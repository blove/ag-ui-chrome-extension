import type { JSX } from 'preact';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface CaptureBannerProps {
  store: PanelStore;
  /**
   * Invoked by the Enable button, which every capture-off state carries.
   *
   * Phase 1 ships no capture layer, so a caller that cannot actually enable capture must SAY so
   * — the button may never silently do nothing, which is indistinguishable from a broken panel
   * and is the exact failure this banner exists to prevent.
   */
  onEnable: () => void;
}

/**
 * The reload requirement, worded once.
 *
 * It is not a formality: the capture hooks install ahead of the page's own scripts, so a stream
 * already in flight is unreachable. A user who enables capture and then waits at a page that is
 * already running would conclude the extension is broken.
 */
function ReloadNote(): JSX.Element {
  return (
    <>
      <strong>requires a reload of the inspected page</strong> — the capture hooks install before
      the page&rsquo;s own scripts run, so a stream already in flight cannot be picked up.
    </>
  );
}

/**
 * The three honest capture states of design §5, plus phase 1's fourth.
 *
 * Design decision P11: **always offer, never claim nothing is there.** Both capture-off branches
 * below carry the same Enable button, and the detection signal changes only the wording. That is
 * a correction, not a preference — P5 shipped detect-then-offer, and measured against a real
 * deployment it was misleading: a production AG-UI app emits no AG-UI traffic at all until the
 * user sends a message, so the detector has nothing to see at exactly the moment the user first
 * opens the panel. "No AG-UI stream detected on this origin" was true, useless, and read as a
 * verdict on the page.
 *
 * Nothing here reads `state.framework`. The fingerprint labels the session (requirements §4.3);
 * it is not evidence about AG-UI, which has no DOM footprint to fingerprint.
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
        <p class="agui-banner__head">Live capture only runs inside the DevTools panel.</p>
        <p class="agui-banner__body">
          This page has no inspected origin to attach to — there is no <code>chrome.devtools</code>{' '}
          to ask, which is what happens outside DevTools. Import a <code>.agui.jsonl</code> capture
          from the Session tab to inspect a stream here — that is the same path a shared bug report
          takes, and every tab works against it.
        </p>
      </div>
    );
  }

  if (capture.kind === 'on') {
    /*
     * §5.4 / resolution C3, and it is checked BEFORE the records test on purpose.
     *
     * A binary connection carries no decodable frames, so this state has zero records and would
     * otherwise fall through to "Waiting for a run — trigger one in the page". The run already
     * happened; the panel simply cannot read it. Saying "waiting" would send the reader off to
     * trigger runs forever, and an unlabelled empty capture is exactly the "silently capturing
     * nothing" failure requirements §15 names.
     */
    const binary = state.binaryTransport;
    if (binary !== null) {
      return (
        <div class="agui-banner agui-banner--info" role="status">
          <p class="agui-banner__head">
            This connection used a binary transport — decoding is not supported yet.
          </p>
          <p class="agui-banner__body">
            Capture is on for {capture.origin} and saw {binary.bytes} bytes of{' '}
            <code>{binary.contentType}</code> on connection <code>{binary.connId}</code>. AG-UI over
            protobuf is detected and labelled in this phase but not decoded (requirements §5.4
            defers that to phase 3), so no events can be shown for it. An SSE run on the same origin
            still captures normally.
          </p>
        </div>
      );
    }

    /*
     * Granted is not loaded, and this is where the difference stops being invisible.
     *
     * The origin being granted says capture is AVAILABLE here.
     * `chrome.scripting.registerContentScripts` only affects FUTURE navigations, so a document
     * that was already open when the grant landed — or when the extension was last reloaded — has
     * none of our content scripts in it and nothing is being captured from it. The panel used to
     * read the permission and announce "Capture is on", which is this project's recurring failure
     * class: something that looks like success.
     *
     * Checked BEFORE the records test, because the warning is about THIS document. Records left
     * over from the previous one do not load a capture layer into the current page, and going
     * quiet over them would put the panel straight back to implying capture it does not have.
     */
    if (state.loaded === false) {
      return (
        <div class="agui-banner agui-banner--offer" role="status">
          <p class="agui-banner__head">
            Capture is on for {capture.origin}, but the capture layer is not loaded in this page.
          </p>
          <p class="agui-banner__body">
            Granting an origin registers the capture scripts for its <em>next</em> page load, so a
            document that was already open when capture was enabled has none of them and reports
            nothing — nothing is being captured from it. Capture here <ReloadNote />
          </p>
        </div>
      );
    }

    if (state.records.length > 0) {
      return null;
    }

    /*
     * The grace period, on screen.
     *
     * The capture layer reports itself at `document_start`, and that report crosses a hop before
     * it reaches here. Saying the layer is missing in the moment before the report is due would
     * flash a false warning on every panel open — and a warning that is usually wrong teaches the
     * user to ignore the one that matters. Saying "capture is on" would be the original defect.
     * So the panel says what is true: it is waiting.
     */
    if (state.loaded === null) {
      return (
        <div class="agui-banner agui-banner--info" role="status">
          <p class="agui-banner__head">Checking whether the capture layer is loaded here…</p>
          <p class="agui-banner__body">
            Capture is on for {capture.origin}. The capture layer reports itself as the page loads,
            and that report has not arrived yet.
          </p>
        </div>
      );
    }

    /*
     * WHAT THIS MAY AND MAY NOT SAY — the reason this whole feature exists, in one sentence.
     *
     * The evidence behind this branch is that our ISOLATED-world relay is running in the
     * inspected document. That proves the content scripts were REGISTERED for it, which is
     * exactly the broken case being ruled out. It does NOT prove the MAIN-world patches installed
     * without throwing, so the wording says "loaded" and stops there. The signal moved out of the
     * page's view on purpose (see `relay/relay.ts`), and buying a stronger claim back with a
     * page-visible handshake is the trade this change was made to refuse.
     *
     * The residual self-corrects: the moment any AG-UI request happens a `conn-open` arrives,
     * records start flowing, and the branch above returns null — records are proof the patches
     * work, and they are the only proof the panel ever asserts on.
     */
    return (
      <div class="agui-banner agui-banner--info" role="status">
        <p class="agui-banner__head">
          Capture is on for {capture.origin}, and the capture layer is loaded in this page.
        </p>
        <p class="agui-banner__body">Waiting for a run — trigger one in the page.</p>
      </div>
    );
  }

  const enable = (
    <button type="button" class="agui-banner__action" onClick={onEnable}>
      Enable capture for {capture.origin}
    </button>
  );

  // Strongest: something answered with an SSE response on this origin. Note what this does NOT
  // say — `observeNetwork` sees finished responses through the DevTools network log, never a
  // frame, so it cannot tell an AG-UI stream from a progress-bar one and this must not pretend
  // otherwise. Saying exactly what was seen is worth more here than a stronger-sounding claim.
  if (capture.signal.level === 'stream') {
    return (
      <div class="agui-banner agui-banner--offer" role="status">
        <p class="agui-banner__head">An event stream was seen on {capture.origin}.</p>
        <p class="agui-banner__body">
          Capture is off for this origin, so the panel can see that a <code>text/event-stream</code>{' '}
          response finished here but not what it carried. Enabling capture grants access to{' '}
          {capture.origin} and <ReloadNote />
        </p>
        {enable}
      </div>
    );
  }

  /*
   * Nothing seen — and this is the branch P11 exists for.
   *
   * It may not say "nothing detected". A production AG-UI app is silent until the user sends a
   * message, so on first open this state carries no information about the page whatsoever. The
   * only honest thing to report is the panel's own ignorance, and then to offer anyway.
   *
   * There is no third, in-between state to reach for, and looking for one is what P11's first
   * attempt got wrong: AG-UI is a wire protocol and specifies nothing in the DOM, so no page-load
   * markup can raise the panel's confidence. The framework fingerprint on the Session tab is not
   * a weaker version of this signal — it is a different fact, about how the app was built rather
   * than about what it speaks.
   */
  return (
    <div class="agui-banner agui-banner--offer" role="status">
      <p class="agui-banner__head">Capture is off for {capture.origin}.</p>
      <p class="agui-banner__body">
        AG-UI traffic often only appears once you send a message, so the panel cannot tell yet
        whether this page speaks AG-UI — enable capture to find out. Enabling grants access to{' '}
        {capture.origin} and <ReloadNote /> You can also import a <code>.agui.jsonl</code> capture
        from the Session tab.
      </p>
      {enable}
    </div>
  );
}
