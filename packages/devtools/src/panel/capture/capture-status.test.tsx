import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { CaptureBanner } from './capture-status';
import { createPanelStore } from '../model/store';
import type { PanelStore } from '../model/store';
import { initialPanelState } from '../model/panel-types';
import type { CaptureStatus, PanelSource } from '../model/panel-types';

function storeWith(capture: CaptureStatus, source: PanelSource = { kind: 'empty' }): PanelStore {
  // `loaded: true` unless a test says otherwise: these are the states of a page that has
  // reported its capture hooks, which is the ordinary case. The tri-state is exercised on its own
  // below.
  return createPanelStore({ ...initialPanelState(), capture, source, loaded: true });
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
        onReRegister={vi.fn()}
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
        onReRegister={vi.fn()}
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
        onReRegister={vi.fn()}
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
    const { container } = render(<CaptureBanner store={store} onEnable={vi.fn()} onReRegister={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('explains that this build has no capture layer rather than showing nothing', () => {
    render(<CaptureBanner store={storeWith({ kind: 'unsupported' })} onEnable={vi.fn()} onReRegister={vi.fn()} />);
    expect(screen.getByText(/only runs inside the DevTools panel/i)).toBeTruthy();
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
        onReRegister={vi.fn()}
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
    render(<CaptureBanner store={store} onEnable={vi.fn()} onReRegister={vi.fn()} />);
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
    render(<CaptureBanner store={store} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    expect(screen.getByRole('status').textContent).not.toMatch(/angular/i);
  });
});

/**
 * Granted is not loaded, and the banner is where the difference becomes visible.
 *
 * `chrome.scripting.registerContentScripts` affects only FUTURE navigations, so an origin granted
 * in a previous session — or an extension reloaded with the page open — leaves a document with
 * none of our content scripts in it while the permission says capture is available. The panel
 * used to read the permission and announce "Capture is on", which is the project's recurring
 * failure class: something that looks like success.
 *
 * The positive claim is deliberately weak. Its evidence is that our ISOLATED-world relay is
 * running in the document, which proves the content scripts were registered — not that the
 * MAIN-world patches installed. The banner must not out-run that.
 */
describe('CaptureBanner — capture layer loaded, not loaded, or unreported', () => {
  function onOrigin(loaded: boolean | null): PanelStore {
    return createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'on', origin: 'http://localhost:3000' },
      source: { kind: 'live', origin: 'http://localhost:3000' },
      loaded,
    });
  }

  it('warns that the capture layer is not loaded, and states the reload requirement once', () => {
    render(<CaptureBanner store={onOrigin(false)} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/capture layer is not loaded/i);
    // The wording lives in `ReloadNote`, shared with the two capture-off states, so the reload
    // requirement is explained one way everywhere.
    expect(banner.textContent).toMatch(/requires a reload of the inspected page/i);
    expect(banner.textContent).not.toMatch(/waiting for a run/i);
  });

  /*
   * The grace period, seen from the banner.
   *
   * A panel that rendered the warning before the page has had a chance to report would flash a
   * false warning on EVERY open, and a warning that is usually wrong is worse than none: it
   * teaches the user to ignore the one that matters.
   */
  it('says it is still checking rather than warning, while nothing has been reported yet', () => {
    render(<CaptureBanner store={onOrigin(null)} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/checking/i);
    expect(banner.textContent).not.toMatch(/capture layer is not loaded/i);
    expect(banner.textContent).not.toMatch(/waiting for a run/i);
  });

  /*
   * THE CLAIM MAY NOT OUT-RUN ITS EVIDENCE — the failure mode this whole feature exists to stop.
   *
   * The relay reporting proves the content scripts were registered for this document. It does not
   * prove `installInject` patched `fetch` without throwing. So the banner may say the capture
   * layer is loaded, and may not say the hooks are installed, that the page is instrumented, or
   * that anything is being captured. The residual self-corrects the moment a record arrives, and
   * records are the only stronger claim the panel ever makes (it goes quiet on them).
   */
  it('claims the capture layer is loaded, and claims nothing stronger', () => {
    render(<CaptureBanner store={onOrigin(true)} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/capture layer is loaded in this page/i);
    expect(text).toMatch(/waiting for a run/i);
    for (const overclaim of [/hooks are installed/i, /instrumented/i, /is being captured/i]) {
      expect(text).not.toMatch(overclaim);
    }
  });

  it('warns even with records on screen, because the warning is about THIS document', () => {
    const store = onOrigin(false);
    store.update((s) => ({
      ...s,
      records: [
        { kind: 'keepalive', seq: 1, tMs: 0, connId: 'c1', raw: '', comment: '', issues: [] },
      ],
    }));
    render(<CaptureBanner store={store} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    // Records from a previous document do not load a capture layer into the current one, and a
    // panel that went quiet here would be back to implying capture it does not have.
    expect(screen.getByRole('status').textContent).toMatch(/capture layer is not loaded/i);
  });

  it('stays quiet over records while the check is still outstanding', () => {
    const store = onOrigin(null);
    store.update((s) => ({
      ...s,
      records: [
        { kind: 'keepalive', seq: 1, tMs: 0, connId: 'c1', raw: '', comment: '', issues: [] },
      ],
    }));
    const { container } = render(<CaptureBanner store={store} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    // A "checking…" note thrown over a full timeline on every navigation is noise. Absence of a
    // report is only worth saying once it has become a finding.
    expect(container.textContent).toBe('');
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
    render(<CaptureBanner store={store} onEnable={vi.fn()} onReRegister={vi.fn()} />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/binary transport/i);
    expect(banner.textContent).toContain('application/vnd.ag-ui.event+proto');
    expect(banner.textContent).toMatch(/decoding is not supported yet/i);
    expect(banner.textContent).not.toMatch(/waiting for a run/i);
  });
});
