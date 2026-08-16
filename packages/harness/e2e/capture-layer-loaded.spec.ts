/**
 * Granted is not loaded — the gap between a permission and a document that has our scripts.
 *
 * WHAT WAS BROKEN, AND WHY NO EXISTING TEST COULD SEE IT. The panel decided it was "capturing"
 * from `chrome.permissions.contains(origin)`. `chrome.scripting.registerContentScripts` affects
 * only FUTURE navigations, so a document that was already open when the origin was granted has
 * none of them in it: the panel said capture was on and nothing was captured. Three ways in — a
 * grant from a previous session, an extension reload with the page open, and a grant the user
 * never acts on. Measured in a real browser on the already-open page:
 * `Function.prototype.toString.call(window.fetch).includes('[native code]')` was `true`
 * (unpatched); after a reload it was `false`, and capture worked.
 *
 * This defect lives entirely in the gap between PERMISSION STATE and DOCUMENT STATE. A unit test
 * on the panel store cannot reach it: a store test supplies both facts itself and can only
 * confirm the mapping it was given. Every other spec in this suite navigates to its page AFTER
 * the extension is fully in place, so the two facts agree by construction and no assertion could
 * tell them apart. What this spec does differently is order: it opens the page FIRST, grants the
 * origin SECOND, and asserts on the state in between — the state the panel used to describe as
 * capturing.
 *
 * `app.test` is a real non-localhost hostname mapped to the harness server. The localhost family
 * is statically registered in the manifest, so on `localhost` the capture layer is loaded from a
 * document's very first load and the divergence being tested cannot exist there.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type { AguiEvent, CaptureRecord } from '@devtools/core/model/types';

import { SCENARIOS } from '../fixtures/index.js';
import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  distWithGrantedOrigin,
  launchWithExtension,
  readCapture,
  readSettledCapture,
  type CaptureSnapshot,
} from './fixtures.js';

const SCENARIO_NAME = 'happy';
const PROMPT = 'happy';
const APP_HOST = 'app.test';
const APP_ORIGIN_PATTERN = `http://${APP_HOST}/*`;

interface ChromeForRegistration {
  scripting: {
    getRegisteredContentScripts(): Promise<{ id: string; matches?: string[] }[]>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  };
}

/** The worker's own hook — see `src/sw/index.ts`, installed unconditionally. */
interface RegistrationHook {
  reconcileRegistrations(): Promise<void>;
}

/** Match patterns the worker currently has capture scripts registered for. */
async function registeredMatches(context: BrowserContext): Promise<string[]> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return sw.evaluate(async (): Promise<string[]> => {
    const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
    const registered = await api.scripting.getRegisteredContentScripts();
    return registered.flatMap((script) => script.matches ?? []);
  });
}

/**
 * Put the extension back to "granted, nothing registered yet" — the state this fixture needs the
 * page to be opened in.
 *
 * IT USED TO NEED NO SUCH THING, and that is the change worth understanding. The worker used to
 * register only on `chrome.permissions.onAdded`, which an unpacked extension's manifest host
 * permission never fires, so an origin granted this way stayed unregistered until this file
 * registered it by hand — and the hand-written registration WAS the fake grant. The worker now
 * reconciles at module scope on every spawn, so by the time a page could be opened the origin is
 * already registered and the ordering this spec is about no longer occurs on its own. Undoing the
 * registration reconstructs it faithfully: the permission is untouched, and the open document
 * genuinely has no content scripts in it.
 */
async function unregisterEverything(context: BrowserContext): Promise<void> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await sw.evaluate(async (): Promise<void> => {
    const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
    const registered = await api.scripting.getRegisteredContentScripts();
    await api.scripting.unregisterContentScripts({ ids: registered.map((script) => script.id) });
  });
}

/**
 * The grant taking effect, through the PRODUCT'S OWN path.
 *
 * `chrome.permissions.request` needs a real user gesture and raises a native dialog no automation
 * can accept, so the PROMPT is what is faked here — never the registration. This is the same
 * function the worker runs at boot and the same one the panel's "Register the capture scripts"
 * button asks for, so the registration under test is the shipped one rather than a restatement of
 * it in this file.
 */
async function registerForOrigin(context: BrowserContext): Promise<void> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await sw.evaluate(async (): Promise<void> => {
    const hook = (globalThis as { __AGUI_DT_TEST__?: RegistrationHook }).__AGUI_DT_TEST__;
    if (!hook) throw new Error('__AGUI_DT_TEST__ is not installed on the service worker.');
    await hook.reconcileRegistrations();
  });
}

function capturedEventTypes(records: CaptureRecord[]): string[] {
  return records
    .filter((record) => record.kind === 'event')
    .map((record) => String(record.event?.type ?? '<unparsed>'));
}

/** Is `window.fetch` still the browser's own? The measurement that found this defect. */
async function fetchIsNative(target: Page): Promise<boolean> {
  return target.evaluate(() =>
    Function.prototype.toString.call(window.fetch).includes('[native code]'),
  );
}

/**
 * Wait for the load report to land, and report what was there when the wait ended.
 *
 * Deliberately does NOT assert: a report that never arrives is a finding for the test that is
 * about it, not a `beforeAll` failure that takes the whole file down and reports the wrong name.
 */
