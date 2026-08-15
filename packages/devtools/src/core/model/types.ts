/**
 * Shared model types for the AG-UI DevTools core.
 *
 * This module is type-only apart from `ORPHANED_RUN_ID`. It must never import
 * from `@ag-ui/core` — the runtime core is decoupled from the upstream package
 * (see `scripts/gen-event-table.ts`, which is the only place that touches it).
 */
import type { RedactionGroup } from '../jsonl/redact';

/** Synthetic run id used for events that arrive with no open run. */
export const ORPHANED_RUN_ID = '__orphaned__';

/**
 * A decoded protocol event. `type` stays a loose `string` on purpose: requirements §7
 * says an unknown event type is a warning to be displayed, never an error, so the model
 * must be able to hold a type this build has never heard of.
 *
 * Declare concrete event shapes as `type` aliases, not `interface`s — TypeScript derives
 * an implicit index signature for aliases but not for interfaces, so an interface will
 * not be assignable here.
 */
export type AguiEvent = { type: string; [key: string]: unknown };

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'event-before-run-started'
  | 'event-after-terminal'
  | 'run-never-terminated'
  | 'empty-text-delta'
  | 'unopened-message-id'
  | 'unopened-tool-call-id'
  | 'tool-result-before-end'
  | 'tool-args-not-json'
  | 'state-patch-failed'
  | 'chunk-missing-message-id'
  | 'chunk-missing-tool-call-id'
  | 'chunk-missing-tool-call-name'
  | 'shape-invalid'
  | 'unbalanced-steps'
  | 'unclosed-message'
  | 'unclosed-tool-call'
  | 'deprecated-event'
  | 'unknown-event-type'
  | 'concurrent-text-messages'
  | 'delta-before-snapshot'
  | 'keepalive-gap'
  | 'run-started-without-input';

/**
 * The severity requirements §7 assigns to each code. Issues are emitted from the chunk
 * expander and from five separate rule modules, so this table is the single source of
 * truth — every emitter reads it rather than restating a severity inline, which is what
 * keeps them from drifting apart.
 */
export const ISSUE_SEVERITY: Record<IssueCode, IssueSeverity> = {
  'event-before-run-started': 'error',
  'event-after-terminal': 'error',
  'run-never-terminated': 'error',
  'empty-text-delta': 'error',
  'unopened-message-id': 'error',
  'unopened-tool-call-id': 'error',
  'tool-result-before-end': 'error',
  'tool-args-not-json': 'error',
  'state-patch-failed': 'error',
  'chunk-missing-message-id': 'error',
  'chunk-missing-tool-call-id': 'error',
  'chunk-missing-tool-call-name': 'error',
  'shape-invalid': 'error',
  'unbalanced-steps': 'warning',
  'unclosed-message': 'warning',
  'unclosed-tool-call': 'warning',
  'deprecated-event': 'warning',
  'unknown-event-type': 'warning',
  'concurrent-text-messages': 'warning',
  'delta-before-snapshot': 'warning',
  'keepalive-gap': 'info',
  'run-started-without-input': 'info',
};

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  /** Human-readable annotation shown against the offending event in the panel. */
  message: string;
  /**
   * Sequence number this issue is anchored to.
   *
   * Usually the `seq` of the record being folded when the issue was raised. Four codes
   * have no owning record — `run-never-terminated`, `unclosed-message`,
   * `unclosed-tool-call`, and a leftover-open `unbalanced-steps`, all raised at
   * connection close — and for those it is the seq of the LAST record attributed to the
   * run, or `0` when the run recorded none. Derive that with `run.recordSeqs.at(-1) ?? 0`;
   * indexing with `[length - 1]` is `number | undefined` under `noUncheckedIndexedAccess`
   * and will not compile.
   *
   * `keepalive-gap` is NOT in that group: a keepalive is itself a `CaptureRecord`, so the
   * issue anchors to the seq of the keepalive that closed the gap.
   */
  seq: number;
  /**
   * Wall-clock offset for issues not anchored to a folded event: the close timestamp for
   * the four connection-close codes, and the arrival time of the late keepalive for
   * `keepalive-gap`.
   */
  tMs?: number;
  runId?: string;
  path?: string;
  opIndex?: number;
}

/**
 * Build an `Issue` with the severity requirements §7 assigns to its code.
 *
 * This is the only sanctioned way to construct an `Issue`. `severity` stays a widened
 * `IssueSeverity` on the interface — correlating it to `code` at the type level breaks the
 * generic factory every emitter needs — so the guarantee that a code always carries its
 * specified severity is upheld here rather than by the compiler.
 */
export function makeIssue(
  code: IssueCode,
  message: string,
  seq: number,
  extra: Partial<Pick<Issue, 'runId' | 'path' | 'opIndex' | 'tMs'>> = {},
): Issue {
  return { code, severity: ISSUE_SEVERITY[code], message, seq, ...extra };
}

interface CaptureRecordBase {
  readonly seq: number;
  readonly tMs: number;
  readonly connId: string;
  /**
   * The frame exactly as received, never mutated. `undefined` means the bytes were
   * already counted against a sibling record produced by chunk expansion, so metrics
   * must not double-count them.
   */
  readonly raw: unknown;
  issues: Issue[];
}

/**
 * One decoded frame off the wire.
 *
 * A discriminated union rather than a flag plus optional fields, so the invariants hold
 * structurally: a keepalive can never carry an event, and an event record can never carry
 * a comment. That is what stops metrics from counting a keepalive as an event —
 * requirements §5.4 requires keepalives be recorded but excluded from the event count.
 */
