/**
 * LangGraph Platform capture, end to end through the REAL extension (spec §7 "Harness", PR 4c).
 *
 * The unit suites prove each hop keeps an SSE event's name — inject's parser, the relay's rebuild,
 * the worker's record — and the golden suites prove `core/` folds a LangGraph capture. Neither can
 * prove the hops are wired to each other in a built extension, in a real browser, over a socket
 * that splits pretty-printed multi-line `data:` payloads wherever it likes. This does.
 *
 * Every scenario is served by `server/langgraph-server.ts` from the page's own origin and driven
 * by `page/langgraph.ts`, a raw `fetch` POST to `/threads/:threadId/runs/stream`. Each is then
 * asserted twice over, through the two folds the panel has — `reconstruct` (the import path) and
 * `foldAsLatePanel` (a panel opened after the run) — which must agree.
 *
 * Each describe drives its run in `beforeAll`, in a fresh tab after a clear, for the reason
 * `capture.spec.ts` gives: a test must fail on its own state, never on a previous test's.
 */
import { expect, test, type BrowserContext } from '@playwright/test';

import type { CaptureRecord, Run } from '@devtools/core/model/types';
import { dialectOf } from '@devtools/core/normalizer/dialect';

import {
  langGraphCanonicalText,
  requireLangGraphScenario,
  type LangGraphFrame,
} from '../fixtures/langgraph.js';
import { SCENARIOS } from '../fixtures/index.js';
import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import {
  clearCapture,
  foldAsLatePanel,
  launchWithExtension,
  readSettledCapture,
  reconstruct,
  type CaptureSnapshot,
  type RequestLine,
} from './fixtures.js';

const THREAD_ID = 'harness-thread';
const PROMPT = 'hello langgraph';

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;

