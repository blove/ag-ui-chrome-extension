/**
 * T7: the acceptance test for the Threadplane export — generated specs run inside a real
 * Threadplane checkout, under Threadplane's own Vitest config and a strict type check.
 *
 *   pnpm verify:threadplane [<threadplane-checkout>] [--mutate]
 *
 * The checkout is the argument, else `THREADPLANE_DIR`, else `~/repos/angular-agent-framework`.
 * On demand and before release, not in CI: CI has no Threadplane checkout.
 *
 * For every capture below, plain and with every redaction group, the spec the Export button
 * would produce is written to `libs/langgraph/src/lib/__devtools_replay__/` (importing
 * Threadplane's `public-api` directly, since the package is not installed inside its own tree),
 * type-checked, and run. The directory is removed afterwards whatever happens, and the checkout's
 * `git status` must be what it was before — the script refuses to start over an existing
 * directory so it never deletes something it did not write.
 *
 * `--mutate` flips one generated expectation. The run must then fail: that is the proof the
 * green run asserts something.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The harness scenarios are the same frames the e2e serves over real SSE. The harness file
// imports `@devtools/…`, which this package's tsconfig maps back onto `src/` for this import.
import { requireLangGraphScenario } from '../../harness/fixtures/langgraph';
import { toThreadplaneSpec } from '../src/core/fixture/threadplane';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../src/core/jsonl/redact';
import { buildExport } from '../src/panel/export/build';
import { applyLoaded } from '../src/panel/import/apply-loaded';
import { loadJsonl } from '../src/panel/import/load-jsonl';
import { initialPanelState } from '../src/panel/model/panel-types';
import { aiChunk, DEFAULT_LG_BODY, langGraphJsonl } from '../src/test/langgraph-capture';

const REPLAY_DIR = 'libs/langgraph/src/lib/__devtools_replay__';
const IMPORT_FROM = '../../public-api';
const EXPORTED_AT = '2026-09-30T12:00:00.000Z';

interface Capture {
  readonly name: string;
  readonly jsonl: string;
}

function captures(): Capture[] {
  const reasoning = readFileSync(new URL('../src/test/fixtures/lg-reasoning.agui.jsonl', import.meta.url), 'utf8');
  const tools = requireLangGraphScenario('lg-tools-subgraph');
  const interrupt = requireLangGraphScenario('lg-interrupt');
  const join = requireLangGraphScenario('lg-join');
  const joinFrames = join.joinFrames ?? [];
  const joinCapture = [
    langGraphJsonl(join.frames),
    // S8: the join is its own connection — a GET with no body, continuing the POST's numbering.
    langGraphJsonl(joinFrames, {
      connId: 'c2',
      method: 'GET',
      url: 'http://localhost:2024/threads/t-1/runs/r-join/stream',
      body: null,
      header: false,
      firstSeq: join.frames.length + 1,
    }),
  ].join('\n');
  // The run that answers lg-interrupt's question: a `command.resume` body with `input: null` (T3).
  const resume = langGraphJsonl(
    [
      { event: 'metadata', data: { run_id: 'r-resume', attempt: 1 } },
      aiChunk('m2', 'Deleted the file.', { chunk_position: 'last' }),
      {
        event: 'values',
        data: {
          messages: [
            { type: 'human', id: 'h1', content: 'delete the file' },
            { type: 'ai', id: 'm1', content: 'I need your approval first.' },
            { type: 'ai', id: 'm2', content: 'Deleted the file.' },
          ],
        },
      },
    ],
    { body: { assistant_id: 'agent', input: null, command: { resume: 'approved' }, stream_mode: DEFAULT_LG_BODY.stream_mode } },
  );
  // lg-tools-subgraph's final `values` drops the tool-calling AI message, so it asserts no tool
  // names; this capture keeps it, so the toolCallNames expectation is run for real too.
  const human = { type: 'human', id: 'h1', content: 'weather in SF?' };
  const toolCalls = langGraphJsonl([
    { event: 'metadata', data: { run_id: 'r-tool-calls', attempt: 1 } },
    { event: 'values', data: { messages: [human] } },
    aiChunk('m1', [], {
      tool_call_chunks: [{ index: 0, id: 'call_1', name: 'get_weather', args: '{"city":"SF"}', type: 'tool_call_chunk' }],
    }),
    aiChunk('m1', [], { chunk_position: 'last' }),
    { event: 'messages', data: [{ type: 'tool', id: 't1', tool_call_id: 'call_1', content: 'Sunny' }, { langgraph_node: 'tools' }] },
    aiChunk('m2', 'It is sunny in SF.', { chunk_position: 'last' }),
    {
      event: 'values',
      data: {
        messages: [
          human,
          { type: 'ai', id: 'm1', content: '', tool_calls: [{ name: 'get_weather', args: { city: 'SF' }, id: 'call_1', type: 'tool_call' }] },
          { type: 'tool', id: 't1', tool_call_id: 'call_1', content: 'Sunny' },
          { type: 'ai', id: 'm2', content: 'It is sunny in SF.' },
        ],
      },
    },
  ]);
  return [
    { name: 'lg-reasoning', jsonl: reasoning },
    { name: 'lg-tools-subgraph', jsonl: langGraphJsonl(tools.frames) },
    { name: 'lg-interrupt', jsonl: langGraphJsonl(interrupt.frames) },
    { name: 'lg-join', jsonl: joinCapture },
    { name: 'lg-resume', jsonl: resume },
    { name: 'lg-tool-calls', jsonl: toolCalls },
  ];
}

/** The spec the Export button produces for this capture: loaded, exported with `groups`, generated. */
function specFor(capture: Capture, groups: RedactionGroup[], filename: string): string {
  const state = applyLoaded(initialPanelState(), loadJsonl(capture.jsonl), `${capture.name}.agui.jsonl`, 0);
  const { lines } = buildExport(state, { scope: null, groups, toolVersion: 'verify-threadplane', exportedAtIso: EXPORTED_AT });
  const spec = toThreadplaneSpec(lines, { filename, importFrom: IMPORT_FROM });
  if (spec === null) throw new Error(`${capture.name}: no LangGraph connection in the export`);
  return spec;
}

