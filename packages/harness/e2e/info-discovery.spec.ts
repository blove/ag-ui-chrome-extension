/**
 * Spec §13 done-when #2, end to end: `/info`-derived agent metadata in Session before any run.
 *
 * Real extension, real browser, real HTTP. The page fetches agent discovery the way the
 * CopilotKit v2 client does — at connect time, before anything is run — and this suite asserts
 * that the metadata reaches the state a PANEL is given, over both runtime transports.
 *
 * WHY THE ASSERTIONS READ THE WORKER RATHER THAN THE UI. The DevTools panel is not reachable from
 * Playwright (design H4/H5). So the claim is made where it can be made honestly: `readCapture`
 * reads `__AGUI_DT_TEST__`, whose `info()` goes through `snapshotFor` — the very function that
 * builds a panel's `snapshot` message — and `foldAsLatePanel` then runs the panel's own
 * `createLiveSession` over it. A hook that assembled its own view of the worker's state is exactly
 * the defect this project already found once, where the e2e stayed green while the shipped message
 * lost a field.
 *
 * WHY THE ORDERING IS DETERMINISTIC. `readSettledCapture` returns once the run's connection has
 * CLOSED. The page awaits discovery before its run form works, `postMessage` delivery is FIFO and
 * port messages are ordered, so a worker that has handled the close has necessarily handled the
 * discovery response ahead of it. Nothing here waits on a duration.
 */
import { expect, test, type BrowserContext } from '@playwright/test';

import { startPageServer, type PageServer } from '../page/serve.js';
import { RUNTIME_BASE_PATH, RUNTIME_INFO } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  clearCapture,
  foldAsLatePanel,
  launchWithExtension,
  readSettledCapture,
  type CaptureSnapshot,
} from './fixtures.js';

/** The agent ids the harness runtime reports, derived from the served body rather than restated. */
const AGENT_IDS = Object.keys(RUNTIME_INFO.agents);

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;

