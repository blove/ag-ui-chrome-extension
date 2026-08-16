/**
 * E6 — the independent leak check that gates a redacted export.
 *
 * This file deliberately RESTATES requirements §11's five groups — text deltas, reasoning
 * content, tool arguments, tool results, and state values — instead of importing anything from
 * `redact.ts`. A check that shares its subject's definition of the answer verifies nothing: it
 * would agree with the redactor about which fields exist, and therefore agree with it about which
 * fields do not.
 *
 * That is not hypothetical here. On 2026-08-15 `redact.ts`'s first consumer shipped a hole its
 * own tests could not see — `RUN_STARTED.input` echoes the whole `RunAgentInput`, so a live
 * recording carried the user's prompt through a redactor that every hand-written fixture agreed
 * was complete (`packages/harness/record.ts`, `leakedValues`). Export is `redact.ts`'s second
 * consumer, and the only one whose entire purpose is handing a file to another human. So the same
 * gate is restated here, over the lines an export actually writes: the request line as well as
 * the events, because the request line is where the user's own message lives.
 *
 * If `redact.ts` ever stops covering a field this file names, this fails. If the protocol grows a
 * payload field, this file is where it has to be added — and the failure is the reminder.
 */
import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import type { JsonlLine } from '../../core/jsonl/codec';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport, type ExportSource } from './build';

const OPTIONS = { toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every string leaf under `value`, however deeply nested. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
}

/**
 * The payload strings a `RunAgentInput` carries, wherever one appears: the captured request body,
 * or the copy the protocol echoes back in `RUN_STARTED.input`.
 *
 * Only payload fields are listed. `id`, `role`, `threadId`, `runId`, `tools` and a tool call's
 * `name` survive redaction by design — §11 names no group that owns developer-authored structure
 * — so treating them as payload would report a leak on every clean export.
 */
function inputPayload(input: unknown, out: string[]): void {
  if (!isObject(input)) return;
  if (Array.isArray(input.messages)) {
    for (const message of input.messages) {
      if (!isObject(message)) continue;
      stringLeaves(message.content, out);
      if (!Array.isArray(message.toolCalls)) continue;
      for (const call of message.toolCalls) {
        if (isObject(call) && isObject(call.function)) stringLeaves(call.function.arguments, out);
      }
    }
  }
  stringLeaves(input.state, out);
  stringLeaves(input.context, out);
  stringLeaves(input.forwardedProps, out);
}

/** The payload strings one event carries, by event type. §11's five groups, restated. */
function eventPayload(event: unknown, out: string[]): void {
  if (!isObject(event)) return;
  const type = typeof event.type === 'string' ? event.type : '';
  switch (type) {
    // `delta` is the payload field for three of the five groups: text, reasoning and toolArgs.
    case 'TEXT_MESSAGE_CONTENT':
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CONTENT':
    case 'REASONING_MESSAGE_CHUNK':
    case 'TOOL_CALL_ARGS':
    case 'TOOL_CALL_CHUNK':
      stringLeaves(event.delta, out);
      break;
    case 'REASONING_ENCRYPTED_VALUE':
      stringLeaves(event.encryptedValue, out);
      break;
    case 'TOOL_CALL_RESULT':
      stringLeaves(event.content, out);
      break;
    case 'STATE_SNAPSHOT':
      stringLeaves(event.snapshot, out);
      break;
    case 'STATE_DELTA':
      if (Array.isArray(event.delta)) {
        for (const op of event.delta) if (isObject(op)) stringLeaves(op.value, out);
      }
      break;
    case 'RUN_STARTED':
      inputPayload(event.input, out);
      break;
    default:
      break;
  }
}

/** Every payload string one export line carries, before redaction. */
function payloadStrings(line: JsonlLine): string[] {
  const out: string[] = [];
  if (line.kind === 'event') eventPayload(line.event, out);
  // The request line is half of what a bug report leaks: the user's own message is in the POST
  // body and in no event at all.
  if (line.kind === 'request') inputPayload(line.input, out);
  // Two characters cannot identify anyone and a stream is full of them; a short delta's LENGTH
  // survives redaction by design anyway, so the placeholder itself would match.
  return out.filter((text) => text.trim().length >= 3);
}

/**
 * Payload strings from `raw` that still appear verbatim among `redacted`'s string leaves.
 *
 * Leaf against leaf rather than against `JSON.stringify(redacted)`: serializing escapes the quotes
 * in a `TOOL_CALL_ARGS` delta — which carries JSON — so a substring search for the original text
 * would miss it and this gate would pass silently. That exact mistake is recorded in
 * `packages/harness/record.ts`.
 */
function leakedValues(raw: readonly JsonlLine[], redacted: readonly JsonlLine[]): string[] {
  const survivors: string[] = [];
  stringLeaves(redacted, survivors);
  const leaks = new Set<string>();
  for (const line of raw) {
    for (const text of payloadStrings(line)) {
      // `includes`, not equality: a payload embedded in a larger string is still a leak.
      if (survivors.some((survivor) => survivor.includes(text))) leaks.add(text);
    }
  }
  return [...leaks];
}

