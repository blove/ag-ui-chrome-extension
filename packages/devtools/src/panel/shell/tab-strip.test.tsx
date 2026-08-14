import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { initialPanelState } from '../model/panel-types';
import { createPanelStore, selectTab } from '../model/store';
import { TabStrip } from './tab-strip';

describe('TabStrip', () => {
  it('renders the five tabs in order as real tabs', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tablist', { name: 'Panel sections' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Timeline',
      'Runs',
      'State',
      'Messages',
      'Session',
    ]);
  });

  it('marks only the current tab as selected', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: 'Timeline', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Session' }).getAttribute('aria-selected')).toBe('false');
  });

  it('selects a tab through the store', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));

    expect(store.get().tab).toBe('session');
    expect(screen.getByRole('tab', { name: 'Session', selected: true })).toBeTruthy();
  });

  it('keeps the deferred tabs selectable', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    for (const [label, id] of [
      ['Runs', 'runs'],
      ['State', 'state'],
      ['Messages', 'messages'],
    ] as const) {
      const tab = screen.getByRole('tab', { name: label });
      expect(tab.hasAttribute('disabled')).toBe(false);
      fireEvent.click(tab);
      expect(store.get().tab).toBe(id);
    }
  });

  it('points each tab at the panel it controls', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: 'State' }).getAttribute('aria-controls')).toBe(
      'agui-tabpanel-state',
    );
  });

  it('roves the tab stop so the strip is a single stop in the tab order', () => {
    const store = createPanelStore({ ...initialPanelState(), tab: 'messages' });
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: 'Messages' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('tabindex')).toBe('-1');
  });

  it('moves between tabs with the arrow keys, wrapping at the ends', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);
    const strip = screen.getByRole('tablist');

    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(store.get().tab).toBe('runs');

    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(store.get().tab).toBe('timeline');

    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(store.get().tab).toBe('session');

    fireEvent.keyDown(strip, { key: 'Home' });
    expect(store.get().tab).toBe('timeline');

    fireEvent.keyDown(strip, { key: 'End' });
    expect(store.get().tab).toBe('session');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Session' }));
  });

  it('follows a tab change made elsewhere in the panel', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    act(() => {
      store.update((s) => selectTab(s, 'runs'));
    });

    expect(screen.getByRole('tab', { name: 'Runs', selected: true })).toBeTruthy();
  });
});
