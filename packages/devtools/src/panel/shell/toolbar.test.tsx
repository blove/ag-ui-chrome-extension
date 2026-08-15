import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import type { CaptureRecord, Issue } from '../../core/model/types';
import { makeIssue } from '../../core/model/types';
import { initialPanelState } from '../model/panel-types';
import type { PanelState } from '../model/panel-types';
import { createPanelStore, toggleIssuesOnly } from '../model/store';
import { Toolbar } from './toolbar';

function record(seq: number, issues: Issue[] = []): CaptureRecord {
  return {
    kind: 'event',
    seq,
    tMs: seq,
    connId: 'c_1',
    raw: { type: 'RUN_STARTED' },
    event: { type: 'RUN_STARTED' },
    issues,
  };
}

function stateWith(over: Partial<PanelState>): PanelState {
  return { ...initialPanelState(), ...over };
}

const ERROR_ISSUE = makeIssue('event-after-terminal', 'late event', 7, { runId: 'r_1' });
const WARNING_ISSUE = makeIssue('unclosed-message', 'message left open', 8, { runId: 'r_1' });
const INFO_ISSUE = makeIssue('keepalive-gap', 'gap of 31s', 9, { runId: 'r_2' });

function badge(): HTMLElement {
  return screen.getByRole('button', { name: /events with issues/ });
}

