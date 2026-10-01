/**
 * The Simulate tab's starting points (design R9): scripts the user edits as JSON before arming.
 *
 * Pure functions, each returning a fresh `ArmScript` — an adapter and its runs, everything an
 * `ArmCommand` holds but the id the panel mints when the user presses Arm (`armCommand`).
 *
 * WHAT EACH IS SHAPED AFTER. Not invented: every frame is the shape the real thing puts on the
 * wire, so a template exercises the app's real adapter code (R2).
 *
 *  - LangGraph frames are `{ event, data }` as the LangGraph SDK yields them — `event` the SSE
 *    event name (`messages` for the `messages-tuple` stream mode, `mode|ns` inside a subgraph),
 *    `data` the parsed payload. They are the same frames this extension captures, so each template
 *    is checked by running it through the extension's own LangGraph expander
 *    (`templates.test.ts`): the interrupt template's first run must read `interrupted`, its second
 *    `finished`.
 *  - AG-UI events are `@ag-ui/core` events. The interrupt is AG-UI's standard one —
 *    `RUN_FINISHED` with `outcome: { type: 'interrupt', interrupts: [...] }` — which Threadplane's
 *    AG-UI reducer (`libs/ag-ui/src/lib/reducer.ts`) turns into its `interrupt` signal and a
 *    paused run.
 *  - The subagent handoff is, for LangGraph, a `task` tool call, the
 *    `threadplane.subagent_binding` custom event Threadplane's middleware announces
 *    (`{ type, namespace: 'tools:<id>', tool_call_id }`, consumed by the bridge in
 *    `stream-manager.bridge.ts`), and the child's namespaced `messages|tools:<id>` frames; for
 *    AG-UI, `SUBAGENT_STARTED` / content events carrying `subagentRunId` / `SUBAGENT_FINISHED`,
 *    which the reducer routes into the child's activity entry.
 */
import type { CaptureRecord } from '../model/types';
import type { AgUiEventScript, AgUiRunScript, ArmCommand, LangGraphRunScript, SimAdapter } from './commands';

export type ArmScript =
  | { adapter: 'langgraph'; runs: LangGraphRunScript[] }
  | { adapter: 'ag-ui'; runs: AgUiRunScript[] };

