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
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';

import type { ThreadplaneDevtoolsReport } from '@devtools/core/signals/report';
import { isThreadplaneReport } from '@devtools/core/signals/report';

import { clearCapture, launchWithExtension, readCapture } from '../e2e/fixtures.js';

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

async function bundle(): Promise<void> {
  for (const pkg of ['chat', 'ag-ui', 'langgraph']) {
    const file = join(distLibs, pkg, `fesm2022/threadplane-${pkg}.mjs`);
    if (!existsSync(file)) throw new Error(`${file} is missing: build Threadplane first.`);
  }
  if (!readFileSync(join(distLibs, 'chat/fesm2022/threadplane-chat.mjs'), 'utf8').includes('threadplane:devtools')) {
    throw new Error('the built @threadplane/chat carries no devtools emitter: wrong branch or a stale build.');
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
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, 'localhost', () => ok(server)));
}

const pairs = (reports: ThreadplaneDevtoolsReport[]): Pair[] => reports.map((r) => [r.eventType, r.wrote]);

async function main(): Promise<void> {
  console.log(`Threadplane: ${threadplane}`);
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
  }
}

await main();
