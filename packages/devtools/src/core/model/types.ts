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

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  seq: number;
  runId?: string;
  path?: string;
  opIndex?: number;
}

export interface CaptureRecord {
  seq: number;
  tMs: number;
  connId: string;
  raw: unknown;
  event: AguiEvent | null;
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

export type PatchResult =
  | { ok: true; value: unknown }
  | { ok: false; opIndex: number; op: PatchOp; reason: PatchFailure };

export interface StateFrame {
  seq: number;
  tMs: number;
  kind: 'snapshot' | 'delta';
  value: unknown;
  patch?: PatchOp[];
  failure?: { opIndex: number; reason: PatchFailure };
}

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
