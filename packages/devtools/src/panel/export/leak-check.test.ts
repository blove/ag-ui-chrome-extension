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
 * Fields §11 promises survive: structure, not content. Restated here rather than imported, for
 * the reason at the top of this file. `role`, `name`, `toolCallName`, `stepName`, `activityType`,
 * `code` and `source` are developer-authored labels, not anything a user typed or a model wrote.
 *
 * Everything NOT on this list is treated as payload by `eventPayload` below. That makes this
 * check fail closed the same way the export must: @ag-ui/core's `BaseEventSchema` is
 * `.passthrough()`, so any event may carry fields no schema names, and the optional `rawEvent`
 * that every event may carry is typically the upstream provider's own chunk, content and all.
 */
const STRUCTURAL_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'timestamp',
  'threadId',
  'runId',
  'parentRunId',
  'messageId',
  'parentMessageId',
  'toolCallId',
  'toolCallName',
  'entityId',
  'subtype',
  'role',
  'name',
  'stepName',
  'activityType',
  'replace',
  'code',
  'source',
  // Not in the schema, but CopilotKit sends it on `RUN_STARTED` and it names the agent.
  'agentId',
]);

/** Every string leaf of `value` except the top-level keys `keep` names. */
function leavesExcept(value: unknown, keep: readonly string[], out: string[]): void {
  if (!isObject(value)) {
    stringLeaves(value, out);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!keep.includes(key)) stringLeaves(child, out);
  }
}

/**
 * The payload strings one message carries, in a `MESSAGES_SNAPSHOT` or a `RunAgentInput`.
 *
 * `id`, `role`, `name`, `toolCallId` and `activityType` are structure; a tool call keeps its `id`,
 * `type` and function `name`. Everything else — `content` whatever the role, `encryptedValue`, a
 * tool message's `error`, a tool call's arguments — is payload.
 */
function messagePayload(message: unknown, out: string[]): void {
  if (!isObject(message)) {
    stringLeaves(message, out);
    return;
  }
  for (const [key, child] of Object.entries(message)) {
    if (['id', 'role', 'name', 'toolCallId', 'activityType'].includes(key)) continue;
    if (key === 'toolCalls' && Array.isArray(child)) {
      for (const call of child) {
        if (!isObject(call)) {
          stringLeaves(call, out);
          continue;
        }
        for (const [callKey, callChild] of Object.entries(call)) {
          if (callKey === 'id' || callKey === 'type') continue;
          if (callKey === 'function') leavesExcept(callChild, ['name'], out);
          else stringLeaves(callChild, out);
        }
      }
      continue;
    }
    stringLeaves(child, out);
  }
}

/**
 * The payload strings a `RunAgentInput` carries, wherever one appears: the captured request body,
 * or the copy the protocol echoes back in `RUN_STARTED.input`.
 *
 * `threadId`, `runId`, `parentRunId` and `tools` survive redaction by design — §11 names no
 * group that owns developer-authored structure — so treating them as payload would report a leak
 * on every clean export. A `resume` entry keeps its `interruptId` and `status`; its `payload`
 * is the user's answer to an interrupt.
 */
function inputPayload(input: unknown, out: string[]): void {
  if (!isObject(input)) return;
  for (const [key, child] of Object.entries(input)) {
    if (['threadId', 'runId', 'parentRunId', 'tools'].includes(key)) continue;
    if (key === 'messages' && Array.isArray(child)) {
      for (const message of child) messagePayload(message, out);
    } else if (key === 'resume' && Array.isArray(child)) {
      for (const entry of child) leavesExcept(entry, ['interruptId', 'status'], out);
    } else {
      stringLeaves(child, out);
    }
  }
}

/** A JSON Patch keeps its `op`, `path` and `from`: those are what decide whether it applies. */
function patchPayload(ops: unknown, out: string[]): void {
  if (!Array.isArray(ops)) {
    stringLeaves(ops, out);
    return;
  }
  for (const op of ops) leavesExcept(op, ['op', 'path', 'from'], out);
}

