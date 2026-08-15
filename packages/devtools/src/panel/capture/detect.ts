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
 * disagreeing is a real maintenance cost this accepts; the mitigation is that everything this
 * function drives is wording on an offer to enable capture, never a claim about contents — which
 * is why the banner it feeds says "an event stream was seen" and not "AG-UI was detected".
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

/**
 * The framework fingerprint, evaluated in the inspected page by `probeFramework`.
 *
 * Written as a string because that is what `inspectedWindow.eval` takes, and in ES5 style because
 * it runs in whatever the page's context is rather than in the panel's bundle. It reads one DOM
 * attribute and returns it; it calls nothing, touches no page state, and makes no request.
 */
const PROBE_EXPRESSION =
  "(function () { var el = document.querySelector('[ng-version]'); " +
  "return el ? el.getAttribute('ng-version') : null; })()";

/**
 * A plausible version string, and short enough to sit in a table cell.
 *
 * The inspected page controls every byte of what the probe returns and is not trusted, so the
 * value is re-checked here rather than where it was read: the label goes on screen.
 */
const NG_VERSION = /^[0-9][0-9a-z.+-]{0,20}$/i;

/**
 * Identify the inspected page's framework. Resolves to null when unknown or unavailable.
 *
 * This is NOT an AG-UI signal and must never be used as one. AG-UI is a wire protocol: it
 * specifies nothing in the DOM, so no markup can tell you an app speaks it — which is exactly why
 * requirements §4.1 chose content-based detection, so the tool works "on a custom endpoint at
 * /v3/chat, on a framework nobody has heard of". Requirements §4.3 gives this its actual job: the
 * fingerprint LABELS THE SESSION, never gates capture. It reaches the Session tab and stops there.
 *
 * `ng-version` is the only fingerprint design §4a's measurement supports. On a production Angular
 * app it was present in the DOM at page load, while `window.ng` and `getAllAngularRootElements`
 * were stripped by the production build, and the React DevTools hook was present — reading that
 * would have labelled that Angular app React. So one attribute, and nothing else.
 */
export function probeFramework(): Promise<string | null> {
  const evalFn = chrome.devtools?.inspectedWindow?.eval;
  if (typeof evalFn !== 'function') return Promise.resolve(null);

  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      PROBE_EXPRESSION,
      (result: unknown, exceptionInfo?: unknown) => {
        resolve(threw(exceptionInfo) ? null : readFramework(result));
      },
    );
  });
}

/**
 * Did the eval fail?
 *
 * `exceptionInfo` is documented as details IF an exception occurred, and DevTools passes nothing
 * when none did — but reading its mere presence as failure would leave the probe silently dead if
 * a Chrome release ever passed a cleared object instead. The flags decide, not the argument count.
 */
function threw(exceptionInfo: unknown): boolean {
  if (exceptionInfo === undefined || exceptionInfo === null) return false;
  if (typeof exceptionInfo !== 'object') return true;
  const info = exceptionInfo as { isError?: unknown; isException?: unknown };
  return Boolean(info.isError) || Boolean(info.isException);
}

function readFramework(result: unknown): string | null {
  if (typeof result !== 'string' || !NG_VERSION.test(result)) return null;
  return `Angular ${result}`;
}
