/**
 * Acceptance: a REAL Threadplane build's `threadplane:devtools` reports reach the extension's
 * service worker, every one, in order, unchanged.
 *
 *   pnpm --filter ag-ui-harness acceptance:threadplane [<threadplane-dir>]
 *
 * The Threadplane checkout comes from argv[2], else THREADPLANE_DIR, else ~/repos/angular-agent-framework. It is
 * only READ: its built `dist/libs/*` packages are bundled (not its sources), and its node_modules
 * supply Angular, rxjs and @ag-ui/client. Needs `pnpm --filter ag-ui-devtools build` first.
 *
 * Steps: esbuild-bundle `threadplane-page.ts` into a temp dir, serve it on
 * `http://localhost:<port>/` (the localhost family is captured without a grant), load it in
 * Chromium with the built extension, wait for the page's runs to finish, then compare the reports
 * the page heard itself with the reports the worker holds (`__AGUI_DT_TEST__.signals()`).
 *
 * THE RUN SIMULATOR (§14.4, cacheplane/threadplane#1204). Then, per adapter: turn Developer mode on
 * for the page's origin through the worker hook (the panel's switch), arm the extension's OWN
 * Interrupt (approval) template through the hook's `arm` (the panel's Arm button), submit on an
 * agent whose transport is a real network one, and hold: the hook acks `armed` → `consumed` run 0,
 * the agent shows the template's interrupt, a resume acks `consumed` run 1 and completes the run —
 * with ZERO requests to the agent endpoints (a Playwright request listener and the server both
 * count) — and the Signals reports the scripted runs produce reach the worker like any others. One
 * unarmed submit per adapter afterwards must make a request, so the zero is not vacuous.
 *
 * BUILDING THREADPLANE. When `dist/libs/{chat,ag-ui,langgraph}` is missing, or older than any file
 * under those libraries' `src/`, the three packages are built with the checkout's own Nx. The
 * checkout's `git status --porcelain` is read before and after and must not change: the build
 * writes only `dist/` (ignored), and this script never writes anywhere else in it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';

import type { ThreadplaneDevtoolsReport } from '@devtools/core/signals/report';
import { isThreadplaneReport } from '@devtools/core/signals/report';
import { parseArmCommand, type Ack } from '@devtools/core/simulate/commands';
import { armCommand, templateScript } from '@devtools/core/simulate/templates';

import type { BrowserContext, Page } from '@playwright/test';

import { clearCapture, launchWithExtension, readCapture, simulator, tabIdOf } from '../e2e/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const threadplane = resolve(
  process.argv[2] ??
    process.env.THREADPLANE_DIR ??
    // The same default as `verify:threadplane`. Until cacheplane/threadplane#1203 merges, pass the
    // hook branch's checkout instead; `bundle()` says so if the build has no emitter.
    join(homedir(), 'repos/angular-agent-framework'),
);
const distLibs = join(threadplane, 'dist/libs');
// Outside the package: ESLint's flat config does not read .gitignore, and would lint the bundle.
const outDir = mkdtempSync(join(tmpdir(), 'threadplane-acceptance-'));

type Pair = [string, string[]];

/** Threadplane's own expectations: libs/ag-ui/src/lib/devtools.spec.ts, first case. */
const EXPECTED_AG_UI: Pair[] = [
  ['submit', ['messages']],
  ['RUN_STARTED', ['status', 'isLoading', 'error', 'interrupt', 'customEvents', 'activities']],
  ['TEXT_MESSAGE_START', ['messages']],
  ['TEXT_MESSAGE_CONTENT', ['messages']],
  ['STATE_SNAPSHOT', ['state', 'messages']],
  ['STATE_DELTA', ['state', 'messages']],
  ['TOOL_CALL_START', ['toolCalls', 'messages']],
  ['TOOL_CALL_ARGS', ['toolCalls']],
  ['TOOL_CALL_END', ['toolCalls']],
  ['CUSTOM', ['customEvents']],
  ['RUN_FINISHED', ['messages', 'status', 'isLoading', 'interruptSession', 'interrupt']],
];

/**
 * libs/langgraph/src/lib/devtools.spec.ts: `run:start` and the two `run:end`s from the labelling
 * case, the stream events from the per-event case (which ends on an `error` this run does not send).
 */
