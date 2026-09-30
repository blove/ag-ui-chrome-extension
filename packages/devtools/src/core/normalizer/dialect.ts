/**
 * Which wire protocol a connection speaks (spec L4, L5).
 *
 * Per connection, not per session, so an AG-UI stream and a LangGraph stream can sit side by
 * side in one capture. Derived only from things every capture stores — the request line and the
 * first event record — so an imported file classifies exactly as the live capture did, and
 * nothing new is persisted. Every consumer that branches on dialect calls this one function: if
 * two of them disagreed about which connections are LangGraph, the panel and the export would
 * tell two different stories about the same file.
 */
import { routeHint } from '../detect/classifier';
import type { JsonlEvent, JsonlLine } from '../jsonl/codec';

export type Dialect = 'agui' | 'langgraph';

export interface DialectRequest {
  readonly method: string;
  readonly url: string;
}

export interface DialectFirstFrame {
  readonly sseEvent?: string;
  /** The parsed payload — `CaptureRecord.raw`, or a `.agui.jsonl` event line's `event`. */
  readonly payload: unknown;
}

export function dialectOf(
  request: DialectRequest | undefined,
  first: DialectFirstFrame | undefined,
): Dialect {
  // The URL is the strongest signal, and it is known before any byte of the response. No body is
  // passed: it only matters to the single-route info arm, never to a `langgraph-run` match.
  if (request !== undefined && routeHint(request.url, request.method)?.kind === 'langgraph-run') {
    return 'langgraph';
  }
  // A LangGraph server behind a proxy path: its first event is always `metadata`, carrying the
  // run id. An AG-UI frame never has an SSE name `metadata` — AG-UI types are UPPER_SNAKE.
  const payload = first?.payload;
  if (
    first?.sseEvent === 'metadata' &&
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { run_id?: unknown }).run_id === 'string'
  ) {
    return 'langgraph';
  }
  return 'agui';
}

/**
 * Each connection's dialect in a list of `.agui.jsonl` lines, by the one rule the run builder uses
 * (L5): its request line, and its first event line. A header or keepalive decides nothing.
 *
 * Lives here rather than beside any one consumer because two of them must agree: the fixture
 * export decides which frames are LangGraph from it, and export redaction decides which request
 * bodies are LangGraph bodies from it. If they disagreed, one file would tell two stories.
 */
export function dialectsOfLines(lines: readonly JsonlLine[]): Map<string, Dialect> {
  const requests = new Map<string, { method: string; url: string }>();
  const firstEvents = new Map<string, JsonlEvent>();
  for (const line of lines) {
    if (line.kind === 'request' && !requests.has(line.connId)) {
      requests.set(line.connId, { method: line.method, url: line.url });
    } else if (line.kind === 'event' && !firstEvents.has(line.connId)) {
      firstEvents.set(line.connId, line);
    }
  }
  const dialects = new Map<string, Dialect>();
  for (const connId of new Set([...requests.keys(), ...firstEvents.keys()])) {
    const first = firstEvents.get(connId);
    dialects.set(
      connId,
      dialectOf(
        requests.get(connId),
        first === undefined
          ? undefined
          : { ...(first.sseEvent !== undefined ? { sseEvent: first.sseEvent } : {}), payload: first.event },
      ),
    );
  }
  return dialects;
}
