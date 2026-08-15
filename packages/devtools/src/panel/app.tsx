import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PanelStore } from './model/store';
import { raiseSignal, selectTab, setCapture, setFramework } from './model/store';
import { useLiveCapture, type EnableStatus } from './capture/use-live-capture';
import { usePanelState } from './model/use-panel-state';
import { applyLoaded } from './import/apply-loaded';
import { DropZone } from './import/drop-zone';
import type { LoadedCapture } from './import/load-jsonl';
import { loadJsonl } from './import/load-jsonl';
import { observeNetwork, probeFramework } from './capture/detect';
import { CaptureBanner } from './capture/capture-status';
import { ScopeBar } from './shell/scope-bar';
import { RunSelector } from './shell/run-selector';
import { TabStrip, tabPanelId } from './shell/tab-strip';
import { Toolbar } from './shell/toolbar';
import { Timeline } from './tabs/timeline/timeline';
import { Messages } from './tabs/messages/messages';
import { Runs } from './tabs/runs/runs';
import { State } from './tabs/state/state';
import { Session } from './tabs/session/session';

/**
 * Resolve the inspected page's origin, so the capture banner can name it.
 *
 * `chrome.devtools.inspectedWindow.eval` runs in the page; reading `location.origin` is the
 * whole of it. There is no `tabs` permission and no fetch — requirements §11.
 *
 * Absent outside DevTools (unit tests, the screenshot harness), in which case capture stays
 * `unsupported` and the banner says so rather than naming a page that is not there.
 */
function resolveOrigin(onOrigin: (origin: string) => void): void {
  const evalFn = chrome.devtools?.inspectedWindow?.eval;
  if (typeof evalFn !== 'function') return;
  chrome.devtools.inspectedWindow.eval('location.origin', (result: unknown) => {
    if (typeof result === 'string' && result !== '' && result !== 'null') onOrigin(result);
  });
}

/**
 * Why Enable did not turn capture on.
 *
 * Each branch names the actual cause. "Something went wrong" would put the user back where the
 * capture banner started them — unable to tell a refusal from a broken extension.
 */
function enableFailure(status: Exclude<EnableStatus, null>): string {
  switch (status.kind) {
    case 'denied':
      return 'Access to this origin was declined, so capture stayed off. Press Enable again to retry, or import a .agui.jsonl capture from the Session tab.';
    case 'unavailable':
      return 'This panel is not running inside DevTools, so there is no origin to grant. Import a .agui.jsonl capture from the Session tab instead.';
    case 'error':
      return `Chrome refused the permission request: ${status.message}`;
    case 'granted':
      return '';
  }
}

/** The bytes an imported capture was decoded from, kept so a re-decode is possible. */
interface RetainedSource {
  text: string;
  filename: string;
  /** The moment of the ORIGINAL import. A re-decode is not a new import and must not say it is. */
  importedAtMs: number;
}

/**
 * The panel shell: three fixed bands (design §2) over the active tab.
 *
 * Every component reads the store explicitly rather than through context, so each is
 * constructible in a test without this component.
 */
