/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import type { CaptureRecord } from '../../../core/model/types';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { visibleRecords } from '../../model/selectors';
import { EventDetail } from './event-detail';

function fixtureState(name: 'malformed' | 'happy'): PanelState {
  const loaded = loadJsonl(name === 'malformed' ? malformedJsonl : happyJsonl);
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    source: { kind: 'imported', filename: `${name}.agui.jsonl`, importedAtMs: 0 },
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function regionOrder(): string[] {
  return screen
    .getAllByRole('region')
    .map((region) => region.getAttribute('aria-label') ?? '')
    .filter((label) => label !== '');
}

describe('EventDetail', () => {
  it('asks for a selection when there is none', () => {
    const store = createPanelStore(fixtureState('malformed'));
    render(<EventDetail store={store} />);

    expect(screen.getByText('Select an event to see its detail.')).toBeTruthy();
  });

  it('puts the verdict above the payload and the raw toggle below both', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 9 });
    render(<EventDetail store={store} />);

    expect(regionOrder()).toEqual(['Event detail', 'Verdict', 'Payload', 'Raw frame']);
  });

  it('names the code, the severity, and the failing op index and reason for a failed patch', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 9 });
    render(<EventDetail store={store} />);

    const verdict = screen.getByRole('region', { name: 'Verdict' });
    expect(within(verdict).getByText('state-patch-failed')).toBeTruthy();
    expect(within(verdict).getByText('error')).toBeTruthy();
    // `opIndex` is on the Issue; `reason` is only on the delta arm of `StateFrame`. The
    // fixture adds /missing/child, so the parent — not the path itself — is what is missing.
    expect(within(verdict).getByText('operation index').nextElementSibling?.textContent).toBe('0');
    expect(within(verdict).getByText('reason').nextElementSibling?.textContent).toBe(
      'parent-not-found',
    );
    expect(within(verdict).getByText('path').nextElementSibling?.textContent).toBe('/missing/child');
  });

  it('renders a verdict with no patch detail for an issue that is not a patch failure', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 5 });
    render(<EventDetail store={store} />);

    const verdict = screen.getByRole('region', { name: 'Verdict' });
    expect(within(verdict).getByText('empty-text-delta')).toBeTruthy();
    expect(within(verdict).queryByText('operation index')).toBeNull();
  });

  it('shows no verdict region at all for a clean event', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 4 });
    render(<EventDetail store={store} />);

    expect(regionOrder()).toEqual(['Event detail', 'Payload', 'Raw frame']);
  });

  it('decodes the payload field by field', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 4 });
    render(<EventDetail store={store} />);

    const payload = within(screen.getByRole('region', { name: 'Payload' }));
    expect(payload.getByText('type').nextElementSibling?.textContent).toBe('TEXT_MESSAGE_CONTENT');
    expect(payload.getByText('messageId').nextElementSibling?.textContent).toBe('m_1');
    expect(payload.getByText('delta').nextElementSibling?.textContent).toBe('Let me check that');
  });

  it('toggles the raw frame exactly as received', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 9 });
    render(<EventDetail store={store} />);

    const toggle = screen.getByRole('button', { name: 'raw' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'raw' }).getAttribute('aria-expanded')).toBe('true');
    const raw = screen.getByRole('region', { name: 'Raw frame' });
    expect(raw.textContent).toContain('"path": "/missing/child"');
  });

  it('renders a keepalive record without reaching for an event', () => {
    const store = createPanelStore({ ...fixtureState('happy'), selectedSeq: 11 });
    render(<EventDetail store={store} />);

    const payload = within(screen.getByRole('region', { name: 'Payload' }));
    expect(payload.getByText('kind').nextElementSibling?.textContent).toBe('keepalive');
    expect(payload.getByText('comment').nextElementSibling?.textContent).toBe('ping');
  });

  it('still renders a selection the active filter has dropped from the list', () => {
    // `setTextFilter` and `toggleIssuesOnly` deliberately leave `selectedSeq` alone — losing the
    // selection mid-keystroke is worse than keeping it — so `selectedRecord` routinely names a
    // record `visibleRecords` no longer contains. The pane must not go blank on it.
    const store = createPanelStore({
      ...fixtureState('malformed'),
      selectedSeq: 9,
      filter: { text: 'no-such-event', issuesOnly: false },
    });
    render(<EventDetail store={store} />);

    expect(visibleRecords(store.get())).toEqual([]);
    expect(screen.queryByText('Select an event to see its detail.')).toBeNull();
    expect(regionOrder()).toEqual(['Event detail', 'Verdict', 'Payload', 'Raw frame']);
    expect(
      within(screen.getByRole('region', { name: 'Verdict' })).getByText('state-patch-failed'),
    ).toBeTruthy();
  });

  it('renders an undecodable event record and still offers its raw bytes', () => {
    const records: CaptureRecord[] = [
      { kind: 'event', seq: 7, tMs: 40, connId: 'c1', raw: 'data: {oops', event: null, issues: [] },
    ];
    const store = createPanelStore({ ...initialPanelState(), records, selectedSeq: 7 });
    render(<EventDetail store={store} />);

    expect(
      screen.getByText(
        'This frame could not be decoded into an event. The bytes are under raw, below.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'raw' }));
    expect(screen.getByRole('region', { name: 'Raw frame' }).textContent).toContain('data: {oops');
  });
});
