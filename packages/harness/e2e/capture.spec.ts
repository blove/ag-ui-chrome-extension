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
 * The capture assertions read the service worker's ring buffer through `__AGUI_DT_TEST__` and
 * fold it with the real `core/` pipeline. The `malformed` block is the point of the whole
 * milestone: a live capture, reconstructed, must produce the same three issues at the same seqs
 * as the golden fixture that scenario was converted from.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type { AguiEvent, CaptureRecord } from '@devtools/core/model/types';

import { SCENARIOS, type Scenario } from '../fixtures/index.js';
import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  clearCapture,
  launchWithExtension,
  readCapture,
  reconstruct,
  type CaptureSnapshot,
} from './fixtures.js';

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

/** Event types only, in stream order — what a captured run must agree with the corpus on. */
function capturedEventTypes(records: CaptureRecord[]): string[] {
  return records
    .filter((record) => record.kind === 'event')
    .map((record) => String(record.event?.type ?? '<unparsed>'));
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let extensionId: string;
let page: Page;
let rendered: RenderedLine[] = [];
let capture: CaptureSnapshot;
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
  capture = await readCapture(ctx);
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
  // The marker gained `protocol` and `source` when the capture layer landed: a page-side hook
  // has to be able to tell which postMessage protocol this build speaks, and which tag it
  // stamps on every message. Kept as an exact-shape assertion so a change to the contract the
  // relay depends on cannot pass unnoticed.
  const marker = await page.evaluate(
    () =>
      (window as unknown as { __AGUI_DEVTOOLS__?: Record<string, unknown> }).__AGUI_DEVTOOLS__,
  );
  expect(marker).toEqual({ version: '0.1.0', protocol: 1, source: 'agui-dt' });
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

test('the whole capture path delivers the happy run to the ring buffer', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  // MAIN world -> relay -> port -> per-tab buffer, with nothing lost and nothing invented: the
  // captured events are the scenario's events, in order.
  expect(capturedEventTypes(capture.records)).toEqual(
    scenario.events.map((event: AguiEvent) => String(event.type)),
  );
  // Keepalives are frames too, and are what a `keepalive-gap` anchors to.
  expect(capture.records.filter((record) => record.kind === 'keepalive').length).toBe(
    scenario.keepalives?.length ?? 0,
  );
  // seq is assigned by the service worker, per tab, from 1.
  expect(capture.records.map((record) => record.seq)).toEqual(
    capture.records.map((_record, index) => index + 1),
  );
  expect(capture.droppedBefore).toBe(0);
});

test('the captured request line carries the RunAgentInput the client sent', () => {
  // Verified fact 4: without `input` every run additionally reports `run-started-without-input`,
  // which reads as a finding about the user's server. One connection, one request line.
  expect(capture.requests.length).toBe(1);
  const request = capture.requests[0];
  if (!request) throw new Error('no request line was captured');
  expect(request.method).toBe('POST');
  expect(request.url).toBe(`${pageServer.url}agui`);
  expect((request.input as { threadId?: unknown }).threadId).toEqual(expect.any(String));
  expect((request.input as { messages?: { content?: unknown }[] }).messages?.[0]?.content).toBe(
    PROMPT,
  );
});

test('the captured happy run reconstructs to a clean run', () => {
  const scenario = SCENARIOS[SCENARIO_NAME];
  if (!scenario) throw new Error(`SCENARIOS.${SCENARIO_NAME} is missing`);

  const { runs, issues } = reconstruct(capture);

  expect(issues.map((issue) => issue.code)).toEqual(scenario.expectIssues);
  expect(runs.length).toBe(1);
  expect(runs[0]?.outcome).toBe('finished');
});

