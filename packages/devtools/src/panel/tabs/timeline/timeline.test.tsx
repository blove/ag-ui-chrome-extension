/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';

// `useIsNarrow` reads the viewport, which jsdom does not resize. Overriding just the hook keeps
// the test independent of how the hook measures, while `NARROW_BREAKPOINT_PX` stays the real one.
const narrow = { value: false };
vi.mock('../../common/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/layout')>();
  return { ...actual, useIsNarrow: () => narrow.value };
});

const { Timeline } = await import('./timeline');

function fixtureState(): PanelState {
  const loaded = loadJsonl(happyJsonl);
  return {
    ...initialPanelState(),
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

/**
 * A run long enough for the event list to actually scroll, with a second message far enough
 * down it that locating it moves the viewport. 150 content events on `m_1` push `m_2`'s first
 * content event to seq 155, well past the ~21 rows a 480px viewport holds.
 */
const LONG_RUN_CONTENT_EVENTS = 150;

function longRunJsonl(): string {
  const lines = [
    '{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/run","input":{}}',
    '{"kind":"event","connId":"c1","seq":1,"tMs":10,"event":{"type":"RUN_STARTED","threadId":"t_l","runId":"r_long"}}',
    '{"kind":"event","connId":"c1","seq":2,"tMs":20,"event":{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}}',
  ];
  for (let i = 0; i < LONG_RUN_CONTENT_EVENTS; i += 1) {
    const seq = 3 + i;
    lines.push(
      `{"kind":"event","connId":"c1","seq":${seq},"tMs":${seq * 10},"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"d${i}"}}`,
    );
  }
  const end = 3 + LONG_RUN_CONTENT_EVENTS;
  lines.push(
    `{"kind":"event","connId":"c1","seq":${end},"tMs":${end * 10},"event":{"type":"TEXT_MESSAGE_END","messageId":"m_1"}}`,
    `{"kind":"event","connId":"c1","seq":${end + 1},"tMs":${(end + 1) * 10},"event":{"type":"TEXT_MESSAGE_START","messageId":"m_2","role":"assistant"}}`,
    `{"kind":"event","connId":"c1","seq":${end + 2},"tMs":${(end + 2) * 10},"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_2","delta":"tail"}}`,
    `{"kind":"event","connId":"c1","seq":${end + 3},"tMs":${(end + 3) * 10},"event":{"type":"TEXT_MESSAGE_END","messageId":"m_2"}}`,
    `{"kind":"event","connId":"c1","seq":${end + 4},"tMs":${(end + 4) * 10},"event":{"type":"RUN_FINISHED","threadId":"t_l","runId":"r_long"}}`,
    '',
  );
  return lines.join('\n');
}

/** The seq of `m_2`'s only content event — what its waterfall bar points at. */
const M2_CONTENT_SEQ = 3 + LONG_RUN_CONTENT_EVENTS + 2;

function longRunState(): PanelState {
  const loaded = loadJsonl(longRunJsonl());
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function listViewport(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.agui-event-list .agui-vlist');
  if (el === null) throw new Error('the event list did not render');
  return el;
}

beforeEach(() => {
  narrow.value = false;
});

describe('Timeline', () => {
  it('composes the waterfall, the list and the detail pane', () => {
    const store = createPanelStore(fixtureState());
    render(<Timeline store={store} />);

    expect(screen.getByRole('region', { name: 'Waterfall' })).toBeTruthy();
    // A listbox, not a `group`: the list is virtualized, so it carries one tab stop and arrow
    // keys rather than a tab stop per row.
    expect(screen.getByRole('listbox', { name: 'Event list' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Event detail' })).toBeTruthy();
  });

  it('splits list and detail side by side above the narrow breakpoint', () => {
    const store = createPanelStore(fixtureState());
    const { container } = render(<Timeline store={store} />);

    expect(container.querySelector('.agui-timeline')?.getAttribute('data-layout')).toBe('split');
    // Not collapsed: the waterfall draws its bars rather than a summary toggle.
    expect(screen.queryByRole('button', { name: /^Waterfall ·/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^run r_happy/ })).toBeTruthy();
  });

  it('stacks the detail under the list and collapses the waterfall below it', () => {
    narrow.value = true;
    const store = createPanelStore(fixtureState());
    const { container } = render(<Timeline store={store} />);

    expect(container.querySelector('.agui-timeline')?.getAttribute('data-layout')).toBe('stacked');
    expect(screen.getByRole('button', { name: /^Waterfall ·/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();
    // Both panes are still present; only their arrangement changed.
    expect(screen.getByRole('listbox', { name: 'Event list' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Event detail' })).toBeTruthy();
  });

  it('scrolls the event list to a bar’s event when the bar is clicked', () => {
    const store = createPanelStore(longRunState());
    render(<Timeline store={store} />);

    expect(screen.queryByRole('option', { name: new RegExp(`^seq ${M2_CONTENT_SEQ} `) })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^message m_2/ }));

    expect(store.get().selectedSeq).toBe(M2_CONTENT_SEQ);
    expect(listViewport().scrollTop).toBeGreaterThan(0);
    expect(
      screen.getByRole('option', { name: new RegExp(`^seq ${M2_CONTENT_SEQ} `) }),
    ).toBeTruthy();
  });

  it('re-locates when the same bar is clicked again after the user scrolls away', () => {
    // The case `scrollToIndex` alone cannot serve: the second click writes the same
    // `selectedSeq`, so without a nonce the list would sit where the user left it.
    const store = createPanelStore(longRunState());
    render(<Timeline store={store} />);

    const bar = screen.getByRole('button', { name: /^message m_2/ });
    fireEvent.click(bar);
    const target = listViewport().scrollTop;
    expect(target).toBeGreaterThan(0);

    listViewport().scrollTop = 0;
    fireEvent.scroll(listViewport());
    expect(screen.queryByRole('option', { name: new RegExp(`^seq ${M2_CONTENT_SEQ} `) })).toBeNull();

    fireEvent.click(bar);

    expect(store.get().selectedSeq).toBe(M2_CONTENT_SEQ);
    expect(listViewport().scrollTop).toBe(target);
    expect(
      screen.getByRole('option', { name: new RegExp(`^seq ${M2_CONTENT_SEQ} `) }),
    ).toBeTruthy();
  });
});
