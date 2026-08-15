/**
 * MAIN-world entry point, injected at `document_start` (requirements §12 manifest).
 *
 * This file is the manifest entry and its basename is load-bearing: CRXJS keys emitted
 * scripts by basename, and an `index.ts` here would collide with `src/sw/index.ts` and
 * silently point the content script at the service worker chunk. See the comment in
 * `manifest.config.ts` before renaming anything.
 *
 * The MAIN-world script is a supply-chain surface in someone else's page (requirements
 * §11): it patches `fetch` only, holds the original reference before patching, preserves
 * page behaviour on every path, never evaluates page data, and never throws into page code.
 */

import { installFetchPatch, type FetchHost } from './fetch-patch';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage } from './protocol';

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
}

export const MARKER_VERSION = '0.1.0';

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
    installFetchPatch(host, {
      post(message: InjectMessage): void {
        try {
          host.postMessage(message, targetOrigin);
        } catch {
          // An opaque-origin document ("null") or a page that replaced postMessage. The
          // capture is lost; the page is not.
        }
      },
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined') {
  installInject(window);
}
