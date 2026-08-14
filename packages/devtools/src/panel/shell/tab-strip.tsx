import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import type { TabId } from '../model/panel-types';
import type { PanelStore } from '../model/store';
import { selectTab } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface TabStripProps {
  store: PanelStore;
}

/**
 * The five tabs from requirements §9. Runs, State and Messages are deferred to a later phase but
 * stay selectable — the panel renders a placeholder for them rather than hiding the tab, so the
 * shape of the finished tool is visible from the first build.
 *
 * Exported because `App` renders one tab panel per entry and needs the same order and ids.
 */
export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'runs', label: 'Runs' },
  { id: 'state', label: 'State' },
  { id: 'messages', label: 'Messages' },
  { id: 'session', label: 'Session' },
];

/** The id of the panel a tab controls. `App` must put this on the rendered tab panel. */
export function tabPanelId(tab: TabId): string {
  return `agui-tabpanel-${tab}`;
}

export function TabStrip({ store }: TabStripProps): JSX.Element {
  const state = usePanelState(store);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function select(tab: TabId): void {
    store.update((s) => selectTab(s, tab));
  }

  // Arrow-key movement is what makes `tablist` a single tab stop rather than five.
  function onKeyDown(e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void {
    const current = TABS.findIndex((t) => t.id === state.tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    const tab = TABS[next];
    if (tab === undefined) return;
    e.preventDefault();
    select(tab.id);
    buttons.current[next]?.focus();
  }

  return (
    <div class="agui-tabs" role="tablist" aria-label="Panel sections" onKeyDown={onKeyDown}>
      {TABS.map((tab, i) => {
        const selected = state.tab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`agui-tab-${tab.id}`}
            class="agui-tabs__tab"
            aria-selected={selected}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            onClick={() => select(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
