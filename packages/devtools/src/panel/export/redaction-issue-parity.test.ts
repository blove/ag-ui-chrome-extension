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
 * under `toolArgs`. `state-patch-failed` is NOT affected in either direction: `redactPatchOp`
 * preserves paths and op names, so the same ops fail at the same positions for the same reasons.
 */
import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import malformedJsonl from '../../test/fixtures/malformed.agui.jsonl?raw';
import chunkedJsonl from '../../test/fixtures/chunked-run.agui.jsonl?raw';
import messagesEdgeJsonl from '../../test/fixtures/messages-edge.agui.jsonl?raw';
import stateEdgeJsonl from '../../test/fixtures/state-edge.agui.jsonl?raw';
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

const CAPTURES: Array<readonly [string, string]> = [
  ['happy-run', happyJsonl],
  ['malformed', malformedJsonl],
  ['chunked-run', chunkedJsonl],
  ['messages-edge', messagesEdgeJsonl],
  ['state-edge', stateEdgeJsonl],
  ['wide (authored here)', WIDE_JSONL],
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
    // otherwise and the data disproved it. `redactPatchOp` preserves `op` and `path`, and those
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
