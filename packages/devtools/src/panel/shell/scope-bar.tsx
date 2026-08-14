import type { JSX } from 'preact';
import { formatDuration } from '../common/format';
import { scopedRun } from '../model/selectors';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface ScopeBarProps {
  store: PanelStore;
}

/**
 * P3: the answer to "what am I looking at", visible from every tab.
 *
 * Display only. The run selector sits beside it in the same band; keeping the two apart means the
 * summary never has to know whether a dropdown is open.
 *
 * An unresolvable scope reads as `not in this capture` rather than falling back to the all-runs
 * summary. Silently widening the scope is exactly the class of lie P3 exists to prevent.
 */
export function ScopeBar({ store }: ScopeBarProps): JSX.Element {
  const state = usePanelState(store);
  const run = scopedRun(state);
  const total = state.runs.length;

  let summary: string;
  if (state.scope === null) {
    summary =
      total === 0 ? 'no runs captured' : `all runs · ${total} ${total === 1 ? 'run' : 'runs'}`;
  } else if (run === undefined) {
    summary = `run ${state.scope} · not in this capture`;
  } else {
    summary = `run ${run.runId} of ${total} · thread ${run.threadId} · ${run.outcome}`;
  }

  return (
    <div class="agui-scope" role="status" aria-label="Current scope">
      <span class="agui-scope__summary">{summary}</span>
      {run !== undefined && (
        <span class="agui-scope__metrics">
          {`duration ${formatDuration(run.metrics.durationMs)} · TTFT ${formatDuration(run.metrics.ttftMs)}`}
        </span>
      )}
    </div>
  );
}
