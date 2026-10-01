import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { createPanelStore } from '../model/store';
import { DeveloperModeBanner, DeveloperModeSwitch } from './developer-mode';

describe('Developer mode switch', () => {
  it('is unavailable, with the reason, until capture is on for the inspected origin', () => {
    const store = createPanelStore();
    store.update((s) => ({ ...s, capture: { kind: 'off', origin: 'https://app.test', signal: { level: 'none' } } }));
    render(<DeveloperModeSwitch store={store} onSet={() => undefined} />);
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Available once capture is enabled for the inspected origin.')).toBeTruthy();
  });

  it('is unavailable without a live panel to ask the worker', () => {
    const store = createPanelStore();
    store.update((s) => ({ ...s, capture: { kind: 'on', origin: 'https://app.test' } }));
    render(<DeveloperModeSwitch store={store} />);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('states the honest limit (R8) where the switch is offered', () => {
    const store = createPanelStore();
    store.update((s) => ({ ...s, capture: { kind: 'on', origin: 'https://app.test' } }));
    render(<DeveloperModeSwitch store={store} onSet={() => undefined} />);
    expect(screen.getByText(/not against code already in it/)).toBeTruthy();
    expect(screen.getByText(/only in the top frame/)).toBeTruthy();
  });
});

describe('Developer mode banner', () => {
  it('shows only while the inspected origin’s flag is on', () => {
    const store = createPanelStore();
    store.update((s) => ({
      ...s,
      capture: { kind: 'on', origin: 'https://app.test' },
      developerModes: { 'https://elsewhere.test': true },
    }));
    const { rerender } = render(<DeveloperModeBanner store={store} />);
    expect(screen.queryByRole('status')).toBeNull();
    store.update((s) => ({ ...s, developerModes: { ...s.developerModes, 'https://app.test': true } }));
    rerender(<DeveloperModeBanner store={store} />);
    expect(screen.getByRole('status').textContent).toBe(
      'Developer mode: this page’s next agent run can be scripted from the panel.',
    );
  });
});
