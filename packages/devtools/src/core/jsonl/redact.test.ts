import { describe, it, expect } from 'vitest';
import type { JsonlEvent, JsonlHeader, JsonlKeepalive, JsonlRequest } from './codec';
import { ALL_REDACTION_GROUPS, redactLine, redactString, type RedactionGroup } from './redact';

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
    expect(redactString('a'.repeat(412))).toBe('«redacted: 412 chars»');
  });

  it('leaves the empty string alone — there is nothing in it to protect', () => {
    /*
     * Found by export, `redact.ts`'s second consumer (2026-08-15).
     *
     * A zero-length string carries no content, so replacing it protects nothing. What it DOES do
     * is change what the validator sees: requirements §7 makes an empty `TEXT_MESSAGE_CONTENT`
     * delta an ERROR (`empty-text-delta`), and `«redacted: 0 chars»` is not empty. A redacted bug
     * report about an empty-delta bug therefore arrived at the colleague reporting no bug at all
     * — the file looked clean while the original did not. §11 promises that structure, types,
     * ordering, sizes and timings survive redaction; the emptiness of an empty payload is exactly
     * that kind of fact, and done-when #7 requires a redacted export to still validate.
     */
    expect(redactString('')).toBe('');
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

    // `text`, not `state`: message content is authored text, and that is the group a user
    // deselects when they want their prompts kept out of a bug report.
    const out = redactLine(request, ['text']) as JsonlRequest;

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

  it('redacts request message content under the text group, which owns authored text', () => {
    const request: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: { messages: [{ id: 'm_user_1', role: 'user', content: 'secret' }] },
    };

    // The user selected `text`. Their own message IS text; leaving it verbatim because a
    // different group was unselected published exactly what they asked to have removed.
    expect(redactLine(request, ['text'])).toEqual({
      ...request,
      input: { messages: [{ id: 'm_user_1', role: 'user', content: '«redacted: 6 chars»' }] },
    });
  });

  it('leaves the request alone when no group owning its payload is selected', () => {
    const request: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: { messages: [{ id: 'm_user_1', role: 'user', content: 'secret' }] },
    };

    expect(redactLine(request, ['reasoning'])).toEqual(request);
  });

  it('redacts request input state, context and forwardedProps under the state group', () => {
    const request: JsonlRequest = deepFreeze({
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: {
        threadId: 't_1',
        messages: [],
        // Developer-authored schema, not user content: no §11 group owns it, and it is what
        // makes a captured run readable.
        tools: [{ name: 'get_weather', description: 'Look up weather' }],
        state: { city: 'Paris', visits: 3 },
        context: [{ description: 'user tier', value: 'enterprise' }],
        forwardedProps: { sessionSecret: 'abc123' },
      },
    });

    expect(redactLine(request, ['state'])).toEqual({
      ...request,
      input: {
        threadId: 't_1',
        messages: [],
        tools: [{ name: 'get_weather', description: 'Look up weather' }],
        state: { city: '«redacted: 5 chars»', visits: '«redacted: 1 chars»' },
        context: [
          { description: '«redacted: 9 chars»', value: '«redacted: 10 chars»' },
        ],
        forwardedProps: { sessionSecret: '«redacted: 6 chars»' },
      },
    });
  });

  it('redacts tool call arguments carried on an input message under the toolArgs group', () => {
    const request: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: {
        messages: [
          {
            id: 'm_a_1',
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
        ],
      },
    };

    expect(redactLine(request, ['toolArgs'])).toEqual({
      ...request,
      input: {
        messages: [
          {
            id: 'm_a_1',
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'tc_1',
                type: 'function',
                // The name survives — it is structure. The arguments do not.
                function: { name: 'get_weather', arguments: '«redacted: 16 chars»' },
              },
            ],
          },
        ],
      },
    });
  });

  it('treats a tool-role input message body as a tool result, not as text', () => {
    const request: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: {
        messages: [{ id: 'm_t_1', role: 'tool', toolCallId: 'tc_1', content: '{"tempC":18}' }],
      },
    };

    expect(redactLine(request, ['toolResults'])).toEqual({
      ...request,
      input: {
        messages: [
          { id: 'm_t_1', role: 'tool', toolCallId: 'tc_1', content: '«redacted: 12 chars»' },
        ],
      },
    });
    // ...and the text group must NOT reach it, or `toolResults` would be unable to protect it.
    expect(redactLine(request, ['text'])).toEqual(request);
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

  /*
   * `RUN_STARTED.input` is an OPTIONAL protocol field (@ag-ui/core: RunStartedEventSchema) that
   * echoes the whole `RunAgentInput` back on the wire — the same payload the request line
   * carries, including the user's own messages.
   *
   * This was found by Tier B recording against a live agent, not by any test here: all three
   * hand-written golden fixtures omit `input`, so the entire suite agreed that lifecycle events
   * carry no payload. A real deployment sends it on every run. Redacting the request body while
   * publishing the identical content from an event field is not partial protection — the
   * exported bundle contains the user's prompts either way.
   */
  it('redacts RUN_STARTED.input, which echoes the whole RunAgentInput back on the wire', () => {
    const line = ev({
      type: 'RUN_STARTED',
      threadId: 't_1',
      runId: 'r_1',
      input: {
        threadId: 't_1',
        runId: 'r_1',
        messages: [{ id: 'u1', role: 'user', content: 'What is the weather in Paris?' }],
        tools: [],
        context: [],
        state: { city: 'Paris' },
        forwardedProps: {},
      },
    });

    expect((redactLine(line, [...ALL_REDACTION_GROUPS]) as JsonlEvent).event).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_1',
      runId: 'r_1',
      input: {
        threadId: 't_1',
        runId: 'r_1',
        messages: [{ id: 'u1', role: 'user', content: '«redacted: 29 chars»' }],
        tools: [],
        context: [],
        state: { city: '«redacted: 5 chars»' },
        forwardedProps: {},
      },
    });
  });

  it('redacts RUN_STARTED.input by the same group ownership as a request line', () => {
    const input = {
      messages: [{ id: 'u1', role: 'user', content: 'secret' }],
      state: { k: 'v' },
    };
    const line = ev({ type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1', input });

    // `text` reaches the message, not the state.
    expect((redactLine(line, ['text']) as JsonlEvent).event).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_1',
      runId: 'r_1',
      input: {
        messages: [{ id: 'u1', role: 'user', content: '«redacted: 6 chars»' }],
        state: { k: 'v' },
      },
    });

    // `state` reaches the state, not the message.
    expect((redactLine(line, ['state']) as JsonlEvent).event).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_1',
      runId: 'r_1',
      input: {
        messages: [{ id: 'u1', role: 'user', content: 'secret' }],
        state: { k: '«redacted: 1 chars»' },
      },
    });
  });

  it('does not invent an input field on a RUN_STARTED that has none', () => {
    const line = ev({ type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' });
    const out = (redactLine(line, [...ALL_REDACTION_GROUPS]) as JsonlEvent).event;

    expect(Object.keys(out as Record<string, unknown>)).toEqual(['type', 'threadId', 'runId']);
  });
});

