/**
 * A page on a granted origin observes NOTHING from this extension.
 *
 * WHAT WAS WRONG. The panel needs to know whether the capture layer is present in the document
 * it is inspecting — absence of that signal is what produces the "you must reload" warning, and
 * that warning is the fix for a real defect (see `capture-layer-loaded.spec.ts`). The signal used
 * to be a `window.postMessage` the MAIN-world script sent at `document_start`, twice:
 *
 *     { source: 'agui-dt', v: 1, kind: 'capture-installed', tMs: <number> }
 *
 * `window.postMessage` targets the page's own window. The ISOLATED-world relay picked it up —
 * and so did every `message` listener the page had, which many apps have for iframe
 * communication. So every load of every page on a granted origin announced, unprompted, that
 * this extension was watching. Not only AG-UI pages: every page. Before that design a page could
 * only find out by actively PROBING (`Function.prototype.toString.call(window.fetch)` is not
 * `[native code]`), or once AG-UI traffic started and `agui-dt` messages were on the bus anyway.
 * Push replaced pull, and the blast radius went from AG-UI pages to all pages.
 *
 * The concern is not fingerprinting. It is an application that behaves differently when it can
 * tell it is being inspected — the one thing a devtools product must never cause. Requirements
 * §11 asks for the extension to be unobtrusive.
 *
 * WHAT THIS ASSERTS. The signal now travels the relay's `chrome.runtime` port, in the ISOLATED
 * world, which the page cannot see. So: a page that makes no AG-UI request at all, on an origin
 * where the content scripts really are installed, must see zero `agui-dt` messages — while the
 * worker state the panel reads still reports the document as loaded.
 *
 * WHY IT CANNOT PASS VACUOUSLY. Three independent ways this could be a test of nothing, each
 * closed by an assertion rather than by care:
 *
 *   1. The collector never attached, or attached to the wrong window → the spec posts a control
 *      message of its own and asserts the collector caught it. A dead listener fails here.
 *   2. The content scripts never ran on this page, so there was nothing to hear → the spec
 *      asserts `window.__AGUI_DEVTOOLS__` is present (the MAIN world ran) and that the worker
 *      reports the document loaded (the ISOLATED world ran). Silence from an extension that is
 *      not there proves nothing.
 *   3. The collector attached too late to hear a `document_start` message → it is installed via
 *      `addInitScript`, which Chrome evaluates on document creation, and the page's own inline
 *      `<head>` script is a second, later witness. Both are asserted, and the mutation check
 *      recorded in the PR confirms a re-added page-visible post makes this file fail.
 *
 * `localhost` is used deliberately: D3 statically registers the localhost family, so the content
 * scripts are in this document from its first load with no grant to arrange. The non-localhost
 * grant path is `capture-layer-loaded.spec.ts`'s subject, and it observes the same silence for
 * the same reason.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import { launchWithExtension, readCapture, type CaptureSnapshot } from './fixtures.js';

/**
 * What the collector records. `data` is whatever crossed the bus; `origin` is kept so a message
 * from somewhere other than this document would be distinguishable rather than lumped in.
 */
interface SeenMessage {
  origin: string;
  data: unknown;
}

interface QuietProbe {
  installedAt: number;
  seen: SeenMessage[];
}

declare global {
  interface Window {
    __QUIET_PROBE__?: QuietProbe;
    __AGUI_DEVTOOLS__?: { source?: string };
  }
}

/** Our own message, so a listener that never fires cannot look like a silent extension. */
const CONTROL = 'harness-control-probe';

/** How long the page is left alone with the extension before the buffer is read. */
const LISTEN_MS = 1500;

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let page: Page;
let quietUrl: string;

let probe: QuietProbe = { installedAt: 0, seen: [] };
let markerPresent = false;
let inlineScriptRan = false;
let snapshot: CaptureSnapshot;

