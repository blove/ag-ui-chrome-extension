/**
 * Threadplane devtools reports, end to end (design G5): page → MAIN world → relay → worker.
 *
 * Real extension, real browser. `page/signals.html` stands in for a Threadplane app in development
 * mode: it dispatches `threadplane:devtools` events on its own window, valid ones interleaved with
 * hostile ones a page could forge, and loads itself again as a subframe that reports once.
 *
 * WHAT IS ASSERTED, AND WHERE. The DevTools panel is unreachable from Playwright (H4/H5), so the
 * claim is made on the worker's hook, whose `signals()` reads through `snapshotFor` — the function
 * that builds a panel's `snapshot`. Exactly the valid reports must arrive, in dispatch order, with
 * nothing added or changed; the page's own dispatch must be undisturbed; and the only `agui-dt`
 * traffic the page can hear must be what its own valid reports provoked.
 *
 * NOT VACUOUS. The page's own listener counts every dispatch, so a page that never ran its script
 * fails on that count rather than passing on an empty worker; the valid reports are asserted
 * field by field, so a worker that held nothing fails naming what it got.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import { clearCapture, launchWithExtension, readCapture, type CaptureSnapshot } from './fixtures.js';

interface SignalsProbe {
  heardOwnEvent: number;
  aguiMessages: unknown[];
  errors: string[];
  dispatched: number;
  stamped: number;
}

declare global {
  interface Window {
    __SIGNALS_PROBE__?: SignalsProbe;
  }
}

/** The valid top-frame reports, in the order the page dispatched them. */
function expectedTopFrame(stamped: number): unknown[] {
  return [
    {
      v: 1,
      agent: 'harness-agent',
      adapter: 'langgraph',
      seq: 1,
      eventType: 'values',
      wrote: ['values', 'messages'],
      tMs: 10,
    },
    {
      v: 1,
      agent: 'harness-agent',
      adapter: 'langgraph',
      seq: 2,
      eventType: 'messages',
      wrote: ['messages', 'messageMetadata'],
      tMs: 20,
    },
    {
      v: 1,
      agent: 'harness-agui-agent',
      adapter: 'ag-ui',
      seq: 1,
      eventType: 'STATE_DELTA',
      wrote: ['state', 'messages'],
      tMs: stamped,
    },
  ];
}

const CHILD_REPORT = {
  v: 1,
  agent: 'harness-child-agent',
  adapter: 'langgraph',
  seq: 1,
  eventType: 'messages',
  wrote: ['messages'],
  tMs: 1,
};

/** Poll the worker until it holds `count` reports; the bound only matters when capture is broken. */
async function readSignals(ctx: BrowserContext, count: number): Promise<CaptureSnapshot> {
  const deadline = Date.now() + 15_000;
  let latest = await readCapture(ctx);
  while (latest.signals.reports.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await readCapture(ctx);
  }
  return latest;
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let page: Page;
let capture: CaptureSnapshot;
let probe: SignalsProbe;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  harness = await startHarnessServer();
  pageServer = await startPageServer({ agentUrl: harness.url });
  ({ ctx } = await launchWithExtension());
  await clearCapture(ctx);

  page = await ctx.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${pageServer.url}signals.html`);
  await page.waitForFunction(() => document.documentElement.dataset.signals === 'dispatched');
  // Four valid reports in all: three from the top frame, one from the subframe.
  capture = await readSignals(ctx, 4);
  // Read after the worker has everything, so every `agui-dt` post has long been delivered too.
  const read = await page.evaluate(() => window.__SIGNALS_PROBE__);
  if (read === undefined) throw new Error('the signals page never ran its script');
  probe = read;
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test('only the valid top-frame reports reach the worker, in dispatch order, unchanged', () => {
  const top = capture.signals.reports.filter((report) => report.agent !== CHILD_REPORT.agent);
  expect(top).toEqual(expectedTopFrame(probe.stamped));
  expect(capture.signals.droppedBefore).toBe(0);
});

test('nothing the page forged crosses: no extra key, no foreign name, no hostile seq', () => {
  const serialized = JSON.stringify(capture.signals);
  expect(serialized).not.toContain('a signal value must never cross');
  expect(serialized).not.toContain('password');
  // Every hostile report carried a seq of 50 or more; the valid ones are 1 and 2.
  expect(capture.signals.reports.every((report) => report.seq < 50)).toBe(true);
});

test('a report from a subframe is captured too', () => {
  // The decision this holds: the MAIN-world script runs `all_frames`, each frame listens on its
  // own window and posts to its own relay, and agent chat is often embedded in an iframe.
  expect(capture.signals.reports).toContainEqual(CHILD_REPORT);
  expect(capture.signals.reports).toHaveLength(4);
});

test('a report creates no record and opens no connection', () => {
  expect(capture.records).toEqual([]);
  expect(capture.requests).toEqual([]);
});

test('the page’s own dispatch is undisturbed by the hostile reports', () => {
  // Every dispatch of the name — valid, hostile, and the detail-less plain Event — reached the
  // page's own listener, and nothing the extension did surfaced as an error.
  expect(probe.heardOwnEvent).toBe(probe.dispatched);
  expect(probe.errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the page hears only what its own valid reports provoked', () => {
  // Three valid top-frame reports, three `signals` posts — and nothing else, because this page
  // makes no request. The subframe posts to its own window, which this listener is not on.
  expect(probe.aguiMessages).toHaveLength(3);
  expect(probe.aguiMessages.every((message) => (message as { kind?: unknown }).kind === 'signals'))
    .toBe(true);
});

test('the reports are cleared with the tab’s buffer', async () => {
  await clearCapture(ctx);
  const cleared = await readCapture(ctx);
  expect(cleared.signals).toEqual({ reports: [], droppedBefore: 0 });
});
