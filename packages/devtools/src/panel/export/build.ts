/**
 * Export policy, in one pure module.
 *
 * Everything interesting about export — what a scope includes, what redaction touches, what the
 * header claims — is decided here, so it is testable in Node with no DOM and no Chrome. The only
 * thing that is NOT here is the act of putting bytes somewhere, which is `download.ts`: that file
 * is deliberately thin because it is the part no unit test can reach.
 *
 * E2 — the lines are RE-ENCODED FROM RECORDS, never passed through from the bytes an import was
 * decoded from. A live capture has no bytes at all, so a passthrough path would be exercised only
 * by imported captures, and the two would drift. Done-when #6 asks for a re-import that is
 * identical IN THE TABS, which is semantic identity and is what a round trip through this
 * function proves.
 */
import type { RuntimeInfo } from '../../core/detect/info';
import type { JsonlHeader, JsonlLine } from '../../core/jsonl/codec';
import { redactLine, type RedactionGroup } from '../../core/jsonl/redact';
import type { CaptureRecord, Run } from '../../core/model/types';
import type { RequestLine } from '../../sw/protocol';
import type { BinaryTransport, PanelSource, RunScope } from '../model/panel-types';
import { buildHeader } from './header';

/**
 * The slice of `PanelState` an export reads.
 *
 * Declared as its own interface rather than taking `PanelState` so a test can construct one in
 * three lines — and so it is visible at a glance that export reads nothing about the UI. A
 * `PanelState` satisfies it structurally, which is how both call sites pass one straight in.
 */
export interface ExportSource {
  records: readonly CaptureRecord[];
  requests: readonly RequestLine[];
  runs: readonly Run[];
  /** The header of the imported file this capture came from. `null` for a live capture. */
  importedHeader: JsonlHeader | null;
  framework: string | null;
  binaryTransport: BinaryTransport | null;
  /**
   * What a `/info` response said during this capture. Exported so an imported capture shows the
   * same Session metadata a live one did (requirements §10: import gives you all tabs working).
   */
  runtime: RuntimeInfo | null;
  source: PanelSource;
}

export interface ExportOptions {
  /** `null` is every run — the same `RunScope` the panel's own scope bar uses. */
  scope: RunScope;
  /**
   * E4: redaction is a MODIFIER on a scope, not a third scope. Modelling "redacted bug report"
   * as `{ scope, groups }` is what stops "single run" and "single run, redacted" from becoming
   * two code paths that can disagree.
   */
  groups: RedactionGroup[];
  toolVersion: string;
  exportedAtIso: string;
}

export interface ExportCounts {
  events: number;
  keepalives: number;
  requests: number;
  runs: number;
}

export interface ExportBundle {
  lines: JsonlLine[];
  header: JsonlHeader;
  counts: ExportCounts;
}

/**
 * The records a scope selects.
 *
 * Events are selected by `Run.recordSeqs`, per E4 — that array IS the run's membership, computed
 * and tested in `core/`.
 *
 * Keepalives need their own rule, because they are deliberately NOT in `recordSeqs`: requirements
 * §5.4 records them and excludes them from the event count, so applying the same filter would
 * silently drop every one of them from a single-run export. They are taken from the run's own
 * connection, within the run's seq span — which keeps the `keepalive-gap` signal that is the
 * entire reason a keepalive is retained, without pulling in heartbeats that belong to a different
 * run sharing the connection.
 */
function selectRecords(source: ExportSource, run: Run | null): CaptureRecord[] {
  if (run === null) return [...source.records];

  const seqs = new Set(run.recordSeqs);
  const first = run.recordSeqs[0];
  const last = run.recordSeqs.at(-1);

  return source.records.filter((record) => {
    if (record.kind === 'event') return seqs.has(record.seq);
    if (record.connId !== run.connId) return false;
    if (first === undefined || last === undefined) return false;
    return record.seq >= first && record.seq <= last;
  });
}

