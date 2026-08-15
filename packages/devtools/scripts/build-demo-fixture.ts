/**
 * The capture the Chrome Web Store screenshots are shot against.
 *
 * Why not an existing fixture: `happy-run.agui.jsonl` is 15 events and `malformed.agui.jsonl` is
 * a validator unit test. Neither reads as a product. Why not a Tier B recording: `record.ts`
 * redacts every payload string, so a recorded capture photographs as «redacted: N chars».
 *
 * The content is fictional and deliberately dull — an order lookup. `framework` and the request
 * URL genuinely name CopilotKit, because that is the real integration this extension targets and
 * it is meant to be visible in the screenshots. What the fixture guarantees instead: no customer
 * or personal names, no credentials, nothing embarrassing.
 *
 * Exactly ONE validator issue, by construction: run 2 emits a TEXT_MESSAGE_CONTENT for a message
 * that has not been opened yet, which is `unopened-message-id`. Every other rule is deliberately
 * satisfied — steps balance, state deltas follow a snapshot and target paths that exist, tool
 * args concatenate to valid JSON, TOOL_CALL_END precedes TOOL_CALL_RESULT, no two text messages
 * are open at once, and every run has a request line carrying its input.
 *
 * Run: `pnpm listing:fixture`
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJsonl, type JsonlLine } from '../src/core/jsonl/codec';

const THREAD = 't_demo';

function header(): JsonlLine {
  return {
    kind: 'header',
    schemaVersion: 1,
    tool: 'ag-ui-devtools@0.1.0',
    // Fixed, never `new Date()`: the fixture must be byte-identical on every regeneration.
    capturedAt: '2026-08-15T09:00:00.000Z',
    url: 'http://localhost:3000/',
    framework: 'react/copilotkit',
    transport: 'sse',
    redacted: [],
  };
}

function request(connId: string, runId: string, prompt: string): JsonlLine {
  return {
    kind: 'request',
    connId,
    tMs: 0,
    method: 'POST',
    url: '/api/copilotkit/agent/support/run',
    input: {
      threadId: THREAD,
      runId,
      state: { order: null, steps: 0 },
      messages: [{ id: `m_user_${runId}`, role: 'user', content: prompt }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
  };
}

/** `seq` is global across the capture; `tMs` is per connection. */
function events(connId: string, from: number, list: Array<[number, unknown]>): JsonlLine[] {
  return list.map(([tMs, event], i) => ({
    kind: 'event',
    connId,
    seq: from + i,
    tMs,
    event: event as Record<string, unknown>,
  })) as JsonlLine[];
}

function runOne(): JsonlLine[] {
  const runId = 'r_demo_1';
  return events('c1', 1, [
    [12, { type: 'RUN_STARTED', threadId: THREAD, runId }],
    [28, { type: 'STEP_STARTED', stepName: 'plan' }],
    [44, { type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' }],
    [96, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Let me look up' }],
    [128, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: ' order 4417' }],
    [161, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: ' for you.' }],
    [180, { type: 'TEXT_MESSAGE_END', messageId: 'm_1' }],
    [188, { type: 'STEP_FINISHED', stepName: 'plan' }],
    [201, { type: 'STEP_STARTED', stepName: 'lookup' }],
    [
      214,
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'tc_1',
        toolCallName: 'lookup_order',
        parentMessageId: 'm_1',
      },
    ],
    [232, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"orderId":' }],
    [251, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: ' "4417",' }],
    [270, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: ' "include": ["shipping"]}' }],
    [284, { type: 'TOOL_CALL_END', toolCallId: 'tc_1' }],
    [
      812,
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'tc_1',
        messageId: 'm_tool_1',
        content:
          '{"orderId":"4417","status":"in_transit","carrier":"Northwind","eta":"2026-08-18"}',
      },
    ],
    [
      840,
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { order: { id: '4417', status: 'unknown', carrier: null }, steps: 0 },
      },
    ],
    [
      858,
      {
        type: 'STATE_DELTA',
        delta: [
          { op: 'replace', path: '/order/status', value: 'in_transit' },
          { op: 'replace', path: '/order/carrier', value: 'Northwind' },
        ],
      },
    ],
    [872, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/steps', value: 1 }] }],
    [886, { type: 'STEP_FINISHED', stepName: 'lookup' }],
    [900, { type: 'STEP_STARTED', stepName: 'respond' }],
    [918, { type: 'TEXT_MESSAGE_START', messageId: 'm_2', role: 'assistant' }],
    [962, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: 'Order 4417 is in transit' }],
    [1004, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: ' with Northwind and should' }],
    [1041, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: ' arrive on 18 August.' }],
    [1058, { type: 'TEXT_MESSAGE_END', messageId: 'm_2' }],
    [1070, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/steps', value: 2 }] }],
    [1082, { type: 'STEP_FINISHED', stepName: 'respond' }],
    [1094, { type: 'RUN_FINISHED', threadId: THREAD, runId }],
  ]);
}

/**
 * `startSeq` is the caller's job, not this function's: seq is global across the whole capture,
 * so run 2 cannot know where it starts without knowing how many events run 1 emitted. Hardcoding
 * it here once was exactly the bug — add or remove an event in `runOne` and this offset silently
 * stops matching, producing either a seq collision or a gap that nothing in the codec or the
 * validator catches (the "anchors that violation" test would still pass on a collision, just
 * against the wrong record).
 */
function runTwo(startSeq: number): JsonlLine[] {
  const runId = 'r_demo_2';
  return events('c2', startSeq, [
    [11, { type: 'RUN_STARTED', threadId: THREAD, runId }],
    [24, { type: 'STEP_STARTED', stepName: 'respond' }],
    // THE VIOLATION. A delta for a message the stream never opened — `unopened-message-id`.
    // This is the single issue the whole fixture exists to make visible in shot 2.
    //
    // Deliberately no TEXT_MESSAGE_START for m_3 anywhere in this run: `ensureMessage` in
    // run-builder.ts materializes the message (and adds it to `openTextMessages`) on first
    // sight regardless of which event opened it, so a START placed after this line would
    // find the id already "open" and trip `concurrent-text-messages` too — turning the one
    // violation this fixture exists to show into two.
    [
      63,
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_3', delta: 'Your replacement label' },
    ],
    [119, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_3', delta: ' is ready to print.' }],
    [136, { type: 'TEXT_MESSAGE_END', messageId: 'm_3' }],
    [148, { type: 'STEP_FINISHED', stepName: 'respond' }],
    [160, { type: 'RUN_FINISHED', threadId: THREAD, runId }],
  ]);
}

export function buildDemoFixture(): string {
  const one = runOne();
  const two = runTwo(1 + one.length);
  return encodeJsonl([
    header(),
    request('c1', 'r_demo_1', 'Where is my order 4417?'),
    ...one,
    request('c2', 'r_demo_2', 'Can you resend the return label?'),
    ...two,
  ]);
}

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../listing/fixtures/demo.agui.jsonl',
);

/** Only write when invoked as a CLI; importing this module must have no side effect. */
if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('build-demo-fixture.ts')) {
  writeFileSync(outPath, buildDemoFixture(), 'utf8');
  console.log(`wrote ${outPath}`);
}