async function waitForLoaded(context: BrowserContext, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await readCapture(context)).loaded) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runOnce(target: Page, prompt: string): Promise<void> {
  await target.fill('#prompt', prompt);
  await target.click('#run');
  await target.waitForFunction(
    () => {
      const status = document.getElementById('status')?.textContent;
      return status === 'done' || status === 'error';
    },
    { timeout: 30_000 },
  );
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let page: Page;
let appUrl: string;
let nativeBefore = false;
let nativeAfter = true;
let beforeReload: CaptureSnapshot;
let afterReload: CaptureSnapshot;
let registeredBeforePage: string[] = [];
let registeredAfterGrant: string[] = [];

test.beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use(SCENARIO_NAME);
  pageServer = await startPageServer({ agentUrl: harness.url });
  appUrl = pageServer.url.replace('http://localhost:', `http://${APP_HOST}:`);

  ({ ctx } = await launchWithExtension({
    dist: distWithGrantedOrigin(APP_ORIGIN_PATTERN),
    args: [
      `--host-resolver-rules=MAP ${APP_HOST} 127.0.0.1`,
      // `crypto.randomUUID`, which the real `@ag-ui/client` uses, exists only in a secure
      // context; `http://app.test:<port>` is not one by default.
      `--unsafely-treat-insecure-origin-as-secure=${appUrl.replace(/\/$/, '')}`,
    ],
  }));

  // The worker reconciles at boot, so wait for that to have happened and then undo it — the page
  // has to be opened while nothing is registered for its origin, which is what this fixture is.
  await expect
    .poll(async () => (await registeredMatches(ctx)).length, { timeout: 15_000 })
    .toBe(2);
  await unregisterEverything(ctx);
  registeredBeforePage = await registeredMatches(ctx);

  // THE PAGE IS OPENED FIRST, before anything is registered for its origin. This is the whole
  // fixture: the user had the app open, and then enabled capture on it.
  page = await ctx.newPage();
  await page.goto(appUrl);
  nativeBefore = await fetchIsNative(page);

  // ...and now the grant lands. Nothing about the open document changes.
  await registerForOrigin(ctx);
  registeredAfterGrant = await registeredMatches(ctx);

  await runOnce(page, PROMPT);
  // Read plainly, and deliberately: this document has no hooks, so there is no connection to
  // wait for and `readSettledCapture` could only time out. What keeps the emptiness below from
  // being merely an early read is `nativeBefore` — `window.fetch` is measured, in the page, to
  // still be the browser's own, so there is no patch that could have produced a frame to wait
  // for in the first place.
  beforeReload = await readCapture(ctx);

  // The one honest remedy, and the one the panel offers. Injecting into the open document
  // instead would leave it PARTIALLY instrumented — bundlers hoist `const f = window.fetch` at
  // module load, and an already-constructed `EventSource` is unreachable — while reporting
  // itself fully instrumented, which is this defect wearing a different hat.
  await page.reload();
  nativeAfter = await fetchIsNative(page);
  await waitForLoaded(ctx);
  await runOnce(page, PROMPT);
  afterReload = await readSettledCapture(ctx);
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test('the page under test is genuinely not localhost', () => {
  // Guards the fixture, not the product. On the localhost family the manifest registers the
  // content scripts statically, so the capture layer is loaded from a document's first load and the
  // divergence this spec is about cannot occur.
  const host = new URL(appUrl).hostname;
  expect(host).toBe(APP_HOST);
  expect(['localhost', '127.0.0.1', '0.0.0.0']).not.toContain(host);
  // And the ORDERING the fixture depends on really was constructed: nothing registered when the
  // page was opened, both scripts registered afterwards. Without this the assertions below would
  // pass for a page that had the capture layer all along and simply failed to report it.
  expect(registeredBeforePage).toEqual([]);
  expect(registeredAfterGrant).toEqual([APP_ORIGIN_PATTERN, APP_ORIGIN_PATTERN]);
});

test('a document open before the grant has no capture layer, and the state says so', () => {
  // The measurement that found this, asserted rather than remembered.
  expect(nativeBefore).toBe(true);
  // What the panel reads. Before this change there was nothing to read and the panel inferred
  // "capturing" from the permission — this is the exact moment it was lying.
  //
  // This assertion is now driven by the ISOLATED-world relay rather than by a MAIN-world
  // `postMessage`: an already-open document has NO content scripts at all, so the relay is not
  // running in it and nothing reports. The evidence moved worlds; the finding did not change.
  expect(beforeReload.loaded).toBe(false);
});

test('capture really does see nothing from that document, which is what makes the claim false', () => {
  // Not a formality: this is the proof that the flag tracks reality rather than being a second
  // thing to keep in sync. A whole run went through the page, and the ring buffer is empty.
  expect(beforeReload.records).toEqual([]);
  expect(beforeReload.requests).toEqual([]);
});

test('a reload loads the capture layer, and the panel-facing state flips with it', () => {
  expect(nativeAfter).toBe(false);
  expect(afterReload.loaded).toBe(true);
});

/*
 * The residual, closed by evidence rather than by assertion.
 *
 * `loaded` says the relay is running, which proves the content scripts were registered — not
 * that the MAIN-world patches installed. `nativeAfter` measures the patch directly, and the
 * records below are the standing proof: a captured run cannot happen without a working patch, and
 * it is what the panel's own claim rests on once traffic starts.
 */
test('and capture then delivers the run, so the flag and the buffer agree', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  expect(capturedEventTypes(afterReload.records)).toEqual(
    scenario.events.map((event: AguiEvent) => String(event.type)),
  );
  expect(afterReload.requests.length).toBe(1);
});
