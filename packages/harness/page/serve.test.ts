import { expect, test } from '@playwright/test';

import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  DOCUMENT_START_PATH,
  RUNTIME_BASE_PATH,
  RUNTIME_INFO,
  startPageServer,
  type PageServer,
} from './serve.js';

let harness: HarnessServer;
let server: PageServer;

test.beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use('happy');
  server = await startPageServer({ agentUrl: harness.url });
});

test.afterAll(async () => {
  await server.stop();
  await harness.stop();
});

test('serves the built page on a localhost origin', async () => {
  // D3 auto-enables the localhost family, and the manifest's static content-script
  // registration matches `http://localhost/*`. A 127.0.0.1 origin would work too, but the
  // hostname the browser sees is what decides, so it is asserted rather than assumed.
  expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  const res = await fetch(server.url);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.text()).toContain('id="messages"');
});

test('proxies /agui to the harness server as a real SSE response', async () => {
  // AGUIMock sends no CORS headers and 404s the preflight (measured). The page can only
  // reach it same-origin, so this proxy is load-bearing, not convenience.
  const res = await fetch(new URL('/agui', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId: 't',
      runId: 'r',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const body = await res.text();
  expect(body).toContain('data: {"type":"RUN_STARTED"');
  expect(body).toContain('data: {"type":"RUN_FINISHED"');
});

test('serves the document_start GET stream EventSource can reach', async () => {
  // The harness server answers POST only, and `EventSource` cannot POST (§5.3), so this is the
  // only endpoint `document-start.html` can open. Its frames are delayed on purpose: an open
  // and its first frame arriving in the same instant is not a shape any real response has, and
  // the async-load window this page exists to exercise lives in that gap.
  const started = Date.now();
  const res = await fetch(new URL(DOCUMENT_START_PATH, server.url));
  const body = await res.text();

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  expect(body).toContain('data: {"type":"RUN_STARTED"');
  expect(body).toContain('data: {"type":"RUN_FINISHED"');
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
});

test('serves document-start.html with its inline script intact', async () => {
  // An inline script, deliberately: a bundled module would load asynchronously and could not
  // run inside the window under test.
  const res = await fetch(new URL('/document-start.html', server.url));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('new EventSource');
});

test('404s a path outside the built page', async () => {
  const res = await fetch(new URL('/../serve.ts', server.url));
  expect(res.status).toBe(404);
});

/**
 * Agent discovery, in both of the runtime's transports (spec §13 done-when #2).
 *
 * The two answer with the SAME body on purpose: the runtime mode is a fact about which request
 * was made, not about the bytes that came back, so a harness that varied the response would let
 * the classifier be right by accident.
 */
test('serves the multi-route GET {base}/info response', async () => {
  const res = await fetch(new URL(`${RUNTIME_BASE_PATH}/info`, server.url));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(await res.json()).toEqual(RUNTIME_INFO);
});

test('serves the single-route POST {base} envelope the same body', async () => {
  const res = await fetch(new URL(RUNTIME_BASE_PATH, server.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'info' }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(RUNTIME_INFO);
});

test('refuses a single-route POST that does not ask for info', async () => {
  // A server that answered every envelope with an agent list would let a classifier that never
  // read the body pass — the capture would look right because the harness was lax.
  const res = await fetch(new URL(RUNTIME_BASE_PATH, server.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'run' }),
  });
  expect(res.status).toBe(400);
});

test('the served body carries fields the panel makes no claim about', () => {
  // Measured verbatim from the Dojo. They exist here so "read and discarded" is something the
  // e2e can actually observe rather than a property of a body that never had them.
  expect(RUNTIME_INFO).toHaveProperty('audioFileTranscriptionEnabled');
  expect(RUNTIME_INFO.agents.default).toHaveProperty('className');
});

test('serves the CopilotKit-shaped page and its own bundle', async () => {
  const res = await fetch(new URL('copilotkit.html', server.url));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('./copilotkit.js');
  expect((await fetch(new URL('copilotkit.js', server.url))).status).toBe(200);
});
