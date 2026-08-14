import type { CaptureRecord, Issue, Run } from '../../core/model/types';
import type { PanelState } from './panel-types';

/**
 * The text a record is matched against.
 *
 * `CaptureRecord` is a union on `kind`, so this narrows before touching either arm: a
 * keepalive has a `comment` and never an `event`. Deliberately NOT `JSON.stringify(record)` —
 * that would fold `seq`, `tMs` and `connId` into the haystack, so typing `5` would match every
 * record whose timestamp happens to contain a 5.
 */
function serializeRecord(record: CaptureRecord): string {
  if (record.kind === 'keepalive') return `keepalive ${record.comment}`;
  if (record.event !== null) return JSON.stringify(record.event);
  // An unparseable frame still has to be findable, so fall back to the raw bytes.
  return record.raw === undefined ? '' : JSON.stringify(record.raw);
}

/** The run named by `scope`, or undefined for 'all runs' / unknown id. */
export function scopedRun(s: PanelState): Run | undefined {
  if (s.scope === null) return undefined;
  return s.runs.find((run) => run.runId === s.scope);
}

/** Issues within the current scope. */
export function scopedIssues(s: PanelState): Issue[] {
  if (s.scope === null) return s.issues;
  return s.issues.filter((issue) => issue.runId === s.scope);
}

/** Issues attached to a given seq, cheapest lookup for row rendering. */
export function issuesBySeq(s: PanelState): Map<number, Issue[]> {
  const bySeq = new Map<number, Issue[]>();
  for (const issue of scopedIssues(s)) {
    const existing = bySeq.get(issue.seq);
    if (existing === undefined) bySeq.set(issue.seq, [issue]);
    else existing.push(issue);
  }
  return bySeq;
}

/** Counts for the toolbar badge. */
export function issueCounts(s: PanelState): {
  error: number;
  warning: number;
  info: number;
  total: number;
} {
  const counts = { error: 0, warning: 0, info: 0, total: 0 };
  for (const issue of scopedIssues(s)) {
    counts[issue.severity] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Records within the current scope, then the filter. Order preserved.
 *
 * Scoping goes through `Run.recordSeqs`, which is the run builder's own attribution — so a
 * keepalive, which is a real record but never enters `recordSeqs`, is visible under 'all runs'
 * and hidden under a run scope. An unknown scope id yields nothing rather than everything.
 *
 * "Carries an issue" is decided by `issuesBySeq`, not by `CaptureRecord.issues`: the run
 * builder attaches issues to the RUN, and the import path hands back the records it fed in,
 * whose own `issues` array stays empty. The seq index is the single source of truth for which
 * row is annotated, which is also what P7 relies on.
 */
export function visibleRecords(s: PanelState): CaptureRecord[] {
  let records = s.records;

  if (s.scope !== null) {
    const seqs = new Set(scopedRun(s)?.recordSeqs ?? []);
    records = records.filter((record) => seqs.has(record.seq));
  }

  if (s.filter.issuesOnly) {
    const bySeq = issuesBySeq(s);
    records = records.filter((record) => bySeq.has(record.seq));
  }

  const needle = s.filter.text.toLowerCase();
  if (needle !== '') {
    records = records.filter((record) => serializeRecord(record).toLowerCase().includes(needle));
  }

  return records;
}

/** The record for `selectedSeq`, or undefined. */
export function selectedRecord(s: PanelState): CaptureRecord | undefined {
  if (s.selectedSeq === null) return undefined;
  return s.records.find((record) => record.seq === s.selectedSeq);
}
