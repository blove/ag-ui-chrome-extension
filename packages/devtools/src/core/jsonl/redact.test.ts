import { describe, it, expect } from 'vitest';
import type { JsonlEvent, JsonlHeader, JsonlKeepalive, JsonlRequest } from './codec';
import { ALL_REDACTION_GROUPS, redactLine, redactString } from './redact';

function ev(event: Record<string, unknown>, seq = 1): JsonlEvent {
  return { kind: 'event', connId: 'c1', seq, tMs: seq * 10, event };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('redactString', () => {
  it('uses the exact template with the real character count', () => {
    expect(redactString('Hello, world!')).toBe('«redacted: 13 chars»');
    expect(redactString('')).toBe('«redacted: 0 chars»');
    expect(redactString('a'.repeat(412))).toBe('«redacted: 412 chars»');
  });
});

describe('ALL_REDACTION_GROUPS', () => {
  it('lists every group', () => {
    expect([...ALL_REDACTION_GROUPS]).toEqual([
      'text',
      'reasoning',
      'toolArgs',
      'toolResults',
      'state',
    ]);
  });
});

describe('redactLine — text group', () => {
  it('replaces TEXT_MESSAGE_CONTENT delta and preserves every structural field', () => {
    const line = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello, world!' }, 3);

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out).toEqual({
      kind: 'event',
      connId: 'c1',
      seq: 3,
      tMs: 30,
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm_1',
        delta: '«redacted: 13 chars»',
      },
    });
  });

  it('replaces TEXT_MESSAGE_CHUNK delta and keeps messageId and role', () => {
    const line = ev({
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm_1',
      role: 'assistant',
      delta: 'abc',
    });

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm_1',
      role: 'assistant',
      delta: '«redacted: 3 chars»',
    });
  });

  it('does not mutate its argument', () => {
    const line = deepFreeze(
      ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello, world!' }),
    );

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out).not.toBe(line);
    expect(line.event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: 'Hello, world!',
    });
  });

  it('leaves other groups alone', () => {
    const args = ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"a":1}' });
    const result = ev({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      content: 'sunny',
    });

    expect((redactLine(args, ['text']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'tc_1',
      delta: '{"a":1}',
    });
    expect((redactLine(result, ['text']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      content: 'sunny',
    });
  });
});

