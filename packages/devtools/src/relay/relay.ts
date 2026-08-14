/**
 * ISOLATED-world content script — the `window.postMessage` → `chrome.runtime` relay leg of
 * requirements §3 (Architecture).
 *
 * STUB. The tag check, the same-origin check, and the `event.source === window` check are live
 * now, so this stub is never a wider surface than the finished relay (requirements §11:
 * "Messages crossing the postMessage boundary are tagged, origin-checked, and shape-validated
 * on the receiving side"). Everything that passes those checks is currently dropped: there is
 * no `chrome.runtime.connect` port to the service worker until the capture layer lands.
 */

const MESSAGE_SOURCE = 'agui-dt';

interface TaggedMessage {
  source: typeof MESSAGE_SOURCE;
  [key: string]: unknown;
}

function isTaggedMessage(data: unknown): data is TaggedMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === MESSAGE_SOURCE
  );
}

window.addEventListener('message', (event: MessageEvent): void => {
  // Only accept messages this frame posted to itself — not from an embedded iframe or opener.
  if (event.source !== window) {
    return;
  }
  // Requirements §11: origin-checked. `window.location.origin` is the injected page's own
  // origin; a MAIN-world post from this frame always matches it.
  if (event.origin !== window.location.origin) {
    return;
  }
  if (!isTaggedMessage(event.data)) {
    return;
  }
  // Dropped. Forwarding over a `chrome.runtime` port arrives with the capture layer.
});

export {};
