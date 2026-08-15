/**
 * Live capture, wired.
 *
 * Everything Chrome-shaped about the panel's connection to the service worker lives here: the
 * port, the origin grant, the navigation hook, and the two toolbar commands. The fold itself is
 * `./live-session`, which is Chrome-free, so this file holds no logic that a test would want to
 * reach through an API stub.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { PanelStore } from '../model/store';
import { captureOn, setInstrumented, setRecording as setRecordingAction } from '../model/store';
import { usePanelState } from '../model/use-panel-state';
import { createLiveSession, type LiveSession } from './live-session';
import { connectToServiceWorker, type PanelPort } from './port';
import { hasOriginGrant, isAutoEnabledOrigin, requestOriginGrant, type GrantOutcome } from './grant';

/**
 * What the last Enable attempt did. `null` until the user presses it.
 *
 * The panel must SAY what happened. An Enable button that resolves to `denied` and shows
 * nothing is indistinguishable from a broken one, which is the failure the whole capture banner
 * exists to prevent.
 */
export type EnableStatus = GrantOutcome | null;

/**
 * How long the panel waits for the inspected document to report its capture hooks before saying
 * it has none.
 *
 * The announcement is posted at `document_start` and crosses two hops — `window.postMessage` to
 * the ISOLATED relay, then a `chrome.runtime` port to the service worker, which may itself have
 * to be woken. A panel that rendered the warning before that had a chance to land would flash a
 * false alarm on EVERY open, and a warning that is usually wrong is worse than no warning at all:
 * it teaches the user to ignore the one that matters.
 *
 * Long enough to cover a woken worker, short enough that a user who is about to be told to reload
 * is not left reading a stale "Capture is on".
 */
export const INSTRUMENTATION_GRACE_MS = 1500;

export interface LiveCapture {
  /** Request the origin grant and turn capture on. Call from a click — Chrome requires it. */
  enable: () => void;
  setRecording: (recording: boolean) => void;
  /** Tell the worker to drop this tab's buffer. Paired with the toolbar's Clear. */
  clearBuffer: () => void;
  /** Reload the inspected page, which is what makes the capture hooks install. */
  reloadInspectedPage: () => void;
  status: EnableStatus;
  /**
   * True while capture cannot work until the inspected page is reloaded.
   *
   * Two ways in, and they are the same fact from different directions: the user has just granted
   * the origin (so the hooks will install on the next load), or the document has been asked and
   * has not reported any (so it has no hooks now). The second used to be missing entirely, which
   * is how the panel came to say it was capturing from documents it had never touched.
   */
  awaitingReload: boolean;
}

function inspectedTabId(): number | null {
  const tabId = chrome.devtools?.inspectedWindow?.tabId;
  return typeof tabId === 'number' ? tabId : null;
}

