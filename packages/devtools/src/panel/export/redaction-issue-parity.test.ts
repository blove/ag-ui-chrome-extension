/**
 * Does redaction change what the validator says? Measured, per fixture, per group.
 *
 * `tool-args-not-json` was the third defect in this family found by giving `redact.ts` a real
 * consumer, after `RUN_STARTED.input` published verbatim and `redactString('')` destroying the
 * `empty-text-delta` signal. Each was found the same way: fold a redacted capture back through
 * the run builder and compare. This file is that comparison, run over every golden fixture and
 * every §11 group, so the next one is found by a test rather than by a reader of a shared bug
 * report.
 *
 * The invariant, in two halves:
 *
 *  - NOTHING IS INVENTED. No issue may appear after redaction that the original did not have.
 *    An invented issue is an accusation about the recipient's agent that the redactor authored,
 *    and the recipient has no way to tell the difference.
 *  - ONLY WITHDRAWN CLAIMS DISAPPEAR, and only where the group that ran actually destroyed that
 *    rule's evidence. A rule that goes quiet for any other reason has stopped working.
 *
 * As measured on 2026-08-15, exactly one rule falls in the second half — `tool-args-not-json`
 * under `toolArgs`. `state-patch-failed` is NOT affected in either direction: `redactPatch`
 * preserves paths and op names, so the same ops fail at the same positions for the same reasons.
 */
import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import malformedJsonl from '../../test/fixtures/malformed.agui.jsonl?raw';
import chunkedJsonl from '../../test/fixtures/chunked-run.agui.jsonl?raw';
import messagesEdgeJsonl from '../../test/fixtures/messages-edge.agui.jsonl?raw';
import stateEdgeJsonl from '../../test/fixtures/state-edge.agui.jsonl?raw';
import lgReasoningJsonl from '../../test/fixtures/lg-reasoning.agui.jsonl?raw';
import { aiChunk, langGraphJsonl } from '../../test/langgraph-capture';
import { encodeJsonl } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import { applyLoaded } from '../import/apply-loaded';
import { loadJsonl } from '../import/load-jsonl';
import { initialPanelState, type PanelState } from '../model/panel-types';
import { buildExport } from './build';

