/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { act } from 'preact/test-utils';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import runsEdgeJsonl from '../../../test/fixtures/runs-edge.agui.jsonl?raw';
import { encodeJsonl } from '../../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS } from '../../../core/jsonl/redact';
import type { Run } from '../../../core/model/types';
import { buildExport } from '../../export/build';
import { applyLoaded } from '../../import/apply-loaded';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore, type PanelStore } from '../../model/store';
import { Runs } from './runs';

type FixtureName = 'happy' | 'edge';

const TEXT: Record<FixtureName, string> = { happy: happyJsonl, edge: runsEdgeJsonl };

function imported(name: FixtureName): PanelState {
  const loaded = loadJsonl(TEXT[name]);
  expect(loaded.decodeErrors).toEqual([]);
  return applyLoaded(initialPanelState(), loaded, `${name}.agui.jsonl`, 1000);
}

/**
 * A capture the user redacted before sharing it, produced the way a user produces one: through
 * the real export builder, then re-imported. §11 keeps structure and replaces values, so this is
 * the state a colleague opening a bug report is in.
 */
function redacted(name: FixtureName): PanelState {
  const source = imported(name);
  const text = encodeJsonl(
    buildExport(source, {
      scope: null,
      groups: [...ALL_REDACTION_GROUPS],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
    }).lines,
  );
  return applyLoaded(initialPanelState(), loadJsonl(text), 'redacted.agui.jsonl', 2000);
}

function renderTab(state: PanelState): PanelStore {
  const store = createPanelStore(state);
  render(<Runs store={store} />);
  return store;
}

/** The data rows, in DOM order — the header is a `row` too, and carries no run. */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((el) => el.hasAttribute('data-run-id'));
}

function rowIds(): string[] {
  return dataRows().map((el) => el.getAttribute('data-run-id') ?? '');
}

function row(runId: string): HTMLElement {
  const found = dataRows().find((el) => el.getAttribute('data-run-id') === runId);
  expect(found).toBeDefined();
  return found!;
}

/** The rendered cell of a row, as text plus whether the panel claims to know it. */
function cell(runId: string, column: string): { text: string; known: string } {
  const el = row(runId).querySelector(`[data-column="${column}"]`);
  expect(el).not.toBeNull();
  return {
    text: (el?.textContent ?? '').trim(),
    known: el?.getAttribute('data-known') ?? '?',
  };
}

/** A synthetic run, for the states no importable file can produce. */
function synthetic(partial: Partial<Run> & { runId: string }): Run {
  return {
    threadId: 't_live',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    redacted: [],
    ...partial,
  };
}

