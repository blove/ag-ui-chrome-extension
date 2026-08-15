import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AGUIMock } from '@copilotkit/aimock';
import type { AGUIEvent } from '@copilotkit/aimock';

import type { AguiEvent } from '@devtools/core/model/types';

import { SCENARIOS, type Scenario } from '../fixtures/index.js';

export interface HarnessServer {
  readonly url: string;
  /** Serve a named scenario on the next run. */
  use(scenario: string): void;
  stop(): Promise<void>;
}

const SSE_CONTENT_TYPE = 'text/event-stream';
const DEFAULT_SCENARIO = 'happy';

/**
 * aimock types its event array as a closed discriminated union; `AguiEvent` is deliberately open,
 * because requirements §7 says an unknown event type is a warning to display, never an error to
 * reject. The corpus is the source of truth for what goes on the wire — a scenario exists
 * precisely to serve payloads the union does not admit — so the two are reconciled here, at the
 * one boundary, rather than by weakening either type.
 */
function asMockEvents(events: readonly AguiEvent[]): AGUIEvent[] {
  return events as unknown as AGUIEvent[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scenarios aimock cannot serve itself.
 *
 * `writeAGUIEventStream` emits `data:` frames and nothing else, under a hardcoded
 * `text/event-stream`. A scenario needing a comment frame or a binary content type is written by
 * `writeCustomStream` below; everything else goes through aimock unmodified, which is where its
 * fidelity — including the `timestamp` stamp of verified fact 2 — actually matters.
 */
function needsCustomTransport(scenario: Scenario): boolean {
  const contentType = scenario.contentType ?? SSE_CONTENT_TYPE;
  return contentType !== SSE_CONTENT_TYPE || (scenario.keepalives?.length ?? 0) > 0;
}

/** Mirrors aimock's stamp so a custom-transport scenario is byte-comparable with a delegated one. */
function stamp(event: AguiEvent): AguiEvent {
  return { ...event, timestamp: event.timestamp ?? Date.now() };
}

function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => {});
    req.on('end', () => resolve());
    req.on('error', reject);
  });
}

/**
 * Frame the events as length-prefixed opaque blobs: a 4-byte big-endian length followed by that
 * many bytes of payload. This is a stand-in for protobuf wire framing, which is deliberate —
 * requirements §5.4 defers *decoding* to phase 3 and asks only that capture detect the content
 * type and label the connection, so what the bytes mean is not under test. What is under test is
 * that capture does not try to parse them as SSE.
 */
function encodeBinaryBody(events: readonly AguiEvent[]): Buffer {
  const chunks: Buffer[] = [];
  for (const event of events) {
    const payload = Buffer.from(JSON.stringify(stamp(event)), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    chunks.push(header, payload);
  }
  return Buffer.concat(chunks);
}

async function writeCustomStream(res: ServerResponse, scenario: Scenario): Promise<void> {
  const contentType = scenario.contentType ?? SSE_CONTENT_TYPE;

  if (contentType !== SSE_CONTENT_TYPE) {
    const body = encodeBinaryBody(scenario.events);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Content-Length': String(body.byteLength),
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    'Content-Type': SSE_CONTENT_TYPE,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const keepalives = scenario.keepalives ?? [];
  const delayMs = scenario.delayMs ?? 0;

  // `afterEvents: 0` fires before the first event, so the pending list is drained on every
  // boundary from 0 to events.length inclusive — hence `<=` rather than `<`.
  for (let written = 0; written <= scenario.events.length; written += 1) {
    for (const keepalive of keepalives) {
      if (keepalive.afterEvents !== written) continue;
      if (keepalive.delayBeforeMs > 0) await sleep(keepalive.delayBeforeMs);
      if (res.socket?.destroyed === true) return;
      res.write(`: ${keepalive.comment}\n\n`);
    }
    const event = scenario.events[written];
    if (event === undefined) break;
    if (res.socket?.destroyed === true) return;
    res.write(`data: ${JSON.stringify(stamp(event))}\n\n`);
    if (delayMs > 0) await sleep(delayMs);
  }

  if (!res.writableEnded) res.end();
}

export async function startHarnessServer(opts: { port?: number } = {}): Promise<HarnessServer> {
  // Never `.start()`ed: AGUIMock is mounted as a request handler so a scenario needing a comment
  // frame or a binary content type can be answered on the same origin and the same port. One
  // origin is not cosmetic — decision D3 keys the capture opt-in on it.
  const mock = new AGUIMock();
  let current = requireScenario(DEFAULT_SCENARIO);
  register(current);

  function register(scenario: Scenario): void {
    mock.reset();
    mock.onRun(/.*/, asMockEvents(scenario.events), scenario.delayMs);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      if (!res.writableEnded) res.end('harness error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'POST' && (pathname === '/' || pathname === '')) {
      if (needsCustomTransport(current)) {
        await drainBody(req);
        await writeCustomStream(res, current);
        return;
      }
      await mock.handleRequest(req, res, pathname);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  const url = await new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('harness server did not bind a TCP port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    url,
    use(scenario: string): void {
      current = requireScenario(scenario);
      register(current);
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // `Connection: keep-alive` means a client that finished reading still holds the socket
        // open, and `close` alone would wait for it. Idle sockets are dropped explicitly so
        // `stop()` resolves promptly in a test teardown.
        server.closeAllConnections();
      });
    },
  };
}

function requireScenario(name: string): Scenario {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    throw new Error(
      `Unknown scenario '${name}'. Known: ${Object.keys(SCENARIOS).sort().join(', ')}`,
    );
  }
  return scenario;
}