describe('redactLine — fails closed on payloads it does not recognise', () => {
  /*
   * These pin the bug found against a LangGraph Platform capture: a payload this module cannot
   * classify into one of the five groups was exported verbatim even with every group selected,
   * which makes PRIVACY.md's claim about a fully-redacted export false for any non-AG-UI stream.
   */

  it('redacts a LangGraph metadata object wholesale, keeping sseEvent', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 1,
      tMs: 10,
      sseEvent: 'metadata',
      event: { run_id: 'r1', attempt: 1 },
    };

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out).toEqual({
      kind: 'event',
      connId: 'c1',
      seq: 1,
      tMs: 10,
      sseEvent: 'metadata',
      event: { run_id: '«redacted: 2 chars»', attempt: '«redacted: 1 chars»' },
    });
  });

  it('leaves the LangGraph metadata object untouched when no group is selected', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 1,
      tMs: 10,
      sseEvent: 'metadata',
      event: { run_id: 'r1', attempt: 1 },
    };

    expect(redactLine(line, [])).toEqual(line);
  });

  it('redacts a messages tuple array wholesale, keeping shape and keys', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 2,
      tMs: 20,
      sseEvent: 'messages',
      event: [
        { type: 'AIMessageChunk', id: 'm1', content: 'Hello secret' },
        { langgraph_node: 'agent' },
      ],
    };

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out).toEqual({
      kind: 'event',
      connId: 'c1',
      seq: 2,
      tMs: 20,
      sseEvent: 'messages',
      event: [
        {
          type: '«redacted: 14 chars»',
          id: '«redacted: 2 chars»',
          content: '«redacted: 12 chars»',
        },
        { langgraph_node: '«redacted: 5 chars»' },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('Hello secret');
  });

  it('leaves the messages tuple array untouched when no group is selected', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 2,
      tMs: 20,
      sseEvent: 'messages',
      event: [
        { type: 'AIMessageChunk', id: 'm1', content: 'Hello secret' },
        { langgraph_node: 'agent' },
      ],
    };

    expect(redactLine(line, [])).toEqual(line);
  });

  it('redacts an unparseable raw string payload to its character count', () => {
    const raw = 'data that did not parse';
    const line: JsonlEvent = { kind: 'event', connId: 'c1', seq: 3, tMs: 30, event: raw };

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toBe(`«redacted: ${raw.length} chars»`);
  });

  it('leaves an unparseable raw string payload untouched when no group is selected', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 3,
      tMs: 30,
      event: 'data that did not parse',
    };

    expect(redactLine(line, [])).toEqual(line);
  });

  it('redacts an object with an unknown type wholesale, but keeps the type — types are structure', () => {
    const line = ev({ type: 'FUTURE_EVENT', text: 'secret' });

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toEqual({ type: 'FUTURE_EVENT', text: '«redacted: 6 chars»' });
  });

  it('leaves an object with an unknown type untouched when no group is selected', () => {
    const line = ev({ type: 'FUTURE_EVENT', text: 'secret' });

    expect(redactLine(line, [])).toEqual(line);
  });

  it('does not keep a top-level type that is not AG-UI-shaped (UPPER_SNAKE)', () => {
    // "keeps a future AG-UI type's Timeline label" only makes sense for a type that could BE
    // an AG-UI type. Free-form app data that happens to have a `type` field — e.g. an order
    // number a non-AG-UI protocol calls `type` — is not that, and must not be special-cased.
    const raw = 'my secret order #123';
    const line = ev({ type: raw });

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toEqual({ type: `«redacted: ${raw.length} chars»` });
  });

  it('nulls a non-string top-level type rather than redacting it as a leaf — validator parity', () => {
    // A redacted STRING here (e.g. `«redacted: 2 chars»`) would still look like a `type` value
    // to the validator, turning what should read as `shape-invalid` into a fabricated
    // `unknown-event-type`. `null` is honest: this payload's `type` was never a usable one.
    const line = ev({ type: 42, note: 'secret' });

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toEqual({ type: null, note: '«redacted: 6 chars»' });
  });

  it('redacts an object with no type wholesale', () => {
    const line = ev({ foo: 'secret' });

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toEqual({ foo: '«redacted: 6 chars»' });
  });

  it('leaves an object with no type untouched when no group is selected', () => {
    const line = ev({ foo: 'secret' });

    expect(redactLine(line, [])).toEqual(line);
  });

  it('leaves a known AG-UI event untouched when the selected group does not own it', () => {
    const line = ev({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"a":1}' });

    expect(redactLine(line, ['text'])).toEqual(line);
  });

  it('leaves a known AG-UI event untouched when no group is selected', () => {
    const line = ev({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"a":1}' });

    expect(redactLine(line, [])).toEqual(line);
  });

  it('leaves a null payload as null', () => {
    const line = ev(null as unknown as Record<string, unknown>);

    expect(redactLine(line, ['text'])).toEqual(line);
  });

  it('leaves a null payload as null when no group is selected', () => {
    const line = ev(null as unknown as Record<string, unknown>);

    expect(redactLine(line, [])).toEqual(line);
  });

  it('leaves an empty string payload as empty', () => {
    const line: JsonlEvent = { kind: 'event', connId: 'c1', seq: 4, tMs: 40, event: '' };

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toBe('');
  });

  it('leaves an empty string payload as empty when no group is selected', () => {
    const line: JsonlEvent = { kind: 'event', connId: 'c1', seq: 4, tMs: 40, event: '' };

    expect(redactLine(line, [])).toEqual(line);
  });
});

