import {
  ORPHANED_RUN_ID,
  makeIssue,
  type AguiEvent,
  type CaptureRecord,
  type Issue,
  type MessageKind,
  type PatchOp,
  type ReconstructedMessage,
  type Run,
  type RunMetrics,
  type ToolCallRecord,
} from '../model/types';
import type { RedactionGroup } from '../jsonl/redact';
import { applyPatch } from '../state/json-patch';
import { createStateTimeline, type StateTimeline } from '../state/timeline';
import { runRules, finalizeRules, type RunValidationState } from '../validator';
import { computeMetrics } from '../metrics/run-metrics';
import { createChunkExpanderState, expandChunk, type ChunkExpanderState } from './chunk-expander';
import { dialectOf, type Dialect } from './dialect';
import {
  createLangGraphExpander,
  type ExpandedEvent,
  type ExpandedIssue,
  type LangGraphExpander,
} from './langgraph/expander';

/**
 * The `event` arm of the `CaptureRecord` union — the only arm the fold decodes. Naming it
 * once keeps every helper below from re-narrowing: `addRecord` splits the union at the top
 * and everything downstream takes the narrowed type.
 */
type EventRecord = Extract<CaptureRecord, { kind: 'event' }>;

export interface RunBuilderOptions {
  expandChunks?: boolean; // default true
  stallThresholdMs?: number; // default 2000
  /**
   * The §11 groups the SOURCE of these records declares redacted — `JsonlHeader.redacted` off
   * line 1 of an imported file. Defaults to none, which is what a live capture always is:
   * redaction happens on the way out, never on the way in.
   *
   * Threaded onto every `Run` this builder produces, because the validator needs it: a rule
   * whose evidence a group destroyed must decline to make its claim rather than make it falsely.
   */
  redacted?: readonly RedactionGroup[];
}

export interface RunBuilder {
  addRequest(connId: string, method: string, url: string, input: unknown): void;
  addRecord(record: CaptureRecord): void;
  closeConnection(connId: string, tMs: number): void;
  runs(): Run[];
  getRun(runId: string): Run | undefined;
  allIssues(): Issue[];
}

interface RunEntry {
  run: Run;
  validation: RunValidationState;
  timeline: StateTimeline;
  /**
   * The records `computeMetrics` sees: one per event folded into this run, plus the
   * connection's keepalives once Task 13c folds them — keepalive bytes count towards
   * `totalStreamBytes` even though they are excluded from `eventCountByType`.
   */
  records: CaptureRecord[];
  metricsDirty: boolean;
}

/** The `keepalive` arm of the `CaptureRecord` union — no `event`, a `comment` instead. */
type KeepaliveRecord = Extract<CaptureRecord, { kind: 'keepalive' }>;

/**
 * requirements §7: a heartbeat gap longer than this is an Info-level hint that something —
 * usually a proxy — is buffering the stream. Strictly greater, so an exactly-15s gap is fine.
 */
const KEEPALIVE_GAP_MS = 15_000;

interface ConnEntry {
  connId: string;
  method?: string;
  url?: string;
  input?: unknown;
  openRunId?: string;
  runIds: string[];
  closedAtMs?: number;
  chunkState: ChunkExpanderState;
  /** Arrival time of the last keepalive on this connection; gaps are measured against it. */
  lastKeepaliveMs?: number;
  /** Decided once, at the connection's first event record (L4). */
  dialect?: Dialect;
  /** Present exactly when `dialect` is `'langgraph'`. */
  langGraph?: LangGraphExpander;
  /** LangGraph: each scope's run (L11, S1). `''` is the connection's top-level run. */
  langGraphRuns?: Map<string, string>;
  /** LangGraph: the seq of this connection's last frame — what its close-time issues anchor to. */
  lastLangGraphSeq?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * An activity is identified by the message it belongs to plus its `activityType`; the
 * normalized model carries a single string id, so the two are joined with '#'.
 */
function activityIdOf(event: AguiEvent): string | undefined {
  const messageId = str(event.messageId);
  const activityType = str(event.activityType);
  if (messageId === undefined && activityType === undefined) return undefined;
  return `${messageId ?? ''}#${activityType ?? ''}`;
}

/**
 * A patch off the wire is `unknown`. `applyPatch` takes `readonly unknown[]` and validates
 * each op itself, but `StateFrame`'s delta arm types `patch` as `PatchOp[]` so the frame can
 * be replayed, so the array is asserted here — once, at the boundary — rather than at every
 * call site. A malformed op survives the assertion and is reported as `invalid-op` by
 * `applyPatch`, which is where the failure belongs.
 */
function asPatchOps(value: unknown): PatchOp[] {
  return Array.isArray(value) ? (value as PatchOp[]) : [];
}

function emptyMetrics(): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
  };
}

