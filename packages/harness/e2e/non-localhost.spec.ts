/**
 * Capture on a NON-LOCALHOST origin — the axis decision D3 is justified by, and the one every
 * other test in this repo is blind to by construction.
 *
 * WHAT WAS BROKEN, AND WHY 923 GREEN TESTS SAID NOTHING ABOUT IT. CRXJS emits a content script
 * that has imports as an async LOADER which `await import(...)`s the real chunk, and lists that
 * chunk in `web_accessible_resources` scoped to the content script's declared matches — here,
 * the localhost family. A MAIN-world content script runs in the PAGE's world, so on a
 * runtime-granted `http://app.test` that import resolved to a `chrome-extension:` URL the page's
 * origin had no access to and Chrome refused it outright:
 *
 *     Denying load of chrome-extension://<id>/assets/inject.ts-<hash>.js. Resources must be
 *     listed in the web_accessible_resources manifest key in order to be loaded by pages
 *     outside the extension.
 *
 * The user granted the origin, the service worker registered the scripts, and capture silently
 * never started — worse than failing loudly. Measured on the pre-fix build with this exact
 * fixture: marker `undefined`, 0 records, 0 request lines. Every existing spec runs on
 * `localhost`, where the WAR matches and the loader resolves, so none of them could see it.
 *
 * The fix is `contentScripts.standaloneFiles` in `packages/devtools/vite.config.ts`: both
 * content scripts are built as self-contained IIFEs, so there is no chunk to fetch, no
 * `web_accessible_resources` key in the emitted manifest at all, and nothing for an origin to be
 * missing. The explicitly REJECTED alternative was widening `web_accessible_resources` to
 * `http(s)://*` — it works, and it makes the extension trivially fingerprintable by any page,
 * which §11 does not accept.
 *
 * `app.test` is a real non-localhost hostname mapped to the harness server with
 * `--host-resolver-rules`. It is deliberately outside the localhost family Chrome treats
 * specially: `127.0.0.1`, `0.0.0.0` and `localhost` are all in the static manifest matches, are
 * all trustworthy origins, and would all pass whether or not this defect existed.
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
  reconstruct,
  type CaptureSnapshot,
} from './fixtures.js';

const SCENARIO_NAME = 'happy';
const PROMPT = 'happy';

/** Not in the localhost family, and not a `.test` detail Chrome treats specially. */
const APP_HOST = 'app.test';
const APP_ORIGIN_PATTERN = `http://${APP_HOST}/*`;

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let page: Page;
let appUrl: string;
let capture: CaptureSnapshot;
let marker: unknown;
let registeredMatches: string[] = [];
const pageErrors: string[] = [];

/**
 * What `src/sw/index.ts` `registerForMatches` does, run in the worker's own context.
 *
 * The scripts are read from `chrome.runtime.getManifest()` rather than named here, for the same
 * reason the worker reads them there: the emitted filenames are build outputs, and a hardcoded
 * path would rot into a test that registers nothing and asserts nothing.
 */
interface DeclaredContentScript {
  js?: string[];
  world?: string;
  all_frames?: boolean;
}

/** The slice of the `chrome` namespace this needs. The harness has no `@types/chrome`. */
interface ChromeForRegistration {
  runtime: { getManifest(): { content_scripts?: DeclaredContentScript[] } };
  scripting: {
    registerContentScripts(scripts: unknown[]): Promise<void>;
    getRegisteredContentScripts(): Promise<{ id: string; matches?: string[] }[]>;
  };
}

async function registerForOrigin(context: BrowserContext, match: string): Promise<string[]> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return sw.evaluate(async (pattern: string): Promise<string[]> => {
    const api = (globalThis as unknown as { chrome: ChromeForRegistration }).chrome;
    const declared = api.runtime.getManifest().content_scripts ?? [];
    await api.scripting.registerContentScripts(
      declared.map((entry, index) => ({
        id: `agui-dt-${String(index)}-${pattern}`,
        matches: [pattern],
        js: entry.js ?? [],
        runAt: 'document_start',
        world: entry.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
        allFrames: entry.all_frames ?? true,
      })),
    );
    const registered = await api.scripting.getRegisteredContentScripts();
    return registered.flatMap((script) => script.matches ?? []);
  }, match);
}