/** A `RUN_FINISHED.outcome` keeps its `type`, and each interrupt its ids and expiry. */
function outcomePayload(outcome: unknown, out: string[]): void {
  if (!isObject(outcome)) {
    stringLeaves(outcome, out);
    return;
  }
  for (const [key, child] of Object.entries(outcome)) {
    if (key === 'type') continue;
    if (key === 'interrupts' && Array.isArray(child)) {
      for (const interrupt of child) {
        leavesExcept(interrupt, ['id', 'toolCallId', 'expiresAt'], out);
      }
    } else {
      stringLeaves(child, out);
    }
  }
}

/**
 * The payload strings one event carries. §11's five groups, restated — plus everything no group
 * can claim (a `CUSTOM` value, a `RAW` event, `rawEvent`, a run's error message and result),
 * which a redacted export must not carry either.
 */
function eventPayload(event: unknown, out: string[]): void {
  if (!isObject(event)) return;
  const type = typeof event.type === 'string' ? event.type : '';
  for (const [key, child] of Object.entries(event)) {
    if (STRUCTURAL_EVENT_FIELDS.has(key)) continue;
    if (type === 'RUN_STARTED' && key === 'input') inputPayload(child, out);
    else if (type === 'MESSAGES_SNAPSHOT' && key === 'messages' && Array.isArray(child)) {
      for (const message of child) messagePayload(message, out);
    } else if (type === 'STATE_DELTA' && key === 'delta') patchPayload(child, out);
    else if (type === 'ACTIVITY_DELTA' && key === 'patch') patchPayload(child, out);
    else if (type === 'RUN_FINISHED' && key === 'outcome') outcomePayload(child, out);
    else stringLeaves(child, out);
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
  // The header's `redacted` list names the groups that ran — `text` among them — which is the
  // export describing itself, not captured content surviving. Left in, a user message part's
  // `{"type":"text"}` would read as a leak on every redacted export.
  for (const line of redacted) {
    stringLeaves(line.kind === 'header' ? { ...line, redacted: [] } : line, survivors);
  }
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

/**
 * The rest of the protocol's content: every field that is neither one of `EVERY_GROUP`'s single
 * payload fields nor structure, as of @ag-ui/core 0.0.57.
 *
 * Until LangGraph PR 4 each of these shipped verbatim with every group selected, disclosed in a
 * PRIVACY.md caveat: a `MESSAGES_SNAPSHOT`'s messages (whose content belongs to a different group
 * per role), the deprecated `THINKING_*` events, activities, `CUSTOM` and `RAW`, a run's error
 * message, result and interrupt outcome, a `resume` answer on the request, an unknown passthrough
 * field, and the `rawEvent` any event may carry — here on a `TEXT_MESSAGE_CONTENT`, whose own
 * `delta` the redactor already understood.
 */
const EVERY_OTHER_FIELD = [
  JSON.stringify({
    kind: 'header',
    schemaVersion: 1,
    tool: 't',
    capturedAt: '2026-09-30T00:00:00.000Z',
    url: 'http://localhost:3000/',
    transport: 'sse',
    redacted: [],
  }),
  JSON.stringify({
    kind: 'request',
    connId: 'c1',
    tMs: 0,
    method: 'POST',
    url: '/run',
    input: {
      threadId: 't1',
      runId: 'r1',
      messages: [
        {
          id: 'u0',
          role: 'user',
          content: 'request user prompt',
          encryptedValue: 'request encrypted blob',
        },
      ],
      resume: [
        {
          interruptId: 'int0',
          status: 'resolved',
          payload: { answer: 'resume payload the user typed' },
        },
      ],
    },
  }),
  ...[
    { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
    {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 's1', role: 'system', content: 'system prompt with house rules' },
        { id: 'd1', role: 'developer', content: 'developer instructions verbatim' },
        { id: 'u1', role: 'user', name: 'ada', content: 'snapshot user prompt text' },
        {
          id: 'u2',
          role: 'user',
          content: [
            { type: 'text', text: 'multimodal user part' },
            { type: 'binary', mimeType: 'image/png', data: 'base64 image bytes here' },
          ],
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'snapshot assistant reply',
          toolCalls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"snapshot tool arguments"}' },
              encryptedValue: 'encrypted tool call reasoning',
            },
          ],
        },
        {
          id: 'tm1',
          role: 'tool',
          toolCallId: 'tc1',
          content: 'snapshot tool result body',
          error: 'snapshot tool error text',
        },
        {
          id: 'rm1',
          role: 'reasoning',
          content: 'snapshot reasoning body',
          encryptedValue: 'encrypted reasoning blob',
        },
        {
          id: 'am1',
          role: 'activity',
          activityType: 'progress',
          content: { status: 'activity message content' },
        },
      ],
    },
    { type: 'THINKING_START', title: 'thinking title text' },
    { type: 'THINKING_TEXT_MESSAGE_START' },
    { type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: 'deprecated thinking delta' },
    { type: 'THINKING_TEXT_MESSAGE_END' },
    { type: 'THINKING_END' },
    {
      type: 'ACTIVITY_SNAPSHOT',
      messageId: 'am2',
      activityType: 'search',
      content: { query: 'activity snapshot content' },
    },
    {
      type: 'ACTIVITY_DELTA',
      messageId: 'am2',
      activityType: 'search',
      patch: [{ op: 'replace', path: '/query', value: 'activity patch value' }],
    },
    { type: 'CUSTOM', name: 'app.event', value: { note: 'custom event value' } },
    { type: 'RAW', source: 'provider', event: { chunk: 'raw provider chunk' } },
    { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'hi there friend',
      rawEvent: { choices: [{ delta: { content: 'rawEvent echo of a delta' } }] },
    },
    { type: 'TEXT_MESSAGE_END', messageId: 'm1', extraField: 'an unknown passthrough field' },
    {
      type: 'RUN_FINISHED',
      threadId: 't1',
      runId: 'r1',
      result: { answer: 'run finished result' },
      outcome: {
        type: 'interrupt',
        interrupts: [
          {
            id: 'int1',
            reason: 'approval needed for wire',
            message: 'interrupt message to user',
            toolCallId: 'tc1',
            responseSchema: { description: 'response schema text' },
            expiresAt: '2026-10-01T00:00:00.000Z',
            metadata: { k: 'interrupt metadata value' },
          },
        ],
      },
    },
    { type: 'RUN_STARTED', threadId: 't1', runId: 'r2' },
    { type: 'RUN_ERROR', code: 'RATE_LIMITED', message: 'run error message with detail' },
  ].map((event, index) =>
    JSON.stringify({ kind: 'event', connId: 'c1', seq: index + 1, tMs: index + 1, event }),
  ),
  '',
].join('\n');

