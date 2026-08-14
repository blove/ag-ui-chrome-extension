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
 * Passive AG-UI detection over the DevTools network log (design decision P5).
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
