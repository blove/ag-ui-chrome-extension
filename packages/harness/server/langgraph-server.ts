/**
 * The LangGraph Platform run-stream routes, served from the PAGE server's own origin.
 *
 * Same-origin rather than behind the `/agui` proxy, and not for convenience: the proxy rewrites
 * every path to the harness server's `/`, and the URL path is the strongest dialect signal the
 * extension has (spec L5) — `/threads/:threadId/runs/stream` has to reach the capture layer
 * exactly as a LangGraph SDK would send it. Served here, the page's request line is the real one.
 *
 *   POST /threads/:threadId/runs/stream          — a run; the scenario is the body's `assistant_id`
 *   GET  /threads/:threadId/runs/:runId/stream   — a join; the scenario whose run id this is
 *
 * No `@langchain/langgraph-api` here: what the capture layer sees is bytes, and the bytes are
 * specified — `event:`, one `data:` line per line of the pretty-printed payload, a blank line.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  encodeLangGraphFrame,
  langGraphScenarios,
  type LangGraphFrame,
  type LangGraphScenario,
} from '../fixtures/langgraph.js';

const RUN_RE = /^\/threads\/([^/]+)\/runs\/stream$/;
const JOIN_RE = /^\/threads\/([^/]+)\/runs\/([^/]+)\/stream$/;

/**
 * The stream is written in pieces of this many characters, with a yield to the event loop between
 * each, and cut WITHOUT regard to frame or line boundaries. Written a frame at a time, Node
 * delivers every read ending exactly on a blank line (measured: 137 reads, none mid-frame), which
 * would leave the capture layer's buffering across reads — a frame's `event:` in one read and its
 * last `data:` line three reads later — untested. Cut blind, a real network's worst case is the
 * ordinary case: measured with a Node reader, `lg-reasoning` arrives in 3485 reads, 3482 of them
 * ending mid-frame, in ~170 ms; even the 890-byte `lg-interrupt` arrives in three.
 */
const PIECE_CHARS = 256;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

function fail(res: ServerResponse, status: number, detail: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail }));
}

async function writeFrames(res: ServerResponse, frames: readonly LangGraphFrame[]): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const text = frames.map(encodeLangGraphFrame).join('');
  for (let at = 0; at < text.length; at += PIECE_CHARS) {
    if (res.writableEnded || res.socket?.destroyed === true) return;
    res.write(text.slice(at, at + PIECE_CHARS));
    await new Promise((done) => setImmediate(done));
  }
  res.end();
}

function runIdOf(scenario: LangGraphScenario): string | undefined {
  const first = scenario.frames[0];
  if (first?.event !== 'metadata') return undefined;
  const data = first.data as { run_id?: unknown };
  return typeof data.run_id === 'string' ? data.run_id : undefined;
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const assistantId =
    typeof body === 'object' && body !== null ? (body as { assistant_id?: unknown }).assistant_id : undefined;
  const scenario = typeof assistantId === 'string' ? langGraphScenarios()[assistantId] : undefined;
  if (scenario === undefined) {
    // A lax server would let a page that sent the wrong body pass; this one answers what the
    // Platform answers for an unknown assistant.
    fail(res, 404, `Assistant ${String(assistantId)} not found`);
    return;
  }
  await writeFrames(res, scenario.frames);
}

async function handleJoin(res: ServerResponse, runId: string): Promise<void> {
  const scenario = Object.values(langGraphScenarios()).find(
    (candidate) => candidate.joinFrames !== undefined && runIdOf(candidate) === runId,
  );
  if (scenario?.joinFrames === undefined) {
    fail(res, 404, `Run ${runId} not found`);
    return;
  }
  await writeFrames(res, scenario.joinFrames);
}

/** Answers the request when it is a LangGraph run-stream route; `false` means "not mine". */
export function handleLangGraph(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method === 'POST' && RUN_RE.test(pathname)) {
    void handleRun(req, res);
    return true;
  }
  const join = JOIN_RE.exec(pathname);
  if (req.method === 'GET' && join?.[2] !== undefined) {
    void handleJoin(res, decodeURIComponent(join[2]));
    return true;
  }
  return false;
}
