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
import { captureOn, setRecording as setRecordingAction } from '../model/store';
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

export interface LiveCapture {
  /** Request the origin grant and turn capture on. Call from a click — Chrome requires it. */
  enable: () => void;
  setRecording: (recording: boolean) => void;
  /** Tell the worker to drop this tab's buffer. Paired with the toolbar's Clear. */
  clearBuffer: () => void;
  /** Reload the inspected page, which is what makes the capture hooks install. */
  reloadInspectedPage: () => void;
  status: EnableStatus;
  /** True once the grant succeeded and the page has not been reloaded from here yet. */
  awaitingReload: boolean;
}

function inspectedTabId(): number | null {
  const tabId = chrome.devtools?.inspectedWindow?.tabId;
  return typeof tabId === 'number' ? tabId : null;
}

export function useLiveCapture(store: PanelStore): LiveCapture {
  const state = usePanelState(store);
  const [status, setStatus] = useState<EnableStatus>(null);
  const [awaitingReload, setAwaitingReload] = useState(false);

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
      setAwaitingReload(true);
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
    setAwaitingReload(false);
    chrome.devtools?.inspectedWindow?.reload?.();
  }, []);

  return { enable, setRecording, clearBuffer, reloadInspectedPage, status, awaitingReload };
}