const OPTIONS = { toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' };

function afterImport(text: string): PanelState {
  const start: PanelState = { ...initialPanelState(), expandChunks: true };
  return applyLoaded(start, loadJsonl(text, { expandChunks: true }), 'c.agui.jsonl', 1000);
}

function exportText(s: PanelState, groups: RedactionGroup[]): string {
  return encodeJsonl(buildExport(s, { scope: s.scope, groups, ...OPTIONS }).lines);
}

/** An issue's identity for comparison: what was claimed, and about which frame. */
function keys(s: PanelState): string[] {
  return s.issues.map((issue) => `${issue.code}@${String(issue.seq)}`);
}

/**
 * A capture no golden fixture covers, so the sweep is not merely a sweep of five happy shapes.
 *
 * It carries a deprecated event, a `RUN_STARTED` echoing its whole `RunAgentInput` (the shape
 * that produced the first defect in this family), reasoning content, a tool result, an activity,
 * unbalanced steps and two concurrent text messages — every remaining rule family that has any
 * chance of reading a redacted field.
 */
const WIDE_JSONL = [
  {
    kind: 'header',
    schemaVersion: 1,
    tool: 't',
    capturedAt: '2026-08-15T00:00:00.000Z',
    url: 'http://localhost:3000/',
    transport: 'sse',
    redacted: [],
  },
  {
    kind: 'request',
    connId: 'c1',
    tMs: 0,
    method: 'POST',
    url: '/agent',
    input: {
      threadId: 't_wide',
      runId: 'r_wide',
      state: { counter: 1 },
      messages: [{ id: 'u1', role: 'user', content: 'go' }],
      tools: [{ name: 'f', description: 'd', parameters: {} }],
      context: [{ description: 'ctx', value: 'v' }],
      forwardedProps: { flag: true },
    },
  },
  ...[
    {
      type: 'RUN_STARTED',
      threadId: 't_wide',
      runId: 'r_wide',
      input: {
        threadId: 't_wide',
        runId: 'r_wide',
        state: { counter: 1 },
        messages: [
          { id: 'u1', role: 'user', content: 'go' },
          {
            id: 'a1',
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 'tc_x', function: { name: 'f', arguments: '{"a":1}' } }],
          },
          { id: 'r1', role: 'tool', toolCallId: 'tc_x', content: 'ok' },
        ],
      },
    },
    { type: 'THINKING_START' },
    { type: 'STEP_FINISHED', stepName: 'never-started' },
    { type: 'REASONING_MESSAGE_START', messageId: 'm_r', role: 'assistant' },
    { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm_r', delta: 'because' },
    { type: 'REASONING_MESSAGE_END', messageId: 'm_r' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm_a', role: 'assistant' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm_b', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_b', delta: 'hi' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_b', delta: '' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm_b' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm_a' },
    { type: 'ACTIVITY_SNAPSHOT', messageId: 'm_a', activityType: 'progress', content: { pct: 10 } },
    { type: 'TOOL_CALL_START', toolCallId: 'tc_1', toolCallName: 'f', parentMessageId: 'm_a' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"a":1,' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '"b":"two"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'tc_1' },
    { type: 'TOOL_CALL_RESULT', messageId: 'm_res', toolCallId: 'tc_1', role: 'tool', content: 'ok' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/counter', value: 9 }] },
    { type: 'STATE_SNAPSHOT', snapshot: { counter: 9, who: 'Ada' } },
    { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/gone/child', value: 1 }] },
    // LangGraph PR 4: the fields `redact.ts` now redacts per field rather than passing through —
    // a snapshot's messages by role, the deprecated THINKING content (including an EMPTY delta,
    // which `redactString` must keep empty), an activity patch, CUSTOM, RAW, and a `rawEvent` on
    // an event whose own payload a group owns.
    {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'u1', role: 'user', content: 'go' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'calling',
          toolCalls: [
            { id: 'tc_x', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          ],
        },
        { id: 'r1', role: 'tool', toolCallId: 'tc_x', content: 'ok', error: 'e' },
        { id: 'rs1', role: 'reasoning', content: 'hmm', encryptedValue: 'x' },
        { id: 'm_a', role: 'activity', activityType: 'progress', content: { pct: 10 } },
      ],
    },
    { type: 'THINKING_TEXT_MESSAGE_START' },
    { type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: 'pondering' },
    { type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: '' },
    { type: 'THINKING_TEXT_MESSAGE_END' },
    {
      type: 'ACTIVITY_DELTA',
      messageId: 'm_a',
      activityType: 'progress',
      patch: [{ op: 'replace', path: '/pct', value: 50 }],
    },
    { type: 'CUSTOM', name: 'app.event', value: { note: 'n' } },
    { type: 'RAW', source: 'provider', event: { chunk: 'c' } },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_res2',
      toolCallId: 'tc_1',
      role: 'tool',
      content: 'again',
      rawEvent: { upstream: 'again' },
    },
    // Task 6b follow-up: `redact.ts` now fails closed on payloads it cannot classify as AG-UI
    // events. These three run that wholesale-redaction path through the SAME validator-parity
    // sweep as every known-type rule above, so a rule that IS live over this fixture — e.g.
    // `deprecated-event`, `run-never-terminated` — is checked to invent or withdraw nothing over
    // them either, the same guarantee the rest of this file gives for known-type events.
    //
    // They do NOT exercise `checkShape` (the module that would raise `shape-invalid` or
    // `unknown-event-type` for an unrecognised or malformed `type`): it has no caller outside
    // its own unit tests, so nothing in the live import/run-builder pipeline raises those codes
    // today, redacted or not — "the authored wide capture really does exercise the other rule
    // families" below confirms neither code appears in the set this fixture actually produces.
    // Placed before `RUN_FINISHED`, not after: an event after the terminal event raises its own
    // `event-after-terminal` issue instead, which would exercise nothing new here.
    { type: 'FUTURE_EVENT', secret: 'unknown-type-event-payload' },
    { type: 42, note: 'numeric-type-event-payload' },
    'raw unparsed frame that never became JSON',
    { type: 'RUN_FINISHED', threadId: 't_wide', runId: 'r_wide' },
  ].map((event, index) => ({
    kind: 'event',
    connId: 'c1',
    seq: index + 1,
    tMs: (index + 1) * 10,
    event,
  })),
]
  .map((line) => JSON.stringify(line))
  .join('\n');

