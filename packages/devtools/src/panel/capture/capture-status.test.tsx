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
  it('leads with the stream when one was seen, and states the reload requirement', () => {
    const onEnable = vi.fn();
    render(
      <CaptureBanner
        store={storeWith({
          kind: 'off',
          origin: 'https://app.example',
          signal: { level: 'stream' },
        })}
        onEnable={onEnable}
      />,
    );

    expect(screen.getByText(/event stream was seen on https:\/\/app\.example/i)).toBeTruthy();
    expect(screen.getByText(/requires a reload of the inspected page/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  /*
   * The whole point of P11.
   *
   * The old wording here claimed "no AG-UI stream detected on this origin", which is true and
   * useless: measured against a real deployment, a production AG-UI app emits no AG-UI traffic
   * until the user sends a message, so the detector has nothing to see at exactly the moment the
   * user first opens the panel. The banner must say that the panel cannot tell yet — not that
   * there is nothing there — and must offer Enable regardless.
   */
  it('never claims nothing is there when it has seen nothing, and offers Enable anyway', () => {
    const onEnable = vi.fn();
    render(
      <CaptureBanner
        store={storeWith({ kind: 'off', origin: 'https://app.example', signal: { level: 'none' } })}
        onEnable={onEnable}
      />,
    );

    expect(screen.getByText(/capture is off for https:\/\/app\.example/i)).toBeTruthy();
    expect(screen.getByText(/only appears once you send a message/i)).toBeTruthy();
    expect(screen.getByText(/cannot tell yet/i)).toBeTruthy();

    const banner = screen.getByRole('status');
    expect(banner.textContent).not.toMatch(/nothing detected/i);
    expect(banner.textContent).not.toMatch(/no ag-ui stream/i);

    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(onEnable).toHaveBeenCalledTimes(1);
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

  it('re-renders as the signal is raised, and keeps offering Enable throughout', () => {
    const store = storeWith({
      kind: 'off',
      origin: 'https://app.example',
      signal: { level: 'none' },
    });
    render(<CaptureBanner store={store} onEnable={vi.fn()} />);
    expect(screen.getByRole('button', { name: /enable capture for/i })).toBeTruthy();

    act(() => {
      store.update((s) => ({
        ...s,
        capture: { kind: 'off', origin: 'https://app.example', signal: { level: 'stream' } },
      }));
    });
    expect(screen.getByText(/event stream was seen/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /enable capture for/i })).toBeTruthy();
  });

  /*
   * The banner never mentions the framework, and this test is here to keep it that way.
   *
   * A framework fingerprint is a DOM heuristic, and AG-UI is a wire protocol that specifies
   * nothing in the DOM — so no markup can support a claim about whether this page speaks AG-UI.
   * Requirements §4.3: the fingerprint labels the session (it is on the Session tab), never gates
   * or colours capture.
   */
  it('says nothing about the framework, however confident the panel is about it', () => {
    const store = storeWith({
      kind: 'off',
      origin: 'https://app.example',
      signal: { level: 'none' },
    });
    store.update((s) => ({ ...s, framework: 'Angular 21.1.6' }));
    render(<CaptureBanner store={store} onEnable={vi.fn()} />);

    expect(screen.getByRole('status').textContent).not.toMatch(/angular/i);
  });
});

/*
 * The one capture-on state that has no records and is not waiting for anything.
 *
 * "Waiting for a run — trigger one in the page" is the wrong sentence here: the run already
 * happened, over a transport this phase cannot decode (requirements §5.4). Saying it anyway
 * would send the reader to trigger runs forever.
 */
describe('CaptureBanner — binary transport', () => {
  it('labels the binary transport instead of waiting for a run that already happened', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'on', origin: 'http://localhost:3000' },
      source: { kind: 'live', origin: 'http://localhost:3000' },
      binaryTransport: {
        connId: 'c1',
        tMs: 3,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 512,
      },
    });
    render(<CaptureBanner store={store} onEnable={vi.fn()} />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/binary transport/i);
    expect(banner.textContent).toContain('application/vnd.ag-ui.event+proto');
    expect(banner.textContent).toMatch(/decoding is not supported yet/i);
    expect(banner.textContent).not.toMatch(/waiting for a run/i);
  });
});
