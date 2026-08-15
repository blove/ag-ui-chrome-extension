const EVENT_STREAM = 'text/event-stream';

/**
 * Is this finished request an SSE response?
 *
 * `content-type` is the ONLY header this extension ever reads (requirements §11); the HAR
 * entry's `content.mimeType` is preferred because DevTools fills it in even when the header
 * list is empty.
 */
function isEventStream(request: chrome.devtools.network.Request): boolean {
  const mimeType = request.response.content.mimeType;
  if (typeof mimeType === 'string' && mimeType.toLowerCase().includes(EVENT_STREAM)) {
    return true;
  }
  return request.response.headers.some(
    (header) =>
      header.name.toLowerCase() === 'content-type' &&
      header.value.toLowerCase().includes(EVENT_STREAM),
  );
}

/**
 * Passive AG-UI detection over the DevTools network log (design decision P11, formerly P5).
 *
 * Under P11 this no longer gates anything: the offer to enable capture is unconditional, and a
 * detection here only strengthens the banner's wording. That is the correction P5 needed — it
 * assumed the panel could wait for traffic before offering, and a production AG-UI app sends none
 * until the user types.
 *
 * This is the WEAKER of the two detection paths, and deliberately so. The strong path is the
 * content classifier in `core/detect`, which reads live frames off the wire and can tell an
 * AG-UI stream from any other SSE stream. This one only ever sees *completed* responses through
 * `chrome.devtools.network`, never a live frame, so it can report "an SSE endpoint exists on
 * this origin" and NOTHING MORE — it cannot decode, cannot validate, and cannot distinguish
 * AG-UI from a progress-bar stream. Design §10 records that keeping the two paths from
 * disagreeing is a real maintenance cost P5 accepts; the mitigation is that everything this
 * function drives is an offer to enable capture, never a claim about the stream's contents.
 *
 * It also makes no request of its own — it observes a log DevTools already keeps
 * (requirements §11, no egress).
 *
 * Fires `onDetected` at most once per subscription; unsubscribe and resubscribe to re-arm
 * (which is what a navigation to a new origin should do). Returns the unsubscribe, which is
 * safe to call more than once, and a no-op unsubscribe when the DevTools APIs are absent —
 * the panel HTML is also opened outside DevTools by the screenshot harness.
 */
export function observeNetwork(onDetected: () => void): () => void {
  const event = chrome.devtools?.network?.onRequestFinished;
  if (event === undefined) {
    return () => {};
  }

  let live = true;
  const listener = (request: chrome.devtools.network.Request): void => {
    if (!live || !isEventStream(request)) return;
    live = false;
    event.removeListener(listener);
    onDetected();
  };

  event.addListener(listener);
  return () => {
    if (!live) return;
    live = false;
    event.removeListener(listener);
  };
}

/** What `PROBE_EXPRESSION` computes inside the inspected page. Both fields may be absent. */
type ProbeResult = { agui?: unknown; ngVersion?: unknown };

/**
 * The page-load fingerprint, evaluated in the inspected page by `probePageMarkers`.
 *
 * Written as a string because that is what `inspectedWindow.eval` takes, and in ES5 style because
 * it runs in whatever the page's context is rather than in the panel's bundle. It reads the DOM
 * and returns plain data; it calls nothing, touches no page state, and makes no request.
 *
 * The two things it looks for are the two that design §4a MEASURED on a production Angular AG-UI
 * app. `window.ng`, `window.getAllAngularRootElements` and the React DevTools hook are deliberately
 * not collected — see `probePageMarkers`.
 */
const PROBE_EXPRESSION = `(function () {
  var agui = null;
  var all = document.getElementsByTagName('*');
  for (var i = 0; i < all.length; i++) {
    var tag = all[i].tagName.toLowerCase();
    if (tag.indexOf('ag-ui-') === 0) { agui = tag; break; }
  }
  var ngEl = document.querySelector('[ng-version]');
  return { agui: agui, ngVersion: ngEl ? ngEl.getAttribute('ng-version') : null };
})()`;

/**
 * A custom element name, and short enough to sit in a sentence.
 *
 * The inspected page controls every byte of what the probe returns and is not trusted, so both
 * fields are re-checked here rather than at the point they were read: `detail` goes on screen.
 */
const AG_UI_TAG = /^ag-ui-[a-z0-9-]{1,40}$/;
const NG_VERSION = /^[0-9][0-9a-z.+-]{0,20}$/i;

function matched(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/**
 * Probe the inspected page for AG-UI and framework markers. Resolves to null when unavailable.
 *
 * This is the signal that makes P11 work. The network watcher above sees nothing until traffic
 * flows, and a production AG-UI app sends none until the user types — but its markup is on screen
 * from the first paint, so a page-load fingerprint IS available. Design §4a is the measured
 * ranking, and it is not the one requirements §4.3 predicted:
 *
 * - An `ag-ui-*` custom element is the strongest pre-traffic evidence there is, and unlike every
 *   framework signal it is AG-UI-specific rather than a statement about how the app was built.
 * - The `ng-version` attribute is reliable — present in the DOM of a production build.
 * - `window.ng` and `getAllAngularRootElements` are STRIPPED from production builds, so they fail
 *   on exactly the deployments that matter, and the React DevTools hook was measured present on an
 *   Angular app, which would label it React. All three rank below everything above and none may
 *   stand alone; since nothing ranks below THEM, alone is the only thing they could ever be. They
 *   are therefore never collected and never quoted, which is also why `detail` stays short enough
 *   to read.
 *
 * Never resolves to `{ level: 'none' }`: absence of markers is not evidence of absence of AG-UI —
 * that is the whole finding behind P11 — so "no markers" is `null`, a probe that added nothing,
 * and the caller's existing signal stands.
 */
export function probePageMarkers(): Promise<{ level: 'markers'; detail: string } | null> {
  const evalFn = chrome.devtools?.inspectedWindow?.eval;
  if (typeof evalFn !== 'function') return Promise.resolve(null);

  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      PROBE_EXPRESSION,
      (result: unknown, exceptionInfo?: unknown) => {
        resolve(exceptionInfo === undefined ? readMarkers(result) : null);
      },
    );
  });
}

function readMarkers(result: unknown): { level: 'markers'; detail: string } | null {
  if (typeof result !== 'object' || result === null) return null;
  const probe = result as ProbeResult;

  const parts: string[] = [];
  const agui = matched(probe.agui, AG_UI_TAG);
  if (agui !== null) parts.push(`${agui} element`);
  const ngVersion = matched(probe.ngVersion, NG_VERSION);
  if (ngVersion !== null) parts.push(`Angular ${ngVersion}`);

  // `·` rather than a comma: `detail` is quoted mid-sentence in the banner.
  return parts.length === 0 ? null : { level: 'markers', detail: parts.join(' · ') };
}