export const TEMPLATE_IDS = ['interrupt', 'subagent-handoff', 'malformed-event'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const TEMPLATE_LABELS: Readonly<Record<TemplateId | 'replay', string>> = {
  interrupt: 'Interrupt (approval)',
  'subagent-handoff': 'Subagent handoff',
  'malformed-event': 'Malformed event',
  replay: 'Replay a captured run',
};

export function armCommand(armId: string, script: ArmScript): ArmCommand {
  return script.adapter === 'langgraph'
    ? { v: 1, armId, adapter: 'langgraph', runs: script.runs }
    : { v: 1, armId, adapter: 'ag-ui', runs: script.runs };
}

/* -------------------------------------------------------------------------- */
/* LangGraph                                                                    */
/* -------------------------------------------------------------------------- */

const QUESTION = 'Send the refund of $42 to the customer?';

function aiChunk(id: string, text: string, last = false): { event: string; data: unknown } {
  return {
    event: 'messages',
    data: [
      { type: 'AIMessageChunk', id, content: text, tool_call_chunks: [], ...(last ? { chunk_position: 'last' } : {}) },
      { langgraph_node: 'agent' },
    ],
  };
}

function langGraphInterrupt(): LangGraphRunScript[] {
  const human = { type: 'human', id: 'sim-h1', content: 'Refund order 1234.' };
  const asking = { type: 'ai', id: 'sim-a1', content: 'I need your approval first.' };
  const interrupt = [{ value: { question: QUESTION, action: 'refund', amount: 42 }, id: 'sim-interrupt-1' }];
  const done = { type: 'ai', id: 'sim-a2', content: 'Approved — the refund has been sent.' };
  return [
    {
      frames: [
        { event: 'metadata', data: { run_id: 'sim-run-1', attempt: 1 } },
        { event: 'values', data: { messages: [human] } },
        aiChunk('sim-a1', 'I need your approval first.', true),
        { event: 'updates', data: { agent: { messages: [asking] } } },
        { event: 'updates', data: { __interrupt__: interrupt } },
        { event: 'values', data: { messages: [human, asking], __interrupt__: interrupt } },
      ],
    },
    {
      frames: [
        { event: 'metadata', data: { run_id: 'sim-run-2', attempt: 1 } },
        { event: 'values', data: { messages: [human, asking] } },
        aiChunk('sim-a2', 'Approved — the refund has been sent.', true),
        { event: 'updates', data: { agent: { messages: [done] } } },
        { event: 'values', data: { messages: [human, asking, done] } },
      ],
    },
  ];
}

function langGraphHandoff(): LangGraphRunScript[] {
  const ns = 'tools:sim-child-1';
  const human = { type: 'human', id: 'sim-h1', content: 'Research the refund policy.' };
  const call = {
    type: 'ai',
    id: 'sim-a1',
    content: '',
    tool_calls: [{ id: 'sim-call-1', name: 'task', args: { subagent_type: 'researcher', description: 'Find the refund policy' } }],
  };
  const result = { type: 'tool', id: 'sim-t1', tool_call_id: 'sim-call-1', name: 'task', content: 'Refunds within 30 days.' };
  const answer = { type: 'ai', id: 'sim-a2', content: 'Refunds are accepted within 30 days.' };
  return [
    {
      frames: [
        { event: 'metadata', data: { run_id: 'sim-run-1', attempt: 1 } },
        { event: 'values', data: { messages: [human] } },
        { event: 'updates', data: { agent: { messages: [call] } } },
        { event: 'values', data: { messages: [human, call] } },
        { event: 'custom', data: { type: 'threadplane.subagent_binding', namespace: ns, tool_call_id: 'sim-call-1' } },
        {
          event: `messages|${ns}`,
          data: [
            { type: 'AIMessageChunk', id: 'sim-child-m1', content: 'Refunds within 30 days.', tool_call_chunks: [], chunk_position: 'last' },
            { langgraph_node: 'researcher', langgraph_checkpoint_ns: ns },
          ],
        },
        { event: `updates|${ns}`, data: { researcher: { messages: [{ type: 'ai', id: 'sim-child-m1', content: 'Refunds within 30 days.' }] } } },
        { event: 'updates', data: { tools: { messages: [result] } } },
        aiChunk('sim-a2', 'Refunds are accepted within 30 days.', true),
        { event: 'values', data: { messages: [human, call, result, answer] } },
      ],
    },
  ];
}

function langGraphMalformed(): LangGraphRunScript[] {
  return [
    {
      frames: [
        { event: 'metadata', data: { run_id: 'sim-run-1', attempt: 1 } },
        { event: 'values', data: { messages: [{ type: 'human', id: 'sim-h1', content: 'hi' }] } },
        // `messages` is a [chunk, metadata] tuple. This is neither.
        { event: 'messages', data: { not: 'a message tuple' } },
        // `values` is the graph's state object. This is a string.
        { event: 'values', data: 'not a state object' },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* AG-UI                                                                        */
/* -------------------------------------------------------------------------- */

function text(messageId: string, delta: string, extra: Record<string, unknown> = {}): AgUiEventScript[] {
  return [
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant', ...extra },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta, ...extra },
    { type: 'TEXT_MESSAGE_END', messageId, ...extra },
  ];
}

function agUiInterrupt(): AgUiRunScript[] {
  return [
    {
      events: [
        { type: 'RUN_STARTED', threadId: 'sim-thread', runId: 'sim-run-1' },
        ...text('sim-a1', 'I need your approval first.'),
        {
          type: 'RUN_FINISHED',
          threadId: 'sim-thread',
          runId: 'sim-run-1',
          outcome: {
            type: 'interrupt',
            interrupts: [{ id: 'sim-interrupt-1', reason: 'approval', message: QUESTION, metadata: { action: 'refund', amount: 42 } }],
          },
        },
      ],
    },
    {
      events: [
        { type: 'RUN_STARTED', threadId: 'sim-thread', runId: 'sim-run-2' },
        ...text('sim-a2', 'Approved — the refund has been sent.'),
        { type: 'RUN_FINISHED', threadId: 'sim-thread', runId: 'sim-run-2' },
      ],
    },
  ];
}

function agUiHandoff(): AgUiRunScript[] {
  const child = { subagentRunId: 'sim-child-1' };
  return [
    {
      events: [
        { type: 'RUN_STARTED', threadId: 'sim-thread', runId: 'sim-run-1' },
        { type: 'TOOL_CALL_START', toolCallId: 'sim-call-1', toolCallName: 'task', parentMessageId: 'sim-a1' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'sim-call-1', delta: '{"subagent_type":"researcher"}' },
        { type: 'TOOL_CALL_END', toolCallId: 'sim-call-1' },
        {
          type: 'SUBAGENT_STARTED',
          subagentRunId: 'sim-child-1',
          name: 'researcher',
          description: 'Find the refund policy',
          parentToolCallId: 'sim-call-1',
        },
        ...text('sim-child-m1', 'Refunds within 30 days.', child),
        { type: 'SUBAGENT_FINISHED', subagentRunId: 'sim-child-1', result: 'Refunds within 30 days.', outcome: { type: 'success' } },
        { type: 'TOOL_CALL_RESULT', messageId: 'sim-t1', toolCallId: 'sim-call-1', content: 'Refunds within 30 days.' },
        ...text('sim-a2', 'Refunds are accepted within 30 days.'),
        { type: 'RUN_FINISHED', threadId: 'sim-thread', runId: 'sim-run-1' },
      ],
    },
  ];
}

function agUiMalformed(): AgUiRunScript[] {
  return [
    {
      events: [
        { type: 'RUN_STARTED', threadId: 'sim-thread', runId: 'sim-run-1' },
        // A message that was never started, and a delta that is not a string.
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'sim-never-started', delta: 42 },
        { type: 'RUN_FINISHED', threadId: 'sim-thread', runId: 'sim-run-1' },
      ],
    },
  ];
}

/** A fresh copy of one template for one adapter. */
export function templateScript(adapter: SimAdapter, id: TemplateId): ArmScript {
  if (adapter === 'langgraph') {
    const runs = id === 'interrupt' ? langGraphInterrupt() : id === 'subagent-handoff' ? langGraphHandoff() : langGraphMalformed();
    return { adapter, runs };
  }
  const runs = id === 'interrupt' ? agUiInterrupt() : id === 'subagent-handoff' ? agUiHandoff() : agUiMalformed();
  return { adapter, runs };
}

/* -------------------------------------------------------------------------- */
/* Replay a captured run                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One captured run, as a one-run script: LangGraph frames as captured (the SSE name and the parsed
 * payload), AG-UI events as captured.
 *
 * `recordSeqs` is the run's (`Run.recordSeqs`); records are looked up by `seq`, so the caller may
 * pass every record it holds. Keepalives carry nothing to replay and are left out, and so is a
 * frame that did not decode into what its adapter needs — a LangGraph frame with no event name, an
 * AG-UI frame that is not an event object. The result is not limit-checked here: the caller runs
 * it through `parseArmCommand`, which says which limit a long run exceeds.
 */
export function replayScript(
  adapter: SimAdapter,
  records: readonly CaptureRecord[],
  recordSeqs: readonly number[],
): ArmScript {
  const bySeq = new Map(records.map((record) => [record.seq, record]));
  const picked = recordSeqs.map((seq) => bySeq.get(seq)).filter((record) => record?.kind === 'event');
  if (adapter === 'langgraph') {
    const frames = picked.flatMap((record) =>
      record?.kind === 'event' && record.sseEvent !== undefined && record.raw !== undefined
        ? [{ event: record.sseEvent, data: record.raw }]
        : [],
    );
    return { adapter, runs: [{ frames }] };
  }
  const events = picked.flatMap((record) =>
    record?.kind === 'event' && record.event !== null && typeof record.event.type === 'string'
      ? [record.event as AgUiEventScript]
      : [],
  );
  return { adapter, runs: [{ events }] };
}