/** Drive one page load in the given discovery mode and read the settled capture. */
async function runInMode(mode: 'multi' | 'single'): Promise<CaptureSnapshot> {
  await clearCapture(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${pageServer.url}copilotkit.html?mode=${mode}`);
  // Discovery finished — the page reports how many agents IT read, so a hung or failed fetch
  // fails here with a diagnosis instead of downstream with an empty buffer.
  await page.waitForFunction(
    (expected: number) => document.getElementById('info')?.textContent === String(expected),
    AGENT_IDS.length,
    { timeout: 30_000 },
  );
  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done', {
    timeout: 30_000,
  });
  const capture = await readSettledCapture(ctx);
  expect(errors).toEqual([]);
  await page.close();
  return capture;
}

test.beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use('happy');
  pageServer = await startPageServer({ agentUrl: harness.url });
  ({ ctx } = await launchWithExtension());
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test.describe('multi-route discovery: GET {base}/info', () => {
  let capture: CaptureSnapshot;

  test.beforeAll(async () => {
    capture = await runInMode('multi');
  });

  test('the worker holds the runtime metadata the page fetched', () => {
    // Not vacuous: this is a real object with real values, asserted field by field. A build that
    // returned `null`, or an empty shell, fails here naming what it actually got.
    expect(capture.info).not.toBeNull();
    expect(capture.info?.version).toBe(RUNTIME_INFO.version);
    expect(capture.info?.mode).toBe('multi-route');
    expect(capture.info?.agents?.map((agent) => agent.id)).toEqual(AGENT_IDS);
  });

  test('and the run beside it is captured exactly as it always was', () => {
    // The SSE path shares `observeResponse` with the branch discovery was added to. This is the
    // assertion that adding one did not disturb the other, measured on the same page load.
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.method).toBe('POST');
    expect(capture.closes).toHaveLength(1);
    expect(capture.records.length).toBeGreaterThan(0);
    expect(capture.records.map((record) => record.seq)).toEqual(
      capture.records.map((_record, index) => index + 1),
    );
  });

  test('discovery produces no record and takes no seq', () => {
    // A Timeline row for a discovery response would be the panel asserting a protocol event the
    // user's stream never contained.
    const urls = capture.requests.map((request) => request.url);
    expect(urls.some((url) => url.includes(RUNTIME_BASE_PATH))).toBe(false);
    expect(
      capture.records.some((record) => JSON.stringify(record).includes('a2ui_chat')),
    ).toBe(false);
  });

  /**
   * THE CRITERION ITSELF: what a panel holds.
   *
   * `foldAsLatePanel` runs the panel's real `createLiveSession` over the real `snapshot` message
   * the worker builds — the ordinary case, where the panel is opened after the client connected
   * and the `info` push arm was broadcast long before it existed.
   */
  test('a panel folding the worker snapshot shows the agents in Session state', () => {
    const panel = foldAsLatePanel(capture);
    expect(panel.runtime).not.toBeNull();
    expect(panel.runtime?.version).toBe(RUNTIME_INFO.version);
    expect(panel.runtime?.mode).toBe('multi-route');
    expect(panel.runtime?.agents?.map((agent) => agent.id)).toEqual(AGENT_IDS);
    // Names and descriptions come across too — the id alone is what the client addresses, but the
    // rest is what makes the Session row worth reading.
    expect(panel.runtime?.agents?.map((agent) => agent.name)).toEqual(AGENT_IDS);
    expect(panel.runtime?.agents?.every((agent) => agent.description === '')).toBe(true);
  });

  test('the panel-facing metadata carries nothing the protocol does not name', () => {
    // `className` and `audioFileTranscriptionEnabled` are in the served body. They are read and
    // discarded, not smuggled into a typed claim and eventually into a shared file.
    const serialized = JSON.stringify(foldAsLatePanel(capture).runtime);
    expect(serialized).not.toContain('className');
    expect(serialized).not.toContain('audioFileTranscription');
  });
});

test.describe('single-route discovery: POST {base} with {"method":"info"}', () => {
  let capture: CaptureSnapshot;

  test.beforeAll(async () => {
    capture = await runInMode('single');
  });

  /**
   * The transport that needed new work.
   *
   * Its URL is the runtime's own base path — the same URL every other single-route call uses — so
   * nothing about it is visible from the route grammar alone. The request BODY is the entire
   * signal, and before this it was recognised by nothing in the codebase.
   */
  test('the worker holds metadata from a request the URL alone could not identify', () => {
    expect(capture.info).not.toBeNull();
    expect(capture.info?.version).toBe(RUNTIME_INFO.version);
    expect(capture.info?.agents?.map((agent) => agent.id)).toEqual(AGENT_IDS);
  });

  test('and reports the runtime mode as single-route', () => {
    // The body is byte-identical to the multi-route one, so this fact exists only in which
    // request was answered — requirements §4's "runtime mode", carried on the metadata itself.
    expect(capture.info?.mode).toBe('single-route');
    expect(foldAsLatePanel(capture).runtime?.mode).toBe('single-route');
  });

  test('the run on the same page is still captured whole', () => {
    expect(capture.requests).toHaveLength(1);
    expect(capture.closes).toHaveLength(1);
    expect(capture.records.length).toBeGreaterThan(0);
  });
});

/**
 * The common case, and the one most users are in.
 *
 * Measured across three page loads of a production AG-UI deployment: no `/info` request, ever,
 * because it is not a CopilotKit app. Nothing here may treat that as a failure, and the state a
 * panel is handed has to say so honestly rather than carrying stale or invented metadata.
 */
test.describe('an AG-UI page that never asks for agent discovery', () => {
  test('leaves the panel-facing metadata null, with the run captured as normal', async () => {
    await clearCapture(ctx);
    const page = await ctx.newPage();
    await page.goto(pageServer.url);
    await page.fill('#prompt', 'happy');
    await page.click('#run');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done', {
      timeout: 30_000,
    });
    const capture = await readSettledCapture(ctx);
    await page.close();

    expect(capture.info).toBeNull();
    expect(foldAsLatePanel(capture).runtime).toBeNull();
    // And this is a working capture, not a broken one — which is exactly why the Session tab's
    // wording for this state must not read as a finding.
    expect(capture.records.length).toBeGreaterThan(0);
    expect(capture.closes).toHaveLength(1);
  });
});