/**
 * A LangGraph Platform capture with something for every group: reasoning and text chunks, a tool
 * call's streamed args and its result with an artifact, cumulative partials and a complete, state
 * with an interrupt, a `custom` frame and an `error`-free close. Field-level redaction (L16) puts
 * placeholders exactly where the expander reads — tool args, partial text — so this is where a
 * claim redaction destroyed the evidence for would show up (L17).
 */
const LG_EVERY_GROUP = langGraphJsonl(
  [
    { event: 'metadata', data: { run_id: 'r-lg', attempt: 1 } },
    aiChunk('m1', [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking it over' }] }], {
      usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }),
    aiChunk('m1', [{ type: 'text', text: 'Looking it up.' }]),
    aiChunk('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_1', name: 'lookup', args: '{"account":' }] }),
    aiChunk('m1', [], { tool_call_chunks: [{ index: 0, args: '"ACME"}' }], chunk_position: 'last' }),
    {
      event: 'messages',
      data: [
        { type: 'tool', id: 't1', name: 'lookup', tool_call_id: 'call_1', content: 'revenue 4.2M', artifact: { rows: [1, 2] } },
        { langgraph_node: 'tools' },
      ],
    },
    { event: 'messages/partial', data: [{ type: 'ai', id: 'm2', content: 'The rev' }] },
    { event: 'messages/partial', data: [{ type: 'ai', id: 'm2', content: 'The revenue is 4.2M.' }] },
    { event: 'messages/complete', data: [{ type: 'ai', id: 'm2', content: 'The revenue is 4.2M.' }] },
    { event: 'custom', data: { progress: 'half way' } },
    { event: 'updates', data: { agent: { messages: [{ type: 'ai', id: 'm2', content: 'The revenue is 4.2M.' }] } } },
    {
      event: 'values',
      data: {
        messages: [
          { type: 'human', id: 'h1', content: 'what is the revenue' },
          { type: 'tool', id: 't1', tool_call_id: 'call_1', content: 'revenue 4.2M' },
        ],
        note: 'a state value',
      },
    },
    { event: 'updates', data: { __interrupt__: [{ value: { question: 'approve?' }, id: 'int-1' }] } },
  ],
  {
    body: {
      assistant_id: 'agent',
      input: { messages: [{ type: 'human', id: 'h1', content: 'what is the revenue' }] },
      command: { resume: 'yes', update: { note: 'x' } },
      config: { configurable: { user: 'u' } },
      stream_mode: ['values', 'messages-tuple', 'updates', 'custom'],
    },
  },
);

/** A subgraph run (L11): its frames are namespaced and fold into a child run. */
const LG_SUBGRAPH = langGraphJsonl(
  [
    { event: 'metadata', data: { run_id: 'r-sub', attempt: 1 } },
    { event: 'values', data: { messages: [{ type: 'human', id: 'h1', content: 'research this' }] } },
    {
      event: 'messages|research:t1',
      data: [{ type: 'AIMessageChunk', id: 's1', content: 'Sub', tool_call_chunks: [] }, { langgraph_node: 'researcher' }],
    },
    {
      event: 'messages|research:t1',
      data: [
        { type: 'AIMessageChunk', id: 's1', content: 'graph findings', tool_call_chunks: [], chunk_position: 'last' },
        { langgraph_node: 'researcher' },
      ],
    },
    { event: 'updates|research:t1', data: { researcher: { messages: [{ type: 'ai', id: 's1', content: 'Subgraph findings' }] } } },
    { event: 'values|research:t1', data: { messages: [{ type: 'ai', id: 's1', content: 'Subgraph findings' }], topic: 'x' } },
    { event: 'updates', data: { research: { findings: 'Subgraph findings' } } },
    aiChunk('m1', 'Summary of the findings', { chunk_position: 'last' }),
    {
      event: 'values',
      data: {
        messages: [
          { type: 'human', id: 'h1', content: 'research this' },
          { type: 'ai', id: 'm1', content: 'Summary of the findings' },
        ],
        findings: 'Subgraph findings',
      },
    },
  ],
  { body: { assistant_id: 'agent', input: { messages: [{ type: 'human', content: 'research this' }] }, stream_mode: ['values', 'messages-tuple', 'updates'], stream_subgraphs: true } },
);

