import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/preact';
import type { CaptureRecord } from '../../../core/model/types';
import type { ThreadplaneDevtoolsReport } from '../../../core/signals/report';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore, type PanelStore } from '../../model/store';
import { Signals, SIGNALS_EMPTY_TEXT } from './signals';

const FAULT_WORDS =
  /\b(not detected|detection|failed|failure|error|unable|could not|missing|broken|none found|no agents)\b/i;

function record(seq: number, type: string, tMs = seq * 10): CaptureRecord {
  return { kind: 'event', seq, tMs, connId: 'c1', raw: '', issues: [], event: { type } };
}

function report(seq: number, eventType: string, wrote: string[], agent = 'a1b2c3d4-agent'): ThreadplaneDevtoolsReport {
  return { v: 1, agent, adapter: 'ag-ui', seq, eventType, wrote, tMs: seq * 10 + 1 };
}

function live(reports: ThreadplaneDevtoolsReport[], records: CaptureRecord[] = []): PanelState {
  return {
    ...initialPanelState(),
    source: { kind: 'live', origin: 'http://localhost:5173' },
    tab: 'signals',
    records,
    signals: { reports, droppedBefore: 0 },
  };
}

function renderTab(state: PanelState): PanelStore {
  const store = createPanelStore(state);
  render(<Signals store={store} />);
  return store;
}

describe('Signals tab', () => {
  it('says exactly what G7 says when there are no reports, with no fault words', () => {
    renderTab(live([]));
    const empty = screen.getByText(SIGNALS_EMPTY_TEXT);
    expect(SIGNALS_EMPTY_TEXT).toBe(
      'No Threadplane devtools events on this page — the Signals view needs a Threadplane app in development mode, version 0.3.0 or later.',
    );
    expect(FAULT_WORDS.exec(empty.closest('section')?.textContent ?? '')).toBeNull();
  });

  it('notes that an imported capture carries none (G8)', () => {
    renderTab({ ...initialPanelState(), source: { kind: 'imported', filename: 'x.agui.jsonl', importedAtMs: 1 } });
    expect(screen.getByText(SIGNALS_EMPTY_TEXT)).toBeTruthy();
    expect(screen.getByText(/live only/i)).toBeTruthy();
  });

  it('draws one block per agent, headed by adapter, short id and report count', () => {
    renderTab(
      live([
        report(1, 'RUN_STARTED', ['status', 'isLoading']),
        report(2, 'TEXT_MESSAGE_CONTENT', ['messages']),
        { ...report(1, 'values', ['values']), agent: 'ffffeeee-2', adapter: 'langgraph' },
      ]),
    );
    const blocks = screen.getAllByRole('table');
    expect(blocks).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'AG-UI · agent a1b2c3d4 · 2 events' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'LangGraph · agent ffffeeee · 1 event' })).toBeTruthy();
  });

  it('rows in vocabulary order, eventType column headers with a title, lit cells where written', () => {
    renderTab(
      live([
        report(1, 'RUN_STARTED', ['isLoading', 'status']),
        report(2, 'TEXT_MESSAGE_CONTENT', ['messages']),
      ]),
    );
    const table = screen.getByRole('table');
    const rowHeads = within(table).getAllByRole('rowheader').map((el) => el.textContent);
    expect(rowHeads).toEqual(['messages', 'status', 'isLoading']);

    const columns = within(table).getAllByRole('button');
    expect(columns.map((el) => el.textContent)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_CONTENT']);
    expect(columns[0]?.getAttribute('title')).toContain('RUN_STARTED');

    const lit = table.querySelectorAll('[data-lit="true"]');
    expect(lit).toHaveLength(3);
    const messagesRow = within(table).getByRole('rowheader', { name: 'messages' }).closest('tr');
    const cells = messagesRow?.querySelectorAll('td') ?? [];
    expect([...cells].map((td) => td.getAttribute('data-lit'))).toEqual(['false', 'true']);
  });

  it('clicking a column selects the matched frame in Timeline and switches tab', () => {
    const store = renderTab(
      live(
        [report(1, 'RUN_STARTED', ['status']), report(2, 'TEXT_MESSAGE_CONTENT', ['messages'])],
        [record(7, 'RUN_STARTED'), record(8, 'TEXT_MESSAGE_CONTENT')],
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /TEXT_MESSAGE_CONTENT/ }));
    expect(store.get().selectedSeq).toBe(8);
    expect(store.get().tab).toBe('timeline');
  });

  it('drops a run scope that does not hold the matched frame, so the selection is visible', () => {
    const store = renderTab({
      ...live([report(1, 'RUN_STARTED', ['status'])], [record(7, 'RUN_STARTED')]),
      scope: 'some-other-run',
    });
    fireEvent.click(screen.getByRole('button', { name: /RUN_STARTED/ }));
    expect(store.get().scope).toBeNull();
    expect(store.get().selectedSeq).toBe(7);
  });

  it('says quietly that no frame matched, and stays on the tab', () => {
    const store = renderTab(live([report(1, 'run:start', ['status'])], [record(7, 'RUN_STARTED')]));
    fireEvent.click(screen.getByRole('button', { name: /run:start/ }));
    expect(store.get().tab).toBe('signals');
    expect(store.get().selectedSeq).toBeNull();
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/no matching frame/i);
    expect(FAULT_WORDS.exec(status.textContent ?? '')).toBeNull();
  });

  it('says how many were not drawn when a block is capped', () => {
    const reports = Array.from({ length: 503 }, (_, i) => report(i + 1, 'TEXT_MESSAGE_CONTENT', ['messages']));
    renderTab(live(reports));
    expect(screen.getByText('Showing the last 500 of 503 events.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(500);
  });

  it('says when earlier reports were evicted (P9)', () => {
    renderTab({ ...live([report(5, 'X', ['status'])]), signals: { reports: [report(5, 'X', ['status'])], droppedBefore: 4 } });
    expect(screen.getByText(/4 earlier Threadplane events are no longer held/)).toBeTruthy();
  });
});
