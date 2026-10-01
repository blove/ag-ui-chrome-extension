/**
 * The captures the Chrome Web Store screenshots are shot against — three of them, one per kind of
 * stream the 0.2.0 gallery photographs:
 *
 *   - `demo.agui.jsonl` — an AG-UI order lookup with exactly one protocol violation (shots 1, 2);
 *   - `demo-langgraph.agui.jsonl` — the same order lookup as LangGraph Platform streams it, with a
 *     tool call and graph state (shots 3, 5: the Derived events, and the Threadplane test export);
 *   - `demo-genui.agui.jsonl` — an AG-UI run that renders an A2UI surface the way CopilotKit's A2UI
 *     middleware does, against a catalog the app advertised (shot 4: the UI inspector).
 *
 * They are separate files, not more runs in one, because each shot's gate depends on its capture:
 * shot 2 reaches its violation by pressing End, and shot 5's Threadplane button is enabled only
 * for a capture with a LangGraph connection. Nothing in any of them needs a Threadplane
 * development build or its page hook — every screenshot depicts what an imported capture shows.
 *
 * What follows describes `demo.agui.jsonl`; the other two are documented at their builders.
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
    tool: 'ag-ui-devtools@0.2.0',
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

/* -------------------------------------------------------------------------- */
/* LangGraph Platform                                                          */
/* -------------------------------------------------------------------------- */

const LG_THREAD = 't_demo_lg';
const LG_RUN = 'r_demo_lg_1';

/**
 * The order lookup again, as LangGraph Platform streams it with `stream_mode` values,
 * messages-tuple and updates: a `metadata` frame, `messages` tuples whose chunks carry text and
 * `tool_call_chunks`, a `tool` message, `updates` per node and `values` after each step.
 *
 * Shaped like the Python server's serialization (`AIMessageChunk`, `chunk_position: 'last'`),
 * which is what `lg-reasoning.agui.jsonl` — a real recording — carries. No validator issue: the
 * expander folds it into one clean run, and the Threadplane test export accepts it.
 */
