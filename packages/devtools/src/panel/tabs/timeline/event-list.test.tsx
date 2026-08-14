/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import { makeIssue, type CaptureRecord } from '../../../core/model/types';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { EventList } from './event-list';

/** The malformed fixture produces exactly three issues, at seqs 5, 9 and 10. */
function malformedState(): PanelState {
  const loaded = loadJsonl(malformedJsonl);
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    source: { kind: 'imported', filename: 'malformed.agui.jsonl', importedAtMs: 0 },
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function severityOf(name: RegExp): string | null {
  return screen.getByRole('button', { name }).getAttribute('data-severity');
}

describe('EventList', () => {
  it('renders one row per record, labelled by seq and not by array index', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.textContent).toContain('RUN_STARTED');
    expect(rows[0]?.textContent?.startsWith('1')).toBe(true);
    expect(rows[9]?.textContent?.startsWith('10')).toBe(true);
  });

  it('keeps the gutter on seq when a filter drops earlier rows', () => {
    const state = malformedState();
    const store = createPanelStore({ ...state, filter: { text: '', issuesOnly: true } });
    render(<EventList store={store} />);

    const rows = screen.getAllByRole('button');
    expect(rows.map((row) => row.textContent?.match(/^\d+/)?.[0])).toEqual(['5', '9', '10']);
  });

  it('tints rows that carry an issue with the issue severity and names the code', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    expect(severityOf(/empty-text-delta/)).toBe('error');
    expect(severityOf(/state-patch-failed/)).toBe('error');
    expect(severityOf(/run-never-terminated/)).toBe('error');
    expect(severityOf(/^seq 1 RUN_STARTED/)).toBeNull();
  });

  it('shows the worst severity when a seq carries more than one issue', () => {
    const state = malformedState();
    const store = createPanelStore({
      ...state,
      issues: [makeIssue('keepalive-gap', 'gap', 3), makeIssue('unknown-event-type', 'unknown', 3)],
    });
    render(<EventList store={store} />);

    // warning (unknown-event-type) outranks info (keepalive-gap).
    expect(severityOf(/keepalive-gap/)).toBe('warning');
  });

  it('selects the clicked row by seq and marks it pressed', () => {
    const store = createPanelStore(malformedState());
    const { rerender } = render(<EventList store={store} />);

    fireEvent.click(screen.getByRole('button', { name: /state-patch-failed/ }));
    expect(store.get().selectedSeq).toBe(9);

    rerender(<EventList store={store} />);
    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent?.startsWith('9')).toBe(true);
  });

  it('says so plainly when the filter matches nothing', () => {
    const store = createPanelStore({
      ...malformedState(),
      filter: { text: 'no-such-event', issuesOnly: false },
    });
    render(<EventList store={store} />);

    expect(screen.getByText('No events match the current filter.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders a keepalive row and an undecodable row without touching a missing event', () => {
    const records: CaptureRecord[] = [
      {
        kind: 'keepalive',
        seq: 1,
        tMs: 0,
        connId: 'c1',
        raw: ':ping\n\n',
        comment: 'ping',
        issues: [],
      },
      { kind: 'event', seq: 2, tMs: 10, connId: 'c1', raw: '{oops', event: null, issues: [] },
    ];
    const store = createPanelStore({ ...initialPanelState(), records });
    render(<EventList store={store} />);

    expect(screen.getByRole('button', { name: /keepalive/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /unparsed/ })).toBeTruthy();
  });
});