export function useLiveCapture(store: PanelStore): LiveCapture {
  const state = usePanelState(store);
  const [status, setStatus] = useState<EnableStatus>(null);
  const [grantedAwaitingReload, setGrantedAwaitingReload] = useState(false);
  /** Bumped on every navigation of the inspected page. One document, one epoch. */
  const [documentEpoch, setDocumentEpoch] = useState(0);

  const sessionRef = useRef<LiveSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createLiveSession({ expandChunks: store.get().expandChunks });
  }
  const portRef = useRef<PanelPort | null>(null);

  const capture = state.capture;
  const captureOnFor = capture.kind === 'on' ? capture.origin : null;

  /*
   * Turn capture on where it is already available, without asking.
   *
   * Two cases, and both would otherwise leave a working origin behind an Enable button that
   * does nothing new: D3 statically registers the localhost family (which is exactly what the
   * harness serves over), and an origin granted in an earlier session is still granted.
   */
  useEffect(() => {
    if (capture.kind !== 'off') return;
    const { origin } = capture;
    if (isAutoEnabledOrigin(origin)) {
      store.update((s) => captureOn(s, origin));
      return;
    }
    let live = true;
    void hasOriginGrant(origin).then((granted) => {
      if (live && granted) store.update((s) => captureOn(s, origin));
    });
    return () => {
      live = false;
    };
  }, [store, capture]);

  /*
   * Ask the document whether it is instrumented, and give it a moment to answer.
   *
   * Declared BEFORE the port effect so the reset cannot land on top of a snapshot that has
   * already answered. `documentEpoch` is bumped on every navigation: a new document inherits
   * nothing, so the question reopens each time and the timeout starts again.
   *
   * Nothing here asks Chrome anything. The answer arrives — or does not — from the page itself,
   * which is the only party that knows, and the timeout is what turns silence into a finding.
   */
  useEffect(() => {
    if (captureOnFor === null) return;
    store.update((s) => setInstrumented(s, null));
    const timer = setTimeout(() => {
      // Only silence becomes a finding: an announcement that arrived in the meantime stands.
      store.update((s) => (s.instrumented === null ? setInstrumented(s, false) : s));
    }, INSTRUMENTATION_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [store, captureOnFor, documentEpoch]);

  // One port for the life of the capture-on state — design §6: holding it open is the MV3
  // keepalive, so it must NOT be reopened per message or per recording change.
  useEffect(() => {
    if (captureOnFor === null) return;
    const tabId = inspectedTabId();
    if (tabId === null) return;

    const port = connectToServiceWorker({
      tabId,
      onMessage: (message) => {
        const session = sessionRef.current;
        if (session === null) return;
        store.update((s) => session.apply(s, message));
      },
      onDisconnect: () => {
        portRef.current = null;
      },
    });
    portRef.current = port;
    // The worker's default is to buffer; only a paused panel has to say otherwise, and it has
    // to say so again on every fresh connection because the worker does not remember.
    if (!store.get().recording) port?.send({ kind: 'set-recording', recording: false });

    return () => {
      port?.disconnect();
      portRef.current = null;
    };
  }, [store, captureOnFor]);

  /*
   * Preserve log on navigate.
   *
   * `preserveLog` is read through a ref rather than listed as a dependency: re-subscribing the
   * navigation listener every time the toggle flips is pointless churn, and `onNavigated` is
   * the one event whose handler must survive unchanged across a run.
   */
  const preserveLogRef = useRef(state.preserveLog);
  preserveLogRef.current = state.preserveLog;
  useEffect(() => {
    const event = chrome.devtools?.network?.onNavigated;
    if (event === undefined || captureOnFor === null) return;
    const listener = (): void => {
      // Reopen the instrumentation question first, and unconditionally: this is a NEW document,
      // and whether the last one had capture hooks says nothing about whether this one does — it
      // may be on an origin that was never granted. Preserve-log is about DATA and must not keep
      // a stale claim about the page alive.
      setDocumentEpoch((epoch) => epoch + 1);
      if (preserveLogRef.current) return;
      // Clearing the worker is enough: it answers with `cleared`, which is what empties the
      // panel. Clearing locally as well would show an empty list a beat before the worker
      // agreed, and the two ends could then disagree if the message never arrived.
      portRef.current?.send({ kind: 'clear' });
    };
    event.addListener(listener);
    return () => {
      event.removeListener(listener);
    };
  }, [captureOnFor]);

  // Expand chunks on a LIVE capture. `App`'s effect covers the imported case by re-decoding the
  // retained bytes; there are no bytes here, so the session re-folds its retained records.
  const expandChunks = state.expandChunks;
  const appliedExpandChunks = useRef(expandChunks);
  const isLive = state.source.kind === 'live';
  useEffect(() => {
    if (appliedExpandChunks.current === expandChunks) return;
    appliedExpandChunks.current = expandChunks;
    const session = sessionRef.current;
    if (session === null || !isLive) return;
    store.update((s) => session.refold(s, { expandChunks }));
  }, [store, expandChunks, isLive]);

  const enable = useCallback(() => {
    if (capture.kind !== 'off') return;
    const { origin } = capture;
    void requestOriginGrant(origin).then((outcome) => {
      setStatus(outcome);
      if (outcome.kind !== 'granted') return;
      setGrantedAwaitingReload(true);
      store.update((s) => captureOn(s, origin));
    });
  }, [store, capture]);

  const setRecording = useCallback(
    (recording: boolean) => {
      store.update((s) => setRecordingAction(s, recording));
      portRef.current?.send({ kind: 'set-recording', recording });
    },
    [store],
  );

  /*
   * Clear both ends.
   *
   * The session is restarted locally rather than waiting for the worker's `cleared` echo,
   * because Clear must work with no worker at all — on an imported capture the toolbar's
   * button is the only thing that empties the panel, and there is no port to answer.
   */
  const clearBuffer = useCallback(() => {
    sessionRef.current?.restart();
    portRef.current?.send({ kind: 'clear' });
  }, []);

  const reloadInspectedPage = useCallback(() => {
    setGrantedAwaitingReload(false);
    chrome.devtools?.inspectedWindow?.reload?.();
  }, []);

  /*
   * The reload is needed either because the grant has not taken effect yet, or because the page
   * has been asked and reported no hooks. `executeScript` into the open document is deliberately
   * NOT offered as a shortcut: it would leave a PARTIALLY instrumented document — a bundler
   * routinely hoists `const f = window.fetch` at module load, and an already-constructed
   * `EventSource` is unreachable — that then reports itself fully instrumented. That is the
   * failure class being fixed, reintroduced. A reload is honest.
   */
  const awaitingReload = grantedAwaitingReload || (capture.kind === 'on' && state.instrumented === false);

  return { enable, setRecording, clearBuffer, reloadInspectedPage, status, awaitingReload };
}