describe('redactLine — a named SSE event is never an AG-UI frame', () => {
  /*
   * Spec L1/L16: the capture and loader paths normalize the default SSE event name (`message`,
   * or none at all) away, so `sseEvent` being present on a line at all means this line came off
   * a non-AG-UI protocol — LangGraph Platform, today. Its payload dispatching into the AG-UI
   * `FIELD_RULES` table by coincidence of a shared `type` string (e.g.
   * a LangGraph `CUSTOM`-shaped frame) would be exactly the kind of misclassification this
   * module exists to avoid — it has no idea what that protocol's `CUSTOM` actually carries.
   * L16's field-level LangGraph rules will hang off this same branch, replacing wholesale
   * redaction with precise per-field rules once that PR lands.
   */
  it('redacts wholesale, ignoring an AG-UI-shaped type, when the line names an SSE event', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 5,
      tMs: 50,
      sseEvent: 'values',
      event: { type: 'CUSTOM', messages: [{ content: 'SECRET' }] },
    };

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(JSON.stringify(out)).not.toContain('SECRET');
    // The payload's own `type` is app data on a named line, not an AG-UI event type, so it is
    // redacted like any other field rather than kept.
    expect((out.event as Record<string, unknown>).type).toBe('«redacted: 6 chars»');
  });

  it('leaves it untouched when no group is selected, named line included', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 5,
      tMs: 50,
      sseEvent: 'values',
      event: { type: 'CUSTOM', messages: [{ content: 'SECRET' }] },
    };

    expect(redactLine(line, [])).toEqual(line);
  });

  it('keeps sseEvent itself — it is on the line, not the payload', () => {
    const line: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 5,
      tMs: 50,
      sseEvent: 'values',
      event: { type: 'CUSTOM', messages: [{ content: 'SECRET' }] },
    };

    const out = redactLine(line, [...ALL_REDACTION_GROUPS]) as JsonlEvent;

    expect(out.sseEvent).toBe('values');
  });
});