/** Flip the first status assertion, which every generated spec has. */
function mutate(spec: string): { spec: string; description: string } {
  const match = /expect\(agent\.status\(\)\)\.toBe\("(idle|error)"\);/.exec(spec);
  if (match === null) throw new Error('--mutate: no status assertion to flip');
  const flipped = match[1] === 'idle' ? 'error' : 'idle';
  return {
    spec: spec.replace(match[0], `expect(agent.status()).toBe("${flipped}");`),
    description: `status "${match[1] ?? ''}" → "${flipped}"`,
  };
}

/**
 * The strict check the previous manual verification used: the specs must type-check under the
 * flags a Threadplane consumer is likely to have on, not just run under Vitest's transpile-only
 * pipeline. Extends the library's build tsconfig so `lib`, `module`, decorators and the like match.
 */
const TYPECHECK_TSCONFIG = {
  extends: '../../../tsconfig.lib.json',
  compilerOptions: {
    strict: true,
    noUnusedLocals: true,
    noPropertyAccessFromIndexSignature: true,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    inlineSources: false,
    // As Threadplane's own tsconfig.type-tests.json: wide enough to hold the sibling libraries
    // the public API reaches through tsconfig paths.
    rootDir: '../../../../..',
    skipLibCheck: true,
    types: [],
  },
  files: [],
  include: ['./*.spec.ts'],
  // The library config excludes specs; these are the files to check.
  exclude: [],
  references: [],
};

interface RunResult {
  readonly code: number;
  readonly output: string;
}

let current: ReturnType<typeof spawn> | undefined;

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
    current = child;
    let output = '';
    const take = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      current = undefined;
      resolvePromise({ code: code ?? 1, output });
    });
  });
}

function gitStatus(dir: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all']);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`git status exited ${String(code)}`))));
  });
}

