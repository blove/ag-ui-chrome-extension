import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { encodeJsonl } from '../../core/jsonl/codec';
import { buildExport, exportBlockedReason } from '../export/build';
import { DEFAULT_EXPORT_IO, type ExportIo } from '../export/download';
import { exportFilename } from '../export/filename';
import { issueCounts } from '../model/selectors';
import { initialPanelState } from '../model/panel-types';
import type { RunScope } from '../model/panel-types';
import type { PanelStore } from '../model/store';
import {
  setTextFilter,
  toggleExpandChunks,
  toggleIssuesOnly,
  togglePreserveLog,
} from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface ToolbarProps {
  store: PanelStore;
  onImport: () => void;
  /**
   * Record/pause. Not a store action, because pausing has to reach the service worker as well
   * as the state — a paused panel that let the worker keep buffering would resume by dumping
   * everything it missed, which is not what Pause means.
   *
   * Optional so the control is still constructible where capture is not: the button is
   * disabled whenever capture is not `on`, so an absent callback is unreachable.
   */
  onSetRecording?: (recording: boolean) => void;
  /**
   * Called after Clear has reset panel state, so the host can clear the service worker's buffer
   * too. Without it the two ends disagree: the panel would be empty while the worker still held
   * the records, and the next snapshot — a reconnect, a reopened panel — would resurrect them.
   */
  onClear?: () => void;
  /**
   * The two side effects export needs. Injected so the button's success and failure branches are
   * both reachable from a test without a real `Blob` — `download.ts` is the deliberately
   * untestable edge, and this is the seam that keeps it out of everything above it.
   */
  exportIo?: ExportIo;
}

export type IssueTone = 'error' | 'warning' | 'none';

interface Counts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/**
 * Danger is reserved for errors. Warnings get the warning colour; an info-only or empty count stays
 * neutral, so the one red thing in the panel always means a protocol error.
 */
export function issueTone(counts: Counts): IssueTone {
  if (counts.error > 0) return 'error';
  if (counts.warning > 0) return 'warning';
  return 'none';
}

export function issueBadgeText(total: number): string {
  return total === 1 ? '1 issue' : `${total} issues`;
}

/**
 * The visible text is a prefix of the accessible name, and the name states the filter state in
 * words — a filtered list must never be mistakable for a clean one, for a screen reader either.
 *
 * The name says *issues in the current run scope*, deliberately, and never a row count. The two
 * genuinely differ: a `keepalive-gap` issue carries a `runId` so it counts here, but a keepalive
 * never enters `Run.recordSeqs`, so under a run scope its row can never be shown. Measured with a
 * >15s gap and issues-only on, the badge reads 2 while the list holds 1. Promising "2 events" would
 * send the reader hunting for a row that does not exist.
 *
 * The scope phrase branches on `scope`, because "in the current run scope" is a lie when the scope
 * is every run: the count really is the whole capture's, and a reader told it was scoped would
 * under-read a number that is in fact the total. `scope` is passed rather than derived from
 * `counts`, since a single-run capture makes the two counts identical and indistinguishable.
 */
export function issueBadgeLabel(counts: Counts, issuesOnly: boolean, scope: RunScope): string {
  const head =
    counts.total === 0
      ? '0 issues'
      : `${issueBadgeText(counts.total)}: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`;
  const where = scope === null ? 'across all runs' : 'in the current run scope';
  const action = issuesOnly
    ? 'Currently filtered to events with issues; activate to show every event.'
    : 'Activate to filter the event list to events with issues.';
  return `${head} detected ${where}. ${action}`;
}

/**
 * P2: with no Issues tab, this badge is where protocol problems stay visible. It is the scoped
 * count, the severity signal, and the issues-only filter in one control.
 *
 * Record and preserve-on-navigate are live once capture is on, and disabled with a reason when
 * it is not. Disabled-with-a-reason rather than hidden: a control that vanishes reads as a
 * missing feature, and one that is present but inert with no explanation reads as a bug.
 */
