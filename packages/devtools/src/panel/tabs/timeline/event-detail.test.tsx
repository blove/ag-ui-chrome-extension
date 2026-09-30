/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import type { AguiEvent, CaptureRecord } from '../../../core/model/types';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { visibleRecords } from '../../model/selectors';
import { aiChunk, langGraphJsonl, type LangGraphTestFrame } from '../../../test/langgraph-capture';
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

function langGraphState(frames: readonly LangGraphTestFrame[], selectedSeq: number): PanelState {
  const loaded = loadJsonl(langGraphJsonl(frames));
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    source: { kind: 'imported', filename: 'lg.agui.jsonl', importedAtMs: 0 },
    runs: loaded.runs,
    records: loaded.records,
    requests: loaded.requests,
    issues: loaded.issues,
    selectedSeq,
  };
}

function derivedItems(): string[] {
  const derived = screen.getByRole('region', { name: 'Derived' });
  return within(derived)
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
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

  it('names a LangGraph frame by its SSE event name in the type field', () => {
    const records: CaptureRecord[] = [
      {
        kind: 'event',
        seq: 3,
        tMs: 5,
        connId: 'c1',
        raw: { messages: [] },
        event: { messages: [] } as unknown as AguiEvent,
        sseEvent: 'values',
        issues: [],
      },
    ];
    const store = createPanelStore({ ...initialPanelState(), records, selectedSeq: 3 });
    render(<EventDetail store={store} />);

    const payload = screen.getByRole('region', { name: 'Payload' });
    expect(within(payload).getByText('type').nextElementSibling?.textContent?.trim()).toBe('values');
  });

  it('shows a LangGraph array payload as the JSON it decoded to, not as undecodable', () => {
    render(
      <EventDetail
        store={createPanelStore(
          langGraphState([{ event: 'metadata', data: { run_id: 'r-1' } }, aiChunk('m1', 'Hi')], 2),
        )}
      />,
    );
    const payload = screen.getByRole('region', { name: 'Payload' });
    expect(within(payload).getByText('type').nextElementSibling?.textContent).toBe('messages');
    expect(payload.textContent).toContain('"type": "AIMessageChunk"');
    expect(payload.textContent).toContain('"langgraph_node": "agent"');
    expect(payload.textContent).not.toMatch(/could not/i);
  });

  it('still calls an unparseable LangGraph frame undecodable', () => {
    const records: CaptureRecord[] = [
      { kind: 'event', seq: 2, tMs: 5, connId: 'c1', raw: '[{oops', event: null, sseEvent: 'messages', issues: [] },
    ];
    const requests = [
      { connId: 'c1', tMs: 0, method: 'POST', url: 'http://localhost:2024/threads/t/runs/stream', input: {} },
    ];
    render(<EventDetail store={createPanelStore({ ...initialPanelState(), records, requests, selectedSeq: 2 })} />);
    expect(
      screen.getByText('This frame could not be decoded into an event. The bytes are under raw, below.'),
    ).toBeTruthy();
  });

  it('leaves a named AG-UI frame whose payload is not an object as undecodable, with no Derived', () => {
    // An AG-UI server may name its frames; the LangGraph reading of an array is for LangGraph only.
    const records: CaptureRecord[] = [
      { kind: 'event', seq: 1, tMs: 0, connId: 'c1', raw: { type: 'RUN_STARTED', runId: 'r', threadId: 't' }, event: { type: 'RUN_STARTED', runId: 'r', threadId: 't' }, sseEvent: 'RUN_STARTED', issues: [] },
      { kind: 'event', seq: 2, tMs: 5, connId: 'c1', raw: [{ delta: 'Hi' }], event: null, sseEvent: 'TEXT_MESSAGE_CONTENT', issues: [] },
    ];
    render(<EventDetail store={createPanelStore({ ...initialPanelState(), records, selectedSeq: 2 })} />);
    expect(
      screen.getByText('This frame could not be decoded into an event. The bytes are under raw, below.'),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Derived' })).toBeNull();
  });

  describe('Derived — what a LangGraph frame was read as (L14)', () => {
    const frames: LangGraphTestFrame[] = [
      { event: 'metadata', data: { run_id: 'r-1' } }, // seq 1
      aiChunk('m1', 'Hi'), // seq 2
      { event: 'messages/metadata', data: { m1: { metadata: {} } } }, // seq 3
      aiChunk('m1', 'x'.repeat(100)), // seq 4
      { event: 'values', data: { messages: [] } }, // seq 5
    ];

    it('sits between the payload and the raw frame', () => {
      render(<EventDetail store={createPanelStore(langGraphState(frames, 2))} />);
      expect(regionOrder()).toEqual(['Event detail', 'Payload', 'Derived', 'Raw frame']);
    });

    it('lists each synthetic event in order, with the id it acts on and its delta', () => {
      render(<EventDetail store={createPanelStore(langGraphState(frames, 2))} />);
      const derived = screen.getByRole('region', { name: 'Derived' });
      expect(derived.textContent).toContain(
        'Read as these AG-UI events — derived by the panel, not sent on the wire:',
      );
      expect(derivedItems()).toEqual(['TEXT_MESSAGE_START m1', 'TEXT_MESSAGE_CONTENT m1 "Hi"']);
    });

    it('truncates a long delta to 80 characters with an ellipsis', () => {
      render(<EventDetail store={createPanelStore(langGraphState(frames, 4))} />);
      expect(derivedItems()).toEqual([`TEXT_MESSAGE_CONTENT m1 "${'x'.repeat(79)}…"`]);
    });

    it('says so, without a fault word, when a frame was read as nothing', () => {
      render(<EventDetail store={createPanelStore(langGraphState(frames, 3))} />);
      const derived = screen.getByRole('region', { name: 'Derived' });
      expect(derived.textContent).toBe('Shown as it arrived — this frame is not read as any AG-UI event.');
      expect(derived.textContent).not.toMatch(
        /not detected|detection|failed|failure|error|unable|could not|missing|broken|none found|no agents/i,
      );
    });

    it('gathers what one frame caused on every run, in run order (S3)', () => {
      const state = langGraphState(
        [
          { event: 'metadata', data: { run_id: 'r-1' } }, // seq 1
          { ...aiChunk('s1', 'x'), event: 'messages|sub:1' }, // seq 2
          { event: 'error', data: { error: 'E', message: 'boom' } }, // seq 3
        ],
        3,
      );
      const [top, child] = state.runs;
      const expected = [...(top?.derived?.get(3) ?? []), ...(child?.derived?.get(3) ?? [])].map(
        (event) => event.type,
      );
      expect(child?.derived?.get(3)?.length).toBeGreaterThan(0);
      expect(top?.derived?.get(3)?.length).toBeGreaterThan(0);
      render(<EventDetail store={createPanelStore(state)} />);
      const items = derivedItems();
      expect(items.map((item) => item.split(' ')[0])).toEqual(expected);
      expect(items).toContain('TEXT_MESSAGE_END s1');
    });

    it('reads a join stream’s frames too, although their run was opened on another connection (S8)', () => {
      const first = langGraphJsonl([{ event: 'metadata', data: { run_id: 'r-1' } }, aiChunk('m1', 'Hel')]);
      const join = langGraphJsonl([aiChunk('m1', 'lo')], {
        connId: 'c2',
        method: 'GET',
        url: 'http://localhost:2024/threads/t-1/runs/r-1/stream',
        body: null,
        header: false,
        firstSeq: 3,
      });
      const loaded = loadJsonl(`${first}\n${join}`);
      expect(loaded.runs.map((run) => run.connId)).toEqual(['c1']);
      const store = createPanelStore({
        ...initialPanelState(),
        runs: loaded.runs,
        records: loaded.records,
        requests: loaded.requests,
        issues: loaded.issues,
        selectedSeq: 3,
      });
      render(<EventDetail store={store} />);
      expect(derivedItems()).toContain('TEXT_MESSAGE_CONTENT m1 "lo"');
    });

    it('shows no Derived region for an AG-UI record', () => {
      render(<EventDetail store={createPanelStore({ ...fixtureState('happy'), selectedSeq: 2 })} />);
      expect(regionOrder()).toEqual(['Event detail', 'Payload', 'Raw frame']);
      expect(screen.queryByRole('region', { name: 'Derived' })).toBeNull();
    });
  });
});