/**
 * A capture with something from every one of §11's five groups, plus the `RUN_STARTED.input`
 * echo that the redactor's first consumer missed.
 */
const EVERY_GROUP = [
  '{"kind":"header","schemaVersion":1,"tool":"t","capturedAt":"2026-08-15T00:00:00.000Z","url":"http://localhost:3000/","transport":"sse","redacted":[]}',
  '{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/run","input":{"threadId":"t1","runId":"r1","messages":[{"id":"u1","role":"user","content":"my private prompt about acquisition targets"},{"id":"a1","role":"assistant","toolCalls":[{"id":"tc0","function":{"name":"search","arguments":"{\\"q\\":\\"confidential query string\\"}"}}]},{"id":"t0","role":"tool","content":"a previous tool result with numbers"}],"state":{"apiToken":"sk-live-not-a-real-secret"},"context":[{"description":"the customer name is Contoso"}],"forwardedProps":{"session":"forwarded secret value"}}}',
  '{"kind":"event","connId":"c1","seq":1,"tMs":1,"event":{"type":"RUN_STARTED","threadId":"t1","runId":"r1","input":{"threadId":"t1","runId":"r1","messages":[{"id":"u1","role":"user","content":"my private prompt about acquisition targets"}],"state":{"apiToken":"sk-live-not-a-real-secret"},"context":[{"description":"the customer name is Contoso"}],"forwardedProps":{"session":"forwarded secret value"}}}}',
  '{"kind":"event","connId":"c1","seq":2,"tMs":2,"event":{"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}}',
  '{"kind":"event","connId":"c1","seq":3,"tMs":3,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"the answer mentions a real customer"}}',
  '{"kind":"event","connId":"c1","seq":4,"tMs":4,"event":{"type":"TEXT_MESSAGE_END","messageId":"m1"}}',
  '{"kind":"event","connId":"c1","seq":5,"tMs":5,"event":{"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","delta":"a chunked fragment of prose"}}',
  '{"kind":"event","connId":"c1","seq":6,"tMs":6,"event":{"type":"REASONING_MESSAGE_START","messageId":"rm1"}}',
  '{"kind":"event","connId":"c1","seq":7,"tMs":7,"event":{"type":"REASONING_MESSAGE_CONTENT","messageId":"rm1","delta":"the model is thinking about the customer"}}',
  '{"kind":"event","connId":"c1","seq":8,"tMs":8,"event":{"type":"REASONING_MESSAGE_CHUNK","messageId":"rm2","delta":"more private deliberation"}}',
  '{"kind":"event","connId":"c1","seq":9,"tMs":9,"event":{"type":"REASONING_ENCRYPTED_VALUE","messageId":"rm1","encryptedValue":"opaque-but-still-not-ours-to-share"}}',
  '{"kind":"event","connId":"c1","seq":10,"tMs":10,"event":{"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"search"}}',
  '{"kind":"event","connId":"c1","seq":11,"tMs":11,"event":{"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\\"query\\":\\"internal revenue figures\\"}"}}',
  '{"kind":"event","connId":"c1","seq":12,"tMs":12,"event":{"type":"TOOL_CALL_END","toolCallId":"tc1"}}',
  '{"kind":"event","connId":"c1","seq":13,"tMs":13,"event":{"type":"TOOL_CALL_CHUNK","toolCallId":"tc2","toolCallName":"lookup","delta":"{\\"id\\":\\"chunked argument payload\\"}"}}',
  '{"kind":"event","connId":"c1","seq":14,"tMs":14,"event":{"type":"TOOL_CALL_RESULT","messageId":"m3","toolCallId":"tc1","role":"tool","content":"{\\"revenue\\":\\"the actual number nobody should see\\"}"}}',
  '{"kind":"event","connId":"c1","seq":15,"tMs":15,"event":{"type":"STATE_SNAPSHOT","snapshot":{"customer":"Contoso Ltd","notes":["a note with real content"]}}}',
  '{"kind":"event","connId":"c1","seq":16,"tMs":16,"event":{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/customer","value":"Fabrikam Inc"},{"op":"add","path":"/notes/-","value":"a second real note"}]}}',
  '{"kind":"event","connId":"c1","seq":17,"tMs":17,"event":{"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}}',
  '',
].join('\n');

function sourceOf(text: string): ExportSource {
  const loaded = loadJsonl(text);
  return {
    records: loaded.records,
    requests: loaded.requests,
    runs: loaded.runs,
    importedHeader: loaded.header,
    runtime: loaded.runtime,
    framework: null,
    binaryTransport: null,
    source: { kind: 'imported', filename: 'capture.agui.jsonl', importedAtMs: 0 },
  };
}

function exportWith(text: string, groups: RedactionGroup[]): JsonlLine[] {
  return buildExport(sourceOf(text), { scope: null, groups, ...OPTIONS }).lines;
}