export function App({ store }: { store: PanelStore }): JSX.Element {
  const state = usePanelState(store);
  const live = useLiveCapture(store);

  /*
   * The raw JSONL behind the current capture.
   *
   * `PanelState` holds the decoded model, not the bytes, and `toggleExpandChunks` only flips a
   * flag — the contract note on it says rebuilding is the caller's job. `App` is that caller, and
   * these are the bytes it rebuilds from. A ref rather than state: nothing renders it, so writing
   * it must not schedule a render.
   */
  const retained = useRef<RetainedSource | null>(null);
  const appliedExpandChunks = useRef(state.expandChunks);

  // Name the inspected origin, so the capture banner can offer to enable capture ON something.
  useEffect(() => {
    let live = true;
    resolveOrigin((origin) => {
      if (!live) return;
      store.update((s) =>
        s.capture.kind === 'unsupported'
          ? setCapture(s, { kind: 'off', origin, signal: { level: 'none' } })
          : s,
      );
    });
    return () => {
      live = false;
    };
  }, [store]);

  /*
   * Label the session with the page's framework — and label ONLY the session.
   *
   * Requirements §4.3: a framework fingerprint labels the session, never gates capture. It writes
   * `framework`, a field no capture decision reads, because AG-UI is a wire protocol with no DOM
   * footprint: an Angular page is no more likely to speak AG-UI than any other. Kept as its own
   * effect for the same reason — it neither waits on the origin nor touches the signal.
   */
  useEffect(() => {
    let live = true;
    void probeFramework().then((framework) => {
      if (live && framework !== null) store.update((s) => setFramework(s, framework));
    });
    return () => {
      live = false;
    };
  }, [store]);

  // The only detection path there is before capture is on, and it can say "an event stream
  // finished on this origin" and nothing more — it never claims the stream is AG-UI, never
  // decodes, and never produces a record. All it does is strengthen the wording on an offer that
  // was already on screen.
  useEffect(
    () => observeNetwork(() => store.update((s) => raiseSignal(s, { level: 'stream' }))),
    [store],
  );

  // Clear drops the capture; the bytes must go with it, or the next Expand-chunks toggle would
  // resurrect data the user asked to be rid of.
  const source = state.source;
  useEffect(() => {
    if (source.kind !== 'imported') retained.current = null;
  }, [source]);

  /*
   * Make Expand chunks mean something.
   *
   * `toggleExpandChunks` flips the flag and stops there, so without this the button would be a
   * no-op after the first import — pressed state changing, nothing on screen moving. Chunk
   * expansion happens inside the run builder, which means the only way to apply it is to replay
   * the capture, which is exactly what `loadJsonl` does.
   */
  const expandChunks = state.expandChunks;
  useEffect(() => {
    if (appliedExpandChunks.current === expandChunks) return;
    appliedExpandChunks.current = expandChunks;
    const held = retained.current;
    if (held === null) return;
    const loaded = loadJsonl(held.text, { expandChunks });
    store.update((s) => applyLoaded(s, loaded, held.filename, held.importedAtMs));
  }, [store, expandChunks]);

  const commit = (loaded: LoadedCapture, filename: string, text: string): void => {
    const importedAtMs = Date.now();
    retained.current = { text, filename, importedAtMs };
    appliedExpandChunks.current = store.get().expandChunks;
    store.update((s) => applyLoaded(s, loaded, filename, importedAtMs));
  };

  let body: JSX.Element;
  switch (state.tab) {
    case 'timeline':
      body =
        state.records.length === 0 ? (
          <section class="agui-empty" aria-label="No capture loaded">
            <h2 class="agui-empty__title">Nothing to inspect yet</h2>
            <p class="agui-empty__detail">
              Import a <code>.agui.jsonl</code> capture to inspect a stream. Requirements §10 makes
              this file the shareable bug report: it loads read-only with every tab working.
            </p>
            <DropZone store={store} onLoaded={commit} />
          </section>
        ) : (
          <Timeline store={store} />
        );
      break;
    case 'session':
      body = <Session store={store} onLoaded={commit} />;
      break;
    case 'runs':
      body = <Runs store={store} />;
      break;
    case 'state':
      body = <State store={store} />;
      break;
    case 'messages':
      body = <Messages store={store} />;
      break;
  }

  return (
    <div class="agui-app">
      {/* One `.agui-shell` around all three bands: the shared focus ring is written as
          `.agui-shell button:focus-visible`, so a band outside it has no visible focus at all. */}
      <div class="agui-shell">
        <div class="agui-shell__band">
          <ScopeBar store={store} />
          <RunSelector store={store} />
        </div>
        <TabStrip store={store} />
        <Toolbar
          store={store}
          onImport={() => store.update((s) => selectTab(s, 'session'))}
          onSetRecording={live.setRecording}
          onClear={live.clearBuffer}
        />
      </div>

      {/*
       * The partial-decode summary `applyLoaded` writes.
       *
       * It lives here rather than in the drop zone because the drop zone unmounts the moment the
       * user leaves the tab it was on, taking its per-line detail with it. A capture that half
       * decoded must never render as a clean one from any tab, so the summary is shell chrome.
       */}
      {state.loadError !== null && (
        <p class="agui-app__load-error" role="alert">
          {state.loadError}
        </p>
      )}

      <CaptureBanner store={store} onEnable={live.enable} />

      {/*
       * What Enable did, and what to do next.
       *
       * The grant is only half of turning capture on: the hooks install ahead of the page's own
       * scripts, so nothing is captured until the page reloads. A panel that granted and then
       * sat there would look broken to a user watching an already-running page — which is
       * exactly the failure the capture banner's reload note exists to prevent, so the button
       * is offered here rather than leaving the user to find it.
       */}
      {live.awaitingReload && (
        <p class="agui-app__note" role="status">
          Capture is on. It takes effect on the next page load — the hooks install before the
          page&rsquo;s own scripts run.{' '}
          <button type="button" class="agui-app__note-action" onClick={live.reloadInspectedPage}>
            Reload the inspected page
          </button>
        </p>
      )}

      {live.status !== null && live.status.kind !== 'granted' && (
        <p class="agui-app__note" role="alert">
          {enableFailure(live.status)}
        </p>
      )}

      <main class="agui-app__body">
        {/*
         * `tabIndex` because two of the five tab panels contain nothing focusable: without it a
         * keyboard user tabbing off the tab strip leaves the panel entirely and never reads the
         * content the tab they just selected is about.
         */}
        <div
          class="agui-app__tabpanel"
          role="tabpanel"
          id={tabPanelId(state.tab)}
          aria-labelledby={`agui-tab-${state.tab}`}
          tabIndex={0}
        >
          {body}
        </div>
      </main>
    </div>
  );
}
