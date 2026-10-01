/**
 * The MAIN-world half of the Signals view (design G5) and the UI tab (UI inspector U5): hear a
 * Threadplane app's devtools reports — signals reports and render reports, routed by `kind` — and
 * pass them on.
 *
 * A Threadplane app in development dispatches `CustomEvent('threadplane:devtools', { detail })` on
 * its own `window`, fire-and-forget (G3). This listens for exactly that name — no other event's
 * detail is ever read — validates the detail, and posts a COPY across the same `postMessage`
 * boundary the frames use.
 *
 * THREE PROPERTIES, each load-bearing:
 *
 *  1. NEVER THROWS INTO THE PAGE'S DISPATCH. The listener runs inside the app's own
 *     `dispatchEvent`, synchronously, in the middle of its state update. Everything is wrapped,
 *     including the post: a page that replaced `postMessage`, a detail with a throwing getter, a
 *     `Proxy` with hostile traps — none of them escapes.
 *  2. SAYS NOTHING UNPROMPTED. Registering a listener is not observable from the page, and the
 *     only `postMessage` this makes is in answer to the page's own dispatch. A page that never
 *     dispatches the event never hears from it — the property `e2e/quiet-page.spec.ts` holds.
 *  3. POSTS A COPY, RE-CHECKED. The detail is the page's object and a getter may answer the
 *     validator one thing and the copy another, so the copy is validated again before it leaves.
 *     The copy is plain data, which is also what `postMessage` can clone without running page code.
 *
 * SUBFRAMES ARE CAPTURED. The MAIN-world script runs with `all_frames` on every granted origin,
 * so each frame installs its own listener on its own `window` and posts to its own relay, which
 * accepts only `event.source === window`. Agent chat is often embedded in an iframe — the case
 * capture was built for — so a Threadplane agent in one is reported like one in the top frame.
 * Each report carries a per-instance `agent` id, so agents in different frames never merge.
 *
 * THE CLOCK. A report's `tMs` is the hook's `performance.now()` in the dispatching document, and
 * every frame this script captures is stamped with `performance.now()` in the SAME document
 * (`install.ts`'s `monotonicNow`). The two are one clock only within a document: each frame of a
 * page has its own time origin, so a top-frame report and a subframe's wire frame are not
 * comparable by `tMs`.
 */

import { cloneRenderReport, isRenderReport } from '../core/signals/render-report';
import {
  cloneReport,
  isThreadplaneReport,
  THREADPLANE_DEVTOOLS_EVENT,
} from '../core/signals/report';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage } from './protocol';

/** What the listener needs from a window. `window` satisfies it. */
export interface SignalsTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * Which report a detail claims to be, from its OWN `kind` (U4): absent is the §14.3 signals report,
 * `'render'` is the render report, and anything else — another string, `undefined` spelled out, an
 * inherited `kind` — is neither and is dropped. Only the routing; each validator then checks the
 * whole shape (a signals report may not carry `kind`, a render report must carry exactly
 * `'render'`), so a getter that answers this read differently from the validator's gains nothing.
 */
function kindOf(detail: unknown): 'signals' | 'render' | null {
  if (typeof detail !== 'object' || detail === null) return null;
  if (!Object.prototype.hasOwnProperty.call(detail, 'kind')) return 'signals';
  return (detail as { kind?: unknown }).kind === 'render' ? 'render' : null;
}

export function installSignalsListener(
  target: SignalsTarget,
  post: (message: InjectMessage) => void,
): void {
  target.addEventListener(THREADPLANE_DEVTOOLS_EVENT, (event: Event): void => {
    try {
      // Read once. A plain `Event` of this name has no `detail` and is rejected below.
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      switch (kindOf(detail)) {
        case 'signals': {
          if (!isThreadplaneReport(detail)) return;
          const report = cloneReport(detail);
          if (!isThreadplaneReport(report)) return;
          post({ source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION, kind: 'signals', report });
          return;
        }
        case 'render': {
          if (!isRenderReport(detail)) return;
          const report = cloneRenderReport(detail);
          if (!isRenderReport(report)) return;
          post({ source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION, kind: 'render', report });
          return;
        }
        case null:
          return;
      }
    } catch {
      // A hostile detail, or a page that broke `postMessage`. The report is lost; the page's own
      // dispatch carries on as if nothing listened — which, as far as it can tell, nothing did.
    }
  });
}
