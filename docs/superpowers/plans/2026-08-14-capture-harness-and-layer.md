# Capture harness + capture layer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic test harness that serves real AG-UI streams, and a capture layer that intercepts them — ending with live traffic reaching the panel.

**Architecture:** `AGUIMock` serves scripted AG-UI events as real SSE. A minimal page drives runs with the real `@ag-ui/client` `HttpAgent`. The extension's MAIN-world `inject/` patches `fetch`/XHR/`EventSource`, tees the response body, parses frames with the existing `core/sse/parser`, and posts them to `relay/` in the ISOLATED world, which forwards over a port to the service worker's per-tab ring buffer. Playwright asserts by evaluating inside the service worker — the DevTools panel UI is not reachable from automation.

**Tech stack:** `@copilotkit/aimock` 1.38, `@ag-ui/client`, Playwright, Vitest 4. No new runtime dependencies — the shipped bundle stays Preact-only.

**Design:** [`2026-08-14-capture-harness-design.md`](../specs/2026-08-14-capture-harness-design.md), decisions H1–H8.
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §3, §5, §11, §15.

---

## Why the harness comes first

The capture layer currently has nothing to capture. Nothing in existence produces a `.agui.jsonl`
except three fixtures written by hand, which encode our *assumptions* about AG-UI rather than
reality — if an assumption is wrong, all 675 existing tests agree with us.

This is the same move that made the phase-1 panel buildable: reuse the path already known to be
correct, one layer further out. The harness serves streams whose expected validator output was
**observed** by running them through the real `core/` pipeline, not guessed.

## Scope

**In:** the harness package (server, page, scenario corpus, Playwright e2e, Tier B recording), the
full capture path (`inject/` fetch + XHR + EventSource, `relay/`, `sw/` ring buffer and ports), panel
live wiring, and CI.

**Out:** protobuf *decoding* — §5.4 defers it to Phase 3, so this plan detects and labels binary
transport only. Export and the redacted bug-report bundle. The Runs, State, and Messages tabs.
All of requirements §14 Phase 2.

## Task order

| # | Task | Package |
|---|---|---|
| 1 | `packages/harness` scaffold | harness |
| 2 | Scenario corpus (`SCENARIOS`), incl. golden-fixture converter | harness |
| 3 | `AGUIMock` server wrapper | harness |
| 4 | Harness page — real `HttpAgent` + plain rendering + page server | harness |
| 5 | Playwright fixtures and the first e2e | harness |
| 6 | `inject/protocol.ts` | devtools |
| 7 | `inject/fetch-patch.ts` — tee, body capture, back-pressure | devtools |
| 8 | `inject/inject.ts` entry | devtools |
| 9 | `inject/xhr-patch.ts`, `inject/eventsource-patch.ts` | devtools |
| 10 | `relay/relay.ts` — the security boundary | devtools |
| 11 | `sw/ring-buffer.ts` | devtools |
| 12 | `sw/index.ts` — ports, per-tab buffers, session mirror, test hook | devtools |
| 13a/b | Panel live wiring | devtools |
| 14 | `record.ts` — Tier B recording from the Dojo, redacted | harness |
| 15 | CI | root |

**Note the ordering correction:** Task 2 (scenarios) precedes Task 3 (server), because
`startHarnessServer` resolves names out of `SCENARIOS`. The design doc listed these the other way
round.

## Conventions

- Commands run from the named package; each step says which.
- `noUncheckedIndexedAccess` is ON everywhere; test files are typechecked. `.at(-1)`, never `[length-1]`.
- `@typescript-eslint/no-explicit-any` is ON — use `unknown`.
- `src/core/**` is NOT modified by this plan. Import from it; never reimplement it.
- Never write the string `@vitest-environment` in prose — Vitest reads it out of any first comment.
- Commit after every green cycle.

---

# Section A — `packages/harness`: scaffold, corpus, server

Covers the harness package itself: the workspace scaffold, the `SCENARIOS` corpus (converted from
the three golden `.agui.jsonl` fixtures plus the authored edge cases), and the `AGUIMock`-backed
server. Sections B and C build the page and the Playwright e2e on top of this.

**Order note.** The brief numbered the server as Task 2 and the fixtures as Task 3. They are
inverted here because `startHarnessServer` resolves scenario names out of `SCENARIOS` —
`use('malformed')` has nothing to look up until the corpus exists — so the corpus must land first
or Task 2 cannot compile. Nothing else changed.

**Every `expectIssues` value below was observed, not assumed.** The whole section was built and run
in `scratchpad/verify-cap-A/`: 27 Playwright tests pass, `tsc --noEmit` is clean under
`noUncheckedIndexedAccess`, and `eslint .` is clean. The observed pipeline output is transcribed at
the bottom under **Verification log**.

Versions confirmed with `npm view <pkg> version` on the day of writing: `@copilotkit/aimock`
1.38.0, `@playwright/test` 1.62.1, `@ag-ui/client` 0.0.58.

---

### Task 1: `packages/harness` package scaffold

Scaffolding, so it ends with real verification commands rather than a red-then-green cycle — but it
still leaves a guard test behind, because the one thing worth asserting here (H6: none of this may
ever reach the shipped bundle) is exactly the kind of invariant that rots silently.

**Files:**
- Create: `packages/harness/package.json`
- Create: `packages/harness/tsconfig.json`
- Create: `packages/harness/playwright.config.ts`
- Create: `packages/harness/eslint.config.js`
- Create: `packages/harness/.gitignore`
- Test: `packages/harness/test/package.spec.ts`

- [ ] **Step 1: Create the package files**

`packages/harness/package.json`

```json
{
  "name": "ag-ui-harness",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Private test harness: serves AG-UI fixtures over real SSE and drives the capture layer",
  "license": "MIT",
  "scripts": {
    "test:ci": "playwright test",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint ."
  },
  "devDependencies": {
    "@ag-ui/client": "0.0.58",
    "@copilotkit/aimock": "^1.38.0",
    "@eslint/js": "^9.39.5",
    "@playwright/test": "^1.62.1",
    "@types/node": "^22.20.1",
    "eslint": "^9.39.5",
    "globals": "^17.11.0",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.67.0"
  }
}
```

There is no `dependencies` key and there must never be one. H6 keeps aimock, Playwright and
`@ag-ui/client` out of the extension's dependency tree; a runtime dependency is the only kind that
can reach a published bundle, so the absence of the key is the enforcement.

The script is `test:ci`, not `test`. pnpm special-cases `test` as an npm lifecycle script:
`pnpm -r test` exits 0 for a package that defines none, so a harness wired only to `test` would be
silently skipped by CI — which is why the root already runs `pnpm -r run test:ci`.

`packages/harness/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "paths": {
      "@devtools/*": ["../devtools/src/*"]
    }
  },
  "include": ["fixtures", "server", "page", "e2e", "test", "playwright.config.ts"]
}
```

The `@devtools/*` alias is how the harness reaches `core/` — `AguiEvent`, `CaptureRecord`,
`createSseParser`, `createRunBuilder`. `packages/devtools` is private and publishes no `exports`
map, so a bare package specifier would not resolve; a path alias does, and Playwright's esbuild
transform resolves it from this same `tsconfig.json`. It is a read-only reference: the contract
forbids modifying `src/core/**`, and nothing in the harness writes to it.

`packages/harness/playwright.config.ts`

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // Every test in this package binds a real TCP port and drives a real stream. Serialising them
  // keeps port pressure and timing measurements honest — `keepalive-gap` asserts on wall-clock
  // arrival times, which parallel workers on a loaded machine would distort.
  fullyParallel: false,
  workers: 1,
  // `keepalive-gap` sleeps 15.5 s on the wire on purpose. The 30 s default would leave almost no
  // headroom on a slow machine.
  timeout: 60_000,
  reporter: 'list',
});
```

`packages/harness/eslint.config.js`

```js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
```

`tseslint.configs.recommended` is what carries `@typescript-eslint/no-explicit-any`. Without a
lint config the harness would be the one package in the repo where `any` is legal, and the root
`pnpm -r lint` would silently skip it.

`packages/harness/.gitignore`

```
test-results/
playwright-report/
.playwright/
```

- [ ] **Step 2: Install and verify the workspace picked the package up**

Run, from the repo root:

```
pnpm install
```

Expected: pnpm reports `+ 9` dev dependencies added for `packages/harness`, resolving
`@copilotkit/aimock 1.38.0`, `@playwright/test 1.62.1`, `@ag-ui/client 0.0.58`,
`typescript 5.9.x`, `eslint 9.39.x`, `typescript-eslint 8.67.x`, `globals 17.11.x`,
`@eslint/js 9.39.x`, `@types/node 22.20.x`. `pnpm-workspace.yaml` already globs `packages/*`, so
no root file changes.

```
pnpm --filter ag-ui-harness exec playwright --version
```

Expected: `Version 1.62.1`

```
pnpm --filter ag-ui-harness typecheck
pnpm --filter ag-ui-harness lint
```

Expected: both exit 0 with no output.

- [ ] **Step 3: Add the guard test that locks the invariants**

`packages/harness/test/package.spec.ts`

```ts
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

interface PackageManifest {
  name?: unknown;
  private?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
}

function readManifest(relativePath: string): PackageManifest {
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`not an object: ${relativePath}`);
  }
  return parsed as PackageManifest;
}

test('the harness is private and can never be published', () => {
  const manifest = readManifest('../package.json');
  expect(manifest.name).toBe('ag-ui-harness');
  expect(manifest.private).toBe(true);
});

test('every harness dependency is a devDependency', () => {
  const manifest = readManifest('../package.json');
  // H6: the shipped extension stays Preact-only. Nothing here may become a runtime dependency,
  // because a runtime dependency is the one kind that can reach a published bundle.
  expect(manifest.dependencies).toBeUndefined();

  const devDependencies = manifest.devDependencies;
  expect(typeof devDependencies).toBe('object');
  const names = Object.keys(devDependencies as Record<string, unknown>);
  expect(names).toContain('@copilotkit/aimock');
  expect(names).toContain('@playwright/test');
  expect(names).toContain('@ag-ui/client');
});

test('the root delegates to test:ci, which this package defines', () => {
  const manifest = readManifest('../package.json');
  const scripts = manifest.scripts;
  expect(typeof scripts).toBe('object');
  // `pnpm` special-cases `test` as a lifecycle script: `pnpm -r test` exits 0 for a package that
  // defines none, so a harness wired only to `test` would be silently skipped by CI. The root
  // runs `test:ci` for exactly that reason.
  expect((scripts as Record<string, unknown>)['test:ci']).toBe('playwright test');
});

test('the harness stays out of the extension package', () => {
  const devtools = readManifest('../../devtools/package.json');
  const runtime = Object.keys((devtools.dependencies ?? {}) as Record<string, unknown>);
  const dev = Object.keys((devtools.devDependencies ?? {}) as Record<string, unknown>);
  for (const forbidden of ['@copilotkit/aimock', '@playwright/test', '@ag-ui/client']) {
    expect(runtime).not.toContain(forbidden);
    expect(dev).not.toContain(forbidden);
  }
});
```

- [ ] **Step 4: Run the guard test**

Run, from `packages/harness`: `pnpm test:ci`

Expected output:

```
Running 4 tests using 1 worker

  ✓  1 test/package.spec.ts:20:1 › the harness is private and can never be published
  ✓  2 test/package.spec.ts:26:1 › every harness dependency is a devDependency
  ✓  3 test/package.spec.ts:40:1 › the root delegates to test:ci, which this package defines
  ✓  4 test/package.spec.ts:50:1 › the harness stays out of the extension package

  4 passed
```

Then, from the repo root, confirm CI now covers two packages: `pnpm test`

Expected: `ag-ui-devtools` runs its Vitest suite (675 passing) and `ag-ui-harness` runs the 4
Playwright tests above. Both exit 0.

- [ ] **Step 5: Commit**

---

### Task 2: The `SCENARIOS` corpus and the golden-fixture converter

Design §5: an aimock fixture is the server's *input*, a `.agui.jsonl` is capture's *output*. The
three goldens convert mechanically in that direction, so the same streams that already test `core/`
offline drive the capture layer online — one corpus, two levels. The conversion is done at load
time from the real files rather than transcribed into literals, so the two can never drift.

**Files:**
- Create: `packages/harness/fixtures/convert.ts`
- Create: `packages/harness/fixtures/index.ts`
- Test: `packages/harness/test/fixtures.spec.ts`

- [ ] **Step 1: Write the failing test**

`packages/harness/test/fixtures.spec.ts`

```ts
import { expect, test } from '@playwright/test';

import { convertGoldenFixture } from '../fixtures/convert.js';
import { SCENARIOS } from '../fixtures/index.js';

test.describe('golden fixture conversion', () => {
  test('happy-run keeps every event in seq order and its lone keepalive', () => {
    const converted = convertGoldenFixture('happy-run.agui.jsonl');

    expect(converted.events).toHaveLength(14);
    expect(converted.events[0]).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_happy',
      runId: 'r_happy',
    });
    expect(converted.events.at(-1)).toEqual({
      type: 'RUN_FINISHED',
      threadId: 't_happy',
      runId: 'r_happy',
    });
    // The first keepalive of a stream has nothing to be measured against, so it carries no delay.
    expect(converted.keepalives).toEqual([{ afterEvents: 10, comment: 'ping', delayBeforeMs: 0 }]);
  });

  test('malformed keeps the three defects and drops header and request lines', () => {
    const converted = convertGoldenFixture('malformed.agui.jsonl');

    expect(converted.events).toHaveLength(10);
    expect(converted.events.map((event) => event.type)).not.toContain('RUN_FINISHED');
    expect(converted.events).toContainEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: '',
    });
    expect(converted.events).toContainEqual({
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/missing/child', value: 42 }],
    });
    expect(converted.keepalives).toEqual([]);
  });

  test('chunked keeps the id-carrying chunk triads', () => {
    const converted = convertGoldenFixture('chunked-run.agui.jsonl');

    expect(converted.events).toHaveLength(7);
    expect(converted.events[2]).toEqual({ type: 'TEXT_MESSAGE_CHUNK', delta: ', world' });
  });
});

test.describe('SCENARIOS corpus', () => {
  test('covers every scenario the contract requires', () => {
    const names = Object.keys(SCENARIOS);
    for (const required of [
      'happy',
      'malformed',
      'chunked',
      'keepalive-gap',
      'slow-chunks',
      'binary',
    ]) {
      expect(names).toContain(required);
    }
  });

  test('every scenario is keyed by its own name and carries a description and events', () => {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      expect(scenario.name).toBe(key);
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(scenario.events.length).toBeGreaterThan(0);
      for (const event of scenario.events) expect(typeof event.type).toBe('string');
    }
  });

  test('the converted scenarios reuse the goldens rather than restating them', () => {
    expect(SCENARIOS.happy?.events).toEqual(convertGoldenFixture('happy-run.agui.jsonl').events);
    expect(SCENARIOS.malformed?.events).toEqual(
      convertGoldenFixture('malformed.agui.jsonl').events,
    );
    expect(SCENARIOS.chunked?.events).toEqual(
      convertGoldenFixture('chunked-run.agui.jsonl').events,
    );
  });

  test('keepalive-gap declares a gap the run builder will actually flag', () => {
    const keepalives = SCENARIOS['keepalive-gap']?.keepalives ?? [];
    expect(keepalives).toHaveLength(2);
    // Strictly greater than 15 000 ms, which is the run builder's threshold.
    expect(keepalives[1]?.delayBeforeMs).toBeGreaterThan(15_000);
    expect(SCENARIOS['keepalive-gap']?.expectIssues).toEqual(['keepalive-gap']);
  });

  test('binary declares the protobuf content type and slow-chunks a per-event delay', () => {
    expect(SCENARIOS.binary?.contentType).toBe('application/vnd.ag-ui.event+proto');
    expect(SCENARIOS['slow-chunks']?.delayMs).toBe(150);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run, from `packages/harness`: `pnpm exec playwright test test/fixtures.spec.ts`

Expected: FAIL with

```
Error: Cannot find module '/…/packages/harness/fixtures/convert.js' imported from /…/packages/harness/test/fixtures.spec.ts
Error: No tests found.
```

- [ ] **Step 3: Write the implementation**

`packages/harness/fixtures/convert.ts`

```ts
import { readFileSync } from 'node:fs';

import type { AguiEvent } from '@devtools/core/model/types';

/** A `:` comment frame the server emits between events. */
export interface ScenarioKeepalive {
  /** Emit once this many events have been written. `0` means before the first event. */
  afterEvents: number;
  /** Comment body, written as `: <comment>`. */
  comment: string;
  /** Milliseconds to sleep before writing it. Drives the >15 s `keepalive-gap` path. */
  delayBeforeMs: number;
}

export interface ConvertedFixture {
  events: AguiEvent[];
  keepalives: ScenarioKeepalive[];
}

const GOLDEN_DIR = new URL('../../devtools/src/test/fixtures/', import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert one golden `.agui.jsonl` into the server-side inputs that reproduce it.
 *
 * A `.agui.jsonl` is capture *output*; an aimock fixture is server *input*. The conversion is
 * mechanical in one direction only — drop `header` and `request` lines, keep `event` payloads in
 * seq order, and turn `keepalive` lines into comment frames — which is what makes one corpus test
 * `core/` offline and the capture layer online (design §5).
 *
 * The goldens are read at load time rather than transcribed into literals here. A copy would be
 * free to drift from the file that `core/`'s own 675 tests assert against, and a corpus that
 * silently disagrees with itself is worse than no corpus.
 *
 * A keepalive's `delayBeforeMs` is the wall-clock distance to the previous keepalive on the same
 * connection, because that is the only quantity `keepalive-gap` measures. The first keepalive of a
 * stream therefore has no delay: with nothing to measure against, the run builder cannot raise a
 * gap on it.
 */
export function convertGoldenFixture(fileName: string): ConvertedFixture {
  const text = readFileSync(new URL(fileName, GOLDEN_DIR), 'utf8');
  const events: AguiEvent[] = [];
  const keepalives: ScenarioKeepalive[] = [];
  let previousKeepaliveMs: number | undefined;

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) continue;

    if (parsed.kind === 'event') {
      const event = parsed.event;
      if (isRecord(event) && typeof event.type === 'string') {
        events.push(event as AguiEvent);
      }
      continue;
    }

    if (parsed.kind === 'keepalive') {
      const tMs = typeof parsed.tMs === 'number' ? parsed.tMs : 0;
      keepalives.push({
        afterEvents: events.length,
        comment: typeof parsed.comment === 'string' ? parsed.comment : '',
        delayBeforeMs: previousKeepaliveMs === undefined ? 0 : tMs - previousKeepaliveMs,
      });
      previousKeepaliveMs = tMs;
    }
  }

  return { events, keepalives };
}
```

`packages/harness/fixtures/index.ts`

```ts
import type { AguiEvent } from '@devtools/core/model/types';

import { convertGoldenFixture, type ScenarioKeepalive } from './convert.js';

export type { ScenarioKeepalive } from './convert.js';

export interface Scenario {
  name: string;
  description: string;
  events: AguiEvent[];
  delayMs?: number;
  /** Expected issue codes after capture, for the e2e assertion. */
  expectIssues: string[];
  /**
   * Comment frames interleaved with the events. Additive to the locked contract — see
   * `Contract gaps` (GAP-A1). `keepalive-gap` cannot be provoked without it: aimock's writer emits
   * only `data:` frames, so a `Scenario` of events alone can never put a `:` comment on the wire.
   */
  keepalives?: ScenarioKeepalive[];
  /**
   * Response `Content-Type`. Defaults to `text/event-stream`. Additive to the locked contract —
   * see `Contract gaps` (GAP-A2). Requirements §5.4 asks capture to detect and label a binary
   * transport, which is a property of the response headers and of no event in the stream.
   */
  contentType?: string;
}

const happyGolden = convertGoldenFixture('happy-run.agui.jsonl');
const malformedGolden = convertGoldenFixture('malformed.agui.jsonl');
const chunkedGolden = convertGoldenFixture('chunked-run.agui.jsonl');

/**
 * A gap longer than the run builder's 15 000 ms threshold, with margin for scheduler jitter.
 * It is real wall-clock sleep on the server: the capture layer stamps `tMs` from arrival time,
 * so the gap cannot be faked by lying in the payload.
 */
const KEEPALIVE_GAP_SLEEP_MS = 15_500;

/** Authored: a clean run whose only defect is a stalled heartbeat. */
const keepaliveGapEvents: AguiEvent[] = [
  { type: 'RUN_STARTED', threadId: 't_gap', runId: 'r_gap' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Thinking about it' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm_1' },
  { type: 'RUN_FINISHED', threadId: 't_gap', runId: 'r_gap' },
];

/** Authored: chunk-only stream, the CopilotKit default shape, paced slowly on purpose. */
const slowChunkEvents: AguiEvent[] = [
  { type: 'RUN_STARTED', threadId: 't_slow', runId: 'r_slow' },
  { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm_1', role: 'assistant', delta: 'Streaming' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' one' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' word' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' at' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' a' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' time.' },
  { type: 'RUN_FINISHED', threadId: 't_slow', runId: 'r_slow' },
];

/** Authored: the §5.4 binary transport. Same events, framed as opaque bytes. */
const binaryEvents: AguiEvent[] = [
  { type: 'RUN_STARTED', threadId: 't_bin', runId: 'r_bin' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Encoded as protobuf.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm_1' },
  { type: 'RUN_FINISHED', threadId: 't_bin', runId: 'r_bin' },
];

export const AGUI_PROTO_CONTENT_TYPE = 'application/vnd.ag-ui.event+proto';

export const SCENARIOS: Record<string, Scenario> = {
  happy: {
    name: 'happy',
    description:
      'Converted from happy-run.agui.jsonl: text, a tool call with a result, a state snapshot ' +
      'and a delta, one keepalive, RUN_FINISHED. Nothing wrong with it.',
    events: happyGolden.events,
    keepalives: happyGolden.keepalives,
    expectIssues: [],
  },
  malformed: {
    name: 'malformed',
    description:
      'Converted from malformed.agui.jsonl: an empty TEXT_MESSAGE_CONTENT delta, a STATE_DELTA ' +
      'whose path has no parent, and no terminal event.',
    events: malformedGolden.events,
    keepalives: malformedGolden.keepalives,
    expectIssues: ['empty-text-delta', 'state-patch-failed', 'run-never-terminated'],
  },
  chunked: {
    name: 'chunked',
    description:
      'Converted from chunked-run.agui.jsonl: TEXT_MESSAGE_CHUNK and TOOL_CALL_CHUNK triads with ' +
      'the id carried forward, which the chunk expander must reconstruct.',
    events: chunkedGolden.events,
    keepalives: chunkedGolden.keepalives,
    expectIssues: [],
  },
  'keepalive-gap': {
    name: 'keepalive-gap',
    description:
      'Authored: two comment frames 15.5 s apart around an otherwise clean run. The only ' +
      'scenario that reaches the keepalive-gap code path.',
    events: keepaliveGapEvents,
    keepalives: [
      { afterEvents: 4, comment: 'ping', delayBeforeMs: 0 },
      { afterEvents: 4, comment: 'ping', delayBeforeMs: KEEPALIVE_GAP_SLEEP_MS },
    ],
    expectIssues: ['keepalive-gap'],
  },
  'slow-chunks': {
    name: 'slow-chunks',
    description:
      'Authored: a chunk-only run written one event every 150 ms, so the tee() consumer is ' +
      'exercised across many small reads rather than one buffered flush (requirements §15).',
    events: slowChunkEvents,
    delayMs: 150,
    expectIssues: [],
  },
  binary: {
    name: 'binary',
    description:
      'Authored: a clean run served as length-prefixed opaque frames under the protobuf content ' +
      'type. Requirements §5.4 asks capture to label it, not to decode it, so it yields no ' +
      'records and therefore no issues.',
    events: binaryEvents,
    contentType: AGUI_PROTO_CONTENT_TYPE,
    expectIssues: [],
  },
};
```

Both keepalives in `keepalive-gap` sit at `afterEvents: 4`, so they bracket the 15.5 s sleep while
the run is still open — the gap therefore attaches to `r_gap` rather than to an orphaned run, and
`RUN_FINISHED` follows. Observed anchor: seq 6, the keepalive that closed the gap.

- [ ] **Step 4: Run test to verify it passes**

Run, from `packages/harness`: `pnpm exec playwright test test/fixtures.spec.ts`

Expected: `8 passed` — 3 conversion tests plus 5 corpus tests. (`pnpm test:ci` at this point runs
12: these 8 plus Task 1's 4 package guards.)

Also run `pnpm typecheck` and `pnpm lint`; both exit 0.

- [ ] **Step 5: Commit**

---

### Task 3: `server/agui-server.ts`

Wraps `AGUIMock` per the contract. Verified fact 1 is reused rather than re-derived: `onRun`,
`reset`, and `handleRequest` are exactly the surface the spike proved.

Two things aimock cannot do, both established by reading `writeAGUIEventStream` in
`@copilotkit/aimock@1.38.0`: it emits `data:` frames and nothing else, under a hardcoded
`text/event-stream`. So a scenario declaring `keepalives` or a `contentType` is written by the
harness itself, and everything else is delegated to aimock untouched — including its `timestamp`
stamp (verified fact 2), which is precisely where its fidelity matters. The harness writer mirrors
that stamp so the two paths are byte-comparable; that was confirmed on the wire.

**Files:**
- Create: `packages/harness/server/agui-server.ts`
- Create: `packages/harness/test/replay.ts`
- Test: `packages/harness/test/agui-server.spec.ts`
- Test: `packages/harness/test/scenarios.spec.ts`

- [ ] **Step 1: Write the failing test**

`packages/harness/test/agui-server.spec.ts`

```ts
import { expect, test } from '@playwright/test';

import { AGUI_PROTO_CONTENT_TYPE } from '../fixtures/index.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

const RUN_INPUT = {
  threadId: 't_harness',
  runId: 'r_harness',
  state: {},
  messages: [{ id: 'm_user_1', role: 'user', content: 'run the scenario' }],
  tools: [],
  context: [],
  forwardedProps: {},
};

async function postRun(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(RUN_INPUT),
  });
}

let server: HarnessServer;

test.beforeEach(async () => {
  server = await startHarnessServer();
});

test.afterEach(async () => {
  await server.stop();
});

test('serves the default scenario as SSE over a real socket', async () => {
  const response = await postRun(server.url);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const text = await response.text();
  const frames = text.split('\n\n').filter((frame) => frame !== '');
  expect(frames.length).toBeGreaterThan(0);
  expect(text).toContain('"type":"RUN_STARTED"');
  expect(text).toContain('"type":"RUN_FINISHED"');
});

test('use() switches the scenario served on the next run', async () => {
  server.use('malformed');
  const malformed = await (await postRun(server.url)).text();
  expect(malformed).toContain('"threadId":"t_bad"');
  expect(malformed).not.toContain('RUN_FINISHED');

  server.use('happy');
  const happy = await (await postRun(server.url)).text();
  expect(happy).toContain('"threadId":"t_happy"');
  expect(happy).toContain('RUN_FINISHED');
});

test('emits SSE comment frames for a scenario that declares keepalives', async () => {
  server.use('happy');
  const text = await (await postRun(server.url)).text();
  expect(text).toContain(': ping\n\n');
});

test('serves the binary scenario under the protobuf content type', async () => {
  server.use('binary');
  const response = await postRun(server.url);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(AGUI_PROTO_CONTENT_TYPE);

  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);
  // Length-prefixed framing, not SSE: the body must not be parseable as `data:` frames.
  expect(new TextDecoder().decode(bytes)).not.toContain('data:');
});

test('use() rejects an unknown scenario by name', () => {
  expect(() => server.use('does-not-exist')).toThrow(/Unknown scenario 'does-not-exist'/);
});

test('binds an ephemeral loopback port and stops cleanly', async () => {
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await server.stop();
  await expect(postRun(server.url)).rejects.toThrow();
  server = await startHarnessServer();
});
```

`packages/harness/test/scenarios.spec.ts`

```ts
import { expect, test } from '@playwright/test';

import { SCENARIOS } from '../fixtures/index.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';
import { replayScenario } from './replay.js';

test.describe('SCENARIOS replayed through the real core/ pipeline', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(`${name} produces exactly its expectIssues`, async () => {
      // `keepalive-gap` sleeps 15.5 s on the wire on purpose: the run builder measures arrival
      // times, so the gap cannot be faked in the payload. The budget is per test rather than a
      // special case, because the corpus grows.
      test.setTimeout(60_000);
      const server: HarnessServer = await startHarnessServer();
      try {
        server.use(name);
        const result = await replayScenario(server.url);
        const codes = result.issues.map((issue) => issue.code).sort();
        expect(codes).toEqual([...scenario.expectIssues].sort());
      } finally {
        await server.stop();
      }
    });
  }

  test('happy replays its keepalive as a keepalive record, not as an event', async () => {
    const server = await startHarnessServer();
    try {
      server.use('happy');
      const result = await replayScenario(server.url);
      expect(result.records.filter((record) => record.kind === 'event')).toHaveLength(14);
      expect(result.records.filter((record) => record.kind === 'keepalive')).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test('binary yields bytes but no records', async () => {
    const server = await startHarnessServer();
    try {
      server.use('binary');
      const result = await replayScenario(server.url);
      expect(result.contentType).toBe('application/vnd.ag-ui.event+proto');
      expect(result.records).toEqual([]);
      expect(result.binaryBytes).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test('a run captured without its request body gains run-started-without-input', async () => {
    // Verified fact 4, kept honest here rather than trusted: `expectIssues` is derived WITH the
    // POST body, so if `inject/` ever stops capturing it, this is the issue every scenario grows.
    const server = await startHarnessServer();
    try {
      server.use('happy');
      const result = await replayScenario(server.url, { withRequest: false });
      expect(result.issues.map((issue) => issue.code)).toEqual(['run-started-without-input']);
    } finally {
      await server.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run, from `packages/harness`: `pnpm exec playwright test test/agui-server.spec.ts test/scenarios.spec.ts`

Expected: FAIL with

```
Error: Cannot find module '/…/packages/harness/server/agui-server.js' imported from /…/packages/harness/test/agui-server.spec.ts
Error: No tests found.
```

- [ ] **Step 3: Write the implementation**

`packages/harness/server/agui-server.ts`

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AGUIMock } from '@copilotkit/aimock';
import type { AGUIEvent } from '@copilotkit/aimock';

import type { AguiEvent } from '@devtools/core/model/types';

import { SCENARIOS, type Scenario } from '../fixtures/index.js';

export interface HarnessServer {
  readonly url: string;
  /** Serve a named scenario on the next run. */
  use(scenario: string): void;
  stop(): Promise<void>;
}

const SSE_CONTENT_TYPE = 'text/event-stream';
const DEFAULT_SCENARIO = 'happy';

/**
 * aimock types its event array as a closed discriminated union; `AguiEvent` is deliberately open,
 * because requirements §7 says an unknown event type is a warning to display, never an error to
 * reject. The corpus is the source of truth for what goes on the wire — a scenario exists
 * precisely to serve payloads the union does not admit — so the two are reconciled here, at the
 * one boundary, rather than by weakening either type.
 */
function asMockEvents(events: readonly AguiEvent[]): AGUIEvent[] {
  return events as unknown as AGUIEvent[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scenarios aimock cannot serve itself.
 *
 * `writeAGUIEventStream` emits `data:` frames and nothing else, under a hardcoded
 * `text/event-stream`. A scenario needing a comment frame or a binary content type is written by
 * `writeCustomStream` below; everything else goes through aimock unmodified, which is where its
 * fidelity — including the `timestamp` stamp of verified fact 2 — actually matters.
 */
function needsCustomTransport(scenario: Scenario): boolean {
  const contentType = scenario.contentType ?? SSE_CONTENT_TYPE;
  return contentType !== SSE_CONTENT_TYPE || (scenario.keepalives?.length ?? 0) > 0;
}

/** Mirrors aimock's stamp so a custom-transport scenario is byte-comparable with a delegated one. */
function stamp(event: AguiEvent): AguiEvent {
  return { ...event, timestamp: event.timestamp ?? Date.now() };
}

function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => {});
    req.on('end', () => resolve());
    req.on('error', reject);
  });
}

/**
 * Frame the events as length-prefixed opaque blobs: a 4-byte big-endian length followed by that
 * many bytes of payload. This is a stand-in for protobuf wire framing, which is deliberate —
 * requirements §5.4 defers *decoding* to phase 3 and asks only that capture detect the content
 * type and label the connection, so what the bytes mean is not under test. What is under test is
 * that capture does not try to parse them as SSE.
 */
function encodeBinaryBody(events: readonly AguiEvent[]): Buffer {
  const chunks: Buffer[] = [];
  for (const event of events) {
    const payload = Buffer.from(JSON.stringify(stamp(event)), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    chunks.push(header, payload);
  }
  return Buffer.concat(chunks);
}

async function writeCustomStream(res: ServerResponse, scenario: Scenario): Promise<void> {
  const contentType = scenario.contentType ?? SSE_CONTENT_TYPE;

  if (contentType !== SSE_CONTENT_TYPE) {
    const body = encodeBinaryBody(scenario.events);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Content-Length': String(body.byteLength),
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    'Content-Type': SSE_CONTENT_TYPE,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const keepalives = scenario.keepalives ?? [];
  const delayMs = scenario.delayMs ?? 0;

  // `afterEvents: 0` fires before the first event, so the pending list is drained on every
  // boundary from 0 to events.length inclusive — hence `<=` rather than `<`.
  for (let written = 0; written <= scenario.events.length; written += 1) {
    for (const keepalive of keepalives) {
      if (keepalive.afterEvents !== written) continue;
      if (keepalive.delayBeforeMs > 0) await sleep(keepalive.delayBeforeMs);
      if (res.socket?.destroyed === true) return;
      res.write(`: ${keepalive.comment}\n\n`);
    }
    const event = scenario.events[written];
    if (event === undefined) break;
    if (res.socket?.destroyed === true) return;
    res.write(`data: ${JSON.stringify(stamp(event))}\n\n`);
    if (delayMs > 0) await sleep(delayMs);
  }

  if (!res.writableEnded) res.end();
}

export async function startHarnessServer(opts: { port?: number } = {}): Promise<HarnessServer> {
  // Never `.start()`ed: AGUIMock is mounted as a request handler so a scenario needing a comment
  // frame or a binary content type can be answered on the same origin and the same port. One
  // origin is not cosmetic — decision D3 keys the capture opt-in on it.
  const mock = new AGUIMock();
  let current = requireScenario(DEFAULT_SCENARIO);
  register(current);

  function register(scenario: Scenario): void {
    mock.reset();
    mock.onRun(/.*/, asMockEvents(scenario.events), scenario.delayMs);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      if (!res.writableEnded) res.end('harness error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'POST' && (pathname === '/' || pathname === '')) {
      if (needsCustomTransport(current)) {
        await drainBody(req);
        await writeCustomStream(res, current);
        return;
      }
      await mock.handleRequest(req, res, pathname);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  const url = await new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('harness server did not bind a TCP port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    url,
    use(scenario: string): void {
      current = requireScenario(scenario);
      register(current);
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // `Connection: keep-alive` means a client that finished reading still holds the socket
        // open, and `close` alone would wait for it. Idle sockets are dropped explicitly so
        // `stop()` resolves promptly in a test teardown.
        server.closeAllConnections();
      });
    },
  };
}

function requireScenario(name: string): Scenario {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    throw new Error(
      `Unknown scenario '${name}'. Known: ${Object.keys(SCENARIOS).sort().join(', ')}`,
    );
  }
  return scenario;
}
```

`packages/harness/test/replay.ts`

```ts
import { createRunBuilder } from '@devtools/core/normalizer/run-builder';
import { createSseParser, type SseFrame } from '@devtools/core/sse/parser';
import type { AguiEvent, CaptureRecord, Issue } from '@devtools/core/model/types';

const CONN_ID = 'c1';

export interface ReplayResult {
  records: CaptureRecord[];
  issues: Issue[];
  contentType: string | null;
  binaryBytes: number;
}

/**
 * Drive one run against the harness server and fold it with the real `core/` pipeline.
 *
 * This is the offline half of the corpus: the same bytes the capture layer will see, parsed by the
 * same parser and folded by the same run builder, with no extension in the way. Its purpose is to
 * make `Scenario.expectIssues` an observation instead of a guess — if this and the Playwright e2e
 * disagree, the capture layer is what is wrong.
 *
 * The request body is fed in by default. Verified fact 4: with no captured `RunAgentInput` every
 * run additionally reports `run-started-without-input`, so omitting it would bake a spurious info
 * issue into every scenario in the corpus. `withRequest: false` exists only to demonstrate that,
 * so the fact stays observed rather than remembered.
 */
export async function replayScenario(
  url: string,
  opts: { withRequest?: boolean } = {},
): Promise<ReplayResult> {
  const withRequest = opts.withRequest ?? true;
  const input = {
    threadId: 't_harness',
    runId: 'r_harness',
    state: {},
    messages: [{ id: 'm_user_1', role: 'user', content: 'run the scenario' }],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
  });

  const contentType = response.headers.get('content-type');
  const builder = createRunBuilder();
  if (withRequest) builder.addRequest(CONN_ID, 'POST', url, input);

  const body = response.body;
  if (body === null) throw new Error('harness response had no body');

  // requirements §5.4: a non-SSE transport is detected and labelled, never parsed. Reading it as
  // text would manufacture records that the capture layer will correctly refuse to produce.
  if (contentType === null || !contentType.startsWith('text/event-stream')) {
    const bytes = (await response.arrayBuffer()).byteLength;
    builder.closeConnection(CONN_ID, 0);
    return { records: [], issues: builder.allIssues(), contentType, binaryBytes: bytes };
  }

  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const records: CaptureRecord[] = [];
  const startedAt = Date.now();
  let seq = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      records.push(toRecord(frame, ++seq, Date.now() - startedAt));
    }
  }
  for (const frame of parser.flush()) {
    records.push(toRecord(frame, ++seq, Date.now() - startedAt));
  }

  for (const record of records) builder.addRecord(record);
  builder.closeConnection(CONN_ID, Date.now() - startedAt);

  return { records, issues: builder.allIssues(), contentType, binaryBytes: 0 };
}

function toRecord(frame: SseFrame, seq: number, tMs: number): CaptureRecord {
  if (frame.kind === 'keepalive') {
    return {
      kind: 'keepalive',
      seq,
      tMs,
      connId: CONN_ID,
      raw: frame.comment,
      comment: frame.comment,
      issues: [],
    };
  }
  let event: AguiEvent | null = null;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    const hasType =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === 'string';
    event = hasType ? (parsed as AguiEvent) : null;
  } catch {
    event = null;
  }
  return { kind: 'event', seq, tMs, connId: CONN_ID, raw: frame.data, event, issues: [] };
}
```

`replay.ts` sits in `test/` but is not itself a spec — Playwright's default `testMatch` only picks
up `*.spec.ts` / `*.test.ts`, so it is imported, never collected.

- [ ] **Step 4: Run test to verify it passes**

Run, from `packages/harness`: `pnpm test:ci`

Expected output — 27 passed, with `keepalive-gap` taking ~15.5 s and `slow-chunks` ~1.2 s:

```
Running 27 tests using 1 worker
  …
  ✓  19 test/scenarios.spec.ts:9:5 › … › happy produces exactly its expectIssues (5ms)
  ✓  20 test/scenarios.spec.ts:9:5 › … › malformed produces exactly its expectIssues (4ms)
  ✓  21 test/scenarios.spec.ts:9:5 › … › chunked produces exactly its expectIssues (4ms)
  ✓  22 test/scenarios.spec.ts:9:5 › … › keepalive-gap produces exactly its expectIssues (15.5s)
  ✓  23 test/scenarios.spec.ts:9:5 › … › slow-chunks produces exactly its expectIssues (1.2s)
  ✓  24 test/scenarios.spec.ts:9:5 › … › binary produces exactly its expectIssues (3ms)
  …
  27 passed (17.7s)
```

Also run `pnpm typecheck` and `pnpm lint`; both exit 0.

- [ ] **Step 5: Commit**

---

## Verification log

Built and run in `scratchpad/verify-cap-A/` against real `@copilotkit/aimock@1.38.0` and the
unmodified `packages/devtools/src/core/**`. `npx tsc --noEmit` and `npx eslint .` both clean;
`npx playwright test` → **27 passed (17.7s)**.

Actual output of the derivation script (server started, POSTed, response folded by
`createSseParser` + `createRunBuilder`):

```
### happy  (77 ms)
  content-type : text/event-stream
  records      : 15 (events 14, keepalives 1)
  OBSERVED     : []
  expectIssues : []
  MATCH        : true

### malformed  (13 ms)
  content-type : text/event-stream
  records      : 10 (events 10, keepalives 0)
  OBSERVED     : [empty-text-delta, run-never-terminated, state-patch-failed]
  expectIssues : [empty-text-delta, run-never-terminated, state-patch-failed]
  MATCH        : true
    - empty-text-delta (error) @seq 5: TEXT_MESSAGE_CONTENT has an empty delta
    - state-patch-failed (error) @seq 9: STATE_DELTA op 0 (add /missing/child) failed: parent-not-found
    - run-never-terminated (error) @seq 10: Connection closed without RUN_FINISHED or RUN_ERROR

### chunked  (3 ms)
  content-type : text/event-stream
  records      : 7 (events 7, keepalives 0)
  OBSERVED     : []
  expectIssues : []
  MATCH        : true

### keepalive-gap  (15509 ms)
  content-type : text/event-stream
  records      : 7 (events 5, keepalives 2)
  OBSERVED     : [keepalive-gap]
  expectIssues : [keepalive-gap]
  MATCH        : true
    - keepalive-gap (info) @seq 6: Keepalive gap of 15501ms on connection c1 exceeds 15000ms

### slow-chunks  (1219 ms)
  content-type : text/event-stream
  records      : 8 (events 8, keepalives 0)
  OBSERVED     : []
  expectIssues : []
  MATCH        : true

### binary  (2 ms)
  content-type : application/vnd.ag-ui.event+proto
  records      : 0 (events 0, keepalives 0)
  binaryBytes  : 456
  OBSERVED     : []
  expectIssues : []
  MATCH        : true

### happy WITHOUT addRequest (verified fact 4)
  OBSERVED : [run-started-without-input]
```

Both transports stamp identically, confirmed on the wire:

```
--- happy (harness writer) ---
data: {"type":"RUN_STARTED","threadId":"t_happy","runId":"r_happy","timestamp":1786755058051}
--- malformed (aimock delegate) ---
data: {"type":"RUN_STARTED","threadId":"t_bad","runId":"r_bad","timestamp":1786755058057}
```

**Caveat for sections B and C.** `expectIssues` is derived from the *offline* replay above. The
e2e must assert the same list against the service-worker ring buffer; if the two disagree, the
capture layer is what is wrong, not this table. In particular `run-started-without-input` is absent
from every scenario precisely because `inject/` is required to capture the POST body.

---

## Contract gaps

- **GAP-A1 — `Scenario` cannot express a keepalive.** The contract requires a `keepalive-gap`
  scenario, but `Scenario` carries only `events`, and aimock's `writeAGUIEventStream` emits `data:`
  frames exclusively. A corpus of events alone can never put a `:` comment on the wire, so the
  required scenario is unreachable as specified. Filled with an additive optional
  `keepalives?: ScenarioKeepalive[]`; the contract's stated fields are unchanged.
- **GAP-A2 — `Scenario` cannot express a transport.** Same shape of problem for the required
  `binary` scenario: content type is a response header, not an event. Filled with an additive
  optional `contentType?: string`, defaulting to `text/event-stream`.
- **GAP-A3 — `HarnessServer` has no hook for serving `packages/harness/page`.** The contract's
  server exposes only `url`, `use`, `stop`, and answers `POST /`; the design says the page is
  "served over `localhost`, which D3 auto-enables". If the page is served from a second port it is
  a second origin, and the D3 per-origin opt-in the harness is meant to exercise applies to the
  page's origin rather than the endpoint's. Section B should either add static serving to this
  same server (a `GET` branch in `handle`) or state explicitly that the two origins are intended.
  Nothing in Task 3 forecloses either.
- **GAP-A4 — no stated import path from `packages/harness` to `core/`.** The contract's
  `fixtures/index.ts` uses `AguiEvent` and its `e2e/fixtures.ts` returns `CaptureRecord[]` and
  `RequestLine[]`, all of which live in `packages/devtools/src`, which is private and exports no
  subpaths. Resolved here with a `@devtools/*` tsconfig path alias; sections B and C should use the
  same alias rather than inventing a second one.
- **GAP-A5 — Playwright browsers are not provisioned.** `test:ci` is `playwright test`. Tasks 1–3
  launch no browser, but section C's extension project will, and CI will need
  `pnpm --filter ag-ui-harness exec playwright install chromium` (verified fact 7 requires
  Playwright's own bundled Chromium, not the user's Chrome).
- **Note, not a gap — `AGUIMock` is used un-started.** `new AGUIMock()` is mounted as a request
  handler via its `Mountable` interface rather than given its own port, so one origin serves both
  the aimock-delegated and harness-written scenarios. Consequently `mock.stop()` is never called —
  it throws when the mock was never started — and `HarnessServer.stop()` closes the Node server
  instead. Verified working.

---

# Capture plan — section B: Tasks 4–5

Covers `packages/harness/page/` (the real-client driver page) and `packages/harness/e2e/`
(the Playwright helpers plus the first end-to-end spec).

## What was verified before this was written

Everything below was executed against the repo's real `packages/devtools/dist`, in
`scratchpad/verify-cap-B/`. These are observations, not predictions.

| Fact | Observed |
|---|---|
| Playwright's bundled Chromium | `151.0.7922.34`, launched with `channel: 'chromium'`, `headless: true` |
| Extension loads | `launchPersistentContext(userDataDir, { args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>'] })` |
| Extension id | `bipnmenibpkpfkpccgkepkniikmpadoi` — stable across runs, derived from the `dist/` path |
| Service worker url | `chrome-extension://bipnmenibpkpfkpccgkepkniikmpadoi/service-worker-loader.js` |
| `channel: 'chromium'` is load-bearing | Dropping it and keeping `headless: true` resolves to `chromium-headless-shell`. Measured: the context launched fine, `ctx.serviceWorkers()` stayed empty, and `waitForEvent('serviceworker')` **timed out** — the extension never loaded, with no error. |
| SW reachability | `ctx.serviceWorkers()` was **empty** immediately after launch; `ctx.waitForEvent('serviceworker')` resolved. Both paths are needed. |
| `sw.evaluate(...)` | works — read `chrome.runtime.getManifest()` and `chrome.runtime.id` from inside it |
| `globalThis.__AGUI_DT_TEST__` | **`undefined` today.** Expected: `src/sw/index.ts` is still the phase-1 stub and installs no hook. `readCapture` must tolerate this, and that tolerance is exactly what makes the first green e2e possible. |
| `inject/` marker | `window.__AGUI_DEVTOOLS__ === { version: '0.1.0' }` on a `http://localhost:<port>/` page — the static content-script registration works, it just captures nothing |
| Real `HttpAgent` request shape | `@ag-ui/client@0.0.57` `requestInit()` is literally `{ method: 'POST', headers: { …, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(input), signal }`. Playwright recorded `POST http://localhost:<port>/agui accept=text/event-stream`. Verified fact 5 reproduced end to end. |
| aimock CORS | **`AGUIMock` sends no `Access-Control-Allow-*` headers and 404s the `OPTIONS` preflight.** A cross-origin `POST` with `Content-Type: application/json` from the page would never leave the browser. The page origin must therefore be the same origin as the agent endpoint — hence `page/serve.ts` proxying `/agui`. |
| Workspace type import | `pnpm install` links a private workspace package (`packages/harness/node_modules/ag-ui-devtools -> ../../devtools`), and `import type { CaptureRecord } from 'ag-ui-devtools/src/core/model/types'` resolves under `moduleResolution: bundler`. `packages/devtools/package.json` has no `exports` map, which is what permits the subpath. |
| Full loop | 14 tests green: 3 files (`page/render.test.ts`, `page/serve.test.ts`, `e2e/capture.spec.ts`), typechecked under the repo's own `tsconfig.base.json` (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `strict`), zero `any` |

## Preconditions for Task 5

Stated explicitly because both are silent failures otherwise:

1. **`packages/devtools/dist/` must be built** before the e2e runs — `pnpm --filter ag-ui-devtools build`.
   `launchWithExtension()` throws a named error if `dist/manifest.json` is absent rather than
   launching a Chromium with no extension in it and failing later on a confusing assertion.
2. **`packages/harness/page/dist/` must be built** — `pnpm --filter ag-ui-harness build:page`.
   `startPageServer()` throws the same way.

`packages/devtools/src/sw/protocol.ts` is **not** a precondition. Tasks 4–5 run while the SW is
still the phase-1 stub; `RequestLine` is declared locally in `e2e/fixtures.ts` (see Contract gaps).

---

### Task 4: The harness page — real `@ag-ui/client`, plain-text rendering

Why the real client and not a hand-rolled `fetch` (design H3): a hand-rolled request tests our
*idea* of a client. `HttpAgent` produces the request shape measured on a production deployment —
`fetch` POST with `Accept: text/event-stream`. That shape is exactly what `inject/` must
intercept, so getting it from the real library is the whole point.

Rendering matters because it enables the panel-vs-app comparison the Messages tab exists for: if
the panel and the page disagree about the same stream, one of them is wrong. Rendering lives in
`page/render.ts` as pure functions so it is unit-testable in Node; `page/main.ts` is DOM wiring
only and is proved by the Task 5 e2e.

**Files:**
- Create: `packages/harness/page/index.html`
- Create: `packages/harness/page/render.ts`
- Create: `packages/harness/page/main.ts`
- Create: `packages/harness/page/serve.ts`
- Create: `packages/harness/page/build.ts`
- Edit: `packages/harness/package.json`
- Test: `packages/harness/page/render.test.ts`
- Test: `packages/harness/page/serve.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/harness/page/render.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { lineFor, textOf } from './render.js';

describe('textOf', () => {
  it('passes a plain string through', () => {
    expect(textOf('hello')).toBe('hello');
  });

  it('joins text parts and labels non-text parts', () => {
    expect(
      textOf([
        { type: 'text', text: 'look: ' },
        { type: 'image', source: { type: 'url', value: 'http://x/y.png' } },
      ]),
    ).toBe('look: [image]');
  });

  it('renders absent content as the empty string', () => {
    expect(textOf(undefined)).toBe('');
  });
});

describe('lineFor', () => {
  it('renders a user message as its text', () => {
    const message: Message = { id: 'u1', role: 'user', content: 'hi' };
    expect(lineFor(message)).toBe('hi');
  });

  it('renders an assistant tool call so a run with no text is still visible', () => {
    const message: Message = {
      id: 'a1',
      role: 'assistant',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"SF"}' },
        },
      ],
    };
    expect(lineFor(message)).toBe('get_weather({"city":"SF"})');
  });

  it('renders text and tool calls together', () => {
    const message: Message = {
      id: 'a2',
      role: 'assistant',
      content: 'checking',
      toolCalls: [{ id: 'tc2', type: 'function', function: { name: 'f', arguments: '{}' } }],
    };
    expect(lineFor(message)).toBe('checking f({})');
  });
});
```

`packages/harness/page/serve.test.ts`

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AGUIMock } from '@copilotkit/aimock';
import { startPageServer, type PageServer } from './serve.js';

let mock: AGUIMock;
let server: PageServer;

beforeAll(async () => {
  mock = new AGUIMock({ port: 0 });
  mock.onRun(/.*/, [
    { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
    { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
  ]);
  server = await startPageServer({ agentUrl: await mock.start() });
});

afterAll(async () => {
  await server.stop();
  await mock.stop();
});

it('serves the built page on a localhost origin', async () => {
  // D3 auto-enables the localhost family, and the manifest's static content-script
  // registration matches `http://localhost/*`. A 127.0.0.1 origin would work too, but the
  // hostname the browser sees is what decides, so it is asserted rather than assumed.
  expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  const res = await fetch(server.url);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.text()).toContain('id="messages"');
});

it('proxies /agui to the harness server as a real SSE response', async () => {
  // AGUIMock sends no CORS headers and 404s the preflight (measured). The page can only
  // reach it same-origin, so this proxy is load-bearing, not convenience.
  const res = await fetch(new URL('/agui', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId: 't',
      runId: 'r',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const body = await res.text();
  expect(body).toContain('data: {"type":"RUN_STARTED"');
  expect(body).toContain('data: {"type":"RUN_FINISHED"');
});

it('404s a path outside the built page', async () => {
  const res = await fetch(new URL('/../serve.ts', server.url));
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ag-ui-harness test`

Expected: FAIL with `Error: Cannot find module './render.js' imported from .../page/render.test.ts`
and the same for `'./serve.js'`. Both suites fail to collect; zero tests run.

- [ ] **Step 3: Write the implementation**

`packages/harness/page/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AG-UI harness</title>
  </head>
  <body>
    <h1>AG-UI capture harness</h1>
    <form id="run-form">
      <input id="prompt" name="prompt" value="hello" size="40" />
      <button id="run" type="submit">Run</button>
    </form>
    <p>status: <output id="status">idle</output></p>
    <p id="error" hidden></p>
    <ul id="messages"></ul>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

`packages/harness/page/render.ts`

```ts
import type { Message } from '@ag-ui/core';

/**
 * `Message['content']` is `string | InputContentPart[] | Record<string, unknown> | undefined`.
 * Anything that is not text is labelled rather than dropped: a run whose only output was an
 * image must not render as an empty line, because "nothing rendered" and "nothing arrived"
 * are the two states this page exists to tell apart.
 */
export function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    parts.push(part.type === 'text' ? part.text : `[${part.type}]`);
  }
  return parts.join('');
}

/** One plain-text line per reconstructed message, comparable by eye with the Messages tab. */
export function lineFor(message: Message): string {
  const body = textOf(message.content);
  if (message.role !== 'assistant') return body;
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) return body;
  const rendered = calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(' ');
  return body.length > 0 ? `${body} ${rendered}` : rendered;
}
```

`packages/harness/page/main.ts`

```ts
/**
 * The harness client. Drives runs with the REAL `@ag-ui/client` `HttpAgent` (design H3).
 *
 * A hand-rolled `fetch` here would test our idea of a client. `HttpAgent.requestInit()` is
 * `{ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
 * body: JSON.stringify(input) }` — the shape measured on a production AG-UI deployment, and
 * the exact shape `inject/` has to intercept. Getting it from the library is the point.
 *
 * The agent endpoint is same-origin on purpose: `AGUIMock` sends no CORS headers and 404s the
 * preflight, so a cross-origin POST would never leave the browser. `page/serve.ts` proxies it.
 */
import { HttpAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import { lineFor } from './render.js';

const AGENT_PATH = '/agui';

function required<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof ctor)) {
    throw new Error(`#${id} is missing or is not a ${ctor.name}`);
  }
  return node;
}

const form = required('run-form', HTMLFormElement);
const prompt = required('prompt', HTMLInputElement);
const status = required('status', HTMLOutputElement);
const errorLine = required('error', HTMLParagraphElement);
const list = required('messages', HTMLUListElement);

const agent = new HttpAgent({ url: new URL(AGENT_PATH, window.location.origin).toString() });

function render(messages: readonly Message[]): void {
  list.replaceChildren(
    ...messages.map((message) => {
      const item = document.createElement('li');
      item.dataset.role = message.role;
      item.dataset.id = message.id;
      item.textContent = lineFor(message);
      return item;
    }),
  );
}

agent.subscribe({
  onMessagesChanged: ({ messages }) => {
    render(messages);
  },
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  errorLine.hidden = true;
  errorLine.textContent = '';
  status.textContent = 'running';
  agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: prompt.value });
  agent
    .runAgent()
    .then(() => {
      status.textContent = 'done';
    })
    .catch((cause: unknown) => {
      // A failed run must be visibly different from a run that produced nothing. `#status`
      // is what the e2e waits on, so it must reach a terminal value on every path.
      errorLine.hidden = false;
      errorLine.textContent = cause instanceof Error ? cause.message : String(cause);
      status.textContent = 'error';
    });
});

status.textContent = 'ready';
```

`packages/harness/page/serve.ts`

```ts
/**
 * Serves the built page over `http://localhost:<port>/` and proxies `POST /agui` to the
 * harness server.
 *
 * The proxy is not convenience. `AGUIMock` sends no `Access-Control-Allow-*` headers and
 * 404s the `OPTIONS` preflight (measured), so a cross-origin POST carrying
 * `Content-Type: application/json` never leaves the browser. Same-origin is also what a real
 * app does — agent endpoints are normally proxied through the app's own origin.
 *
 * `localhost` rather than `127.0.0.1` because the manifest's static content scripts match
 * `http://localhost/*` and D3 auto-enables the localhost family.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PageServer {
  readonly url: string;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const pageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(pageRoot, 'dist');

function proxy(req: IncomingMessage, res: ServerResponse, agentUrl: string): void {
  const target = new URL(agentUrl);
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method ?? 'POST',
      headers,
    },
    (upstreamRes) => {
      // Headers first, then a raw pipe: the SSE frames must reach the browser with the same
      // chunk boundaries the server wrote, because chunk cadence is one of the things the
      // capture layer is being tested on.
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

export function startPageServer(opts: { agentUrl: string; port?: number }): Promise<PageServer> {
  if (!existsSync(join(distRoot, 'index.html'))) {
    throw new Error(
      `${join(distRoot, 'index.html')} does not exist. ` +
        'Run `pnpm --filter ag-ui-harness build:page` first.',
    );
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/agui') {
      proxy(req, res, opts.agentUrl);
      return;
    }
    // Chrome asks unprompted, and an unhandled 404 shows up as a console error, which the
    // e2e asserts is empty.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = rel === '/' || rel === '\\' ? join(distRoot, 'index.html') : join(distRoot, rel);
    if (!file.startsWith(distRoot) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      ready({
        url: `http://localhost:${String(port)}/`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
```

`packages/harness/page/build.ts`

```ts
/**
 * Bundles the page. `@ag-ui/client` is an npm package with real dependencies (rxjs, zod,
 * fast-json-patch), so "no build step" is not available if the page is to use the real
 * client — and using the real client is the entire justification for the page (H3).
 * esbuild, one call, no config file: the minimum that makes H3 possible.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const outDir = join(pageRoot, 'dist');

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [join(pageRoot, 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'chrome111', // the manifest's `minimum_chrome_version`
  outfile: join(outDir, 'main.js'),
  sourcemap: true,
  logLevel: 'info',
});
copyFileSync(join(pageRoot, 'index.html'), join(outDir, 'index.html'));
```

`packages/harness/package.json` — add these entries to the file Task 1 created. Playwright and
esbuild are `devDependencies` of a `private: true` package that is never bundled or published,
which is how requirement "Playwright must never enter the shipped bundle" is satisfied
structurally; `packages/devtools`'s own `verify:build` grep remains the check on the shipped side.

```json
{
  "scripts": {
    "build:page": "tsx page/build.ts",
    "test": "vitest run",
    "test:ci": "pnpm build:page && vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@ag-ui/client": "0.0.57",
    "@ag-ui/core": "0.0.57",
    "@copilotkit/aimock": "1.38.0",
    "ag-ui-devtools": "workspace:*",
    "esbuild": "^0.28.2",
    "playwright": "^1.62.1",
    "tsx": "^4.19.2",
    "typescript": "^5.9.0",
    "vitest": "^4.1.10"
  }
}
```

Add `page/dist` to `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ag-ui-harness build:page && pnpm --filter ag-ui-harness test && pnpm --filter ag-ui-harness typecheck`

Expected: 7 tests pass across `page/render.test.ts` and `page/serve.test.ts`; typecheck clean.

- [ ] **Step 5: Commit**

`harness: page driven by the real @ag-ui/client HttpAgent`

---

### Task 5: `e2e/fixtures.ts` and the first end-to-end spec

This is the first test in the project that loads the actual built extension into an actual
browser. It is deliberately honest about where the capture layer currently stands: with
`inject/` still a stub and `src/sw/index.ts` installing no test hook, capture sees nothing, so
the capture assertion is **zero records, zero requests, zero dropped**. That is a real
assertion, not a placeholder — it proves the whole rig works end to end while proving capture
does not yet. **Every later capture commit turns more of that assertion positive:** the
`inject/` commit makes `requests` non-empty, the framing commit makes `records` non-empty, the
ring-buffer commit makes `droppedBefore` meaningful.

The spec stops at captured data, not rendered panel state (design H4): the DevTools panel UI is
shadow-encapsulated and its targets do not attach, so it is not drivable. Panel rendering
already has 320 jsdom tests and the screenshot gate. Assertions read the ring buffer out of the
MV3 service worker (H5), which is confirmed reachable.

**Files:**
- Create: `packages/harness/e2e/fixtures.ts`
- Edit: `packages/harness/vitest.config.ts`
- Test: `packages/harness/e2e/capture.spec.ts`

- [ ] **Step 1: Write the failing test**

`packages/harness/e2e/capture.spec.ts`

```ts
/**
 * The first end-to-end test: real extension, real browser, real SSE, real client.
 *
 * Preconditions, both of which fail loudly rather than silently:
 *   pnpm --filter ag-ui-devtools build      → packages/devtools/dist
 *   pnpm --filter ag-ui-harness build:page  → packages/harness/page/dist
 *
 * The last test asserts capture is EMPTY. That is the current truth: `inject/` patches no page
 * API and `src/sw/index.ts` installs no `__AGUI_DT_TEST__` hook. Each capture commit that
 * follows flips part of it positive.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { AguiEvent } from 'ag-ui-devtools/src/core/model/types';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';
import { SCENARIOS, type Scenario } from '../fixtures/index.js';
import { startPageServer, type PageServer } from '../page/serve.js';
import { launchWithExtension, readCapture } from './fixtures.js';

/** Derived from the scenario, so the fixture stays the single source of truth. */
function expectedAssistantText(scenario: Scenario): string {
  return scenario.events
    .filter((event: AguiEvent) => event.type === 'TEXT_MESSAGE_CONTENT')
    .map((event: AguiEvent) => (typeof event.delta === 'string' ? event.delta : ''))
    .join('');
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let extensionId: string;
let page: Page;
const pageErrors: string[] = [];
const posts: { url: string; accept: string }[] = [];

beforeAll(async () => {
  harness = await startHarnessServer();
  harness.use('happy');
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
});

afterAll(async () => {
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

test('the real HttpAgent runs the happy scenario and the page renders it', async () => {
  const scenario = SCENARIOS.happy;
  if (!scenario) throw new Error('SCENARIOS.happy is missing');

  await page.fill('#prompt', 'happy');
  await page.click('#run');
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'done',
    undefined,
    { timeout: 30_000 },
  );

  const rendered = await page.$$eval('#messages li', (items) =>
    items.map((item) => ({ role: item.getAttribute('data-role'), text: item.textContent })),
  );
  expect(rendered).toEqual([
    { role: 'user', text: 'happy' },
    { role: 'assistant', text: expectedAssistantText(scenario) },
  ]);
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
  await expect(readCapture(ctx)).resolves.toEqual({
    records: [],
    requests: [],
    droppedBefore: 0,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ag-ui-devtools build && pnpm --filter ag-ui-harness build:page && pnpm --filter ag-ui-harness test`

Expected: FAIL with `Error: Cannot find module './fixtures.js' imported from .../e2e/capture.spec.ts`.
The suite fails to collect; zero of its five tests run.

- [ ] **Step 3: Write the implementation**

`packages/harness/e2e/fixtures.ts`

```ts
/**
 * Playwright helpers for the capture e2e (design H4/H5).
 *
 * Two mechanics here are verified, not guessed, and must not be "simplified":
 *
 *  1. The extension is loaded via `launchPersistentContext` with `--disable-extensions-except`
 *     + `--load-extension`, in PLAYWRIGHT'S BUNDLED CHROMIUM. Chrome 151 has removed
 *     `--load-extension`; pointing this at a `channel: 'chrome'` browser silently launches
 *     with no extension at all. `channel: 'chromium'` pins the bundled build — measured: drop
 *     it and `headless: true` resolves to `chromium-headless-shell`, which launches happily,
 *     registers no service worker, and reports no error.
 *  2. `ctx.serviceWorkers()` is frequently EMPTY immediately after launch — observed. The
 *     `waitForEvent('serviceworker')` fallback is the difference between a reliable suite and
 *     a flaky one.
 *
 * The DevTools panel UI is NOT reachable and must not be driven from here. All assertions go
 * through `readCapture`, which reads the ring buffer out of the service worker.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Worker } from 'playwright';
import { chromium } from 'playwright';
import type { CaptureRecord } from 'ag-ui-devtools/src/core/model/types';

/**
 * Mirrors `RequestLine` in the locked contract verbatim. It is declared here rather than
 * imported because `packages/devtools/src/sw/protocol.ts` does not exist while the harness is
 * being built — the harness ships first, by design. Re-point this import at
 * `ag-ui-devtools/src/sw/protocol` in the commit that creates that module.
 */
export interface RequestLine {
  connId: string;
  tMs: number;
  method: string;
  url: string;
  input: unknown;
}

export interface CaptureSnapshot {
  records: CaptureRecord[];
  requests: RequestLine[];
  droppedBefore: number;
}

/** The shape `src/sw/index.ts` attaches to the SW global. Undefined until that task lands. */
interface TestHook {
  records(): CaptureRecord[];
  requests(): RequestLine[];
  droppedBefore(): number;
  bytes(): number;
  clear(): void;
}

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION_DIST =
  process.env.AGUI_EXTENSION_DIST ?? resolve(harnessRoot, '../devtools/dist');

export async function launchWithExtension(): Promise<{
  ctx: BrowserContext;
  extensionId: string;
}> {
  // A missing dist launches a browser with no extension and fails later on a confusing
  // assertion about a marker that was never going to be there. Fail here instead.
  if (!existsSync(join(EXTENSION_DIST, 'manifest.json'))) {
    throw new Error(
      `${join(EXTENSION_DIST, 'manifest.json')} does not exist. ` +
        'Run `pnpm --filter ag-ui-devtools build` before the e2e suite.',
    );
  }
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'agui-harness-')), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIST}`,
      `--load-extension=${EXTENSION_DIST}`,
    ],
  });
  const sw = await serviceWorker(ctx);
  return { ctx, extensionId: new URL(sw.url()).host };
}

async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers()[0];
  if (existing) return existing;
  return ctx.waitForEvent('serviceworker', { timeout: 30_000 });
}

export async function readCapture(ctx: BrowserContext): Promise<CaptureSnapshot> {
  const sw = await serviceWorker(ctx);
  return sw.evaluate((): CaptureSnapshot => {
    // `__AGUI_DT_TEST__` is undefined on today's build — `src/sw/index.ts` is the phase-1
    // stub. Reporting empties rather than throwing is what lets the first e2e be green while
    // still asserting something true.
    const hook = (globalThis as { __AGUI_DT_TEST__?: TestHook }).__AGUI_DT_TEST__;
    if (!hook) {
      return { records: [], requests: [], droppedBefore: 0 };
    }
    return {
      records: hook.records(),
      requests: hook.requests(),
      droppedBefore: hook.droppedBefore(),
    };
  });
}
```

`packages/harness/vitest.config.ts` — extend the config Task 1 created so the e2e specs are
collected and given browser-sized budgets:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['page/**/*.test.ts', 'server/**/*.test.ts', 'fixtures/**/*.test.ts', 'e2e/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One browser and one pair of servers at a time. Parallel files would race for the
    // extension profile directory and multiply Chromium launches for no benefit.
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ag-ui-devtools build && pnpm --filter ag-ui-harness build:page && pnpm --filter ag-ui-harness test && pnpm --filter ag-ui-harness typecheck`

Expected: 5 e2e tests pass alongside the 7 from Task 4; typecheck clean.

First run on a clean machine also needs `pnpm --filter ag-ui-harness exec playwright install chromium`
— the full Chromium, **not** `chromium-headless-shell`, which cannot load extensions. That is a
different browser from the one `screenshot:panel` installs, and CI must install both.

- [ ] **Step 5: Commit**

`harness: first end-to-end capture spec (asserts capture is still empty)`

---

## Contract gaps

1. **Nothing in the contract serves the harness page.** `startHarnessServer` returns the aimock
   url only. `AGUIMock` was measured to send no `Access-Control-Allow-*` headers and to 404 the
   `OPTIONS` preflight, so the page cannot reach it cross-origin at all. Task 4 adds
   `page/serve.ts` exporting `startPageServer({ agentUrl, port? }): Promise<PageServer>` with
   `PageServer = { readonly url: string; stop(): Promise<void> }`, serving `page/dist` and
   proxying `POST /agui`. Fold this into the contract or move it into `server/`.

2. **`RequestLine` has no home module at harness time.** The contract places it in
   `src/sw/protocol.ts`, which the capture tasks create *after* the harness. `e2e/fixtures.ts`
   declares it locally, verbatim, with a pointer comment; the SW task should re-point that
   import. `CaptureRecord` has no such problem — `src/core/model/types` exists today and the
   subpath import resolves through the pnpm workspace link.

3. **The contract does not say what the harness page needs from a build.** `@ag-ui/client` has
   real npm dependencies, so "no build step" and "the real `HttpAgent`" cannot both hold. Task 4
   resolves it with one esbuild call (`page/build.ts`, `build:page`), targeting `chrome111` to
   match the manifest floor.

4. **`readCapture` has no defined behaviour when `__AGUI_DT_TEST__` is absent**, which is its
   state on every build until the SW task lands. Task 5 returns
   `{ records: [], requests: [], droppedBefore: 0 }`. Worth stating in the contract, because the
   alternative — throwing — would make the first green e2e impossible.

5. **Playwright browser installation is unspecified.** The e2e needs full `chromium`;
   `screenshot:panel` needs `chromium-headless-shell`. `chromium-headless-shell` cannot load
   extensions. CI must install both.

---

## Capture layer, part C — the `fetch` path (Tasks 6–8)

Requirements §5.1, §5.4, §5.5, §11, §15. This is the milestone's centre: `core/sse/parser` and
`core/detect/classifier` are complete and tested but unreachable — nothing in the shipped extension
calls them. These three tasks make them reachable from a real page.

Why a MAIN-world `fetch` patch at all, restated from §3 so nobody re-litigates it during review:
AG-UI's client POSTs with `Accept: text/event-stream` (verified fact 5). `chrome.debugger`'s
`Network.eventSourceMessageReceived` only fires for the `EventSource` API, so CDP would never see
the main case. `chrome.devtools.network` cannot hand back a streaming body incrementally. Patching
`window.fetch` at `document_start` is the only approach that sees each frame as it lands.

Three decisions worth reading before the diffs:

- **`WireFrame.raw` is the frame's `data` payload for events**, and the reconstructed
  `:${comment}\n\n` line for keepalives. The contract calls `raw` "the exact frame text"; for a
  keepalive that is unambiguous, but for an event frame the alternative — shipping
  `data: {...}\n\n` and re-parsing SSE in the service worker — would be absurd. This choice also
  matches what `panel/import/load-jsonl.ts` already puts into `CaptureRecord.raw`. Consequence:
  `event:` / `id:` / `retry:` metadata is dropped. AG-UI streams use bare `data:` frames, so
  nothing is lost today. Listed under Contract gaps.
- **Every `text/event-stream` response is captured**, whether or not it turns out to be AG-UI.
  §15 names "silently capturing nothing" as a failure mode to avoid, and `InjectMessage` has no
  field for a classification verdict, so gating delivery on the classifier would mean dropping
  frames with no way to say so. `createConnClassifier` still runs on every frame; its verdict is
  read back through `FetchPatch.classificationOf(connId)` until the contract grows a field for it.
- **Task 8 does not create `src/inject/index.ts`.** The manifest entry stays
  `src/inject/inject.ts`. Amendment A28 in the phase-1 plan documents why: CRXJS keys emitted
  scripts by basename, so an `index.ts` here collides with `src/sw/index.ts`, and the collision is
  **silent** — the build succeeds and the emitted manifest points the MAIN-world content script at
  the service worker chunk, which throws at `document_start` on every page. That regression was
  reproduced on this repo. Keep all three entry basenames distinct.

All commands below run from `packages/devtools` unless the step says otherwise.

Every code block below was executed: the modules were built against the real `src/core/**` and run
under Vitest 4.1.10 in jsdom, plus `tsc --noEmit` and the repo's ESLint config. 71 tests pass.

---

### Task 6: The inject → relay wire protocol

`InjectMessage`, `WireFrame`, `isInjectMessage`, and the two literals, exactly as the contract
fixes them. Pure — no DOM, no `chrome` — but it ships in a jsdom project because the rest of
`src/inject/**` needs one and a second project for one pure file is not worth the config.

`isInjectMessage` is a security boundary, not a convenience: the MAIN world is the page's own
world, so any script on the page can post a lookalike message at the relay. It must reject
everything malformed and must not be able to throw, because a throw inside the relay's `message`
listener takes the listener down.

**Files:**
- Modify: `packages/devtools/vitest.config.ts`
- Create: `packages/devtools/src/inject/protocol.ts`
- Test: `packages/devtools/src/inject/protocol.test.ts`

- [ ] **Step 1: Add the `inject` Vitest project**

`packages/devtools/vitest.config.ts` in full:

```ts
import { defineConfig } from 'vitest/config';

/**
 * Three projects, because the three halves of this package have incompatible environments.
 *
 * `core/` is deliberately Chrome-free and DOM-free (design §3 / D10, enforced by the
 * `no-restricted-globals` fence in eslint.config.js) and must keep running under plain `node` —
 * running it in jsdom would silently make `document` and `window` available and let the fence rot.
 * `panel/` renders Preact and needs a DOM, so it gets jsdom plus a setup file. `inject/` patches
 * page globals and reads streaming `Response` bodies, so it needs a DOM too — but no setup file
 * and no Preact.
 *
 * `test.projects` is the Vitest 4 API (`InlineConfig.projects?: TestProjectConfiguration[]`);
 * each entry is itself a config object with its own nested `test` block.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          // `src/test/` holds the cross-module integration + golden-fixture suite. It imports only
          // from core/ and is Node-only, so it belongs to this project despite living outside
          // `src/core/`; without the second glob its 5 tests would stop running entirely.
          include: ['src/core/**/*.test.ts', 'src/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'panel',
          environment: 'jsdom',
          include: ['src/panel/**/*.test.{ts,tsx}'],
          setupFiles: ['src/panel/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'inject',
          // jsdom implements none of `fetch`, `Response`, `ReadableStream` or `TextDecoder`, so
          // Vitest's jsdom environment leaves Node's versions in place on globalThis — which is
          // exactly what the fetch patch needs. Verified: all four are present, `Response.body`
          // is a real `ReadableStream`, and `tee()` behaves as it does in Chrome.
          environment: 'jsdom',
          include: ['src/inject/**/*.test.ts'],
        },
      },
    ],
  },
});
```

Run `pnpm test:ci` and confirm the existing suite is unchanged: the new
project matches no files yet, so the totals stay where they were.

- [ ] **Step 2: Write the failing test**

`packages/devtools/src/inject/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  AGUI_DT_SOURCE,
  PROTOCOL_VERSION,
  isInjectMessage,
  type InjectMessage,
  type WireFrame,
} from './protocol';

const connOpen: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'conn-open',
  connId: 'c1',
  tMs: 12.5,
  method: 'POST',
  url: 'http://localhost:3000/api/copilotkit/agent/default/run',
  contentType: 'text/event-stream',
  input: { threadId: 't_1', runId: 'r_1', messages: [] },
};

const frames: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'frames',
  connId: 'c1',
  frames: [
    { kind: 'event', tMs: 13, raw: '{"type":"RUN_STARTED"}' },
    { kind: 'keepalive', tMs: 14, raw: ':ping\n\n', comment: 'ping' },
  ],
};

const goodFrame: WireFrame = { kind: 'event', tMs: 13, raw: '{"type":"RUN_STARTED"}' };

const connClose: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'conn-close',
  connId: 'c1',
  tMs: 99,
  reason: 'complete',
};

const binary: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'binary',
  connId: 'c2',
  tMs: 42,
  contentType: 'application/vnd.ag-ui.event+proto',
  bytes: 2048,
};

/** A copy of `message` with one key removed, so "missing field" cases stay readable. */
function without(message: InjectMessage, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...message };
  delete copy[key];
  return copy;
}

describe('constants', () => {
  it('pins the literals the relay matches on', () => {
    expect(AGUI_DT_SOURCE).toBe('agui-dt');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('isInjectMessage — accepts every message the contract defines', () => {
  it('accepts conn-open', () => {
    expect(isInjectMessage(connOpen)).toBe(true);
  });

  it('accepts frames, including an empty batch', () => {
    expect(isInjectMessage(frames)).toBe(true);
    expect(isInjectMessage({ ...frames, frames: [] })).toBe(true);
  });

  it('accepts conn-close for every reason', () => {
    for (const reason of ['complete', 'error', 'aborted'] as const) {
      expect(isInjectMessage({ ...connClose, reason })).toBe(true);
    }
  });

  it('accepts binary, including a zero-byte body', () => {
    expect(isInjectMessage(binary)).toBe(true);
    expect(isInjectMessage({ ...binary, bytes: 0 })).toBe(true);
  });

  it('accepts conn-open with an explicitly undefined input', () => {
    expect(isInjectMessage({ ...connOpen, input: undefined })).toBe(true);
  });

  it('accepts a null contentType on conn-open', () => {
    expect(isInjectMessage({ ...connOpen, contentType: null })).toBe(true);
  });

  it('accepts messages that survived a structured clone', () => {
    for (const message of [connOpen, frames, connClose, binary]) {
      expect(isInjectMessage(structuredClone(message))).toBe(true);
    }
  });

  it('narrows the type so the relay can switch on kind', () => {
    const value: unknown = frames;
    if (!isInjectMessage(value)) throw new Error('expected a valid message');
    const kinds: string[] = [];
    if (value.kind === 'frames') {
      const list: WireFrame[] = value.frames;
      kinds.push(...list.map((f) => f.kind));
    }
    expect(kinds).toEqual(['event', 'keepalive']);
  });
});

describe('isInjectMessage — rejects anything else', () => {
  it('rejects non-objects', () => {
    for (const value of [null, undefined, 0, 1, '', 'agui-dt', true, Symbol('x'), () => 0]) {
      expect(isInjectMessage(value)).toBe(false);
    }
  });

  it('rejects arrays', () => {
    expect(isInjectMessage([])).toBe(false);
    expect(isInjectMessage([connOpen])).toBe(false);
  });

  it('rejects a foreign or missing source tag', () => {
    expect(isInjectMessage({ ...connOpen, source: 'other-tool' })).toBe(false);
    expect(isInjectMessage({ ...connOpen, source: undefined })).toBe(false);
    expect(isInjectMessage(without(connOpen, 'source'))).toBe(false);
  });

  it('rejects a foreign protocol version', () => {
    expect(isInjectMessage({ ...connOpen, v: 2 })).toBe(false);
    expect(isInjectMessage({ ...connOpen, v: '1' })).toBe(false);
  });

  it('rejects an unknown or missing kind', () => {
    expect(isInjectMessage({ ...connOpen, kind: 'conn-reopen' })).toBe(false);
    expect(isInjectMessage({ source: AGUI_DT_SOURCE, v: 1, connId: 'c1' })).toBe(false);
  });

  it('rejects a missing or empty connId', () => {
    expect(isInjectMessage({ ...connOpen, connId: '' })).toBe(false);
    expect(isInjectMessage({ ...connOpen, connId: 7 })).toBe(false);
    expect(isInjectMessage(without(connOpen, 'connId'))).toBe(false);
  });

  it('rejects non-finite timestamps', () => {
    expect(isInjectMessage({ ...connOpen, tMs: Number.NaN })).toBe(false);
    expect(isInjectMessage({ ...connOpen, tMs: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isInjectMessage({ ...connOpen, tMs: '12' })).toBe(false);
  });

  it('rejects conn-open without an input key', () => {
    expect(isInjectMessage(without(connOpen, 'input'))).toBe(false);
  });

  it('rejects conn-open with a non-string method or url', () => {
    expect(isInjectMessage({ ...connOpen, method: 7 })).toBe(false);
    expect(isInjectMessage({ ...connOpen, url: null })).toBe(false);
  });

  it('rejects frames that are not an array', () => {
    expect(isInjectMessage({ ...frames, frames: '[]' })).toBe(false);
    expect(isInjectMessage({ ...frames, frames: { 0: frames.kind } })).toBe(false);
  });

  it('rejects a batch containing one malformed frame', () => {
    const bad: unknown[] = [
      { kind: 'event', tMs: 1, raw: 1 },
      { kind: 'event', tMs: 'soon', raw: 'x' },
      { kind: 'keepalive', tMs: 1, raw: ':x\n\n' },
      { kind: 'chunk', tMs: 1, raw: 'x' },
      null,
      'data: x',
    ];
    for (const frame of bad) {
      expect(isInjectMessage({ ...frames, frames: [goodFrame, frame] })).toBe(false);
    }
  });

  it('rejects an unknown close reason', () => {
    expect(isInjectMessage({ ...connClose, reason: 'timeout' })).toBe(false);
    expect(isInjectMessage({ ...connClose, reason: undefined })).toBe(false);
  });

  it('rejects binary without a byte count or content type', () => {
    expect(isInjectMessage({ ...binary, bytes: -1 })).toBe(false);
    expect(isInjectMessage({ ...binary, bytes: Number.NaN })).toBe(false);
    expect(isInjectMessage({ ...binary, contentType: null })).toBe(false);
  });
});

describe('isInjectMessage — hostile input from the page', () => {
  it('returns false instead of throwing when a getter throws', () => {
    const hostile = {
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-open',
      connId: 'c1',
      get tMs(): number {
        throw new Error('boom');
      },
    };
    expect(() => isInjectMessage(hostile)).not.toThrow();
    expect(isInjectMessage(hostile)).toBe(false);
  });

  it('returns false instead of throwing for a Proxy with hostile traps', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('boom');
        },
        has(): never {
          throw new Error('boom');
        },
      },
    );
    expect(isInjectMessage(hostile)).toBe(false);
  });

  it('returns false instead of throwing when frames.every is poisoned', () => {
    const hostileFrames = Object.assign([], {
      every(): never {
        throw new Error('boom');
      },
    });
    expect(isInjectMessage({ ...frames, frames: hostileFrames })).toBe(false);
  });

  it('handles a null-prototype message body', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, connOpen);
    expect(isInjectMessage(bare)).toBe(true);
  });

  it('reads inherited properties: this is a shape check, not an own-property check', () => {
    const proto = { source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION, kind: 'conn-close', reason: 'complete', tMs: 1 };
    const inherited = Object.create(proto) as Record<string, unknown>;
    inherited.connId = 'c1';
    // Pinned deliberately: structuredClone flattens the prototype chain anyway, so a real
    // postMessage never delivers this shape, and rejecting it would buy nothing.
    expect(isInjectMessage(inherited)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/inject/protocol.test.ts`

Expected: FAIL with `Error: Failed to resolve import "./protocol" from
"src/inject/protocol.test.ts". Does the file exist?`

- [ ] **Step 4: Write the implementation**

`packages/devtools/src/inject/protocol.ts`:

```ts
/**
 * The MAIN-world → ISOLATED-world wire protocol (design §3, requirements §11).
 *
 * Both halves of the boundary import this module: `inject/` builds messages, `relay/`
 * validates them. It is pure — no DOM, no `chrome` — so it is unit-testable anywhere.
 */

export const AGUI_DT_SOURCE = 'agui-dt';
export const PROTOCOL_VERSION = 1;

/**
 * One SSE frame as it left the wire.
 *
 * For `kind: 'event'`, `raw` is the frame's `data` payload exactly as received — data lines
 * joined with `\n`, one leading space after the colon stripped, which is what the SSE grammar
 * says the payload is. For `kind: 'keepalive'`, `raw` is the reconstructed comment frame
 * (`:${comment}\n\n`), matching what `panel/import/load-jsonl.ts` already puts in
 * `CaptureRecord.raw` for an imported keepalive.
 */
export type WireFrame =
  | { kind: 'event'; tMs: number; raw: string }
  | { kind: 'keepalive'; tMs: number; raw: string; comment: string };

export type InjectMessage =
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'conn-open';
      connId: string;
      tMs: number;
      method: string;
      url: string;
      contentType: string | null;
      input: unknown;
    }
  | { source: 'agui-dt'; v: 1; kind: 'frames'; connId: string; frames: WireFrame[] }
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'conn-close';
      connId: string;
      tMs: number;
      reason: 'complete' | 'error' | 'aborted';
    }
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'binary';
      connId: string;
      tMs: number;
      contentType: string;
      bytes: number;
    };

const CLOSE_REASONS: ReadonlySet<string> = new Set(['complete', 'error', 'aborted']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWireFrame(value: unknown): value is WireFrame {
  if (!isRecord(value)) return false;
  if (!isTime(value.tMs)) return false;
  if (typeof value.raw !== 'string') return false;
  if (value.kind === 'event') return true;
  if (value.kind === 'keepalive') return typeof value.comment === 'string';
  return false;
}

function check(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.source !== AGUI_DT_SOURCE) return false;
  if (value.v !== PROTOCOL_VERSION) return false;
  if (typeof value.connId !== 'string' || value.connId === '') return false;

  switch (value.kind) {
    case 'conn-open':
      return (
        isTime(value.tMs) &&
        typeof value.method === 'string' &&
        typeof value.url === 'string' &&
        (value.contentType === null || typeof value.contentType === 'string') &&
        // `input` is `unknown`, so the only thing to assert is that the sender meant to
        // send one. A conn-open with no `input` key is a capture bug (verified fact 4),
        // not a message to forward.
        'input' in value
      );
    case 'frames':
      return Array.isArray(value.frames) && value.frames.every(isWireFrame);
    case 'conn-close':
      return isTime(value.tMs) && typeof value.reason === 'string' && CLOSE_REASONS.has(value.reason);
    case 'binary':
      return (
        isTime(value.tMs) &&
        typeof value.contentType === 'string' &&
        isTime(value.bytes) &&
        value.bytes >= 0
      );
    default:
      return false;
  }
}

/**
 * Shape guard for everything crossing the postMessage boundary. This is a security
 * boundary: the MAIN world is the page's world, so any script on the page can post a
 * lookalike message. Anything that fails is dropped silently by `relay/`.
 *
 * Hostile input must not be able to throw out of here — a throwing getter or a `Proxy`
 * with a hostile `has` trap would otherwise take down the relay's message listener — so
 * the whole check runs inside `try`.
 */
export function isInjectMessage(value: unknown): value is InjectMessage {
  try {
    return check(value);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/inject/protocol.test.ts`

Expected: `Test Files 1 passed (1)`, `Tests 27 passed (27)`.

Then `pnpm typecheck && pnpm lint`.

- [ ] **Step 6: Commit**

```
git add packages/devtools/vitest.config.ts packages/devtools/src/inject/protocol.ts packages/devtools/src/inject/protocol.test.ts
git commit -m "Add the inject to relay wire protocol and its shape guard"
```

---

### Task 7: The `fetch` patch

The heart of it. Patch `window.fetch`; hold the original first; capture request meta and the body;
classify by content type; `tee()` the response body, hand one branch back to the page untouched and
drain the other eagerly; feed the drained branch through `core/sse/parser`; emit `conn-open`,
batched `frames`, and `conn-close`.

Details that the tests pin, because each one is a way this goes subtly wrong:

- **Back-pressure (§15).** `tee()` buffers for whichever branch lags. The drain loop therefore
  never awaits delivery: frames are pushed onto a queue and flushed on a scheduled callback, and
  the drain keeps reading even if that callback never runs. Three tests cover it, including one
  where the page never reads its branch at all and one where the scheduler is stalled forever.
- **Request body (verified fact 4).** Without the `RunAgentInput`, every real capture reports a
  spurious `run-started-without-input`. §5.1's four body types are handled plus `Request` inputs;
  a `ReadableStream` body is recorded as `[unreadable stream body]` rather than consumed. A JSON
  body is parsed to structure — only objects and arrays, so a bare `"42"` stays the string the page
  sent. Because a `Blob` read is async, `conn-open` is gated on it and frames queue behind it;
  ordering is pinned by a test.
- **Timestamps (§5.5).** A frame is stamped with the arrival time of the chunk its first byte
  arrived in, not with parse-completion time. Only the first frame produced by a chunk can have
  started earlier; every later frame in that chunk began inside it.
- **Binary (§5.4).** `application/vnd.ag-ui.event+proto` emits `conn-open`, one `binary` with the
  byte count, and `conn-close` — never frames. Decoding is Phase 3.
- **Transparency.** `new Response(body, init)` — the shape §5.1 prescribes — drops `url`,
  `redirected` and `type`, all page-readable. They are shadowed back on. Null-body statuses are
  checked *before* the tee, because after a tee the original body is locked and there is no way
  back.

**Files:**
- Create: `packages/devtools/src/inject/fetch-patch.ts`
- Test: `packages/devtools/src/inject/fetch-patch.test.ts`

- [ ] **Step 7: Write the failing test**

`packages/devtools/src/inject/fetch-patch.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { installFetchPatch, type FetchHost } from './fetch-patch';
import { isInjectMessage, type InjectMessage, type WireFrame } from './protocol';

const RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}';
const TEXT_START = '{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}';
const TEXT_END = '{"type":"TEXT_MESSAGE_END","messageId":"m_1"}';

/** A stream whose chunks are pushed by the test, so ordering is never a race. */
function controllable(): {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
  error(reason: unknown): void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
    },
  });
  const require = (): ReadableStreamDefaultController<Uint8Array> => {
    if (controller === undefined) throw new Error('stream not started');
    return controller;
  };
  return {
    stream,
    push: (text: string): void => require().enqueue(encoder.encode(text)),
    close: (): void => require().close(),
    error: (reason: unknown): void => require().error(reason),
  };
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>, contentType = 'text/event-stream'): Response {
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': contentType },
  });
}

/** Lets every pending microtask and stream read settle. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Harness {
  host: FetchHost;
  posted: InjectMessage[];
  kinds(): string[];
  frames(): WireFrame[];
  patch: ReturnType<typeof installFetchPatch>;
}

function harness(
  respond: (...args: Parameters<typeof fetch>) => Promise<Response>,
  overrides: Partial<Parameters<typeof installFetchPatch>[1]> = {},
): Harness {
  const posted: InjectMessage[] = [];
  const host: FetchHost = { fetch: respond as typeof fetch };
  let clock = 0;
  const patch = installFetchPatch(host, {
    post: (message): void => {
      posted.push(message);
    },
    now: (): number => {
      clock += 1;
      return clock;
    },
    newConnId: (): string => 'c1',
    ...overrides,
  });
  return {
    host,
    posted,
    patch,
    kinds: (): string[] => posted.map((m) => m.kind),
    frames: (): WireFrame[] =>
      posted.flatMap((m) => (m.kind === 'frames' ? m.frames : [])),
  };
}

describe('installFetchPatch — transparency to the page', () => {
  it('replaces fetch and restores it on uninstall', () => {
    const original = ((): Promise<Response> => Promise.resolve(new Response(''))) as typeof fetch;
    const host: FetchHost = { fetch: original };
    const patch = installFetchPatch(host, { post: (): void => undefined });
    expect(host.fetch).not.toBe(original);
    patch.uninstall();
    expect(host.fetch).toBe(original);
  });

  it('does not clobber a later patch installed over ours', () => {
    const original = ((): Promise<Response> => Promise.resolve(new Response(''))) as typeof fetch;
    const host: FetchHost = { fetch: original };
    const patch = installFetchPatch(host, { post: (): void => undefined });
    const theirs = ((): Promise<Response> => Promise.resolve(new Response(''))) as typeof fetch;
    host.fetch = theirs;
    patch.uninstall();
    expect(host.fetch).toBe(theirs);
  });

  it('passes the original arguments through untouched', async () => {
    const seen: unknown[] = [];
    const init: RequestInit = { method: 'POST', body: '{"a":1}' };
    const h = harness((...args) => {
      seen.push(...args);
      return Promise.resolve(new Response('ok', { headers: { 'content-type': 'application/json' } }));
    });
    await h.host.fetch('http://localhost:3000/api', init);
    expect(seen[0]).toBe('http://localhost:3000/api');
    expect(seen[1]).toBe(init);
  });

  it('returns a non-stream response as the very same object, unlocked', async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const h = harness(() => Promise.resolve(response));
    const got = await h.host.fetch('http://localhost:3000/api');
    expect(got).toBe(response);
    expect(got.bodyUsed).toBe(false);
    expect(await got.text()).toBe('{"ok":true}');
    await settle();
    expect(h.posted).toEqual([]);
  });

  it('propagates a rejection unchanged and posts nothing', async () => {
    const failure = new TypeError('Failed to fetch');
    const h = harness(() => Promise.reject(failure));
    await expect(h.host.fetch('http://localhost:3000/api')).rejects.toBe(failure);
    await settle();
    expect(h.posted).toEqual([]);
  });

  it('hands the page a byte-identical body plus status, headers, url and type', async () => {
    const original = new Response(streamOf([`data: ${RUN_STARTED}\n\n`, 'data: tail\n\n']), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream', 'x-trace': 'abc' },
    });
    Object.defineProperty(original, 'url', { value: 'http://localhost:3000/run' });
    const h = harness(() => Promise.resolve(original));
    const got = await h.host.fetch('http://localhost:3000/run');
    expect(got.status).toBe(200);
    expect(got.statusText).toBe('OK');
    expect(got.headers.get('content-type')).toBe('text/event-stream');
    expect(got.headers.get('x-trace')).toBe('abc');
    expect(got.url).toBe('http://localhost:3000/run');
    expect(got.type).toBe(original.type);
    expect(await got.text()).toBe(`data: ${RUN_STARTED}\n\ndata: tail\n\n`);
  });

  it('survives a relay that throws on every message', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`]))), {
      post: (): void => {
        throw new Error('relay is gone');
      },
    });
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(await got.text()).toBe(`data: ${RUN_STARTED}\n\n`);
  });
});

describe('installFetchPatch — capture', () => {
  it('emits conn-open, frames and conn-close in order', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_START}\n\n`])),
      ),
    );
    await h.host.fetch('http://localhost:3000/api/copilotkit/agent/default/run', {
      method: 'post',
      body: '{"threadId":"t_1","runId":"r_1","messages":[]}',
    });
    await settle();

    expect(h.kinds()).toEqual(['conn-open', 'frames', 'frames', 'conn-close']);
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.method).toBe('POST');
    expect(open.url).toBe('http://localhost:3000/api/copilotkit/agent/default/run');
    expect(open.contentType).toBe('text/event-stream');
    expect(open.input).toEqual({ threadId: 't_1', runId: 'r_1', messages: [] });
    expect(open.connId).toBe('c1');

    expect(h.frames().map((f) => f.raw)).toEqual([RUN_STARTED, TEXT_START]);

    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('complete');
    expect(h.posted.every(isInjectMessage)).toBe(true);
  });

  it('records keepalive comments as keepalive frames', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf([': ping\n\n', `data: ${RUN_STARTED}\n\n`, ':\n\n']))),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames()).toEqual([
      { kind: 'keepalive', tMs: expect.any(Number), raw: ':ping\n\n', comment: 'ping' },
      { kind: 'event', tMs: expect.any(Number), raw: RUN_STARTED },
      { kind: 'keepalive', tMs: expect.any(Number), raw: ':\n\n', comment: '' },
    ]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf(['data: {"type":"TEXT_MES', 'SAGE_CONTENT","delta":"hi"}\r\n', '\r\n'])),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual(['{"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}']);
  });

  it('flushes an unterminated trailing frame when the stream ends', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([`data: ${TEXT_END}\n`]))));
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual([TEXT_END]);
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
  });

  it('batches every frame of one chunk into a single frames message', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf([`data: ${RUN_STARTED}\n\ndata: ${TEXT_START}\n\ndata: ${TEXT_END}\n\n`])),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    const batches = h.posted.filter((m) => m.kind === 'frames');
    expect(batches).toHaveLength(1);
    expect(h.frames()).toHaveLength(3);
  });

  it('never delivers frames after conn-close even when the batch is still queued', async () => {
    const held: Array<() => void> = [];
    const h = harness(
      () => Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`]))),
      { schedule: (task): number => held.push(task) },
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'frames', 'conn-close']);
    for (const task of held) task();
    expect(h.kinds()).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('classifies the connection from its content (spec §4.1)', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_START}\n\n`])),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.patch.classificationOf('c1')).toBe('agui');
  });

  it('leaves an unrelated SSE stream classified not-agui but still captured', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf(['data: {"hello":"world"}\n\n']))),
    );
    await h.host.fetch('http://localhost:3000/progress');
    await settle();
    expect(h.patch.classificationOf('c1')).toBe('not-agui');
    expect(h.frames().map((f) => f.raw)).toEqual(['{"hello":"world"}']);
  });
});

describe('installFetchPatch — back-pressure (requirements §15)', () => {
  it('drains our branch in full even when the page never reads its own', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_START}\n\n`, `data: ${TEXT_END}\n\n`])),
      ),
    );
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(got.bodyUsed).toBe(false);
    expect(h.frames()).toHaveLength(3);
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
  });

  it('delivers a frame to the relay before the page reads that chunk', async () => {
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    const reader = got.body?.getReader();
    if (reader === undefined) throw new Error('page body missing');

    source.push(`data: ${RUN_STARTED}\n\n`);
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual([RUN_STARTED]);

    // Only now does the page get around to reading.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(`data: ${RUN_STARTED}\n\n`);

    source.push(`data: ${TEXT_END}\n\n`);
    source.close();
    await settle();
    expect(h.frames()).toHaveLength(2);
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
    await reader.read();
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it('keeps draining while delivery is stalled indefinitely', async () => {
    const stalled: Array<() => void> = [];
    const h = harness(
      () =>
        Promise.resolve(
          sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_END}\n\n`])),
        ),
      { schedule: (task): number => stalled.push(task) },
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    // The stream was fully consumed and closed even though no scheduled flush ever ran.
    expect(h.kinds()).toContain('conn-close');
    expect(h.frames()).toHaveLength(2);
  });
});

describe('installFetchPatch — request body capture (verified fact 4)', () => {
  async function inputFor(body: BodyInit | null | undefined): Promise<unknown> {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([':\n\n']))));
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body });
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    return open.input;
  }

  it('parses a JSON string body into structure', async () => {
    expect(await inputFor('{"threadId":"t_1","messages":[{"role":"user"}]}')).toEqual({
      threadId: 't_1',
      messages: [{ role: 'user' }],
    });
  });

  it('keeps a non-JSON string body verbatim', async () => {
    expect(await inputFor('threadId=t_1')).toBe('threadId=t_1');
  });

  it('keeps a scalar JSON body as the string the page sent', async () => {
    expect(await inputFor('42')).toBe('42');
  });

  it('serialises URLSearchParams', async () => {
    expect(await inputFor(new URLSearchParams({ threadId: 't_1', q: 'a b' }))).toBe(
      'threadId=t_1&q=a+b',
    );
  });

  it('lists FormData entries, naming file parts without reading them', async () => {
    const form = new FormData();
    form.append('threadId', 't_1');
    form.append('upload', new Blob(['1234'], { type: 'text/plain' }), 'note.txt');
    expect(await inputFor(form)).toEqual([
      ['threadId', 't_1'],
      ['upload', '[file note.txt, 4 bytes]'],
    ]);
  });

  it('reads a Blob body', async () => {
    expect(await inputFor(new Blob(['{"threadId":"t_1"}'], { type: 'application/json' }))).toEqual({
      threadId: 't_1',
    });
  });

  it('records a ReadableStream body without consuming it', async () => {
    const body = streamOf(['{"threadId":"t_1"}']);
    expect(await inputFor(body)).toBe('[unreadable stream body]');
    expect(body.locked).toBe(false);
    expect(await new Response(body).text()).toBe('{"threadId":"t_1"}');
  });

  it('records null when there is no body', async () => {
    expect(await inputFor(undefined)).toBe(null);
    expect(await inputFor(null)).toBe(null);
  });

  it('captures the body of a Request argument without disturbing it', async () => {
    const seen: Request[] = [];
    const h = harness((...args) => {
      seen.push(args[0] as Request);
      return Promise.resolve(sseResponse(streamOf([':\n\n'])));
    });
    const request = new Request('http://localhost:3000/run', {
      method: 'POST',
      body: '{"threadId":"t_2"}',
    });
    await h.host.fetch(request);
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_2' });
    expect(open.method).toBe('POST');
    expect(open.url).toBe('http://localhost:3000/run');
    expect(seen[0]?.bodyUsed).toBe(false);
  });

  it('holds frames until conn-open, even when the body read resolves late', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`]))),
    );
    await h.host.fetch('http://localhost:3000/run', {
      method: 'POST',
      body: new Blob(['{"threadId":"t_1"}']),
    });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'frames', 'conn-close']);
  });
});

describe('installFetchPatch — binary transport (requirements §5.4)', () => {
  it('reports byte counts and never frames', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf(['abcd', 'efghij']), 'application/vnd.ag-ui.event+proto'),
      ),
    );
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'binary', 'conn-close']);
    const binary = h.posted[1];
    if (binary?.kind !== 'binary') throw new Error('expected binary');
    expect(binary.bytes).toBe(10);
    expect(binary.contentType).toBe('application/vnd.ag-ui.event+proto');
    expect(h.patch.classificationOf('c1')).toBe('binary');
    expect(await got.text()).toBe('abcdefghij');
  });
});

describe('installFetchPatch — failures mid-stream', () => {
  it('closes with error when the response stream errors', async () => {
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    source.push(`data: ${RUN_STARTED}\n\n`);
    await settle();
    source.error(new TypeError('network error'));
    await settle();
    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('error');
    await expect(got.text()).rejects.toBeDefined();
  });

  it('closes with aborted when the caller aborted', async () => {
    const controller = new AbortController();
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    void h.host.fetch('http://localhost:3000/run', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    source.error(new DOMException('The user aborted a request.', 'AbortError'));
    await settle();
    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('aborted');
  });

  it('closes with aborted on an AbortError with no signal in sight', async () => {
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    void h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    source.error(new DOMException('aborted', 'AbortError'));
    await settle();
    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('aborted');
  });

  it('opens and closes an SSE response that carries no body at all', async () => {
    const h = harness(() =>
      Promise.resolve(new Response(null, { status: 204, headers: { 'content-type': 'text/event-stream' } })),
    );
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'conn-close']);
    expect(got.status).toBe(204);
  });
});

describe('installFetchPatch — timestamps (requirements §5.5)', () => {
  it('stamps a frame when its first byte arrived, not when parsing finished', async () => {
    const source = controllable();
    const clock = { value: 100 };
    const h = harness(() => Promise.resolve(sseResponse(source.stream)), {
      now: (): number => clock.value,
    });
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });

    clock.value = 200;
    source.push('data: {"type":"RUN_STAR');
    await settle();
    expect(h.frames()).toHaveLength(0);

    clock.value = 300;
    source.push('TED"}\n\n');
    await settle();
    expect(h.frames().map((f) => f.tMs)).toEqual([200]);

    clock.value = 400;
    source.push(`data: ${TEXT_START}\n\ndata: ${TEXT_END}\n\n`);
    source.close();
    await settle();
    expect(h.frames().map((f) => f.tMs)).toEqual([200, 300, 400]);
  });

  it('stamps conn-open with the time the request was issued', async () => {
    const clock = { value: 5 };
    const h = harness(
      () => {
        clock.value = 900;
        return Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`])));
      },
      { now: (): number => clock.value },
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.tMs).toBe(5);
  });
});

describe('installFetchPatch — a real run, byte-split at hostile boundaries', () => {
  /** The golden fixture the core pipeline is already tested against. */
  function fixtureEvents(): unknown[] {
    // `new URL(..., import.meta.url)` would build a jsdom URL, which `node:fs` rejects
    // because it is not an instance of Node's own URL class. Use a plain path.
    const text = readFileSync(
      join(import.meta.dirname, '../test/fixtures/happy-run.agui.jsonl'),
      'utf8',
    );
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && 'event' in parsed) {
        events.push((parsed as { event: unknown }).event);
      }
    }
    return events;
  }

  it('recovers every event of happy-run.agui.jsonl from a 7-byte-chunked stream', async () => {
    const events = fixtureEvents();
    const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));

    const h = harness(() =>
      Promise.resolve(
        sseResponse(
          new ReadableStream<Uint8Array>({
            start(c): void {
              for (const chunk of chunks) c.enqueue(chunk);
              c.close();
            },
          }),
        ),
      ),
    );
    await h.host.fetch('http://localhost:3000/api/copilotkit/agent/default/run', {
      method: 'POST',
      body: '{"threadId":"t_happy"}',
    });
    await settle();

    expect(events.length).toBeGreaterThan(5);
    expect(h.frames().map((f) => JSON.parse(f.raw) as unknown)).toEqual(events);
    expect(h.patch.classificationOf('c1')).toBe('agui');
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
  });

  it('reassembles a multi-byte character split across two chunks', async () => {
    const payload = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"héllo 🌍"}';
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    const split = bytes.length - 4; // lands inside the 4-byte emoji
    const h = harness(() =>
      Promise.resolve(
        sseResponse(
          new ReadableStream<Uint8Array>({
            start(c): void {
              c.enqueue(bytes.subarray(0, split));
              c.enqueue(bytes.subarray(split));
              c.close();
            },
          }),
        ),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual([payload]);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm vitest run src/inject/fetch-patch.test.ts`

Expected: FAIL with `Error: Failed to resolve import "./fetch-patch" from
"src/inject/fetch-patch.test.ts". Does the file exist?`

- [ ] **Step 9: Write the implementation**

`packages/devtools/src/inject/fetch-patch.ts`:

```ts
/**
 * `window.fetch` capture (requirements §5.1).
 *
 * AG-UI's client POSTs with `Accept: text/event-stream` (verified fact 5), so this is the
 * path that matters — `chrome.debugger`'s `Network.eventSourceMessageReceived` never sees it,
 * which is the whole reason a MAIN-world patch exists (spec §3).
 *
 * Non-negotiables from requirements §11 and §15, each pinned by a test:
 *   - the original `fetch` reference is taken before patching and used on every path;
 *   - page behaviour is preserved on every path, including errors and non-stream responses;
 *   - the parse branch of `tee()` drains eagerly and never awaits delivery — a lagging
 *     branch makes `tee()` buffer without bound and stalls the page;
 *   - nothing here evaluates page data, and nothing thrown by the relay reaches page code.
 */

import {
  classifyContentType,
  createConnClassifier,
  type Classification,
} from '../core/detect/classifier';
import { createSseParser, type SseFrame } from '../core/sse/parser';
import {
  AGUI_DT_SOURCE,
  PROTOCOL_VERSION,
  type InjectMessage,
  type WireFrame,
} from './protocol';

/** The object whose `fetch` is replaced. `window` satisfies it; tests pass a stand-in. */
export interface FetchHost {
  fetch: typeof fetch;
}

export interface FetchPatchOptions {
  /** Delivery to the relay. Called synchronously; may throw — it is caught here. */
  post(message: InjectMessage): void;
  /** Monotonic clock. Defaults to `performance.now()` (requirements §5.5). */
  now?(): number;
  /** Batch scheduler. Defaults to `queueMicrotask` (requirements §5.1). */
  schedule?(task: () => void): void;
  /** Connection id factory. Defaults to a counter plus random suffix. */
  newConnId?(): string;
}

export interface FetchPatch {
  /** Restores the original `fetch`, unless the page patched over us in the meantime. */
  uninstall(): void;
  /**
   * Content classification for a connection (spec §4.1: two AG-UI events ⇒ `agui`, one ⇒
   * `provisional`). `InjectMessage` has nowhere to carry this yet, so it is exposed here.
   */
  classificationOf(connId: string): Classification | undefined;
}

type CloseReason = 'complete' | 'error' | 'aborted';

/** Requirements §5.1: a stream request body is recorded, never consumed. */
const UNREADABLE_STREAM_BODY = '[unreadable stream body]';
const UNSUPPORTED_BODY = '[unsupported body]';

/** Bounded so a long-lived page cannot grow this map without limit. */
const MAX_TRACKED_CLASSIFICATIONS = 64;

/**
 * Statuses whose responses are defined to have no body. `new Response(body, { status })`
 * throws a TypeError for these, and `tee()` has already locked the original body by then,
 * so the check has to happen before the tee, not in a catch around it.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? (): number => performance.now()
    : (): number => Date.now();

const defaultSchedule: (task: () => void) => void =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (task: () => void): void => {
        void Promise.resolve().then(task);
      };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * JSON bodies are decoded so the panel gets the `RunAgentInput` as structure rather than as
 * one long string. Only objects and arrays are unwrapped: a bare `"42"` body is more
 * faithfully reported as the string the page actually sent.
 */
function decodeBodyText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : text;
  } catch {
    return text;
  }
}

async function captureBody(body: unknown): Promise<unknown> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return decodeBodyText(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of body) {
      entries.push([
        key,
        typeof value === 'string' ? value : `[file ${value.name}, ${value.size} bytes]`,
      ]);
    }
    return entries;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return decodeBodyText(await body.text());
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    // Reading it would consume the page's request body. Record its existence instead.
    return UNREADABLE_STREAM_BODY;
  }
  return UNSUPPORTED_BODY;
}

function isRequestObject(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (isRequestObject(input)) return input.url;
  return safeString(input);
}

function methodOf(input: unknown, init: RequestInit | undefined): string {
  const raw = init?.method ?? (isRequestObject(input) ? input.method : undefined);
  return typeof raw === 'string' && raw !== '' ? raw.toUpperCase() : 'GET';
}

function signalOf(input: unknown, init: RequestInit | undefined): AbortSignal | undefined {
  const signal = init?.signal ?? (isRequestObject(input) ? input.signal : undefined);
  return signal ?? undefined;
}

interface RequestMeta {
  method: string;
  url: string;
  tMs: number;
  /** Resolves to the captured body. Never rejects. */
  input: Promise<unknown>;
  signal: AbortSignal | undefined;
}

function captureRequestMeta(
  input: unknown,
  init: RequestInit | undefined,
  tMs: number,
): RequestMeta {
  let body: Promise<unknown>;
  if (init && 'body' in init) {
    body = captureBody(init.body);
  } else if (isRequestObject(input) && input.body !== null) {
    // `clone()` tees the request body, so the request the page made is untouched.
    body = Promise.resolve()
      .then(() => input.clone().text())
      .then(decodeBodyText);
  } else {
    body = Promise.resolve(null);
  }
  return {
    method: methodOf(input, init),
    url: urlOf(input),
    tMs,
    input: body.catch((): unknown => UNSUPPORTED_BODY),
    signal: signalOf(input, init),
  };
}

function closeReasonFor(error: unknown, signal: AbortSignal | undefined): CloseReason {
  try {
    if (signal?.aborted === true) return 'aborted';
  } catch {
    /* a hostile signal object is not evidence of an abort */
  }
  try {
    if (isRecord(error) && error.name === 'AbortError') return 'aborted';
  } catch {
    /* likewise for a hostile error */
  }
  return 'error';
}

function defineOwn(target: Response, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, configurable: true, enumerable: false });
  } catch {
    /* a frozen Response is still a usable Response */
  }
}

/**
 * `new Response(body, init)` — the shape requirements §5.1 prescribes — drops `url`,
 * `redirected` and `type`, all of which the page can read. Shadow them with own data
 * properties so the substitution is not observable.
 */
function copyResponse(original: Response, body: ReadableStream<Uint8Array>): Response {
  const copy = new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
  defineOwn(copy, 'url', original.url);
  defineOwn(copy, 'redirected', original.redirected);
  defineOwn(copy, 'type', original.type);
  return copy;
}

export function installFetchPatch(host: FetchHost, options: FetchPatchOptions): FetchPatch {
  // Held before patching (requirements §11) and used on every path below.
  const original = host.fetch;
  const now = options.now ?? defaultNow;
  const schedule = options.schedule ?? defaultSchedule;
  const classifications = new Map<string, Classification>();

  let connCounter = 0;
  const newConnId =
    options.newConnId ??
    ((): string => {
      connCounter += 1;
      return `c${connCounter}-${Math.random().toString(36).slice(2, 10)}`;
    });

  function safePost(message: InjectMessage): void {
    try {
      options.post(message);
    } catch {
      // A failing relay must never surface in page code, and must never stop the drain.
    }
  }

  function remember(connId: string, classification: Classification): void {
    classifications.set(connId, classification);
    if (classifications.size > MAX_TRACKED_CLASSIFICATIONS) {
      const oldest = classifications.keys().next();
      if (oldest.done !== true) classifications.delete(oldest.value);
    }
  }

  interface Conn {
    frame(frame: WireFrame): void;
    observe(data: string): void;
    binary(bytes: number, tMs: number): void;
    close(reason: CloseReason): void;
  }

  function createConn(connId: string, meta: RequestMeta, contentType: string | null): Conn {
    const classifier = createConnClassifier(contentType);
    remember(connId, classifier.current());

    let opened = false;
    let closed = false;
    let flushScheduled = false;
    let queue: WireFrame[] = [];
    let deferredBinary: { bytes: number; tMs: number } | null = null;
    let deferredClose: { reason: CloseReason; tMs: number } | null = null;

    // The response may already be streaming while a Blob body is still being read, so
    // frames queue behind conn-open rather than racing it.
    void meta.input.then(open, () => {
      open(null);
    });

    function open(input: unknown): void {
      if (opened) return;
      opened = true;
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-open',
        connId,
        tMs: meta.tMs,
        method: meta.method,
        url: meta.url,
        contentType,
        input,
      });
      flushNow();
      if (deferredBinary !== null) {
        postBinary(deferredBinary.bytes, deferredBinary.tMs);
        deferredBinary = null;
      }
      if (deferredClose !== null) {
        postClose(deferredClose.reason, deferredClose.tMs);
        deferredClose = null;
      }
    }

    function flushNow(): void {
      if (!opened || queue.length === 0) return;
      const batch = queue;
      queue = [];
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId,
        frames: batch,
      });
    }

    function postBinary(bytes: number, tMs: number): void {
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'binary',
        connId,
        tMs,
        contentType: contentType ?? '',
        bytes,
      });
    }

    function postClose(reason: CloseReason, tMs: number): void {
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-close',
        connId,
        tMs,
        reason,
      });
    }

    return {
      frame(frame: WireFrame): void {
        queue.push(frame);
        if (flushScheduled) return;
        flushScheduled = true;
        schedule(() => {
          flushScheduled = false;
          flushNow();
        });
      },
      observe(data: string): void {
        remember(connId, classifier.observe(data));
      },
      binary(bytes: number, tMs: number): void {
        if (!opened) {
          deferredBinary = { bytes, tMs };
          return;
        }
        postBinary(bytes, tMs);
      },
      close(reason: CloseReason): void {
        if (closed) return;
        closed = true;
        const tMs = now();
        if (!opened) {
          deferredClose = { reason, tMs };
          return;
        }
        // Frames queued for the next microtask must not arrive after the close.
        flushNow();
        postClose(reason, tMs);
      },
    };
  }

  function emit(frames: SseFrame[], startMs: number, chunkMs: number, conn: Conn): void {
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      if (frame === undefined) continue;
      // §5.5: the frame is stamped when its first byte arrived, not when parsing finished.
      // Only the first frame of a chunk can have started earlier than this chunk.
      const tMs = i === 0 ? startMs : chunkMs;
      if (frame.kind === 'event') {
        conn.observe(frame.data);
        conn.frame({ kind: 'event', tMs, raw: frame.data });
      } else {
        conn.frame({ kind: 'keepalive', tMs, raw: `:${frame.comment}\n\n`, comment: frame.comment });
      }
    }
  }

  async function drainSse(
    stream: ReadableStream<Uint8Array>,
    conn: Conn,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    // Arrival time of the oldest byte the parser is still holding.
    let pendingSinceMs: number | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        const tMs = now();
        if (pendingSinceMs === undefined) pendingSinceMs = tMs;
        const text = decoder.decode(value, { stream: true });
        if (text === '') continue;
        const frames = parser.push(text);
        emit(frames, pendingSinceMs, tMs, conn);
        // Anything the parser still holds began inside this chunk at the earliest.
        if (frames.length > 0) pendingSinceMs = tMs;
      }
      const tMs = now();
      const startMs = pendingSinceMs ?? tMs;
      const tail = decoder.decode();
      const frames = tail === '' ? parser.flush() : [...parser.push(tail), ...parser.flush()];
      emit(frames, startMs, tMs, conn);
      conn.close('complete');
    } catch (error) {
      conn.close(closeReasonFor(error, signal));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  async function drainBinary(
    stream: ReadableStream<Uint8Array>,
    conn: Conn,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const reader = stream.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        bytes += value.byteLength;
      }
      // §5.4: protobuf decoding is Phase 3. Report the transport, size and timing so the
      // panel can say "binary transport" instead of showing an empty stream.
      conn.binary(bytes, now());
      conn.close('complete');
    } catch (error) {
      conn.binary(bytes, now());
      conn.close(closeReasonFor(error, signal));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  function observeResponse(response: Response, meta: RequestMeta): Response {
    // Requirements §11: `content-type` is the only header this extension ever reads.
    const contentType = response.headers.get('content-type');
    const transport = classifyContentType(contentType);
    if (transport === 'other') return response;

    const connId = newConnId();
    const conn = createConn(connId, meta, contentType);

    const body = response.body;
    if (body === null || NULL_BODY_STATUSES.has(response.status)) {
      conn.close('complete');
      return response;
    }

    const [toPage, toUs] = body.tee();
    if (transport === 'binary') void drainBinary(toUs, conn, meta.signal);
    else void drainSse(toUs, conn, meta.signal);
    return copyResponse(response, toPage);
  }

  function patched(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args;
    let meta: RequestMeta | null = null;
    try {
      meta = captureRequestMeta(input, init, now());
    } catch {
      meta = null;
    }
    const pending = original.apply(this, args);
    if (meta === null) return pending;
    const captured = meta;
    return pending.then((response) => {
      try {
        return observeResponse(response, captured);
      } catch {
        // Capture must never cost the page its response.
        return response;
      }
    });
  }

  host.fetch = patched;

  return {
    uninstall(): void {
      if (host.fetch === patched) host.fetch = original;
    },
    classificationOf(connId: string): Classification | undefined {
      return classifications.get(connId);
    },
  };
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm vitest run src/inject/fetch-patch.test.ts`

Expected: `Test Files 1 passed (1)`, `Tests 37 passed (37)`.

Then `pnpm typecheck && pnpm lint`.

Sanity-check that the suite is load-bearing before moving on — each of these mutations was run and
produced the named failures:

| Mutation | Failing tests |
|---|---|
| drop `flushNow()` from `close()` | 3, incl. "never delivers frames after conn-close" |
| stamp every frame with the chunk's own time | 1: "stamps a frame when its first byte arrived" |
| `await` the drain before returning the response | 3, by 5 s timeout — the page really does stall |
| skip `tee()` and parse the page's own branch | 5, incl. "hands the page a byte-identical body" |
| return the original `Response` after teeing | 5, same set |
| post `conn-open` immediately with a null input | 9, the whole body-capture group |

- [ ] **Step 11: Commit**

```
git add packages/devtools/src/inject/fetch-patch.ts packages/devtools/src/inject/fetch-patch.test.ts
git commit -m "Capture AG-UI SSE streams by patching fetch in the MAIN world"
```

---

### Task 8: The `document_start` entry point

Installs the marker and the patch, once per window, and posts to the relay. Everything here is
about not being a liability in someone else's page (§11): it never evaluates page data, never
throws into page code, and posts only tagged same-origin messages.

`installInject` takes its window as a parameter so the tests can drive a stand-in; the module then
calls it on the real `window` at import, which is what the content script needs. Both paths are
tested, including one end-to-end case that listens for real `message` events on the jsdom window
and validates each one with `isInjectMessage` — the relay's own check, on the receiving side of a
real postMessage.

Note the file: **`inject.ts`, not `index.ts`** (A28, above). This replaces the stub's body.

**Files:**
- Modify: `packages/devtools/src/inject/inject.ts`
- Modify: `packages/devtools/scripts/verify-build.ts`
- Test: `packages/devtools/src/inject/inject.test.ts`

- [ ] **Step 12: Write the failing test**

`packages/devtools/src/inject/inject.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { installInject, MARKER_VERSION, type InjectHost } from './inject';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, isInjectMessage, type InjectMessage } from './protocol';

const SSE = 'text/event-stream';
const RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}';

function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** jsdom delivers each postMessage on its own task, so one settle() is not enough. */
async function settleUntil(done: () => boolean, turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (done()) return;
    await settle();
  }
}

function sseFetch(): typeof fetch {
  return ((): Promise<Response> =>
    Promise.resolve(
      new Response(`data: ${RUN_STARTED}\n\n`, { status: 200, headers: { 'content-type': SSE } }),
    )) as typeof fetch;
}

interface FakeHost extends InjectHost {
  sent: Array<{ message: unknown; targetOrigin: string }>;
}

function fakeHost(overrides: Partial<InjectHost> = {}): FakeHost {
  const sent: Array<{ message: unknown; targetOrigin: string }> = [];
  return {
    sent,
    fetch: sseFetch(),
    location: { origin: 'http://localhost:3000' },
    postMessage(message: unknown, targetOrigin: string): void {
      sent.push({ message, targetOrigin });
    },
    ...overrides,
  };
}

describe('installInject — the document_start entry', () => {
  it('installs itself on import into a real window', () => {
    expect(window.__AGUI_DEVTOOLS__).toEqual({
      version: MARKER_VERSION,
      protocol: PROTOCOL_VERSION,
      source: AGUI_DT_SOURCE,
    });
  });

  it('is guarded against double injection', () => {
    const host = fakeHost();
    const first = host.fetch;
    expect(installInject(host)).toBe(true);
    const patched = host.fetch;
    expect(patched).not.toBe(first);
    expect(installInject(host)).toBe(false);
    expect(host.fetch).toBe(patched);
    expect(installInject(window)).toBe(false);
  });

  it('posts tagged, same-origin messages the relay guard accepts', async () => {
    const host = fakeHost();
    installInject(host);
    await host.fetch('http://localhost:3000/api/copilotkit/agent/default/run', {
      method: 'POST',
      body: '{"threadId":"t_1"}',
    });
    await settle();

    expect(host.sent.length).toBeGreaterThan(0);
    for (const { message, targetOrigin } of host.sent) {
      expect(targetOrigin).toBe('http://localhost:3000');
      expect(isInjectMessage(message)).toBe(true);
    }
    const kinds = host.sent.map((entry) => (entry.message as InjectMessage).kind);
    expect(kinds).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('never throws into page code when postMessage throws', async () => {
    const host = fakeHost({
      postMessage(): void {
        throw new DOMException('Invalid target origin', 'SyntaxError');
      },
    });
    expect(installInject(host)).toBe(true);
    const response = await host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(await response.text()).toBe(`data: ${RUN_STARTED}\n\n`);
  });

  it('returns false instead of throwing when the host is hostile', () => {
    const hostile = {
      get fetch(): never {
        throw new Error('boom');
      },
      location: { origin: 'http://localhost:3000' },
      postMessage(): void {},
    } as unknown as InjectHost;
    expect(installInject(hostile)).toBe(false);
  });

  it('leaves a page that never opens a stream completely untouched', async () => {
    const plain = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const host = fakeHost({ fetch: ((): Promise<Response> => Promise.resolve(plain)) as typeof fetch });
    installInject(host);
    const got = await host.fetch('http://localhost:3000/api');
    await settle();
    expect(got).toBe(plain);
    expect(host.sent).toEqual([]);
  });
});

describe('installInject — on the real window', () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('delivers messages a same-origin listener can validate', async () => {
    const received: unknown[] = [];
    const listener = (event: MessageEvent): void => {
      received.push(event.data);
    };
    window.addEventListener('message', listener);
    window.fetch = sseFetch();
    delete window.__AGUI_DEVTOOLS__;
    expect(installInject(window)).toBe(true);

    await window.fetch('http://localhost:3000/run', { method: 'POST', body: '{"threadId":"t_1"}' });
    await settleUntil(() => received.length === 3);
    window.removeEventListener('message', listener);

    expect(received.length).toBe(3);
    expect(received.every(isInjectMessage)).toBe(true);
    const open = received[0];
    if (!isInjectMessage(open) || open.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_1' });
    expect(open.contentType).toBe(SSE);
  });
});
```

- [ ] **Step 13: Run test to verify it fails**

Run: `pnpm vitest run src/inject/inject.test.ts`

Expected: FAIL, 7 of 7, headlined by `TypeError: installInject is not a function` — the stub
exports only `AguiDevtoolsMarker`. The first case fails differently, with
`AssertionError: expected { version: '0.1.0' } to deeply equal { version: undefined, …(2) }`,
because `MARKER_VERSION` is not exported yet either.

- [ ] **Step 14: Write the implementation**

`packages/devtools/src/inject/inject.ts`, replacing the stub in full:

```ts
/**
 * MAIN-world entry point, injected at `document_start` (requirements §12 manifest).
 *
 * This file is the manifest entry and its basename is load-bearing: CRXJS keys emitted
 * scripts by basename, and an `index.ts` here would collide with `src/sw/index.ts` and
 * silently point the content script at the service worker chunk. See the comment in
 * `manifest.config.ts` before renaming anything.
 *
 * The MAIN-world script is a supply-chain surface in someone else's page (requirements
 * §11): it patches `fetch` only, holds the original reference before patching, preserves
 * page behaviour on every path, never evaluates page data, and never throws into page code.
 */

import { installFetchPatch, type FetchHost } from './fetch-patch';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage } from './protocol';

export interface AguiDevtoolsMarker {
  /** Extension version, so a page-side hook can reason about capability. */
  version: string;
  /** postMessage protocol version, so the relay and a page hook agree on the shape. */
  protocol: number;
  /** The tag on every message this script posts. */
  source: string;
}

declare global {
  interface Window {
    __AGUI_DEVTOOLS__?: AguiDevtoolsMarker;
  }
}

/** What `installInject` needs from a window. `window` satisfies it; tests pass a stand-in. */
export interface InjectHost extends FetchHost {
  postMessage(message: unknown, targetOrigin: string): void;
  readonly location: { readonly origin: string };
  __AGUI_DEVTOOLS__?: AguiDevtoolsMarker;
}

export const MARKER_VERSION = '0.1.0';

/**
 * Install the marker and the capture patch. Returns `false` when this window already has
 * them — the manifest injects into every frame and a page can be re-injected (bfcache
 * restore, `chrome.scripting.registerContentScripts` after an origin is granted at runtime
 * per requirements §12), and patching twice would double every captured frame.
 *
 * Never throws: a document_start script that throws is a broken page.
 */
export function installInject(host: InjectHost): boolean {
  try {
    if (host.__AGUI_DEVTOOLS__ !== undefined) return false;
    host.__AGUI_DEVTOOLS__ = {
      version: MARKER_VERSION,
      protocol: PROTOCOL_VERSION,
      source: AGUI_DT_SOURCE,
    };
    // Read once, at install time, so a page that later rewrites `location` cannot retarget
    // our messages at another origin.
    const targetOrigin = host.location.origin;
    installFetchPatch(host, {
      post(message: InjectMessage): void {
        try {
          host.postMessage(message, targetOrigin);
        } catch {
          // An opaque-origin document ("null") or a page that replaced postMessage. The
          // capture is lost; the page is not.
        }
      },
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined') {
  installInject(window);
}
```

- [ ] **Step 15: Run test to verify it passes**

Run: `pnpm vitest run src/inject/inject.test.ts`

Expected: `Test Files 1 passed (1)`, `Tests 7 passed (7)`.

Then the whole inject project: `pnpm vitest run --project inject`
→ `Test Files 3 passed (3)`, `Tests 71 passed (71)`.

- [ ] **Step 16: Re-run the build gate A30 added, and correct its stale comment**

`scripts/verify-build.ts` resolves each content script through `dist/manifest.json` and asserts the
chunk it points at really is that script's code — the guard added after the silent basename
collision. Its MAIN-world comment ("The presence marker is the entire observable behaviour of
src/inject/inject.ts today") is now false. Correct it, and leave the `required` list alone:

```ts
      // The presence marker. `checkEntry` requires every token to appear verbatim in the entry
      // SOURCE file as well as the bundle, so the capture layer cannot be asserted from here:
      // inject.ts reaches the message tag through the `AGUI_DT_SOURCE` identifier, and
      // identifiers do not survive minification. The literal is asserted on the relay entry,
      // whose own source contains it.
      required: ['__AGUI_DEVTOOLS__'],
```

Run: `pnpm build && pnpm verify:build`

Expected: the build succeeds and every `verify:build` check passes. The MAIN-world chunk now
carries the whole capture layer and still contains no `chrome.runtime`, because nothing under
`src/inject/**` imports `chrome`.

- [ ] **Step 17: Commit**

```
git add packages/devtools/src/inject/inject.ts packages/devtools/src/inject/inject.test.ts packages/devtools/scripts/verify-build.ts
git commit -m "Install the fetch capture patch at document_start and post to the relay"
```

Full gate before handing off, from the repo root:
`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm verify:build`.


---

# Capture plan — section D: Tasks 9–10

`inject/` XHR + EventSource capture, and the ISOLATED-world relay.

Every block below was written into
`scratchpad/verify-cap-D/`, compiled with the repo's `tsconfig.base.json` settings
(`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), linted with the repo's
`eslint.config.js`, and run under Vitest 4 in jsdom. Result: **83 tests, 3 files, all passing;
`tsc --noEmit` clean; `eslint` clean.** The code here is that code verbatim, not a sketch of it.

## What this section depends on

| Needs | From | Used for |
|---|---|---|
| `src/inject/protocol.ts` — `AGUI_DT_SOURCE`, `PROTOCOL_VERSION`, `InjectMessage`, `WireFrame`, `isInjectMessage` | earlier capture task | all three files |
| `src/sw/protocol.ts` — `RELAY_PORT_NAME`, `RelayMessage` | SW task | Task 10 |
| `src/core/sse/parser.ts` — `createSseParser` | shipped, unchanged | Task 9a only |

Two of those have to be right before Task 10 typechecks; both are written up under
**Contract gaps** at the end of this file. Read that section before starting Task 10.

Both patch modules take their collaborators as arguments (`post`, `now`, `nextConnId`, and the
object being patched) rather than reaching for `window` themselves. That is what makes them
testable without a network, and it is how the `inject.ts` entry point wires all three patches to
one batching sink and one `performance.now()` clock.

---

### Task 9a: `XMLHttpRequest` capture (§5.2)

**Files:**
- Create: `packages/devtools/src/inject/xhr-patch.ts`
- Test: `packages/devtools/src/inject/xhr-patch.test.ts`
- Modify: `packages/devtools/vitest.config.ts`

- [ ] **Step 1: Write the failing test**

First give the new directories a Vitest project. `src/inject/**` and `src/relay/**` match no
existing `include`, so without this the test file below is silently never run — the failure mode
this repo has already been bitten by once. Idempotent: if an earlier capture task already added
the `capture` project, this file is already correct and nothing changes.

`packages/devtools/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

/**
 * Three projects, because the three halves of this package have incompatible environments.
 *
 * `core/` is deliberately Chrome-free and DOM-free (design §3 / D10, enforced by the
 * `no-restricted-globals` fence in eslint.config.js) and must keep running under plain `node` —
 * running it in jsdom would silently make `document` and `window` available and let the fence rot.
 * `panel/` renders Preact and needs a DOM, so it gets jsdom plus a setup file.
 * `capture/` is `inject/`, `relay/` and `sw/`: they patch DOM globals and talk to `chrome`, so
 * they need jsdom, but they must NOT get the panel's setup file — the relay is a security
 * boundary and each of its tests installs the exact `chrome` stub it wants to assert against.
 *
 * `test.projects` is the Vitest 4 API (`InlineConfig.projects?: TestProjectConfiguration[]`);
 * each entry is itself a config object with its own nested `test` block.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          // `src/test/` holds the cross-module integration + golden-fixture suite. It imports only
          // from core/ and is Node-only, so it belongs to this project despite living outside
          // `src/core/`; without the second glob its 5 tests would stop running entirely.
          include: ['src/core/**/*.test.ts', 'src/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'panel',
          environment: 'jsdom',
          include: ['src/panel/**/*.test.{ts,tsx}'],
          setupFiles: ['src/panel/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'capture',
          environment: 'jsdom',
          include: ['src/{inject,relay,sw}/**/*.test.ts'],
        },
      },
    ],
  },
});
```

`packages/devtools/src/inject/xhr-patch.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';

import { isInjectMessage, type InjectMessage } from './protocol';
import { installXhrPatch } from './xhr-patch';

/**
 * A fake `XMLHttpRequest`. jsdom's real one cannot be driven through `readyState === 3` without a
 * server, and the whole point of §5.2 is what happens on that transition.
 */
class FakeXhr extends EventTarget {
  readyState = 0;
  responseText = '';
  response: unknown = '';
  status = 0;
  responseType: XMLHttpRequestResponseType = '';

  readonly openCalls: unknown[][] = [];
  readonly sendCalls: unknown[] = [];
  readonly headers = new Map<string, string>();

  open(...args: unknown[]): void {
    this.openCalls.push(args);
    this.readyState = 1;
  }

  send(body?: unknown): void {
    this.sendCalls.push(body);
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  // --- test drivers, not part of the XHR API ---

  headersReceived(contentType: string | null): void {
    if (contentType !== null) this.headers.set('content-type', contentType);
    this.status = 200;
    this.readyState = 2;
    this.dispatchEvent(new Event('readystatechange'));
  }

  chunk(text: string): void {
    this.responseText += text;
    this.response = this.responseText;
    this.readyState = 3;
    this.dispatchEvent(new Event('readystatechange'));
  }

  finish(terminal: 'load' | 'error' | 'abort' | 'timeout' = 'load'): void {
    this.readyState = 4;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new Event(terminal));
    this.dispatchEvent(new Event('loadend'));
  }
}

interface Harness {
  readonly posted: InjectMessage[];
  uninstall: () => void;
  create: () => FakeXhr;
}

let active: Harness | null = null;

function setup(): Harness {
  const posted: InjectMessage[] = [];
  let tick = 0;
  let conn = 0;
  const uninstall = installXhrPatch({
    target: FakeXhr,
    post: (message) => {
      posted.push(message);
    },
    now: () => {
      tick += 10;
      return tick;
    },
    nextConnId: () => `c${(conn += 1)}`,
  });
  const harness: Harness = { posted, uninstall, create: () => new FakeXhr() };
  active = harness;
  return harness;
}

function kinds(posted: InjectMessage[]): string[] {
  return posted.map((message) => message.kind);
}

function framesOf(posted: InjectMessage[]): string[] {
  const out: string[] = [];
  for (const message of posted) {
    if (message.kind === 'frames') for (const frame of message.frames) out.push(frame.raw);
  }
  return out;
}

const SSE = 'text/event-stream';

afterEach(() => {
  active?.uninstall();
  active = null;
});

describe('installXhrPatch — behaviour preservation', () => {
  it('forwards open and send arguments to the originals', () => {
    const { create } = setup();
    const xhr = create();
    xhr.open('POST', '/api/agent/run', true, null, null);
    xhr.send('{"threadId":"t1"}');

    expect(xhr.openCalls).toEqual([['POST', '/api/agent/run', true, null, null]]);
    expect(xhr.sendCalls).toEqual(['{"threadId":"t1"}']);
  });

  it('restores the original open and send on uninstall', () => {
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    const { uninstall } = setup();
    expect(FakeXhr.prototype.open).not.toBe(originalOpen);
    uninstall();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
  });

  it('survives a post that throws', () => {
    const posted: InjectMessage[] = [];
    const uninstall = installXhrPatch({
      target: FakeXhr,
      post: (message) => {
        posted.push(message);
        throw new Error('relay exploded');
      },
      now: () => 1,
      nextConnId: () => 'c1',
    });
    active = { posted, uninstall, create: () => new FakeXhr() };

    const xhr = new FakeXhr();
    expect(() => {
      xhr.open('POST', '/run');
      xhr.send(null);
      xhr.headersReceived(SSE);
      xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
      xhr.finish();
    }).not.toThrow();
    expect(posted.length).toBeGreaterThan(0);
  });

  it('ignores an XHR that was never opened through the patch', () => {
    const { posted } = setup();
    const xhr = new FakeXhr();
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.finish();
    expect(posted).toEqual([]);
  });
});

describe('installXhrPatch — stream candidates', () => {
  it('reports nothing for a non-stream response', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('GET', '/api/info');
    xhr.send(null);
    xhr.headersReceived('application/json');
    xhr.chunk('{"agents":[]}');
    xhr.finish();
    expect(posted).toEqual([]);
  });

  it('reports nothing when the response carries no content-type', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('GET', '/api/info');
    xhr.send(null);
    xhr.headersReceived(null);
    xhr.finish();
    expect(posted).toEqual([]);
  });

  it('opens a connection with the parsed request body as input', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', 'https://example.test/agent/run');
    xhr.send('{"threadId":"t1","runId":"r1","messages":[]}');
    xhr.headersReceived('text/event-stream; charset=utf-8');

    const [open] = posted;
    expect(open?.kind).toBe('conn-open');
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.connId).toBe('c1');
    expect(open.method).toBe('POST');
    expect(open.url).toBe('https://example.test/agent/run');
    expect(open.contentType).toBe('text/event-stream; charset=utf-8');
    expect(open.input).toEqual({ threadId: 't1', runId: 'r1', messages: [] });
  });

  it('keeps a non-JSON body verbatim and a URLSearchParams body as fields', () => {
    const { posted, create } = setup();
    const a = create();
    a.open('POST', '/run');
    a.send('not json');
    a.headersReceived(SSE);

    const b = create();
    b.open('POST', '/run');
    b.send(new URLSearchParams({ threadId: 't2' }));
    b.headersReceived(SSE);

    const opens = posted.filter((message) => message.kind === 'conn-open');
    expect(opens[0]?.kind === 'conn-open' && opens[0].input).toBe('not json');
    expect(opens[1]?.kind === 'conn-open' && opens[1].input).toEqual({ threadId: 't2' });
  });
});

describe('installXhrPatch — readyState 3 slicing (§5.2)', () => {
  it('slices only the newly arrived text on each LOADING event', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);

    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.chunk('data: {"type":"TEXT_MESSAGE_START"}\n\n');

    const frameMessages = posted.filter((message) => message.kind === 'frames');
    expect(frameMessages).toHaveLength(2);
    expect(framesOf(posted)).toEqual([
      'data: {"type":"RUN_STARTED"}\n',
      'data: {"type":"TEXT_MESSAGE_START"}\n',
    ]);
  });

  it('carries a frame across a chunk boundary that splits it mid-line', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);

    xhr.chunk('data: {"type":"TEXT_MESS');
    expect(posted.filter((message) => message.kind === 'frames')).toHaveLength(0);
    xhr.chunk('AGE_CONTENT","delta":"hi"}\n\n');

    expect(framesOf(posted)).toEqual(['data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}\n']);
  });

  it('records keepalive comments as keepalive frames', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk(': ping\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    xhr.finish();

    const frames = posted.flatMap((message) => (message.kind === 'frames' ? message.frames : []));
    expect(frames[0]).toEqual({ kind: 'keepalive', tMs: expect.any(Number), raw: ':ping\n', comment: 'ping' });
    expect(frames[1]?.kind).toBe('event');
  });

  it('preserves event name, id and multi-line data in the reconstructed frame text', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('event: message\nid: 7\ndata: {"a":1,\ndata: "b":2}\n\n');

    expect(framesOf(posted)).toEqual(['event: message\nid: 7\ndata: {"a":1,\ndata: "b":2}\n']);
  });

  it('gives every frame from one slice the same timestamp — the §5.2 fidelity limit', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"A"}\n\ndata: {"type":"B"}\n\n');

    const frames = posted.flatMap((message) => (message.kind === 'frames' ? message.frames : []));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.tMs).toBe(frames[1]?.tMs);
  });

  it('flushes a body whose last frame has no trailing blank line', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_FINISHED"}');
    expect(framesOf(posted)).toEqual([]);
    xhr.finish();

    expect(framesOf(posted)).toEqual(['data: {"type":"RUN_FINISHED"}\n']);
    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('emits no frames message for a slice that completes no frame', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"parti');
    expect(posted.filter((message) => message.kind === 'frames')).toEqual([]);
  });
});

describe('installXhrPatch — close reasons', () => {
  it('closes complete on load', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.finish('load');

    const close = posted.at(-1);
    expect(close?.kind === 'conn-close' && close.reason).toBe('complete');
  });

  it('closes aborted on abort, not complete', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.finish('abort');

    const closes = posted.filter((message) => message.kind === 'conn-close');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.kind === 'conn-close' && closes[0].reason).toBe('aborted');
  });

  it('closes error on error and on timeout', () => {
    const { posted, create } = setup();
    const a = create();
    a.open('POST', '/run');
    a.send(null);
    a.headersReceived(SSE);
    a.finish('error');

    const b = create();
    b.open('POST', '/run');
    b.send(null);
    b.headersReceived(SSE);
    b.finish('timeout');

    const closes = posted.filter((message) => message.kind === 'conn-close');
    expect(closes.map((message) => (message.kind === 'conn-close' ? message.reason : ''))).toEqual([
      'error',
      'error',
    ]);
  });

  it('never closes a connection it never opened', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('GET', '/api/info');
    xhr.send(null);
    xhr.headersReceived('application/json');
    xhr.finish('error');
    expect(posted).toEqual([]);
  });
});

describe('installXhrPatch — binary transport (§5.4)', () => {
  it('reports protobuf responses as bytes, never as frames', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.responseType = 'arraybuffer';
    xhr.headersReceived('application/vnd.ag-ui.event+proto');
    xhr.response = new ArrayBuffer(128);
    xhr.finish();

    expect(kinds(posted)).toEqual(['conn-open', 'binary', 'conn-close']);
    const binary = posted[1];
    expect(binary?.kind === 'binary' && binary.bytes).toBe(128);
    expect(binary?.kind === 'binary' && binary.contentType).toBe('application/vnd.ag-ui.event+proto');
  });

  it('reports an event stream the page requested as a Blob as bytes rather than silence', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.responseType = 'blob';
    xhr.headersReceived(SSE);
    xhr.response = new Blob(['data: {"type":"RUN_STARTED"}\n\n']);
    xhr.finish();

    expect(kinds(posted)).toEqual(['conn-open', 'binary', 'conn-close']);
  });
});

describe('installXhrPatch — reuse and protocol shape', () => {
  it('gives a reopened XHR a fresh connection id', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.finish();

    xhr.responseText = '';
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.finish();

    const ids = new Set(posted.map((message) => message.connId));
    expect(ids).toEqual(new Set(['c1', 'c2']));
  });

  it('does not let the retired listeners of a reopened XHR capture the second response', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"A"}\n\n');
    xhr.finish();

    // A real XHR clears responseText on the next request; the second body is longer than the
    // first, which is what would tempt the retired record's offset into slicing it again.
    xhr.responseText = '';
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"B"}\n\ndata: {"type":"C"}\n\ndata: {"type":"D"}\n\n');
    xhr.finish();

    const perConn = posted.reduce<Record<string, string[]>>((acc, message) => {
      (acc[message.connId] ??= []).push(message.kind);
      return acc;
    }, {});
    expect(perConn.c1).toEqual(['conn-open', 'frames', 'conn-close']);
    expect(perConn.c2).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('emits only messages the relay guard accepts', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send('{"threadId":"t1"}');
    xhr.headersReceived(SSE);
    xhr.chunk(': ping\n\ndata: {"type":"RUN_STARTED"}\n\n');
    xhr.finish();

    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    for (const message of posted) expect(isInjectMessage(message)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/devtools`): `pnpm vitest run src/inject/xhr-patch.test.ts`

Expected: FAIL with
`Error: Failed to resolve import "./xhr-patch" from "src/inject/xhr-patch.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

`packages/devtools/src/inject/xhr-patch.ts`:

```ts
/**
 * `XMLHttpRequest` capture — requirements §5.2.
 *
 * TIMING FIDELITY, stated rather than absorbed: `fetch` (§5.1) tees the response body and sees
 * every chunk as the network delivers it, so a frame's `tMs` is the arrival time of its first
 * byte (§5.5). XHR has no such hook. The only incremental view is `readyState === 3`
 * (`LOADING`), which the browser fires when it has appended *some* text to `responseText` —
 * coalescing several network chunks into one event, on its own schedule. So every frame decoded
 * out of one `readyState === 3` slice carries the same timestamp: the moment that slice was
 * handed to us, not the moment each frame landed. Inter-frame gaps within a slice read as zero.
 * The §8 metrics built on XHR captures are therefore coarser than the `fetch` ones. §5.2 accepts
 * this ("Lower fidelity on timing than fetch; acceptable") — this comment is here so nobody later
 * reads a flat-looking XHR waterfall as a finding about the server.
 */
import { createSseParser, type SseFrame, type SseParser } from '../core/sse/parser';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage, type WireFrame } from './protocol';

/** The slice of `XMLHttpRequest` this patch touches. Keeps the tests free of a real XHR. */
export interface XhrLike extends EventTarget {
  readonly readyState: number;
  readonly responseText: string;
  readonly response: unknown;
  readonly status: number;
  responseType: XMLHttpRequestResponseType;
  getResponseHeader(name: string): string | null;
}

export interface XhrPrototypeLike extends XhrLike {
  open(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void;
  send(body?: unknown): void;
}

export interface XhrConstructorLike {
  prototype: XhrPrototypeLike;
}

export interface XhrPatchOptions {
  /** The constructor whose prototype gets patched. Production passes `window.XMLHttpRequest`. */
  target: XhrConstructorLike;
  /** Delivery to the relay. Must never throw; this patch guards it anyway. */
  post: (message: InjectMessage) => void;
  /** §5.5 monotonic clock. Production passes `() => performance.now()`. */
  now: () => number;
  nextConnId: () => string;
}

/** Content type that means "protobuf transport, decoding deferred to Phase 3" (§5.4). */
const PROTO_CONTENT_TYPE = 'application/vnd.ag-ui.event+proto';
const SSE_CONTENT_TYPE = 'text/event-stream';

type Mode = 'ignore' | 'sse' | 'binary';

type OpenArgs = Parameters<XhrPrototypeLike['open']>;
type SendArgs = Parameters<XhrPrototypeLike['send']>;

interface ConnState {
  method: string;
  url: string;
  input: unknown;
  connId: string;
  mode: Mode;
  contentType: string | null;
  parser: SseParser | null;
  /** Characters of `responseText` already fed to the parser. */
  offset: number;
  opened: boolean;
  closed: boolean;
  /** True once `open` was called again on the same XHR object; see `patchedOpen`. */
  superseded: boolean;
}

function mediaType(header: string | null): string {
  if (header === null) return '';
  const semi = header.indexOf(';');
  return (semi === -1 ? header : header.slice(0, semi)).trim().toLowerCase();
}

/**
 * `responseText` throws `InvalidStateError` unless `responseType` is `''` or `'text'`, so the
 * incremental path is only available for those two.
 */
function isTextResponseType(responseType: string): boolean {
  return responseType === '' || responseType === 'text';
}

/**
 * §5.1's request-body rules, applied to `send`'s argument. Never reads a `Blob` or a `Document`:
 * both need async or serialization work that would change page timing, and the `RunAgentInput`
 * we actually care about is always a JSON string.
 */
export function snapshotXhrBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of body.entries()) out[key] = typeof value === 'string' ? value : null;
    return out;
  }
  return '[unreadable body]';
}

/** Canonical SSE text for a parsed frame. See the `raw` note in the plan's contract gaps. */
export function frameToWireFrame(frame: SseFrame, tMs: number): WireFrame {
  if (frame.kind === 'keepalive') {
    return { kind: 'keepalive', tMs, raw: `:${frame.comment}\n`, comment: frame.comment };
  }
  const lines: string[] = [];
  if (frame.eventName !== undefined) lines.push(`event: ${frame.eventName}`);
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.retry !== undefined) lines.push(`retry: ${frame.retry}`);
  for (const dataLine of frame.data.split('\n')) lines.push(`data: ${dataLine}`);
  return { kind: 'event', tMs, raw: `${lines.join('\n')}\n` };
}

function byteLength(response: unknown, responseText: string): number {
  if (response instanceof ArrayBuffer) return response.byteLength;
  if (ArrayBuffer.isView(response)) return response.byteLength;
  if (typeof Blob !== 'undefined' && response instanceof Blob) return response.size;
  if (typeof response === 'string') return response.length;
  return responseText.length;
}

/**
 * Patch `open`/`send` on `target.prototype`. Returns an uninstall that restores both originals.
 *
 * Behaviour preservation (§11): originals are captured before anything is replaced, every
 * patched path ends in `Reflect.apply` on the original with the caller's own `this` and
 * arguments, and all capture work runs inside `try`/`catch` so a defect here can never surface
 * as a page-visible XHR failure.
 */
export function installXhrPatch(options: XhrPatchOptions): () => void {
  const { target, post, now, nextConnId } = options;
  const proto = target.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const states = new WeakMap<object, ConnState>();

  function emit(message: InjectMessage): void {
    try {
      post(message);
    } catch {
      // The relay leg is never allowed to break the page.
    }
  }

  function openConn(state: ConnState, contentType: string | null): void {
    if (state.opened) return;
    state.opened = true;
    state.contentType = contentType;
    emit({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-open',
      connId: state.connId,
      tMs: now(),
      method: state.method,
      url: state.url,
      contentType,
      input: state.input,
    });
  }

  function closeConn(state: ConnState, reason: 'complete' | 'error' | 'aborted'): void {
    if (state.superseded || !state.opened || state.closed) return;
    state.closed = true;
    emit({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-close',
      connId: state.connId,
      tMs: now(),
      reason,
    });
  }

  function drain(xhr: XhrLike, state: ConnState, final: boolean): void {
    const parser = state.parser;
    if (parser === null) return;
    const text = xhr.responseText;
    const chunk = text.length > state.offset ? text.slice(state.offset) : '';
    state.offset = text.length;
    const tMs = now();
    const frames: WireFrame[] = [];
    if (chunk !== '') {
      for (const frame of parser.push(chunk)) frames.push(frameToWireFrame(frame, tMs));
    }
    if (final) {
      for (const frame of parser.flush()) frames.push(frameToWireFrame(frame, tMs));
    }
    if (frames.length === 0) return;
    emit({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: state.connId,
      frames,
    });
  }

  function onHeaders(xhr: XhrLike, state: ConnState): void {
    const header = xhr.getResponseHeader('content-type');
    const type = mediaType(header);
    if (type === PROTO_CONTENT_TYPE) {
      state.mode = 'binary';
      openConn(state, header);
      return;
    }
    if (type !== SSE_CONTENT_TYPE) {
      // Not a stream candidate: this XHR is never reported, not even as a connection.
      state.mode = 'ignore';
      return;
    }
    if (!isTextResponseType(xhr.responseType)) {
      // An event stream the page asked for as a Blob/ArrayBuffer. `responseText` would throw, so
      // report it the way §5.4 reports any undecodable transport — bytes and timing, no frames —
      // rather than opening a connection that silently produces nothing.
      state.mode = 'binary';
      openConn(state, header);
      return;
    }
    state.mode = 'sse';
    state.parser = createSseParser();
    openConn(state, header);
  }

  function onDone(xhr: XhrLike, state: ConnState): void {
    if (state.mode === 'sse') {
      drain(xhr, state, true);
      return;
    }
    if (state.mode === 'binary') {
      const text = isTextResponseType(xhr.responseType) ? xhr.responseText : '';
      emit({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'binary',
        connId: state.connId,
        tMs: now(),
        contentType: state.contentType ?? '',
        bytes: byteLength(xhr.response, text),
      });
    }
  }

  proto.open = function patchedOpen(this: XhrLike, ...args: OpenArgs): void {
    try {
      // An XHR object can be reopened; every `open` starts a fresh connection record. The
      // listeners `send` attached for the previous one are still on the instance and cannot be
      // removed from here, so the retired record is flagged and every handler ignores it —
      // otherwise the second response would be sliced twice, once under each connection id.
      const previous = states.get(this);
      if (previous !== undefined) previous.superseded = true;
      states.set(this, {
        method: String(args[0]),
        url: String(args[1]),
        input: null,
        connId: nextConnId(),
        mode: 'ignore',
        contentType: null,
        parser: null,
        offset: 0,
        opened: false,
        closed: false,
        superseded: false,
      });
    } catch {
      states.delete(this);
    }
    return Reflect.apply(originalOpen, this, args);
  };

  proto.send = function patchedSend(this: XhrLike, ...args: SendArgs): void {
    try {
      const state = states.get(this);
      if (state !== undefined) {
        state.input = snapshotXhrBody(args[0]);
        // Arrow callbacks: `this` stays the XHR instance without aliasing it to a local.
        this.addEventListener('readystatechange', () => {
          try {
            if (state.superseded) return;
            if (this.readyState === 2) onHeaders(this, state);
            else if (this.readyState === 3 && state.mode === 'sse') drain(this, state, false);
            else if (this.readyState === 4) onDone(this, state);
          } catch {
            // Never let capture surface inside the page's own handler chain.
          }
        });
        // Close on the terminal events, not on `readyState === 4`: `abort` and `error` fire
        // *after* that transition, so closing there would label every abort 'complete'.
        this.addEventListener('load', () => {
          closeConn(state, 'complete');
        });
        this.addEventListener('error', () => {
          closeConn(state, 'error');
        });
        this.addEventListener('timeout', () => {
          closeConn(state, 'error');
        });
        this.addEventListener('abort', () => {
          closeConn(state, 'aborted');
        });
      }
    } catch {
      // Fall through to the original send regardless.
    }
    return Reflect.apply(originalSend, this, args);
  };

  return function uninstall(): void {
    proto.open = originalOpen;
    proto.send = originalSend;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/devtools`):

```
pnpm vitest run src/inject/xhr-patch.test.ts
pnpm typecheck
pnpm lint
```

Expected: `Test Files 1 passed (1)`, `Tests 24 passed (24)`; typecheck and lint clean.

- [ ] **Step 5: Commit**

```
git add packages/devtools/vitest.config.ts packages/devtools/src/inject/xhr-patch.ts packages/devtools/src/inject/xhr-patch.test.ts
git commit -m "feat(inject): capture XMLHttpRequest event streams (§5.2)"
```

---

### Task 9b: `EventSource` capture (§5.3)

**Files:**
- Create: `packages/devtools/src/inject/eventsource-patch.ts`
- Test: `packages/devtools/src/inject/eventsource-patch.test.ts`

- [ ] **Step 6: Write the failing test**

`packages/devtools/src/inject/eventsource-patch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isInjectMessage, type InjectMessage } from './protocol';
import {
  installEventSourcePatch,
  type EventSourceConstructorLike,
  type EventSourceScope,
} from './eventsource-patch';

/**
 * A fake `EventSource`. jsdom ships one, but it opens a real connection and gives a test no way
 * to deliver a frame; §5.3 is entirely about what happens when a frame arrives.
 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  closeCalls = 0;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 2;
  }

  // --- test drivers, not part of the EventSource API ---

  deliver(data: string, lastEventId = ''): void {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent('message', { data, lastEventId }));
  }

  deliverNamed(type: string, data: string): void {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent(type, { data }));
  }

  fail(readyState: 0 | 2): void {
    this.readyState = readyState;
    this.dispatchEvent(new Event('error'));
  }
}

interface Harness {
  readonly posted: InjectMessage[];
  readonly scope: EventSourceScope;
  uninstall: () => void;
}

function setup(): Harness {
  const posted: InjectMessage[] = [];
  let tick = 0;
  let conn = 0;
  const scope: EventSourceScope = { EventSource: FakeEventSource };
  const uninstall = installEventSourcePatch({
    scope,
    post: (message) => {
      posted.push(message);
    },
    now: () => {
      tick += 10;
      return tick;
    },
    nextConnId: () => `c${(conn += 1)}`,
  });
  return { posted, scope, uninstall };
}

function kinds(posted: InjectMessage[]): string[] {
  return posted.map((message) => message.kind);
}

describe('installEventSourcePatch — behaviour preservation', () => {
  it('constructs the original with the caller arguments and keeps instanceof working', () => {
    const { scope, uninstall } = setup();
    const source = new scope.EventSource('https://example.test/sse', { withCredentials: true });

    expect(source).toBeInstanceOf(FakeEventSource);
    expect(source.url).toBe('https://example.test/sse');
    expect((source as FakeEventSource).withCredentials).toBe(true);
    uninstall();
  });

  it('delegates close to the original', () => {
    const { scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    source.close();
    expect((source as FakeEventSource).closeCalls).toBe(1);
    uninstall();
  });

  it('restores the original binding on uninstall', () => {
    const { scope, uninstall } = setup();
    expect(scope.EventSource).not.toBe(FakeEventSource);
    uninstall();
    expect(scope.EventSource).toBe(FakeEventSource);
  });

  it('adds no own property a page could enumerate', () => {
    const { scope, uninstall } = setup();
    const plain = new FakeEventSource('/sse');
    const patched = new scope.EventSource('/sse');
    expect(Object.keys(patched as object)).toEqual(Object.keys(plain));
    expect(Reflect.ownKeys(patched as object)).toEqual(Reflect.ownKeys(plain));
    uninstall();
  });

  it('still delivers frames to the page listeners', () => {
    const { scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    const seen: string[] = [];
    source.addEventListener('message', (event) => {
      seen.push(String((event as MessageEvent<unknown>).data));
    });
    (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}');
    expect(seen).toEqual(['{"type":"RUN_STARTED"}']);
    uninstall();
  });

  it('survives a post that throws', () => {
    const posted: InjectMessage[] = [];
    const scope: EventSourceScope = { EventSource: FakeEventSource };
    const uninstall = installEventSourcePatch({
      scope,
      post: (message) => {
        posted.push(message);
        throw new Error('relay exploded');
      },
      now: () => 1,
      nextConnId: () => 'c1',
    });

    expect(() => {
      const source = new scope.EventSource('/sse');
      (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}');
      source.close();
    }).not.toThrow();
    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    uninstall();
  });
});

describe('installEventSourcePatch — capture (§5.3)', () => {
  it('opens a connection at construction with a null input', () => {
    const { posted, scope, uninstall } = setup();
    new scope.EventSource('https://example.test/sse');

    const open = posted[0];
    expect(open?.kind).toBe('conn-open');
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.connId).toBe('c1');
    expect(open.method).toBe('GET');
    expect(open.url).toBe('https://example.test/sse');
    expect(open.contentType).toBe('text/event-stream');
    expect(open.input).toBeNull();
    uninstall();
  });

  it('re-serializes a delivered frame into canonical SSE text', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"RUN_STARTED","threadId":"t1"}');

    const message = posted[1];
    expect(message?.kind).toBe('frames');
    if (message?.kind !== 'frames') throw new Error('expected frames');
    expect(message.connId).toBe('c1');
    expect(message.frames).toEqual([
      { kind: 'event', tMs: expect.any(Number), raw: 'data: {"type":"RUN_STARTED","threadId":"t1"}\n' },
    ]);
    uninstall();
  });

  it('includes the id line only when the browser reports one', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"A"}', '42');
    (source as FakeEventSource).deliver('{"type":"B"}');

    const raws = posted.flatMap((message) =>
      message.kind === 'frames' ? message.frames.map((frame) => frame.raw) : [],
    );
    expect(raws).toEqual(['id: 42\ndata: {"type":"A"}\n', 'data: {"type":"B"}\n']);
    uninstall();
  });

  it('splits multi-line data back into one data line each', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"a":1,\n"b":2}');

    const message = posted[1];
    expect(message?.kind === 'frames' && message.frames[0]?.raw).toBe('data: {"a":1,\ndata: "b":2}\n');
    uninstall();
  });

  it('does not capture named event frames — the documented §5.3 limit', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliverNamed('run', '{"type":"RUN_STARTED"}');

    expect(kinds(posted)).toEqual(['conn-open']);
    uninstall();
  });

  it('closes complete when the page closes the stream', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"RUN_FINISHED"}');
    source.close();
    source.close();

    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    const close = posted[2];
    expect(close?.kind === 'conn-close' && close.reason).toBe('complete');
    uninstall();
  });

  it('ignores a retryable error and closes error once the browser gives up', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).fail(0);
    expect(kinds(posted)).toEqual(['conn-open']);

    (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}');
    (source as FakeEventSource).fail(2);

    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    const close = posted[2];
    expect(close?.kind === 'conn-close' && close.reason).toBe('error');
    uninstall();
  });

  it('gives each EventSource its own connection id', () => {
    const { posted, scope, uninstall } = setup();
    const a = new scope.EventSource('/sse');
    const b = new scope.EventSource('/sse');
    (a as FakeEventSource).deliver('{"type":"A"}');
    (b as FakeEventSource).deliver('{"type":"B"}');

    expect(posted.map((message) => message.connId)).toEqual(['c1', 'c2', 'c1', 'c2']);
    uninstall();
  });

  it('emits only messages the relay guard accepts', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}', '1');
    source.close();

    expect(posted).toHaveLength(3);
    for (const message of posted) expect(isInjectMessage(message)).toBe(true);
    uninstall();
  });

  it('types the real EventSource as a valid patch target', () => {
    // jsdom does not implement `EventSource` at all, which is why every test above drives a fake.
    // The assignment still has to typecheck: production passes `window` as the scope, so
    // `EventSourceConstructorLike` must accept the real constructor.
    const target: EventSourceConstructorLike | null =
      typeof EventSource === 'undefined' ? null : EventSource;
    expect(target === null || typeof target === 'function').toBe(true);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run (from `packages/devtools`): `pnpm vitest run src/inject/eventsource-patch.test.ts`

Expected: FAIL with
`Error: Failed to resolve import "./eventsource-patch" from "src/inject/eventsource-patch.test.ts". Does the file exist?`

- [ ] **Step 8: Write the implementation**

`packages/devtools/src/inject/eventsource-patch.ts`:

```ts
/**
 * `EventSource` capture — requirements §5.3.
 *
 * DIFFERENT CODE PATH, on purpose: `EventSource` frames arrive *already parsed* by the browser.
 * There is no response body to tee and no text to slice, so `core/sse/parser` is not used here at
 * all — the `MessageEvent` hands us `data`, `lastEventId` and the event type, and this module
 * re-serializes them into the canonical frame text `WireFrame.raw` carries. That re-serialization
 * is the only place in the capture layer where `raw` is a reconstruction rather than a copy of
 * what crossed the wire: the browser consumed the wire text before we could see it.
 *
 * Two consequences worth stating rather than absorbing:
 *  - A frame's `tMs` is when the browser *dispatched* the event, not when its first byte landed
 *    (§5.5). Comparable to XHR's fidelity, better than nothing, worse than `fetch`.
 *  - Only the default `message` type is mirrored. A named `event:` frame reaches the page through
 *    `addEventListener('<name>', ...)`, and there is no way to enumerate those names without
 *    wrapping `addEventListener` per instance — extra surface, extra detectability, on a
 *    transport §5.3 already calls rare because `EventSource` cannot send a POST body and AG-UI's
 *    `RunAgentInput` has to go somewhere. Named frames are simply not captured; they are not
 *    silently mislabelled.
 */
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage, type WireFrame } from './protocol';

/** The slice of `EventSource` this patch touches. Keeps the tests free of a real one. */
export interface EventSourceLike extends EventTarget {
  readonly url: string;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSED. */
  readonly readyState: number;
  close(): void;
}

export interface EventSourceConstructorLike {
  new (url: string | URL, init?: EventSourceInit): EventSourceLike;
  readonly prototype: EventSourceLike;
}

/** The object that owns the `EventSource` binding. Production passes `window`. */
export interface EventSourceScope {
  EventSource: EventSourceConstructorLike;
}

export interface EventSourcePatchOptions {
  scope: EventSourceScope;
  post: (message: InjectMessage) => void;
  now: () => number;
  nextConnId: () => string;
}

function isMessageEvent(event: Event): event is MessageEvent<unknown> {
  return 'data' in event;
}

/** Canonical SSE text for a frame the browser already parsed. */
function toRaw(data: string, lastEventId: string): string {
  const lines: string[] = [];
  if (lastEventId !== '') lines.push(`id: ${lastEventId}`);
  for (const dataLine of data.split('\n')) lines.push(`data: ${dataLine}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Replace `scope.EventSource` with a subclass that tees `message` frames. Returns an uninstall
 * that restores the original binding.
 *
 * Behaviour preservation (§11): the original constructor is captured before the binding is
 * replaced, the subclass only ever calls `super(...)` with the caller's own arguments, every
 * listener body is wrapped in `try`/`catch`, and no page-visible property is added to the
 * instance. `instanceof` keeps working because the replacement extends the original.
 */
export function installEventSourcePatch(options: EventSourcePatchOptions): () => void {
  const { scope, post, now, nextConnId } = options;
  const OriginalEventSource = scope.EventSource;
  /**
   * Per-instance close hook. A `WeakMap` rather than a property on the instance: an own property
   * — however obscurely named — is exactly the kind of thing a page can enumerate to detect the
   * extension (§11), and the map keeps the instance shape identical to an unpatched one.
   */
  const closers = new WeakMap<object, (reason: 'complete' | 'error' | 'aborted') => void>();

  function emit(message: InjectMessage): void {
    try {
      post(message);
    } catch {
      // The relay leg is never allowed to break the page.
    }
  }

  class PatchedEventSource extends OriginalEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      const connId = nextConnId();
      let closed = false;

      const close = (reason: 'complete' | 'error' | 'aborted'): void => {
        if (closed) return;
        closed = true;
        emit({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'conn-close',
          connId,
          tMs: now(),
          reason,
        });
      };

      // `EventSource` is `text/event-stream` by definition and cannot carry a request body,
      // which is exactly why §5.3 calls it rare for AG-UI: `input` is honestly null here, and a
      // capture taken over this transport will report `run-started-without-input`.
      emit({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-open',
        connId,
        tMs: now(),
        method: 'GET',
        url: String(url),
        contentType: 'text/event-stream',
        input: null,
      });

      super.addEventListener('message', (event: Event): void => {
        try {
          if (!isMessageEvent(event)) return;
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          const lastEventId = typeof event.lastEventId === 'string' ? event.lastEventId : '';
          const frame: WireFrame = { kind: 'event', tMs: now(), raw: toRaw(data, lastEventId) };
          emit({
            source: AGUI_DT_SOURCE,
            v: PROTOCOL_VERSION,
            kind: 'frames',
            connId,
            frames: [frame],
          });
        } catch {
          // Never surface inside the page's own listener chain.
        }
      });

      super.addEventListener('error', (): void => {
        try {
          // `EventSource` retries on its own; the page keeps the same object. Reporting the
          // connection closed here would strand every frame that arrives after a reconnect, so
          // an error only closes the record once the browser has given up (`CLOSED`).
          if (this.readyState === 2) close('error');
        } catch {
          // Ignored.
        }
      });

      closers.set(this, close);
    }

    override close(): void {
      try {
        closers.get(this)?.('complete');
      } catch {
        // Ignored.
      }
      super.close();
    }
  }

  scope.EventSource = PatchedEventSource;

  return function uninstall(): void {
    scope.EventSource = OriginalEventSource;
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run (from `packages/devtools`):

```
pnpm vitest run src/inject/eventsource-patch.test.ts
pnpm typecheck
pnpm lint
```

Expected: `Test Files 1 passed (1)`, `Tests 16 passed (16)`; typecheck and lint clean.

- [ ] **Step 10: Commit**

```
git add packages/devtools/src/inject/eventsource-patch.ts packages/devtools/src/inject/eventsource-patch.test.ts
git commit -m "feat(inject): capture EventSource streams (§5.3)"
```

---

### Task 10: the ISOLATED-world relay (§3, §11, §15)

**Files:**
- Create: `packages/devtools/src/relay/relay.ts` (replaces the stub of the same name)
- Test: `packages/devtools/src/relay/relay.test.ts`

The file is `relay.ts`, **not** `index.ts`. CRXJS keys content scripts by basename, and two
`index.ts` entries collide silently — this project has already paid for that lesson once.

Before Step 11, confirm `src/sw/protocol.ts` declares `RelayMessage` distributively (see
**Contract gaps** #1). With the contract's literal `Omit<InjectMessage, 'source'>`, Step 13 fails
`pnpm typecheck` with four `TS2353: Object literal may only specify known properties, and 'tMs'
does not exist in type 'RelayMessage'` errors, and no amount of work in `relay.ts` fixes it.

- [ ] **Step 11: Write the failing test**

`packages/devtools/src/relay/relay.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGUI_DT_SOURCE, PROTOCOL_VERSION } from '../inject/protocol';
import { RELAY_PORT_NAME } from '../sw/protocol';

/** A `chrome.runtime.Port` double: records what the relay sent and can fail on demand. */
interface FakePort {
  readonly name: string;
  readonly posted: unknown[];
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onDisconnect: { addListener: (listener: () => void) => void };
  /** Fail the next N `postMessage` calls, as a dead port does. */
  failPosts: number;
  /** Fire the disconnect listeners, as MV3 does when the worker is terminated (§15). */
  killFromServiceWorker: () => void;
}

interface ChromeHarness {
  readonly ports: FakePort[];
  readonly connectNames: string[];
  /** Make the next `connect` throw, as an invalidated extension context does. */
  connectThrows: number;
}

function installChrome(): ChromeHarness {
  const harness: ChromeHarness = { ports: [], connectNames: [], connectThrows: 0 };

  const connect = (info: { name: string }): FakePort => {
    harness.connectNames.push(info.name);
    if (harness.connectThrows > 0) {
      harness.connectThrows -= 1;
      throw new Error('Extension context invalidated.');
    }
    const listeners = new Set<() => void>();
    const port: FakePort = {
      name: info.name,
      posted: [],
      failPosts: 0,
      postMessage: (message: unknown): void => {
        if (port.failPosts > 0) {
          port.failPosts -= 1;
          throw new Error('Attempting to use a disconnected port object');
        }
        port.posted.push(message);
      },
      disconnect: (): void => {
        for (const listener of [...listeners]) listener();
      },
      onDisconnect: {
        addListener: (listener: () => void): void => {
          listeners.add(listener);
        },
      },
      killFromServiceWorker: (): void => {
        for (const listener of [...listeners]) listener();
      },
    };
    harness.ports.push(port);
    return port;
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { connect, lastError: undefined },
  };
  return harness;
}

let messageListener: EventListener | null = null;

/** Load a fresh copy of the relay and remember the listener it registered. */
async function loadRelay(): Promise<void> {
  const spy = vi.spyOn(window, 'addEventListener');
  vi.resetModules();
  await import('./relay');
  const call = spy.mock.calls.find(([type]) => type === 'message');
  const listener = call?.[1];
  if (typeof listener !== 'function') throw new Error('relay registered no message listener');
  messageListener = listener as EventListener;
  spy.mockRestore();
}

/** Dispatch a real `message` event, with any part of it under the test's control. */
function post(data: unknown, overrides: { origin?: string; source?: unknown } = {}): void {
  const event = new MessageEvent('message', {
    data,
    origin: overrides.origin ?? window.location.origin,
  });
  Object.defineProperty(event, 'source', {
    value: 'source' in overrides ? overrides.source : window,
    configurable: true,
  });
  window.dispatchEvent(event);
}

function validOpen(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: AGUI_DT_SOURCE,
    v: PROTOCOL_VERSION,
    kind: 'conn-open',
    connId: 'c1',
    tMs: 12.5,
    method: 'POST',
    url: 'https://example.test/agent/run',
    contentType: 'text/event-stream',
    input: { threadId: 't1' },
    ...extra,
  };
}

function delivered(harness: ChromeHarness): unknown[] {
  return harness.ports.flatMap((port) => port.posted);
}

let chromeHarness: ChromeHarness;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(async () => {
  chromeHarness = installChrome();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  await loadRelay();
});

afterEach(() => {
  if (messageListener !== null) window.removeEventListener('message', messageListener);
  messageListener = null;
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies = [];
  Reflect.deleteProperty(globalThis, 'chrome');
});

function expectSilent(): void {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
}

describe('relay — forwarding', () => {
  it('connects with the contract port name on the first valid message', () => {
    post(validOpen());
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
  });

  it('opens no port at all for a page that never posts a valid message', () => {
    post('hello');
    post({ source: 'other-extension', v: 1, kind: 'conn-close' });
    post(validOpen(), { origin: 'https://evil.example' });
    expect(chromeHarness.connectNames).toEqual([]);
    expect(chromeHarness.ports).toEqual([]);
  });

  it('reuses one port across many messages', () => {
    post(validOpen());
    post(validOpen({ connId: 'c2' }));
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
    expect(chromeHarness.ports).toHaveLength(1);
    expect(chromeHarness.ports[0]?.posted).toHaveLength(2);
  });

  it('forwards conn-open without the source tag', () => {
    post(validOpen());
    expect(delivered(chromeHarness)).toEqual([
      {
        v: 1,
        kind: 'conn-open',
        connId: 'c1',
        tMs: 12.5,
        method: 'POST',
        url: 'https://example.test/agent/run',
        contentType: 'text/event-stream',
        input: { threadId: 't1' },
      },
    ]);
  });

  it('forwards both frame kinds', () => {
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: 'c1',
      frames: [
        { kind: 'event', tMs: 1, raw: 'data: {"type":"RUN_STARTED"}\n' },
        { kind: 'keepalive', tMs: 2, raw: ':ping\n', comment: 'ping' },
      ],
    });
    expect(delivered(chromeHarness)).toEqual([
      {
        v: 1,
        kind: 'frames',
        connId: 'c1',
        frames: [
          { kind: 'event', tMs: 1, raw: 'data: {"type":"RUN_STARTED"}\n' },
          { kind: 'keepalive', tMs: 2, raw: ':ping\n', comment: 'ping' },
        ],
      },
    ]);
  });

  it('forwards conn-close and binary', () => {
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-close',
      connId: 'c1',
      tMs: 3,
      reason: 'aborted',
    });
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'binary',
      connId: 'c2',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 64,
    });
    expect(delivered(chromeHarness)).toEqual([
      { v: 1, kind: 'conn-close', connId: 'c1', tMs: 3, reason: 'aborted' },
      {
        v: 1,
        kind: 'binary',
        connId: 'c2',
        tMs: 4,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 64,
      },
    ]);
  });

  it('drops properties the contract does not name, at the top level and inside frames', () => {
    post(validOpen({ cookie: 'session=abc', headers: { authorization: 'Bearer x' } }));
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: 'c1',
      frames: [{ kind: 'event', tMs: 1, raw: 'data: {}\n', stolen: 'secret' }],
    });

    const [open, frames] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(open ?? {}).sort()).toEqual(
      ['connId', 'contentType', 'input', 'kind', 'method', 'tMs', 'url', 'v'].sort(),
    );
    const frameList = (frames ?? {}).frames as Record<string, unknown>[];
    expect(Object.keys(frameList[0] ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });

  it('passes the request body through verbatim', () => {
    const input = { threadId: 't1', messages: [{ role: 'user', content: 'hi' }], tools: [] };
    post(validOpen({ input }));
    const [open] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(open?.input).toEqual(input);
  });
});

describe('relay — hostile input is dropped silently', () => {
  const cases: Array<[string, () => void]> = [
    ['a message from an embedded iframe (wrong source)', () => post(validOpen(), { source: {} })],
    ['a message with a null source', () => post(validOpen(), { source: null })],
    [
      'a cross-origin poster',
      () => post(validOpen(), { origin: 'https://evil.example' }),
    ],
    ['an opaque "null" origin', () => post(validOpen(), { origin: 'null' })],
    [
      'a same-origin string that only looks like ours',
      () => post(validOpen(), { origin: `${window.location.origin}.evil.example` }),
    ],
    ['an untagged message', () => post({ v: 1, kind: 'conn-open', connId: 'c1', tMs: 1 })],
    ['a look-alike tag', () => post(validOpen({ source: 'agui-dt-evil' }))],
    ['a bumped protocol version', () => post(validOpen({ v: 2 }))],
    ['a version that is a string', () => post(validOpen({ v: '1' }))],
    ['an unknown kind', () => post(validOpen({ kind: 'exfiltrate' }))],
    ['a missing connId', () => post(validOpen({ connId: undefined }))],
    ['a non-string connId', () => post(validOpen({ connId: 42 }))],
    ['an empty connId', () => post(validOpen({ connId: '' }))],
    ['a NaN timestamp', () => post(validOpen({ tMs: Number.NaN }))],
    ['a non-string url', () => post(validOpen({ url: { toString: () => 'x' } }))],
    ['an invalid close reason', () =>
      post({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-close',
        connId: 'c1',
        tMs: 1,
        reason: 'exfiltrate',
      })],
    ['frames that are not an array', () =>
      post({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: 'c1',
        frames: 'data: {}',
      })],
    ['a frame that is not an object', () =>
      post({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: 'c1',
        frames: ['data: {}'],
      })],
    ['a frame missing raw', () =>
      post({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: 'c1',
        frames: [{ kind: 'event', tMs: 1 }],
      })],
    ['a keepalive frame missing its comment', () =>
      post({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: 'c1',
        frames: [{ kind: 'keepalive', tMs: 1, raw: ':x\n' }],
      })],
    ['a mixed array where only the last frame is malformed', () =>
      post({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: 'c1',
        frames: [{ kind: 'event', tMs: 1, raw: 'data: {}\n' }, null],
      })],
    ['a bare string', () => post('data: {"type":"RUN_STARTED"}')],
    ['null', () => post(null)],
    ['a number', () => post(7)],
    ['an array', () => post([validOpen()])],
    ['a function', () => post(() => undefined)],
    ['a message whose tag lives on the prototype, not the object', () => {
      const hostile = Object.create({ source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION }) as Record<
        string,
        unknown
      >;
      hostile.kind = 'conn-open';
      hostile.connId = 'c1';
      hostile.tMs = 1;
      hostile.method = 'POST';
      hostile.url = '/run';
      hostile.contentType = null;
      post(hostile);
    }],
  ];

  for (const [name, send] of cases) {
    it(`drops ${name}`, () => {
      expect(send).not.toThrow();
      expect(delivered(chromeHarness)).toEqual([]);
      expect(chromeHarness.connectNames).toEqual([]);
      expectSilent();
    });
  }

  it('drops a payload whose getter throws, without throwing itself', () => {
    const hostile = validOpen();
    Object.defineProperty(hostile, 'kind', {
      get(): never {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(() => {
      post(hostile);
    }).not.toThrow();
    expect(delivered(chromeHarness)).toEqual([]);
    expectSilent();
  });

  it('does not let a __proto__ key on an otherwise valid message pollute Object.prototype', () => {
    const hostile = JSON.parse(
      `{"__proto__":{"polluted":"yes"},"source":"${AGUI_DT_SOURCE}","v":1,"kind":"conn-open",` +
        `"connId":"c1","tMs":1,"method":"POST","url":"/run","contentType":null,"input":null}`,
    ) as unknown;
    post(hostile);

    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    const [forwarded] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.getPrototypeOf(forwarded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(forwarded, '__proto__')).toBe(false);
    expect(Object.keys(forwarded ?? {})).not.toContain('polluted');
    expectSilent();
  });

  it('strips a constructor key riding along on a valid message', () => {
    const hostile = validOpen({ constructor: { name: 'evil' }, toString: 'nope' });
    post(hostile);
    const [forwarded] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(forwarded ?? {})).not.toContain('constructor');
    expect(Object.keys(forwarded ?? {})).not.toContain('toString');
    expect(forwarded?.kind).toBe('conn-open');
  });

  it('never answers the page', () => {
    const reply = vi.spyOn(window, 'postMessage');
    post(validOpen());
    post(validOpen(), { origin: 'https://evil.example' });
    post('probe');
    expect(reply).not.toHaveBeenCalled();
    reply.mockRestore();
  });
});

describe('relay — surviving a sleeping service worker (§15)', () => {
  it('reconnects when the port died since the last message', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    expect(first?.posted).toHaveLength(1);

    first?.killFromServiceWorker();
    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME, RELAY_PORT_NAME]);
    expect(chromeHarness.ports[1]?.posted).toHaveLength(1);
    expectSilent();
  });

  it('reconnects when postMessage throws on a stale port and still delivers the message', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    if (first === undefined) throw new Error('no port');
    first.failPosts = 1;

    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.ports).toHaveLength(2);
    expect(first.posted).toHaveLength(1);
    const second = chromeHarness.ports[1];
    expect(second?.posted).toEqual([
      {
        v: 1,
        kind: 'conn-open',
        connId: 'c2',
        tMs: 12.5,
        method: 'POST',
        url: 'https://example.test/agent/run',
        contentType: 'text/event-stream',
        input: { threadId: 't1' },
      },
    ]);
    expectSilent();
  });

  it('gives up after one retry instead of looping', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    if (first === undefined) throw new Error('no port');
    first.failPosts = 1;
    // The replacement port is dead on arrival too.
    const originalConnect = (globalThis as unknown as { chrome: { runtime: { connect: (info: { name: string }) => FakePort } } })
      .chrome.runtime.connect;
    (globalThis as unknown as { chrome: { runtime: { connect: (info: { name: string }) => FakePort } } }).chrome.runtime.connect =
      (info) => {
        const port = originalConnect(info);
        port.failPosts = 1;
        return port;
      };

    expect(() => {
      post(validOpen({ connId: 'c2' }));
    }).not.toThrow();
    expect(chromeHarness.connectNames).toHaveLength(2);
    expectSilent();
  });

  it('drops the message when the extension context is gone, then recovers', () => {
    chromeHarness.connectThrows = 1;
    expect(() => {
      post(validOpen());
    }).not.toThrow();
    expect(delivered(chromeHarness)).toEqual([]);

    post(validOpen({ connId: 'c2' }));
    expect(delivered(chromeHarness)).toHaveLength(1);
    expectSilent();
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run (from `packages/devtools`): `pnpm vitest run src/relay/relay.test.ts`

Expected: FAIL with `Tests  13 failed | 30 passed (43)`. The stub `relay.ts` still exists, so the
import resolves and the failure is behavioural, not a resolution error: the stub registers a
listener but never connects a port. The first assertion to blow up is
`AssertionError: expected [] to deeply equal [ 'agui-devtools-relay' ]` in *connects with the
contract port name on the first valid message*; the other 12 are the remaining forwarding,
stripping and reconnect tests. The 30 that pass are the hostile-input ones — that is exactly what
the stub was for, and they must stay green through the rewrite.

- [ ] **Step 13: Write the implementation**

`packages/devtools/src/relay/relay.ts` (replace the file wholesale):

```ts
/**
 * ISOLATED-world content script — the `window.postMessage` -> `chrome.runtime` leg of §3.
 *
 * This file is the security boundary (§11). Everything reaching it was written by the page: the
 * MAIN-world capture script posts here, but so can any script on the page, and so can an iframe
 * or an opener. The order below is the boundary, and it is deliberate:
 *
 *   1. `event.source === window` — the message was posted by this frame to itself. Rejects
 *      embedded iframes and openers before any field is read.
 *   2. `event.origin === window.location.origin` — same origin. Rejects a cross-origin poster.
 *   3. `isInjectMessage` — full shape validation, including the protocol version.
 *
 * Anything failing any check is dropped with **no logging**. A `console.warn` here would leak
 * the extension's presence to any page that opens the console — and worse, would echo attacker
 * content into a log the user reads. Silence is the feature.
 *
 * Nothing is ever posted back to the page, no property is added to any global, and no DOM node
 * is created, so a page cannot detect the relay by feature-probing.
 */
import { isInjectMessage, PROTOCOL_VERSION, type InjectMessage } from '../inject/protocol';
import { RELAY_PORT_NAME, type RelayMessage } from '../sw/protocol';

let port: chrome.runtime.Port | null = null;

/**
 * Connect to the service worker, or return null if the extension context is gone (a reload or an
 * uninstall invalidates it and every `chrome.runtime` call throws).
 */
function connect(): chrome.runtime.Port | null {
  try {
    const next = chrome.runtime.connect({ name: RELAY_PORT_NAME });
    next.onDisconnect.addListener((): void => {
      // Reading `lastError` marks it consumed. Leaving it unread makes Chrome print
      // "Unchecked runtime.lastError" — console noise that is itself a detectable signal.
      if (chrome.runtime.lastError !== undefined) {
        // Deliberately consumed and deliberately not logged.
      }
      if (port === next) port = null;
    });
    port = next;
    return next;
  } catch {
    port = null;
    return null;
  }
}

/**
 * Deliver one message, reconnecting once if the port is dead.
 *
 * MV3 terminates an idle service worker at ~30 s (§15 risk row 1), which disconnects the port
 * without warning; the first `postMessage` after that throws. Reconnecting wakes the worker, so
 * the correct response is to retry, not to throw — a throw here would surface inside the page's
 * own `postMessage` dispatch.
 */
function send(message: RelayMessage): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = port ?? connect();
    if (active === null) return;
    try {
      active.postMessage(message);
      return;
    } catch {
      port = null;
    }
  }
}

/**
 * Screen out anything whose prototype is not the plain one, before the guard runs.
 *
 * A genuine `postMessage` delivers a structured clone, and a clone's prototype is always
 * `Object.prototype` — a page cannot smuggle a prototype chain across the boundary. Anything with
 * some other prototype therefore did not come from `postMessage` at all, and its inherited
 * properties may be accessors that would run inside `isInjectMessage`. `isInjectMessage` reads
 * properties, not own-properties, so without this line an object carrying the `source`/`v` tags
 * on its prototype validates. Three lines to make "hostile shapes never reach the port" true as
 * stated rather than true by luck.
 */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rebuild the message from known fields only.
 *
 * `isInjectMessage` proves the required fields are present; it does not prove the object carries
 * *nothing else*. Copying field by field means a hostile extra property — or a `__proto__` /
 * `constructor` key riding along on an otherwise valid message — never reaches the service
 * worker. `input` is the one value passed through by reference, because it is the page's own
 * `RunAgentInput` and the whole point of capturing it (verified fact 4) is to keep it verbatim.
 */
function toRelayMessage(message: InjectMessage): RelayMessage {
  switch (message.kind) {
    case 'conn-open':
      return {
        v: PROTOCOL_VERSION,
        kind: 'conn-open',
        connId: message.connId,
        tMs: message.tMs,
        method: message.method,
        url: message.url,
        contentType: message.contentType,
        input: message.input,
      };
    case 'frames':
      return {
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: message.connId,
        frames: message.frames.map((frame) =>
          frame.kind === 'keepalive'
            ? { kind: 'keepalive', tMs: frame.tMs, raw: frame.raw, comment: frame.comment }
            : { kind: 'event', tMs: frame.tMs, raw: frame.raw },
        ),
      };
    case 'conn-close':
      return {
        v: PROTOCOL_VERSION,
        kind: 'conn-close',
        connId: message.connId,
        tMs: message.tMs,
        reason: message.reason,
      };
    case 'binary':
      return {
        v: PROTOCOL_VERSION,
        kind: 'binary',
        connId: message.connId,
        tMs: message.tMs,
        contentType: message.contentType,
        bytes: message.bytes,
      };
  }
}

window.addEventListener('message', (event: MessageEvent): void => {
  try {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (!isPlainObject(data)) return;
    if (!isInjectMessage(data)) return;
    send(toRelayMessage(data));
  } catch {
    // A hostile payload can throw from a getter during validation or copying. Drop it.
  }
});

export {};
```

- [ ] **Step 14: Run test to verify it passes**

Run (from `packages/devtools`):

```
pnpm vitest run src/relay/relay.test.ts
pnpm typecheck
pnpm lint
pnpm verify:build
```

Expected: `Test Files 1 passed (1)`, `Tests 43 passed (43)`; typecheck, lint and the build
verifier clean. `verify:build` matters here specifically: `relay.js` must still appear as its own
content-script entry in the built manifest, under that basename.

- [ ] **Step 15: Commit**

```
git add packages/devtools/src/relay/relay.ts packages/devtools/src/relay/relay.test.ts
git commit -m "feat(relay): forward validated inject messages to the service worker (§3, §11, §15)"
```

---

## Verification actually run

Workspace: `scratchpad/verify-cap-D/`, with `node_modules` symlinked to `packages/devtools`, the
repo's `tsconfig.base.json` compiler options, the repo's `eslint.config.js`, `core/sse/parser.ts`
copied in unmodified, and `inject/protocol.ts` + `sw/protocol.ts` written to the contract.

```
$ ./node_modules/.bin/vitest run
 Test Files  3 passed (3)
      Tests  83 passed (83)

$ ./node_modules/.bin/tsc --noEmit -p tsconfig.json
(no output, exit 0)

$ ./node_modules/.bin/eslint src
(no output, exit 0)
```

The red phase was verified too, by moving the three implementation files aside:

```
 FAIL  |capture| src/inject/xhr-patch.test.ts [ src/inject/xhr-patch.test.ts ]
Error: Failed to resolve import "./xhr-patch" from "src/inject/xhr-patch.test.ts". Does the file exist?
 FAIL  |capture| src/inject/eventsource-patch.test.ts [ src/inject/eventsource-patch.test.ts ]
Error: Failed to resolve import "./eventsource-patch" from "src/inject/eventsource-patch.test.ts". Does the file exist?
 FAIL  |capture| src/relay/relay.test.ts [ src/relay/relay.test.ts ]
Error: Failed to resolve import "./relay" from "src/relay/relay.test.ts". Does the file exist?
```

### Hostile inputs the relay tests reject

Each of these is dispatched as a real `MessageEvent` on `window`, and each asserts three things:
nothing reaches the port, **no port is ever opened**, and no `console` method is called.

Rejected at check 1 (`event.source !== window`): a message from an embedded iframe (a foreign
object as `source`); a message with a `null` source.

Rejected at check 2 (origin): a cross-origin poster (`https://evil.example`); an opaque `"null"`
origin; a prefix attack (`http://localhost:3000.evil.example`).

Rejected at check 2.5 (plain-object screen, added after a test found the hole — see gap #2): an
object carrying the `source` and `v` tags on its **prototype** rather than as own properties.

Rejected at check 3 (`isInjectMessage`): an untagged message; the look-alike tag `agui-dt-evil`;
`v: 2`; `v: '1'`; `kind: 'exfiltrate'`; a missing `connId`; a numeric `connId`; an empty
`connId`; `tMs: NaN`; a `url` that is an object with a `toString`; `reason: 'exfiltrate'`;
`frames` as a string; a frame that is a string; a frame missing `raw`; a keepalive frame missing
`comment`; a frames array whose last element is `null`; a bare string; `null`; a number; an
array; a function.

Rejected without throwing: a payload whose `kind` is a getter that throws.

Accepted but neutralised: a `__proto__` key from `JSON.parse` on an otherwise valid message —
`Object.prototype` stays unpolluted, and the forwarded object has plain-`Object` prototype with
no `__proto__` own key; `constructor` and `toString` keys riding along on a valid message are
stripped, as are a `cookie` / `headers` pair and a `stolen` key inside a frame.

Reconnect behaviour (§15), all asserted silent: a port disconnected by the service worker leads
to a fresh `connect` on the next message; a `postMessage` that throws
`Attempting to use a disconnected port object` reconnects and re-delivers **that** message; two
dead ports in a row stop after exactly two `connect` calls rather than looping; a `connect` that
throws `Extension context invalidated.` drops the message without throwing and recovers on the
next one.

---

## Contract gaps

**1. `RelayMessage` as written does not typecheck.** The contract says
`export type RelayMessage = Omit<InjectMessage, 'source'>;`. `Omit` does not distribute over a
union: it computes `Pick<InjectMessage, Exclude<keyof InjectMessage, 'source'>>`, and
`keyof (A | B)` is the *intersection* of keys, so `RelayMessage` collapses to
`{ v: 1; kind: 'conn-open' | 'frames' | 'conn-close' | 'binary'; connId: string }` — `tMs`,
`frames`, `method`, `url`, `input`, `reason`, `contentType` and `bytes` all vanish from the type.
Building `relay.ts` against it produces four `TS2353` errors. The fix keeps the contract's name
and its prose meaning, and belongs in `src/sw/protocol.ts`:

```ts
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RelayMessage = DistributiveOmit<InjectMessage, 'source'>;
```

The SW task hits this first; whoever gets there first should apply it.

**2. `isInjectMessage` does not reject prototype-carried tags.** The contract specifies the guard
by signature only. A guard written the obvious way reads properties, not own-properties, so
`Object.create({ source: 'agui-dt', v: 1 })` with the rest of a valid message set as own keys
passes it. That was a real failing test here, not a hypothetical. Two possible homes for the fix;
this section took the second and does not depend on the first:
  - make the guard own-property-strict in `src/inject/protocol.ts`, and/or
  - screen at the boundary — `relay.ts` now rejects anything whose prototype is not
    `Object.prototype` or `null` before calling the guard.

A real `postMessage` always delivers a structured clone (prototype always `Object.prototype`), so
the screen costs nothing on the legitimate path.

**3. `WireFrame.raw` cannot be "the exact frame text".** The contract calls `raw` "the exact frame
text as it left the wire", but the reusable parser — `core/sse/parser.ts`, which this section is
required to reuse and forbidden to modify — returns parsed fields (`data`, `eventName`, `id`,
`retry`, `comment`) and does not retain frame boundaries. `EventSource` is worse: the browser
consumes the wire text before any patch can see it. So both files here **re-serialize** a
canonical frame text: `event:` / `id:` / `retry:` lines, then one `data:` line per line of data,
then a terminating newline; keepalives become `:<comment>\n`. This round-trips through the same
parser to an identical frame, which is what downstream consumers need, but it normalises
whitespace, field order and the `data:`-with-no-space form. Either amend the contract's wording,
or add a `raw` passthrough to `SseFrame` in a later task that is allowed to touch `core/`.

**4. No name is specified for the shared inject-side helpers.** Three things are needed by more
than one patch module and the contract names none of them: the batching sink (`post`), the §5.5
clock (`now`), and the connection-id generator (`nextConnId`). This section takes all three as
options rather than inventing a module, so the fetch task and the `inject.ts` entry point are
free to place them wherever they like. Two small helpers are currently duplicated across the
fetch task's file and this one — `snapshotXhrBody` (the §5.1 body-snapshot rules) and the
frame-to-`WireFrame` re-serializer. If the fetch task exports equivalents, collapse them into one
module and delete the copies here; nothing else in these files changes.

**5. `EventSource` named-event frames are not captured, by decision.** A named `event:` frame is
delivered only to `addEventListener('<name>', ...)`, and enumerating those names requires
wrapping `addEventListener` on every instance — more page surface and more detectability on a
transport §5.3 already calls rare (it cannot carry the `RunAgentInput` at all). The limitation is
stated in the module header and covered by a test that asserts a named frame produces nothing,
rather than being mislabelled. Revisit only if a real deployment turns up using it.

---

# Capture plan — Section E: the service worker (Tasks 11–12)

Two files, two TDD cycles: `src/sw/ring-buffer.ts` (the per-tab capture buffer) and
`src/sw/index.ts` (the MV3 port hub that fills it).

**Depends on, from earlier sections:**

- `packages/devtools/src/sw/protocol.ts` — `RELAY_PORT_NAME`, `PANEL_PORT_NAME`, `RelayMessage`,
  `SwMessage`, `RequestLine`, `PanelCommand`
- `packages/devtools/src/inject/protocol.ts` — `WireFrame`
- `packages/devtools/src/core/model/types.ts` — `CaptureRecord`, `AguiEvent`. Imported, never
  modified.

All commands run from `packages/devtools`.

**Verified before writing:** every file below was built and run against a stubbed
`chrome.runtime` / `chrome.storage.session` / `chrome.tabs` in
`scratchpad/verify-cap-E/` — 26 tests pass, `tsc --noEmit` clean, `eslint` clean. Eviction was
proven with a 3-record and a 3-record-worth-of-bytes buffer; the session-storage restore was
proven by tearing down one module instance and loading a second against the same storage map.

---

### Task 11: The per-tab ring buffer

`RingBuffer` is where requirements §11's "ring buffer caps on memory (default 5k events / 8 MB,
configurable), oldest dropped" becomes code — and where panel design decision P9 gets the number it
needs. P9 exists because sessions are long and ongoing, so the defaults **will** evict in normal
use, and a panel that renders a truncated stream without saying so is the same class of trust
failure as a hidden validator issue: someone computes TTFT from a run whose start was evicted and
never knows. `PanelState.droppedBefore` has been sitting at a hardcoded `0` since panel Task 2
waiting for this function.

Byte accounting uses UTF-8 length, not `String.length`. This project already fixed that exact bug
in `core/metrics/run-metrics.ts`, where UTF-16 code units under-report a CJK payload by 3x — a
buffer sized in code units would hold roughly 3x its configured memory for a Japanese conversation,
which is the OOM the cap exists to prevent.

**Files:**
- Create: `packages/devtools/src/sw/ring-buffer.ts`
- Test: `packages/devtools/src/sw/ring-buffer.test.ts`
- Modify: `packages/devtools/vitest.config.ts`

- [ ] **Step 1: Give `src/sw/**` a Vitest project**

`vitest.config.ts` currently has two projects, `core` and `panel`; neither includes `src/sw/`. A
test there would match nothing and Vitest would exit 0 having run it zero times. Add the project
first so Step 3's failure is a real failure. Skip this step if an earlier section already added a
project covering `src/sw/**/*.test.ts`.

Full `packages/devtools/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

/**
 * Three projects, because the halves of this package have incompatible environments.
 *
 * `core/` is deliberately Chrome-free and DOM-free (design §3 / D10, enforced by the
 * `no-restricted-globals` fence in eslint.config.js) and must keep running under plain `node` —
 * running it in jsdom would silently make `document` and `window` available and let the fence rot.
 * `panel/` renders Preact and needs a DOM, so it gets jsdom plus a setup file.
 * `sw/` is a service worker: no DOM, and a `chrome` stub supplied per test file. Without an entry
 * of its own its tests match no project's `include` and Vitest reports "No test files found"
 * instead of running them — a whole surface silently untested.
 *
 * `test.projects` is the Vitest 4 API (`InlineConfig.projects?: TestProjectConfiguration[]`);
 * each entry is itself a config object with its own nested `test` block.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          // `src/test/` holds the cross-module integration + golden-fixture suite. It imports only
          // from core/ and is Node-only, so it belongs to this project despite living outside
          // `src/core/`; without the second glob its 5 tests would stop running entirely.
          include: ['src/core/**/*.test.ts', 'src/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'panel',
          environment: 'jsdom',
          include: ['src/panel/**/*.test.{ts,tsx}'],
          setupFiles: ['src/panel/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'sw',
          environment: 'node',
          include: ['src/sw/**/*.test.ts'],
        },
      },
    ],
  },
});
```

- [ ] **Step 2: Write the failing test**

`packages/devtools/src/sw/ring-buffer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CaptureRecord } from '../core/model/types';
import type { RequestLine } from './protocol';
import { createRingBuffer } from './ring-buffer';

function eventRecord(seq: number, content = 'x'): CaptureRecord {
  const event = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: content };
  return { kind: 'event', seq, tMs: seq, connId: 'c1', raw: event, event, issues: [] };
}

function keepalive(seq: number): CaptureRecord {
  return { kind: 'keepalive', seq, tMs: seq, connId: 'c1', raw: ':ping\n\n', comment: 'ping', issues: [] };
}

function requestLine(connId: string): RequestLine {
  return { connId, tMs: 0, method: 'POST', url: '/agent', input: { threadId: 't1' } };
}

function seqs(records: CaptureRecord[]): number[] {
  return records.map((record) => record.seq);
}

describe('createRingBuffer', () => {
  it('starts empty with nothing dropped', () => {
    const buffer = createRingBuffer();
    expect(buffer.records()).toEqual([]);
    expect(buffer.requests()).toEqual([]);
    expect(buffer.droppedBefore()).toBe(0);
    expect(buffer.bytes()).toBe(0);
  });

  it('keeps records in push order below the caps', () => {
    const buffer = createRingBuffer();
    buffer.push(eventRecord(1));
    buffer.push(keepalive(2));
    buffer.push(eventRecord(3));
    expect(seqs(buffer.records())).toEqual([1, 2, 3]);
    expect(buffer.droppedBefore()).toBe(0);
  });

  it('evicts oldest-first and counts every eviction once the record cap is passed', () => {
    const buffer = createRingBuffer({ maxRecords: 3 });
    for (let seq = 1; seq <= 10; seq += 1) buffer.push(eventRecord(seq));
    expect(seqs(buffer.records())).toEqual([8, 9, 10]);
    expect(buffer.droppedBefore()).toBe(7);
  });

  it('keeps evicting correctly past the compaction threshold', () => {
    const buffer = createRingBuffer({ maxRecords: 5 });
    for (let seq = 1; seq <= 500; seq += 1) buffer.push(eventRecord(seq));
    expect(seqs(buffer.records())).toEqual([496, 497, 498, 499, 500]);
    expect(buffer.droppedBefore()).toBe(495);
  });

  it('evicts on the byte cap and keeps bytes() in step with what is retained', () => {
    // Two-digit seqs only, so every record serializes to the same length and the cap is exact.
    const probe = createRingBuffer();
    probe.push(eventRecord(10));
    const perRecord = probe.bytes();

    const buffer = createRingBuffer({ maxBytes: perRecord * 3 });
    for (let seq = 10; seq <= 29; seq += 1) buffer.push(eventRecord(seq));

    expect(buffer.records().length).toBe(3);
    expect(seqs(buffer.records())).toEqual([27, 28, 29]);
    expect(buffer.bytes()).toBe(perRecord * 3);
    expect(buffer.droppedBefore()).toBe(17);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // `raw` only — an unparseable frame — so the payload is serialized exactly once.
    const unparsed = (text: string): CaptureRecord => ({
      kind: 'event',
      seq: 1,
      tMs: 1,
      connId: 'c1',
      raw: text,
      event: null,
      issues: [],
    });
    const ascii = createRingBuffer();
    ascii.push(unparsed('aaa'));
    const cjk = createRingBuffer();
    cjk.push(unparsed('日本語'));

    // Same String.length, 3x the bytes on the wire. A code-unit count would report these equal
    // and the buffer would hold ~3x its configured memory.
    expect('aaa'.length).toBe('日本語'.length);
    expect(cjk.bytes()).toBe(ascii.bytes() + 6);
  });

  it('retains the newest record even when it alone exceeds the byte cap', () => {
    const buffer = createRingBuffer({ maxBytes: 10 });
    buffer.push(eventRecord(1));
    buffer.push(eventRecord(2));
    expect(seqs(buffer.records())).toEqual([2]);
    expect(buffer.droppedBefore()).toBe(1);
    expect(buffer.bytes()).toBeGreaterThan(10);
  });

  it('holds request lines separately and counts their bytes', () => {
    const buffer = createRingBuffer();
    buffer.addRequest(requestLine('c1'));
    buffer.addRequest(requestLine('c2'));
    expect(buffer.requests().map((request) => request.connId)).toEqual(['c1', 'c2']);
    expect(buffer.bytes()).toBeGreaterThan(0);
    expect(buffer.droppedBefore()).toBe(0);
  });

  it('does not count request eviction as a dropped record', () => {
    const buffer = createRingBuffer({ maxRecords: 2 });
    buffer.addRequest(requestLine('c1'));
    buffer.addRequest(requestLine('c2'));
    buffer.addRequest(requestLine('c3'));
    expect(buffer.requests().map((request) => request.connId)).toEqual(['c2', 'c3']);
    expect(buffer.droppedBefore()).toBe(0);
  });

  it('returns a copy, so a caller cannot mutate the buffer through it', () => {
    const buffer = createRingBuffer();
    buffer.push(eventRecord(1));
    const taken = buffer.records();
    taken.push(eventRecord(2));
    expect(buffer.records().length).toBe(1);
  });

  it('clear() empties everything and resets the dropped count', () => {
    const buffer = createRingBuffer({ maxRecords: 2 });
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(eventRecord(seq));
    buffer.addRequest(requestLine('c1'));
    expect(buffer.droppedBefore()).toBe(3);

    buffer.clear();

    expect(buffer.records()).toEqual([]);
    expect(buffer.requests()).toEqual([]);
    expect(buffer.bytes()).toBe(0);
    // A cleared buffer has dropped nothing before its own start; leaving the count set would
    // leave P9's truncation marker on screen forever.
    expect(buffer.droppedBefore()).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/sw/ring-buffer.test.ts`
Expected: FAIL with `Error: Cannot find module './ring-buffer' imported from
.../src/sw/ring-buffer.test.ts`

- [ ] **Step 4: Write the implementation**

`packages/devtools/src/sw/ring-buffer.ts`:

```ts
/**
 * The service worker's per-tab capture buffer — requirements §11's "ring buffer caps on memory
 * (default 5k events / 8 MB, configurable), oldest dropped".
 *
 * Eviction is COUNTED, never silent. `droppedBefore()` is the whole reason this module reports
 * anything at all beyond its contents: panel design decision P9 established that sessions are
 * long and ongoing, so the default caps WILL evict in normal use, and a panel that renders a
 * truncated stream without saying so is the same class of trust failure as a hidden validator
 * issue — someone computes TTFT from a run whose start was evicted and never knows.
 */
import type { CaptureRecord } from '../core/model/types';
import type { RequestLine } from './protocol';

export interface RingBufferOptions {
  maxRecords?: number;
  maxBytes?: number;
}

export interface RingBuffer {
  push(record: CaptureRecord): void;
  addRequest(request: RequestLine): void;
  records(): CaptureRecord[];
  requests(): RequestLine[];
  /** Count evicted from the front. Feeds PanelState.droppedBefore (P9). */
  droppedBefore(): number;
  bytes(): number;
  clear(): void;
}

/** requirements §11. */
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How many evicted slots may sit at the front before the backing arrays are rebuilt.
 *
 * Eviction moves a head index instead of calling `shift()`, so a full buffer costs O(1) per push
 * rather than O(n); compaction bounds the stale references that trick leaves behind. 64 keeps the
 * over-retention small relative to the byte cap while making the O(n) rebuild a 1-in-64 event.
 */
const COMPACT_AFTER = 64;

/**
 * UTF-8 byte length of a value's JSON encoding.
 *
 * `TextEncoder`, not `String.length`: `String.length` counts UTF-16 code units, so a CJK
 * codepoint reports 1 for 3 bytes on the wire and an emoji 2 for 4. `core/metrics/run-metrics.ts`
 * carries the same note for the same reason — a buffer sized in code units would hold roughly 3x
 * its configured memory for a Japanese conversation, which is exactly the OOM the cap exists to
 * prevent.
 */
const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

export function createRingBuffer(options: RingBufferOptions = {}): RingBuffer {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let recordList: CaptureRecord[] = [];
  let recordSizes: number[] = [];
  let head = 0;
  let recordBytes = 0;

  let requestList: RequestLine[] = [];
  let requestSizes: number[] = [];
  let requestHead = 0;
  let requestBytes = 0;

  let dropped = 0;

  function recordCount(): number {
    return recordList.length - head;
  }

  function requestCount(): number {
    return requestList.length - requestHead;
  }

  function compact(): void {
    if (head >= COMPACT_AFTER) {
      recordList = recordList.slice(head);
      recordSizes = recordSizes.slice(head);
      head = 0;
    }
    if (requestHead >= COMPACT_AFTER) {
      requestList = requestList.slice(requestHead);
      requestSizes = requestSizes.slice(requestHead);
      requestHead = 0;
    }
  }

  /**
   * Drop oldest-first until both caps hold.
   *
   * The byte cap stops at one record on purpose: a single frame larger than `maxBytes` would
   * otherwise evict itself the instant it arrived, leaving a buffer that looks empty while
   * capture is plainly working. Holding the newest record over-runs the cap by exactly one
   * record — bounded, and visible in `bytes()` — instead of hiding the event.
   */
  function enforceCaps(): void {
    while (recordCount() > 0 && recordCount() > maxRecords) {
      recordBytes -= recordSizes[head] ?? 0;
      head += 1;
      dropped += 1;
    }
    while (recordCount() > 1 && recordBytes + requestBytes > maxBytes) {
      recordBytes -= recordSizes[head] ?? 0;
      head += 1;
      dropped += 1;
    }
    // Request lines are one per connection and are what `run-started-without-input` reads, so
    // they are capped by count only and their eviction does NOT touch `droppedBefore`: P9's
    // counter is a RECORD count that positions the panel's truncation marker in the event list.
    while (requestCount() > maxRecords) {
      requestBytes -= requestSizes[requestHead] ?? 0;
      requestHead += 1;
    }
    compact();
  }

  return {
    push(record: CaptureRecord): void {
      const size = byteLength(record);
      recordList.push(record);
      recordSizes.push(size);
      recordBytes += size;
      enforceCaps();
    },

    addRequest(request: RequestLine): void {
      const size = byteLength(request);
      requestList.push(request);
      requestSizes.push(size);
      requestBytes += size;
      enforceCaps();
    },

    records(): CaptureRecord[] {
      return recordList.slice(head);
    },

    requests(): RequestLine[] {
      return requestList.slice(requestHead);
    },

    droppedBefore(): number {
      return dropped;
    },

    bytes(): number {
      return recordBytes + requestBytes;
    },

    clear(): void {
      recordList = [];
      recordSizes = [];
      head = 0;
      recordBytes = 0;
      requestList = [];
      requestSizes = [];
      requestHead = 0;
      requestBytes = 0;
      // A cleared buffer has dropped nothing before its (empty) start, so the panel must stop
      // showing a truncation marker the moment the user clears.
      dropped = 0;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/sw/ring-buffer.test.ts`
Expected: 11 passed. Then `pnpm typecheck && pnpm lint` clean.

- [ ] **Step 6: Commit**

`feat(sw): per-tab ring buffer with counted, never-silent eviction (P9)`


---

### Task 12: The MV3 service worker

The worker is the only place with a per-tab view of the stream, so it is what turns `WireFrame`s
into `CaptureRecord`s: `seq`, `connId`, `kind`, and `tMs` are assigned here. It holds one buffer per
`tabId`, replays a snapshot to a panel that subscribes late, and mirrors to `chrome.storage.session`
so a terminated worker can restore (§15 risk row 1). The panel port is the other half of that
mitigation — a connected port keeps the worker alive while a panel is watching.

`globalThis.__AGUI_DT_TEST__` is installed **unconditionally**. It exposes only data the extension
already holds for the tab being inspected and makes no network call, and a build flag would mean
the tested artifact differs from the shipped one — which is exactly how a silently broken build
passed every gate earlier in this project (see `scripts/verify-build.ts`).

Three decisions worth stating before the code:

- **`tMs` is copied from the frame, not minted here.** §5.5 wants the page-side arrival time of the
  frame's first byte. A worker-side clock read would fold postMessage and port latency into every
  timing metric.
- **The mirror holds the newest 1000 records, not all 5000.** `chrome.storage.session` has a ~10 MB
  extension-wide quota and this write runs on a 250 ms debounce; mirroring a full 8 MB buffer would
  spend both. The records that do not fit are added to `droppedBefore` on restore rather than
  vanishing — a restored buffer that silently starts mid-run is precisely what P9 forbids.
- **Restore gates the message path.** The mirror load is async and port messages are not, so
  everything touching a buffer queues behind restore and drains in order. Handling a frame first
  would give it a `seq` the restored records then reuse.

**Files:**
- Create: `packages/devtools/src/sw/index.ts` (replaces the stub)
- Test: `packages/devtools/src/sw/index.test.ts`
- Modify: `packages/devtools/src/sw/protocol.ts` (one type, see Step 9)

- [ ] **Step 7: Write the failing test**

The `chrome` stub is inline: `installChrome()` covers exactly the surface the worker touches, its
`storage.session.set` round-trips through JSON so an unserializable mirror fails here rather than in
Chrome, and its `deferGet` option pins a read open so the restore-ordering test is deterministic
instead of racing a microtask.

`packages/devtools/src/sw/index.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureRecord } from '../core/model/types';
import type { WireFrame } from '../inject/protocol';
import {
  PANEL_PORT_NAME,
  RELAY_PORT_NAME,
  type PanelCommand,
  type RelayMessage,
  type SwMessage,
} from './protocol';

/* -------------------------------------------------------------------------- */
/* A `chrome` stub covering exactly the surface the worker touches.             */
/* -------------------------------------------------------------------------- */

type Listener<A extends unknown[]> = (...args: A) => void;

class FakeEvent<A extends unknown[]> {
  private readonly listeners: Listener<A>[] = [];
  addListener(fn: Listener<A>): void {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener<A>): void {
    const index = this.listeners.indexOf(fn);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  emit(...args: A): void {
    for (const fn of [...this.listeners]) fn(...args);
  }
}

class FakePort {
  readonly onMessage = new FakeEvent<[unknown, FakePort]>();
  readonly onDisconnect = new FakeEvent<[FakePort]>();
  /** Everything the worker has sent to this port. */
  readonly sent: SwMessage[] = [];
  constructor(
    readonly name: string,
    readonly sender?: { tab?: { id: number } },
  ) {}
  postMessage(message: unknown): void {
    this.sent.push(message as SwMessage);
  }
  disconnect(): void {
    this.onDisconnect.emit(this);
  }
}

interface ChromeStub {
  session: Map<string, unknown>;
  connect(port: FakePort): void;
  removeTab(tabId: number): void;
  /** Resolve reads held back by `deferGet` — lets a test pin the worker mid-restore. */
  releaseGet(): void;
}

function installChrome(
  session: Map<string, unknown> = new Map(),
  options: { deferGet?: boolean } = {},
): ChromeStub {
  const onConnect = new FakeEvent<[FakePort]>();
  const onRemoved = new FakeEvent<[number]>();
  const held: (() => void)[] = [];

  const storageSession = {
    get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      if (keys === null) {
        Object.assign(out, Object.fromEntries(session));
      } else {
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          if (session.has(key)) out[key] = session.get(key);
        }
      }
      if (options.deferGet !== true) return Promise.resolve(out);
      return new Promise<Record<string, unknown>>((resolve) => {
        held.push(() => {
          resolve(out);
        });
      });
    },
    set(items: Record<string, unknown>): Promise<void> {
      // The real API structured-clones on the way in. Round-tripping through JSON here proves
      // the mirror is actually serializable instead of discovering it in Chrome.
      for (const [key, value] of Object.entries(items)) {
        session.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      }
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) session.delete(key);
      return Promise.resolve();
    },
  };

  globalThis.chrome = {
    runtime: { onConnect },
    storage: { session: storageSession },
    tabs: { onRemoved },
  } as unknown as typeof chrome;

  return {
    session,
    connect: (port) => {
      onConnect.emit(port);
    },
    removeTab: (tabId) => {
      onRemoved.emit(tabId);
    },
    releaseGet: () => {
      while (held.length > 0) {
        const resolve = held.shift();
        if (resolve) resolve();
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

async function loadWorker(): Promise<void> {
  vi.resetModules();
  await import('./index');
}

/** Let the restore promise and any pending mirror write settle. */
async function settle(ms = 0): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function testHook(): NonNullable<typeof globalThis.__AGUI_DT_TEST__> {
  const hook = globalThis.__AGUI_DT_TEST__;
  if (!hook) throw new Error('__AGUI_DT_TEST__ was not installed');
  return hook;
}

function relayPort(tabId: number): FakePort {
  return new FakePort(RELAY_PORT_NAME, { tab: { id: tabId } });
}

function panelPort(): FakePort {
  return new FakePort(PANEL_PORT_NAME);
}

function send(port: FakePort, message: RelayMessage | PanelCommand): void {
  port.onMessage.emit(message, port);
}

function eventFrame(tMs: number, event: Record<string, unknown>): WireFrame {
  return { kind: 'event', tMs, raw: JSON.stringify(event) };
}

function messagesOfKind<K extends SwMessage['kind']>(
  port: FakePort,
  kind: K,
): Extract<SwMessage, { kind: K }>[] {
  return port.sent.filter((message): message is Extract<SwMessage, { kind: K }> => message.kind === kind);
}

function snapshotOf(port: FakePort): Extract<SwMessage, { kind: 'snapshot' }> {
  const snapshot = messagesOfKind(port, 'snapshot')[0];
  if (!snapshot) throw new Error('no snapshot was sent');
  return snapshot;
}

function appendedRecords(port: FakePort): CaptureRecord[] {
  return messagesOfKind(port, 'append').flatMap((message) => message.records);
}

/* -------------------------------------------------------------------------- */

describe('service worker', () => {
  let stub: ChromeStub;

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('installs the test hook unconditionally, with no port ever connected', () => {
    const hook = testHook();
    expect(hook.records()).toEqual([]);
    expect(hook.requests()).toEqual([]);
    expect(hook.droppedBefore()).toBe(0);
    expect(hook.bytes()).toBe(0);
  });

  it('assigns seq, tMs, connId and kind when turning wire frames into records', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [
        eventFrame(12, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
        { kind: 'keepalive', tMs: 15, raw: ': ping\n\n', comment: 'ping' },
        eventFrame(20, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }),
      ],
    });

    const records = testHook().records();
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.tMs)).toEqual([12, 15, 20]);
    expect(records.every((record) => record.connId === 'c1')).toBe(true);
    expect(records.map((record) => record.kind)).toEqual(['event', 'keepalive', 'event']);

    const first = records[0];
    if (first?.kind !== 'event') throw new Error('expected an event record');
    expect(first.event?.['type']).toBe('RUN_STARTED');
    expect(first.issues).toEqual([]);

    const second = records[1];
    if (second?.kind !== 'keepalive') throw new Error('expected a keepalive record');
    expect(second.comment).toBe('ping');
    expect(second.raw).toBe(': ping\n\n');
  });

  it('records an unparseable frame with event null instead of dropping it', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [{ kind: 'event', tMs: 5, raw: '{not json' }] });

    const record = testHook().records()[0];
    if (record?.kind !== 'event') throw new Error('expected an event record');
    expect(record.event).toBeNull();
    expect(record.raw).toBe('{not json');
  });

  it('parses full SSE frame text as well as a bare data payload', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [{ kind: 'event', tMs: 5, raw: 'event: message\ndata: {"type":"RUN_STARTED"}\n\n' }],
    });

    const record = testHook().records()[0];
    if (record?.kind !== 'event') throw new Error('expected an event record');
    expect(record.event?.['type']).toBe('RUN_STARTED');
  });

  it('replays a snapshot to a panel that subscribes after the run', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'conn-open',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/agent',
      contentType: 'text/event-stream',
      input: { threadId: 't1' },
    });
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(12, { type: 'RUN_STARTED' })] });

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const snapshot = snapshotOf(panel);
    expect(snapshot.records.map((record) => record.seq)).toEqual([1]);
    expect(snapshot.requests.map((request) => request.url)).toEqual(['/agent']);
    expect(snapshot.droppedBefore).toBe(0);
  });

  it('appends to the subscribed panel only, never to a panel watching another tab', () => {
    const watcher = panelPort();
    stub.connect(watcher);
    send(watcher, { kind: 'subscribe', tabId: 7 });
    const other = panelPort();
    stub.connect(other);
    send(other, { kind: 'subscribe', tabId: 9 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(12, { type: 'RUN_STARTED' })] });

    expect(appendedRecords(watcher).map((record) => record.seq)).toEqual([1]);
    expect(appendedRecords(other)).toEqual([]);
  });

  it('forwards conn-open as a request line and conn-close as closed', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'conn-open',
      connId: 'c1',
      tMs: 3,
      method: 'POST',
      url: '/agent',
      contentType: 'text/event-stream',
      input: { threadId: 't1' },
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 99, reason: 'complete' });

    expect(messagesOfKind(panel, 'request')[0]?.request).toEqual({
      connId: 'c1',
      tMs: 3,
      method: 'POST',
      url: '/agent',
      input: { threadId: 't1' },
    });
    expect(messagesOfKind(panel, 'closed')[0]).toEqual({ kind: 'closed', connId: 'c1', tMs: 99 });
  });

  it('honours set-recording in both directions', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);

    send(panel, { kind: 'set-recording', recording: false });
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(1, { type: 'RUN_STARTED' })] });
    expect(testHook().records()).toEqual([]);

    send(panel, { kind: 'set-recording', recording: true });
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(2, { type: 'RUN_STARTED' })] });
    expect(testHook().records().map((record) => record.tMs)).toEqual([2]);
  });

  it('clears the buffer, the mirror, and the panel on the clear command', async () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(1, { type: 'RUN_STARTED' })] });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9, reason: 'complete' });
    await settle();
    expect(stub.session.has('agui-dt:tab:7')).toBe(true);

    send(panel, { kind: 'clear' });
    await settle();

    expect(testHook().records()).toEqual([]);
    expect(testHook().droppedBefore()).toBe(0);
    expect(messagesOfKind(panel, 'cleared').length).toBe(1);
    expect(stub.session.has('agui-dt:tab:7')).toBe(false);
  });

  it('ignores a binary notice rather than mis-encoding it as a record', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'binary',
      connId: 'c1',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 512,
    });
    expect(testHook().records()).toEqual([]);
  });

  it('drops a tab buffer and its mirror when the tab closes', async () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(1, { type: 'RUN_STARTED' })] });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9, reason: 'complete' });
    await settle();

    stub.removeTab(7);
    await settle();

    expect(testHook().records()).toEqual([]);
    expect(stub.session.has('agui-dt:tab:7')).toBe(false);
  });

  it('mirrors on a debounce as frames arrive, without waiting for a close', async () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(1, { type: 'RUN_STARTED' })] });

    expect(stub.session.has('agui-dt:tab:7')).toBe(false);
    await settle(300);
    expect(stub.session.has('agui-dt:tab:7')).toBe(true);
  });

  it('queues relay traffic that arrives before the restore completes', async () => {
    const session = new Map<string, unknown>([
      [
        'agui-dt:tab:7',
        {
          v: 1,
          records: [
            { kind: 'event', seq: 50, tMs: 1, connId: 'c0', raw: { type: 'RUN_STARTED' }, event: { type: 'RUN_STARTED' }, issues: [] },
          ],
          requests: [],
          droppedBefore: 4,
          nextSeq: 51,
          recording: true,
        },
      ],
    ]);
    // `deferGet` pins the read open, which is the real shape of a woken worker: the mirror load
    // is async and port traffic is not.
    stub = installChrome(session, { deferGet: true });
    vi.resetModules();
    await import('./index');

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames: [eventFrame(60, { type: 'RUN_FINISHED' })] });
    expect(testHook().records()).toEqual([]);

    stub.releaseGet();
    await settle();

    const records = testHook().records();
    expect(records.map((record) => record.seq)).toEqual([50, 51]);
    expect(testHook().droppedBefore()).toBe(4);
  });
});

describe('service worker restore after termination', () => {
  it('restores records, requests, seq, and droppedBefore from the session mirror', async () => {
    const session = new Map<string, unknown>();

    // ---- first worker incarnation ----
    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'conn-open',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/agent',
      contentType: 'text/event-stream',
      input: { threadId: 't1' },
    });
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' }), eventFrame(30, { type: 'RUN_FINISHED' })],
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });
    await settle();
    expect(session.has('agui-dt:tab:7')).toBe(true);

    // ---- worker terminated; a new one starts against the same session storage ----
    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const snapshot = snapshotOf(panel);
    expect(snapshot.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(snapshot.records.map((record) => record.kind)).toEqual(['event', 'event']);
    expect(snapshot.requests.map((request) => request.url)).toEqual(['/agent']);
    expect(snapshot.droppedBefore).toBe(0);

    // seq continues from the restored high-water mark instead of colliding with it.
    const revived = relayPort(7);
    stub.connect(revived);
    send(revived, { v: 1, kind: 'frames', connId: 'c2', frames: [eventFrame(90, { type: 'RUN_STARTED' })] });
    expect(appendedRecords(panel).map((record) => record.seq)).toEqual([3]);
  });

  it('counts records the mirror could not hold as dropped, rather than losing them silently', async () => {
    const session = new Map<string, unknown>();

    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    const frames: WireFrame[] = [];
    for (let i = 0; i < 1200; i += 1) frames.push(eventFrame(i, { type: 'TEXT_MESSAGE_CONTENT', delta: 'x' }));
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9999, reason: 'complete' });
    await settle();

    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const snapshot = snapshotOf(panel);
    expect(snapshot.records.length).toBe(1000);
    expect(snapshot.records[0]?.seq).toBe(201);
    // P9: the 200 records that did not fit in the mirror are reported, not silently missing.
    expect(snapshot.droppedBefore).toBe(200);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm vitest run src/sw/index.test.ts`
Expected: FAIL — 15 tests fail in `beforeEach` with `Error: Cannot find module './index'`, and the
two restore tests fail the same way. (The stub `src/sw/index.ts` from Task 17 registers a panel port
and nothing else, so if it is still in place the failures are instead `__AGUI_DT_TEST__ was not
installed` and `no snapshot was sent`.)

- [ ] **Step 9: Write the implementation**

First, one type fix in `packages/devtools/src/sw/protocol.ts`. `Omit` is **not** distributive over a
union: `Omit<InjectMessage, 'source'>` keeps only the keys common to all four arms, which collapses
`RelayMessage` to `{ v; kind; connId }` — `frames`, `url`, `input`, and `tMs` all disappear, and so
does the discriminated union the worker narrows on. `tsc` reports
`Property 'frames' does not exist on type 'RelayMessage'` on every use. The exported name and its
meaning are unchanged; only the mapping is fixed.

Replace:

```ts
export type RelayMessage = Omit<InjectMessage, 'source'>;
```

with:

```ts
/**
 * `Omit` is NOT distributive over a union: `Omit<A | B, 'source'>` keeps only the keys common to
 * every arm, so the plain form collapses this to `{ v; kind; connId }` and every payload field —
 * `frames`, `url`, `input`, `tMs` — disappears along with the discriminated union. Mapping over
 * the arms preserves them, which is what the contract's "identical payloads, minus the `source`
 * tag" means.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RelayMessage = DistributiveOmit<InjectMessage, 'source'>;
```

Then `packages/devtools/src/sw/index.ts`, replacing the stub in full:

```ts
/**
 * MV3 service worker — the port hub of requirements §3 (Architecture).
 *
 * It owns three things nothing else can:
 *   1. ONE ring buffer per `tabId`, so a panel opened after a run still sees it (§3 "survives
 *      panel-opened-late via replay").
 *   2. The `WireFrame` → `CaptureRecord` conversion: `seq`, `tMs`, `connId`, and `kind` are
 *      assigned HERE, because the SW is the first place with a per-tab view of the stream.
 *   3. The `chrome.storage.session` mirror that survives worker termination (§15 risk row 1:
 *      "MV3 service worker terminates at ~30 s idle, losing the buffer"). The panel port is the
 *      other half of that mitigation — an open port keeps the worker alive while a panel watches.
 *
 * Session storage is cleared by Chrome on browser close, which is what keeps requirements §11's
 * "no persistence by default" true: nothing here touches disk.
 */
import type { AguiEvent, CaptureRecord } from '../core/model/types';
import type { WireFrame } from '../inject/protocol';
import {
  PANEL_PORT_NAME,
  RELAY_PORT_NAME,
  type PanelCommand,
  type RelayMessage,
  type RequestLine,
  type SwMessage,
} from './protocol';
import { createRingBuffer, type RingBuffer } from './ring-buffer';

/**
 * The harness's window into the worker (verified fact 6: Playwright can evaluate inside the MV3
 * service worker but cannot drive the DevTools panel, so assertions read the buffer from here).
 *
 * Installed UNCONDITIONALLY, not behind a build flag. It exposes only data the extension already
 * holds for the tab being inspected, makes no network call, and gating it would mean the tested
 * artifact differs from the shipped one — the exact class of gap that let a silently broken build
 * pass every gate earlier in this project.
 */
declare global {
  var __AGUI_DT_TEST__:
    | {
        records(): CaptureRecord[];
        requests(): RequestLine[];
        droppedBefore(): number;
        bytes(): number;
        clear(): void;
      }
    | undefined;
}

interface TabState {
  buffer: RingBuffer;
  /** Monotonic per tab. Fixtures and the JSONL codec start at 1. */
  nextSeq: number;
  recording: boolean;
  /**
   * Records dropped before this buffer existed — i.e. evicted by a PREVIOUS incarnation of the
   * worker, or trimmed from the session mirror. `RingBuffer` counts only its own evictions, so
   * P9's total is this plus `buffer.droppedBefore()`.
   */
  restoredDropped: number;
}

const tabs = new Map<number, TabState>();
/** Panel ports, mapped to the tab each has subscribed to. `null` until `subscribe` arrives. */
const panelPorts = new Map<chrome.runtime.Port, number | null>();

const SESSION_KEY_PREFIX = 'agui-dt:tab:';
/**
 * How much of a tab's tail is mirrored. The buffer holds up to 8 MB; `chrome.storage.session` has
 * a ~10 MB quota shared by the whole extension, and this write happens on a 250 ms debounce, so
 * mirroring the full buffer would spend the quota and the main thread on every burst. The records
 * left out are counted into `droppedBefore` on restore rather than vanishing — a restored buffer
 * that silently starts mid-run is precisely what P9 forbids.
 */
const MIRROR_MAX_RECORDS = 1000;
const MIRROR_DEBOUNCE_MS = 250;

interface MirroredTab {
  v: 1;
  records: CaptureRecord[];
  requests: RequestLine[];
  droppedBefore: number;
  nextSeq: number;
  recording: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tab state                                                                    */
/* -------------------------------------------------------------------------- */

function ensureTab(tabId: number): TabState {
  const existing = tabs.get(tabId);
  if (existing) return existing;
  const created: TabState = {
    buffer: createRingBuffer(),
    nextSeq: 1,
    recording: true,
    restoredDropped: 0,
  };
  tabs.set(tabId, created);
  return created;
}

function droppedFor(state: TabState): number {
  return state.restoredDropped + state.buffer.droppedBefore();
}

function broadcast(tabId: number, message: SwMessage): void {
  for (const [port, subscribed] of panelPorts) {
    if (subscribed === tabId) port.postMessage(message);
  }
}

/* -------------------------------------------------------------------------- */
/* WireFrame -> CaptureRecord                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `data:` payload of an SSE frame.
 *
 * Accepts either a bare payload or full frame text, because "the exact frame text" is the only
 * thing `WireFrame.raw` promises and a frame that carries `event:`/`id:` lines would otherwise
 * fail to parse. A payload that merely CONTAINS `data:` inside a string keeps its own text: no
 * line starts with the field name, so the loop yields nothing and the original is returned.
 */
function dataPayload(text: string): string {
  if (!text.includes('data:')) return text;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice('data:'.length);
    lines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return lines.length > 0 ? lines.join('\n') : text;
}

/**
 * Decode one event frame the same way the JSONL import path does: a non-object payload becomes
 * `event: null` and is still recorded, never dropped, so a malformed frame is surfaced and
 * flagged rather than disappearing. `raw` holds the decoded value when there is one — matching
 * `panel/import/load-jsonl.ts`, so `totalStreamBytes` counts a captured frame identically to a
 * re-imported one.
 */
function decodeEventFrame(text: string): { raw: unknown; event: AguiEvent | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataPayload(text));
  } catch {
    return { raw: text, event: null };
  }
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  return { raw: parsed, event: isObject ? (parsed as AguiEvent) : null };
}

/**
 * `tMs` is COPIED from the frame, not minted here. Requirements §5.5 wants the page-side arrival
 * time of the frame's first byte; a worker-side clock read would fold in postMessage and port
 * latency and quietly corrupt TTFT.
 */
function toRecord(frame: WireFrame, seq: number, connId: string): CaptureRecord {
  if (frame.kind === 'keepalive') {
    return {
      kind: 'keepalive',
      seq,
      tMs: frame.tMs,
      connId,
      raw: frame.raw,
      comment: frame.comment,
      issues: [],
    };
  }
  const decoded = decodeEventFrame(frame.raw);
  return {
    kind: 'event',
    seq,
    tMs: frame.tMs,
    connId,
    raw: decoded.raw,
    event: decoded.event,
    issues: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Session mirror                                                               */
/* -------------------------------------------------------------------------- */

const mirrorTimers = new Map<number, ReturnType<typeof setTimeout>>();

function sessionKey(tabId: number): string {
  return `${SESSION_KEY_PREFIX}${String(tabId)}`;
}

async function writeMirror(tabId: number): Promise<void> {
  const state = tabs.get(tabId);
  if (!state) return;
  const all = state.buffer.records();
  const kept = all.length > MIRROR_MAX_RECORDS ? all.slice(all.length - MIRROR_MAX_RECORDS) : all;
  const mirrored: MirroredTab = {
    v: 1,
    records: kept,
    requests: state.buffer.requests(),
    droppedBefore: droppedFor(state) + (all.length - kept.length),
    nextSeq: state.nextSeq,
    recording: state.recording,
  };
  await chrome.storage.session.set({ [sessionKey(tabId)]: mirrored });
}

function scheduleMirror(tabId: number): void {
  if (mirrorTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    mirrorTimers.delete(tabId);
    void writeMirror(tabId);
  }, MIRROR_DEBOUNCE_MS);
  mirrorTimers.set(tabId, timer);
}

/** Write now — used at connection close, the one moment a lost tail would lose a whole run. */
function flushMirror(tabId: number): void {
  const timer = mirrorTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    mirrorTimers.delete(tabId);
  }
  void writeMirror(tabId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Light structural check — this is our own data, and a corrupt entry is discarded, not trusted. */
function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!isRecord(value)) return false;
  const kind = value['kind'];
  return (
    (kind === 'event' || kind === 'keepalive') &&
    typeof value['seq'] === 'number' &&
    typeof value['tMs'] === 'number' &&
    typeof value['connId'] === 'string' &&
    Array.isArray(value['issues'])
  );
}

function isRequestLine(value: unknown): value is RequestLine {
  return (
    isRecord(value) &&
    typeof value['connId'] === 'string' &&
    typeof value['tMs'] === 'number' &&
    typeof value['method'] === 'string' &&
    typeof value['url'] === 'string'
  );
}

function asMirroredTab(value: unknown): MirroredTab | null {
  if (!isRecord(value) || value['v'] !== 1) return null;
  const records = value['records'];
  const requests = value['requests'];
  const droppedBefore = value['droppedBefore'];
  const nextSeq = value['nextSeq'];
  if (!Array.isArray(records) || !Array.isArray(requests)) return null;
  if (typeof droppedBefore !== 'number' || typeof nextSeq !== 'number') return null;
  return {
    v: 1,
    records: records.filter(isCaptureRecord),
    requests: requests.filter(isRequestLine),
    droppedBefore,
    nextSeq,
    recording: value['recording'] !== false,
  };
}

/* -------------------------------------------------------------------------- */
/* Restore gate                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Restore is async and port messages are not, so everything that touches a buffer is queued
 * behind it and drained IN ORDER. Handling a frame before the mirror loads would give it a seq
 * that the restored records then reuse.
 */
let restored = false;
const queued: (() => void)[] = [];

function afterRestore(work: () => void): void {
  if (restored) work();
  else queued.push(work);
}

async function restoreFromSession(): Promise<void> {
  try {
    const stored: Record<string, unknown> = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(SESSION_KEY_PREFIX)) continue;
      const tabId = Number(key.slice(SESSION_KEY_PREFIX.length));
      if (!Number.isInteger(tabId)) continue;
      const mirrored = asMirroredTab(value);
      if (!mirrored) continue;
      const state = ensureTab(tabId);
      for (const request of mirrored.requests) state.buffer.addRequest(request);
      for (const record of mirrored.records) state.buffer.push(record);
      state.restoredDropped = mirrored.droppedBefore;
      state.nextSeq = mirrored.nextSeq;
      state.recording = mirrored.recording;
    }
  } finally {
    restored = true;
    // Splice rather than iterate: a queued unit of work may itself queue more.
    while (queued.length > 0) {
      const work = queued.shift();
      if (work) work();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Relay port                                                                   */
/* -------------------------------------------------------------------------- */

const RELAY_KINDS: ReadonlySet<string> = new Set(['conn-open', 'frames', 'conn-close', 'binary']);

function asRelayMessage(value: unknown): RelayMessage | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !RELAY_KINDS.has(kind)) return null;
  if (typeof value['connId'] !== 'string') return null;
  if (kind === 'frames' && !Array.isArray(value['frames'])) return null;
  return value as unknown as RelayMessage;
}

function handleRelayMessage(tabId: number, message: RelayMessage): void {
  const state = ensureTab(tabId);
  // Not recording means not capturing: a paused panel must not fill the buffer behind the user's
  // back, and requirements §11's opt-in posture is meaningless if a "stopped" capture keeps data.
  if (!state.recording) return;

  switch (message.kind) {
    case 'conn-open': {
      const request: RequestLine = {
        connId: message.connId,
        tMs: message.tMs,
        method: message.method,
        url: message.url,
        input: message.input,
      };
      state.buffer.addRequest(request);
      broadcast(tabId, { kind: 'request', request });
      scheduleMirror(tabId);
      return;
    }
    case 'frames': {
      const appended: CaptureRecord[] = [];
      for (const frame of message.frames) {
        const record = toRecord(frame, state.nextSeq, message.connId);
        state.nextSeq += 1;
        state.buffer.push(record);
        appended.push(record);
      }
      if (appended.length > 0) broadcast(tabId, { kind: 'append', records: appended });
      scheduleMirror(tabId);
      return;
    }
    case 'conn-close': {
      broadcast(tabId, { kind: 'closed', connId: message.connId, tMs: message.tMs });
      // The end of a connection is the moment a lost tail costs a whole run, so this one writes
      // through instead of waiting out the debounce.
      flushMirror(tabId);
      return;
    }
    case 'binary': {
      // Requirements §5.4 wants a first-class "binary transport — decoding not supported yet"
      // state, but `SwMessage` has no arm for it and `PanelState` has no field for it, so there
      // is nothing to deliver it over. Dropped rather than mis-encoded as a record. See the
      // contract gap noted with this task.
      return;
    }
  }
}

function attachRelayPort(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    // A relay port with no tab cannot be attributed to a buffer. Nothing to do but let it go.
    port.disconnect();
    return;
  }
  port.onMessage.addListener((raw: unknown): void => {
    const message = asRelayMessage(raw);
    if (!message) return;
    afterRestore(() => {
      handleRelayMessage(tabId, message);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Panel port                                                                   */
/* -------------------------------------------------------------------------- */

function snapshotFor(tabId: number): SwMessage {
  const state = ensureTab(tabId);
  return {
    kind: 'snapshot',
    records: state.buffer.records(),
    requests: state.buffer.requests(),
    droppedBefore: droppedFor(state),
  };
}

function handlePanelCommand(port: chrome.runtime.Port, command: PanelCommand): void {
  switch (command.kind) {
    case 'subscribe': {
      panelPorts.set(port, command.tabId);
      port.postMessage(snapshotFor(command.tabId));
      return;
    }
    case 'clear': {
      const tabId = panelPorts.get(port) ?? null;
      if (tabId === null) return;
      const state = ensureTab(tabId);
      state.buffer.clear();
      state.restoredDropped = 0;
      void chrome.storage.session.remove(sessionKey(tabId));
      broadcast(tabId, { kind: 'cleared' });
      return;
    }
    case 'set-recording': {
      const tabId = panelPorts.get(port) ?? null;
      if (tabId === null) return;
      ensureTab(tabId).recording = command.recording;
      scheduleMirror(tabId);
      return;
    }
  }
}

function asPanelCommand(value: unknown): PanelCommand | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (kind === 'subscribe') {
    return typeof value['tabId'] === 'number' ? { kind, tabId: value['tabId'] } : null;
  }
  if (kind === 'clear') return { kind };
  if (kind === 'set-recording') {
    return typeof value['recording'] === 'boolean'
      ? { kind, recording: value['recording'] }
      : null;
  }
  return null;
}

function attachPanelPort(port: chrome.runtime.Port): void {
  // Registered before the first command so the port counts as open — §15's keepalive half of the
  // termination mitigation is simply that a connected port keeps the worker alive.
  panelPorts.set(port, null);
  port.onMessage.addListener((raw: unknown): void => {
    const command = asPanelCommand(raw);
    if (!command) return;
    afterRestore(() => {
      handlePanelCommand(port, command);
    });
  });
  port.onDisconnect.addListener((): void => {
    panelPorts.delete(port);
  });
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                       */
/* -------------------------------------------------------------------------- */

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port): void => {
  if (port.name === RELAY_PORT_NAME) attachRelayPort(port);
  else if (port.name === PANEL_PORT_NAME) attachPanelPort(port);
});

chrome.tabs.onRemoved.addListener((tabId: number): void => {
  tabs.delete(tabId);
  mirrorTimers.delete(tabId);
  void chrome.storage.session.remove(sessionKey(tabId));
});

/**
 * Aggregated across tabs: the hook's signature takes no `tabId`, and the harness drives exactly
 * one page. Ordering is per tab — `seq` is per tab too — so a multi-tab read is a concatenation,
 * not an interleave.
 */
globalThis.__AGUI_DT_TEST__ = {
  records(): CaptureRecord[] {
    return [...tabs.values()].flatMap((state) => state.buffer.records());
  },
  requests(): RequestLine[] {
    return [...tabs.values()].flatMap((state) => state.buffer.requests());
  },
  droppedBefore(): number {
    return [...tabs.values()].reduce((total, state) => total + droppedFor(state), 0);
  },
  bytes(): number {
    return [...tabs.values()].reduce((total, state) => total + state.buffer.bytes(), 0);
  },
  clear(): void {
    for (const [tabId, state] of tabs) {
      state.buffer.clear();
      state.restoredDropped = 0;
      void chrome.storage.session.remove(sessionKey(tabId));
      broadcast(tabId, { kind: 'cleared' });
    }
  },
};

void restoreFromSession();

export {};
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm vitest run src/sw/index.test.ts`
Expected: 15 passed in `service worker`, 2 passed in `service worker restore after termination`.
Then `pnpm test && pnpm typecheck && pnpm lint` clean, and `pnpm build && pnpm verify:build` still
green — `src/sw/index.ts` is a manifest entry point, so `verify:build` checks that its emitted chunk
still contains this code and not a content script's.

- [ ] **Step 11: Commit**

`feat(sw): per-tab port hub, session mirror, and the harness test hook`

---

### Task 13a: Panel live wiring — state and the fold

The panel's model comes out of `createRunBuilder` today via `import/load-jsonl.ts`. Live capture
uses the *same* builder, held across messages instead of run once over a file. This task is the
Chrome-free half: the fold, and the two state fields the toolbar needs. Task 13b is the port.

**Files:**

- Create: `packages/devtools/src/panel/capture/live-session.ts`
- Test: `packages/devtools/src/panel/capture/live-session.test.ts`
- Modify: `packages/devtools/src/panel/model/panel-types.ts`
- Modify: `packages/devtools/src/panel/model/store.ts`
- Test: `packages/devtools/src/panel/model/store.test.ts`

Imports `RequestLine` / `SwMessage` from `src/sw/protocol.ts` — created by an earlier capture
task, not by this one.

- [ ] **Step 1: Write the failing test**

`packages/devtools/src/panel/capture/live-session.test.ts` (new file, complete):

```ts
import { describe, expect, it } from 'vitest';
import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import type { RequestLine } from '../../sw/protocol';
import { initialPanelState } from '../model/panel-types';
import { createLiveSession } from './live-session';

let nextSeq = 0;

function record(event: AguiEvent, connId = 'c1', tMs = nextSeq * 10): CaptureRecord {
  const seq = nextSeq++;
  return { kind: 'event', seq, tMs, connId, raw: event, event, issues: [] };
}

function requestLine(connId = 'c1'): RequestLine {
  return {
    connId,
    tMs: 0,
    method: 'POST',
    url: 'http://localhost:5173/agent',
    input: { threadId: 't1', runId: 'r1', messages: [], tools: [], context: [], state: {} },
  };
}

function happyRun(connId = 'c1'): CaptureRecord[] {
  nextSeq = 0;
  return [
    record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }, connId),
    record({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }, connId),
    record({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' }, connId),
    record({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }, connId),
    record({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }, connId),
  ];
}

describe('createLiveSession', () => {
  it('folds a snapshot into runs, records and issues', () => {
    const session = createLiveSession();
    const records = happyRun();

    const next = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      droppedBefore: 0,
    });

    expect(next.records).toHaveLength(5);
    expect(next.runs).toHaveLength(1);
    expect(next.runs[0]?.runId).toBe('r1');
    expect(next.issues).toEqual([]);
  });

  it('appends onto an existing fold without replaying it', () => {
    const session = createLiveSession();
    const records = happyRun();
    const head = records.slice(0, 2);
    const tail = records.slice(2);

    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: head,
      requests: [requestLine()],
      droppedBefore: 0,
    });
    state = session.apply(state, { kind: 'append', records: tail });

    expect(state.records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.outcome).toBe('finished');
  });

  it('carries the request through, so a run is not reported as input-less', () => {
    const withRequest = createLiveSession();
    const withoutRequest = createLiveSession();
    const records = happyRun();

    const a = withRequest.apply(initialPanelState(), { kind: 'request', request: requestLine() });
    const withInput = withRequest.apply(a, { kind: 'append', records });
    const withoutInput = withoutRequest.apply(initialPanelState(), {
      kind: 'append',
      records: happyRun(),
    });

    expect(withInput.issues.map((issue) => issue.code)).not.toContain('run-started-without-input');
    expect(withoutInput.issues.map((issue) => issue.code)).toContain('run-started-without-input');
  });

  it('finalizes on closed, so an unterminated run reports it', () => {
    const session = createLiveSession();
    nextSeq = 0;
    const records = [
      record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
      record({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
    ];

    let state = session.apply(initialPanelState(), { kind: 'request', request: requestLine() });
    state = session.apply(state, { kind: 'append', records });
    expect(state.issues.map((issue) => issue.code)).not.toContain('run-never-terminated');

    state = session.apply(state, { kind: 'closed', connId: 'c1', tMs: 99 });
    expect(state.issues.map((issue) => issue.code)).toContain('run-never-terminated');
  });

  it('counts its own eviction into droppedBefore (P9)', () => {
    const session = createLiveSession({ maxRecords: 3 });
    const records = happyRun();

    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      droppedBefore: 0,
    });

    expect(state.records.map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(state.droppedBefore).toBe(2);
  });

  it("adds the worker's own eviction count to its own", () => {
    const session = createLiveSession({ maxRecords: 3 });
    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      droppedBefore: 7,
    });

    expect(state.droppedBefore).toBe(9);
  });

  it('empties everything on cleared', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      droppedBefore: 4,
    });
    state = { ...state, selectedSeq: 2, scope: 'r1' };

    state = session.apply(state, { kind: 'cleared' });

    expect(state.records).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.issues).toEqual([]);
    expect(state.droppedBefore).toBe(0);
    expect(state.selectedSeq).toBeNull();
    expect(state.scope).toBeNull();
  });

  it('re-folds under a new expandChunks without losing the request', () => {
    const session = createLiveSession({ expandChunks: false });
    nextSeq = 0;
    const records = [
      record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
      record({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'hi' }),
      record({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }),
    ];

    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      droppedBefore: 0,
    });
    state = session.apply(state, { kind: 'closed', connId: 'c1', tMs: 40 });
    const before = state.issues.map((issue) => issue.code);

    const after = session.refold(state, { expandChunks: true });

    expect(after.records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(after.runs).toHaveLength(1);
    // A re-fold must not invent an issue the same capture did not have a moment earlier.
    expect(after.issues.map((issue) => issue.code)).not.toContain('run-started-without-input');
    expect(after.issues.map((issue) => issue.code)).not.toContain('run-never-terminated');
    expect(before).not.toContain('run-started-without-input');
  });

  it('drops a selection that a new snapshot may not contain', () => {
    const session = createLiveSession();
    const state = session.apply(
      { ...initialPanelState(), selectedSeq: 99, scope: 'r_old' },
      { kind: 'snapshot', records: happyRun(), requests: [requestLine()], droppedBefore: 0 },
    );

    expect(state.selectedSeq).toBeNull();
    expect(state.scope).toBeNull();
  });
});
```

Append to `packages/devtools/src/panel/model/store.test.ts` — extend the existing import list
with `captureOn`, `setRecording`, `togglePreserveLog`, then add these two blocks at the end of the
file. `makeRecord` and `makeRun` are the helpers the file already defines.

```ts
describe('captureOn', () => {
  it('sets capture and source together', () => {
    const next = captureOn(initialPanelState(), 'http://localhost:5173');
    expect(next.capture).toEqual({ kind: 'on', origin: 'http://localhost:5173' });
    expect(next.source).toEqual({ kind: 'live', origin: 'http://localhost:5173' });
  });

  it('drops an imported capture rather than mixing it with a live one', () => {
    const imported: PanelState = {
      ...initialPanelState(),
      source: { kind: 'imported', filename: 'happy.agui.jsonl', importedAtMs: 5 },
      records: [makeRecord(1)],
      runs: [makeRun('r1', [1])],
      scope: 'r1',
      selectedSeq: 1,
      droppedBefore: 3,
      loadError: 'one line could not be decoded',
    };

    const next = captureOn(imported, 'https://app.example');

    expect(next.records).toEqual([]);
    expect(next.runs).toEqual([]);
    expect(next.issues).toEqual([]);
    expect(next.scope).toBeNull();
    expect(next.selectedSeq).toBeNull();
    expect(next.droppedBefore).toBe(0);
    expect(next.loadError).toBeNull();
  });

  it('keeps live records when the origin is re-affirmed', () => {
    const live = captureOn(initialPanelState(), 'https://app.example');
    const withData: PanelState = { ...live, records: [makeRecord(1)], selectedSeq: 1 };
    const next = captureOn(withData, 'https://app.example');
    expect(next.records).toHaveLength(1);
    expect(next.selectedSeq).toBe(1);
  });
});

describe('recording and preserve-log', () => {
  it('starts recording, so Enable begins capturing', () => {
    expect(initialPanelState().recording).toBe(true);
    expect(initialPanelState().preserveLog).toBe(false);
  });

  it('sets recording without touching capture', () => {
    const on = captureOn(initialPanelState(), 'https://app.example');
    const paused = setRecording(on, false);
    expect(paused.recording).toBe(false);
    expect(paused.capture).toEqual({ kind: 'on', origin: 'https://app.example' });
  });

  it('toggles preserve-log', () => {
    const once = togglePreserveLog(initialPanelState());
    expect(once.preserveLog).toBe(true);
    expect(togglePreserveLog(once).preserveLog).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/panel/capture/live-session.test.ts src/panel/model/store.test.ts`

Expected: FAIL with `Failed to resolve import "./live-session" from "src/panel/capture/live-session.test.ts"`,
and in `store.test.ts` `No "captureOn" export is defined on the "./store" mock` / a TypeScript
error `Module '"./store"' has no exported member 'captureOn'`.

- [ ] **Step 3: Write the implementation**

`packages/devtools/src/panel/capture/live-session.ts` (new file, complete):

```ts
/**
 * The fold from sw→panel messages into `PanelState`.
 *
 * This is the live twin of `import/load-jsonl.ts`, and deliberately the same fold: both feed
 * `createRunBuilder`, so the panel's model comes out of one code path whether it was imported
 * or captured (design §7). What differs is only that this one is incremental — the builder is
 * held across messages instead of being run once over a finished file.
 *
 * No Chrome API is touched here. The port lives in `./port`, so every branch below is
 * reachable from a test with a plain object.
 */
import type { CaptureRecord } from '../../core/model/types';
import { createRunBuilder, type RunBuilder } from '../../core/normalizer/run-builder';
import type { RequestLine, SwMessage } from '../../sw/protocol';
import type { PanelState } from '../model/panel-types';

export interface LiveSessionOptions {
  expandChunks?: boolean;
  /**
   * How many records the PANEL keeps. Matches the service worker's ring-buffer default
   * (contract: `maxRecords` 5000) so the two ends evict at the same scale.
   */
  maxRecords?: number;
}

export interface LiveSession {
  /** Fold one message and return the next state. `s` is never mutated. */
  apply(s: PanelState, message: SwMessage): PanelState;
  /**
   * Re-run the whole fold under new options and return the resulting state.
   *
   * This is what makes Expand chunks mean something on a live capture: expansion happens
   * inside the run builder, so the only way to apply it is to feed the retained records
   * through a new one. The imported path solves the same problem by re-decoding the file
   * (`App`'s `retained` bytes); live capture has no file, so it retains the records instead.
   */
  refold(s: PanelState, options: LiveSessionOptions): PanelState;
  /** Throw the fold away and start empty. */
  restart(options?: LiveSessionOptions): void;
  /** Every record the session still holds. */
  records(): CaptureRecord[];
}

/**
 * The panel's own bound on retained records, mirroring the ring buffer's 5000 default.
 *
 * The panel needs its OWN bound: `append` carries records and nothing else, so a panel that
 * simply accumulated them would grow without limit across a long session — and design §9 says
 * sessions are long and ongoing. Evicting here is also what makes `droppedBefore` truthful:
 * the field means "records dropped before the earliest one SHOWN", and what is shown is this
 * list. P9 then does the rest — the toolbar count is never silent.
 */
const DEFAULT_MAX_RECORDS = 5000;

export function createLiveSession(options: LiveSessionOptions = {}): LiveSession {
  let expandChunks = options.expandChunks ?? true;
  let maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  let builder: RunBuilder = createRunBuilder({ expandChunks });
  let records: CaptureRecord[] = [];
  /**
   * Retained so `refold` can rebuild. Verified fact 4: a run whose `RunAgentInput` is missing
   * reports `run-started-without-input`, so dropping these would make Expand chunks invent an
   * issue that the same capture did not have a moment earlier.
   */
  let requests: RequestLine[] = [];
  /** Connections already closed, replayed by `refold` so `finalizeRules` still runs. */
  let closed: Array<{ connId: string; tMs: number }> = [];
  let droppedBefore = 0;

  function restart(next: LiveSessionOptions = {}): void {
    expandChunks = next.expandChunks ?? expandChunks;
    maxRecords = next.maxRecords ?? maxRecords;
    builder = createRunBuilder({ expandChunks });
    records = [];
    requests = [];
    closed = [];
    droppedBefore = 0;
  }

  /** Oldest-first eviction, counted. Never silent — that is the whole of P9. */
  function trim(): void {
    if (records.length <= maxRecords) return;
    const excess = records.length - maxRecords;
    records = records.slice(excess);
    droppedBefore += excess;
  }

  function project(s: PanelState): PanelState {
    return {
      ...s,
      runs: builder.runs(),
      records,
      issues: builder.allIssues(),
      droppedBefore,
    };
  }

  function addRequest(request: RequestLine): void {
    requests.push(request);
    builder.addRequest(request.connId, request.method, request.url, request.input);
  }

  function refold(s: PanelState, next: LiveSessionOptions): PanelState {
    const heldRecords = records;
    const heldRequests = requests;
    const heldClosed = closed;
    const heldDropped = droppedBefore;
    restart(next);
    for (const request of heldRequests) addRequest(request);
    for (const record of heldRecords) builder.addRecord(record);
    for (const entry of heldClosed) builder.closeConnection(entry.connId, entry.tMs);
    records = heldRecords;
    closed = heldClosed;
    droppedBefore = heldDropped;
    return project(s);
  }

  function apply(s: PanelState, message: SwMessage): PanelState {
    switch (message.kind) {
      case 'snapshot': {
        // A snapshot replaces everything, so the builder is replaced too: re-feeding a fresh
        // one is the only way to get runs that describe exactly these records.
        restart();
        // Requests first, all of them. Verified fact 4: without the `RunAgentInput` behind it
        // every run additionally reports `run-started-without-input`, so a request that
        // arrived after its run's first record would put a spurious issue on screen. Order
        // among requests themselves does not matter — each is keyed by `connId`.
        for (const request of message.requests) addRequest(request);
        for (const record of message.records) builder.addRecord(record);
        records = [...message.records];
        // The worker's own eviction count is the floor: those records are gone before the
        // panel ever saw them, and `trim()` may add to it below.
        droppedBefore = message.droppedBefore;
        trim();
        // The snapshot is a new dataset: a selection made against the previous one would point
        // at a seq this one may not contain, and a scope at a run it may not have.
        return { ...project(s), scope: null, selectedSeq: null };
      }
      case 'append': {
        for (const record of message.records) builder.addRecord(record);
        records = [...records, ...message.records];
        trim();
        return project(s);
      }
      case 'request': {
        addRequest(message.request);
        return project(s);
      }
      case 'closed': {
        // Closing is what runs `finalizeRules`, so an unterminated run reports
        // `run-never-terminated` instead of sitting silently in 'running'.
        closed.push({ connId: message.connId, tMs: message.tMs });
        builder.closeConnection(message.connId, message.tMs);
        return project(s);
      }
      case 'cleared': {
        restart();
        return { ...project(s), scope: null, selectedSeq: null, loadError: null };
      }
    }
  }

  return {
    apply,
    refold,
    restart,
    records: () => records,
  };
}
```

`packages/devtools/src/panel/model/panel-types.ts` — three edits.

Replace the `CaptureStatus` doc comment:

```ts
/**
 * Capture availability for the inspected origin.
 *
 * `unsupported` means there is no `chrome.devtools` to ask — the panel HTML opened outside
 * DevTools, which is what unit tests and the screenshot harness do.
 *
 * `on` says the origin is capture-enabled, NOT that records are arriving: pausing is
 * `recording`, a separate field, because a paused panel is still attached to an enabled origin
 * and folding the two would make Resume indistinguishable from a fresh grant.
 */
```

Replace the `droppedBefore` field in `PanelState`, adding two fields after it:

```ts
  /** Records evicted before the earliest retained one, counted by the live session (P9). */
  droppedBefore: number;
  /**
   * Record/pause. True means new records are wanted; false means the service worker has been
   * told to stop buffering for this tab.
   *
   * Separate from `capture` on purpose — see the note there. It is `true` from the start so
   * that enabling capture starts recording, which is what a user who just pressed Enable
   * expects; the button reads Pause from the moment capture is on.
   */
  recording: boolean;
  /**
   * Keep the captured records across a navigation of the inspected page.
   *
   * Off by default, matching Chrome's own Network panel. When off, a navigation clears both
   * ends: the panel's fold and the worker's buffer.
   */
  preserveLog: boolean;
```

In `initialPanelState`, replace `droppedBefore: 0,` with:

```ts
    droppedBefore: 0,
    recording: true,
    preserveLog: false,
```

and replace the stale sentence in its doc comment:

```ts
 * `capture` starts `unsupported` because there is nothing to ask until `chrome.devtools` has
 * answered — the panel is driven entirely by import until `setCapture` or `captureOn` is called
 * with something better.
```

`packages/devtools/src/panel/model/store.ts` — insert immediately after `setCapture`:

```ts
/**
 * Capture is on for `origin`: set the status AND the source in one write.
 *
 * The two must move together. `source` is what the capture banner and the empty state read to
 * decide whether the panel is showing data or offering to get some, so leaving it `empty` while
 * `capture` said `on` would keep the import drop zone on screen over a live stream. It also
 * drops any imported capture: a panel cannot be showing a file and a live tab at once, and
 * silently appending live records to an imported file would produce a stream that never existed.
 */
export function captureOn(s: PanelState, origin: string): PanelState {
  const wasImported = s.source.kind === 'imported';
  return {
    ...s,
    capture: { kind: 'on', origin },
    source: { kind: 'live', origin },
    runs: wasImported ? [] : s.runs,
    records: wasImported ? [] : s.records,
    issues: wasImported ? [] : s.issues,
    droppedBefore: wasImported ? 0 : s.droppedBefore,
    scope: wasImported ? null : s.scope,
    selectedSeq: wasImported ? null : s.selectedSeq,
    loadError: wasImported ? null : s.loadError,
  };
}

export function setRecording(s: PanelState, recording: boolean): PanelState {
  return { ...s, recording };
}

export function togglePreserveLog(s: PanelState): PanelState {
  return { ...s, preserveLog: !s.preserveLog };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/panel/capture/live-session.test.ts src/panel/model/store.test.ts`

Verified output from the scratch build of this change:

```
 Test Files  2 passed (2)
      Tests  58 passed (58)
```

Then the whole package plus typecheck and lint:

Run: `pnpm --filter ag-ui-devtools test && pnpm typecheck && pnpm lint`

- [ ] **Step 5: Commit**

`panel: fold sw messages into PanelState (live session, P9)`

---

### Task 13b: Panel live wiring — port, grant, and the controls they light up

**Files:**

- Create: `packages/devtools/src/panel/capture/port.ts`
- Create: `packages/devtools/src/panel/capture/grant.ts`
- Create: `packages/devtools/src/panel/capture/use-live-capture.ts`
- Test: `packages/devtools/src/panel/capture/live-capture.test.tsx`
- Modify: `packages/devtools/src/panel/test-setup.ts`
- Modify: `packages/devtools/src/panel/app.tsx`
- Modify: `packages/devtools/src/panel/app.test.tsx`
- Modify: `packages/devtools/src/panel/shell/toolbar.tsx`
- Modify: `packages/devtools/src/panel/tabs/timeline/event-list.tsx`
- Modify: `packages/devtools/src/panel/panel.css`

- [ ] **Step 1: Write the failing test**

First extend the chrome stub. `packages/devtools/src/panel/test-setup.ts` — add the navigated
event type and factory above `interface ChromeStub`:

```ts
/** The `onNavigated` half of the fake network API — preserve-log-on-navigate hangs off it. */
interface FakeNavigatedEvent {
  addListener: (listener: (url: string) => void) => void;
  removeListener: (listener: (url: string) => void) => void;
  emit: (url: string) => void;
}

function createNavigatedEvent(): FakeNavigatedEvent {
  const listeners = new Set<(url: string) => void>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    emit: (url) => {
      for (const listener of [...listeners]) listener(url);
    },
  };
}
```

In `interface ChromeStub`, replace the `network` line and add `reload` to `inspectedWindow`:

```ts
    network: { onRequestFinished: FakeRequestEvent; onNavigated: FakeNavigatedEvent };
    inspectedWindow: {
      tabId: number;
      reload: () => void;
```

In `chromeStub`, replace the same two spots:

```ts
    network: { onRequestFinished: createRequestEvent(), onNavigated: createNavigatedEvent() },
    inspectedWindow: {
      tabId: 1,
      reload: () => {},
```

and add this note immediately after the `chromeStub` object literal:

```ts
/*
 * `chrome.runtime.connect` and `chrome.permissions` are DELIBERATELY absent from the default
 * stub.
 *
 * Both are guarded on the panel side — `connectToServiceWorker` returns null without a
 * `connect`, and `requestOriginGrant` returns `unavailable` without `permissions` — and those
 * are the branches every test that is not about live capture must take. A default stub would
 * silently open a port in all 320 existing panel tests. A test that wants either installs its
 * own; `src/panel/capture/live-capture.test.tsx` does exactly that.
 */
```

`packages/devtools/src/panel/capture/live-capture.test.tsx` (new file, complete):

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/preact';
import { App } from '../app';
import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import type { PanelCommand, RequestLine, SwMessage } from '../../sw/protocol';
import { createPanelStore } from '../model/store';

/* ------------------------------------------------------------------ fakes */

type Listener<T> = (value: T) => void;

interface FakePort {
  readonly posted: PanelCommand[];
  connected: boolean;
  /** Push a message as if the service worker had sent it. */
  emit: (message: SwMessage) => void;
  /** Drop the port as if the worker had gone away. */
  drop: () => void;
  postMessage: (command: PanelCommand) => void;
  disconnect: () => void;
  onMessage: {
    addListener: (listener: Listener<unknown>) => void;
    removeListener: (listener: Listener<unknown>) => void;
  };
  onDisconnect: {
    addListener: (listener: Listener<void>) => void;
    removeListener: (listener: Listener<void>) => void;
  };
}

function createFakePort(): FakePort {
  const messageListeners = new Set<Listener<unknown>>();
  const disconnectListeners = new Set<Listener<void>>();
  const posted: PanelCommand[] = [];
  const port: FakePort = {
    posted,
    connected: true,
    emit: (message) => {
      for (const listener of [...messageListeners]) listener(message);
    },
    drop: () => {
      port.connected = false;
      for (const listener of [...disconnectListeners]) listener();
    },
    postMessage: (command) => {
      posted.push(command);
    },
    disconnect: () => {
      port.connected = false;
    },
    onMessage: {
      addListener: (listener) => {
        messageListeners.add(listener);
      },
      removeListener: (listener) => {
        messageListeners.delete(listener);
      },
    },
    onDisconnect: {
      addListener: (listener) => {
        disconnectListeners.add(listener);
      },
      removeListener: (listener) => {
        disconnectListeners.delete(listener);
      },
    },
  };
  return port;
}

interface RuntimeWithConnect {
  connect?: (info: { name: string }) => unknown;
}

/** Install a fake port factory and return the port every `connect` hands back. */
function stubPort(): { port: FakePort; names: string[] } {
  const port = createFakePort();
  const names: string[] = [];
  (chrome.runtime as unknown as RuntimeWithConnect).connect = (info) => {
    names.push(info.name);
    return port;
  };
  return { port, names };
}

interface PermissionsStub {
  request: (p: { origins: string[] }) => Promise<boolean>;
  contains: (p: { origins: string[] }) => Promise<boolean>;
}

function stubPermissions(stub: Partial<PermissionsStub>): { requested: string[][] } {
  const requested: string[][] = [];
  const permissions: PermissionsStub = {
    request: async (p) => {
      requested.push(p.origins);
      return (await stub.request?.(p)) ?? false;
    },
    contains: async (p) => (await stub.contains?.(p)) ?? false,
  };
  (chrome as unknown as { permissions?: PermissionsStub }).permissions = permissions;
  return { requested };
}

/** Answer `location.origin` with `origin`, and every other probe with undefined. */
function stubOrigin(origin: string): void {
  chrome.devtools.inspectedWindow.eval = ((
    expression: string,
    callback?: (result: unknown) => void,
  ) => {
    callback?.(expression === 'location.origin' ? origin : undefined);
  }) as typeof chrome.devtools.inspectedWindow.eval;
}

interface NavigatedStub {
  emit: (url: string) => void;
}

function navigated(): NavigatedStub {
  return chrome.devtools.network.onNavigated as unknown as NavigatedStub;
}

afterEach(() => {
  delete (chrome.runtime as unknown as RuntimeWithConnect).connect;
  delete (chrome as unknown as { permissions?: PermissionsStub }).permissions;
});

/* --------------------------------------------------------------- fixtures */

function eventRecord(seq: number, event: AguiEvent, tMs = seq * 10): CaptureRecord {
  return { kind: 'event', seq, tMs, connId: 'c1', raw: event, event, issues: [] };
}

const REQUEST: RequestLine = {
  connId: 'c1',
  tMs: 0,
  method: 'POST',
  url: 'http://localhost:5173/agent',
  input: { threadId: 't1', runId: 'r1', messages: [], tools: [], context: [], state: {} },
};

const RUN_STARTED = eventRecord(0, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' });
const TEXT_START = eventRecord(1, {
  type: 'TEXT_MESSAGE_START',
  messageId: 'm1',
  role: 'assistant',
});
const TEXT_CONTENT = eventRecord(2, {
  type: 'TEXT_MESSAGE_CONTENT',
  messageId: 'm1',
  delta: 'hello',
});

/* ------------------------------------------------------------------ tests */

describe('panel live wiring', () => {
  it('auto-enables a localhost origin and subscribes with the inspected tab id', async () => {
    stubOrigin('http://localhost:5173');
    const { port, names } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);

    await waitFor(() => {
      expect(names).toEqual(['agui-devtools-panel']);
    });
    expect(port.posted[0]).toEqual({ kind: 'subscribe', tabId: 1 });
    expect(store.get().capture).toEqual({ kind: 'on', origin: 'http://localhost:5173' });
    expect(await screen.findByText('Capture is on for http://localhost:5173.')).toBeTruthy();
  });

  it('renders a snapshot and then tails appended records', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({
        kind: 'snapshot',
        records: [RUN_STARTED, TEXT_START],
        requests: [REQUEST],
        droppedBefore: 0,
      });
    });

    expect(await screen.findByRole('option', { name: /seq 0 RUN_STARTED/ })).toBeTruthy();

    act(() => {
      port.emit({ kind: 'append', records: [TEXT_CONTENT] });
    });

    expect(await screen.findByRole('option', { name: /seq 2 TEXT_MESSAGE_CONTENT/ })).toBeTruthy();
    expect(store.get().source).toEqual({ kind: 'live', origin: 'http://localhost:5173' });
  });

  it("surfaces the worker's eviction count in the toolbar (P9)", async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({
        kind: 'snapshot',
        records: [RUN_STARTED],
        requests: [REQUEST],
        droppedBefore: 12,
      });
    });

    expect(await screen.findByText('12 dropped')).toBeTruthy();
  });

  it('activates record/pause and tells the worker', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    const pause = await screen.findByRole('button', { name: 'Pause' });
    expect(pause.hasAttribute('disabled')).toBe(false);
    expect(pause.getAttribute('aria-pressed')).toBe('true');

    pause.click();

    await waitFor(() => {
      expect(port.posted).toContainEqual({ kind: 'set-recording', recording: false });
    });
    expect(store.get().recording).toBe(false);
    expect(await screen.findByRole('button', { name: 'Record' })).toBeTruthy();
  });

  it('clears the worker buffer when the page navigates, unless preserve is on', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      navigated().emit('http://localhost:5173/next');
    });
    expect(port.posted).toContainEqual({ kind: 'clear' });

    const preserve = await screen.findByRole('button', { name: 'Preserve log on navigate' });
    expect(preserve.hasAttribute('disabled')).toBe(false);
    preserve.click();
    await waitFor(() => {
      expect(store.get().preserveLog).toBe(true);
    });

    const before = port.posted.filter((command) => command.kind === 'clear').length;
    act(() => {
      navigated().emit('http://localhost:5173/again');
    });
    expect(port.posted.filter((command) => command.kind === 'clear')).toHaveLength(before);
  });

  it('requests the origin grant from Enable and then offers the reload', async () => {
    stubOrigin('https://app.example.com');
    stubPort();
    const { requested } = stubPermissions({ request: async () => true });
    const store = createPanelStore();

    render(<App store={store} />);

    const enable = await screen.findByRole('button', {
      name: 'Enable capture for https://app.example.com',
    });
    enable.click();

    await waitFor(() => {
      expect(requested).toEqual([['https://app.example.com/*']]);
    });
    expect(store.get().capture).toEqual({ kind: 'on', origin: 'https://app.example.com' });

    const reload = await screen.findByRole('button', { name: 'Reload the inspected page' });
    const spy = vi.spyOn(chrome.devtools.inspectedWindow, 'reload');
    reload.click();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    spy.mockRestore();
  });

  it('says so when the grant is declined', async () => {
    stubOrigin('https://app.example.com');
    stubPort();
    stubPermissions({ request: async () => false });
    const store = createPanelStore();

    render(<App store={store} />);
    const enable = await screen.findByRole('button', {
      name: 'Enable capture for https://app.example.com',
    });
    enable.click();

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Access to this origin was declined'),
    );
    expect(store.get().capture.kind).toBe('off');
  });

  it('auto-enables an origin that was already granted', async () => {
    stubOrigin('https://app.example.com');
    const { names } = stubPort();
    stubPermissions({ contains: async () => true });
    const store = createPanelStore();

    render(<App store={store} />);

    await waitFor(() => {
      expect(store.get().capture).toEqual({ kind: 'on', origin: 'https://app.example.com' });
    });
    // The port opens in the effect that the capture change schedules, one commit later.
    await waitFor(() => {
      expect(names).toEqual(['agui-devtools-panel']);
    });
  });

  it('drops a malformed port message instead of folding it', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({ kind: 'not-a-kind' } as unknown as SwMessage);
      port.emit(null as unknown as SwMessage);
    });

    expect(store.get().records).toEqual([]);
    expect(store.get().loadError).toBeNull();
  });
});
```

`packages/devtools/src/panel/app.test.tsx` — the phase-1 test asserting Enable cannot work is now
false. Replace it in place:

```tsx
  it('says so when there is no chrome.permissions to grant through', async () => {
    // No `chrome.permissions` in the default stub, which is the panel HTML opened outside
    // DevTools. Enable must still say what happened rather than doing nothing visible.
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'off', origin: 'https://app.example', signal: { level: 'stream' } },
    });
    render(<App store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(await screen.findByText(/not running inside DevTools/i)).toBeTruthy();
    expect(store.get().capture.kind).toBe('off');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/panel/capture/live-capture.test.tsx src/panel/app.test.tsx`

Expected: FAIL with `Failed to resolve import "./use-live-capture" from "src/panel/app.tsx"`
(reached through `live-capture.test.tsx`'s import of `../app`), and in `app.test.tsx`
`TestingLibraryElementError: Unable to find an element with the text: /not running inside DevTools/i`.

- [ ] **Step 3: Write the implementation**

`packages/devtools/src/panel/capture/port.ts` (new file, complete):

```ts
/**
 * The panel's port to the service worker.
 *
 * Design §6: this port is also the MV3 keepalive — holding it open is what addresses the ~30s
 * idle termination in requirements §15. So it is opened once for the life of the panel and only
 * closed when the panel unmounts.
 *
 * It makes no request of its own. `chrome.runtime.connect` is intra-extension messaging, not
 * network: requirements §11's no-egress rule is kept structurally, because there is nothing here
 * that could fetch.
 */
import { PANEL_PORT_NAME, type PanelCommand, type SwMessage } from '../../sw/protocol';

export interface PanelPort {
  send(command: PanelCommand): void;
  disconnect(): void;
}

export interface ConnectOptions {
  /** `chrome.devtools.inspectedWindow.tabId` — the tab whose buffer this panel subscribes to. */
  tabId: number;
  onMessage: (message: SwMessage) => void;
  /** Called if the worker goes away. The port is dead at that point and must be reopened. */
  onDisconnect?: () => void;
}

const SW_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  'snapshot',
  'append',
  'request',
  'closed',
  'cleared',
]);

/**
 * Narrow a port payload to `SwMessage`.
 *
 * `Port.onMessage` hands over `unknown`, so *something* has to narrow it, and a cast would be
 * the one place a malformed message could reach the run builder as a `CaptureRecord[]`. This
 * checks the discriminant only: the sender is our own service worker, so the risk being
 * defended against is a version skew between a reloaded extension and a still-open panel, not
 * a hostile peer.
 */
export function asSwMessage(value: unknown): SwMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !SW_MESSAGE_KINDS.has(kind)) return null;
  return value as SwMessage;
}

/**
 * Open the port and subscribe to a tab. Returns `null` when there is no `chrome.runtime` to
 * connect through — the panel HTML is also opened outside DevTools by the screenshot harness,
 * and by every jsdom test that does not stub it.
 */
export function connectToServiceWorker(options: ConnectOptions): PanelPort | null {
  const connect = chrome.runtime?.connect;
  if (typeof connect !== 'function') return null;

  const port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
  let open = true;

  port.onMessage.addListener((raw: unknown) => {
    const message = asSwMessage(raw);
    // Dropped silently and deliberately: a panel that rendered an error for an unrecognised
    // frame would turn a forward-compatible worker into a broken-looking panel.
    if (message !== null) options.onMessage(message);
  });

  port.onDisconnect.addListener(() => {
    open = false;
    options.onDisconnect?.();
  });

  // First thing on the wire. Until the worker knows the tab it has no buffer to replay.
  port.postMessage({ kind: 'subscribe', tabId: options.tabId } satisfies PanelCommand);

  return {
    send: (command) => {
      if (open) port.postMessage(command);
    },
    disconnect: () => {
      if (!open) return;
      open = false;
      port.disconnect();
    },
  };
}
```

`packages/devtools/src/panel/capture/grant.ts` (new file, complete):

```ts
/**
 * The per-origin opt-in of decision D3.
 *
 * The extension ships inert: `manifest.config.ts` declares `optional_host_permissions` and no
 * static remote host, so capture on a non-localhost origin exists only once the user has granted
 * that origin. This is the request, and it is the ONLY thing the panel does about it —
 * registering content scripts for a granted origin is the service worker's job, driven by
 * `chrome.permissions.onAdded`, so no message and no `PanelCommand` is needed for it.
 *
 * `chrome.permissions.request` must be called from a user gesture, which is why this is reached
 * from the Enable button's click handler and never from an effect.
 */

/**
 * The hosts `manifest.config.ts` statically registers content scripts for.
 *
 * D3 auto-enables the localhost family, which is why the harness (design §3, served over
 * localhost) needs no grant at all. Kept in sync with `LOCALHOST_MATCHES` by hand — there is
 * no import path from a manifest config into the panel bundle.
 */
const AUTO_ENABLED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/** True when capture is already available on this origin without asking for anything. */
export function isAutoEnabledOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    // `http:` only, matching the manifest. A match pattern ignores the port, so
    // `http://localhost:5173` is covered by `http://localhost/*` and needs no special case.
    return url.protocol === 'http:' && AUTO_ENABLED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export type GrantOutcome =
  | { kind: 'granted' }
  | { kind: 'denied' }
  /** No `chrome.permissions` to ask — outside DevTools, or a test. */
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * The match pattern for one origin.
 *
 * `chrome.permissions.request` takes match patterns, not origins: a bare `https://example.com`
 * is rejected, and the path component has to be there. Exported because the shape of this
 * string is the difference between a working grant and a silent `false`.
 */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

export async function requestOriginGrant(origin: string): Promise<GrantOutcome> {
  const request = chrome.permissions?.request;
  if (typeof request !== 'function') return { kind: 'unavailable' };

  try {
    const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
    return granted ? { kind: 'granted' } : { kind: 'denied' };
  } catch (error) {
    // A rejected request is a real, reportable outcome — Chrome rejects when the call did not
    // come from a user gesture, and a swallowed rejection would look exactly like a denial.
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Has this origin already been granted? Used on open, so a re-opened panel is not asked twice. */
export async function hasOriginGrant(origin: string): Promise<boolean> {
  const contains = chrome.permissions?.contains;
  if (typeof contains !== 'function') return false;
  try {
    return await chrome.permissions.contains({ origins: [originPattern(origin)] });
  } catch {
    return false;
  }
}
```

`packages/devtools/src/panel/capture/use-live-capture.ts` (new file, complete):

```ts
/**
 * Live capture, wired.
 *
 * Everything Chrome-shaped about the panel's connection to the service worker lives here: the
 * port, the origin grant, the navigation hook, and the two toolbar commands. The fold itself is
 * `./live-session`, which is Chrome-free, so this file holds no logic that a test would want to
 * reach through an API stub.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { PanelStore } from '../model/store';
import { captureOn, setRecording as setRecordingAction } from '../model/store';
import { usePanelState } from '../model/use-panel-state';
import { createLiveSession, type LiveSession } from './live-session';
import { connectToServiceWorker, type PanelPort } from './port';
import { hasOriginGrant, isAutoEnabledOrigin, requestOriginGrant, type GrantOutcome } from './grant';

/**
 * What the last Enable attempt did. `null` until the user presses it.
 *
 * The panel must SAY what happened. An Enable button that resolves to `denied` and shows
 * nothing is indistinguishable from a broken one, which is the failure the whole capture banner
 * exists to prevent.
 */
export type EnableStatus = GrantOutcome | null;

export interface LiveCapture {
  /** Request the origin grant and turn capture on. Call from a click — Chrome requires it. */
  enable: () => void;
  setRecording: (recording: boolean) => void;
  /** Tell the worker to drop this tab's buffer. Paired with the toolbar's Clear. */
  clearBuffer: () => void;
  /** Reload the inspected page, which is what makes the capture hooks install. */
  reloadInspectedPage: () => void;
  status: EnableStatus;
  /** True once the grant succeeded and the page has not been reloaded from here yet. */
  awaitingReload: boolean;
}

function inspectedTabId(): number | null {
  const tabId = chrome.devtools?.inspectedWindow?.tabId;
  return typeof tabId === 'number' ? tabId : null;
}

export function useLiveCapture(store: PanelStore): LiveCapture {
  const state = usePanelState(store);
  const [status, setStatus] = useState<EnableStatus>(null);
  const [awaitingReload, setAwaitingReload] = useState(false);

  const sessionRef = useRef<LiveSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createLiveSession({ expandChunks: store.get().expandChunks });
  }
  const portRef = useRef<PanelPort | null>(null);

  const capture = state.capture;
  const captureOnFor = capture.kind === 'on' ? capture.origin : null;

  /*
   * Turn capture on where it is already available, without asking.
   *
   * Two cases, and both would otherwise leave a working origin behind an Enable button that
   * does nothing new: D3 statically registers the localhost family (which is exactly what the
   * harness serves over), and an origin granted in an earlier session is still granted.
   */
  useEffect(() => {
    if (capture.kind !== 'off') return;
    const { origin } = capture;
    if (isAutoEnabledOrigin(origin)) {
      store.update((s) => captureOn(s, origin));
      return;
    }
    let live = true;
    void hasOriginGrant(origin).then((granted) => {
      if (live && granted) store.update((s) => captureOn(s, origin));
    });
    return () => {
      live = false;
    };
  }, [store, capture]);

  // One port for the life of the capture-on state — design §6: holding it open is the MV3
  // keepalive, so it must NOT be reopened per message or per recording change.
  useEffect(() => {
    if (captureOnFor === null) return;
    const tabId = inspectedTabId();
    if (tabId === null) return;

    const port = connectToServiceWorker({
      tabId,
      onMessage: (message) => {
        const session = sessionRef.current;
        if (session === null) return;
        store.update((s) => session.apply(s, message));
      },
      onDisconnect: () => {
        portRef.current = null;
      },
    });
    portRef.current = port;
    // The worker's default is to buffer; only a paused panel has to say otherwise, and it has
    // to say so again on every fresh connection because the worker does not remember.
    if (!store.get().recording) port?.send({ kind: 'set-recording', recording: false });

    return () => {
      port?.disconnect();
      portRef.current = null;
    };
  }, [store, captureOnFor]);

  /*
   * Preserve log on navigate.
   *
   * `preserveLog` is read through a ref rather than listed as a dependency: re-subscribing the
   * navigation listener every time the toggle flips is pointless churn, and `onNavigated` is
   * the one event whose handler must survive unchanged across a run.
   */
  const preserveLogRef = useRef(state.preserveLog);
  preserveLogRef.current = state.preserveLog;
  useEffect(() => {
    const event = chrome.devtools?.network?.onNavigated;
    if (event === undefined || captureOnFor === null) return;
    const listener = (): void => {
      if (preserveLogRef.current) return;
      // Clearing the worker is enough: it answers with `cleared`, which is what empties the
      // panel. Clearing locally as well would show an empty list a beat before the worker
      // agreed, and the two ends could then disagree if the message never arrived.
      portRef.current?.send({ kind: 'clear' });
    };
    event.addListener(listener);
    return () => {
      event.removeListener(listener);
    };
  }, [captureOnFor]);

  // Expand chunks on a LIVE capture. `App`'s effect covers the imported case by re-decoding the
  // retained bytes; there are no bytes here, so the session re-folds its retained records.
  const expandChunks = state.expandChunks;
  const appliedExpandChunks = useRef(expandChunks);
  const isLive = state.source.kind === 'live';
  useEffect(() => {
    if (appliedExpandChunks.current === expandChunks) return;
    appliedExpandChunks.current = expandChunks;
    const session = sessionRef.current;
    if (session === null || !isLive) return;
    store.update((s) => session.refold(s, { expandChunks }));
  }, [store, expandChunks, isLive]);

  const enable = useCallback(() => {
    if (capture.kind !== 'off') return;
    const { origin } = capture;
    void requestOriginGrant(origin).then((outcome) => {
      setStatus(outcome);
      if (outcome.kind !== 'granted') return;
      setAwaitingReload(true);
      store.update((s) => captureOn(s, origin));
    });
  }, [store, capture]);

  const setRecording = useCallback(
    (recording: boolean) => {
      store.update((s) => setRecordingAction(s, recording));
      portRef.current?.send({ kind: 'set-recording', recording });
    },
    [store],
  );

  /*
   * Clear both ends.
   *
   * The session is restarted locally rather than waiting for the worker's `cleared` echo,
   * because Clear must work with no worker at all — on an imported capture the toolbar's
   * button is the only thing that empties the panel, and there is no port to answer.
   */
  const clearBuffer = useCallback(() => {
    sessionRef.current?.restart();
    portRef.current?.send({ kind: 'clear' });
  }, []);

  const reloadInspectedPage = useCallback(() => {
    setAwaitingReload(false);
    chrome.devtools?.inspectedWindow?.reload?.();
  }, []);

  return { enable, setRecording, clearBuffer, reloadInspectedPage, status, awaitingReload };
}
```

`packages/devtools/src/panel/app.tsx` — five edits.

1. Replace the first two import lines:

```tsx
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PanelStore } from './model/store';
import { raiseSignal, selectTab, setCapture, setFramework } from './model/store';
import { useLiveCapture, type EnableStatus } from './capture/use-live-capture';
```

2. Insert above `interface RetainedSource`:

```tsx
/**
 * Why Enable did not turn capture on.
 *
 * Each branch names the actual cause. "Something went wrong" would put the user back where the
 * capture banner started them — unable to tell a refusal from a broken extension.
 */
function enableFailure(status: Exclude<EnableStatus, null>): string {
  switch (status.kind) {
    case 'denied':
      return 'Access to this origin was declined, so capture stayed off. Press Enable again to retry, or import a .agui.jsonl capture from the Session tab.';
    case 'unavailable':
      return 'This panel is not running inside DevTools, so there is no origin to grant. Import a .agui.jsonl capture from the Session tab instead.';
    case 'error':
      return `Chrome refused the permission request: ${status.message}`;
    case 'granted':
      return '';
  }
}
```

3. Replace the `enableBlocked` state with the hook:

```tsx
  const state = usePanelState(store);
  const live = useLiveCapture(store);
```

4. Replace the `Toolbar` element:

```tsx
        <Toolbar
          store={store}
          onImport={() => store.update((s) => selectTab(s, 'session'))}
          onSetRecording={live.setRecording}
          onClear={live.clearBuffer}
        />
```

5. Replace the `CaptureBanner` element and the `enableBlocked` note that follows it:

```tsx
      <CaptureBanner store={store} onEnable={live.enable} />

      {/*
       * What Enable did, and what to do next.
       *
       * The grant is only half of turning capture on: the hooks install ahead of the page's own
       * scripts, so nothing is captured until the page reloads. A panel that granted and then
       * sat there would look broken to a user watching an already-running page — which is
       * exactly the failure the capture banner's reload note exists to prevent, so the button
       * is offered here rather than leaving the user to find it.
       */}
      {live.awaitingReload && (
        <p class="agui-app__note" role="status">
          Capture is on. It takes effect on the next page load — the hooks install before the
          page&rsquo;s own scripts run.{' '}
          <button type="button" class="agui-app__note-action" onClick={live.reloadInspectedPage}>
            Reload the inspected page
          </button>
        </p>
      )}

      {live.status !== null && live.status.kind !== 'granted' && (
        <p class="agui-app__note" role="alert">
          {enableFailure(live.status)}
        </p>
      )}
```

`packages/devtools/src/panel/shell/toolbar.tsx` — five edits.

1. Replace the store import:

```tsx
import {
  setTextFilter,
  toggleExpandChunks,
  toggleIssuesOnly,
  togglePreserveLog,
} from '../model/store';
```

2. Add two props to `ToolbarProps`, after `onImport`:

```tsx
  /**
   * Record/pause. Not a store action, because pausing has to reach the service worker as well
   * as the state — a paused panel that let the worker keep buffering would resume by dumping
   * everything it missed, which is not what Pause means.
   *
   * Optional so the control is still constructible where capture is not: the button is
   * disabled whenever capture is not `on`, so an absent callback is unreachable.
   */
  onSetRecording?: (recording: boolean) => void;
  /**
   * Called after Clear has reset panel state, so the host can clear the service worker's buffer
   * too. Without it the two ends disagree: the panel would be empty while the worker still held
   * the records, and the next snapshot — a reconnect, a reopened panel — would resurrect them.
   */
  onClear?: () => void;
```

3. Replace the last paragraph of the `Toolbar` doc comment and the signature and first lines:

```tsx
 * Record and preserve-on-navigate are live once capture is on, and disabled with a reason when
 * it is not. Disabled-with-a-reason rather than hidden: a control that vanishes reads as a
 * missing feature, and one that is present but inert with no explanation reads as a bug.
 */
export function Toolbar({ store, onImport, onSetRecording, onClear }: ToolbarProps): JSX.Element {
  const state = usePanelState(store);
  const counts = issueCounts(state);
  const tone = issueTone(counts);
  const captureIsOn = state.capture.kind === 'on';
  const recording = captureIsOn && state.recording;
  const hasData = state.source.kind !== 'empty' || state.records.length > 0 || state.runs.length > 0;
```

4. Replace the Record button and the Clear button's `onClick`:

```tsx
      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={recording}
        disabled={!captureIsOn}
        title={
          captureIsOn
            ? 'Stop or resume buffering events for this tab'
            : 'Enable capture for this origin first — or import a .agui.jsonl to inspect a stream'
        }
        onClick={() => onSetRecording?.(!state.recording)}
      >
        {recording ? 'Pause' : 'Record'}
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        disabled={!hasData}
        onClick={() => {
          // No `clearCapture` action exists; a reset to the initial state is exactly what clear
          // means. Capture status, source, record/pause and preserve-log survive: they describe
          // the inspected page and the session's settings, not the data being discarded.
          store.update((s) => ({
            ...initialPanelState(),
            capture: s.capture,
            source: s.source.kind === 'live' ? s.source : { kind: 'empty' },
            recording: s.recording,
            preserveLog: s.preserveLog,
          }));
          onClear?.();
        }}
      >
        Clear
      </button>
```

5. Replace the preserve-on-navigate button:

```tsx
      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={state.preserveLog}
        disabled={!captureIsOn}
        title={
          captureIsOn
            ? 'Keep captured events when the inspected page navigates'
            : 'Applies to live capture, which is off for this origin'
        }
        onClick={() => store.update(togglePreserveLog)}
      >
        Preserve log on navigate
      </button>
```

`packages/devtools/src/panel/tabs/timeline/event-list.tsx` — two edits.

1. After the `focusSeqRef` declaration:

```tsx
  /** P6 applies to a live, recording capture: a paused one has nothing arriving to tail. */
  const follow = state.source.kind === 'live' && state.recording;
```

2. Add the prop to `VirtualList`, directly after `scrollNonce`:

```tsx
          /*
           * P6: tail a live capture, and only a live one. An imported file is complete the
           * moment it loads, so following it would do nothing but fight a user who scrolled.
           * The list stops following as soon as the user scrolls up — `VirtualList` owns that
           * rule, so this prop is the whole of the wiring.
           */
          follow={follow}
```

`packages/devtools/src/panel/panel.css` — the note now contains a button. Replace the comment
above `.agui-app__note` and add the action rule after it:

```css
/* The panel's own status line — what Enable did, and the reload it now needs. */
.agui-app__note {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--agui-border);
  background: var(--agui-surface);
  color: var(--agui-fg-muted);
}

/* Matches .agui-banner__action, minus its top margin: this one sits inline in a sentence. */
.agui-app__note-action {
  font: inherit;
  padding: 1px 8px;
  border: 1px solid var(--agui-accent);
  border-radius: 3px;
  background: var(--agui-surface-raised);
  color: var(--agui-accent);
  cursor: pointer;
}

.agui-app__note-action:hover {
  background: var(--agui-hover);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/panel/capture/live-capture.test.tsx src/panel/app.test.tsx`

Verified output from the scratch build of this change:

```
 Test Files  2 passed (2)
      Tests  30 passed (30)
```

Then the whole package: `pnpm --filter ag-ui-devtools test`

Verified output from the scratch build of Tasks 13a + 13b together — 675 tests in 40 files today,
699 in 42 after:

```
 Test Files  42 passed (42)
      Tests  699 passed (699)
```

Then: `pnpm typecheck && pnpm lint && pnpm build && pnpm verify:build && pnpm screenshot:panel`

The visual gate is not optional here: this task adds a button (`.agui-app__note-action`) to a
band that had none, and an unstyled control in that band is exactly the class of regression the
gate exists for.

- [ ] **Step 5: Commit**

`panel: connect to the service worker, grant origins, tail live runs (P6, P9, P11)`

---

### Task 14: `packages/harness/record.ts` — Tier B recording, redacted

Tier A is authored fixtures and is the CI corpus. Tier B is the only thing that can tell us Tier A
is wrong (design §7). It runs by hand, against the AG-UI Dojo, and **H7 is enforced in code**:
`src/core/jsonl/redact.ts` — 17 tests, zero production consumers until now — is what every
recorded event passes through, and a gate refuses to write anything that survived it unredacted.

Target is `~/repos/ag-ui/apps/dojo`, driven by `OPENAI_API_KEY` from the root `.env`, not
production. Requirements §11 makes avoiding real user content strictly better than redacting it,
and the Dojo has no real users. The upstream path is derived, not guessed:
`@copilotkitnext/runtime` mounts `POST /agent/:agentId/run`; the Dojo mounts that app at
`/api/copilotkitnext/<integrationId>`; and its route registers
`BuiltInAgent({ model: 'openai/gpt-5-mini' })` as `default` for any integrationId it does not
recognise. So `http://localhost:3000/api/copilotkitnext/builtin/agent/default/run` needs the key
and nothing else — no Python backend, no Mastra store, no second process.

**Alternative, documented and deliberately not wired:** the Threadplane LangGraph backend at
`examples/ag-ui/python`. It is closer to a production deployment and would answer the protobuf
question of requirements §5.4 more convincingly, but it needs its own Python environment and its
own credentials, and it is not an MIT-neutral target for this repo. Point `--upstream` at it when
that trade is worth making; nothing in `record.ts` is Dojo-specific.

**Files:**

- Create: `packages/harness/record.ts`
- Test: `packages/harness/record.test.ts`
- Modify: `packages/harness/package.json`
- Modify: `packages/harness/README.md`

- [ ] **Step 1: Write the failing test**

`packages/harness/record.test.ts` (new file, complete). It stands up a local HTTP server emitting
a canned SSE stream carrying unmistakable text, proxies it through a real `AGUIMock`, and asserts
the committed fixture is clean. No key, no upstream, no cost — decision H2 applied to the
recorder itself.

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leakedValues, recordOnce, redactRecordedEvents, toCommittableFixture } from './record';

/**
 * A stand-in for a real agent. Emits the same SSE shape a real one does, carrying text that is
 * unmistakable if it survives — which is the whole point: this exercises the H7 gate without a
 * key, without network egress, and without spending money (design decision H2).
 */
const SECRET_TEXT = 'my bank account number is 12345678';
const SECRET_ARGS = '{"ssn":"078-05-1120"}';
const SECRET_STATE = 'patient-record-alpha';

const UPSTREAM_EVENTS: unknown[] = [
  { type: 'RUN_STARTED', threadId: 't_up', runId: 'r_up' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: SECRET_TEXT },
  { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
  { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'lookup' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: SECRET_ARGS },
  { type: 'TOOL_CALL_END', toolCallId: 'tc1' },
  { type: 'STATE_SNAPSHOT', snapshot: { chart: SECRET_STATE, count: 3 } },
  { type: 'RUN_FINISHED', threadId: 't_up', runId: 'r_up' },
];

let upstream: Server | null = null;
let outDir: string | null = null;

async function startUpstream(events: readonly unknown[]): Promise<string> {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream = server;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no upstream port');
  return `http://127.0.0.1:${String(address.port)}/agent/default/run`;
}

afterEach(async () => {
  if (upstream !== null) {
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    upstream = null;
  }
  if (outDir !== null) {
    await rm(outDir, { recursive: true, force: true });
    outDir = null;
  }
});

describe('redactRecordedEvents', () => {
  it('replaces payloads and keeps structure', () => {
    const [text] = redactRecordedEvents([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: SECRET_TEXT },
    ]);

    expect(text).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: `«redacted: ${String(SECRET_TEXT.length)} chars»`,
    });
  });

  it('leaves lifecycle events alone', () => {
    const event = { type: 'RUN_STARTED', threadId: 't_up', runId: 'r_up' };
    expect(redactRecordedEvents([event])[0]).toEqual(event);
  });
});

describe('leakedValues', () => {
  it('finds nothing in a properly redacted stream', () => {
    expect(leakedValues(UPSTREAM_EVENTS, redactRecordedEvents(UPSTREAM_EVENTS))).toEqual([]);
  });

  it('catches a payload that was not redacted', () => {
    // Exactly what a regression in redact.ts would look like: everything else clean, one field
    // through untouched.
    const half = redactRecordedEvents(UPSTREAM_EVENTS).map((event, index) =>
      index === 2 ? UPSTREAM_EVENTS[2] : event,
    );
    expect(leakedValues(UPSTREAM_EVENTS, half)).toEqual([SECRET_TEXT]);
  });
});

describe('toCommittableFixture', () => {
  it('keys the fixture on the authored prompt, not the recorded match', () => {
    const fixture = toCommittableFixture(
      { match: { message: 'whatever the recorder captured' }, events: [] },
      'what is AG-UI?',
    );
    expect(fixture.match).toEqual({ message: 'what is AG-UI?' });
  });
});

describe('recordOnce', () => {
  it('records through the proxy and commits only redacted events', async () => {
    const upstreamUrl = await startUpstream(UPSTREAM_EVENTS);
    outDir = await mkdtemp(join(tmpdir(), 'agui-record-out-'));
    const outFile = join(outDir, 'nested', 'fake-agent.json');

    const result = await recordOnce({
      upstream: upstreamUrl,
      prompt: 'what is AG-UI?',
      outFile,
    });

    expect(result.eventCount).toBe(UPSTREAM_EVENTS.length);
    expect(result.eventTypes).toContain('TOOL_CALL_ARGS');

    const written = await readFile(outFile, 'utf-8');
    expect(written).not.toContain(SECRET_TEXT);
    expect(written).not.toContain(SECRET_ARGS);
    expect(written).not.toContain(SECRET_STATE);
    expect(written).toContain('«redacted:');
    // Structure survives, which is what makes the fixture replayable at all.
    expect(written).toContain('"RUN_STARTED"');
    expect(written).toContain('"chart"');
    expect(JSON.parse(written)).toMatchObject({
      fixtures: [{ match: { message: 'what is AG-UI?' } }],
    });
  }, 20_000);

  it('leaves no unredacted recording on disk', async () => {
    const upstreamUrl = await startUpstream(UPSTREAM_EVENTS);
    outDir = await mkdtemp(join(tmpdir(), 'agui-record-out-'));
    const before = new Set(await listTemp());

    await recordOnce({
      upstream: upstreamUrl,
      prompt: 'what is AG-UI?',
      outFile: join(outDir, 'fake-agent.json'),
    });

    const after = (await listTemp()).filter((name) => !before.has(name));
    expect(after).toEqual([]);
  }, 20_000);
});

async function listTemp(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(tmpdir())).filter((name) => name.startsWith('agui-record-'));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ag-ui-harness test`

Expected: FAIL with `Error: Failed to load url ./record (resolved id: ./record) ... Does the file exist?`

- [ ] **Step 3: Write the implementation**

`packages/harness/record.ts` (new file, complete):

```ts
/**
 * Tier B recording — put a recorder in front of a real AG-UI agent and keep what it says.
 *
 * Design §7: this is the highest-value part of the harness, because it is the only thing that
 * can tell us the hand-written Tier A fixtures are wrong. It is also the only part that ever
 * sees real model output, which is why H7 makes redaction mandatory rather than advisory:
 * nothing recorded here reaches `fixtures/` without passing through
 * `src/core/jsonl/redact.ts` first.
 *
 * H8: the key never enters CI. This file is run by hand, occasionally, and CI only replays what
 * it committed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGUIMock } from '@copilotkit/aimock';
import type { JsonlEvent } from '../devtools/src/core/jsonl/codec';
import { ALL_REDACTION_GROUPS, redactLine } from '../devtools/src/core/jsonl/redact';

/* ------------------------------------------------------------------ shapes */

/** What aimock writes: `{ fixtures: [{ match, events, delayMs? }] }`. */
export interface RecordedMatch {
  message?: string;
  toolCallId?: string;
  toolName?: string;
  stateKey?: string;
}

export interface RecordedFixture {
  match: RecordedMatch;
  events: unknown[];
  delayMs?: number;
}

export interface RecordedFixtureFile {
  fixtures: RecordedFixture[];
}

/* -------------------------------------------------------------- redaction */

/**
 * Run one recorded event through `redactLine`.
 *
 * The event is wrapped as a `JsonlEvent` because that is the unit `redact.ts` operates on — it
 * redacts a capture line, not a bare event. The wrapper's `seq`/`tMs`/`connId` are structure,
 * never written anywhere, and `redactLine` returns them untouched.
 */
function redactEvent(event: unknown): unknown {
  const line: JsonlEvent = { kind: 'event', connId: 'rec', seq: 0, tMs: 0, event };
  const redacted = redactLine(line, [...ALL_REDACTION_GROUPS]);
  return redacted.kind === 'event' ? redacted.event : event;
}

/** Every recorded event, redacted. All five groups — a recording gets no exemptions. */
export function redactRecordedEvents(events: readonly unknown[]): unknown[] {
  return events.map((event) => redactEvent(event));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every string leaf under `value`, however deeply nested. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
}

/**
 * The payload strings one event carries, by event type.
 *
 * This deliberately RESTATES requirements §11's five groups rather than importing anything from
 * `redact.ts`. A check that shares its subject's definition of the answer verifies nothing; this
 * one fails if `redact.ts` ever stops covering a field it covers today — which matters more here
 * than anywhere, because `redact.ts` has no other production consumer to notice.
 */
function payloadStrings(event: unknown): string[] {
  if (!isObject(event)) return [];
  const out: string[] = [];
  const type = typeof event.type === 'string' ? event.type : '';
  switch (type) {
    case 'TEXT_MESSAGE_CONTENT':
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CONTENT':
    case 'REASONING_MESSAGE_CHUNK':
    case 'TOOL_CALL_ARGS':
    case 'TOOL_CALL_CHUNK':
      stringLeaves(event.delta, out);
      break;
    case 'TOOL_CALL_RESULT':
      stringLeaves(event.content, out);
      break;
    case 'REASONING_ENCRYPTED_VALUE':
      stringLeaves(event.encryptedValue, out);
      break;
    case 'STATE_SNAPSHOT':
      stringLeaves(event.snapshot, out);
      break;
    case 'STATE_DELTA':
      if (Array.isArray(event.delta)) {
        for (const op of event.delta) if (isObject(op)) stringLeaves(op.value, out);
      }
      break;
    default:
      break;
  }
  // Two characters cannot identify anyone, and a stream is full of them — `delta: "I"` would
  // match half the file's structure and fail every recording for nothing. The length of a short
  // delta survives redaction by design anyway.
  return out.filter((text) => text.trim().length >= 3);
}

/**
 * Payload strings from `raw` that still appear verbatim in `redacted`. Empty means clean.
 *
 * This is the gate `main` refuses to write past. A recording that trips it is a redaction bug,
 * not a bad recording, and the right response is to fix `redact.ts` rather than to commit.
 */
export function leakedValues(raw: readonly unknown[], redacted: readonly unknown[]): string[] {
  const haystack = JSON.stringify(redacted);
  const leaks = new Set<string>();
  for (const event of raw) {
    for (const text of payloadStrings(event)) {
      if (haystack.includes(text)) leaks.add(text);
    }
  }
  return [...leaks];
}

/* ---------------------------------------------------------------- parsing */

export function parseRecordedFile(text: string): RecordedFixtureFile {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed) || !Array.isArray(parsed.fixtures)) {
    throw new Error('Recorded file has no `fixtures` array — aimock did not write a fixture.');
  }
  const fixtures = parsed.fixtures.map((entry, index) => {
    if (!isObject(entry) || !Array.isArray(entry.events)) {
      throw new Error(`Recorded fixture ${String(index)} has no \`events\` array.`);
    }
    return {
      match: isObject(entry.match) ? (entry.match as RecordedMatch) : {},
      events: entry.events,
    };
  });
  return { fixtures };
}

/**
 * Turn a recorded fixture into a committable one.
 *
 * The `match` is replaced with the prompt this run actually sent rather than kept from the
 * recording. Two reasons: it is authored text we already have, so nothing about the match is a
 * guess; and aimock keys `match.message` on the last user message, which on a recording from a
 * shared machine is the one field most likely to carry something personal.
 */
export function toCommittableFixture(fixture: RecordedFixture, prompt: string): RecordedFixture {
  return { match: { message: prompt }, events: redactRecordedEvents(fixture.events) };
}

/* -------------------------------------------------------------- recording */

export interface RecordOptions {
  /** The real AG-UI endpoint to sit in front of. */
  upstream: string;
  /** The user message to send. Authored, never taken from anything personal. */
  prompt: string;
  /** Where the redacted fixture is written. */
  outFile: string;
}

export interface RecordResult {
  outFile: string;
  eventCount: number;
  eventTypes: string[];
}

/**
 * Record one run and write the redacted fixture.
 *
 * The raw recording lands in a temp directory that is removed in a `finally`, so unredacted
 * model output never survives the process even if the redaction gate throws.
 */
export async function recordOnce(options: RecordOptions): Promise<RecordResult> {
  const rawDir = await mkdtemp(join(tmpdir(), 'agui-record-'));
  const mock = new AGUIMock({ port: 0 });
  mock.enableRecording({ upstream: options.upstream, fixturePath: rawDir });
  const url = await mock.start();

  try {
    const threadId = `t_${randomUUID().slice(0, 8)}`;
    const runId = `r_${randomUUID().slice(0, 8)}`;
    // The request shape measured on a real deployment (verified fact 5): POST, JSON body,
    // `Accept: text/event-stream`.
    const response = await fetch(new URL('/', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId,
        runId,
        messages: [{ id: 'u1', role: 'user', content: options.prompt }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Upstream returned ${String(response.status)}. Is ${options.upstream} running, and does it have a model key?`,
      );
    }
    // Drain: the fixture is written when the upstream stream ends, so the read has to finish
    // before the temp directory is inspected.
    await response.text();

    const written = (await readdir(rawDir)).filter((name) => name.endsWith('.json')).sort();
    const newest = written.at(-1);
    if (newest === undefined) {
      throw new Error(
        'Nothing was recorded. aimock only records a run it did not already have a fixture for.',
      );
    }

    const parsed = parseRecordedFile(await readFile(join(rawDir, newest), 'utf-8'));
    const recorded = parsed.fixtures[0];
    if (recorded === undefined) throw new Error('Recorded file held an empty `fixtures` array.');

    const committable = toCommittableFixture(recorded, options.prompt);

    // H7, enforced rather than trusted.
    const leaks = leakedValues(recorded.events, committable.events);
    if (leaks.length > 0) {
      throw new Error(
        `Redaction gate failed: ${String(leaks.length)} payload string(s) survived redact.ts. ` +
          'Nothing was written. Fix src/core/jsonl/redact.ts before recording again.',
      );
    }

    await mkdir(dirname(options.outFile), { recursive: true });
    await writeFile(
      options.outFile,
      `${JSON.stringify({ fixtures: [committable] }, null, 2)}\n`,
      'utf-8',
    );

    const eventTypes = [
      ...new Set(
        committable.events.map((event) =>
          isObject(event) && typeof event.type === 'string' ? event.type : 'unknown',
        ),
      ),
    ];
    return { outFile: options.outFile, eventCount: committable.events.length, eventTypes };
  } finally {
    await mock.stop();
    // The unredacted recording does not outlive the process. Requirements §11.
    await rm(rawDir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------- CLI */

/**
 * The AG-UI Dojo's endpoint for an integration with no backend of its own.
 *
 * Derived, not guessed. `@copilotkitnext/runtime` mounts `POST /agent/:agentId/run`, the Dojo
 * mounts that app at `/api/copilotkitnext/<integrationId>`, and its route falls back to
 * `BuiltInAgent({ model: 'openai/gpt-5-mini' })` registered as `default` for an integrationId it
 * does not recognise. So this path needs `OPENAI_API_KEY` and nothing else — no Python backend,
 * no Mastra store, no second process.
 */
const DOJO_UPSTREAM = 'http://localhost:3000/api/copilotkitnext/builtin/agent/default/run';

const USAGE = `Usage: pnpm --filter ag-ui-harness record -- [options]

  --upstream <url>   AG-UI endpoint to record from
                     (default: ${DOJO_UPSTREAM})
  --prompt <text>    the user message to send
  --name <slug>      fixture name, written to fixtures/recorded/<slug>.json

Start the Dojo first, with the key from this repo's .env:

  set -a && . /path/to/ag-ui-chrome-extension/.env && set +a
  cd ~/repos/ag-ui/apps/dojo && npm run dev
`;

function arg(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  // Node reads `.env` itself; there is no dotenv dependency and no key in any committed file.
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
  } catch {
    // Absent `.env` is not fatal here — the key belongs to the upstream's process, not this one.
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in — the Dojo needs it,\n' +
        'and CI never does (design decision H8).\n',
    );
    console.error(USAGE);
    return 1;
  }

  const name = arg(argv, '--name') ?? 'recorded-run';
  const prompt = arg(argv, '--prompt') ?? 'In one short sentence, what is the AG-UI protocol?';
  const upstream = arg(argv, '--upstream') ?? DOJO_UPSTREAM;
  const outFile = new URL(`../fixtures/recorded/${name}.json`, import.meta.url).pathname;

  const result = await recordOnce({ upstream, prompt, outFile });
  console.log(`Recorded ${String(result.eventCount)} events from ${upstream}`);
  console.log(`Event types: ${result.eventTypes.join(', ')}`);
  console.log(`Redacted fixture written to ${result.outFile}`);
  console.log('Review it before committing — redaction preserves structure, not content.');
  return 0;
}

// `process.argv[1]` is this file only when it was executed directly, so importing the module
// from a test never starts a server.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
```

`packages/harness/package.json` — add the `record` script alongside the ones the harness already
has:

```json
    "record": "tsx record.ts"
```

`packages/harness/README.md` — append:

```md
## Tier B: recording from a real agent

Local only. The key never enters CI (design decision H8), and every recorded event passes
through `packages/devtools/src/core/jsonl/redact.ts` before it is written (H7). `record.ts`
refuses to write a fixture at all if any payload string survived redaction.

1. Put `OPENAI_API_KEY` in the repo-root `.env` (see `.env.example`). It is gitignored.
2. Start the AG-UI Dojo with that key in its environment:

       set -a && . "$(git rev-parse --show-toplevel)/.env" && set +a
       cd ~/repos/ag-ui/apps/dojo && npm run dev

3. Record:

       pnpm --filter ag-ui-harness record -- --name dojo-agentic-chat \
         --prompt "In one short sentence, what is the AG-UI protocol?"

The fixture lands in `fixtures/recorded/<name>.json`. **Read it before committing** — redaction
preserves structure, ids, ordering and timings, and replaces content with
`«redacted: N chars»`. It does not, and cannot, decide that some content was fine to keep.

`--upstream` points anywhere. The Threadplane LangGraph backend (`examples/ag-ui/python`) is the
more production-like target and would answer the protobuf question of requirements §5.4 more
convincingly; it needs its own Python environment and credentials, so it is documented here
rather than wired.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ag-ui-harness test`

Verified output from the scratch build of this change, against a real `AGUIMock` proxying a real
local SSE server:

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

Then `pnpm typecheck && pnpm lint` at the root.

**The real Tier B run** — by hand, with the key, and never in CI:

Run: `pnpm --filter ag-ui-harness record -- --name dojo-agentic-chat --prompt "In one short sentence, what is the AG-UI protocol?"`

Expected on success, four lines:

```
Recorded <n> events from http://localhost:3000/api/copilotkitnext/builtin/agent/default/run
Event types: RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED
Redacted fixture written to <repo>/packages/harness/fixtures/recorded/dojo-agentic-chat.json
Review it before committing — redaction preserves structure, not content.
```

Expected with no key: exit 1 and `OPENAI_API_KEY is not set.` followed by the usage block.
Expected with the Dojo not running: `Upstream returned 502.` — aimock synthesizes a 502 when it
cannot reach the upstream.

Then confirm the committed file by eye:

Run: `grep -c '«redacted:' packages/harness/fixtures/recorded/dojo-agentic-chat.json`

Expected: a non-zero count, and no readable model prose anywhere in the file.

- [ ] **Step 5: Commit**

`harness: record Tier B fixtures through redact.ts (H7, H8)`

---

### Task 15: CI — run the harness e2e against a freshly built `dist/`

Every gate in CI today is blind to whether the extension CAPTURES: `inject/`, `relay/` and the
service worker run in a real browser or not at all. This adds the one step that watches them,
after the existing gates, reusing the Playwright install the visual gate already pays for.

No new action is introduced — `actions/checkout@v7`, `pnpm/action-setup@v6`,
`actions/setup-node@v7`, `actions/cache@v6` and `softprops/action-gh-release@v3` are all already
in this workflow and unchanged.

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` (root)

- [ ] **Step 1: Write the failing test**

The gate here is the workflow itself, so the test is a linter run plus a local reproduction of
what CI will do. Add the root script first, because the workflow calls it.

`package.json` (root) — add to `scripts`, after `screenshot:panel`:

```json
    "test:e2e": "pnpm --filter ag-ui-harness run test:e2e"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm test:e2e`

Expected: FAIL — before the workflow change the local machine has no full Chromium installed for
this Playwright version, and Playwright reports
`browserType.launchPersistentContext: Executable doesn't exist at ~/.cache/ms-playwright/chromium-*/chrome-*`
with the hint `Please run the following command to download new browsers: npx playwright install`.

- [ ] **Step 3: Write the implementation**

`.github/workflows/ci.yml` — four edits inside the `verify` job.

1. Replace the "Resolve the Playwright version" step:

```yaml
      #
      # Two packages now drive a browser — `ag-ui-devtools` for the visual gate and
      # `ag-ui-harness` for the capture e2e — out of ONE cached browser directory. That only
      # works while they agree on the version, so the disagreement is made loud here rather than
      # left to surface as "executable doesn't exist" halfway down the job.
      - name: Resolve the Playwright version
        id: playwright
        run: |
          version="$(pnpm --filter ag-ui-devtools exec playwright --version | awk '{print $2}')"
          harness="$(pnpm --filter ag-ui-harness exec playwright --version | awk '{print $2}')"
          if [ "$version" != "$harness" ]; then
            echo "Playwright version mismatch: devtools $version, harness $harness." >&2
            echo "One cached browser serves both packages; pin them to the same version." >&2
            exit 1
          fi
          echo "version=$version" >> "$GITHUB_OUTPUT"
```

2. Replace the cache step, bumping the key:

```yaml
      # Keyed on Playwright's own version, not the lockfile hash: Playwright pins the exact
      # Chromium build it can drive, so a cache entry is only reusable while that version is
      # unchanged. No `restore-keys` for the same reason — a prefix match here would restore a
      # Chromium the installed Playwright refuses to launch.
      #
      # The `-ext1` suffix is not decoration. The install step below changed from one browser to
      # two, and the KEY did not otherwise change: a cache entry written by the old step holds
      # only `chromium-headless-shell`, and restoring it would satisfy `cache-hit` while leaving
      # the full Chromium the harness e2e needs missing. Bump this suffix whenever the set of
      # installed browsers changes.
      - name: Cache the Playwright browsers
        id: playwright-cache
        uses: actions/cache@v6
        with:
          path: ~/.cache/ms-playwright
          key: playwright-ext1-${{ runner.os }}-${{ steps.playwright.outputs.version }}
```

3. Replace the "Install the Chromium headless shell" step:

```yaml
      # Two browsers, because the two gates need different ones.
      #
      # `chromium-headless-shell` is what the visual gate drives: measured, 199 MB / 7.0s instead
      # of 558 MB / 13.7s, and it is what `chromium.launch()` actually starts, since Playwright
      # resolves a default headless launch to the shell.
      #
      # The harness e2e needs the FULL `chromium`. An MV3 extension loads only through
      # `launchPersistentContext` with `--disable-extensions-except` + `--load-extension`
      # (verified fact 7), and the headless shell is a separate binary built without the
      # extensions stack — it does not merely ignore the flags, it cannot serve them.
      #
      # `--with-deps` resolves both to the same apt group, and that group includes `xvfb`, which
      # is what the e2e step below runs under.
      - name: Install the Chromium builds
        if: steps.playwright-cache.outputs.cache-hit != 'true'
        run: pnpm --filter ag-ui-devtools exec playwright install --with-deps chromium chromium-headless-shell
```

4. Append after the "Visual gate" step, still inside `verify`:

```yaml
      # The other half of the same argument. The visual gate proves the panel RENDERS; nothing
      # above it proves the extension CAPTURES — `inject/`, `relay/` and the service worker run
      # in a real browser or not at all, and 699 unit tests can only agree with our idea of what
      # a stream looks like (design §1). This step serves fixtures over real SSE, drives them
      # with the real `@ag-ui/client`, and reads the ring buffer out of the MV3 service worker
      # (decisions H4/H5).
      #
      # It runs against the `dist/` the Build step produced, unpacked — the same artifact
      # `verify:build` just checked and `package` will ship. This step asserts that first,
      # because a missing or stale `dist/` otherwise surfaces as an inscrutable Chromium
      # extension-load failure.
      #
      # `xvfb-run` because an MV3 extension needs a full, headed Chromium. `-a` picks a free
      # display number rather than assuming :99 is unused.
      #
      # No key, no upstream, no network: CI only ever replays committed fixtures (decision H8).
      - name: Assert the e2e will load the freshly built extension
        run: test -f packages/devtools/dist/manifest.json

      - name: Harness end-to-end
        run: xvfb-run -a pnpm test:e2e
```

- [ ] **Step 4: Run test to verify it passes**

Run: `actionlint`

Verified output on the edited workflow (actionlint 1.7.x with shellcheck 0.11.0 present, so the
`run:` blocks were shell-linted too):

```
verbose: Found 0 parse errors in 1 ms for .github/workflows/ci.yml
verbose: Found total 0 errors in 160 ms for .github/workflows/ci.yml
```

Then reproduce the CI sequence locally:

Run: `pnpm --filter ag-ui-devtools exec playwright install --with-deps chromium chromium-headless-shell && pnpm build && pnpm verify:build && pnpm screenshot:panel && pnpm test:e2e`

Expected: every command exits 0, and the last prints the harness Playwright summary with all
scenarios passing. On Linux prefix the last command with `xvfb-run -a`; on macOS a headed
Chromium needs no X server.

Then push the branch and confirm the `verify` job is green through the new
`Harness end-to-end` step.

- [ ] **Step 5: Commit**

`ci: run the harness capture e2e against the built extension`

---

## Notes for whoever executes this

**`xvfb` needs no separate install step.** Verified against the installed
`playwright-core@1.62.1`: `xvfb` is the first entry in the `tools` list for every Ubuntu target
in its `nativeDeps` table, so both `playwright install --with-deps` and the cache-hit path's
`playwright install-deps chromium` put it on the runner.

**The panel's `droppedBefore` is the panel's own count.** `SwMessage.append` carries records and
nothing else, so the worker's eviction count only arrives on a `snapshot`. The live session
therefore bounds its own retained list at the same 5000 and adds its evictions to whatever the
snapshot reported. This is not a workaround: `PanelState.droppedBefore` means "dropped before the
earliest record SHOWN", and what is shown is the panel's list.

---
---

# Appendix — cross-section resolutions

Six sections were authored in parallel against a locked contract, each building and running its code
before writing it down. Where they disagreed, or where the contract itself was wrong, the resolution
is recorded here and applied to the task text above.

## Contract defects — my errors, found by execution

| # | Defect | Resolution |
|---|---|---|
| **C1** | **`RelayMessage = Omit<InjectMessage, 'source'>` does not typecheck.** Reported independently by two sections. `Omit` does not distribute over a union — it keeps only keys common to all four arms, so `RelayMessage` collapsed to `{ v; kind; connId }`, silently dropping `frames`, `url`, `input`, `tMs`, `reason`, `contentType`, `bytes` *and* the discriminant. `tsc` fails with `Property 'frames' does not exist`. | `src/sw/protocol.ts` defines `type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;` and `RelayMessage = DistributiveOmit<InjectMessage, 'source'>`. Exported name and meaning unchanged. |
| **C2** | **`WireFrame.raw` as "the exact frame text" is unachievable.** Flagged by three sections. `core/sse/parser.ts` returns parsed fields, not frame text, and it is reuse-only. EventSource frames are pre-consumed by the browser and can never be byte-exact. | **Pinned:** for an event frame, `raw` is the **`data:` payload** — the string `JSON.parse` consumes. This matches what `panel/import/load-jsonl.ts` already does, which is the tiebreaker. For a keepalive, `raw` is the comment text. Consequence, accepted: `event:`, `id:`, and `retry:` metadata has no home on the wire in this milestone. |
| **C3** | **`SwMessage` had no `binary` arm, so the SW dropped binary messages entirely.** §5.4 requires a first-class "binary transport — decoding not supported yet" state, and the section flagged this as "the one place this plan leaves something invisible". | `SwMessage` gains `{ kind: 'binary'; connId; tMs; contentType; bytes }`, and `PanelState` gains a binary-transport field the Session tab renders. An unlabelled binary stream would look like a capture that silently saw nothing — the exact failure mode §15 names. |
| **C4** | **`SwMessage.append` carried no `droppedBefore`**, so eviction after the initial snapshot was invisible to the panel — breaking P9 for precisely the long sessions P9 exists for. | `append` carries `droppedBefore`. `PanelState.droppedBefore` means "records dropped before the earliest one shown". |
| **C5** | `conn-close` had nowhere to carry the AG-UI classification verdict, though §4.1 makes content-based classification the *primary* detection signal. | `conn-close` gains `classification: Classification`. Capture still records every `text/event-stream` response regardless — §15 names "silently capturing nothing" as the failure to avoid. |
| **C6** | `isInjectMessage` strictness was unspecified, and a property-reading guard accepts a tag carried on the **prototype**. | The guard is own-property-strict, and `relay/` additionally screens for a plain prototype before validating. Both halves, because this is a security boundary. |

## Findings that changed the design

| # | Finding | Consequence |
|---|---|---|
| **F1** | **aimock cannot emit SSE comments or a non-`text/event-stream` content type.** Its `writeAGUIEventStream` hardcodes both, so two of the six required scenarios — `keepalive-gap` and `binary` — are unreachable through aimock alone. | The harness server mounts `AGUIMock` un-started as a `Mountable` request handler and writes those two scenarios itself, mirroring aimock's `timestamp` stamp. Confirmed byte-comparable on the wire. |
| **F2** | **`AGUIMock` sends no CORS headers and 404s the `OPTIONS` preflight** (measured), so a page on another origin cannot reach it at all. | Task 4 adds `page/serve.ts`, serving the page and proxying `POST /agui` — one origin, no preflight, and D3's localhost auto-enable applies to the page's origin. |
| **F3** | **`channel: 'chromium'` is load-bearing in Playwright.** Without it, headless resolves to `chromium-headless-shell`, which launches fine, **loads no extension, registers no service worker, and reports no error**. | Pinned in `launchWithExtension`, with a comment. CI installs both `chromium` (e2e) and `chromium-headless-shell` (visual gate). |
| **F4** | **`chrome.permissions.request` succeeding does not start capture.** Something must register content scripts for the newly granted origin (D3). | The SW listens to `chrome.permissions.onAdded` and registers via `chrome.scripting.registerContentScripts`. **Task 12 owns this** — without it the grant succeeds and capture silently never starts, which is the worst available outcome. |
| **F5** | `keepalive-gap` costs **15.5 s of real wall clock**, because the run builder measures arrival times. The gap cannot be faked in the payload. | Accepted; that scenario is tagged slow and excluded from the fast local loop. |
| **F6** | The Dojo exposes a key-only AG-UI endpoint at `/api/copilotkitnext/builtin/agent/default/run` with no Python backend — unrecognised integrations fall back to a built-in agent. | Tier B recording targets that. No LangGraph, no Python. |
| **F7** | `src/inject/index.ts` is unusable as an entry name: CRXJS keys emitted scripts by basename, so it collides **silently** with `src/sw/index.ts`. This already bit this project once (amendment A28). | The manifest entry stays `src/inject/inject.ts`. |

## Verification standard met by every section

Each section built its code in a scratch workspace against the **real** `core/` modules and ran it.
Notable results:

- **Task 7's back-pressure was mutation-tested**: awaiting the drain before returning the response makes three tests fail *by 5-second timeout* — the page genuinely stalls. Skipping `tee()` fails five. A real `Response` whose page-side branch is **never read** still delivers every frame.
- **The golden fixture re-chunked to 7-byte boundaries** round-trips to exactly its events, and a 4-byte emoji split across chunk boundaries reassembles.
- **The relay rejects 25+ hostile inputs** — cross-origin, opaque `"null"` origin, origin-prefix attack, look-alike tag, version skew, prototype-carried tags, a `kind` getter that throws — with no port opened, nothing logged, and nothing thrown.
- **Eviction and UTF-8 accounting proven**: `'日本語'` and `'aaa'` have equal `String.length`; the buffer reports +6 bytes for the CJK payload. This project fixed the same UTF-16 bug once already in `run-metrics.ts`.
- **Session-mirror restore proven** across two simulated worker incarnations, including that mirror-trimmed records surface as `droppedBefore`.
- **Every `expectIssues` value was observed**, not guessed — including re-confirming that omitting the request body adds `run-started-without-input` to an otherwise clean run.

## Decision for Task 12 — the relay's async-load window

Found while wiring Tasks 9–10, and re-judged as worse than first thought.

Once `relay.ts` gained imports, CRXJS stopped emitting it as a direct content script and began
wrapping it in a loader that `await import(...)`s its chunk. So the relay's `message` listener
registers slightly *after* `document_start`. The MAIN-world script has the same shape, but resolves
a plain relative import, while the ISOLATED loader additionally goes through
`chrome.runtime.getURL` and a web-accessible-resource fetch — so MAIN is the likelier of the two to
win the race.

Why it matters more than a dropped frame: **`EventSource` posts `conn-open` synchronously in its
constructor**, and XHR posts on `readyState === 2`, so an early inline script can produce a message
inside that window. And `conn-open` is the message that carries `input`, the `RunAgentInput`.
Losing it does not merely lose a frame — the service worker then sees frames for a connection it
never opened, and the run surfaces as `run-started-without-input`, which reads as a **finding about
the user's server** rather than a defect in our capture. A misattributed finding is worse than a
missing one.

**Decided: re-state `conn-open` on the first `frames` message for a connection**, and make the
service worker's handling of it idempotent.

Rejected alternatives and why:
- *Give `relay.ts` no imports* so CRXJS emits it synchronously. Cheapest, but it means inlining
  `isInjectMessage` — duplicating a security boundary into two places that must not drift. Not
  worth it.
- *Buffer in MAIN until the relay signals readiness.* Needs the relay to answer the page, which §11
  forbids.
- *Have the SW tolerate frames for an unknown `connId`.* Mitigates the symptom but still loses
  `input`, which is the whole point.

The chosen fix needs no handshake and nothing page-observable: the first `frames` message simply
carries the open payload again, and the SW ignores it if it already has one. Task 12 must also add
a test asserting a `conn-open` posted at `document_start` reaches the buffer.

## BLOCKING follow-up — capture cannot start on non-localhost origins

Found while implementing Task 12, and confirmed by reading the built manifest.

CRXJS emits each content script as an async **loader** that dynamic-imports its real chunk, and
scopes those chunks in `web_accessible_resources` to the localhost family only:

```
web_accessible_resources.matches: ["http://0.0.0.0/*", "http://127.0.0.1/*", "http://localhost/*"]
content_scripts.js:               ["assets/inject.ts-loader-*.js", ...]
```

A MAIN-world script runs in the *page's* world, so on a granted `https://example.com` that import
resolves to a chrome-extension: URL not web-accessible to that origin and is blocked. The grant
succeeds, `permissions.onAdded` registers the scripts, and **capture silently never starts** —
which is the exact failure F4 was written to prevent, one layer out. It also breaks D3's per-origin
opt-in, and with it the "works on deployed environments without a code change" axis the product is
justified by.

Everything in the capture milestone is verified on **localhost**, where it genuinely works, so this
is invisible to the harness e2e by construction.

A second, related finding: a stream opened by a synchronous inline script *before* the MAIN loader
resolves is invisible to capture entirely. The `conn-open` re-statement cannot help — the patch is
not installed yet.

**Recommended fix: make the content-script entries self-contained**, so CRXJS emits them directly
instead of behind a loader. Configure the bundler to inline shared modules into each content-script
entry rather than extracting a shared chunk. That is a build-config change, **not** source
duplication — `isInjectMessage` stays one source of truth, which is why this is preferable to
inlining the guard by hand. It removes the WAR requirement and closes the async-load window in one
move.

Rejected: widening `web_accessible_resources` to `http://*/*`/`https://*/*`. It would work, but it
makes the extension trivially fingerprintable by any page, which §11's posture does not accept.
`use_dynamic_url: true` mitigates that but keeps the loader indirection and its race.

**This should be fixed before Tasks 13–15.** Wiring the panel to a capture layer that cannot run on
a real site would be building on sand.

## Known gaps carried forward

1. **`§5.5`'s `Date.now()` epoch anchor has no message field** — all `tMs` values are `performance.now()`-based only. Fine within a session; a captured file cannot be aligned to wall clock.
2. **EventSource named-event frames are not captured** — that would need per-instance `addEventListener` wrapping. Documented in the module and covered by a test asserting the limitation.
3. **`PanelCommand` has no `unsubscribe` or keepalive arm**, and `snapshot` carries no `recording` flag, so a panel reconnecting to a woken worker cannot tell whether capture is paused. Task 13b works around it; the protocol should grow a field.
4. **`packages/harness` imports `core/` by relative path** — `ag-ui-devtools` is private with no `exports` map. Fine under tsx/vitest; revisit if devtools ever gains a build boundary.
5. **Request-line eviction does not increment `droppedBefore`**, since P9's counter positions a truncation marker in the *event* list.

## Definition of done

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm verify:build`, `pnpm screenshot:panel` all green
- [ ] `core` project still reports its full pre-existing count; nothing under `src/core/**` modified
- [ ] The harness serves all six scenarios, and the e2e asserts captured records match each scenario's observed `expectIssues`
- [ ] `malformed` captured live produces exactly three issues at the same seqs as the golden fixture
- [ ] A binary-transport stream is labelled, not silently empty (C3)
- [ ] Eviction is visible in the panel during a long run (P9, C4)
- [ ] Granting a non-localhost origin actually starts capture (F4)
- [ ] Tier B recording produces a redacted fixture; the key never enters CI
