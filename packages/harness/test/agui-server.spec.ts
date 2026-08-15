import { expect, test } from '@playwright/test';

import { AGUI_PROTO_CONTENT_TYPE } from '../fixtures/index.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

const RUN_INPUT = {
  threadId: 't_harness',
  runId: 'r_harness',
  state: {},
  messages: [{ id: 'm_user_1', role: 'user', content: 'run the scenario' }],
  tools: [],
  context: [],
  forwardedProps: {},
};

async function postRun(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(RUN_INPUT),
  });
}

let server: HarnessServer;

test.beforeEach(async () => {
  server = await startHarnessServer();
});

test.afterEach(async () => {
  await server.stop();
});

test('serves the default scenario as SSE over a real socket', async () => {
  const response = await postRun(server.url);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const text = await response.text();
  const frames = text.split('\n\n').filter((frame) => frame !== '');
  expect(frames.length).toBeGreaterThan(0);
  expect(text).toContain('"type":"RUN_STARTED"');
  expect(text).toContain('"type":"RUN_FINISHED"');
});

test('use() switches the scenario served on the next run', async () => {
  server.use('malformed');
  const malformed = await (await postRun(server.url)).text();
  expect(malformed).toContain('"threadId":"t_bad"');
  expect(malformed).not.toContain('RUN_FINISHED');

  server.use('happy');
  const happy = await (await postRun(server.url)).text();
  expect(happy).toContain('"threadId":"t_happy"');
  expect(happy).toContain('RUN_FINISHED');
});

test('emits SSE comment frames for a scenario that declares keepalives', async () => {
  server.use('happy');
  const text = await (await postRun(server.url)).text();
  expect(text).toContain(': ping\n\n');
});

test('serves the binary scenario under the protobuf content type', async () => {
  server.use('binary');
  const response = await postRun(server.url);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(AGUI_PROTO_CONTENT_TYPE);

  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);
  // Length-prefixed framing, not SSE: the body must not be parseable as `data:` frames.
  expect(new TextDecoder().decode(bytes)).not.toContain('data:');
});

test('use() rejects an unknown scenario by name', () => {
  expect(() => server.use('does-not-exist')).toThrow(/Unknown scenario 'does-not-exist'/);
});

test('binds an ephemeral loopback port and stops cleanly', async () => {
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await server.stop();
  await expect(postRun(server.url)).rejects.toThrow();
  server = await startHarnessServer();
});
