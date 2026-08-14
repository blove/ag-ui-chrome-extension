/**
 * MAIN-world entry point, injected at `document_start` (requirements §12 manifest).
 *
 * STUB. The capture layer — requirements §5 (`inject.js`): §5.1 fetch `tee()`, §5.2
 * XMLHttpRequest `readyState === 3` slicing, §5.3 EventSource, §5.4 SSE framing via
 * `core/sse/parser`, §5.5 `performance.now()` frame timestamps — is NOT implemented in this
 * milestone. No page API is patched here, so on this build the extension cannot alter page
 * behaviour on any code path.
 *
 * When §5 lands, this module must hold original references to `fetch`, `XMLHttpRequest`, and
 * `EventSource` before patching, preserve original behaviour on every path including errors,
 * never evaluate page data, and post only tagged, same-origin messages to the relay
 * (requirements §11).
 */

export interface AguiDevtoolsMarker {
  /** Extension version, so a page-side hook can reason about capability. */
  version: string;
}

declare global {
  interface Window {
    __AGUI_DEVTOOLS__?: AguiDevtoolsMarker;
  }
}

const MARKER_VERSION = '0.1.0';

/**
 * Install the presence marker. Guarded because the manifest injects into all frames and a
 * page can be re-injected (bfcache restore, `chrome.scripting.registerContentScripts` after
 * an origin is granted at runtime per requirements §12).
 */
function installMarker(): void {
  if (window.__AGUI_DEVTOOLS__) {
    return;
  }
  window.__AGUI_DEVTOOLS__ = { version: MARKER_VERSION };
}

installMarker();