describe('redactLine — reasoning group', () => {
  it('replaces reasoning content, chunk delta and encrypted value', () => {
    const content = ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'm_r', delta: 'because' });
    const chunk = ev({ type: 'REASONING_MESSAGE_CHUNK', messageId: 'm_r', delta: 'abc' });
    const encrypted = ev({
      type: 'REASONING_ENCRYPTED_VALUE',
      entityId: 'e_1',
      subtype: 'thinking',
      encryptedValue: 'ZW5jcnlwdGVk',
    });

    expect((redactLine(content, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'REASONING_MESSAGE_CONTENT',
      messageId: 'm_r',
      delta: '«redacted: 7 chars»',
    });
    expect((redactLine(chunk, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'REASONING_MESSAGE_CHUNK',
      messageId: 'm_r',
      delta: '«redacted: 3 chars»',
    });
    expect((redactLine(encrypted, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'REASONING_ENCRYPTED_VALUE',
      entityId: 'e_1',
      subtype: 'thinking',
      encryptedValue: '«redacted: 12 chars»',
    });
  });
});

describe('redactLine — toolArgs and toolResults groups', () => {
  it('replaces TOOL_CALL_ARGS and TOOL_CALL_CHUNK deltas, keeping ids and names', () => {
    const args = ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"city":"Paris",' });
    const chunk = ev({
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'tc_1',
      toolCallName: 'get_weather',
      parentMessageId: 'm_1',
      delta: '{"a":1}',
    });

    expect((redactLine(args, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'tc_1',
      delta: '«redacted: 16 chars»',
    });
    expect((redactLine(chunk, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'tc_1',
      toolCallName: 'get_weather',
      parentMessageId: 'm_1',
      delta: '«redacted: 7 chars»',
    });
  });

  it('replaces TOOL_CALL_RESULT content, keeping ids and role', () => {
    const line = ev({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      role: 'tool',
      content: '{"tempC":24}',
    });

    expect((redactLine(line, ['toolResults']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      role: 'tool',
      content: '«redacted: 12 chars»',
    });
  });
});

describe('redactLine — state group', () => {
  it('replaces every snapshot leaf, keeping keys, nulls and array shape', () => {
    const line = deepFreeze(
      ev({
        type: 'STATE_SNAPSHOT',
        snapshot: {
          counter: 7,
          ok: true,
          name: 'Ada',
          missing: null,
          notes: ['one', 2, false, null],
          nested: { deep: { s: 'x' } },
          empty: [],
        },
      }),
    );

    const out = redactLine(line, ['state']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'STATE_SNAPSHOT',
      snapshot: {
        counter: '«redacted: 1 chars»',
        ok: '«redacted: 4 chars»',
        name: '«redacted: 3 chars»',
        missing: null,
        notes: ['«redacted: 3 chars»', '«redacted: 1 chars»', '«redacted: 5 chars»', null],
        nested: { deep: { s: '«redacted: 1 chars»' } },
        empty: [],
      },
    });
    expect((line.event as { snapshot: { name: string } }).snapshot.name).toBe('Ada');
  });

  it('preserves op and path on a STATE_DELTA and redacts only the value leaves', () => {
    const line = ev({
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/counter', value: 2 },
        { op: 'add', path: '/notes/-', value: 'second note' },
        { op: 'add', path: '/profile', value: { name: 'Ada', tags: ['x', null] } },
        { op: 'remove', path: '/stale' },
        { op: 'move', path: '/b', from: '/a' },
      ],
    });

    const out = redactLine(line, ['state']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/counter', value: '«redacted: 1 chars»' },
        { op: 'add', path: '/notes/-', value: '«redacted: 11 chars»' },
        {
          op: 'add',
          path: '/profile',
          value: { name: '«redacted: 3 chars»', tags: ['«redacted: 1 chars»', null] },
        },
        { op: 'remove', path: '/stale' },
        { op: 'move', path: '/b', from: '/a' },
      ],
    });
  });

  it('replaces request input message contents without touching ids, roles or ordering', () => {
    const request: JsonlRequest = deepFreeze({
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/api/copilotkit/agent/default/run',
      input: {
        threadId: 't_1',
        runId: 'r_1',
        messages: [
          { id: 'm_user_1', role: 'user', content: 'What is the weather in Paris?' },
          { id: 'm_a_1', role: 'assistant', content: 'Checking.' },
        ],
        tools: [],
      },
    });

    const out = redactLine(request, ['state']) as JsonlRequest;

    expect(out).toEqual({
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/api/copilotkit/agent/default/run',
      input: {
        threadId: 't_1',
        runId: 'r_1',
        messages: [
          { id: 'm_user_1', role: 'user', content: '«redacted: 29 chars»' },
          { id: 'm_a_1', role: 'assistant', content: '«redacted: 9 chars»' },
        ],
        tools: [],
      },
    });
  });

  it('leaves the request alone when the state group is not selected', () => {
    const request: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: { messages: [{ id: 'm_user_1', role: 'user', content: 'secret' }] },
    };

    expect(redactLine(request, ['text', 'toolArgs'])).toEqual(request);
  });
});

describe('redactLine — passthrough cases', () => {
  it('is a no-op for an empty group list', () => {
    const line = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello, world!' });

    const out = redactLine(line, []);

    expect(out).toEqual(line);
    expect((out as JsonlEvent).event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: 'Hello, world!',
    });
  });

  it('leaves the header untouched', () => {
    const header: JsonlHeader = {
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@0.1.0',
      capturedAt: '2026-08-13T10:00:00.000Z',
      url: 'http://localhost:3000/',
      transport: 'sse',
      redacted: [],
    };

    expect(redactLine(header, [...ALL_REDACTION_GROUPS])).toEqual(header);
  });

  it('leaves a keepalive untouched under every group', () => {
    const keepalive: JsonlKeepalive = {
      kind: 'keepalive',
      connId: 'c1',
      seq: 7,
      tMs: 15_000,
      comment: 'ping',
    };
    const bare: JsonlKeepalive = { ...keepalive, seq: 8, tMs: 30_000, comment: '' };

    // Proxy/heartbeat metadata, not user content: no §11 group owns an SSE comment, and
    // the comment body is exactly what a proxy-buffering diagnosis reads.
    expect(redactLine(keepalive, [...ALL_REDACTION_GROUPS])).toEqual(keepalive);
    expect(redactLine(bare, [...ALL_REDACTION_GROUPS])).toEqual(bare);
  });

  it('leaves lifecycle events untouched under every group', () => {
    const line = ev({ type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' });

    expect((redactLine(line, [...ALL_REDACTION_GROUPS]) as JsonlEvent).event).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_1',
      runId: 'r_1',
    });
  });
});
