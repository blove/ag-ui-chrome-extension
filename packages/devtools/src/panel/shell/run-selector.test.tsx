import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import type { Issue, Run, RunMetrics, RunOutcome } from '../../core/model/types';
import { makeIssue } from '../../core/model/types';
import { initialPanelState } from '../model/panel-types';
import { createPanelStore } from '../model/store';
import { RunSelector } from './run-selector';

function metrics(): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
  };
}

function makeRun(runId: string, threadId: string, outcome: RunOutcome, issues: Issue[] = []): Run {
  return {
    runId,
    threadId,
    connId: 'c_1',
    startedAtMs: 0,
    outcome,
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: metrics(),
    issues,
    recordSeqs: [],
    redacted: [],
  };
}

const RUNS: Run[] = [
  makeRun('r_1', 't_1', 'finished'),
  makeRun('r_2', 't_1', 'aborted', [
    makeIssue('event-after-terminal', 'late event', 7, { runId: 'r_2' }),
    makeIssue('unclosed-message', 'message left open', 9, { runId: 'r_2' }),
  ]),
  makeRun('r_3', 't_2', 'error'),
];

function openSelector(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Run:/ }));
}

describe('RunSelector', () => {
  it('names the current scope on the trigger', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);

    expect(screen.getByRole('button', { name: 'Run: r_2' })).toBeTruthy();
  });

  it('offers an all-runs entry alongside the runs', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    expect(screen.getByRole('option', { name: /All runs/ })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('labels each run with thread, outcome and issue count', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    const option = screen.getByRole('option', { name: /r_2/ });
    expect(option.textContent).toContain('thread t_1 · aborted');
    expect(option.textContent).toContain('2 issues');
    expect(screen.getByRole('option', { name: /r_1/ }).textContent).toContain('no issues');
  });

  it('marks the scoped run as the selected option', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    expect(screen.getByRole('option', { name: /r_2/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: /r_1/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('option', { name: /All runs/ }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('sets the scope and closes when a run is chosen', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /r_3/ }));

    expect(store.get().scope).toBe('r_3');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run: r_3' })).toBeTruthy();
  });

  it('returns to all runs through the all-runs entry', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_3' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /All runs/ }));

    expect(store.get().scope).toBeNull();
    expect(screen.getByRole('button', { name: 'Run: all runs' })).toBeTruthy();
  });

  it('filters the list by the search query', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(screen.getByRole('combobox', { name: 'Search runs' }), {
      target: { value: 't_2' },
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('r_3');
  });

  it('says so when nothing matches instead of showing an empty list', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(screen.getByRole('combobox', { name: 'Search runs' }), {
      target: { value: 'nope' },
    });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('No run matches "nope"')).toBeTruthy();
  });

  it('virtualizes: 500 runs render a window, not 500 rows', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      makeRun(`r_${i + 1}`, `t_${i % 7}`, 'finished'),
    );
    const store = createPanelStore({ ...initialPanelState(), runs: many, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    const rendered = screen.getAllByRole('option').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(30);
  });

  it('finds a run deep in the list by search', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      makeRun(`r_${i + 1}`, `t_${i % 7}`, 'finished'),
    );
    const store = createPanelStore({ ...initialPanelState(), runs: many, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(screen.getByRole('combobox', { name: 'Search runs' }), {
      target: { value: 'r_487' },
    });
    fireEvent.click(screen.getByRole('option', { name: /r_487/ }));

    expect(store.get().scope).toBe('r_487');
  });

  it('closes on a pointer press outside without changing the scope', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(
      <div>
        <RunSelector store={store} />
        <button type="button">Elsewhere</button>
      </div>,
    );
    openSelector();
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(store.get().scope).toBe('r_2');
  });

  it('stays open for a pointer press inside the popup', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Search runs' }));

    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('closes on Escape without changing the scope', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search runs' }), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(store.get().scope).toBe('r_2');
  });
});

/**
 * The list is virtualized, so only ~12 of 400 options exist in the DOM at any moment. Roving DOM
 * focus therefore cannot reach option 300 — the node is not there to be focused, and Tab skips it.
 * These tests hold the combobox contract that replaces it: the search box keeps focus,
 * `aria-activedescendant` names the active option, and `scrollToIndex` mounts whatever it names.
 */