function createRun(
  runId: string,
  threadId: string,
  connId: string,
  startedAtMs: number,
  redacted: readonly RedactionGroup[],
): Run {
  return {
    runId,
    threadId,
    connId,
    startedAtMs,
    redacted,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: emptyMetrics(),
    issues: [],
    recordSeqs: [],
  };
}

function createEntry(run: Run): RunEntry {
  return {
    run,
    validation: {
      run,
      openTextMessages: new Set(),
      openReasoningMessages: new Set(),
      openToolCalls: new Set(),
      endedToolCalls: new Set(),
      openSteps: [],
      terminated: false,
      sawSnapshot: false,
    },
    timeline: createStateTimeline(),
    records: [],
    metricsDirty: true,
  };
}

export function createRunBuilder(options: RunBuilderOptions = {}): RunBuilder {
  const expandChunks = options.expandChunks ?? true;
  const stallThresholdMs = options.stallThresholdMs ?? 2000;
  // Copied, not aliased: a caller mutating the array it passed must not retroactively change
  // what every run in this builder claims about its own provenance.
  const redacted: readonly RedactionGroup[] = [...(options.redacted ?? [])];
  const entries = new Map<string, RunEntry>();
  const order: string[] = [];
  const conns = new Map<string, ConnEntry>();

  function ensureConn(connId: string): ConnEntry {
    let conn = conns.get(connId);
    if (!conn) {
      conn = { connId, runIds: [], chunkState: createChunkExpanderState() };
      conns.set(connId, conn);
    }
    return conn;
  }

  function ensureOrphanEntry(connId: string, tMs: number): RunEntry {
    let entry = entries.get(ORPHANED_RUN_ID);
    if (!entry) {
      const run = createRun(ORPHANED_RUN_ID, '', connId, tMs, redacted);
      run.outcome = 'orphaned';
      entry = createEntry(run);
      entries.set(ORPHANED_RUN_ID, entry);
      order.push(ORPHANED_RUN_ID);
    }
    return entry;
  }

  /**
   * `inheritInput: false` is a LangGraph child run (L11): the connection's request body is the
   * top-level run's input, not the subgraph's, so a child's `input` stays absent.
   */
  function openRunFromStarted(
    conn: ConnEntry,
    event: AguiEvent,
    record: CaptureRecord,
    inheritInput = true,
  ): RunEntry {
    const runId = str(event.runId) ?? `__run_${record.seq}__`;
    const existing = entries.get(runId);
    if (existing) {
      conn.openRunId = runId;
      return existing;
    }
    const run = createRun(runId, str(event.threadId) ?? '', conn.connId, record.tMs, redacted);
    run.parentRunId = str(event.parentRunId);
    run.agentId = str(event.agentId);
    // The POST body stashed by addRequest is the fallback; an inlined RUN_STARTED.input wins.
    if (event.input !== undefined) run.input = event.input;
    else if (inheritInput) run.input = conn.input;
    const entry = createEntry(run);
    entries.set(runId, entry);
    order.push(runId);
    conn.openRunId = runId;
    conn.runIds.push(runId);
    return entry;
  }

  // A connection's current run stays current after its terminal event so that the validator
  // can see 'event-after-terminal' instead of the event silently becoming an orphan.
  function resolveRun(conn: ConnEntry, event: AguiEvent, record: CaptureRecord): RunEntry {
    if (event.type === 'RUN_STARTED') return openRunFromStarted(conn, event, record);
    if (conn.openRunId !== undefined) {
      const entry = entries.get(conn.openRunId);
      if (entry) return entry;
    }
    return ensureOrphanEntry(conn.connId, record.tMs);
  }

  function attachIssues(entry: RunEntry, issues: Issue[]): void {
    for (const issue of issues) {
      entry.run.issues.push(issue.runId === undefined ? { ...issue, runId: entry.run.runId } : issue);
    }
  }

  /**
   * `member: false` folds an event a record caused on a run the record does not belong to — a
   * LangGraph frame closing another run's message, or opening an ancestor run (S3). It keeps the
   * record's seq and time, but the seq does not join the run's `recordSeqs`, and it carries no
   * bytes, so neither the run's event count nor its byte count sees the frame.
   */
  function noteRecord(
    entry: RunEntry,
    record: EventRecord,
    event: AguiEvent | null,
    countBytes: boolean,
    member = true,
  ): void {
    const seqs = entry.run.recordSeqs;
    if (member && seqs[seqs.length - 1] !== record.seq) seqs.push(record.seq);
    entry.records.push(
      countBytes && member
        ? { ...record, event, issues: [] }
        : { ...record, raw: undefined, event, issues: [] },
    );
    entry.metricsDirty = true;
  }

  /**
   * `kind` is the event family that opened the message ('text' for the `TEXT_MESSAGE_*`
   * triad, 'reasoning' for `REASONING_MESSAGE_*`). It is deliberately not read from
   * `event.role`: the protocol's `role` is a different field with different semantics.
   */
  function ensureMessage(
    entry: RunEntry,
    messageId: string,
    kind: MessageKind,
    tMs: number,
  ): ReconstructedMessage {
    let message = entry.run.messages.get(messageId);
    if (!message) {
      // Content for a never-opened messageId is still reconstructed so the panel shows it;
      // the validator has already flagged the missing START on this same event.
      message = { messageId, kind, content: '', startedAtMs: tMs, closed: false, contentSeqs: [] };
      entry.run.messages.set(messageId, message);
      if (kind === 'text') entry.validation.openTextMessages.add(messageId);
      else entry.validation.openReasoningMessages.add(messageId);
    }
    return message;
  }

  function ensureToolCall(entry: RunEntry, toolCallId: string, tMs: number): ToolCallRecord {
    let call = entry.run.toolCalls.get(toolCallId);
    if (!call) {
      // As with messages, a never-opened toolCallId is still materialized so its args are
      // visible; the validator has already flagged the missing TOOL_CALL_START.
      call = { toolCallId, argsText: '', startedAtMs: tMs, closed: false };
      entry.run.toolCalls.set(toolCallId, call);
      entry.validation.openToolCalls.add(toolCallId);
    }
    return call;
  }

  function applyTransition(entry: RunEntry, event: AguiEvent, record: CaptureRecord): void {
    const run = entry.run;
    const validation = entry.validation;
    switch (event.type) {
      case 'RUN_STARTED':
        break;
      case 'RUN_FINISHED':
      case 'RUN_ERROR': {
        if (run.runId === ORPHANED_RUN_ID) break;
        run.outcome = event.type === 'RUN_FINISHED' ? 'finished' : 'error';
        run.endedAtMs = record.tMs;
        validation.terminated = true;
        break;
      }
      case 'TEXT_MESSAGE_START': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) ensureMessage(entry, messageId, 'text', record.tMs);
        break;
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'text', record.tMs);
          message.content += str(event.delta) ?? '';
          message.contentSeqs.push(record.seq);
        }
        break;
      }
      case 'TEXT_MESSAGE_END': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'text', record.tMs);
          message.closed = true;
          message.endedAtMs = record.tMs;
          validation.openTextMessages.delete(messageId);
        }
        break;
      }
      case 'REASONING_MESSAGE_START': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) ensureMessage(entry, messageId, 'reasoning', record.tMs);
        break;
      }
      case 'REASONING_MESSAGE_CONTENT': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'reasoning', record.tMs);
          message.content += str(event.delta) ?? '';
          message.contentSeqs.push(record.seq);
        }
        break;
      }
      case 'REASONING_MESSAGE_END': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'reasoning', record.tMs);
          message.closed = true;
          message.endedAtMs = record.tMs;
          validation.openReasoningMessages.delete(messageId);
        }
        break;
      }
      case 'STEP_STARTED': {
        const stepName = str(event.stepName);
        if (stepName !== undefined) {
          run.steps.push({ stepName, startedAtMs: record.tMs, closed: false });
          validation.openSteps.push(stepName);
        }
        break;
      }
      case 'STEP_FINISHED': {
        const stepName = str(event.stepName);
        if (stepName !== undefined) {
          for (let i = run.steps.length - 1; i >= 0; i -= 1) {
            const step = run.steps[i]!;
            if (step.stepName === stepName && !step.closed) {
              step.closed = true;
              step.endedAtMs = record.tMs;
              break;
            }
          }
          const openIndex = validation.openSteps.lastIndexOf(stepName);
          if (openIndex >= 0) validation.openSteps.splice(openIndex, 1);
        }
        break;
      }
      case 'TOOL_CALL_START': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.toolCallName = str(event.toolCallName) ?? call.toolCallName;
          call.parentMessageId = str(event.parentMessageId) ?? call.parentMessageId;
        }
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.argsText += str(event.delta) ?? '';
        }
        break;
      }
      case 'TOOL_CALL_END': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.closed = true;
          call.endedAtMs = record.tMs;
          if (call.argsText.trim() === '') {
            // A tool call that streamed no args at all is not a parse failure.
            call.args = undefined;
            call.argsParseError = undefined;
          } else {
            try {
              call.args = JSON.parse(call.argsText) as unknown;
              call.argsParseError = undefined;
            } catch (error) {
              call.args = undefined;
              call.argsParseError = error instanceof Error ? error.message : String(error);
            }
          }
          validation.openToolCalls.delete(toolCallId);
          validation.endedToolCalls.add(toolCallId);
        }
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.result = event.content;
          call.resultAtMs = record.tMs;
        }
        break;
      }
      case 'STATE_SNAPSHOT': {
        entry.timeline.applySnapshot(record.seq, record.tMs, event.snapshot);
        run.stateTimeline = entry.timeline.frames();
        validation.sawSnapshot = true;
        break;
      }
      case 'STATE_DELTA': {
        entry.timeline.applyDelta(record.seq, record.tMs, asPatchOps(event.delta));
        run.stateTimeline = entry.timeline.frames();
        break;
      }
      case 'ACTIVITY_SNAPSHOT': {
        const activityId = activityIdOf(event);
        if (activityId !== undefined) {
          run.activities.set(activityId, {
            activityId,
            value: event.content,
            updatedAtMs: record.tMs,
          });
        }
        break;
      }
      case 'ACTIVITY_DELTA': {
        const activityId = activityIdOf(event);
        if (activityId !== undefined) {
          const previous = run.activities.get(activityId);
          const result = applyPatch(previous?.value, asPatchOps(event.patch));
          run.activities.set(activityId, {
            activityId,
            // A failed activity patch keeps the last good value, mirroring the state timeline.
            value: result.ok ? result.value : previous?.value,
            updatedAtMs: record.tMs,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Fold one keepalive frame.
   *
   * A keepalive is connection-scoped but every `Issue` is run-scoped, so the gap attaches to
   * the connection's current run, or to the orphaned run when the connection has none. It is
   * not a protocol event: it resolves nothing, and it never enters `run.recordSeqs`.
   */
  function foldKeepalive(conn: ConnEntry, record: KeepaliveRecord): void {
    const open = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
    const entry = open ?? ensureOrphanEntry(conn.connId, record.tMs);

    // The bytes are real bytes on the wire, so the record still goes to `computeMetrics`,
    // which counts them in `totalStreamBytes` while `kind` keeps them out of
    // `eventCountByType`. `noteRecord` is deliberately not used: it pushes `recordSeqs`.
    entry.records.push(record);
    entry.metricsDirty = true;

    const previousMs = conn.lastKeepaliveMs;
    conn.lastKeepaliveMs = record.tMs;
    if (previousMs === undefined) return;

    const gapMs = record.tMs - previousMs;
    // Strictly greater: requirements §7 flags a gap LONGER than 15 s, so exactly 15 000 ms
    // is clean. Both sides of that boundary are pinned by tests — 15 000 and 15 001.
    if (gapMs <= KEEPALIVE_GAP_MS) return;

    // Anchored to the keepalive that CLOSED the gap — it is a real record with a real seq,
    // which is why `keepalive-gap` is not one of the codes `finalizeRules` derives a seq for.
    attachIssues(entry, [
      makeIssue(
        'keepalive-gap',
        `Keepalive gap of ${gapMs}ms on connection ${conn.connId} exceeds ${KEEPALIVE_GAP_MS}ms`,
        record.seq,
        { tMs: record.tMs },
      ),
    ]);
  }

  /**
   * The `*_END` events a connection's chunk state still owes, in triad order, clearing that
   * state as it goes.
   *
   * `expandChunk` synthesizes a trailing END only when a NEW id opens, and it is per-event:
   * it has no end-of-stream hook, so the LAST message and tool call of a chunk-only stream —
   * the CopilotKit default — would otherwise never close. That cost every healthy chunked run
   * a spurious `unclosed-message` and `unclosed-tool-call`, and left `ToolCallRecord.args`
   * `undefined` even for perfectly valid JSON, because `args` is parsed only in the builder's
   * `TOOL_CALL_END` case. Closing the stream is the run builder's job, so it lives here.
   *
   * When `expandChunks` is false nothing ever writes `conn.chunkState`, so this yields nothing.
   */
  function takeChunkFlushEvents(conn: ConnEntry): AguiEvent[] {
    const state = conn.chunkState;
    const events: AguiEvent[] = [];
    if (state.openTextMessageId !== undefined) {
      events.push({ type: 'TEXT_MESSAGE_END', messageId: state.openTextMessageId });
    }
    if (state.openReasoningMessageId !== undefined) {
      events.push({ type: 'REASONING_MESSAGE_END', messageId: state.openReasoningMessageId });
    }
    if (state.openToolCallId !== undefined) {
      events.push({ type: 'TOOL_CALL_END', toolCallId: state.openToolCallId });
    }
    conn.chunkState = createChunkExpanderState();
    return events;
  }

  /**
   * Fold one event onto one run: validate (pure), then mutate, then record, then attach.
   *
   * Every event takes this path — off the wire, out of chunk expansion, or out of the
   * end-of-stream flush — so message closing, `endedAtMs` and tool-args parsing happen in
   * exactly one place and a synthesized END is validated like any other.
   */
  function foldEvent(
    entry: RunEntry,
    event: AguiEvent,
    record: EventRecord,
    countBytes: boolean,
    validate = true,
    member = true,
  ): void {
    // L12: a synthetic event from the LangGraph expander is correct by construction. An AG-UI
    // issue raised against one would be our translation bug reported as the user's.
    const issues = validate ? runRules(event, record, entry.validation) : [];
    applyTransition(entry, event, record);
    noteRecord(entry, record, event, countBytes, member);
    attachIssues(entry, issues);
  }

  /**
   * Flush the connection's chunk state onto its CURRENT run — the one that owns whatever the
   * state still holds open — for the two exits that are not a terminal event: the connection
   * closing, and a new `RUN_STARTED` taking the connection over.
   *
   * No frame carries these: the stream stopped, or moved on. They anchor to the run's last
   * real seq — the same anchor `finalizeRules` uses for the run-end codes — so anything they
   * raise still points at a record the user can select, and `raw: undefined` keeps them out
   * of `totalStreamBytes` because nothing was ever on the wire. `tMs` is the moment the run
   * demonstrably ended: the close, or the incoming `RUN_STARTED`.
   *
   * A no-op when the connection has no current run or the chunk state is empty.
   */
  function flushChunkStateOntoCurrentRun(conn: ConnEntry, tMs: number): void {
    if (conn.openRunId === undefined) return;
    const entry = entries.get(conn.openRunId);
    if (entry === undefined) return;
    const seq = entry.run.recordSeqs.at(-1) ?? 0;
    for (const event of takeChunkFlushEvents(conn)) {
      const record: EventRecord = {
        kind: 'event',
        seq,
        tMs,
        connId: conn.connId,
        raw: undefined,
        event,
        issues: [],
      };
      foldEvent(entry, event, record, false);
    }
  }

  function dialectFor(conn: ConnEntry, record: EventRecord): Dialect {
    conn.dialect ??= dialectOf(
      conn.method !== undefined && conn.url !== undefined
        ? { method: conn.method, url: conn.url }
        : undefined,
      { ...(record.sseEvent !== undefined ? { sseEvent: record.sseEvent } : {}), payload: record.raw },
    );
    return conn.dialect;
  }

  /**
   * Open the run a synthetic RUN_STARTED names. A child (non-empty runKey) must not take over the
   * connection: the next top-level frame — and the next keepalive, which `foldKeepalive` routes by
   * `openRunId` — still belongs to the top-level run (S3). A run that already exists is a join
   * stream continuing it (S8): it is mapped here, so the join's frames and finish fold onto it, but
   * not added to `conn.runIds` — `openRunFromStarted` registers a run only on the connection that
   * created it, and only that connection's close may abort it.
   */
  function openLangGraphRun(conn: ConnEntry, runKey: string, event: AguiEvent, record: EventRecord): RunEntry {
    const previous = conn.openRunId;
    const entry = openRunFromStarted(conn, event, record, runKey === '');
    if (runKey !== '') conn.openRunId = previous;
    (conn.langGraphRuns ??= new Map()).set(runKey, entry.run.runId);
    return entry;
  }

  function langGraphEntry(conn: ConnEntry, runKey: string): RunEntry | undefined {
    const runId = conn.langGraphRuns?.get(runKey);
    return runId === undefined ? undefined : entries.get(runId);
  }

  /**
   * Fold a frame's synthetic events onto the runs their runKeys name, stamped with the frame (L10).
   * The frame belongs to its own run only (S3): its seq joins that run's `recordSeqs` and its bytes
   * and wire name are counted once there (L13). An event it causes on another run — closing a
   * child a top-level error cut off, opening an ancestor — is folded there as a non-member.
   * Returns whether the frame was counted.
   */
  function foldSynthetic(
    conn: ConnEntry,
    events: readonly ExpandedEvent[],
    record: EventRecord,
    frameKey: string,
  ): boolean {
    let counted = false;
    for (const { runKey, event } of events) {
      const entry =
        event.type === 'RUN_STARTED' ? openLangGraphRun(conn, runKey, event, record) : langGraphEntry(conn, runKey);
      if (entry === undefined) continue;
      entry.run.dialect = 'langgraph';
      const member = runKey === frameKey;
      const countBytes = member && !counted;
      if (countBytes) counted = true;
      foldEvent(entry, event, record, countBytes, false, member);
    }
    return counted;
  }

  /**
   * A LangGraph frame. Read `raw`, not `event`: `event` is null for any non-object payload, and
   * the `messages` tuple is a JSON array.
   */
  function foldLangGraph(conn: ConnEntry, record: EventRecord): void {
    conn.langGraph ??= createLangGraphExpander(conn.connId, {
      ...(conn.method !== undefined ? { method: conn.method } : {}),
      ...(conn.url !== undefined ? { url: conn.url } : {}),
      input: conn.input,
    });
    const expansion = conn.langGraph.push({
      seq: record.seq,
      ...(record.sseEvent !== undefined ? { sseEvent: record.sseEvent } : {}),
      payload: record.raw,
    });
    conn.lastLangGraphSeq = record.seq;
    const counted = foldSynthetic(conn, expansion.events, record, expansion.runKey);
    const target =
      langGraphEntry(conn, expansion.runKey) ?? langGraphEntry(conn, '') ?? ensureOrphanEntry(conn.connId, record.tMs);
    // A frame that folded nothing onto its own run — a `debug` frame, `messages/metadata`, a
    // frame after an error — is still that run's record, raw.
    if (!counted) noteRecord(target, record, null, true);
    attachLangGraphIssues(conn, expansion.issues, target);
    attachIssues(target, record.issues);
  }

  /** Each issue on the run it is about (S3); `fallback` for a run key this connection never opened. */
  function attachLangGraphIssues(conn: ConnEntry, issues: readonly ExpandedIssue[], fallback: RunEntry): void {
    for (const { runKey, issue } of issues) attachIssues(langGraphEntry(conn, runKey) ?? fallback, [issue]);
  }

  /**
   * The expander's end of stream: close what is open and settle each run's outcome (L6, L9, S6).
   * Nothing was on the wire for these events: they fold as non-members (S3), so they add no seq,
   * byte or wire name, and each is stamped with its own run's last seq, like the chunk flush — or,
   * for a run that holds no record (an ancestor a nested frame opened), this connection's last frame.
   */
  function finishLangGraph(conn: ConnEntry, tMs: number): void {
    const top = conn.langGraph === undefined ? undefined : langGraphEntry(conn, '');
    if (conn.langGraph === undefined || top === undefined) return;
    // Anchored to THIS connection's last frame, not the run's: with a join stream (S8) the run's
    // last frame may be another connection's, and "this stream closed without its final values"
    // is a claim about this one.
    const finish = conn.langGraph.finish(conn.lastLangGraphSeq ?? top.run.recordSeqs.at(-1) ?? 0);
    // A join that closed before seeing the run end says nothing about a run another connection
    // opened (S8): that connection may still be streaming it, mid-message. Only its creator's
    // close, or a join that saw the end, settles it.
    if (!conn.runIds.includes(top.run.runId) && !finish.sawRunEnd) return;
    for (const { runKey, event } of finish.events) {
      const entry = langGraphEntry(conn, runKey);
      if (entry === undefined) continue;
      const seq = entry.run.recordSeqs.at(-1) ?? conn.lastLangGraphSeq ?? 0;
      const record: EventRecord = { kind: 'event', seq, tMs, connId: conn.connId, raw: undefined, event, issues: [] };
      foldEvent(entry, event, record, false, false, false);
    }
    attachLangGraphIssues(conn, finish.issues.map(({ runKey, issue }) => ({ runKey, issue: { ...issue, tMs } })), top);
    for (const runKey of finish.interrupted) {
      const entry = langGraphEntry(conn, runKey);
      if (entry !== undefined) entry.run.outcome = 'interrupted';
    }
  }

  function addRecord(record: CaptureRecord): void {
    const conn = ensureConn(record.connId);

    // 1. A keepalive carries no event to fold — only timing and bytes. Splitting the union
    //    here is also what makes every `record.event` access below legal.
    if (record.kind === 'keepalive') {
      foldKeepalive(conn, record);
      return;
    }

    // 1b. A LangGraph connection folds through its expander (L4). Decided before the null check:
    //     a LangGraph `messages` tuple is an array, so its `event` is null by construction.
    if (dialectFor(conn, record) === 'langgraph') {
      foldLangGraph(conn, record);
      return;
    }

    // 2. An unparseable frame carries no event to fold; it still belongs to the run's
    //    record list and its capture-time issues still surface on the run.
    if (record.event === null) {
      const open = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
      const entry = open ?? ensureOrphanEntry(conn.connId, record.tMs);
      noteRecord(entry, record, null, true);
      attachIssues(entry, record.issues);
      return;
    }

    // 3. Chunk expansion, when enabled, turns one *_CHUNK into its triad members.
    let events: AguiEvent[];
    let expansionIssues: Issue[];
    if (expandChunks) {
      const expansion = expandChunk(record.event, conn.chunkState, record.seq);
      events = expansion.events;
      expansionIssues = expansion.issues;
    } else {
      events = [record.event];
      expansionIssues = [];
    }

    // 4. Resolve, validate (pure), then mutate — the builder owns every state change.
    let first: RunEntry | undefined;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      // A RUN_STARTED hands the connection to a new run, and `resolveRun` is what performs
      // that switch — so the flush goes BEFORE it. The chunk state is connection-scoped, so
      // whatever it still holds open belongs to the OUTGOING run; flushing after the switch
      // would only move the mis-attribution, materializing a phantom message or tool call on
      // the incoming run. Not theoretical: requirements §4.2's
      // `POST {base}/agent/:agentId/connect` resumes a stream on a connection that may
      // already have carried a run.
      if (event.type === 'RUN_STARTED') flushChunkStateOntoCurrentRun(conn, record.tMs);
      const entry = resolveRun(conn, event, record);
      if (first === undefined) first = entry;
      // The terminal event is the last moment at which the chunk state's outstanding ENDs
      // are still legal, so they are folded here — strictly BEFORE this event is validated
      // and applied. `applyTransition` sets `validation.terminated` on the terminal event,
      // and after that every event, synthesized ones included, trips `event-after-terminal`.
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
        for (const flushed of takeChunkFlushEvents(conn)) foldEvent(entry, flushed, record, false);
      }
      // Only the first expanded event carries the raw frame, so its bytes are counted once.
      foldEvent(entry, event, record, i === 0);
    }

    // 5. Record bookkeeping and issue attachment for the record as a whole.
    const openEntry = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
    const target = first ?? openEntry ?? ensureOrphanEntry(conn.connId, record.tMs);
    if (events.length === 0) noteRecord(target, record, null, true);
    attachIssues(target, expansionIssues);
    attachIssues(target, record.issues);
  }

  function syncMetrics(entry: RunEntry): void {
    if (!entry.metricsDirty) return;
    entry.run.metrics = computeMetrics(entry.run, entry.records, stallThresholdMs);
    entry.metricsDirty = false;
  }

  return {
    addRequest(connId: string, method: string, url: string, input: unknown): void {
      const conn = ensureConn(connId);
      conn.method = method;
      conn.url = url;
      conn.input = input;
    },

    addRecord,

    closeConnection(connId: string, tMs: number): void {
      const conn = conns.get(connId);
      // Idempotent by `closedAtMs`, not by luck: `finalizeRules` is a pure function of a
      // validation state that closing does not reset, so a second pass over an UNTERMINATED
      // run re-raises `run-never-terminated` and every `unclosed-*`. A finished run hides
      // the bug — `finalizeRules` emits nothing for it however often it runs.
      if (conn === undefined || conn.closedAtMs !== undefined) return;
      conn.closedAtMs = tMs;
      // A run that never terminated got no flush from `addRecord`, so it happens here —
      // and BEFORE `finalizeRules`, which reads the very sets the synthesized ENDs clear.
      flushChunkStateOntoCurrentRun(conn, tMs);
      finishLangGraph(conn, tMs);
      for (const runId of conn.runIds) {
        const entry = entries.get(runId);
        if (entry === undefined) continue;
        // `finalizeRules` is the SOLE owner of every run-end issue, including
        // `run-never-terminated`. It derives `seq` from `run.recordSeqs` itself.
        // The builder must not emit that issue a second time here — doing so
        // double-counts it and breaks the Task 16 "exactly three issues" test.
        // L12: the run-end rules are AG-UI rules. A LangGraph run's end is settled by the
        // expander's `finish`, which closes what is open and raises its own issues.
        if (conn.dialect !== 'langgraph') attachIssues(entry, finalizeRules(entry.validation, tMs));
        if (entry.run.outcome === 'running') {
          entry.run.outcome = 'aborted';
          entry.run.endedAtMs = tMs;
          entry.metricsDirty = true;
        }
        syncMetrics(entry);
      }
    },

    runs(): Run[] {
      const result: Run[] = [];
      for (const runId of order) {
        const entry = entries.get(runId);
        if (entry === undefined) continue;
        if (runId === ORPHANED_RUN_ID && entry.run.recordSeqs.length === 0) continue;
        syncMetrics(entry);
        result.push(entry.run);
      }
      return result;
    },

    getRun(runId: string): Run | undefined {
      const entry = entries.get(runId);
      if (entry === undefined) return undefined;
      syncMetrics(entry);
      return entry.run;
    },

    allIssues(): Issue[] {
      const result: Issue[] = [];
      for (const runId of order) {
        const entry = entries.get(runId);
        if (entry) result.push(...entry.run.issues);
      }
      return result.sort((a, b) => a.seq - b.seq);
    },
  };
}
