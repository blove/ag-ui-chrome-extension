import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Run } from '../../core/model/types';
import { VirtualList } from '../common/virtual-list';
import type { RunScope } from '../model/panel-types';
import { scopedRun } from '../model/selectors';
import type { PanelStore } from '../model/store';
import { selectScope } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface RunSelectorProps {
  store: PanelStore;
}

/** The "all runs" entry is an option like any other, so one list handles both scopes. */
type RunOption = { kind: 'all' } | { kind: 'run'; run: Run };

const ROW_HEIGHT_PX = 32;
const LIST_HEIGHT_PX = 256;

function issueText(count: number): string {
  if (count === 0) return 'no issues';
  return count === 1 ? '1 issue' : `${count} issues`;
}

function issueTone(run: Run): 'error' | 'warning' | 'none' {
  if (run.issues.some((i) => i.severity === 'error')) return 'error';
  if (run.issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'none';
}

function matches(run: Run, query: string): boolean {
  const haystack = [run.runId, run.threadId, run.outcome, run.agentId ?? ''].join(' ').toLowerCase();
  return haystack.includes(query);
}

/**
 * A row's accessible name is stated, never assembled.
 *
 * The name a browser computes from three adjacent inline spans has no separators at all —
 * `r_2thread t_1 · aborted2 issues` — which reads as noise to a screen reader and makes every
 * `getByRole(..., { name })` query a guess. Each option says its own name instead.
 */
function runOptionLabel(run: Run): string {
  return `${run.runId} · thread ${run.threadId} · ${run.outcome} · ${issueText(run.issues.length)}`;
}

/**
 * P10: searchable and virtualized, because a long session has many runs and a plain dropdown
 * assumes four.
 *
 * Each row carries thread, outcome and issue count so the interesting run is findable here rather
 * than by opening the Runs tab first.
 */
export function RunSelector({ store }: RunSelectorProps): JSX.Element {
  const state = usePanelState(store);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = scopedRun(state);
  const containerRef = useRef<HTMLDivElement>(null);

  /*
   * Dismiss on a pointer press anywhere else. Without this the only exits are Escape and choosing
   * an option, so clicking an unrelated control leaves a 256px popup parked across the tab strip
   * with nothing under the pointer but overlay.
   *
   * `pointerdown` on the document rather than `focusout` on the container: it fires before the
   * outside control's `click`, so that control still receives the press it was aimed at, and it
   * does not depend on the popup ever having held focus.
   */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container === null) return;
      const target = event.target;
      if (target instanceof Node && container.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const options = useMemo<RunOption[]>(() => {
    const q = query.trim().toLowerCase();
    const runs = q === '' ? state.runs : state.runs.filter((r) => matches(r, q));
    const head: RunOption[] = q === '' || 'all runs'.includes(q) ? [{ kind: 'all' }] : [];
    return [...head, ...runs.map((run): RunOption => ({ kind: 'run', run }))];
  }, [state.runs, query]);

  function choose(scope: RunScope): void {
    store.update((s) => selectScope(s, scope));
    setQuery('');
    setOpen(false);
  }

  const triggerText =
    state.scope === null
      ? 'Run: all runs'
      : current === undefined
        ? `Run: ${state.scope} (unknown)`
        : `Run: ${current.runId}`;

  return (
    <div
      ref={containerRef}
      class="agui-run-selector"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        class="agui-run-selector__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {triggerText}
        <span aria-hidden="true" class="agui-run-selector__caret">
          ▾
        </span>
      </button>

      {open && (
        <div class="agui-run-selector__popup">
          <input
            type="search"
            class="agui-run-selector__search"
            aria-label="Search runs"
            placeholder="Search runs"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          {options.length === 0 ? (
            <p class="agui-run-selector__empty">{`No run matches "${query}"`}</p>
          ) : (
            <div role="listbox" aria-label="Runs" class="agui-run-selector__list">
              <VirtualList<RunOption>
                items={options}
                rowHeight={ROW_HEIGHT_PX}
                height={LIST_HEIGHT_PX}
                overscan={4}
                renderRow={(option) =>
                  option.kind === 'all' ? (
                    <button
                      key="all"
                      type="button"
                      role="option"
                      aria-selected={state.scope === null}
                      aria-label={`All runs · ${state.runs.length} ${state.runs.length === 1 ? 'run' : 'runs'}`}
                      class="agui-run-option"
                      onClick={() => choose(null)}
                    >
                      <span class="agui-run-option__id">All runs</span>
                      <span class="agui-run-option__meta">
                        {`${state.runs.length} ${state.runs.length === 1 ? 'run' : 'runs'}`}
                      </span>
                    </button>
                  ) : (
                    <button
                      key={option.run.runId}
                      type="button"
                      role="option"
                      aria-selected={state.scope === option.run.runId}
                      aria-label={runOptionLabel(option.run)}
                      class="agui-run-option"
                      onClick={() => choose(option.run.runId)}
                    >
                      <span class="agui-run-option__id">{option.run.runId}</span>
                      <span class="agui-run-option__meta">
                        {`thread ${option.run.threadId} · ${option.run.outcome}`}
                      </span>
                      <span class="agui-run-option__issues" data-tone={issueTone(option.run)}>
                        {issueText(option.run.issues.length)}
                      </span>
                    </button>
                  )
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
