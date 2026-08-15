/**
 * ISOLATED-world content script — the `window.postMessage` -> `chrome.runtime` leg of §3.
 *
 * This file is the security boundary (§11). Everything reaching it was written by the page: the
 * MAIN-world capture script posts here, but so can any script on the page, and so can an iframe
 * or an opener. The order below is the boundary, and it is deliberate:
 *
 *   1. `event.source === window` — the message was posted by this frame to itself. Rejects
 *      embedded iframes and openers before any field is read.
 *   2. `event.origin === window.location.origin` — same origin. Rejects a cross-origin poster.
 *   3. `isInjectMessage` — full shape validation, including the protocol version.
 *
 * Anything failing any check is dropped with **no logging**. A `console.warn` here would leak
 * the extension's presence to any page that opens the console — and worse, would echo attacker
 * content into a log the user reads. Silence is the feature.
 *
 * Nothing is ever posted back to the page, no property is added to any global, and no DOM node
 * is created, so a page cannot detect the relay by feature-probing.
 *
 * It has one thing of its own to say, at the bottom of this file: that the capture layer is
 * loaded in this document. That report goes up the `chrome.runtime` port and never near the page.
 */
import { isInjectMessage, PROTOCOL_VERSION, type InjectMessage } from '../inject/protocol';
import { RELAY_PORT_NAME, type RelayMessage } from '../sw/protocol';

let port: chrome.runtime.Port | null = null;

/**
 * Connect to the service worker, or return null if the extension context is gone (a reload or an
 * uninstall invalidates it and every `chrome.runtime` call throws).
 */
function connect(): chrome.runtime.Port | null {
  try {
    const next = chrome.runtime.connect({ name: RELAY_PORT_NAME });
    next.onDisconnect.addListener((): void => {
      // Reading `lastError` marks it consumed. Leaving it unread makes Chrome print
      // "Unchecked runtime.lastError" — console noise that is itself a detectable signal.
      if (chrome.runtime.lastError !== undefined) {
        // Deliberately consumed and deliberately not logged.
      }
      if (port === next) port = null;
    });
    port = next;
    return next;
  } catch {
    port = null;
    return null;
  }
}

/**
 * Deliver one message, reconnecting once if the port is dead.
 *
 * MV3 terminates an idle service worker at ~30 s (§15 risk row 1), which disconnects the port
 * without warning; the first `postMessage` after that throws. Reconnecting wakes the worker, so
 * the correct response is to retry, not to throw — a throw here would surface inside the page's
 * own `postMessage` dispatch.
 */
function send(message: RelayMessage): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = port ?? connect();
    if (active === null) return;
    try {
      active.postMessage(message);
      return;
    } catch {
      port = null;
    }
  }
}

/**
 * Screen out anything whose prototype is not the plain one, before the guard runs.
 *
 * A genuine `postMessage` delivers a structured clone, and a clone's prototype is always
 * `Object.prototype` — a page cannot smuggle a prototype chain across the boundary. Anything with
 * some other prototype therefore did not come from `postMessage` at all, and its inherited
 * properties may be accessors that would run inside `isInjectMessage`. `isInjectMessage` reads
 * properties, not own-properties, so without this line an object carrying the `source`/`v` tags
 * on its prototype validates. Three lines to make "hostile shapes never reach the port" true as
 * stated rather than true by luck.
 */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rebuild the message from known fields only.
 *
 * `isInjectMessage` proves the required fields are present; it does not prove the object carries
 * *nothing else*. Copying field by field means a hostile extra property — or a `__proto__` /
 * `constructor` key riding along on an otherwise valid message — never reaches the service
 * worker. `input` is the one value passed through by reference, because it is the page's own
 * `RunAgentInput` and the whole point of capturing it (verified fact 4) is to keep it verbatim.
 */