describe('Runs — empty', () => {
  it('says there is no capture rather than rendering an empty table', () => {
    renderTab(initialPanelState());

    expect(screen.getByRole('region', { name: 'Runs' })).toBeTruthy();
    expect(screen.getByText(/no runs to show/i)).toBeTruthy();
    // A header row over nothing is a table that looks broken rather than empty.
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Runs — the table (R1)', () => {
  it('renders one row per run, in capture order', () => {
    renderTab(imported('edge'));

    expect(rowIds()).toEqual(['r_alpha', 'r_beta', 'r_gamma', '__orphaned__']);
  });

  it('heads the table with §9.2’s columns', () => {
    renderTab(imported('edge'));

    expect(
      screen.getAllByRole('columnheader').map((el) => (el.textContent ?? '').trim()),
    ).toEqual(['Run', 'Thread', 'Agent', 'Outcome', 'Duration', 'TTFT', 'Events', 'Issues']);
  });

  it('reports every column of a finished run from what core measured', () => {
    renderTab(imported('edge'));

    expect(cell('r_alpha', 'thread')).toEqual({ text: 't_alpha', known: 'true' });
    expect(cell('r_alpha', 'agent')).toEqual({ text: 'weather-agent', known: 'true' });
    expect(cell('r_alpha', 'outcome')).toEqual({ text: 'finished', known: 'true' });
    expect(cell('r_alpha', 'duration')).toEqual({ text: '200ms', known: 'true' });
    expect(cell('r_alpha', 'ttft')).toEqual({ text: '140ms', known: 'true' });
    expect(cell('r_alpha', 'events')).toEqual({ text: '5', known: 'true' });
    expect(cell('r_alpha', 'issues')).toEqual({ text: '0', known: 'true' });
  });

  it('marks the cells whose value is not known, rather than printing a number', () => {
    renderTab(imported('edge'));

    // r_beta ran tools and never emitted a token: TTFT is not 0ms, it does not exist.
    expect(cell('r_beta', 'agent').known).toBe('false');
    expect(cell('r_beta', 'ttft')).toEqual({ text: 'no text', known: 'false' });
    expect(cell('r_beta', 'duration')).toEqual({ text: '120ms', known: 'true' });
  });

  it('renders an orphaned run as one, rather than as a run with a zero duration', () => {
    renderTab(imported('edge'));

    expect(cell('__orphaned__', 'outcome').text).toBe('orphaned');
    expect(cell('__orphaned__', 'thread').known).toBe('false');
    expect(cell('__orphaned__', 'duration')).toEqual({ text: 'no run start', known: 'false' });
    expect(cell('__orphaned__', 'ttft').known).toBe('false');
    expect(cell('__orphaned__', 'issues').text).toBe('2');
  });

  /**
   * `running` is only ever reachable live: the import path closes every connection, which turns
   * an unterminated run into `aborted`. So this is the one §8 state that has to be constructed.
   */
  it('renders a run that is still going as still going', () => {
    renderTab({
      ...initialPanelState(),
      source: { kind: 'live', origin: 'http://localhost:3000' },
      runs: [synthetic({ runId: 'r_live', recordSeqs: [1, 2] })],
    });

    expect(cell('r_live', 'outcome').text).toBe('running');
    expect(cell('r_live', 'duration')).toEqual({ text: 'still running', known: 'false' });
    expect(cell('r_live', 'ttft').known).toBe('false');
    expect(cell('r_live', 'events').text).toBe('2');
  });

  it('tones a row by the worst issue it carries, so an error is not hidden by a warning', () => {
    renderTab(imported('edge'));

    // r_gamma: run-never-terminated (error) beside unclosed-message (warning).
    expect(cell('r_gamma', 'issues').text).toBe('2');
    expect(row('r_gamma').querySelector('[data-column="issues"]')?.getAttribute('data-tone')).toBe(
      'error',
    );
    expect(row('r_alpha').querySelector('[data-column="issues"]')?.getAttribute('data-tone')).toBe(
      'none',
    );
  });

  it('names the whole row, absences included, for a reader who hears one control', () => {
    renderTab(imported('edge'));

    const label = row('r_beta').getAttribute('aria-label') ?? '';
    expect(label).toContain('r_beta');
    expect(label).toContain('error');
    expect(label).toMatch(/no text/i);
    expect(label).toContain('1 issue');
  });
});

describe('Runs — click-through to Timeline (R2)', () => {
  it('scopes to the run, lands on its first frame, and switches to Timeline', () => {
    const store = renderTab(imported('edge'));

    fireEvent.click(row('r_gamma'));

    expect(store.get().scope).toBe('r_gamma');
    expect(store.get().selectedSeq).toBe(11);
    expect(store.get().tab).toBe('timeline');
  });

  it('scopes without selecting when the run has no records to land on', () => {
    const store = renderTab({
      ...initialPanelState(),
      runs: [synthetic({ runId: 'r_empty', recordSeqs: [] })],
    });

    fireEvent.click(row('r_empty'));

    expect(store.get().scope).toBe('r_empty');
    expect(store.get().selectedSeq).toBeNull();
    expect(store.get().tab).toBe('timeline');
  });

  /*
   * The tab whose job is choosing a run must show the choices. State and Messages filter
   * themselves to the shell's scope; a Runs table that did the same would answer "which runs are
   * there?" with the one the user already picked, and R2 makes this table the scope picker.
   */
  it('keeps listing every run under a scope, marking the one in force', () => {
    renderTab({ ...imported('edge'), scope: 'r_beta' });

    expect(rowIds()).toEqual(['r_alpha', 'r_beta', 'r_gamma', '__orphaned__']);
    expect(row('r_beta').getAttribute('aria-current')).toBe('true');
    expect(row('r_alpha').getAttribute('aria-current')).toBeNull();
  });
});

describe('Runs — virtualization (R3)', () => {
  const many = Array.from({ length: 300 }, (_, i) =>
    synthetic({ runId: `r_${String(i)}`, outcome: 'finished', recordSeqs: [i] }),
  );

  it('windows a long capture instead of mounting every run', () => {
    renderTab({ ...initialPanelState(), runs: many });

    const mounted = rowIds();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(many.length);
    expect(mounted[0]).toBe('r_0');
  });

  it('keeps the sizer at the height of the whole capture, not of the window', () => {
    const { container } = render(
      <Runs store={createPanelStore({ ...initialPanelState(), runs: many })} />,
    );

    const sizer = container.querySelector('.agui-vlist__sizer');
    expect(sizer).not.toBeNull();
    // 300 rows worth of scroll, so the scrollbar describes the capture rather than the window.
    const height = Number.parseInt((sizer as HTMLElement).style.height, 10);
    expect(height).toBeGreaterThan(300 * 20);
  });

  /*
   * The shrink bug this component was warned about: a virtual list rendered blank when its item
   * count fell below the scroll position it was still holding. Clearing a capture does exactly
   * that, and a Runs tab that went blank after Clear would look like a broken tab.
   */
  it('still renders rows after the capture shrinks under a scrolled viewport', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: many });
    const { container } = render(<Runs store={store} />);

    const viewport = container.querySelector('.agui-vlist');
    expect(viewport).not.toBeNull();
    (viewport as HTMLElement).scrollTop = 4000;
    fireEvent.scroll(viewport as HTMLElement);

    act(() => {
      store.set({ ...store.get(), runs: many.slice(0, 3) });
    });

    expect(rowIds()).toEqual(['r_0', 'r_1', 'r_2']);
  });
});

