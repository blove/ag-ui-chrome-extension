import { expect, test } from '@playwright/test';

import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { leakedValues, recordOnce, redactRecordedEvents, toCommittableFixture } from './record.js';

/**
 * A stand-in for a real agent. Emits the same SSE shape a real one does, carrying text that is
 * unmistakable if it survives — which is the whole point: this exercises the H7 gate without a
 * key, without network egress, and without spending money (design decision H2).
 */
const SECRET_TEXT = 'my bank account number is 12345678';
const SECRET_ARGS = '{"ssn":"078-05-1120"}';
const SECRET_STATE = 'patient-record-alpha';

const UPSTREAM_EVENTS: unknown[] = [
  { type: 'RUN_STARTED', threadId: 't_up', runId: 'r_up' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: SECRET_TEXT },
  { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
  { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'lookup' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: SECRET_ARGS },
  { type: 'TOOL_CALL_END', toolCallId: 'tc1' },
  { type: 'STATE_SNAPSHOT', snapshot: { chart: SECRET_STATE, count: 3 } },
  { type: 'RUN_FINISHED', threadId: 't_up', runId: 'r_up' },
];

let upstream: Server | null = null;
let outDir: string | null = null;

async function startUpstream(events: readonly unknown[]): Promise<string> {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream = server;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no upstream port');
  return `http://127.0.0.1:${String(address.port)}/agent/default/run`;
}

/** Every temp entry this module could have produced — the recorder's, and the tests' own. */
async function listTemp(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('agui-record-'));
}

test.afterEach(async () => {
  if (upstream !== null) {
    const server = upstream;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream = null;
  }
  if (outDir !== null) {
    await rm(outDir, { recursive: true, force: true });
    outDir = null;
  }
});

test.describe('redactRecordedEvents', () => {
  test('replaces payloads and keeps structure', () => {
    const [text] = redactRecordedEvents([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: SECRET_TEXT },
    ]);

    expect(text).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: `«redacted: ${String(SECRET_TEXT.length)} chars»`,
    });
  });

  test('leaves lifecycle events alone', () => {
    const event = { type: 'RUN_STARTED', threadId: 't_up', runId: 'r_up' };
    expect(redactRecordedEvents([event])[0]).toEqual(event);
  });
});

test.describe('leakedValues', () => {
  test('finds nothing in a properly redacted stream', () => {
    expect(leakedValues(UPSTREAM_EVENTS, redactRecordedEvents(UPSTREAM_EVENTS))).toEqual([]);
  });

  test('catches a payload that was not redacted', () => {
    // Exactly what a regression in redact.ts would look like: everything else clean, one field
    // through untouched.
    const half = redactRecordedEvents(UPSTREAM_EVENTS).map((event, index) =>
      index === 2 ? UPSTREAM_EVENTS[2] : event,
    );
    expect(leakedValues(UPSTREAM_EVENTS, half)).toEqual([SECRET_TEXT]);
  });

  test('catches an unredacted tool-call argument and state value too', () => {
    // One per remaining group that carries free text, so a redaction bug in any of them is a
    // failed recording rather than a committed leak.
    const argsThrough = redactRecordedEvents(UPSTREAM_EVENTS).map((event, index) =>
      index === 5 ? UPSTREAM_EVENTS[5] : event,
    );
    expect(leakedValues(UPSTREAM_EVENTS, argsThrough)).toEqual([SECRET_ARGS]);

    const stateThrough = redactRecordedEvents(UPSTREAM_EVENTS).map((event, index) =>
      index === 7 ? UPSTREAM_EVENTS[7] : event,
    );
    expect(leakedValues(UPSTREAM_EVENTS, stateThrough)).toEqual([SECRET_STATE]);
  });
});

test.describe('toCommittableFixture', () => {
  test('keys the fixture on the authored prompt, not the recorded match', () => {
    const fixture = toCommittableFixture(
      { match: { message: 'whatever the recorder captured' }, events: [] },
      'what is AG-UI?',
    );
    expect(fixture.match).toEqual({ message: 'what is AG-UI?' });
  });
});

test.describe('recordOnce', () => {
  test('records through the proxy and commits only redacted events', async () => {
    const upstreamUrl = await startUpstream(UPSTREAM_EVENTS);
    outDir = await mkdtemp(join(tmpdir(), 'agui-record-out-'));
    const outFile = join(outDir, 'nested', 'fake-agent.json');

    const result = await recordOnce({
      upstream: upstreamUrl,
      prompt: 'what is AG-UI?',
      outFile,
    });

    expect(result.eventCount).toBe(UPSTREAM_EVENTS.length);
    expect(result.eventTypes).toContain('TOOL_CALL_ARGS');

    const written = await readFile(outFile, 'utf-8');
    expect(written).not.toContain(SECRET_TEXT);
    expect(written).not.toContain(SECRET_ARGS);
    expect(written).not.toContain(SECRET_STATE);
    expect(written).toContain('«redacted:');
    // Structure survives, which is what makes the fixture replayable at all.
    expect(written).toContain('"RUN_STARTED"');
    expect(written).toContain('"chart"');
    expect(JSON.parse(written)).toMatchObject({
      fixtures: [{ match: { message: 'what is AG-UI?' } }],
    });
  });

  test('leaves no unredacted recording on disk', async () => {
    const upstreamUrl = await startUpstream(UPSTREAM_EVENTS);
    outDir = await mkdtemp(join(tmpdir(), 'agui-record-out-'));
    const before = new Set(await listTemp());

    await recordOnce({
      upstream: upstreamUrl,
      prompt: 'what is AG-UI?',
      outFile: join(outDir, 'fake-agent.json'),
    });

    const after = (await listTemp()).filter((name) => !before.has(name));
    expect(after).toEqual([]);
  });

  test('reports the upstream rather than writing a fixture when it is unreachable', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'agui-record-out-'));
    const outFile = join(outDir, 'unreachable.json');

    // Port 1 on loopback refuses instantly; aimock synthesizes a 502 for an unreachable
    // upstream. The message has to name the upstream, because "502" alone sends the reader
    // looking at the recorder instead of at the agent that is not running.
    await expect(
      recordOnce({
        upstream: 'http://127.0.0.1:1/agent/default/run',
        prompt: 'what is AG-UI?',
        outFile,
      }),
    ).rejects.toThrow(/127\.0\.0\.1:1/);

    const written = await readdir(outDir);
    expect(written).toEqual([]);
    expect((await listTemp()).filter((name) => !name.startsWith('agui-record-out-'))).toEqual([]);
  });
});