export type CaptureRecord =
  | (CaptureRecordBase & {
      readonly kind: 'event';
      /**
       * The decoded event, or `null` when the payload could not be parsed — such a record
       * is still surfaced and flagged rather than dropped.
       */
      readonly event: AguiEvent | null;
    })
  | (CaptureRecordBase & {
      readonly kind: 'keepalive';
      /** The SSE comment body. Empty string for a bare `:` heartbeat. */
      readonly comment: string;
    });

/**
 * How a reconstructed message was produced. Deliberately NOT named `role`: the protocol
 * carries its own `role` field on `TEXT_MESSAGE_START` and `TOOL_CALL_RESULT` with
 * different semantics, and conflating the two invites `kind: event.role`.
 */
export type MessageKind = 'text' | 'reasoning';

export interface ReconstructedMessage {
  messageId: string;
  kind: MessageKind;
  content: string;
  startedAtMs: number;
  endedAtMs?: number;
  closed: boolean;
  /**
   * Seqs of the records that contributed content to this message. Named for content,
   * not chunks: it collects every `*_MESSAGE_CONTENT` record, whether it arrived as a
   * discrete CONTENT event or was synthesized by expanding a `*_CHUNK`.
   */
  contentSeqs: number[];
}

export interface ToolCallRecord {
  toolCallId: string;
  toolCallName?: string;
  parentMessageId?: string;
  argsText: string;
  args?: unknown;
  argsParseError?: string;
  result?: unknown;
  startedAtMs: number;
  endedAtMs?: number;
  resultAtMs?: number;
  closed: boolean;
}

export interface ActivityRecord {
  /**
   * Composite key, built as `` `${messageId}#${activityType}` ``. AG-UI identifies an
   * activity by both fields while this record carries a single string, so every producer
   * and every lookup must compose it the same way.
   */
  activityId: string;
  value: unknown;
  updatedAtMs: number;
}

export interface StepRecord {
  stepName: string;
  startedAtMs: number;
  endedAtMs?: number;
  closed: boolean;
}

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; path: string; from: string }
  | { op: 'copy'; path: string; from: string }
  | { op: 'test'; path: string; value: unknown };

export type PatchFailure =
  | 'path-not-found'
  | 'parent-not-found'
  | 'invalid-path'
  | 'invalid-op'
  | 'test-failed'
  | 'index-out-of-bounds';

/**
 * `op` is deliberately `unknown` on the failure branch. A patch arrives off the wire, so
 * the operation that failed may be a bare string, an object with no `op` key, or an `add`
 * missing its `value` — none of which are representable as a `PatchOp`. Typing it as
 * `PatchOp` would force every consumer to cast and would let a renderer read
 * `result.op.path` and print `undefined`.
 */
export type PatchResult =
  | { ok: true; value: unknown }
  | { ok: false; opIndex: number; op: unknown; reason: PatchFailure };

/**
 * A real discriminated union rather than one `kind` field beside two independent
 * optionals. A delta frame always carries the patch that produced it — that is what makes
 * the State tab scrubbable — and a snapshot frame can never carry a patch failure.
 *
 * `value` is the document as it stands AFTER this frame. When `failure` is set the patch
 * did not apply, so `value` is unchanged from the previous frame: state does not advance
 * past a failed delta, but the frame is still retained so the scrubber can mark it.
 */
export type StateFrame =
  | {
      kind: 'snapshot';
      seq: number;
      tMs: number;
      value: unknown;
    }
  | {
      kind: 'delta';
      seq: number;
      tMs: number;
      value: unknown;
      patch: PatchOp[];
      failure?: { opIndex: number; reason: PatchFailure };
    };

export interface RunMetrics {
  durationMs?: number;
  ttftMs?: number;
  ttfrtMs?: number;
  gapP50Ms?: number;
  gapP95Ms?: number;
  gapMaxMs?: number;
  stalls: Array<{ startMs: number; endMs: number; messageId: string }>;
  toolLatencyMs: Record<string, number>;
  statePatchCount: number;
  statePatchBytes: number;
  eventCountByType: Record<string, number>;
  totalStreamBytes: number;
}

export type RunOutcome = 'running' | 'finished' | 'error' | 'aborted' | 'orphaned';

export interface Run {
  runId: string;
  threadId: string;
  parentRunId?: string;
  agentId?: string;
  connId: string;
  input?: unknown;
  startedAtMs: number;
  endedAtMs?: number;
  outcome: RunOutcome;
  messages: Map<string, ReconstructedMessage>;
  toolCalls: Map<string, ToolCallRecord>;
  activities: Map<string, ActivityRecord>;
  steps: StepRecord[];
  stateTimeline: StateFrame[];
  metrics: RunMetrics;
  issues: Issue[];
  recordSeqs: number[];
  /**
   * The requirements §11 groups whose payloads were replaced with placeholders before this
   * capture reached us — `JsonlHeader.redacted`, carried into the model.
   *
   * Empty for a live capture: the panel folds what the wire said, and redaction only ever
   * happens on the way OUT. It is non-empty exactly when the run was reconstructed from an
   * imported file whose header declares groups redacted.
   *
   * It lives on `Run` rather than on the panel because it is an input to VALIDATION, and
   * `core/` is deliberately Chrome-free so a CLI or a VS Code extension can reuse it (§13). A
   * rule that cannot see this field cannot tell "the agent emitted malformed tool arguments"
   * from "the redactor replaced them", and every consumer of `core/` would re-inherit that
   * confusion. Typed as `RedactionGroup[]` and not `string[]`: the set of groups is closed,
   * and a rule asking about a group name that does not exist should not compile.
   */
  redacted: readonly RedactionGroup[];
}