describe('Runs — a redacted capture', () => {
  it('says the capture was redacted, on the tab and on every row it applies to', () => {
    renderTab(redacted('edge'));

    expect(screen.getByTestId('runs-redacted')).toBeTruthy();
    expect(row('r_alpha').getAttribute('data-redacted')).toBe('true');
    expect(row('r_alpha').getAttribute('aria-label')).toMatch(/redacted/i);
  });

  it('says nothing about redaction on a capture that was not redacted', () => {
    renderTab(imported('edge'));

    expect(screen.queryByTestId('runs-redacted')).toBeNull();
    expect(row('r_alpha').getAttribute('data-redacted')).toBe('false');
  });

  /*
   * Redaction removes evidence; it must never ADD a finding. The validator withdraws the one
   * claim redaction destroys the evidence for (`tool-args-not-json`), so the counts in this
   * table need no special case — but "needs no special case" is a claim, and this is the test
   * that makes it one rather than an assumption.
   */
  it('never reports more issues on a run than the capture it was redacted from', () => {
    const before = imported('edge').runs;
    const after = redacted('edge').runs;

    expect(after.map((run) => run.runId)).toEqual(before.map((run) => run.runId));
    for (const [index, run] of after.entries()) {
      expect(run.issues.length).toBeLessThanOrEqual(before[index]?.issues.length ?? -1);
    }
  });

  it('keeps a clean run clean through a redacted export', () => {
    renderTab(redacted('happy'));

    expect(cell('r_happy', 'issues')).toEqual({ text: '0', known: 'true' });
  });

  /** §11 keeps structure, ids, ordering and sizes, so every measurement in this table survives. */
  it('keeps the measurements redaction does not touch', () => {
    renderTab(redacted('edge'));

    expect(cell('r_alpha', 'duration')).toEqual({ text: '200ms', known: 'true' });
    expect(cell('r_alpha', 'ttft')).toEqual({ text: '140ms', known: 'true' });
    expect(cell('r_alpha', 'agent')).toEqual({ text: 'weather-agent', known: 'true' });
    expect(cell('r_alpha', 'events')).toEqual({ text: '5', known: 'true' });
  });
});