test.describe('the malformed scenario, captured live', () => {
  let malformed: CaptureSnapshot;

  test.beforeAll(async () => {
    // A NEW tab, not a reload: `seq` is monotonic per tab and a clear does not reset it, so the
    // absolute seq assertions below need a buffer that has never held anything.
    await clearCapture(ctx);
    harness.use('malformed');

    const second = await ctx.newPage();
    await second.goto(pageServer.url);
    await second.fill('#prompt', 'malformed');
    await second.click('#run');
    // `malformed` has no terminal event, so the real client ends the run by whichever path it
    // chooses. Either terminal status means the stream is over and capture is complete.
    await second.waitForFunction(
      () => {
        const status = document.getElementById('status')?.textContent;
        return status === 'done' || status === 'error';
      },
      { timeout: 30_000 },
    );
    malformed = await readCapture(ctx);
    await second.close();
  });

  test('captures exactly the scenario stream', () => {
    const scenario = SCENARIOS['malformed'];
    if (!scenario) throw new Error('SCENARIOS.malformed is missing');
    expect(capturedEventTypes(malformed.records)).toEqual(
      scenario.events.map((event: AguiEvent) => String(event.type)),
    );
  });

  test('reconstructs to exactly the three known issues at the known seqs', () => {
    const scenario = SCENARIOS['malformed'];
    if (!scenario) throw new Error('SCENARIOS.malformed is missing');

    const { runs, issues } = reconstruct(malformed);

    // This is the end-to-end equivalence proof. `SCENARIOS.malformed` was converted from
    // `packages/devtools/src/test/fixtures/malformed.agui.jsonl`, whose issues were OBSERVED by
    // folding the fixture through `core/` (see the integration suite, Done-when #5). Serving
    // those same events over a real socket, intercepting them in the page, relaying them to the
    // service worker and folding the ring buffer's contents must land on the same three issues
    // anchored to the same seqs — the empty delta at 5, the parentless patch at 9, and the
    // missing terminal event at 10. A capture layer that dropped, reordered, re-chunked or
    // re-numbered a single frame cannot satisfy this.
    expect(
      [...issues].sort((a, b) => a.seq - b.seq).map((issue) => [issue.code, issue.seq]),
    ).toEqual([
      ['empty-text-delta', 5],
      ['state-patch-failed', 9],
      ['run-never-terminated', 10],
    ]);
    expect([...issues].map((issue) => issue.code).sort()).toEqual(
      [...scenario.expectIssues].sort(),
    );

    expect(runs.length).toBe(1);
    expect(runs[0]?.runId).toBe('r_bad');
    // Not `run-started-without-input`: the request line was captured, so the only findings are
    // the three that are genuinely in the stream.
    expect(issues.map((issue) => issue.code)).not.toContain('run-started-without-input');
  });
});

test.describe('the document_start window', () => {
  test('a conn-open posted before the relay is listening still reaches the buffer', async () => {
    // The decision this task implements: the relay's `message` listener registers a tick after
    // `document_start`, because CRXJS wraps a content script that has imports in an async
    // loader. `EventSource` posts `conn-open` synchronously from its constructor, so an inline
    // script in `<head>` can post one into that window — and `conn-open` is the message that
    // carries `RunAgentInput`. Losing it makes a healthy run report
    // `run-started-without-input`, i.e. a finding about the USER'S server rather than about our
    // capture. The MAIN world therefore re-states the open ahead of the first frames batch and
    // the worker ignores a duplicate, which is what makes this assertion deterministic instead
    // of a coin flip on loader ordering.
    await clearCapture(ctx);
    const early = await ctx.newPage();
    await early.goto(`${pageServer.url}document-start.html`);
    await early.waitForSelector('#ready');

    // The stream's frames are delayed server-side, so wait for the whole thing rather than for
    // the first thing to arrive.
    await expect
      .poll(async () => capturedEventTypes((await readCapture(ctx)).records), { timeout: 10_000 })
      .toEqual(['RUN_STARTED', 'RUN_FINISHED']);

    const earlyCapture = await readCapture(ctx);
    // Recorded verbatim as the page passed it: `eventsource-patch.ts` stores `String(url)`, so a
    // relative specifier stays relative. (`fetch-patch.ts` resolves against the document, so the
    // two transports disagree — noted, and not this task's to change.)
    expect(earlyCapture.requests.map((request) => request.url)).toEqual([
      '/agui-document-start',
    ]);
    // `EventSource` cannot carry a body, so `input` is honestly null (§5.3) — the point here is
    // that the request line EXISTS, not what it carries.
    expect(earlyCapture.requests[0]?.method).toBe('GET');

    await early.close();
  });
});