export function buildLangGraphDemoFixture(): string {
  const node = (name: string, step: number): Record<string, unknown> => ({
    langgraph_node: name,
    langgraph_step: step,
    run_id: LG_RUN,
    thread_id: LG_THREAD,
  });
  const chunk = (
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    type: 'AIMessageChunk',
    id,
    content: text === '' ? [] : [{ type: 'text', text, index: 0 }],
    tool_call_chunks: [],
    chunk_position: null,
    ...extra,
  });
  const human = {
    type: 'human',
    id: 'msg_user_1',
    content: 'Where is my order 4417?',
  };
  const askAi = {
    type: 'ai',
    id: 'lc_run--demo-1',
    content: 'Let me look up order 4417 for you.',
    tool_calls: [{ id: 'call_4417', name: 'lookup_order', args: { orderId: '4417', include: ['shipping'] } }],
  };
  const result =
    '{"orderId":"4417","status":"in_transit","carrier":"Northwind","eta":"2026-08-18"}';
  const tool = {
    type: 'tool',
    id: 'msg_tool_1',
    name: 'lookup_order',
    tool_call_id: 'call_4417',
    content: result,
  };
  const answerText = 'Order 4417 is in transit with Northwind and should arrive on 18 August.';
  const answerAi = { type: 'ai', id: 'lc_run--demo-2', content: answerText, tool_calls: [] };
  const order = { id: '4417', status: 'in_transit', carrier: 'Northwind', eta: '2026-08-18' };

  const frames: Array<[number, string, unknown]> = [
    [6, 'metadata', { run_id: LG_RUN, attempt: 1 }],
    [11, 'values', { messages: [human], order: null }],
    [58, 'messages', [chunk('lc_run--demo-1', 'Let me look up'), node('agent', 1)]],
    [83, 'messages', [chunk('lc_run--demo-1', ' order 4417'), node('agent', 1)]],
    [104, 'messages', [chunk('lc_run--demo-1', ' for you.'), node('agent', 1)]],
    [
      131,
      'messages',
      [
        chunk('lc_run--demo-1', '', {
          tool_call_chunks: [{ index: 0, id: 'call_4417', name: 'lookup_order', args: '' }],
        }),
        node('agent', 1),
      ],
    ],
    [
      152,
      'messages',
      [
        chunk('lc_run--demo-1', '', {
          tool_call_chunks: [{ index: 0, args: '{"orderId": "4417",' }],
        }),
        node('agent', 1),
      ],
    ],
    [
      170,
      'messages',
      [
        chunk('lc_run--demo-1', '', {
          tool_call_chunks: [{ index: 0, args: ' "include": ["shipping"]}' }],
        }),
        node('agent', 1),
      ],
    ],
    [
      184,
      'messages',
      [
        chunk('lc_run--demo-1', '', {
          chunk_position: 'last',
          usage_metadata: { input_tokens: 212, output_tokens: 31, total_tokens: 243 },
        }),
        node('agent', 1),
      ],
    ],
    [196, 'updates', { agent: { messages: [askAi] } }],
    [203, 'values', { messages: [human, askAi], order: null }],
    [742, 'messages', [tool, node('tools', 2)]],
    [751, 'updates', { tools: { messages: [tool], order } }],
    [760, 'values', { messages: [human, askAi, tool], order }],
    [812, 'messages', [chunk('lc_run--demo-2', 'Order 4417 is in transit'), node('agent', 3)]],
    [851, 'messages', [chunk('lc_run--demo-2', ' with Northwind and should'), node('agent', 3)]],
    [889, 'messages', [chunk('lc_run--demo-2', ' arrive on 18 August.'), node('agent', 3)]],
    [
      903,
      'messages',
      [
        chunk('lc_run--demo-2', '', {
          chunk_position: 'last',
          usage_metadata: { input_tokens: 287, output_tokens: 19, total_tokens: 306 },
        }),
        node('agent', 3),
      ],
    ],
    [915, 'updates', { agent: { messages: [answerAi] } }],
    [924, 'values', { messages: [human, askAi, tool, answerAi], order }],
  ];

  return encodeJsonl([
    {
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@0.2.0',
      capturedAt: '2026-10-01T09:00:00.000Z',
      url: 'http://localhost:4200/',
      transport: 'sse',
      redacted: [],
    },
    {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: `http://localhost:2024/threads/${LG_THREAD}/runs/stream`,
      input: {
        assistant_id: 'support',
        input: { messages: [{ type: 'human', content: human.content }] },
        stream_mode: ['values', 'messages-tuple', 'updates'],
      },
    },
    ...frames.map(
      ([tMs, sseEvent, event], i): JsonlLine => ({
        kind: 'event',
        connId: 'c1',
        seq: i + 1,
        tMs,
        sseEvent,
        event,
      }),
    ),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Generative UI                                                               */
/* -------------------------------------------------------------------------- */

const UI_THREAD = 't_demo_ui';
const UI_RUN = 'r_demo_ui_1';
const BASIC_CATALOG = 'https://a2ui.org/specification/v0_9/basic_catalog.json';

/**
 * An AG-UI run that renders an order card as an A2UI v0.9 surface, the way CopilotKit's A2UI
 * middleware puts one on the wire: a `render_a2ui` tool call whose progress is mirrored into
 * `a2ui-surface` ACTIVITY_SNAPSHOTs, against a catalog the app advertised in the request context
 * (the basic catalog plus one custom `OrderCard`).
 *
 * Exactly two catalog findings, by construction, and they are the shot's subject:
 *   - `DeliveryMap` is not in the advertised catalog — an unknown type, so it and its child do not
 *     render;
 *   - `OrderCard` is missing a prop the catalog marks required (`eta`).
 * Everything else — Column, Text, Row, Button with its child and action — is valid.
 */
export function buildGenUiDemoFixture(): string {
  const required = (component: string, props: string[]): Record<string, unknown> => ({
    allOf: [
      { $ref: 'common_types.json#/$defs/ComponentCommon' },
      { properties: { component: { const: component } }, required: ['component', ...props] },
    ],
  });
  const schema = {
    catalogId: BASIC_CATALOG,
    components: {
      Text: required('Text', ['text']),
      Row: required('Row', ['children']),
      Column: required('Column', ['children']),
      Card: required('Card', ['child']),
      Button: required('Button', ['child', 'action']),
      OrderCard: required('OrderCard', ['orderId', 'status', 'eta']),
    },
  };
  const components = [
    { id: 'root', component: 'Column', children: ['title', 'summary', 'actions'] },
    { id: 'title', component: 'Text', text: 'Order 4417' },
    { id: 'summary', component: 'OrderCard', orderId: '4417', status: { path: '/order/status' } },
    { id: 'actions', component: 'Row', children: ['track', 'map'] },
    { id: 'track', component: 'Button', child: 'trackLabel', action: { name: 'track_order' } },
    { id: 'trackLabel', component: 'Text', text: 'Track package' },
    { id: 'map', component: 'DeliveryMap', child: 'mapLabel' },
    { id: 'mapLabel', component: 'Text', text: 'Northwind depot' },
  ];
  const args = JSON.stringify({
    surfaceId: 'order-4417',
    components,
    data: { order: { status: 'in_transit' } },
  });
  const operations = (withData: boolean): unknown[] => [
    { version: 'v0.9', createSurface: { surfaceId: 'order-4417', catalogId: BASIC_CATALOG } },
    { version: 'v0.9', updateComponents: { surfaceId: 'order-4417', components } },
    ...(withData
      ? [
          {
            version: 'v0.9',
            updateDataModel: {
              surfaceId: 'order-4417',
              path: '/',
              value: { order: { status: 'in_transit' } },
            },
          },
        ]
      : []),
  ];
  const surface = (content: unknown): Record<string, unknown> => ({
    type: 'ACTIVITY_SNAPSHOT',
    messageId: 'a2ui-surface-tc_ui_1',
    activityType: 'a2ui-surface',
    content,
    replace: true,
  });

  const list: Array<[number, unknown]> = [
    [10, { type: 'RUN_STARTED', threadId: UI_THREAD, runId: UI_RUN }],
    [34, { type: 'TEXT_MESSAGE_START', messageId: 'm_ui_1', role: 'assistant' }],
    [71, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_ui_1', delta: 'Here is order 4417.' }],
    [88, { type: 'TEXT_MESSAGE_END', messageId: 'm_ui_1' }],
    [
      102,
      { type: 'TOOL_CALL_START', toolCallId: 'tc_ui_1', toolCallName: 'render_a2ui', parentMessageId: 'm_ui_1' },
    ],
    [110, surface({ status: 'building' })],
    [164, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_ui_1', delta: args }],
    [171, surface({ a2ui_operations: operations(false) })],
    [176, surface({ a2ui_operations: operations(true) })],
    [183, { type: 'TOOL_CALL_END', toolCallId: 'tc_ui_1' }],
    [197, { type: 'RUN_FINISHED', threadId: UI_THREAD, runId: UI_RUN }],
  ];

  return encodeJsonl([
    {
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@0.2.0',
      capturedAt: '2026-10-01T09:30:00.000Z',
      url: 'http://localhost:3000/',
      framework: 'react/copilotkit',
      transport: 'sse',
      redacted: [],
    },
    {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/api/copilotkit',
      input: {
        threadId: UI_THREAD,
        runId: UI_RUN,
        state: {},
        messages: [{ id: 'm_user_ui_1', role: 'user', content: 'Show me order 4417.' }],
        tools: [],
        context: [
          {
            description:
              'A2UI catalog capabilities: available catalog IDs and custom component definitions the client can render.',
            value: `Available A2UI catalog:\n- ${BASIC_CATALOG}\n  Extends the basic catalog with all standard components plus:\n  - OrderCard`,
          },
          {
            description:
              'A2UI Component Schema — available components for generating UI surfaces. Use these component names and properties when creating A2UI operations.',
            value: JSON.stringify(schema),
          },
        ],
        forwardedProps: {},
      },
    },
    ...events('c1', 1, list),
  ]);
}

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../listing/fixtures');

/** Every committed listing fixture, by file name, and the builder that produces it. */
export const LISTING_FIXTURES: ReadonlyArray<readonly [string, () => string]> = [
  ['demo.agui.jsonl', buildDemoFixture],
  ['demo-langgraph.agui.jsonl', buildLangGraphDemoFixture],
  ['demo-genui.agui.jsonl', buildGenUiDemoFixture],
];

/** Only write when invoked as a CLI; importing this module must have no side effect. */
if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('build-demo-fixture.ts')) {
  for (const [file, build] of LISTING_FIXTURES) {
    const outPath = resolve(fixturesDir, file);
    writeFileSync(outPath, build(), 'utf8');
    console.log(`wrote ${outPath}`);
  }
}