describe('RunSelector keyboard navigation', () => {
  const MANY: Run[] = Array.from({ length: 400 }, (_, i) =>
    makeRun(`r_${String(i + 1).padStart(3, '0')}`, `t_${i % 7}`, 'finished'),
  );

  function search(): HTMLElement {
    return screen.getByRole('combobox', { name: 'Search runs' });
  }

  function activeOption(): HTMLElement | null {
    const id = screen.getByRole('listbox').getAttribute('aria-activedescendant');
    return id === null ? null : document.getElementById(id);
  }

  function press(key: string, times = 1): void {
    for (let i = 0; i < times; i += 1) fireEvent.keyDown(search(), { key });
  }

  it('starts with the first option active and points the listbox at it', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^All runs/);
  });

  it('moves the active option down and up with the arrow keys', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    press('ArrowDown', 2);
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^r_2 · /);

    press('ArrowUp');
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^r_1 · /);
  });

  it('does not run off either end of the list', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    press('ArrowUp', 3);
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^All runs/);

    press('ArrowDown', 20);
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^r_3 · /);
  });

  it('chooses the active option with Enter, which the probe found did nothing', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    press('ArrowDown', 3);
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(store.get().scope).toBe('r_3');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('brings an option far below the rendered window into the DOM as it is arrowed to', () => {
    // 400 runs + the all-runs entry, of which the 256px viewport holds ~12. Option 40 is well
    // outside the initial window, so it can only be reachable if the window follows the active
    // index — the property that was broken.
    const store = createPanelStore({ ...initialPanelState(), runs: MANY, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    expect(screen.queryByRole('option', { name: /^r_040 · / })).toBeNull();

    press('ArrowDown', 40);

    expect(screen.getByRole('option', { name: /^r_040 · / })).toBeTruthy();
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^r_040 · /);
  });

  it('reaches the last of 400 options with End, and the first again with Home', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: MANY, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    press('End');

    expect(screen.getByRole('option', { name: /^r_400 · / })).toBeTruthy();
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^r_400 · /);

    press('Home');

    expect(screen.getByRole('option', { name: /^All runs/ })).toBeTruthy();
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^All runs/);
  });

  it('selects a distant run with Enter without ever showing it on screen first', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: MANY, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    press('End');
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(store.get().scope).toBe('r_400');
  });

  it('keeps the active option mounted after the list is scrolled by hand and then filtered', () => {
    /*
     * The one case `scrollToIndex` alone cannot carry, and the exception to the note that keyboard
     * navigation always moves to a *different* index.
     *
     * Scrolling with the wheel moves the window without going through `scrollToIndex`, so the last
     * index it served is still 0. Typing resets the active index to 0 as well — the same value, and
     * `VirtualList` deliberately will not re-scroll for an index it has already served. The query
     * below still matches 400 runs, so `VirtualList`'s clamp of `scrollTop` to `maxScrollTop` does
     * not rescue it either: without a remount the window stays at the bottom and
     * `aria-activedescendant` names an option ~390 rows above it that is not in the DOM.
     */
    const store = createPanelStore({ ...initialPanelState(), runs: MANY, scope: null });
    const { container } = render(<RunSelector store={store} />);
    openSelector();

    const viewport = container.querySelector('.agui-vlist');
    expect(viewport).not.toBeNull();
    (viewport as HTMLElement).scrollTop = 12_000;
    fireEvent.scroll(viewport as HTMLElement);
    expect(screen.queryByRole('option', { name: /^All runs/ })).toBeNull();

    fireEvent.input(search(), { target: { value: 't_' } });

    expect(screen.getAllByRole('option').length).toBeLessThan(30);
    expect(activeOption()).not.toBeNull();
    expect(activeOption()?.getAttribute('aria-label')).toMatch(/^r_001 · /);
  });

  it('keeps focus in the search box while the active option moves', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: MANY, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    press('ArrowDown', 30);

    expect(document.activeElement).toBe(search());
  });

  it('wires the trigger and the search box to the listbox by id', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);

    const trigger = screen.getByRole('button', { name: /^Run:/ });
    expect(trigger.getAttribute('aria-controls')).toBeNull();

    openSelector();

    const listboxId = screen.getByRole('listbox').id;
    expect(listboxId).not.toBe('');
    expect(trigger.getAttribute('aria-controls')).toBe(listboxId);
    expect(search().getAttribute('aria-controls')).toBe(listboxId);
    expect(search().getAttribute('aria-activedescendant')).toBe(activeOption()?.id);
  });

  it('ignores the arrow keys when the query matches nothing', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(search(), { target: { value: 'nope' } });
    press('ArrowDown', 3);
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(screen.getByText('No run matches "nope"')).toBeTruthy();
    expect(store.get().scope).toBe('r_2');
    expect(search().getAttribute('aria-activedescendant')).toBeNull();
  });
});
