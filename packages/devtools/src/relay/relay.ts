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
    case 'capture-installed':
      // Forwarded through the same rebuild as everything else, and deliberately not exempted
      // from any check above: this is the message the panel reads as "this document has capture
      // hooks in it", so a forged one would make the panel claim capture is live where it is
      // not. Only `tMs` survives — there is nothing else the worker needs to know.
      return { v: PROTOCOL_VERSION, kind: 'capture-installed', tMs: message.tMs };
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

export {};