describe('redactLine — a named line whose SSE event name matches its own payload type IS AG-UI', () => {
  /*
   * An AG-UI server that names its SSE frames after the event type (e.g. Hono's
   * `writeSSE({ event, data })`) produces lines where `sseEvent === event.type`. That equality
   * is exactly the signal LangGraph Platform's frames can never produce by coincidence:
   * LangGraph's own names (`metadata`, `values`, `messages|<ns>`) are lowercase and/or
   * namespaced, so they can never equal an AG-UI `UPPER_SNAKE` `type`. Treat a match as
   * confirmation this is an AG-UI frame and redact it exactly as an unnamed line would; treat a
   * mismatch — or any non-AG-UI shape — as before: wholesale, erring safe.
   */

  it('redacts a matching named TEXT_MESSAGE_CONTENT exactly as the unnamed line would', () => {
    const named = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'secret' });
    named.sseEvent = 'TEXT_MESSAGE_CONTENT';
    const unnamed = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'secret' }, 1);

    const out = redactLine(named, ['text']) as JsonlEvent;
    const expected = redactLine(unnamed, ['text']) as JsonlEvent;

    expect(out.event).toEqual(expected.event);
    expect(out.event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: '«redacted: 6 chars»',
    });
    expect(out.sseEvent).toBe('TEXT_MESSAGE_CONTENT');
  });

  it('leaves a matching named TEXT_MESSAGE_CONTENT untouched when the selected group does not own it', () => {
    const line = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'secret' });
    line.sseEvent = 'TEXT_MESSAGE_CONTENT';

    const out = redactLine(line, ['toolArgs']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'secret',
    });
  });

  it('still redacts wholesale when the named event does not match the payload type', () => {
    const line = ev({ type: 'CUSTOM', value: 'SECRET' });
    line.sseEvent = 'values';

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect((out.event as Record<string, unknown>).type).toBe('«redacted: 6 chars»');
  });

  it('redacts wholesale when the named event does not match a known AG-UI type at all', () => {
    const line = ev({ type: 'TEXT_MESSAGE_CONTENT', delta: 'secret' });
    line.sseEvent = 'something-else';

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(JSON.stringify(out)).not.toContain('secret');
    // Wholesale, not the AG-UI single-field path: `type` is dropped like any other unattributed
    // field, since `keepAguiType` is false on this branch.
    expect((out.event as Record<string, unknown>).type).toBe('«redacted: 20 chars»');
  });
});

/*
 * LangGraph PR 4: fail closed per FIELD on known AG-UI events, not only per payload.
 *
 * @ag-ui/core's `BaseEventSchema` is `.passthrough()` and every event may carry `rawEvent`, so a
 * known `type` says which fields the protocol NAMES, not which fields a line carries. Each named
 * content field belongs to a §11 group; ids, roles, names, timestamps and patch ops/paths are
 * structure; anything else cannot be classified and goes as soon as any group is selected.
 */
