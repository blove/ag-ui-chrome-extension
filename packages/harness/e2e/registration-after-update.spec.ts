/**
 * A SECOND SESSION AGAINST AN EXISTING GRANT — the shape of every real user's second day, and the
 * case this suite could not reach by construction.
 *
 * WHAT WAS BROKEN. `src/sw/index.ts` called `chrome.scripting.registerContentScripts` from exactly
 * one trigger: `chrome.permissions.onAdded`. Chrome discards dynamically registered content
 * scripts when an extension is updated or reloaded, and KEEPS the host permission. So after any
 * update the origin was still granted, nothing was registered for it, and `onAdded` had nothing
 * left to fire about — capture died silently and permanently for every origin the user had ever
 * granted, and re-granting could not repair it because the origin was already granted. The only
 * escape was to revoke and re-grant, which nothing told them to do. The code stated the wrong
 * assumption out loud: its `catch` said `registerContentScripts` "persists across sessions by
 * default", which is true of a browser RESTART and false of an extension reload or update.
 *
 * Measured in the user's own Chrome on 2026-08-15, on an origin granted that morning:
 * `window.fetch` unpatched, `XMLHttpRequest.prototype.open` unpatched, `window.__AGUI_DEVTOOLS__`
 * absent — both before and after a page reload, which is what rules out the already-known "the
 * document was open before the grant landed" case.
 *
 * WHY NO TEST CAUGHT IT. Every e2e here installs a fresh extension and grants inside the test, so
 * `onAdded` always fired and the one trigger the worker had always ran. Nothing exercised a second
 * session against an existing grant.
 *
 * WHAT THIS DOES. It reproduces the post-update state on a real browser: the grant stays in place
 * (`distWithGrantedOrigin`, the same mechanism `non-localhost.spec.ts` uses), the registrations are
 * unregistered out from under the worker exactly as Chrome discards them, no permission event is
 * fired, and the worker's own boot path is run again. Then a page is loaded and a real run driven,
 * and capture has to deliver it.
 *
 * Assertions read worker state by evaluating INSIDE the service worker (design H4/H5) — the
 * DevTools panel is not reachable from Playwright — and the capture assertion goes through
 * `readSettledCapture`, so it waits on the connection closing rather than on a duration.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type { AguiEvent, CaptureRecord } from '@devtools/core/model/types';
import type { RegistrationState } from '@devtools/sw/protocol';

import { SCENARIOS } from '../fixtures/index.js';
import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  distWithGrantedOrigin,
  launchWithExtension,
  readSettledCapture,
  reconstruct,
  type CaptureSnapshot,
} from './fixtures.js';

const SCENARIO_NAME = 'happy';
const PROMPT = 'happy';

/** Not in the localhost family: the static manifest matches must not be what makes this pass. */
const APP_HOST = 'app.test';
const APP_ORIGIN_PATTERN = `http://${APP_HOST}/*`;

/** The slice of `chrome` these evaluations touch. The harness has no `@types/chrome`. */
interface ChromeForRegistration {
  permissions: { getAll(): Promise<{ origins?: string[] }> };
  scripting: {
    getRegisteredContentScripts(): Promise<{ id: string; matches?: string[] }[]>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  };
}

/** The worker's own test hook — see `src/sw/index.ts`, installed unconditionally. */
interface RegistrationHook {
  registration(): RegistrationState;
  reconcileRegistrations(): Promise<void>;
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let page: Page;
let appUrl: string;

/** After the worker's very first boot, with the origin granted and nothing yet registered. */
let atFirstBoot: { matches: string[]; granted: string[]; believed: RegistrationState };
/** After Chrome discarded the registrations, as an update does. */
let afterUpdate: { matches: string[]; granted: string[] };
/** After the worker's boot path ran a second time against that state. */
let afterReboot: { matches: string[]; believed: RegistrationState };
let capture: CaptureSnapshot;
let marker: unknown;

function capturedEventTypes(records: CaptureRecord[]): string[] {
  return records
    .filter((record) => record.kind === 'event')
    .map((record) => String(record.event?.type ?? '<unparsed>'));
}

test.beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use(SCENARIO_NAME);
  pageServer = await startPageServer({ agentUrl: harness.url });
  appUrl = pageServer.url.replace('http://localhost:', `http://${APP_HOST}:`);