const EXPECTED_LANGGRAPH: Pair[] = [
  ['run:start', ['status', 'error', 'custom', 'toolProgress', 'messages']],
  ['messages', ['messages', 'messageMetadata', 'subagents', 'toolCalls']],
  ['values', ['values', 'messages', 'subagents', 'toolCalls']],
  ['updates', ['values']],
  ['custom', ['custom']],
  ['run:end', ['subagents']],
  ['run:end', ['status']],
];

/**
 * Resolves `@threadplane/<pkg>[/<sub>]` to the BUILT package in `dist/libs/<pkg>` (its symlinks in
 * node_modules point at the sources), and each package's `#development-install` import to its own
 * built collector stub.
 */
function threadplaneDist(): Plugin {
  return {
    name: 'threadplane-dist',
    setup(b) {
      b.onResolve({ filter: /^@threadplane\// }, (args) => {
        const [, pkg, ...rest] = args.path.split('/');
        const root = join(distLibs, pkg ?? '');
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          exports?: Record<string, string | { import?: string; default?: string }>;
          module?: string;
          main?: string;
        };
        const key = rest.length ? `./${rest.join('/')}` : '.';
        const entry = manifest.exports?.[key];
        const target =
          typeof entry === 'string'
            ? entry
            : (entry?.import ?? entry?.default ?? (key === '.' ? (manifest.module ?? manifest.main) : undefined));
        if (!target) throw new Error(`${args.path}: no export ${key} in ${root}/package.json`);
        return { path: join(root, target) };
      });
      b.onResolve({ filter: /^#development-install$/ }, (args) => {
        const pkg = args.importer.slice(distLibs.length + 1).split('/')[0] ?? '';
        return { path: join(distLibs, pkg, '.install-collector/development-install.mjs') };
      });
    },
  };
}

const LIBS = ['chat', 'ag-ui', 'langgraph'] as const;
const bundleOf = (pkg: string): string => join(distLibs, pkg, `fesm2022/threadplane-${pkg}.mjs`);

/** The newest modification time of any file under `dir`. */
function newestUnder(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestUnder(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: threadplane, encoding: 'utf8' });
}

/** Build Threadplane's three packages if their dist is missing or older than their sources. */
function ensureThreadplaneBuilt(): void {
  const stale = LIBS.filter(
    (pkg) => !existsSync(bundleOf(pkg)) || statSync(bundleOf(pkg)).mtimeMs < newestUnder(join(threadplane, 'libs', pkg, 'src')),
  );
  const before = gitStatus();
  console.log(`Threadplane git status before: ${before.trim() === '' ? 'clean' : `\n${before}`}`);
  if (stale.length > 0) {
    console.log(`Building Threadplane (${stale.join(', ')} missing or older than its sources)…`);
    execFileSync(join(threadplane, 'node_modules/.bin/nx'), ['run-many', '-t', 'build', '-p', LIBS.join(',')], {
      cwd: threadplane,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
    });
  } else {
    console.log('Threadplane dist is up to date with its sources; not rebuilding.');
  }
  const after = gitStatus();
  console.log(`Threadplane git status after:  ${after.trim() === '' ? 'clean' : `\n${after}`}`);
  if (after !== before) throw new Error('building Threadplane changed its git status; refusing to go on.');
}