function capturedEventTypes(records: CaptureRecord[]): string[] {
  return records
    .filter((record) => record.kind === 'event')
    .map((record) => String(record.event?.type ?? '<unparsed>'));
}

test.beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use(SCENARIO_NAME);
  pageServer = await startPageServer({ agentUrl: harness.url });
  // Same server, reached under a hostname that is not in the localhost family.
  appUrl = pageServer.url.replace('http://localhost:', `http://${APP_HOST}:`);

  ({ ctx } = await launchWithExtension({
    dist: distWithGrantedOrigin(APP_ORIGIN_PATTERN),
    args: [
      `--host-resolver-rules=MAP ${APP_HOST} 127.0.0.1`,
      // `crypto.randomUUID`, which the real `@ag-ui/client` uses to id a message, exists only in
      // a secure context. `localhost` is one by fiat; `http://app.test:<port>` is not, and
      // without this flag the page throws before it ever reaches the network — a failure that
      // has nothing to do with capture and would be easy to misread as one.
      `--unsafely-treat-insecure-origin-as-secure=${appUrl.replace(/\/$/, '')}`,
    ],
  }));
  registeredMatches = await registerForOrigin(ctx, APP_ORIGIN_PATTERN);

  page = await ctx.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
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

test('the page under test is genuinely not localhost', () => {
  // Guards the fixture, not the product. If the host-resolver rule ever stopped applying and
  // this fell back to localhost, every assertion below would pass for the wrong reason and the
  // suite would go back to being blind to exactly the defect it exists for.
  const host = new URL(appUrl).hostname;
  expect(host).toBe(APP_HOST);
  expect(['localhost', '127.0.0.1', '0.0.0.0']).not.toContain(host);
  // And the content scripts really are registered for it at runtime, rather than the page being
  // covered by the manifest's static localhost matches.
  expect(registeredMatches).toEqual([APP_ORIGIN_PATTERN, APP_ORIGIN_PATTERN]);
});

test('the MAIN-world content script installs on a granted non-localhost origin', () => {
  // Pre-fix this was `undefined`: the loader's dynamic import of its chunk was denied.
  expect(marker).toEqual({ version: '0.1.0', protocol: 1, source: 'agui-dt' });
});

test('no resource load is denied to the page', () => {
  // The defect's own error text, asserted directly. It is a `console` error rather than a page
  // error, and it is the single most specific signature of a regression here.
  expect(pageErrors.filter((message) => /web_accessible_resources|Denying load/.test(message))).toEqual(
    [],
  );
  expect(pageErrors).toEqual([]);
});

test('the whole capture path delivers the run from a non-localhost origin', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  // Pre-fix: 0 records, 0 requests, no error anywhere.
  expect(capturedEventTypes(capture.records)).toEqual(
    scenario.events.map((event: AguiEvent) => String(event.type)),
  );
  expect(capture.requests.length).toBe(1);
  expect(capture.requests[0]?.url).toBe(`${appUrl}agui`);
  expect(capture.droppedBefore).toBe(0);
});

test('the run captured off a non-localhost origin reconstructs clean', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  const { runs, issues } = reconstruct(capture);

  expect(issues.map((issue) => issue.code)).toEqual(scenario.expectIssues);
  expect(runs.length).toBe(1);
  expect(runs[0]?.outcome).toBe('finished');
  // The specific misattribution the request line prevents: a lost `conn-open` reads as a defect
  // in the user's server.
  expect(issues.map((issue) => issue.code)).not.toContain('run-started-without-input');
});

test('a stream opened by the first synchronous inline script is captured off a non-localhost origin', async () => {
  // Both failure modes at once: the origin axis and the document_start timing axis. Nothing here
  // waits for the marker, so this passes only if the content scripts are BOTH self-contained
  // (no async chunk to fetch) AND reachable from an origin outside the localhost family.
  const sync = await ctx.newPage();
  await sync.goto(`${appUrl}document-start-sync.html`);

  await expect
    .poll(
      async () =>
        (await readCapture(ctx)).requests.map((request) => request.url).filter((url) => url.includes('sync=1')),
      { timeout: 10_000 },
    )
    .toEqual(['/agui-document-start?sync=1']);

  await sync.close();
});
