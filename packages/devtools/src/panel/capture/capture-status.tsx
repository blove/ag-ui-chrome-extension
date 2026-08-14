import type { JSX } from 'preact';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface CaptureBannerProps {
  store: PanelStore;
  /**
   * Invoked by the Enable button in the detect-then-offer state.
   *
   * Phase 1 ships no capture layer, so a caller that cannot actually enable capture must SAY so
   * — the button may never silently do nothing, which is indistinguishable from a broken panel
   * and is the exact failure P5 exists to prevent.
   */
  onEnable: () => void;
}

/**
 * The three honest capture states of design §5, plus phase 1's fourth.
 *
 * P5's rule is that a capture-off origin gets detect-then-offer, never a dead panel: an empty
 * panel is indistinguishable from a broken one, and the extension ships inert on every
 * non-localhost origin (D3), so that state is the common first impression rather than an edge
 * case. Every branch here therefore says something true about why nothing is on screen.
 *
 * Renders nothing once an imported capture is on screen — the user is looking at data and does
 * not need to be told about a capture layer they are not using — and nothing once live records
 * are flowing, since "idle" is then false.
 */
export function CaptureBanner({ store, onEnable }: CaptureBannerProps): JSX.Element | null {
  const state = usePanelState(store);

  if (state.source.kind === 'imported') {
    return null;
  }

  const capture = state.capture;

  if (capture.kind === 'unsupported') {
    return (
      <div class="agui-banner agui-banner--info" role="status">
        <p class="agui-banner__head">Live capture is not available in this build.</p>
        <p class="agui-banner__body">
          The capture layer lands in a later milestone. Import a <code>.agui.jsonl</code> capture
          from the Session tab to inspect a stream now — that is the same path a shared bug report
          takes, and every tab works against it.
        </p>
      </div>
    );
  }

  if (capture.kind === 'on') {
    if (state.records.length > 0) {
      return null;
    }
    return (
      <div class="agui-banner agui-banner--info" role="status">
        <p class="agui-banner__head">Capture is on for {capture.origin}.</p>
        <p class="agui-banner__body">Waiting for a run — trigger one in the page.</p>
      </div>
    );
  }

  if (capture.aguiDetected) {
    return (
      <div class="agui-banner agui-banner--offer" role="status">
        <p class="agui-banner__head">An event stream was detected on {capture.origin}.</p>
        <p class="agui-banner__body">
          Capture is off for this origin. Enabling it grants access to {capture.origin} and{' '}
          <strong>requires a reload of the inspected page</strong> — the capture hooks install
          before the page&rsquo;s own scripts run, so a stream already in flight cannot be picked
          up.
        </p>
        <button type="button" class="agui-banner__action" onClick={onEnable}>
          Enable capture for {capture.origin}
        </button>
      </div>
    );
  }

  return (
    <div class="agui-banner agui-banner--quiet" role="status">
      <p class="agui-banner__head">No AG-UI stream detected on {capture.origin} yet.</p>
      <p class="agui-banner__body">
        Nothing is wrong — the panel is watching for a <code>text/event-stream</code> response and
        will offer to enable capture when it sees one. You can also import a{' '}
        <code>.agui.jsonl</code> capture from the Session tab.
      </p>
    </div>
  );
}
