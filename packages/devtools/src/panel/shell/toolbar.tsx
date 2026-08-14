import type { JSX } from 'preact';
import { issueCounts } from '../model/selectors';
import { initialPanelState } from '../model/panel-types';
import type { RunScope } from '../model/panel-types';
import type { PanelStore } from '../model/store';
import { setTextFilter, toggleExpandChunks, toggleIssuesOnly } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface ToolbarProps {
  store: PanelStore;
  onImport: () => void;
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
 * Record and preserve-on-navigate are rendered disabled: phase 1 has no capture layer, and
 * `ToolbarProps` carries no callback for either. Showing them inert is more honest than hiding
 * them and more honest than wiring a control that does nothing.
 */
export function Toolbar({ store, onImport }: ToolbarProps): JSX.Element {
  const state = usePanelState(store);
  const counts = issueCounts(state);
  const tone = issueTone(counts);
  const recording = state.capture.kind === 'on';
  const hasData = state.source.kind !== 'empty' || state.records.length > 0 || state.runs.length > 0;

  return (
    <div class="agui-toolbar" role="toolbar" aria-label="Capture controls">
      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={recording}
        disabled
        title="Live capture is not available yet — import a .agui.jsonl to inspect a stream"
      >
        {recording ? 'Pause' : 'Record'}
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        disabled={!hasData}
        onClick={() => {
          // No `clearCapture` action exists; a reset to the initial state is exactly what clear
          // means. Capture status survives because it describes the inspected page, not the data.
          store.update((s) => ({ ...initialPanelState(), capture: s.capture }));
        }}
      >
        Clear
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={false}
        disabled
        title="Takes effect once live capture lands"
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