async function bundle(): Promise<void> {
  for (const pkg of LIBS) {
    if (!existsSync(bundleOf(pkg))) throw new Error(`${bundleOf(pkg)} is missing: build Threadplane first.`);
  }
  const chat = readFileSync(bundleOf('chat'), 'utf8');
  if (!chat.includes('threadplane:devtools')) {
    throw new Error('the built @threadplane/chat carries no devtools emitter: wrong branch or a stale build.');
  }
  if (!chat.includes('threadplane:devtools:arm')) {
    throw new Error('the built @threadplane/chat has no scripted runs: build cacheplane/threadplane#1204.');
  }
  await build({
    entryPoints: [join(here, 'threadplane-page.ts')],
    outfile: join(outDir, 'threadplane-page.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: 'inline',
    logLevel: 'warning',
    nodePaths: [join(threadplane, 'node_modules')],
    // No `define` for ngDevMode: development mode is Angular's default, as in `ng serve`.
    plugins: [threadplaneDist()],
  });
}

/** Requests that reached the server's agent endpoints — what a scripted run must never cause. */
const agentHits: string[] = [];
const isAgentPath = (path: string): boolean => /^\/(langgraph|agui)(\/|\?|$)/.test(path);

function serve(): Promise<Server> {
  const html =
    '<!doctype html><meta charset="utf-8"><title>Threadplane acceptance</title>' +
    '<script type="module" src="/threadplane-page.js"></script>';
  const server = createServer((req, res) => {
    if (req.url === '/threadplane-page.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(join(outDir, 'threadplane-page.js')));
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      if (isAgentPath(req.url ?? '')) agentHits.push(`${req.method ?? '?'} ${req.url ?? ''}`);
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, 'localhost', () => ok(server)));
}

const pairs = (reports: ThreadplaneDevtoolsReport[]): Pair[] => reports.map((r) => [r.eventType, r.wrote]);

/* -------------------------------------------------------------------------- */
/* The run simulator, against the real build                                    */
/* -------------------------------------------------------------------------- */

type SimAdapter = 'langgraph' | 'ag-ui';

interface SimResult {
  status: string;
  interrupt: unknown;
  error: string | null;
  messages: string[];
  threw: string | null;
}

/** The acks the worker holds for `armId`, once one in `state` (with `run`, if given) is among them. */
async function waitForAck(ctx: BrowserContext, armId: string, state: Ack['state'], run?: number): Promise<Ack[]> {
  const mine = async (): Promise<Ack[]> => (await simulator.acks(ctx)).filter((ack) => ack.armId === armId);
  const deadline = Date.now() + 15_000;
  let acks = await mine();
  while (!acks.some((ack) => ack.state === state && ack.run === run) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    acks = await mine();
  }
  return acks;
}

const QUESTION = 'Send the refund of $42 to the customer?';
const DONE = 'Approved — the refund has been sent.';

async function simulate(
  ctx: BrowserContext,
  page: Page,
  tabId: number,
  adapter: SimAdapter,
  requests: string[],
  failures: string[],
): Promise<void> {
  const fail = (message: string): void => {
    failures.push(`simulator (${adapter}): ${message}`);
  };
  const armId = `acceptance-${adapter}-${String(Date.now())}`;
  // The extension's own template — what the Simulate tab arms for "Interrupt (approval)".
  const command = armCommand(armId, templateScript(adapter, 'interrupt'));
  if (!parseArmCommand(command).ok) fail('the extension’s own interrupt template does not validate');
  const requestsBefore = requests.length;
  const hitsBefore = agentHits.length;

  const dispatch = await simulator.arm(ctx, tabId, command);
  console.log(`\n${adapter}: arm ${armId} → ${JSON.stringify(dispatch)}`);
  if (dispatch?.outcome !== 'dispatched') fail(`the arm was not dispatched: ${JSON.stringify(dispatch)}`);
  let acks = await waitForAck(ctx, armId, 'armed');
  console.log(`  acks after arm:    ${JSON.stringify(acks)}`);

  const first = await page.evaluate(
    ({ adapter }) => {
      const sim = (window as unknown as { __TP_SIM__: { submit(a: string, i: unknown): Promise<SimResult> } }).__TP_SIM__;
      return sim.submit(adapter, { message: 'Refund order 1234.' });
    },
    { adapter },
  );
  acks = await waitForAck(ctx, armId, 'consumed', 0);
  console.log(`  acks after submit: ${JSON.stringify(acks)}`);
  console.log(`  agent after submit: status=${first.status} interrupt=${JSON.stringify(first.interrupt)} error=${String(first.error)}`);
  console.log(`                      messages=${JSON.stringify(first.messages)}`);
  if (first.threw !== null) fail(`submit threw: ${first.threw}`);
  if (first.error !== null) fail(`the agent errored after run 0: ${first.error}`);
  if (first.interrupt === null) fail('no interrupt after run 0');
  else if (!JSON.stringify(first.interrupt).includes(QUESTION)) fail(`the interrupt does not carry the template's question: ${JSON.stringify(first.interrupt)}`);

  const second = await page.evaluate(
    ({ adapter }) => {
      const sim = (window as unknown as { __TP_SIM__: { submit(a: string, i: unknown): Promise<SimResult> } }).__TP_SIM__;
      return sim.submit(adapter, { resume: { approved: true } });
    },
    { adapter },
  );
  acks = await waitForAck(ctx, armId, 'consumed', 1);
  console.log(`  acks after resume: ${JSON.stringify(acks)}`);
  console.log(`  agent after resume: status=${second.status} interrupt=${JSON.stringify(second.interrupt)} error=${String(second.error)}`);
  console.log(`                      messages=${JSON.stringify(second.messages)}`);
  if (second.threw !== null) fail(`resume threw: ${second.threw}`);
  if (second.error !== null) fail(`the agent errored after run 1: ${second.error}`);
  if (second.interrupt !== null) fail(`the interrupt is still set after the resume: ${JSON.stringify(second.interrupt)}`);
  if (second.status !== 'idle') fail(`the run did not complete: status ${second.status}`);
  if (second.messages.at(-1) !== DONE) fail(`the last message is not the template's answer: ${JSON.stringify(second.messages.at(-1))}`);

  const expected: Ack[] = [
    { v: 1, armId, state: 'armed' },
    { v: 1, armId, state: 'consumed', run: 0 },
    { v: 1, armId, state: 'consumed', run: 1 },
  ];
  if (!isDeepStrictEqual(acks, expected)) fail(`acks differ:\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(acks)}`);

  const madeRequests = requests.slice(requestsBefore);
  const madeHits = agentHits.slice(hitsBefore);
  console.log(`  agent-endpoint requests during the scripted runs: browser ${String(madeRequests.length)}, server ${String(madeHits.length)}`);
  if (madeRequests.length > 0 || madeHits.length > 0) {
    fail(`the scripted runs reached the network: ${JSON.stringify([...madeRequests, ...madeHits])}`);
  }
}

/** One UNARMED submit per adapter must reach the network — proof the zero above can fail. */
async function controlRequests(page: Page, requests: string[], failures: string[]): Promise<void> {
  for (const adapter of ['ag-ui', 'langgraph'] as const) {
    const before = requests.length;
    const hitsBefore = agentHits.length;
    await page.evaluate(
      ({ adapter }) => {
        const sim = (window as unknown as { __TP_SIM__: { submit(a: string, i: unknown): Promise<unknown> } }).__TP_SIM__;
        return sim.submit(adapter, { message: 'unarmed' });
      },
      { adapter },
    );
    const made = requests.slice(before);
    console.log(`\ncontrol (${adapter}, unarmed): browser ${String(made.length)} request(s), server ${String(agentHits.length - hitsBefore)} hit(s): ${JSON.stringify(made)}`);
    if (made.length === 0) failures.push(`control (${adapter}): an unarmed submit made no request, so the listener proves nothing`);
  }
}

async function main(): Promise<void> {
  console.log(`Threadplane: ${threadplane}`);
  ensureThreadplaneBuilt();
  await bundle();
  const server = await serve();
  const port = (server.address() as AddressInfo).port;
  const { ctx } = await launchWithExtension();
  const failures: string[] = [];
  try {
    await clearCapture(ctx);
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Every request the page makes to an agent endpoint, from the browser's side.
    const requests: string[] = [];
    page.on('request', (request) => {
      if (isAgentPath(new URL(request.url()).pathname)) requests.push(`${request.method()} ${request.url()}`);
    });
    await page.goto(`http://localhost:${String(port)}/`);
    await page.waitForFunction(() => (window as { __TP_DONE__?: boolean }).__TP_DONE__ === true, null, {
      timeout: 30_000,
    });
    const { dispatched, error } = await page.evaluate(() => {
      const w = window as unknown as { __TP_REPORTS__: unknown[]; __TP_ERROR__?: string };
      return { dispatched: w.__TP_REPORTS__, error: w.__TP_ERROR__ };
    });
    if (error) failures.push(`the page's runs threw: ${error}`);
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);

    // Poll until the worker holds as many as the page dispatched; the bound only matters if broken.
    const deadline = Date.now() + 15_000;
    let held = (await readCapture(ctx)).signals;
    while (held.reports.length < dispatched.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      held = (await readCapture(ctx)).signals;
    }

    const invalid = dispatched.filter((report) => !isThreadplaneReport(report));
    for (const report of invalid) failures.push(`rejected by isThreadplaneReport: ${JSON.stringify(report)}`);
    if (dispatched.length === 0) failures.push('the page dispatched no reports at all (not in dev mode?)');
    if (!isDeepStrictEqual(held.reports, dispatched)) {
      failures.push(
        `the worker's reports differ from the page's: dispatched ${String(dispatched.length)}, ` +
          `held ${String(held.reports.length)}, ring dropped ${String(held.droppedBefore)}`,
      );
    }

    const valid = dispatched.filter(isThreadplaneReport);
    const agUi = valid.filter((r) => r.adapter === 'ag-ui');
    const langgraph = valid.filter((r) => r.adapter === 'langgraph');
    const expect = (name: string, actual: Pair[], expected: Pair[]): void => {
      if (!isDeepStrictEqual(actual, expected)) {
        failures.push(`${name} [eventType, wrote] differs from Threadplane's spec:\n` +
          `  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
      }
    };
    expect('AG-UI', pairs(agUi), EXPECTED_AG_UI);
    expect('LangGraph', pairs(langgraph), EXPECTED_LANGGRAPH);
    for (const [name, list] of [['ag-ui', agUi], ['langgraph', langgraph]] as const) {
      const seqs = list.map((r) => r.seq);
      if (!isDeepStrictEqual(seqs, seqs.map((_, i) => i + 1))) failures.push(`${name} seqs not 1..n: ${seqs.join(',')}`);
      if (new Set(list.map((r) => r.agent)).size !== 1) failures.push(`${name}: expected one agent id`);
    }

    console.log(`\nDispatched by the page: ${String(dispatched.length)}  (ag-ui ${String(agUi.length)}, langgraph ${String(langgraph.length)})`);
    console.log(`Held by the worker:     ${String(held.reports.length)}  (ring dropped ${String(held.droppedBefore)})`);
    for (const [name, list] of [['ag-ui', agUi], ['langgraph', langgraph]] as const) {
      console.log(`\n${name}:`);
      for (const r of list) console.log(`  #${String(r.seq).padStart(2)} ${r.eventType.padEnd(22)} ${JSON.stringify(r.wrote)}`);
    }

    // The run simulator.
    const origin = `http://localhost:${String(port)}`;
    const tabId = await tabIdOf(ctx, page);
    const enabled = await simulator.setDeveloperMode(ctx, origin, true);
    console.log(`\nDeveloper mode for ${origin}: ${String(enabled)}`);
    if (!enabled) failures.push('Developer mode could not be turned on for the harness origin');
    for (const adapter of ['langgraph', 'ag-ui'] as const) {
      await simulate(ctx, page, tabId, adapter, requests, failures);
    }
    // The scripted runs went through the adapters' real code, so they produced Signals reports like
    // any run — and every one of those reached the worker too. Read before the control submits.
    const allDispatched = await page.evaluate(() => (window as unknown as { __TP_REPORTS__: unknown[] }).__TP_REPORTS__);
    const reportDeadline = Date.now() + 15_000;
    let allHeld = (await readCapture(ctx)).signals;
    while (allHeld.reports.length < allDispatched.length && Date.now() < reportDeadline) {
      await new Promise((r) => setTimeout(r, 25));
      allHeld = (await readCapture(ctx)).signals;
    }
    const scriptedReports = allDispatched.slice(dispatched.length).filter(isThreadplaneReport);
    console.log(`\nSignals reports from the scripted runs: ${String(scriptedReports.length)} (all held by the worker: ${String(isDeepStrictEqual(allHeld.reports, allDispatched))})`);
    if (scriptedReports.length === 0) failures.push('the scripted runs produced no Signals reports');
    if (!isDeepStrictEqual(allHeld.reports, allDispatched)) {
      failures.push('after the scripted runs, the worker’s Signals reports differ from the page’s');
    }

    await controlRequests(page, requests, failures);
    if (pageErrors.length) failures.push(`page errors after the simulator: ${pageErrors.join(' | ')}`);
  } finally {
    await ctx.close();
    await new Promise((r) => server.close(r));
    rmSync(outDir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\nFAIL\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: every report the real Threadplane build dispatched reached the worker, in order, unchanged.');
    console.log('PASS: the extension’s interrupt templates scripted both adapters through armed → consumed 0 → interrupt → resume → consumed 1 → idle, with no agent-endpoint request.');
  }
}

await main();