describe('Toolbar issue badge', () => {
  it('shows the total for the current scope, not the whole capture', () => {
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE, INFO_ISSUE], scope: 'r_1' }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().textContent).toContain('2 issues');
    expect(badge().getAttribute('aria-label')).toContain('2 issues: 1 error, 1 warning, 0 info');
  });

  it('counts every issue when the scope is all runs', () => {
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE, INFO_ISSUE], scope: null }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().textContent).toContain('3 issues');
  });

  it('uses the danger tone only when an error is present', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('error');
  });

  it('uses the warning tone when only warnings are present', () => {
    const store = createPanelStore(stateWith({ issues: [WARNING_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('warning');
  });

  it('stays neutral for an info-only count', () => {
    const store = createPanelStore(stateWith({ issues: [INFO_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('none');
    expect(badge().textContent).toContain('1 issue');
  });

  it('is neutral and reads as zero when there are no issues', () => {
    const store = createPanelStore(stateWith({ records: [record(1)] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('none');
    expect(badge().textContent).toContain('0 issues');
    expect(badge().getAttribute('aria-label')).toContain('0 issues');
  });

  it('toggles filter.issuesOnly when clicked', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    fireEvent.click(badge());
    expect(store.get().filter.issuesOnly).toBe(true);

    fireEvent.click(badge());
    expect(store.get().filter.issuesOnly).toBe(false);
  });

  it('is a pressed button that says it is filtering, so a filtered list cannot look clean', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('aria-pressed')).toBe('false');
    expect(badge().textContent).not.toContain('filtered');

    fireEvent.click(badge());

    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge().textContent).toContain('filtered');
    expect(badge().getAttribute('aria-label')).toContain('filtered to events with issues');
  });

  it('counts issues in scope rather than the rows the filter can show', () => {
    // A `keepalive-gap` issue carries a runId, so it counts under a run scope — but a keepalive
    // never enters `Run.recordSeqs`, so its row can never appear in the scoped list. The badge is
    // a count of issues, and its name must not promise otherwise.
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE], scope: 'r_1' }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    const label = badge().getAttribute('aria-label') ?? '';
    expect(label).toContain('in the current run scope');
    expect(label).not.toMatch(/\d+ (rows|events) shown/);
  });

  it('says the count is scoped to the run only when a run is actually scoped', () => {
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE, INFO_ISSUE], scope: 'r_1' }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    const label = badge().getAttribute('aria-label') ?? '';
    expect(label).toContain('2 issues: 1 error, 1 warning, 0 info detected in the current run scope');
    expect(label).not.toContain('across all runs');
  });

  it('says the count spans every run when the scope is all runs', () => {
    // The all-runs count is the whole capture's. Calling it "the current run scope" would read as
    // a subset and let someone under-read a total.
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE, INFO_ISSUE], scope: null }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    const label = badge().getAttribute('aria-label') ?? '';
    expect(label).toContain('3 issues: 1 error, 1 warning, 1 info detected across all runs');
    expect(label).not.toContain('in the current run scope');
  });

  it('reflects the filter being toggled from elsewhere', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    act(() => {
      store.update(toggleIssuesOnly);
    });

    expect(badge().getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Toolbar controls', () => {
  it('offers record as an inert control while capture is off', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Record' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // Not `state.recording`, which is true from the start: with capture off nothing is being
    // recorded, and a pressed-looking Record button would say otherwise.
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toMatch(/enable capture for this origin first/i);
  });

  it('offers preserve-on-navigate as an inert control while capture is off', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Preserve log on navigate' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('activates record once capture is on, and reports the pause through the host', () => {
    const store = createPanelStore(
      stateWith({
        capture: { kind: 'on', origin: 'http://localhost:3000' },
        source: { kind: 'live', origin: 'http://localhost:3000' },
      }),
    );
    const onSetRecording = vi.fn();
    render(<Toolbar store={store} onImport={() => undefined} onSetRecording={onSetRecording} />);

    const button = screen.getByRole('button', { name: 'Pause' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(button);
    // Not a store action: pausing has to reach the service worker as well as the state.
    expect(onSetRecording).toHaveBeenCalledWith(false);
  });

  it('activates preserve-on-navigate once capture is on, and toggles it in the store', () => {
    const store = createPanelStore(
      stateWith({
        capture: { kind: 'on', origin: 'http://localhost:3000' },
        source: { kind: 'live', origin: 'http://localhost:3000' },
      }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Preserve log on navigate' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(store.get().preserveLog).toBe(true);
  });

  it('tells the host to clear the worker buffer too, and keeps a live source', () => {
    const store = createPanelStore(
      stateWith({
        capture: { kind: 'on', origin: 'http://localhost:3000' },
        source: { kind: 'live', origin: 'http://localhost:3000' },
        records: [record(1)],
        preserveLog: true,
      }),
    );
    const onClear = vi.fn();
    render(<Toolbar store={store} onImport={() => undefined} onClear={onClear} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onClear).toHaveBeenCalledTimes(1);
    const after = store.get();
    expect(after.records).toEqual([]);
    // The live source, the capture status and the session's settings describe the inspected
    // page, not the data being discarded.
    expect(after.source).toEqual({ kind: 'live', origin: 'http://localhost:3000' });
    expect(after.preserveLog).toBe(true);
  });

  it('disables clear when there is nothing to clear', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears the loaded capture but keeps the capture status', () => {
    const store = createPanelStore(
      stateWith({
        source: { kind: 'imported', filename: 'happy-run.agui.jsonl', importedAtMs: 5 },
        capture: { kind: 'off', origin: 'https://example.test', signal: { level: 'stream' } },
        records: [record(1)],
        issues: [ERROR_ISSUE],
        scope: 'r_1',
        selectedSeq: 1,
      }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    const after = store.get();
    expect(after.records).toEqual([]);
    expect(after.issues).toEqual([]);
    expect(after.runs).toEqual([]);
    expect(after.scope).toBeNull();
    expect(after.selectedSeq).toBeNull();
    expect(after.source).toEqual({ kind: 'empty' });
    expect(after.capture).toEqual({
      kind: 'off',
      origin: 'https://example.test',
      signal: { level: 'stream' },
    });
  });

  it('toggles expand-chunks through the store', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Expand chunks' });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);

    expect(store.get().expandChunks).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('drives the text filter and shows the text already applied', () => {
    const store = createPanelStore(stateWith({ filter: { text: 'tool', issuesOnly: false } }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    const input = screen.getByRole('searchbox', { name: 'Filter events' }) as HTMLInputElement;
    expect(input.value).toBe('tool');

    fireEvent.input(input, { target: { value: 'RUN_ERROR' } });

    expect(store.get().filter.text).toBe('RUN_ERROR');
  });

  it('asks the host to import', () => {
    const onImport = vi.fn();
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={onImport} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('surfaces evicted events instead of dropping them silently', () => {
    const store = createPanelStore(stateWith({ droppedBefore: 12, records: [record(13)] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(screen.getByText('12 dropped')).toBeTruthy();
  });

  it('shows no dropped count when nothing was evicted', () => {
    const store = createPanelStore(stateWith({ records: [record(1)] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(screen.queryByText(/dropped/)).toBeNull();
  });
});
