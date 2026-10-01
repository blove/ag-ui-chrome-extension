/**
 * Threadplane render reports, end to end (UI inspector U5): page → MAIN world → relay → worker.
 *
 * `page/render.html` stands in for a Threadplane app in development rendering generative UI: it
 * dispatches `threadplane:devtools` render reports, valid ones interleaved with hostile ones and
 * one §14.3 signals report on the same event name. The claim is made on the worker's hook, whose
 * `renders()` reads through `snapshotFor` — what a panel is sent.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import { clearCapture, launchWithExtension, readCapture, type CaptureSnapshot } from './fixtures.js';

interface RenderProbe {
  heardOwnEvent: number;
  aguiMessages: unknown[];
  errors: string[];
  dispatched: number;
  stamped: number;
}

declare global {
  interface Window {
    __RENDER_PROBE__?: RenderProbe;
  }
}

function expectedRenders(stamped: number): unknown[] {
  return [
    {
      v: 1,
      kind: 'render',
      surface: 's1',
      seq: 1,
      registry: ['Column', 'Text'],
      elements: [
        { key: 'root', type: 'Column', state: 'mounted' },
        { key: 'mystery', type: 'Mystery', state: 'unresolved' },
        { key: 'leaf', type: 'Text', state: 'hidden' },
      ],
      tMs: 10,
    },
    {
      v: 1,
      kind: 'render',
      surface: 'spec:card',
      seq: 2,
      registry: ['Text'],
      elements: [{ key: 'card', type: 'Text', state: 'fallback' }],
      tMs: stamped,
    },
  ];
}

async function readRenders(ctx: BrowserContext, count: number): Promise<CaptureSnapshot> {
  const deadline = Date.now() + 15_000;
  let latest = await readCapture(ctx);
  while ((latest.renders.reports.length < count || latest.signals.reports.length < 1) && Date.now() < deadline) {
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
let probe: RenderProbe;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  harness = await startHarnessServer();
  pageServer = await startPageServer({ agentUrl: harness.url });
  ({ ctx } = await launchWithExtension());
  await clearCapture(ctx);

  page = await ctx.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${pageServer.url}render.html`);
  await page.waitForFunction(() => document.documentElement.dataset.render === 'dispatched');
  capture = await readRenders(ctx, 2);
  const read = await page.evaluate(() => window.__RENDER_PROBE__);
  if (read === undefined) throw new Error('the render page never ran its script');
  probe = read;
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test('only the valid render reports reach the worker’s render ring, in dispatch order, unchanged', () => {
  expect(capture.renders.reports).toEqual(expectedRenders(probe.stamped));
  expect(capture.renders.droppedBefore).toBe(0);
});

test('the signals report on the same event is routed to the signals ring, not the render ring', () => {
  expect(capture.signals.reports).toEqual([
    { v: 1, agent: 'harness-agent', adapter: 'ag-ui', seq: 1, eventType: 'RUN_STARTED', wrote: ['status'], tMs: 11 },
  ]);
});

test('nothing the page forged crosses: no prop value, no unknown kind or state', () => {
  const serialized = JSON.stringify(capture.renders);
  expect(serialized).not.toContain('a prop value must never cross');
  expect(serialized).not.toContain('visible');
  expect(capture.renders.reports.every((report) => report.seq < 50)).toBe(true);
});

test('a render report creates no record and opens no connection', () => {
  expect(capture.records).toEqual([]);
  expect(capture.requests).toEqual([]);
});

test('the page’s own dispatch is undisturbed, and it hears only what its valid reports provoked', () => {
  expect(probe.heardOwnEvent).toBe(probe.dispatched);
  expect(probe.errors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(
    probe.aguiMessages.map((message) => (message as { kind?: unknown }).kind),
  ).toEqual(['render', 'signals', 'render']);
});

test('the render reports are cleared with the tab’s buffer', async () => {
  await clearCapture(ctx);
  const cleared = await readCapture(ctx);
  expect(cleared.renders).toEqual({ reports: [], droppedBefore: 0 });
});
