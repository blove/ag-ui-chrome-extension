/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { Waterfall } from './waterfall';

function stateFrom(text: string): PanelState {
  const loaded = loadJsonl(text);
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function fixtureState(name: 'malformed' | 'happy'): PanelState {
  return stateFrom(name === 'malformed' ? malformedJsonl : happyJsonl);
}

/** A run whose message goes quiet for 3.18s — over the 2s default stall threshold. */
const STALLED_JSONL = [
  '{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/run","input":{}}',
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_s","runId":"r_s"}}',
  '{"kind":"event","connId":"c1","seq":2,"tMs":10,"event":{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}}',
  '{"kind":"event","connId":"c1","seq":3,"tMs":20,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"a"}}',
  '{"kind":"event","connId":"c1","seq":4,"tMs":3200,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"b"}}',
  '{"kind":"event","connId":"c1","seq":5,"tMs":3210,"event":{"type":"TEXT_MESSAGE_END","messageId":"m_1"}}',
  '{"kind":"event","connId":"c1","seq":6,"tMs":3220,"event":{"type":"RUN_FINISHED","threadId":"t_s","runId":"r_s"}}',
  '',
].join('\n');

describe('Waterfall', () => {
  it('charts a run bar, a message bar and a tool bar from the real run model', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^run r_happy · finished/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^message m_1 · text/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^tool get_weather/ })).toBeTruthy();
  });

  it('charts step bars', () => {
    const store = createPanelStore(fixtureState('malformed'));
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^step analyze 110ms/ })).toBeTruthy();
  });

  it('positions a bar proportionally within the charted span', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    // Span is 12ms..380ms. The tool starts at 110ms: (110 - 12) / 368 = 26.6%.
    const tool = screen.getByRole('button', { name: /^tool get_weather/ });
    expect(tool.style.left.startsWith('26.6')).toBe(true);
  });

  it('marks a stall inside the message it belongs to', () => {
    const store = createPanelStore(stateFrom(STALLED_JSONL));
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: 'stall 3.18s in m_1 · text' })).toBeTruthy();
  });

  it('selects the run’s first record when the run bar is clicked', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: /^run r_happy/ }));
    expect(store.get().selectedSeq).toBe(1);
  });

  it('selects the message’s first content event when a message bar is clicked', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: /^message m_1/ }));
    expect(store.get().selectedSeq).toBe(3);
  });

  it('selects the first record at or after a tool bar’s start, since tool calls carry no seqs', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: /^tool get_weather/ }));
    expect(store.get().selectedSeq).toBe(7);
  });

  it('marks the hovered bar and clears it on leave', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    const bar = screen.getByRole('button', { name: /^tool get_weather/ });
    fireEvent.mouseEnter(bar);
    expect(screen.getByRole('button', { name: /^tool get_weather/ }).dataset.hovered).toBe('true');
    fireEvent.mouseLeave(bar);
    expect(screen.getByRole('button', { name: /^tool get_weather/ }).dataset.hovered).toBe('false');
  });

  it('collapses to one summary line that expands on click', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed />);

    const toggle = screen.getByRole('button', { name: /^Waterfall · 1 run/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1 tool');
    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /^run r_happy/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Waterfall/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('charts only the scoped run when the scope bar names one', () => {
    const happy = fixtureState('happy');
    const malformed = fixtureState('malformed');
    const both: PanelState = {
      ...happy,
      runs: [...happy.runs, ...malformed.runs],
      records: [...happy.records, ...malformed.records],
      scope: 'r_bad',
    };
    const store = createPanelStore(both);
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^run r_bad/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();
  });

  it('charts every run when the scope is all runs', () => {
    const happy = fixtureState('happy');
    const malformed = fixtureState('malformed');
    const store = createPanelStore({
      ...happy,
      runs: [...happy.runs, ...malformed.runs],
      records: [...happy.records, ...malformed.records],
      scope: null,
    });
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^run r_happy/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^run r_bad/ })).toBeTruthy();
  });

  it('charts nothing for an unknown scope id, as the event list already does', () => {
    // `visibleRecords` treats an unknown scope as "nothing rather than everything". Charting
    // every run here instead would put a full waterfall above an empty event list.
    const store = createPanelStore({ ...fixtureState('happy'), scope: 'r_nope' });
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();
    expect(screen.getByText('No runs to chart.')).toBeTruthy();
  });

  it('says there is nothing to chart rather than rendering an empty strip', () => {
    const store = createPanelStore(initialPanelState());
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByText('No runs to chart.')).toBeTruthy();
  });

  it('reports the locate to its host as well as writing the store', () => {
    const store = createPanelStore(fixtureState('happy'));
    const located: number[] = [];
    render(
      <Waterfall
        store={store}
        collapsed={false}
        onLocate={(seq) => {
          located.push(seq);
        }}
      />,
    );

    const bar = screen.getByRole('button', { name: /^tool get_weather/ });
    fireEvent.click(bar);
    fireEvent.click(bar);
    // The same seq twice is a real request — clicking the same bar again after scrolling away
    // must reach the host, which `selectedSeq` alone cannot express.
    expect(located).toEqual([7, 7]);
  });
});