/**
 * `EVERY_OTHER_FIELD`'s payload strings, by the group that owns them. §11 has five groups; what
 * no group can claim — content whose meaning the extension cannot know — is `anyGroup`: removed
 * by selecting any one of them, because guessing which group it belongs to and guessing wrong
 * would ship it.
 */
const OTHER_BY_GROUP: Record<RedactionGroup | 'anyGroup', string[]> = {
  text: [
    'request user prompt',
    'system prompt with house rules',
    'developer instructions verbatim',
    'snapshot user prompt text',
    'multimodal user part',
    'base64 image bytes here',
    'snapshot assistant reply',
    'hi there friend',
  ],
  reasoning: [
    'request encrypted blob',
    'encrypted tool call reasoning',
    'snapshot reasoning body',
    'encrypted reasoning blob',
    'thinking title text',
    'deprecated thinking delta',
  ],
  toolArgs: ['{"q":"snapshot tool arguments"}'],
  toolResults: ['snapshot tool result body', 'snapshot tool error text'],
  state: ['activity message content', 'activity snapshot content', 'activity patch value'],
  anyGroup: [
    'resume payload the user typed',
    'custom event value',
    'raw provider chunk',
    'rawEvent echo of a delta',
    'an unknown passthrough field',
    'run finished result',
    'approval needed for wire',
    'interrupt message to user',
    'response schema text',
    'interrupt metadata value',
    'run error message with detail',
  ],
};

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