test.beforeAll(async () => {
  harness = await startHarnessServer();
  // Only the mixed page reaches it; `happy` is the AG-UI run that sits beside a LangGraph one.
  harness.use('happy');
  pageServer = await startPageServer({ agentUrl: harness.url });
  ({ ctx } = await launchWithExtension());
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

interface Driven {
  capture: CaptureSnapshot;
  pageErrors: string[];
  elapsedMs: number;
}

/** Clear, open a fresh tab on `langgraph.html?<query>`, run, and read the settled capture. */
async function drive(query: Record<string, string>, connections = 1): Promise<Driven> {
  await clearCapture(ctx);
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  const search = new URLSearchParams({ thread: THREAD_ID, ...query }).toString();
  await page.goto(`${pageServer.url}langgraph.html?${search}`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  const started = Date.now();
  await page.fill('#prompt', PROMPT);
  await page.click('#run');
  await page.waitForFunction(
    () => {
      const status = document.getElementById('status')?.textContent;
      return status === 'done' || status === 'error';
    },
    { timeout: 30_000 },
  );
  const status = await page.textContent('#status');
  const error = await page.textContent('#error');
  if (status !== 'done') throw new Error(`the page's run ended '${String(status)}': ${String(error)}`);
  const capture = await readSettledCapture(ctx, { connections });
  const elapsedMs = Date.now() - started;
  await page.close();
  return { capture, pageErrors, elapsedMs };
}

type EventRecord = Extract<CaptureRecord, { kind: 'event' }>;

function eventsOf(capture: CaptureSnapshot, connId: string): EventRecord[] {
  return capture.records.filter(
    (record): record is EventRecord => record.kind === 'event' && record.connId === connId,
  );
}

function onlyRequest(capture: CaptureSnapshot, pathSuffix: string): RequestLine {
  const matching = capture.requests.filter((request) => request.url.endsWith(pathSuffix));
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

function dialectOfConn(capture: CaptureSnapshot, request: RequestLine): string {
  const first = eventsOf(capture, request.connId)[0];
  return dialectOf(
    request,
    first === undefined
      ? undefined
      : { ...(first.sseEvent !== undefined ? { sseEvent: first.sseEvent } : {}), payload: first.raw },
  );
}

function countsOf(frames: readonly LangGraphFrame[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const frame of frames) counts[frame.event] = (counts[frame.event] ?? 0) + 1;
  return counts;
}

/**
 * What the two folds must agree on.
 *
 * A message's `endedAtMs` is left out, and deliberately. When a CONNECTION close is what ends a
 * message — a LangGraph stream that drops mid-message, as `lg-join`'s POST does — the two folds
 * anchor that close differently by construction: `reconstruct` models an import, which has no
 * close lines and closes each connection at its last frame, while a late panel is handed the
 * worker's real `conn-close` time, a fraction of a millisecond later (measured: 171.1 vs 171.4).
 * Everything else about the message — content, which frames built it, when it started, that it
 * is closed — is compared.
 */
function project(run: Run): unknown {
  return {
    runId: run.runId,
    parentRunId: run.parentRunId,
    threadId: run.threadId,
    outcome: run.outcome,
    dialect: run.dialect,
    messages: [...run.messages.values()].map((message) => ({ ...message, endedAtMs: undefined })),
    toolCalls: [...run.toolCalls.values()],
    recordSeqs: run.recordSeqs,
    issues: run.issues.map((issue) => [issue.code, issue.seq]),
    counts: run.metrics.eventCountByType,
  };
}

/** Both of the panel's folds, and the proof they are one answer. */
function foldBoth(capture: CaptureSnapshot): Run[] {
  const imported = reconstruct(capture);
  const late = foldAsLatePanel(capture);
  expect(late.runs.map(project)).toEqual(imported.runs.map(project));
  expect(late.issues.map((issue) => [issue.code, issue.seq])).toEqual(
    imported.issues.map((issue) => [issue.code, issue.seq]),
  );
  return imported.runs;
}

/**
 * The transport half, common to every scenario: every frame's NAME survived inject -> relay -> sw
 * in order, every multi-line payload decoded to the value the server serialised, and the request
 * line is the LangGraph request the page sent.
 */
function expectWireFaithful(capture: CaptureSnapshot, request: RequestLine, frames: readonly LangGraphFrame[]): void {
  const events = eventsOf(capture, request.connId);
  // Every record named — and when one is not, the failure says WHICH names were lost, counted
  // by the name the server wrote, rather than a bare list of seqs to cross-reference by hand.
  const lost: Record<string, number> = {};
  events.forEach((record, index) => {
    if (record.sseEvent !== undefined) return;
    const name = frames[index]?.event ?? '<extra record>';
    lost[name] = (lost[name] ?? 0) + 1;
  });
  expect(lost, 'SSE event names lost between inject -> relay -> sw, by name').toEqual({});
  expect(events.map((record) => record.sseEvent)).toEqual(frames.map((frame) => frame.event));
  expect(events.map((record) => record.raw)).toEqual(frames.map((frame) => frame.data));
  expect(capture.droppedBefore).toBe(0);
  expect(dialectOfConn(capture, request)).toBe('langgraph');
}

function expectLangGraphRequest(request: RequestLine, scenario: string): void {
  expect(request.method).toBe('POST');
  expect(request.url).toBe(`${pageServer.url}threads/${THREAD_ID}/runs/stream`);
  expect(request.input).toEqual({
    assistant_id: scenario,
    input: { messages: [{ type: 'human', content: PROMPT }] },
    stream_mode: ['values', 'messages-tuple', 'updates', 'custom'],
    stream_subgraphs: true,
  });
}

test.describe('lg-reasoning: the real Python-server recording, served whole', () => {
  const scenario = requireLangGraphScenario('lg-reasoning');
  let driven: Driven;

  test.beforeAll(async () => {
    driven = await drive({ scenario: scenario.name });
    console.log(
      `lg-reasoning: ${String(scenario.frames.length)} frames captured and settled in ` +
        `${String(driven.elapsedMs)} ms`,
    );
  });

  test('every frame arrives named, in order, with its multi-line payload decoded', () => {
    expect(driven.pageErrors).toEqual([]);
    expect(driven.capture.requests).toHaveLength(1);
    const request = onlyRequest(driven.capture, '/runs/stream');
    expectLangGraphRequest(request, scenario.name);
    expectWireFaithful(driven.capture, request, scenario.frames);
  });

  test('folds to one finished run whose text is the recording, byte for byte', () => {
    const runs = foldBoth(driven.capture);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.dialect).toBe('langgraph');
    expect(run.runId).toBe('019e0a0b-6976-7c72-8d57-479ba0c859f6');
    expect(run.threadId).toBe(THREAD_ID);
    expect(run.outcome).toBe('finished');
    const text = [...run.messages.values()].filter((message) => message.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.content).toBe(langGraphCanonicalText('lg-reasoning.canonical.txt'));
    expect([...run.messages.values()].filter((message) => message.kind === 'reasoning')).toHaveLength(1);
    expect(run.issues).toEqual([]);
    expect(run.metrics.eventCountByType).toEqual(countsOf(scenario.frames));
  });
});

test.describe('lg-tools-subgraph: a tool call and a subgraph child run', () => {
  const scenario = requireLangGraphScenario('lg-tools-subgraph');
  let driven: Driven;

  test.beforeAll(async () => {
    driven = await drive({ scenario: scenario.name });
  });

  test('every frame arrives named, including the namespaced ones', () => {
    expect(driven.pageErrors).toEqual([]);
    const request = onlyRequest(driven.capture, '/runs/stream');
    expectLangGraphRequest(request, scenario.name);
    expectWireFaithful(driven.capture, request, scenario.frames);
  });

  test('the tool call is parsed with its result, and the subgraph is a finished child run', () => {
    const runs = foldBoth(driven.capture);
    expect(runs.map((run) => [run.runId, run.parentRunId, run.outcome])).toEqual([
      ['r-tools', undefined, 'finished'],
      ['r-tools/research:t1', 'r-tools', 'finished'],
    ]);
    const [top, child] = runs;
    expect(top?.toolCalls.get('call_1')).toMatchObject({
      toolCallName: 'get_weather',
      parentMessageId: 'm2',
      argsText: '{"city":"SF"}',
      args: { city: 'SF' },
      closed: true,
      result: 'Sunny',
    });
    expect(top?.messages.get('m1')?.content).toBe('It is sunny in SF.');
    expect(child?.messages.get('s1')).toMatchObject({ content: 'Looking', closed: true });
    expect(child?.threadId).toBe(THREAD_ID);
    expect(runs.flatMap((run) => run.issues)).toEqual([]);
  });
});

test.describe('lg-interrupt: a run that stops for approval', () => {
  const scenario = requireLangGraphScenario('lg-interrupt');
  let driven: Driven;

  test.beforeAll(async () => {
    driven = await drive({ scenario: scenario.name });
  });

  test('every frame arrives named', () => {
    const request = onlyRequest(driven.capture, '/runs/stream');
    expectWireFaithful(driven.capture, request, scenario.frames);
  });

  test('folds to one interrupted run with no issues', () => {
    const runs = foldBoth(driven.capture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('interrupted');
    expect(runs[0]?.messages.get('m1')?.content).toBe('I need your approval first.');
    expect(runs[0]?.issues).toEqual([]);
  });
});

test.describe('lg-join: a join stream continues the run it rejoins', () => {
  const scenario = requireLangGraphScenario('lg-join');
  let driven: Driven;

  test.beforeAll(async () => {
    driven = await drive({ scenario: scenario.name, join: 'r-join' }, 2);
  });

  test('two connections, both LangGraph, each named frame for frame', () => {
    expect(driven.capture.requests).toHaveLength(2);
    const post = onlyRequest(driven.capture, '/runs/stream');
    const join = onlyRequest(driven.capture, '/runs/r-join/stream');
    expect(post.url).toBe(`${pageServer.url}threads/${THREAD_ID}/runs/stream`);
    expect(join.method).toBe('GET');
    expectWireFaithful(driven.capture, post, scenario.frames);
    expectWireFaithful(driven.capture, join, scenario.joinFrames ?? []);
  });

  test('one run, the whole answer, finished by the joining connection', () => {
    const runs = foldBoth(driven.capture);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.runId).toBe('r-join');
    expect(run.outcome).toBe('finished');
    expect(run.messages.get('m1')?.content).toBe('Hello');
    // The POST connection did end without its final values; that stays true of it (S6).
    const lastPostSeq = eventsOf(driven.capture, onlyRequest(driven.capture, '/runs/stream').connId).at(-1)?.seq;
    expect(run.issues.map((issue) => [issue.code, issue.seq])).toEqual([['lg-no-final-values', lastPostSeq]]);
  });
});

test.describe('one page, two dialects: an AG-UI run and a LangGraph run', () => {
  const scenario = requireLangGraphScenario('lg-tools-subgraph');
  let driven: Driven;

  test.beforeAll(async () => {
    driven = await drive({ scenario: scenario.name, agui: '1' }, 2);
  });

  test('two connections, one per dialect', () => {
    expect(driven.pageErrors).toEqual([]);
    expect(driven.capture.requests).toHaveLength(2);
    const agui = onlyRequest(driven.capture, '/agui');
    const lg = onlyRequest(driven.capture, '/runs/stream');
    expect(dialectOfConn(driven.capture, agui)).toBe('agui');
    expectWireFaithful(driven.capture, lg, scenario.frames);
    // AG-UI frames are unnamed on the wire, and capture must not invent a name for them.
    const aguiEvents = eventsOf(driven.capture, agui.connId);
    expect(aguiEvents.map((record) => record.sseEvent)).toEqual(aguiEvents.map(() => undefined));
    expect(aguiEvents.map((record) => record.event?.type)).toEqual(
      SCENARIOS.happy?.events.map((event) => event.type),
    );
  });

  test('each connection folds in its own dialect', () => {
    const runs = foldBoth(driven.capture);
    const aguiRuns = runs.filter((run) => run.dialect === undefined);
    const lgRuns = runs.filter((run) => run.dialect === 'langgraph');
    expect(aguiRuns).toHaveLength(1);
    expect(aguiRuns[0]?.outcome).toBe('finished');
    expect(aguiRuns[0]?.issues).toEqual([]);
    expect(lgRuns.map((run) => [run.runId, run.parentRunId, run.outcome])).toEqual([
      ['r-tools', undefined, 'finished'],
      ['r-tools/research:t1', 'r-tools', 'finished'],
    ]);
    expect(lgRuns[0]?.toolCalls.get('call_1')?.result).toBe('Sunny');
    expect(runs.flatMap((run) => run.issues)).toEqual([]);
  });
});