describe('redactLine — every field of a known AG-UI event is structure or redacted', () => {
  it('redacts rawEvent under any group, even where that group does not own the payload', () => {
    const line = ev({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 't1',
      delta: '{"a":1}',
      rawEvent: { chunk: 'provider text' },
    });

    expect((redactLine(line, ['text']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 't1',
      delta: '{"a":1}',
      rawEvent: { chunk: '«redacted: 13 chars»' },
    });
  });

  it('redacts a passthrough field no schema names under any group', () => {
    const line = ev({ type: 'TEXT_MESSAGE_END', messageId: 'm1', note: 'secret' });

    expect((redactLine(line, ['state']) as JsonlEvent).event).toEqual({
      type: 'TEXT_MESSAGE_END',
      messageId: 'm1',
      note: '«redacted: 6 chars»',
    });
  });

  it('keeps structure: ids, role, name, timestamp', () => {
    const event = {
      type: 'TEXT_MESSAGE_START',
      messageId: 'm1',
      role: 'assistant',
      name: 'planner',
      timestamp: 123,
    };

    expect((redactLine(ev(event), [...ALL_REDACTION_GROUPS]) as JsonlEvent).event).toEqual(event);
  });

  it('redacts CUSTOM value and RAW event under any group, keeping name and source', () => {
    const custom = ev({ type: 'CUSTOM', name: 'app.x', value: { n: 5 } });
    const raw = ev({ type: 'RAW', source: 'openai', event: 'data' });

    expect((redactLine(custom, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'CUSTOM',
      name: 'app.x',
      value: { n: '«redacted: 1 chars»' },
    });
    expect((redactLine(raw, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'RAW',
      source: 'openai',
      event: '«redacted: 4 chars»',
    });
  });

  it('redacts RUN_ERROR message under any group, keeping code', () => {
    const line = ev({ type: 'RUN_ERROR', code: 'E1', message: 'boom' });

    expect((redactLine(line, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'RUN_ERROR',
      code: 'E1',
      message: '«redacted: 4 chars»',
    });
  });

  it('redacts RUN_FINISHED result and interrupt text, keeping outcome type and ids', () => {
    const line = ev({
      type: 'RUN_FINISHED',
      threadId: 't',
      runId: 'r',
      result: 'done',
      outcome: {
        type: 'interrupt',
        interrupts: [{ id: 'i1', toolCallId: 'tc', reason: 'why', expiresAt: '2026-01-01' }],
      },
    });

    expect((redactLine(line, ['state']) as JsonlEvent).event).toEqual({
      type: 'RUN_FINISHED',
      threadId: 't',
      runId: 'r',
      result: '«redacted: 4 chars»',
      outcome: {
        type: 'interrupt',
        interrupts: [
          { id: 'i1', toolCallId: 'tc', reason: '«redacted: 3 chars»', expiresAt: '2026-01-01' },
        ],
      },
    });
  });

  it('attributes deprecated THINKING_* content to reasoning', () => {
    const delta = ev({ type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: 'hmm' });
    const start = ev({ type: 'THINKING_START', title: 'plan' });

    expect(redactLine(delta, ['text'])).toEqual(delta);
    expect((redactLine(delta, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'THINKING_TEXT_MESSAGE_CONTENT',
      delta: '«redacted: 3 chars»',
    });
    expect((redactLine(start, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'THINKING_START',
      title: '«redacted: 4 chars»',
    });
  });

  it('keeps an empty THINKING delta empty — redactString’s validator-parity rule', () => {
    const line = ev({ type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: '' });

    expect(redactLine(line, ['reasoning'])).toEqual(line);
  });

  it('attributes ACTIVITY_* content to state, keeping activityType and op/path/from', () => {
    const snap = ev({
      type: 'ACTIVITY_SNAPSHOT',
      messageId: 'a',
      activityType: 'p',
      replace: true,
      content: { pct: 10 },
    });
    const delta = ev({
      type: 'ACTIVITY_DELTA',
      messageId: 'a',
      activityType: 'p',
      patch: [
        { op: 'replace', path: '/pct', value: 20 },
        { op: 'move', from: '/a', path: '/b' },
      ],
    });

    expect(redactLine(snap, ['text'])).toEqual(snap);
    expect((redactLine(snap, ['state']) as JsonlEvent).event).toEqual({
      type: 'ACTIVITY_SNAPSHOT',
      messageId: 'a',
      activityType: 'p',
      replace: true,
      content: { pct: '«redacted: 2 chars»' },
    });
    expect((redactLine(delta, ['state']) as JsonlEvent).event).toEqual({
      type: 'ACTIVITY_DELTA',
      messageId: 'a',
      activityType: 'p',
      patch: [
        { op: 'replace', path: '/pct', value: '«redacted: 2 chars»' },
        { op: 'move', from: '/a', path: '/b' },
      ],
    });
  });

  it('attributes MESSAGES_SNAPSHOT content per message by role', () => {
    const toolCalls = (args: string): unknown[] => [
      { id: 'c', type: 'function', function: { name: 'f', arguments: args } },
    ];
    const messages = [
      { id: 'u', role: 'user', content: 'hi' },
      { id: 'a', role: 'assistant', content: 'yo', toolCalls: toolCalls('{}') },
      { id: 't', role: 'tool', toolCallId: 'c', content: 'ok' },
      { id: 'r', role: 'reasoning', content: 'because' },
      { id: 'x', role: 'activity', activityType: 'p', content: { k: 'v' } },
    ];
    const line = ev({ type: 'MESSAGES_SNAPSHOT', messages });
    /** `messages` with exactly one message's fields replaced: each group reaches one role. */
    const expected = (index: number, fields: Record<string, unknown>): unknown[] =>
      messages.map((message, i) => (i === index ? { ...message, ...fields } : message));

    const cases: Array<[RedactionGroup, unknown[]]> = [
      ['toolResults', expected(2, { content: '«redacted: 2 chars»' })],
      ['reasoning', expected(3, { content: '«redacted: 7 chars»' })],
      ['state', expected(4, { content: { k: '«redacted: 1 chars»' } })],
      ['toolArgs', expected(1, { toolCalls: toolCalls('«redacted: 2 chars»') })],
      [
        'text',
        expected(0, { content: '«redacted: 2 chars»' }).map((message, i) =>
          i === 1 ? { ...(message as object), content: '«redacted: 2 chars»' } : message,
        ),
      ],
    ];
    for (const [group, want] of cases) {
      const out = (redactLine(line, [group]) as JsonlEvent).event as { messages: unknown };
      expect(out.messages, group).toEqual(want);
    }
  });

  it('redacts an unnamed message field, and an unknown role’s content, under any group', () => {
    const line = ev({
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'u', role: 'user', content: 'hi', extra: 'leak' },
        { id: 'z', role: 'narrator', content: 'story' },
      ],
    });

    expect((redactLine(line, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'u', role: 'user', content: 'hi', extra: '«redacted: 4 chars»' },
        { id: 'z', role: 'narrator', content: '«redacted: 5 chars»' },
      ],
    });
  });

  it('keeps a __proto__ key on a known event, a message and a patch op as redacted data', () => {
    const event = JSON.parse(
      '{"type":"MESSAGES_SNAPSHOT","__proto__":{"a":"top secret"},' +
        '"messages":[{"id":"u","role":"user","content":"hi","__proto__":{"b":"msg secret"}}]}',
    ) as Record<string, unknown>;
    const patch = JSON.parse(
      '{"type":"STATE_DELTA","delta":[{"op":"add","path":"/x","__proto__":{"c":"op secret"}}]}',
    ) as Record<string, unknown>;

    for (const input of [event, patch]) {
      const out = (redactLine(ev(input), ['text']) as JsonlEvent).event;
      const text = JSON.stringify(out);
      for (const secret of ['top secret', 'msg secret', 'op secret']) {
        expect(text).not.toContain(secret);
      }
      expect(text).toContain('"__proto__"');
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    }
  });

  it('does not resolve a field or a role through Object.prototype — `constructor` is not a rule', () => {
    // `rules['constructor']` is `Object`, which returns its argument: an unguarded lookup would
    // ship the field verbatim. `CONTENT_GROUP_BY_ROLE['constructor']` is `Object` too, which no
    // selection contains: an unguarded lookup would ship that message's content verbatim.
    const field = ev({ type: 'TEXT_MESSAGE_END', messageId: 'm', constructor: 'field secret' });
    const role = ev({
      type: 'MESSAGES_SNAPSHOT',
      messages: [{ id: 'x', role: 'constructor', content: 'role secret' }],
    });

    expect(JSON.stringify(redactLine(field, ['text']))).not.toContain('field secret');
    expect(JSON.stringify(redactLine(role, ['text']))).not.toContain('role secret');
    expect(JSON.stringify(redactLine(role, ['text']))).toContain('«redacted: 11 chars»');
  });

  it('redacts a request resume payload under any group, keeping interruptId and status', () => {
    const line: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: {
        threadId: 't',
        runId: 'r',
        resume: [{ interruptId: 'i', status: 'resolved', payload: 'yes' }],
      },
    };

    expect((redactLine(line, ['text']) as JsonlRequest).input).toEqual({
      threadId: 't',
      runId: 'r',
      resume: [{ interruptId: 'i', status: 'resolved', payload: '«redacted: 3 chars»' }],
    });
  });
});

describe('redactLine — a LangGraph Platform request body fails closed', () => {
  /*
   * A LangGraph Platform run's POST body is not a `RunAgentInput`: the user's prompt sits at
   * `input.messages[].content`, next to `command` (resume values), `config` and `metadata`.
   * `redactInput` reads only top-level `messages`/`state`/`context`/`forwardedProps`, so every
   * one of those shipped verbatim with every group selected. Until field-level LangGraph rules
   * land (spec L16), everything but the run's settings is redacted whenever any group is chosen.
   */
  const PROMPT = 'please summarise the confidential acquisition memo for me';
  const body = {
    assistant_id: 'agent',
    input: { messages: [{ type: 'human', content: PROMPT }] },
    command: { resume: 'approve the secret plan' },
    config: { configurable: { user_token: 'sk-secret-123' } },
    metadata: { note: 'private' },
    stream_mode: ['values', 'messages-tuple'],
    stream_subgraphs: true,
  };
  const line: JsonlRequest = {
    kind: 'request',
    connId: 'c1',
    tMs: 0,
    method: 'POST',
    url: 'http://localhost:2024/threads/t1/runs/stream',
    input: body,
  };

  it('redacts the prompt, command, config and metadata with only `text` selected', () => {
    const out = redactLine(deepFreeze(structuredClone(line)), ['text'], 'langgraph') as JsonlRequest;
    const text = JSON.stringify(out);
    for (const secret of [PROMPT, 'approve the secret plan', 'sk-secret-123', 'private']) {
      expect(text).not.toContain(secret);
    }
    const input = out.input as Record<string, unknown>;
    expect(input.assistant_id).toBe('agent');
    expect(input.stream_mode).toEqual(['values', 'messages-tuple']);
    expect(input.stream_subgraphs).toBe(true);
    // Structure survives, content does not.
    expect(input.input).toEqual({ messages: [{ type: '«redacted: 5 chars»', content: `«redacted: ${PROMPT.length} chars»` }] });
  });

  it('redacts every unknown key too — anything unclassified is content', () => {
    const out = redactLine({ ...line, input: { ...body, surprise: { x: 'mystery value' } } }, ['state'], 'langgraph');
    expect(JSON.stringify(out)).not.toContain('mystery value');
  });

  it('keeps a __proto__ key as data', () => {
    const input = JSON.parse('{"assistant_id":"agent","__proto__":{"leak":"prototype secret"}}') as unknown;
    const out = redactLine({ ...line, input }, ['text'], 'langgraph') as JsonlRequest;
    const redacted = out.input as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redacted, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('prototype secret');
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });

  it('redacts a non-object body wholesale', () => {
    const out = redactLine({ ...line, input: 'a raw body string' }, ['text'], 'langgraph') as JsonlRequest;
    expect(out.input).toBe('«redacted: 17 chars»');
  });

  it('returns the line unchanged when no group is selected', () => {
    expect(redactLine(line, [], 'langgraph')).toBe(line);
  });

  it('leaves an AG-UI request on the RunAgentInput path', () => {
    const agui: JsonlRequest = { ...line, input: { threadId: 't', messages: [{ role: 'user', content: 'hello there' }], metadata: { keep: 'me' } } };
    const out = redactLine(agui, ['text'], 'agui') as JsonlRequest;
    // `metadata` is not a `RunAgentInput` field, so it is content no group can claim and goes
    // under any group (LangGraph PR 4) — the RunAgentInput path is per field, not a passthrough.
    expect(out.input).toEqual({
      threadId: 't',
      messages: [{ role: 'user', content: '«redacted: 11 chars»' }],
      metadata: { keep: '«redacted: 2 chars»' },
    });
  });
});
