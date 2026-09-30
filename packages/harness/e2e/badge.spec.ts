/**
 * The toolbar badge (spec §14.6), end to end through the REAL extension.
 *
 * `sw/index.test.ts` proves the worker calls `chrome.action` with the right values against a stub.
 * It cannot prove Chrome accepts them — that the manifest's `action` key is there, that a
 * `{ tabId }` badge stays on its tab, that the relay's frames reach the detection rule in a built
 * extension. This reads what Chrome itself holds, per tab, through `chrome.action.getBadgeText` /
 * `getTitle` in the service worker (`readBadge`).
 *
 * Each test drives its own scenario in its own tab after a clear, and reads the badge only once
 * the capture has settled (`readSettledCapture`) and the badge has stopped changing
 * (`readSettledBadge`) — never by waiting for it to look right. So a badge that stays dark is a
 * diff, and the plain-SSE test's `''` is a reading taken after the stream was captured in full,
 * not before anything happened.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { PLAIN_SSE_PATH, PLAIN_SSE_TICKS, startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  clearCapture,
  launchWithExtension,
  readSettledBadge,
  readSettledCapture,
  type BadgeReading,
  type CaptureSnapshot,
} from './fixtures.js';

const DEFAULT: BadgeReading = { text: '', title: 'AG-UI DevTools' };

function titleFor(parts: string): string {
  return `AG-UI DevTools — ${parts} — open DevTools → AG-UI`;
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;

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

/** Open `path` in a fresh tab, run it, and wait for the page's own `#status` to end. */
async function drive(path: string, run: boolean): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${pageServer.url}${path}`);
  if (run) {
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
    await page.click('#run');
  }
  await page.waitForFunction(
    () => {
      const status = document.getElementById('status')?.textContent;
      return status === 'done' || status === 'error';
    },
    { timeout: 30_000 },
  );
  const status = await page.textContent('#status');
  if (status !== 'done') {
    throw new Error(`the page's run ended '${String(status)}': ${String(await page.textContent('#error'))}`);
  }
  return page;
}

test.beforeEach(async () => {
  await clearCapture(ctx);
});

test('an AG-UI run lights its tab AG, and a second tab on the same origin stays dark', async () => {
  // Opened FIRST and left open: the content scripts are in it (localhost), it never speaks, and it
  // must still read the default while the tab beside it is lit. A badge set without `{ tabId }`
  // is window-wide and would light this one too.
  const quiet = await ctx.newPage();
  await quiet.goto(`${pageServer.url}quiet.html`);
  expect(await readSettledBadge(ctx, quiet)).toEqual(DEFAULT);

  const started = Date.now();
  const page = await drive('', true);
  await readSettledCapture(ctx);
  const badge = await readSettledBadge(ctx, page);
  test.info().annotations.push({ type: 'run-to-badge', description: `${String(Date.now() - started)}ms` });

  expect(badge).toEqual({ text: 'AG', title: titleFor('AG-UI · 1 connection') });
  expect(await readSettledBadge(ctx, quiet)).toEqual(DEFAULT);
  await page.close();
  await quiet.close();
});

test('a LangGraph Platform run lights its tab LG', async () => {
  const page = await drive('langgraph.html?scenario=lg-reasoning', true);
  await readSettledCapture(ctx);
  expect(await readSettledBadge(ctx, page)).toEqual({
    text: 'LG',
    title: titleFor('LangGraph Platform · 1 connection'),
  });
  await page.close();
});

test('a page that speaks both lights its tab A+L', async () => {
  const page = await drive('langgraph.html?scenario=lg-reasoning&agui=1', true);
  await readSettledCapture(ctx, { connections: 2 });
  expect(await readSettledBadge(ctx, page)).toEqual({
    text: 'A+L',
    title: titleFor('AG-UI · LangGraph Platform · 2 connections'),
  });
  await page.close();
});

test('an SSE stream that is not AG-UI is captured, and leaves the badge dark', async () => {
  const page = await drive('plain-sse.html', false);
  const capture: CaptureSnapshot = await readSettledCapture(ctx);

  // The '' below is only worth something if the stream really reached the worker: the request
  // line and every tick, recorded as events with no AG-UI type.
  expect(capture.requests.map((request) => new URL(request.url, pageServer.url).pathname)).toEqual([
    PLAIN_SSE_PATH,
  ]);
  const ticks = capture.records.map((record) =>
    record.kind === 'event' ? record.raw : `<${record.kind}>`,
  );
  expect(ticks).toEqual(
    Array.from({ length: PLAIN_SSE_TICKS }, (_, index) => ({ tick: index + 1 })),
  );

  expect(await readSettledBadge(ctx, page)).toEqual(DEFAULT);
  await page.close();
});
