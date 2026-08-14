import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { CaptureBanner } from './capture-status';
import { createPanelStore } from '../model/store';
import type { PanelStore } from '../model/store';
import { initialPanelState } from '../model/panel-types';
import type { CaptureStatus, PanelSource } from '../model/panel-types';

function storeWith(capture: CaptureStatus, source: PanelSource = { kind: 'empty' }): PanelStore {
  return createPanelStore({ ...initialPanelState(), capture, source });
}

describe('CaptureBanner', () => {
  it('offers Enable and states the reload requirement when AG-UI is detected', () => {
    const onEnable = vi.fn();
    render(
      <CaptureBanner
        store={storeWith({ kind: 'off', origin: 'https://app.example', aguiDetected: true })}
        onEnable={onEnable}
      />,
    );

    expect(screen.getByText(/detected on https:\/\/app\.example/i)).toBeTruthy();
    expect(screen.getByText(/requires a reload of the inspected page/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  it('says plainly that nothing has been detected, with no Enable button', () => {
    render(
      <CaptureBanner
        store={storeWith({ kind: 'off', origin: 'https://app.example', aguiDetected: false })}
        onEnable={vi.fn()}
      />,
    );

    expect(screen.getByText(/no ag-ui stream detected on https:\/\/app\.example yet/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says capture is on and idle while no records have arrived', () => {
    render(
      <CaptureBanner
        store={storeWith({ kind: 'on', origin: 'http://localhost:3000' })}
        onEnable={vi.fn()}
      />,
    );
    expect(screen.getByText(/capture is on for http:\/\/localhost:3000/i)).toBeTruthy();
    expect(screen.getByText(/waiting for a run/i)).toBeTruthy();
  });

  it('goes quiet once records are flowing', () => {
    const store = storeWith({ kind: 'on', origin: 'http://localhost:3000' });
    store.update((s) => ({
      ...s,
      records: [{ kind: 'keepalive', seq: 1, tMs: 0, connId: 'c1', raw: '', comment: '', issues: [] }],
    }));
    const { container } = render(<CaptureBanner store={store} onEnable={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('explains that this build has no capture layer rather than showing nothing', () => {
    render(<CaptureBanner store={storeWith({ kind: 'unsupported' })} onEnable={vi.fn()} />);
    expect(screen.getByText(/live capture is not available in this build/i)).toBeTruthy();
    expect(screen.getByText(/\.agui\.jsonl/)).toBeTruthy();
  });

  it('goes quiet while an imported capture is on screen', () => {
    const { container } = render(
      <CaptureBanner
        store={storeWith(
          { kind: 'unsupported' },
          { kind: 'imported', filename: 'bug.agui.jsonl', importedAtMs: 0 },
        )}
        onEnable={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('re-renders when capture status changes', () => {
    const store = storeWith({ kind: 'off', origin: 'https://app.example', aguiDetected: false });
    render(<CaptureBanner store={store} onEnable={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();

    act(() => {
      store.update((s) => ({
        ...s,
        capture: { kind: 'off', origin: 'https://app.example', aguiDetected: true },
      }));
    });
    expect(screen.getByRole('button', { name: /enable capture for/i })).toBeTruthy();
  });
});
