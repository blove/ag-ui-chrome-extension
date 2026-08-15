/**
 * MAIN-world entry point, injected at `document_start` (requirements §12 manifest).
 *
 * TWO PROPERTIES OF THIS FILE ARE LOAD-BEARING. Both are enforced by `scripts/verify-build.ts`,
 * so breaking either fails `pnpm verify:build` rather than only failing in a browser.
 *
 * 1. THE BASENAME. CRXJS keys emitted scripts by basename, so an `index.ts` here would collide
 *    with `src/sw/index.ts` and silently point the content script at the service worker chunk.
 *    See the comment in `manifest.config.ts` before renaming anything.
 *
 * 2. NO EXPORTS. This entry is listed in `contentScripts.standaloneFiles` (`vite.config.ts`), so
 *    CRXJS builds it as one self-contained IIFE with every import inlined — no async loader, no
 *    separate chunk, and therefore no `web_accessible_resources` entry. That is what makes
 *    capture work on a runtime-granted non-localhost origin at all: a loader's
 *    `await import(<chunk>)` runs in the PAGE's world, where a chunk that is not web-accessible
 *    to that origin is blocked outright, and capture then never starts with no error anywhere.
 *
 *    Rollup gives an IIFE that has exports a named global to hang them on
 *    (`var inject = (function(exports){…})({})`). An export here would therefore put a
 *    `window.inject` on every page the extension touches — a fingerprinting surface §11 does not
 *    accept. The implementation lives in `./install`, which is bundled into this same file;
 *    that is where the unit tests import from.
 *
 * Running it synchronously, rather than from a loader's promise, also closes the window in which
 * a stream opened by a page's first inline script was invisible to capture: the patch is
 * installed before any page script runs.
 */
import { installInject } from './install';

if (typeof window !== 'undefined') {
  installInject(window);
}
