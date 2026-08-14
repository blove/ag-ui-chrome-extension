import { describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/preact';
import type { Run, RunMetrics, RunOutcome } from '../../core/model/types';
import { createPanelStore, selectScope } from '../model/store';
import { initialPanelState } from '../model/panel-types';
import { ScopeBar } from './scope-bar';

function metrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
    ...over,
  };
}

function makeRun(
  runId: string,
  threadId: string,
  outcome: RunOutcome,
  m: RunMetrics = metrics(),
): Run {
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
    metrics: m,
    issues: [],
    recordSeqs: [],
  };
}

const RUNS: Run[] = [
  makeRun('r_1', 't_1', 'finished'),
  makeRun('r_2', 't_1', 'aborted', metrics({ durationMs: 1840, ttftMs: 240 })),
  makeRun('r_3', 't_2', 'error'),
  makeRun('r_4', 't_2', 'running'),
];

describe('ScopeBar', () => {
  it('names the scoped run, its position, thread and outcome', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<ScopeBar store={store} />);

    const bar = screen.getByRole('status');
    expect(within(bar).getByText('run r_2 of 4 · thread t_1 · aborted')).toBeTruthy();
  });

  it('shows duration and TTFT for the scoped run', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('duration 1.84s · TTFT 240ms')).toBeTruthy();
  });

  it('renders an em dash for metrics a still-running run has not produced', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_4' });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('duration — · TTFT —')).toBeTruthy();
  });

  it('reports the all-runs scope with a run count and no per-run metrics', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('all runs · 4 runs')).toBeTruthy();
    expect(screen.queryByText(/TTFT/)).toBeNull();
  });

  it('says so plainly when nothing has been captured', () => {
    const store = createPanelStore(initialPanelState());
    render(<ScopeBar store={store} />);

    expect(screen.getByText('no runs captured')).toBeTruthy();
  });

  it('does not silently fall back to all-runs when the scoped id is unknown', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_9' });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('run r_9 · not in this capture')).toBeTruthy();
  });

  it('follows the store when the scope changes', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<ScopeBar store={store} />);

    act(() => {
      store.update((s) => selectScope(s, 'r_3'));
    });

    expect(screen.getByText('run r_3 of 4 · thread t_2 · error')).toBeTruthy();
  });
});
