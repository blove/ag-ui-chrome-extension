/**
 * MAIN-world entry point, injected at `document_start` (requirements §12 manifest).
 *
 * This file is the manifest entry and its basename is load-bearing: CRXJS keys emitted
 * scripts by basename, and an `index.ts` here would collide with `src/sw/index.ts` and
 * silently point the content script at the service worker chunk. See the comment in
 * `manifest.config.ts` before renaming anything.
 *
 * The MAIN-world script is a supply-chain surface in someone else's page (requirements
 * §11): it patches `fetch`, `XMLHttpRequest` and `EventSource`, holds each original
 * reference before patching, preserves page behaviour on every path, never evaluates page
 * data, and never throws into page code.
 *
 * All three transports share one clock and one connection-id factory. The shared factory is
 * load-bearing: the service worker keys its per-connection state by `connId` alone, so two
 * transports numbering their own connections from 1 would collide on `c1` and interleave two
 * unrelated streams into one record.
 */

import { installEventSourcePatch, type EventSourceConstructorLike } from './eventsource-patch';
import { installFetchPatch, type FetchHost } from './fetch-patch';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage } from './protocol';
import { installXhrPatch, type XhrConstructorLike } from './xhr-patch';

export interface AguiDevtoolsMarker {
  /** Extension version, so a page-side hook can reason about capability. */
  version: string;
  /** postMessage protocol version, so the relay and a page hook agree on the shape. */
  protocol: number;
  /** The tag on every message this script posts. */
  source: string;
}

declare global {
  interface Window {
    __AGUI_DEVTOOLS__?: AguiDevtoolsMarker;
  }
}

/** What `installInject` needs from a window. `window` satisfies it; tests pass a stand-in. */
export interface InjectHost extends FetchHost {
  postMessage(message: unknown, targetOrigin: string): void;
  readonly location: { readonly origin: string };
  __AGUI_DEVTOOLS__?: AguiDevtoolsMarker;
  /**
   * Optional because a host may genuinely lack them: jsdom implements no `EventSource` at all,
   * and a worker-like scope has no `XMLHttpRequest`. A real browser window has both, and the
   * `installs all three transports` test asserts both get patched when they are present — an
   * entry point that quietly stops installing one is the failure mode this shape guards.
   */
  XMLHttpRequest?: XhrConstructorLike;
  EventSource?: EventSourceConstructorLike;
}

export const MARKER_VERSION = '0.1.0';

/**
 * Re-state `conn-open` with the first `frames` message of each connection.
 *
 * The ISOLATED-world relay is no longer emitted as a direct content script — it has imports, so
 * CRXJS wraps it in a loader that `await import(...)`s its chunk, and that resolution goes
 * through `chrome.runtime.getURL` and a web-accessible-resource fetch. Its `message` listener
 * therefore registers slightly AFTER `document_start`, while this MAIN-world script resolves a
 * plain relative import and usually wins the race. `EventSource` posts `conn-open` synchronously
 * in its constructor and XHR posts at `readyState === 2`, so an inline script at the top of a
 * page can produce a `conn-open` inside that window, when nothing is listening yet.
 *
 * Losing it is not one lost message: `conn-open` is the message that carries `input`, the
 * `RunAgentInput`. Without it the service worker sees frames for a connection it never opened
 * and the run surfaces as `run-started-without-input` — a finding that reads as a defect in the
 * USER'S server rather than in our capture. A misattributed finding is worse than a missing one.
 *
 * So the open is posted again, immediately before the first batch of frames, by which time the
 * relay is certainly listening. It is a plain `conn-open` message and goes through exactly the
 * same guard as the first one; the service worker keys on `connId` and ignores an open for a
 * connection it already has. Nothing is page-observable and no handshake is involved.
 */
function withOpenRestated(post: (message: InjectMessage) => void): (message: InjectMessage) => void {
  /** Connections whose open has been posted but not yet re-stated. */
  const pending = new Map<string, InjectMessage>();
  return (message: InjectMessage): void => {
    if (message.kind === 'conn-open') {
      pending.set(message.connId, message);
    } else if (message.kind === 'frames') {
      const open = pending.get(message.connId);
      if (open !== undefined) {
        pending.delete(message.connId);
        post(open);
      }
    } else {
      // A connection that closed, or turned out to be binary, has no frames left to ride with.
      pending.delete(message.connId);
    }
    post(message);
  };
}

/** Requirements §5.5: one monotonic clock for every transport. */
const monotonicNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? (): number => performance.now()
    : (): number => Date.now();

/**
 * Narrowing helper. `EventSourceScope` requires a non-optional `EventSource`, which an
 * `InjectHost` cannot declare, so the presence check and the narrowing are one step.
 */
function hasEventSource(
  host: InjectHost,
): host is InjectHost & { EventSource: EventSourceConstructorLike } {
  return host.EventSource !== undefined;
}

/**
 * Install the marker and the capture patch. Returns `false` when this window already has
 * them — the manifest injects into every frame and a page can be re-injected (bfcache
 * restore, `chrome.scripting.registerContentScripts` after an origin is granted at runtime
 * per requirements §12), and patching twice would double every captured frame.
 *
 * Never throws: a document_start script that throws is a broken page.
 */
export function installInject(host: InjectHost): boolean {
  try {
    if (host.__AGUI_DEVTOOLS__ !== undefined) return false;
    host.__AGUI_DEVTOOLS__ = {
      version: MARKER_VERSION,
      protocol: PROTOCOL_VERSION,
      source: AGUI_DT_SOURCE,
    };
    // Read once, at install time, so a page that later rewrites `location` cannot retarget
    // our messages at another origin.
    const targetOrigin = host.location.origin;
    const send = (message: InjectMessage): void => {
      try {
        host.postMessage(message, targetOrigin);
      } catch {
        // An opaque-origin document ("null") or a page that replaced postMessage. The
        // capture is lost; the page is not.
      }
    };
    // One sink for all three transports, so the re-statement above happens in exactly one
    // place rather than three times over in the patches.
    const post = withOpenRestated(send);
    let connCounter = 0;
    const nextConnId = (): string => {
      connCounter += 1;
      return `c${String(connCounter)}-${Math.random().toString(36).slice(2, 10)}`;
    };

    installFetchPatch(host, { post, now: monotonicNow, newConnId: nextConnId });
    if (host.XMLHttpRequest !== undefined) {
      installXhrPatch({ target: host.XMLHttpRequest, post, now: monotonicNow, nextConnId });
    }
    // §5.3: `EventSource` cannot carry a POST body, so AG-UI over it is rare — but it is
    // specified, and a module that looks installed while being dead code is worse than either
    // shipping it or deleting it.
    if (hasEventSource(host)) {
      installEventSourcePatch({ scope: host, post, now: monotonicNow, nextConnId });
    }
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined') {
  installInject(window);
}