export function Toolbar({
  store,
  onImport,
  onSetRecording,
  onClear,
  exportIo = DEFAULT_EXPORT_IO,
}: ToolbarProps): JSX.Element {
  const state = usePanelState(store);
  const counts = issueCounts(state);
  const tone = issueTone(counts);
  const captureIsOn = state.capture.kind === 'on';
  const recording = captureIsOn && state.recording;
  const hasData = state.source.kind !== 'empty' || state.records.length > 0 || state.runs.length > 0;

  const exportBlocked = exportBlockedReason(state, state.scope);
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * E5 — one click: current scope, UNREDACTED, and labelled as unredacted.
   *
   * This is the developer exporting their own capture for themselves, where a silently-redacted
   * file would be useless — §10 lists "full" and "redacted bug report" as separate modes for
   * exactly that reason. Redaction is a deliberate act on the Session tab; the label here is what
   * stops the other direction from being a surprise too.
   *
   * The same `buildExport` the Session tab calls, with the arguments fixed. Two call sites, one
   * implementation, no duplicated policy.
   */
  function onExport(): void {
    if (exportBlocked !== null) {
      setExportError(exportBlocked);
      return;
    }
    const built = buildExport(state, {
      scope: state.scope,
      groups: [],
      toolVersion: chrome.runtime.getManifest().version,
      exportedAtIso: new Date().toISOString(),
    });
    const result = exportIo.download(
      exportFilename(built.header.url, built.header.capturedAt),
      encodeJsonl(built.lines),
    );
    setExportError(result.ok ? null : result.reason);
  }

  return (
    <div class="agui-toolbar" role="toolbar" aria-label="Capture controls">
      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={recording}
        disabled={!captureIsOn}
        title={
          captureIsOn
            ? 'Stop or resume buffering events for this tab'
            : 'Enable capture for this origin first — or import a .agui.jsonl to inspect a stream'
        }
        onClick={() => onSetRecording?.(!state.recording)}
      >
        {recording ? 'Pause' : 'Record'}
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        disabled={!hasData}
        onClick={() => {
          // No `clearCapture` action exists; a reset to the initial state is exactly what clear
          // means. Capture status, source, record/pause and preserve-log survive: they describe
          // the inspected page and the session's settings, not the data being discarded.
          store.update((s) => ({
            ...initialPanelState(),
            capture: s.capture,
            source: s.source.kind === 'live' ? s.source : { kind: 'empty' },
            recording: s.recording,
            preserveLog: s.preserveLog,
          }));
          onClear?.();
        }}
      >
        Clear
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={captureIsOn && state.preserveLog}
        disabled={!captureIsOn}
        title={
          captureIsOn
            ? 'Keep captured events when the inspected page navigates'
            : 'Applies to live capture, which is off for this origin'
        }
        onClick={() => store.update(togglePreserveLog)}
      >
        Preserve log on navigate
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={state.expandChunks}
        onClick={() => store.update(toggleExpandChunks)}
      >
        Expand chunks
      </button>

      <input
        type="search"
        class="agui-toolbar__filter"
        aria-label="Filter events"
        placeholder="Filter"
        value={state.filter.text}
        onInput={(e) => {
          const { value } = e.currentTarget;
          store.update((s) => setTextFilter(s, value));
        }}
      />

      <button type="button" class="agui-toolbar__button" onClick={onImport}>
        Import
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        disabled={exportBlocked !== null}
        title={
          exportBlocked ??
          'Download this capture as .agui.jsonl, unredacted, at the current run scope. ' +
            'Use the Session tab to redact field groups, copy to the clipboard, or emit a test fixture.'
        }
        onClick={onExport}
      >
        Export (unredacted)
      </button>

      {exportError !== null && (
        <span class="agui-toolbar__export-error" role="alert">
          {exportError}
        </span>
      )}

      {state.droppedBefore > 0 && (
        <span
          class="agui-toolbar__dropped"
          title="Older events were evicted from the buffer before the first one shown"
        >
          {`${state.droppedBefore} dropped`}
        </span>
      )}

      <button
        type="button"
        class="agui-issue-badge"
        data-tone={tone}
        aria-pressed={state.filter.issuesOnly}
        aria-label={issueBadgeLabel(counts, state.filter.issuesOnly, state.scope)}
        onClick={() => store.update(toggleIssuesOnly)}
      >
        <span aria-hidden="true" class="agui-issue-badge__dot" />
        <span class="agui-issue-badge__count">{issueBadgeText(counts.total)}</span>
        {state.filter.issuesOnly && <span class="agui-issue-badge__flag">filtered</span>}
      </button>
    </div>
  );
}