test.beforeAll(async () => {
  // The harness server is started but never asked for anything: the quiet page has no client on
  // it. It exists so the page server can be constructed the same way every other spec does.
  harness = await startHarnessServer();
  pageServer = await startPageServer({ agentUrl: harness.url });
  quietUrl = new URL('/quiet.html', pageServer.url).href;

  ({ ctx } = await launchWithExtension());
  page = await ctx.newPage();

  /*
   * THE COLLECTOR, installed before the document exists.
   *
   * `addInitScript` is evaluated by Chrome when the execution context is created, which is ahead
   * of the page's own scripts. That is the earliest a page-side observer can be, and it is the
   * position a real page's first inline `<head>` script is approximating. If the extension speaks
   * at `document_start` at all, this hears it.
   */
  await page.addInitScript(() => {
    const probeState: QuietProbe = { installedAt: Date.now(), seen: [] };
    window.__QUIET_PROBE__ = probeState;
    window.addEventListener('message', (event: MessageEvent) => {
      probeState.seen.push({ origin: event.origin, data: event.data as unknown });
    });
  });

  await page.goto(quietUrl);
  await page.waitForLoadState('load');

  inlineScriptRan =
    (await page.evaluate(() => document.documentElement.getAttribute('data-quiet-page'))) === 'ran';
  markerPresent = await page.evaluate(() => window.__AGUI_DEVTOOLS__ !== undefined);

  // Sit on the page doing nothing, which is what the case under test is. The old announcement
  // was posted at install and again on the next task, so anything on a timer lands well inside
  // this window.
  await page.waitForTimeout(LISTEN_MS);

  // Prove the collector is alive, from the page's own context, on the same bus the extension
  // would have used. A broken selector or a listener that never attached dies here rather than
  // returning an empty array that looks like success.
  await page.evaluate((tag: string) => {
    window.postMessage({ source: tag, note: 'the collector must catch this' }, window.origin);
  }, CONTROL);
  await page.waitForFunction(
    (tag: string) =>
      (window.__QUIET_PROBE__?.seen ?? []).some(
        (entry) => (entry.data as { source?: unknown } | null)?.source === tag,
      ),
    CONTROL,
    { timeout: 5_000 },
  );

  probe = await page.evaluate(
    () => window.__QUIET_PROBE__ ?? { installedAt: 0, seen: [] as SeenMessage[] },
  );
  snapshot = await readCapture(ctx);
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test('the fixture is real: the quiet page ran and the extension is in it', () => {
  // Without these, "the page saw nothing" would be satisfied by a page that never loaded, or by
  // a build with no content scripts in it — silence from an absent extension proves nothing at
  // all. This is the assertion that makes the rest of the file mean something.
  expect(inlineScriptRan).toBe(true);
  expect(markerPresent).toBe(true);
});

test('the collector is genuinely listening, so an empty result would be a finding', () => {
  expect(probe.installedAt).toBeGreaterThan(0);
  const control = probe.seen.filter(
    (entry) => (entry.data as { source?: unknown } | null)?.source === CONTROL,
  );
  expect(control).toHaveLength(1);
});

test('the page hears nothing at all from the extension', () => {
  // THE DELIVERABLE. Everything the page's bus carried, minus the one message the harness put
  // there itself. On a page that makes no AG-UI request this must be empty — the extension has
  // no reason to speak and now has no way to.
  const unexplained = probe.seen.filter(
    (entry) => (entry.data as { source?: unknown } | null)?.source !== CONTROL,
  );
  expect(unexplained).toEqual([]);
});

test('and nothing tagged agui-dt in particular, which is what named the extension', () => {
  // Stated separately from the blanket assertion above so a failure says WHICH property broke.
  // `agui-dt` is the tag `capture-installed` carried, and the string a page would grep for.
  const tagged = probe.seen.filter(
    (entry) => (entry.data as { source?: unknown } | null)?.source === 'agui-dt',
  );
  expect(tagged).toEqual([]);
});

test('while the panel-facing worker state still reports the document as loaded', () => {
  // The other half, and the reason this is a trade rather than a deletion: the signal the panel
  // depends on still arrives. It came over the relay's `chrome.runtime` port, which is why the
  // assertion above and this one are both true at once.
  expect(snapshot.loaded).toBe(true);
});

test('and nothing was captured, because the page never made a request', () => {
  // Loaded is not capturing. A page with the capture layer in it and no AG-UI traffic yields an
  // empty buffer, which is exactly the state the tri-state banner has to describe without
  // claiming either success or breakage.
  expect(snapshot.records).toEqual([]);
  expect(snapshot.requests).toEqual([]);
});