describe('the leak check itself', () => {
  test('finds a payload string that survived, or it is not a gate at all', () => {
    // An "export" that redacted nothing must be reported as leaking. Without this the whole file
    // could be vacuously green — which is the failure mode E6 exists to rule out.
    const unredacted = exportWith(EVERY_GROUP, []);
    expect(leakedValues(unredacted, unredacted).sort()).toEqual(
      [
        'a chunked fragment of prose',
        'a note with real content',
        'a previous tool result with numbers',
        'a second real note',
        'forwarded secret value',
        'my private prompt about acquisition targets',
        'opaque-but-still-not-ours-to-share',
        'sk-live-not-a-real-secret',
        '{"revenue":"the actual number nobody should see"}',
        'the answer mentions a real customer',
        'the customer name is Contoso',
        'the model is thinking about the customer',
        '{"id":"chunked argument payload"}',
        '{"q":"confidential query string"}',
        '{"query":"internal revenue figures"}',
        'Contoso Ltd',
        'Fabrikam Inc',
        'more private deliberation',
      ].sort(),
    );
  });
});

describe('E6: a fully redacted export leaks nothing', () => {
  test('no payload string from any of §11’s five groups survives', () => {
    const raw = exportWith(EVERY_GROUP, []);
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
  });

  test('the same holds for the golden happy-run capture', () => {
    const raw = exportWith(happyJsonl, []);
    const redacted = exportWith(happyJsonl, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
  });

  test('a run-scoped redacted export leaks nothing either', () => {
    const source = sourceOf(EVERY_GROUP);
    const raw = buildExport(source, { scope: 'r1', groups: [], ...OPTIONS }).lines;
    const redacted = buildExport(source, {
      scope: 'r1',
      groups: [...ALL_REDACTION_GROUPS],
      ...OPTIONS,
    }).lines;
    expect(leakedValues(raw, redacted)).toEqual([]);
  });
});

describe('E6: each group protects its own payload', () => {
  /**
   * Group by group, because §11 lets the user opt back into full fidelity PER GROUP. A redactor
   * that only worked when all five were selected would leak on every partial choice — and a
   * partial choice is the normal one for a bug report about tool arguments.
   */
  const byGroup: Record<RedactionGroup, string[]> = {
    text: ['the answer mentions a real customer', 'a chunked fragment of prose'],
    reasoning: [
      'the model is thinking about the customer',
      'more private deliberation',
      'opaque-but-still-not-ours-to-share',
    ],
    toolArgs: ['{"query":"internal revenue figures"}', '{"id":"chunked argument payload"}'],
    toolResults: ['{"revenue":"the actual number nobody should see"}'],
    state: ['Contoso Ltd', 'Fabrikam Inc', 'a note with real content', 'a second real note'],
  };

  for (const group of ALL_REDACTION_GROUPS) {
    test(`selecting only \`${group}\` removes everything that group owns`, () => {
      const redacted = exportWith(EVERY_GROUP, [group]);
      const survivors: string[] = [];
      stringLeaves(redacted, survivors);
      for (const secret of byGroup[group]) {
        expect(survivors.some((survivor) => survivor.includes(secret))).toBe(false);
      }
    });
  }
});

describe('E6: what must NOT be redacted, or the file stops being a bug report', () => {
  test('structure, ids, ordering and timings survive', () => {
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    const events = redacted.filter((line) => line.kind === 'event');
    expect(events.map((line) => (line.event as { type: string }).type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TEXT_MESSAGE_CHUNK',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CHUNK',
      'REASONING_ENCRYPTED_VALUE',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_CHUNK',
      'TOOL_CALL_RESULT',
      'STATE_SNAPSHOT',
      'STATE_DELTA',
      'RUN_FINISHED',
    ]);
    expect(events.map((line) => line.tMs)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  test('a tool call keeps its NAME — a bug report about the wrong tool needs it', () => {
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    const start = redacted.find(
      (line) => line.kind === 'event' && (line.event as { type: string }).type === 'TOOL_CALL_START',
    );
    expect((start as { event: { toolCallName: string } }).event.toolCallName).toBe('search');
  });

  test('a state patch keeps its JSON Pointer paths and its ops', () => {
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    const delta = redacted.find(
      (line) => line.kind === 'event' && (line.event as { type: string }).type === 'STATE_DELTA',
    );
    const ops = (delta as { event: { delta: { op: string; path: string }[] } }).event.delta;
    expect(ops.map((op) => `${op.op} ${op.path}`)).toEqual(['replace /customer', 'add /notes/-']);
  });

  test('the placeholder keeps the size, which is what a protocol bug report is about', () => {
    const redacted = exportWith(EVERY_GROUP, ['text']);
    const content = redacted.find(
      (line) =>
        line.kind === 'event' && (line.event as { type: string }).type === 'TEXT_MESSAGE_CONTENT',
    );
    expect((content as { event: { delta: string } }).event.delta).toBe('«redacted: 35 chars»');
  });
});
