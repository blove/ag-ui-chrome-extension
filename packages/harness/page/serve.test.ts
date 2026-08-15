import { expect, test } from '@playwright/test';

import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import { startPageServer, type PageServer } from './serve.js';

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

test('404s a path outside the built page', async () => {
  const res = await fetch(new URL('/../serve.ts', server.url));
  expect(res.status).toBe(404);
});