function toRelayMessage(message: InjectMessage): RelayMessage {
  switch (message.kind) {
    case 'conn-open':
      return {
        v: PROTOCOL_VERSION,
        kind: 'conn-open',
        connId: message.connId,
        tMs: message.tMs,
        method: message.method,
        url: message.url,
        contentType: message.contentType,
        input: message.input,
      };
    case 'frames':
      return {
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: message.connId,
        frames: message.frames.map((frame) =>
          frame.kind === 'keepalive'
            ? { kind: 'keepalive', tMs: frame.tMs, raw: frame.raw, comment: frame.comment }
            : { kind: 'event', tMs: frame.tMs, raw: frame.raw },
        ),
      };
    case 'conn-close':
      return {
        v: PROTOCOL_VERSION,
        kind: 'conn-close',
        connId: message.connId,
        tMs: message.tMs,
        reason: message.reason,
      };
    case 'binary':
      return {
        v: PROTOCOL_VERSION,
        kind: 'binary',
        connId: message.connId,
        tMs: message.tMs,
        contentType: message.contentType,
        bytes: message.bytes,
      };
  }
}

window.addEventListener('message', (event: MessageEvent): void => {
  try {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (!isPlainObject(data)) return;
    if (!isInjectMessage(data)) return;
    send(toRelayMessage(data));
  } catch {
    // A hostile payload can throw from a getter during validation or copying. Drop it.
  }
});

/**
 * Report that the capture layer is LOADED in this document — the panel's tri-state signal, moved
 * out of the page's reach.
 *
 * WHY IT IS HERE AND NOT IN THE MAIN WORLD. The MAIN-world script used to post a
 * `capture-installed` message at `document_start`, and `window.postMessage` targets the page's
 * own window: every page `message` listener saw it, and many pages have one. That announced the
 * extension, unprompted, on every load of every page on a granted origin — including the pages
 * that never make an AG-UI request. This file is the ISOLATED world; `chrome.runtime` is a
 * channel the page cannot see, read, or forge. Nothing about this call is page-observable.
 *
 * WHY AN EXPLICIT MESSAGE RATHER THAN THE PORT CONNECTION ITSELF. The port would be the cheaper
 * signal — the worker gets `tabId` and `frameId` off `port.sender` either way — but it cannot
 * carry the fact the worker actually needs. `markLoaded` REPLACES a top-level frame's record and
 * clears the subframes beneath it, because a new top-level document destroys them; that is only
 * correct for a genuinely new document. A port connection does not distinguish one from a
 * RECONNECT: `send` above reopens the port after MV3 terminates an idle worker (§15), and a
 * reconnect from the main frame would then wipe the still-live subframes' records. This message
 * is sent exactly once, at module evaluation, so its arrival means "a document just loaded here"
 * — which is precisely the fact the replace-on-navigation behaviour is keyed on. The identity
 * still comes from `port.sender`, i.e. from Chrome rather than from the message, so nothing about
 * WHICH frame this is can be influenced from the page side.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT — the accepted residual. This relay running proves the
 * content scripts were registered for this document, which is exactly the broken case the signal
 * exists to catch: a document already open when its origin was granted has no content scripts in
 * it at all, so nothing arrives here and the panel says so. It does NOT prove the MAIN-world
 * patches installed successfully — `installInject` swallows its own throw, and this report would
 * be sent regardless. That case is our own code under test rather than a configuration the user
 * can get into, and it self-corrects the instant any AG-UI request happens, because a `conn-open`
 * is proof the patches work. The panel's wording is weakened to match: it claims the capture
 * layer is LOADED here, never that the hooks are installed. If the claim is ever to be
 * strengthened, the way to do it at zero page-visible cost is for the MAIN world to record its
 * install result somewhere the ISOLATED world can read — the two worlds share the DOM, so a
 * detached node's attribute would do — and for this file to forward it. That is not built now:
 * it would trade a page-visible signal for a DOM-visible one, and the extra fact is worth less
 * than the simplicity.
 */
send({ v: PROTOCOL_VERSION, kind: 'capture-loaded' });

export {};