/** Vitest's closing lines, e.g. `Test Files  10 passed (10)` and `Tests  12 passed (12)`. */
function vitestSummary(output: string): string[] {
  return output
    .split('\n')
    // eslint-disable-next-line no-control-regex -- colour codes, in case a tool ignores NO_COLOR
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => /^(Test Files|Tests)\s/.test(line));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mutateFlag = args.includes('--mutate');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const threadplane = resolve(positional[0] ?? process.env['THREADPLANE_DIR'] ?? join(homedir(), 'repos/angular-agent-framework'));
  const libDir = join(threadplane, 'libs/langgraph');
  const outDir = join(threadplane, REPLAY_DIR);

  if (!existsSync(join(libDir, 'vite.config.mts'))) {
    console.error(`verify:threadplane: ${threadplane} is not a Threadplane checkout (no libs/langgraph/vite.config.mts)`);
    return 2;
  }
  if (existsSync(outDir)) {
    console.error(`verify:threadplane: ${outDir} already exists — refusing to overwrite it. Remove it and re-run.`);
    return 2;
  }

  const before = await gitStatus(threadplane);
  let created = false;
  const cleanUp = (): void => {
    if (created) rmSync(outDir, { recursive: true, force: true });
    created = false;
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    current?.kill(signal);
    cleanUp();
    console.error(`\nverify:threadplane: interrupted by ${signal}; removed ${REPLAY_DIR}`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let vitest: RunResult;
  let tsc: RunResult;
  const written: string[] = [];
  let mutation: string | undefined;
  try {
    mkdirSync(outDir);
    created = true;
    for (const capture of captures()) {
      for (const [suffix, groups] of [
        ['', []],
        ['-redacted', [...ALL_REDACTION_GROUPS]],
      ] as const) {
        const filename = `${capture.name}${suffix}.spec.ts`;
        let spec = specFor(capture, [...groups], filename);
        if (mutateFlag && mutation === undefined) {
          const mutated = mutate(spec);
          spec = mutated.spec;
          mutation = `${filename}: ${mutated.description}`;
        }
        writeFileSync(join(outDir, filename), spec);
        written.push(filename);
      }
    }
    writeFileSync(join(outDir, 'tsconfig.json'), `${JSON.stringify(TYPECHECK_TSCONFIG, null, 2)}\n`);
    console.log(`verify:threadplane: wrote ${String(written.length)} specs to ${outDir}`);
    if (mutation !== undefined) console.log(`verify:threadplane: --mutate flipped ${mutation}`);

    console.log('\n$ tsc --noEmit -p __devtools_replay__/tsconfig.json');
    tsc = await run(join(threadplane, 'node_modules/.bin/tsc'), ['--noEmit', '-p', join(REPLAY_DIR, 'tsconfig.json')], threadplane);
    console.log('\n$ vitest run --config vite.config.mts src/lib/__devtools_replay__');
    vitest = await run(join(threadplane, 'node_modules/.bin/vitest'), ['run', '--config', 'vite.config.mts', 'src/lib/__devtools_replay__'], libDir);
  } finally {
    cleanUp();
  }

  const after = await gitStatus(threadplane);
  const clean = before === after;

  console.log('\n── verify:threadplane summary ──');
  console.log(`checkout:   ${threadplane}`);
  console.log(`specs:      ${String(written.length)} (${written.join(', ')})`);
  if (mutation !== undefined) console.log(`mutation:   ${mutation}`);
  console.log(`type check: ${tsc.code === 0 ? 'passed' : `FAILED (exit ${String(tsc.code)})`}`);
  console.log(`vitest:     ${vitest.code === 0 ? 'passed' : `FAILED (exit ${String(vitest.code)})`}`);
  for (const line of vitestSummary(vitest.output)) console.log(`            ${line}`);
  console.log(`checkout:   ${clean ? 'git status unchanged' : 'git status CHANGED'}`);
  if (!clean) console.log(`before:\n${before}\nafter:\n${after}`);

  const ok = tsc.code === 0 && vitest.code === 0 && clean;
  console.log(`result:     ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
