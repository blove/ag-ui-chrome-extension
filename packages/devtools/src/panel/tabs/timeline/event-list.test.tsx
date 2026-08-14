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
  return screen.getByRole('option', { name }).getAttribute('data-severity');
}

describe('EventList', () => {
  it('renders one row per record, labelled by seq and not by array index', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.textContent).toContain('RUN_STARTED');
    expect(rows[0]?.textContent?.startsWith('1')).toBe(true);
    expect(rows[9]?.textContent?.startsWith('10')).toBe(true);
  });

  it('keeps the gutter on seq when a filter drops earlier rows', () => {
    const state = malformedState();
    const store = createPanelStore({ ...state, filter: { text: '', issuesOnly: true } });
    render(<EventList store={store} />);

    const rows = screen.getAllByRole('option');
    expect(rows.map((row) => row.textContent?.match(/^\d+/)?.[0])).toEqual(['5', '9', '10']);
  });

  it('tints rows that carry an issue with the issue severity and names the code', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    expect(severityOf(/empty-text-delta/)).toBe('error');
    expect(severityOf(/state-patch-failed/)).toBe('error');
    expect(severityOf(/run-never-terminated/)).toBe('error');
    expect(severityOf(/^seq 1 RUN_STARTED/)).toBeNull();

    // Exactly three of the ten rows are annotated, and at the seqs the fixture's issues name.
    // Asserted against the unfiltered list so a stray tint on a clean row cannot hide behind
    // the issues-only filter, which would drop that row before it could be counted.
    const annotated = screen
      .getAllByRole('option')
      .filter((row) => row.getAttribute('data-severity') !== null);
    expect(annotated.map((row) => row.textContent?.match(/^\d+/)?.[0])).toEqual(['5', '9', '10']);
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

  it('selects the clicked row by seq and marks it selected', () => {
    const store = createPanelStore(malformedState());
    const { rerender } = render(<EventList store={store} />);

    fireEvent.click(screen.getByRole('option', { name: /state-patch-failed/ }));
    expect(store.get().selectedSeq).toBe(9);

    rerender(<EventList store={store} />);
    const selected = screen.getAllByRole('option', { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent?.startsWith('9')).toBe(true);
  });

  it('says so plainly when the filter matches nothing', () => {
    const store = createPanelStore({
      ...malformedState(),
      filter: { text: 'no-such-event', issuesOnly: false },
    });
    render(<EventList store={store} />);

    expect(screen.getByText('No events match the current filter.')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
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

    expect(screen.getByRole('option', { name: /keepalive/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /unparsed/ })).toBeTruthy();
  });
});

/**
 * The list is virtualized, so of 5002 rows only ~26 are ever in the DOM. A row that is not
 * mounted is not in the accessibility tree and cannot be tabbed to, which left a keyboard-only
 * user with no route at all to row 3000 — not a slow route, none. These tests hold the listbox
 * contract that replaces the tab-stop-per-row model: one tab stop, arrows for the rest, and a
 * window that follows the selection into the DOM.
 */
describe('EventList keyboard navigation', () => {
  const BIG_COUNT = 5002;

  function bigState(): PanelState {
    const records: CaptureRecord[] = Array.from({ length: BIG_COUNT }, (_, i) => ({
      kind: 'event',
      seq: i + 1,
      tMs: i,
      connId: 'c1',
      raw: { type: 'CUSTOM' },
      event: { type: 'CUSTOM', name: `n${i + 1}` },
      issues: [],
    }));
    return { ...initialPanelState(), records };
  }

  function list(): HTMLElement {
    return screen.getByRole('listbox', { name: 'Event list' });
  }

  function press(key: string, times = 1): void {
    for (let i = 0; i < times; i += 1) fireEvent.keyDown(list(), { key });
  }

  function tabStops(): (string | undefined)[] {
    return screen
      .getAllByRole('option')
      .filter((row) => row.getAttribute('tabindex') === '0')
      .map((row) => row.getAttribute('data-seq') ?? undefined);
  }

  it('exposes exactly one tab stop, so the list is one Tab away and not 5002', () => {
    const store = createPanelStore(bigState());
    render(<EventList store={store} />);

    expect(screen.getAllByRole('option').length).toBeLessThan(40);
    expect(tabStops()).toEqual(['1']);
  });

  it('selects the first row on the first ArrowDown rather than skipping it', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    press('ArrowDown');

    expect(store.get().selectedSeq).toBe(1);
  });

  it('moves the selection down and up, and moves focus with it', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    press('ArrowDown', 3);
    expect(store.get().selectedSeq).toBe(3);
    expect(document.activeElement?.getAttribute('data-seq')).toBe('3');

    press('ArrowUp');
    expect(store.get().selectedSeq).toBe(2);
    expect(document.activeElement?.getAttribute('data-seq')).toBe('2');
    expect(tabStops()).toEqual(['2']);
  });

  it('does not run off either end of the list', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    press('ArrowUp', 4);
    expect(store.get().selectedSeq).toBe(1);

    press('ArrowDown', 40);
    expect(store.get().selectedSeq).toBe(10);
  });

  it('leaves keys it does not own to the rest of the panel', () => {
    const store = createPanelStore({ ...malformedState(), selectedSeq: 5 });
    render(<EventList store={store} />);

    press('a');
    press('PageDown');

    expect(store.get().selectedSeq).toBe(5);
  });

  it('reaches row 5002 of 5002 with End and brings it into the DOM to be focused', () => {
    // The property that was broken: before this, row 5002 existed in no DOM a keyboard could
    // reach. `queryByRole` first, to prove it really is outside the initial window.
    const store = createPanelStore(bigState());
    render(<EventList store={store} />);

    expect(screen.queryByRole('option', { name: /^seq 5002 / })).toBeNull();

    press('End');

    expect(store.get().selectedSeq).toBe(BIG_COUNT);
    expect(screen.getByRole('option', { name: /^seq 5002 / })).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-seq')).toBe('5002');
    expect(tabStops()).toEqual(['5002']);
  });

  it('returns to row 1 with Home from the far end of a 5002-row list', () => {
    const store = createPanelStore(bigState());
    render(<EventList store={store} />);

    press('End');
    expect(screen.queryByRole('option', { name: /^seq 1 / })).toBeNull();

    press('Home');

    expect(store.get().selectedSeq).toBe(1);
    expect(screen.getByRole('option', { name: /^seq 1 / })).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-seq')).toBe('1');
  });

  it('keeps arrowing from a distant row, mounting each next row as it goes', () => {
    // Arrow keys always move to a *different* index, which is why `VirtualList` refusing to
    // re-scroll for a repeated index is harmless here.
    const store = createPanelStore(bigState());
    render(<EventList store={store} />);

    press('End');
    press('ArrowUp', 30);

    expect(store.get().selectedSeq).toBe(BIG_COUNT - 30);
    expect(document.activeElement?.getAttribute('data-seq')).toBe(String(BIG_COUNT - 30));
  });

  it('keeps a tab stop when the selection is filtered out of the visible rows', () => {
    // `selectedSeq` 1 survives the issues-only filter as state but has no row. Without the
    // fallback to row 0 the list would hold no tabbable row at all and drop out of the tab order.
    const store = createPanelStore({
      ...malformedState(),
      selectedSeq: 1,
      filter: { text: '', issuesOnly: true },
    });
    render(<EventList store={store} />);

    expect(tabStops()).toEqual(['5']);
  });
});
