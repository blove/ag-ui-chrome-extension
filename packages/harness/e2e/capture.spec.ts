/**
 * The first end-to-end test: real extension, real browser, real SSE, real client.
 *
 * Preconditions, both built by `test/global-setup.ts` before any spec runs:
 *   packages/devtools/dist         → the unpacked extension
 *   packages/harness/page/dist     → the bundled harness page
 *
 * The run itself happens in `beforeAll`, not in the first test that needs it. Playwright
 * discards a worker after a failing test and re-runs `beforeAll` in a fresh one, so a test
 * that asserted on state a PREVIOUS test had produced would report an empty array the moment
 * anything above it went red — a cascade that hides the real failure. Every test below reads
 * state the hook produced, so each one fails on its own merits.
 *
 * The last test asserts capture is EMPTY. That is the current truth: `inject/` patches no page
 * API and `src/sw/index.ts` installs no `__AGUI_DT_TEST__` hook. Each capture commit that
 * follows flips part of it positive.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type { AguiEvent } from '@devtools/core/model/types';

import { SCENARIOS, type Scenario } from '../fixtures/index.js';
import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import { launchWithExtension, readCapture } from './fixtures.js';

const SCENARIO_NAME = 'happy';
const PROMPT = 'happy';

interface RenderedLine {
  role: string | null;
  text: string | null;
}

function deltasOf(scenario: Scenario, type: string): string {
  return scenario.events
    .filter((event: AguiEvent) => event.type === type)
    .map((event: AguiEvent) => (typeof event.delta === 'string' ? event.delta : ''))
    .join('');
}

function firstOf(scenario: Scenario, type: string): AguiEvent {
  const event = scenario.events.find((candidate: AguiEvent) => candidate.type === type);
  if (event === undefined) throw new Error(`scenario '${scenario.name}' has no ${type}`);
  return event;
}

/**
 * What the REAL `@ag-ui/client` reconstructs from the happy scenario, derived from the
 * fixture so it stays the single source of truth.
 *
 * Three lines, not two: the tool call carries `parentMessageId: m_1`, so the client folds it
 * into the assistant message that opened `m_1` rather than emitting a message of its own, and
 * `TOOL_CALL_RESULT` becomes a separate `tool`-role message. That folding is precisely the
 * behaviour the Messages tab has to agree with, which is why it is asserted rather than
 * loosened to "contains the text".
 */
function expectedLines(scenario: Scenario): RenderedLine[] {
  const text = deltasOf(scenario, 'TEXT_MESSAGE_CONTENT');
  const name = firstOf(scenario, 'TOOL_CALL_START').toolCallName;
  const args = deltasOf(scenario, 'TOOL_CALL_ARGS');
  const result = firstOf(scenario, 'TOOL_CALL_RESULT').content;
  return [
    { role: 'user', text: PROMPT },
    { role: 'assistant', text: `${text} ${String(name)}(${args})` },
    { role: 'tool', text: String(result) },
  ];
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let extensionId: string;
let page: Page;
let rendered: RenderedLine[] = [];
const pageErrors: string[] = [];
const posts: { url: string; accept: string }[] = [];

test.beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use(SCENARIO_NAME);
  pageServer = await startPageServer({ agentUrl: harness.url });
  ({ ctx, extensionId } = await launchWithExtension());
  page = await ctx.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.method() === 'POST') {
      posts.push({ url: request.url(), accept: request.headers().accept ?? '' });
    }
  });
  await page.goto(pageServer.url);

  await page.fill('#prompt', PROMPT);
  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done', {
    timeout: 30_000,
  });
  rendered = await page.$$eval('#messages li', (items) =>
    items.map((item) => ({ role: item.getAttribute('data-role'), text: item.textContent })),
  );
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test('the extension loads and its MV3 service worker registers', () => {
  // Playwright's bundled Chromium honours --load-extension; Chrome 151 has removed it, which
  // is why this suite must never be pointed at the user's own browser.
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('the MAIN-world content script reaches the harness page', async () => {
  const marker = await page.evaluate(
    () => (window as unknown as { __AGUI_DEVTOOLS__?: { version: string } }).__AGUI_DEVTOOLS__,
  );
  expect(marker).toEqual({ version: '0.1.0' });
});

test('the real HttpAgent runs the happy scenario and the page renders it', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  expect(rendered).toEqual(expectedLines(scenario));
  expect(pageErrors).toEqual([]);
});

test('the request the capture layer must intercept is a POST asking for SSE', () => {
  // Verified fact 5, asserted from the outside rather than assumed. If a future
  // @ag-ui/client changes this shape, `inject/` is wrong and this is where it surfaces.
  expect(posts).toEqual([{ url: `${pageServer.url}agui`, accept: 'text/event-stream' }]);
});

test('capture sees nothing yet, because inject/ is still a stub', async () => {
  // The honest current state. `inject/` patches no page API, so nothing is posted to the
  // relay; `src/sw/index.ts` installs no `__AGUI_DT_TEST__`, so `readCapture` reports empties.
  // Turning each field of this positive is the definition of done for the capture commits.
  expect(await readCapture(ctx)).toEqual({
    records: [],
    requests: [],
    droppedBefore: 0,
  });
});