function toLine(record: CaptureRecord): JsonlLine {
  if (record.kind === 'keepalive') {
    return {
      kind: 'keepalive',
      connId: record.connId,
      seq: record.seq,
      tMs: record.tMs,
      comment: record.comment,
    };
  }
  /*
   * `raw` rather than `event`, deliberately.
   *
   * `raw` is the frame exactly as it arrived; `event` is `null` when the payload would not parse
   * as an object. Writing `event` would turn an unparseable frame into a `null` in the file and
   * lose the thing a colleague opened the capture to look at. The codec types the field `unknown`
   * for precisely this reason.
   *
   * `raw` is `undefined` on a record whose bytes were counted against a sibling produced by chunk
   * expansion — those never reach `PanelState.records`, but the fallback keeps the line honest if
   * one ever did.
   */
  return {
    kind: 'event',
    connId: record.connId,
    seq: record.seq,
    tMs: record.tMs,
    event: record.raw ?? record.event,
  };
}

/**
 * Build the lines an export writes. Pure: same input, same file, every time.
 *
 * Ordering is header, then request lines by arrival, then records by seq. Requests first because
 * `loadJsonl` and the live fold both feed the run builder in file order, and a run whose
 * `RunAgentInput` arrives after its first event picks up `run-started-without-input` — a finding
 * about the user's server that this capture did not have.
 */
export function buildExport(source: ExportSource, options: ExportOptions): ExportBundle {
  const run = options.scope === null ? null : (source.runs.find((r) => r.runId === options.scope) ?? null);
  // A scope naming a run this capture does not hold selects nothing. Falling back to everything
  // would hand over the whole capture to someone who asked for one run of it.
  const scopedToMissingRun = options.scope !== null && run === null;

  const records = scopedToMissingRun ? [] : selectRecords(source, run);
  const connIds = new Set(records.map((record) => record.connId));
  const requests = scopedToMissingRun
    ? []
    : source.requests.filter((request) => run === null || connIds.has(request.connId));

  const header = buildHeader({
    previous: source.importedHeader,
    groups: options.groups,
    toolVersion: options.toolVersion,
    exportedAtIso: options.exportedAtIso,
    url: source.source.kind === 'live' ? source.source.origin : null,
    framework: source.framework,
    transport: source.binaryTransport !== null ? 'binary' : 'sse',
    runtime: source.runtime,
  });

  const body: JsonlLine[] = [
    ...requests.map((request) => ({ kind: 'request' as const, ...request })),
    ...[...records].sort((a, b) => a.seq - b.seq).map((record) => toLine(record)),
  ];

  return {
    // The header is never redacted — `redactLine` returns it untouched by design, and its
    // `redacted` field is the one thing in the file that must state the truth about the rest.
    lines: [header, ...body.map((line) => redactLine(line, options.groups))],
    header,
    counts: {
      events: records.filter((record) => record.kind === 'event').length,
      keepalives: records.filter((record) => record.kind === 'keepalive').length,
      requests: requests.length,
      runs: scopedToMissingRun ? 0 : run === null ? source.runs.length : 1,
    },
  };
}

/**
 * Why export is unavailable, or `null` when it is available.
 *
 * A zero-record `.agui.jsonl` is worse than no file: it opens, it validates, it renders an empty
 * timeline, and it tells its reader nothing about why. So the control is disabled WITH THE
 * REASON — the same disabled-with-a-reason the toolbar already uses for Record, because a control
 * that vanishes reads as a missing feature and one that is inert without explanation reads as a
 * bug.
 */
export function exportBlockedReason(source: ExportSource, scope: RunScope): string | null {
  if (source.records.length === 0) {
    return 'Nothing has been captured yet, so there is nothing to export.';
  }
  if (scope !== null) {
    const run = source.runs.find((candidate) => candidate.runId === scope);
    if (run === undefined || run.recordSeqs.length === 0) {
      return 'The selected run holds no records, so there is nothing to export. Switch the scope to all runs.';
    }
  }
  return null;
}
