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

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search runs' }), {
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

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search runs' }), {
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

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search runs' }), {
      target: { value: 'r_487' },
    });
    fireEvent.click(screen.getByRole('option', { name: /r_487/ }));

    expect(store.get().scope).toBe('r_487');
  });

  it('closes on Escape without changing the scope', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search runs' }), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(store.get().scope).toBe('r_2');
  });
});