const CAPTURES: Array<readonly [string, string]> = [
  ['happy-run', happyJsonl],
  ['malformed', malformedJsonl],
  ['chunked-run', chunkedJsonl],
  ['messages-edge', messagesEdgeJsonl],
  ['state-edge', stateEdgeJsonl],
  ['wide (authored here)', WIDE_JSONL],
  // A real LangGraph Platform capture: its request body is redacted fail-closed, and that must
  // still invent or withdraw nothing — the dialect comes from the URL, which survives.
  ['lg-reasoning', lgReasoningJsonl],
  // Field-level redaction (L16) leaves placeholders where the expander reads; it must decline
  // what they destroyed (L17) rather than invent an issue.
  ['lg every group (authored here)', LG_EVERY_GROUP],
  ['lg subgraph (authored here)', LG_SUBGRAPH],
];

/** Every single group, plus the "Redact everything" button's set. */
const GROUP_SETS: Array<readonly [string, RedactionGroup[]]> = [
  ...ALL_REDACTION_GROUPS.map((group): readonly [string, RedactionGroup[]] => [group, [group]]),
  ['all groups', [...ALL_REDACTION_GROUPS]],
];

describe('redaction never invents an issue', () => {
  for (const [name, text] of CAPTURES) {
    for (const [label, groups] of GROUP_SETS) {
      test(`${name} redacted with ${label} raises nothing new`, () => {
        const original = afterImport(text);
        const redacted = afterImport(exportText(original, groups));

        const before = keys(original);
        const invented = keys(redacted).filter((issue) => !before.includes(issue));

        expect(invented).toEqual([]);
      });
    }
  }
});

describe('redaction withdraws exactly one claim, and only where it destroyed the evidence', () => {
  for (const [name, text] of CAPTURES) {
    for (const [label, groups] of GROUP_SETS) {
      test(`${name} redacted with ${label} keeps every claim the file still supports`, () => {
        const original = afterImport(text);
        const redacted = afterImport(exportText(original, groups));

        const after = keys(redacted);
        const withdrawn = keys(original).filter((issue) => !after.includes(issue));
        const expected = groups.includes('toolArgs')
          ? keys(original).filter((issue) => issue.startsWith('tool-args-not-json@'))
          : [];

        expect(withdrawn).toEqual(expected);
      });
    }
  }

  test('state-patch-failed is untouched by redaction, in both directions', () => {
    // Measured by the State milestone and re-measured here, because an earlier hypothesis said
    // otherwise and the data disproved it. `redactPatch` preserves `op` and `path`, and those
    // are what decides whether a patch applies — so the same ops fail at the same positions for
    // the same reasons, redacted or not.
    for (const [, text] of CAPTURES) {
      const original = afterImport(text);
      const redacted = afterImport(exportText(original, [...ALL_REDACTION_GROUPS]));
      const failures = (s: PanelState): string[] =>
        s.issues
          .filter((issue) => issue.code === 'state-patch-failed')
          .map((issue) => `${String(issue.seq)}:${String(issue.opIndex)}:${issue.path ?? '-'}`);

      expect(failures(redacted)).toEqual(failures(original));
    }
  });

  test('the authored wide capture really does exercise the other rule families', () => {
    // A sweep over captures that raise nothing proves nothing. This pins that the fixtures above
    // put real issues in front of the comparison, so a rule that went silent would be caught.
    const codes = new Set(CAPTURES.flatMap(([, text]) => afterImport(text).issues.map((i) => i.code)));

    expect([...codes].sort()).toEqual([
      'concurrent-text-messages',
      'delta-before-snapshot',
      'deprecated-event',
      'empty-text-delta',
      'run-never-terminated',
      'state-patch-failed',
      'tool-args-not-json',
      'unbalanced-steps',
      'unclosed-message',
    ]);
  });
});