describe('the leak check sees every field, not only the five groups’ own', () => {
  test('finds every payload string in the rest of the protocol when nothing is redacted', () => {
    const unredacted = exportWith(EVERY_OTHER_FIELD, []);
    // `image/png` is a user message part's MIME type: part of a payload no field-level rule can
    // see into, so it is reported with the rest of that part.
    expect(leakedValues(unredacted, unredacted).sort()).toEqual(
      [...Object.values(OTHER_BY_GROUP).flat(), 'image/png', 'text', 'binary'].sort(),
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

  test('the same holds for every field outside the five groups’ own', () => {
    const raw = exportWith(EVERY_OTHER_FIELD, []);
    const redacted = exportWith(EVERY_OTHER_FIELD, [...ALL_REDACTION_GROUPS]);
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

describe('E6: each group protects its own share of the rest of the protocol', () => {
  for (const group of ALL_REDACTION_GROUPS) {
    test(`selecting only \`${group}\` removes what it owns and what no group can own`, () => {
      const redacted = exportWith(EVERY_OTHER_FIELD, [group]);
      const survivors: string[] = [];
      stringLeaves(redacted, survivors);
      for (const secret of [...OTHER_BY_GROUP[group], ...OTHER_BY_GROUP.anyGroup]) {
        expect(survivors.some((survivor) => survivor.includes(secret)), secret).toBe(false);
      }
    });

    test(`selecting only \`${group}\` leaves every other group’s content alone`, () => {
      // Per-field ownership is the point: a `MESSAGES_SNAPSHOT` tool message's content is a tool
      // RESULT, so selecting \`text\` must not reach it — or deselecting \`toolResults\` to share
      // a tool bug would silently strip the very thing being reported.
      const redacted = exportWith(EVERY_OTHER_FIELD, [group]);
      const survivors: string[] = [];
      stringLeaves(redacted, survivors);
      for (const other of ALL_REDACTION_GROUPS.filter((g) => g !== group)) {
        for (const kept of OTHER_BY_GROUP[other]) {
          expect(survivors.some((survivor) => survivor.includes(kept)), kept).toBe(true);
        }
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

  test('the rest of the protocol keeps its structure: ids, roles, names, codes, paths', () => {
    const redacted = exportWith(EVERY_OTHER_FIELD, [...ALL_REDACTION_GROUPS]);
    const byType = (type: string): Record<string, unknown> => {
      const line = redacted.find(
        (candidate) =>
          candidate.kind === 'event' && (candidate.event as { type: string }).type === type,
      );
      return (line as { event: Record<string, unknown> }).event;
    };

    const messages = byType('MESSAGES_SNAPSHOT').messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => `${String(m.id)}:${String(m.role)}`)).toEqual([
      's1:system',
      'd1:developer',
      'u1:user',
      'u2:user',
      'a1:assistant',
      'tm1:tool',
      'rm1:reasoning',
      'am1:activity',
    ]);
    expect(messages).toMatchObject([
      {},
      {},
      { name: 'ada' },
      {},
      { toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'search' } }] },
      { toolCallId: 'tc1' },
      {},
      { activityType: 'progress' },
    ]);

    expect(byType('ACTIVITY_DELTA').patch).toEqual([
      { op: 'replace', path: '/query', value: '«redacted: 20 chars»' },
    ]);
    expect(byType('ACTIVITY_SNAPSHOT').activityType).toBe('search');
    expect(byType('CUSTOM').name).toBe('app.event');
    expect(byType('RAW').source).toBe('provider');
    expect(byType('RUN_ERROR').code).toBe('RATE_LIMITED');
    expect(byType('RUN_FINISHED').outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ id: 'int1', toolCallId: 'tc1' }],
    });
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
