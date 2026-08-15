/**
 * The Runs tab's view of the run model (design decision R1).
 *
 * Pure and DOM-free, so the thing the table actually claims — what each column says, and what it
 * says when there is nothing to say — is testable without rendering anything.
 *
 * Nothing here measures. `core/metrics/run-metrics` computed every number and the validator
 * produced every issue; this module only decides how an absent one is reported. That decision is
 * the whole of the module: `agentId`, `durationMs` and `ttftMs` are all `undefined` on real runs,
 * each for a different reason, and a table that printed `0` — or the same `—` for all three —
 * would be inventing a measurement nobody took.
 */
import type { IssueSeverity, Run, RunOutcome } from '../../../core/model/types';
import { formatDuration } from '../../common/format';

/** §9.2's columns, in the order the requirement lists them. */
export const RUN_COLUMNS = [
  { key: 'thread', label: 'Thread' },
  { key: 'agent', label: 'Agent' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'duration', label: 'Duration' },
  { key: 'ttft', label: 'TTFT' },
  { key: 'events', label: 'Events' },
  { key: 'issues', label: 'Issues' },
] as const satisfies readonly { key: string; label: string }[];

export type RunColumnKey = (typeof RUN_COLUMNS)[number]['key'];

/**
 * One cell.
 *
 * `known: false` is the load-bearing field. It does NOT mean "empty" — the text is still a
 * sentence a reader can act on ("still running", "no text") — it means the panel is reporting the
 * absence of a measurement rather than a measurement. The renderer draws the two differently, and
 * `note` carries the longer explanation for the ones where the short form is not enough.
 */
export interface Cell {
  text: string;
  known: boolean;
  note?: string;
}

export interface RunRow {
  runId: string;
  outcome: RunOutcome;
  cells: Record<RunColumnKey, Cell>;
  /** `recordSeqs.length` — keepalives are excluded by the run builder (§5.4). */
  eventCount: number;
  issueCount: number;
  /** Undefined exactly when the run recorded no issues. Drives the row's tone. */
  worstSeverity?: IssueSeverity;
  /** True when this run was reconstructed from a file whose header declares groups redacted. */
  redacted: boolean;
  /** The frame R2's click-through lands on. Undefined when the run recorded no records. */
  firstSeq?: number;
  /** Everything above, in one sentence: the row is one control, so this is what is announced. */
  label: string;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 3, warning: 2, info: 1 };

function worstSeverity(run: Run): IssueSeverity | undefined {
  let worst: IssueSeverity | undefined;
  for (const issue of run.issues) {
    if (worst === undefined || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[worst]) {
      worst = issue.severity;
    }
  }
  return worst;
}

function known(text: string): Cell {
  return { text, known: true };
}

function absent(text: string, note?: string): Cell {
  return note === undefined ? { text, known: false } : { text, known: false, note };
}

/**
 * The thread the run belongs to.
 *
 * `''` is the orphan bucket: it is synthesized for events that arrived with no open run, so there
 * was no `RUN_STARTED` to carry a thread id. Rendering that as an empty cell would look like a
 * layout bug rather than the protocol violation it is.
 */
function threadCell(run: Run): Cell {
  return run.threadId === ''
    ? absent(
        'no thread id',
        'These events arrived with no open run, so no RUN_STARTED named a thread for them.',
      )
    : known(run.threadId);
}

function agentCell(run: Run): Cell {
  return run.agentId === undefined
    ? absent('not reported', 'This run’s RUN_STARTED carried no agentId.')
    : known(run.agentId);
}

/**
 * How long the run took — or why that is not a question this capture can answer.
 *
 * `durationMs` is `endedAtMs - startedAtMs`, so it is undefined exactly while the run has no end.
 * Three different situations produce that, and they are three different findings.
 */
function durationCell(run: Run): Cell {
  const durationMs = run.metrics.durationMs;
  if (durationMs !== undefined) return known(formatDuration(durationMs));
  if (run.outcome === 'running') {
    return absent(
      'still running',
      'This run has not ended, so its duration is not a number yet — not zero.',
    );
  }
  if (run.outcome === 'orphaned') {
    return absent(
      'no run start',
      'These events arrived with no RUN_STARTED, so there is no start to measure a duration from.',
    );
  }
  return absent('not reported', 'This run recorded no end, so no duration could be computed.');
}

/**
 * Time to first token: `RUN_STARTED` → the first `TEXT_MESSAGE_CONTENT` (§8).
 *
 * Undefined means no text content ever arrived on this run. A run that ended without emitting a
 * token and a run that has not emitted one YET are different states, and only the second may
 * still change.
 */
function ttftCell(run: Run): Cell {
  const ttftMs = run.metrics.ttftMs;
  if (ttftMs !== undefined) return known(formatDuration(ttftMs));
  if (run.outcome === 'running') {
    return absent(
      'no text yet',
      'No TEXT_MESSAGE_CONTENT has arrived on this run yet. It is still going, so one still may.',
    );
  }
  return absent(
    'no text',
    'This run emitted no TEXT_MESSAGE_CONTENT at all, so there is no first token to time.',
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The row's accessible name.
 *
 * Built from the same `Cell`s the row draws, so an absence is announced in exactly the words it is
 * shown in. A name assembled from the underlying model instead would be free to say "0ms" where
 * the cell says "still running".
 */
function rowLabel(run: Run, cells: Record<RunColumnKey, Cell>, redacted: boolean): string {
  const parts = [
    `Run ${run.runId}`,
    `thread ${cells.thread.text}`,
    `agent ${cells.agent.text}`,
    cells.outcome.text,
    `duration ${cells.duration.text}`,
    `TTFT ${cells.ttft.text}`,
    plural(Number(cells.events.text), 'event'),
    plural(Number(cells.issues.text), 'issue'),
  ];
  if (redacted) parts.push('redacted capture');
  return parts.join(', ');
}

/**
 * One row per run, in the order the run builder produced them — which is the order the runs first
 * appeared on the wire. Deliberately not sorted: a table that reordered itself as a live capture
 * arrived would move the row under the reader's cursor.
 */
export function runRows(runs: readonly Run[]): RunRow[] {
  return runs.map((run): RunRow => {
    const eventCount = run.recordSeqs.length;
    const issueCount = run.issues.length;
    const cells: Record<RunColumnKey, Cell> = {
      thread: threadCell(run),
      agent: agentCell(run),
      outcome: known(run.outcome),
      duration: durationCell(run),
      ttft: ttftCell(run),
      // Zero is a measurement here, not an absence: the run really did record no events, and the
      // validator really did find nothing. Both stay `known`.
      events: known(String(eventCount)),
      issues: known(String(issueCount)),
    };
    const redacted = run.redacted.length > 0;

    const row: RunRow = {
      runId: run.runId,
      outcome: run.outcome,
      cells,
      eventCount,
      issueCount,
      redacted,
      label: rowLabel(run, cells, redacted),
    };
    const severity = worstSeverity(run);
    if (severity !== undefined) row.worstSeverity = severity;
    // `.at(0)` rather than `[0]`: under `noUncheckedIndexedAccess` the index is possibly
    // undefined, and that is the real case — a run with no attributed records has no frame to
    // land on, and seq 0 is a frame that exists.
    const firstSeq = run.recordSeqs.at(0);
    if (firstSeq !== undefined) row.firstSeq = firstSeq;
    return row;
  });
}
