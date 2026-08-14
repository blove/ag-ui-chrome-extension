// The hook renders, so this file stays on the `panel` project's jsdom default and carries no
// environment docblock of its own — unlike the pure-logic suites, which opt down to node.
import { describe, it, expect } from 'vitest';
import type { JSX } from 'preact';
import { render, act } from '@testing-library/preact';
import { initialPanelState } from './panel-types';
import { createPanelStore, selectSeq, selectTab, type PanelStore } from './store';
import { usePanelState } from './use-panel-state';

/** Renders the two fields the tests assert on, and records one entry per render. */
function TabProbe({ store, renders }: { store: PanelStore; renders: string[] }): JSX.Element {
  const state = usePanelState(store);
  renders.push(`${state.tab}:${String(state.selectedSeq)}`);
  return <div data-testid="probe">{state.tab}</div>;
}

/** A real store wrapped so the test can see how many listeners are currently attached. */
function trackingStore(): { store: PanelStore; listenerCount: () => number } {
  const inner = createPanelStore();
  let count = 0;
  const store: PanelStore = {
    get: () => inner.get(),
    set: (next) => {
      inner.set(next);
    },
    update: (fn) => {
      inner.update(fn);
    },
    subscribe: (listener) => {
      count += 1;
      const unsubscribe = inner.subscribe(listener);
      return () => {
        count -= 1;
        unsubscribe();
      };
    },
  };
  return { store, listenerCount: () => count };
}

describe('usePanelState', () => {
  it('returns the store state at mount', () => {
    const store = createPanelStore(selectTab(initialPanelState(), 'session'));
    const { getByTestId } = render(<TabProbe store={store} renders={[]} />);
    expect(getByTestId('probe').textContent).toBe('session');
  });

  it('re-renders with the new state when the store is set', () => {
    const store = createPanelStore();
    const { getByTestId } = render(<TabProbe store={store} renders={[]} />);
    act(() => {
      store.set(selectTab(store.get(), 'runs'));
    });
    expect(getByTestId('probe').textContent).toBe('runs');
  });

  it('re-renders on update() as well as set()', () => {
    const store = createPanelStore();
    const renders: string[] = [];
    render(<TabProbe store={store} renders={renders} />);
    act(() => {
      store.update((prev) => selectSeq(selectTab(prev, 'state'), 4));
    });
    expect(renders.at(-1)).toBe('state:4');
  });

  it('unsubscribes on unmount', () => {
    // Asserted against a live listener count rather than a render count: Preact drops a setState on
    // an unmounted component anyway, so "no extra render" would pass even with the cleanup missing.
    const { store, listenerCount } = trackingStore();
    const { unmount } = render(<TabProbe store={store} renders={[]} />);
    expect(listenerCount()).toBe(1);
    unmount();
    expect(listenerCount()).toBe(0);
  });

  it('resubscribes when handed a different store', () => {
    const first = createPanelStore();
    const second = createPanelStore(selectTab(initialPanelState(), 'runs'));
    const renders: string[] = [];
    const { rerender, getByTestId } = render(<TabProbe store={first} renders={renders} />);

    rerender(<TabProbe store={second} renders={renders} />);
    act(() => {
      second.set(selectTab(second.get(), 'messages'));
    });
    expect(getByTestId('probe').textContent).toBe('messages');

    const rendersAfterSwitch = renders.length;
    act(() => {
      first.set(selectTab(first.get(), 'session'));
    });
    expect(renders.length).toBe(rendersAfterSwitch);
  });
});
