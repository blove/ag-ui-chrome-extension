/**
 * Shared model types for the AG-UI DevTools core.
 *
 * This module is type-only apart from `ORPHANED_RUN_ID`. It must never import
 * from `@ag-ui/core` — the runtime core is decoupled from the upstream package
 * (see `scripts/gen-event-table.ts`, which is the only place that touches it).
 */

/** Synthetic run id used for events that arrive with no open run. */
export const ORPHANED_RUN_ID = '__orphaned__';

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
  /**
   * Sequence number this issue is anchored to.
   *
   * For issues raised while folding a specific event, this is that record's `seq`.
   * Five codes have no owning event — `run-never-terminated`, `unclosed-message`,
   * `unclosed-tool-call`, a leftover-open `unbalanced-steps`, and `keepalive-gap` — and
   * for those it is the seq of the LAST record attributed to the run, or `0` when the
   * run recorded none. Derive it with `run.recordSeqs.at(-1) ?? 0`; indexing with
   * `[length - 1]` is `number | undefined` under `noUncheckedIndexedAccess` and will
   * not compile.
   */
  seq: number;
  /** Wall-clock offset, set only for issues raised at connection close. */
  tMs?: number;
  runId?: string;
  path?: string;
  opIndex?: number;
}

export interface CaptureRecord {
  /**
   * Discriminates a decoded protocol event from an SSE keepalive comment. Keepalives
   * carry no event and exist only so the run builder can measure heartbeat gaps and
   * raise `keepalive-gap` (requirements §7, Info). Without this the code would be
   * unreachable, because the SSE parser's keepalive frames would have nowhere to go.
   */
  readonly kind: 'event' | 'keepalive';
  readonly seq: number;
  readonly tMs: number;
  readonly connId: string;
  /**
   * The frame exactly as received, never mutated. `undefined` means the bytes were
   * already counted against a sibling record produced by chunk expansion, so metrics
   * must not double-count them.
   */
  readonly raw: unknown;
  /**
   * The decoded event, or `null` when the payload could not be parsed — such a record
   * is still surfaced and flagged rather than dropped. Always `null` when
   * `kind === 'keepalive'`.
   */
  readonly event: AguiEvent | null;
  /** The SSE comment body, present only when `kind === 'keepalive'`. */
  readonly comment?: string;
  issues: Issue[];
}

export type MessageRole = 'assistant' | 'reasoning';

export interface ReconstructedMessage {
  messageId: string;
  role: MessageRole;
  content: string;
  startedAtMs: number;
  endedAtMs?: number;
  closed: boolean;
  chunkSeqs: number[];
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
}