  ({ ctx } = await launchWithExtension({
    dist: distWithGrantedOrigin(APP_ORIGIN_PATTERN),
    args: [
      `--host-resolver-rules=MAP ${APP_HOST} 127.0.0.1`,
      // `crypto.randomUUID`, which `@ag-ui/client` uses, exists only in a secure context.
      `--unsafely-treat-insecure-origin-as-secure=${appUrl.replace(/\/$/, '')}`,
    ],
  }));
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));

  /* --- 1. first boot: granted, and the worker registers with no event ------------------- */
  await expect
    .poll(
      async () =>
        (
          await sw.evaluate(async () => {
            const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
            const registered = await api.scripting.getRegisteredContentScripts();
            return registered.flatMap((script) => script.matches ?? []);
          })
        ).filter((match) => match === APP_ORIGIN_PATTERN).length,
      { timeout: 15_000 },
    )
    .toBe(2);
  atFirstBoot = await sw.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
    const hook = (
      globalThis as { __AGUI_DT_TEST__?: RegistrationHook }
    ).__AGUI_DT_TEST__;
    if (!hook) throw new Error('__AGUI_DT_TEST__ is not installed on the service worker.');
    const registered = await api.scripting.getRegisteredContentScripts();
    const permissions = await api.permissions.getAll();
    return {
      matches: registered.flatMap((script) => script.matches ?? []),
      granted: permissions.origins ?? [],
      believed: hook.registration(),
    };
  });

  /* --- 2. the update: Chrome discards the registrations, keeps the permission ----------- */
  afterUpdate = await sw.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
    const registered = await api.scripting.getRegisteredContentScripts();
    await api.scripting.unregisterContentScripts({
      ids: registered.map((script) => script.id),
    });
    const left = await api.scripting.getRegisteredContentScripts();
    const permissions = await api.permissions.getAll();
    return {
      matches: left.flatMap((script) => script.matches ?? []),
      granted: permissions.origins ?? [],
    };
  });

  /* --- 3. the second session: run the worker's boot path again, with no event ----------- */
  afterReboot = await sw.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
    const hook = (
      globalThis as { __AGUI_DT_TEST__?: RegistrationHook }
    ).__AGUI_DT_TEST__;
    if (!hook) throw new Error('__AGUI_DT_TEST__ is not installed on the service worker.');
    await hook.reconcileRegistrations();
    const registered = await api.scripting.getRegisteredContentScripts();
    return {
      matches: registered.flatMap((script) => script.matches ?? []),
      believed: hook.registration(),
    };
  });

  /* --- 4. and capture has to actually work ---------------------------------------------- */
  page = await ctx.newPage();
  await page.goto(appUrl);
  marker = await page.evaluate(
    () => (window as unknown as { __AGUI_DEVTOOLS__?: unknown }).__AGUI_DEVTOOLS__,
  );
  await page.fill('#prompt', PROMPT);
  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done', {
    timeout: 30_000,
  });
  capture = await readSettledCapture(ctx);
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test('the worker registers an origin granted before it booted, with no permission event', () => {
  // The fixture's whole premise: an unpacked extension receives its manifest host permissions at
  // load time and `permissions.onAdded` never fires, so this registration cannot have come from
  // the one trigger the worker used to have. It is the boot-time reconciliation, and nothing else.
  expect(atFirstBoot.granted).toContain(APP_ORIGIN_PATTERN);
  expect(atFirstBoot.matches).toEqual([APP_ORIGIN_PATTERN, APP_ORIGIN_PATTERN]);
  expect(atFirstBoot.believed).toEqual({ matches: [APP_ORIGIN_PATTERN], error: null });
});

test('the manifest’s static localhost family is not registered a second time', () => {
  // `chrome.permissions.getAll()` reports content-script matches among its origins — asserted
  // here rather than assumed, because the exclusion in the worker depends on it. A reconciliation
  // that took the list at face value would inject the capture layer twice on every localhost page.
  expect(atFirstBoot.granted).toContain('http://localhost/*');
  expect(atFirstBoot.matches).not.toContain('http://localhost/*');
  expect(atFirstBoot.believed.matches).not.toContain('http://localhost/*');
});

test('an update leaves the grant in place and the registrations gone', () => {
  // The state the user was left in, permanently. Guards the fixture: if the unregister silently
  // did nothing, every assertion below would pass for the wrong reason and this spec would be as
  // blind to the defect as the rest of the suite was.
  expect(afterUpdate.matches).toEqual([]);
  expect(afterUpdate.granted).toContain(APP_ORIGIN_PATTERN);
});

test('the worker’s boot path registers it again, unprompted', () => {
  expect(afterReboot.matches).toEqual([APP_ORIGIN_PATTERN, APP_ORIGIN_PATTERN]);
  // And what the worker BELIEVES was rebuilt from Chrome rather than carried in memory — the
  // second half of the same bug, and what makes a later revoke actually unregister anything.
  expect(afterReboot.believed).toEqual({ matches: [APP_ORIGIN_PATTERN], error: null });
});

test('a page loaded in that second session is instrumented', () => {
  // Pre-fix this was `undefined`, measured in a real browser: no content scripts, so no marker.
  expect(marker).toEqual({ version: '0.1.0', protocol: 1, source: 'agui-dt' });
});

test('and capture delivers the whole run', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  // Pre-fix: 0 records, 0 request lines, no error anywhere — capture silently doing nothing, which
  // requirements §15 names as the failure mode to avoid.
  expect(capturedEventTypes(capture.records)).toEqual(
    scenario.events.map((event: AguiEvent) => String(event.type)),
  );
  expect(capture.requests.length).toBe(1);
  expect(capture.requests[0]?.url).toBe(`${appUrl}agui`);

  const { runs, issues } = reconstruct(capture);
  expect(issues.map((issue) => issue.code)).toEqual(scenario.expectIssues);
  expect(runs.length).toBe(1);
  expect(runs[0]?.outcome).toBe('finished');
});

test('the panel is told the origin is registered, on the snapshot it is actually sent', () => {
  // The panel is unreachable from Playwright (H4/H5), so this reads the same `RegistrationState`
  // `snapshotFor` embeds, through the worker's own hook. It is what the panel reads to tell
  // "reload this document" from "nothing is registered, and reloading cannot help".
  expect(afterReboot.believed.matches).toEqual([APP_ORIGIN_PATTERN]);
  expect(afterReboot.believed.error).toBeNull();
});

