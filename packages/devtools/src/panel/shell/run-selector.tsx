import type { JSX } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
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
  const searchRef = useRef<HTMLInputElement>(null);
  /*
   * The active option — the one Enter would choose — as an index rather than a focused element.
   *
   * A virtualized listbox holds ~12 of its 400 options in the DOM, so roving DOM focus cannot
   * reach option 300: the node does not exist to be focused, and Tab therefore skips it entirely.
   * `aria-activedescendant` moves the *reported* focus without moving the real one, which keeps
   * the search box focused and lets `scrollToIndex` mount whatever the active index names.
   */
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-option-${index}`;

  // Opening a popup whose only keyboard entry point is a text field means focusing that field;
  // otherwise the trigger's Enter leaves focus behind on the trigger and the arrow keys go nowhere.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

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

  // A filter can shorten the list under a high active index; clamping at the point of use keeps
  // `aria-activedescendant` pointing at an option that exists.
  const lastIndex = options.length - 1;
  const active = Math.min(activeIndex, lastIndex);

  function choose(scope: RunScope): void {
    store.update((s) => selectScope(s, scope));
    setQuery('');
    setActiveIndex(0);
    setOpen(false);
  }

  function chooseOption(option: RunOption | undefined): void {
    if (option === undefined) return;
    choose(option.kind === 'all' ? null : option.run.runId);
  }

  /**
   * Arrow / Home / End / Enter on the search box, the combobox pattern.
   *
   * `preventDefault` on the arrows because the search box is a text field: without it ArrowUp and
   * ArrowDown move the caret to the start and end of the query instead of moving the selection,
   * and Home/End do the same horizontally.
   */
  function onSearchKeyDown(event: KeyboardEvent): void {
    if (lastIndex < 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex(Math.min(active + 1, lastIndex));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex(Math.max(active - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(lastIndex);
        break;
      case 'Enter':
        event.preventDefault();
        chooseOption(options[active]);
        break;
      default:
        break;
    }
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
        // Only while the listbox is actually in the document: `aria-controls` naming an id that
        // does not exist is worse than absent, because AT reports a broken relationship.
        aria-controls={open && options.length > 0 ? listboxId : undefined}
        onClick={() => {
          setActiveIndex(0);
          setOpen(!open);
        }}
      >
        {triggerText}
        <span aria-hidden="true" class="agui-run-selector__caret">
          ▾
        </span>
      </button>

      {open && (
        <div class="agui-run-selector__popup">
          <input
            ref={searchRef}
            type="search"
            // The search box *is* the combobox: it keeps DOM focus the whole time the popup is
            // open, and `aria-activedescendant` is only honoured on the focused element. The
            // trigger discloses; this navigates.
            role="combobox"
            class="agui-run-selector__search"
            aria-label="Search runs"
            placeholder="Search runs"
            aria-expanded={options.length > 0}
            aria-controls={options.length > 0 ? listboxId : undefined}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            value={query}
            onKeyDown={onSearchKeyDown}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActiveIndex(0);
            }}
          />
          {options.length === 0 ? (
            <p class="agui-run-selector__empty">{`No run matches "${query}"`}</p>
          ) : (
            <div
              id={listboxId}
              role="listbox"
              aria-label="Runs"
              // Stated here as well as on the search box. The focused element is what AT reads it
              // from, so the search box is the one that does the work; the listbox copy keeps the
              // relationship legible to anything that inspects the list on its own.
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              class="agui-run-selector__list"
            >
              <VirtualList<RunOption>
                /*
                 * Remounted per query, which resets the scroll offset to the top.
                 *
                 * `scrollToIndex` is a value and not a command (see `VirtualList`): it will not
                 * re-scroll for an index it has already served. A new query resets `activeIndex`
                 * to 0, so after scrolling to option 300 and then typing, the request would be
                 * "0" again — the same value, no scroll — and `aria-activedescendant` would name
                 * an option 300 rows above the window and therefore not in the DOM. A new query
                 * is a new list, so remounting is the honest fix rather than a nonce.
                 */
                key={query}
                items={options}
                rowHeight={ROW_HEIGHT_PX}
                height={LIST_HEIGHT_PX}
                overscan={4}
                // Keeps the active option mounted, which is what makes
                // `aria-activedescendant` resolvable at index 300 of 400.
                scrollToIndex={active >= 0 ? active : undefined}
                renderRow={(option, index) =>
                  option.kind === 'all' ? (
                    <button
                      key="all"
                      id={optionId(index)}
                      type="button"
                      role="option"
                      aria-selected={state.scope === null}
                      aria-label={`All runs · ${state.runs.length} ${state.runs.length === 1 ? 'run' : 'runs'}`}
                      class="agui-run-option"
                      data-active={index === active}
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
                      id={optionId(index)}
                      type="button"
                      role="option"
                      aria-selected={state.scope === option.run.runId}
                      aria-label={runOptionLabel(option.run)}
                      class="agui-run-option"
                      data-active={index === active}
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
