# AG-UI DevTools panel — phase 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working DevTools panel that imports a `.agui.jsonl` capture and inspects it — shell, Timeline, and Session — with no capture layer.

**Architecture:** The panel is a Preact app over an observable store of plain `PanelState`. `core/` supplies the entire data model unchanged; `loadJsonl` replays a `.agui.jsonl` file through the *same* `run-builder` path that live capture will use, so the UI is built and tested against real golden fixtures before `inject/` exists. Selectors are pure and node-tested; components are jsdom-tested through `@testing-library/preact`; the built panel is screenshot-verified in both colour schemes.

**Tech stack:** Preact 10, Vitest 4 with two projects (`core` in node, `panel` in jsdom), `@testing-library/preact`, jsdom, Playwright for the visual gate only. No new runtime dependencies — the shipped bundle stays Preact-only.

**Design:** [`docs/superpowers/specs/2026-08-14-panel-ui-design.md`](../specs/2026-08-14-panel-ui-design.md), decisions P1–P10.
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §9, §10, §11.

---

## Scope

**In:** test infrastructure, panel state and selectors, JSONL import, virtualization and formatting primitives, the shell (scope bar, run selector, tab strip, toolbar with the issue badge), the Timeline tab (waterfall, event list, event detail), capture-status detection and banner, the Session tab, and app wiring.

**Out:** the Runs, State, and Messages tabs — their `TabId` values exist and selecting them renders an honest "coming next" placeholder. The capture layer (`inject/`, `relay/`, `sw/`). Export and redacted bug-report bundles. All of requirements §14 Phase 2.

**Why this order.** Design §7: `core/` already round-trips `.agui.jsonl` and three golden fixtures exist. Building the panel against import first means no Chrome APIs, no MAIN-world injection, no service worker — and a capture-layer bug can never be mistaken for a rendering bug. The `malformed` fixture, which produces exactly three issues at known positions, doubles as the visual test case for the inline-issue treatment (P2).

## File structure

Paths under `packages/devtools/`.

| File | Responsibility | Task |
|---|---|---|
| `vitest.config.ts`, `src/panel/test-setup.ts` | Two Vitest projects; `chrome` stub; DOM cleanup | 1 |
| `src/panel/model/panel-types.ts` | `PanelState` and its members | 2 |
| `src/panel/model/store.ts` | Observable store plus pure actions | 2 |
| `src/panel/model/use-panel-state.ts` | `usePanelState(store)` subscription hook | 2 |
| `src/panel/model/selectors.ts` | Pure derivations — scope, filter, issue counts | 3 |
| `src/panel/import/load-jsonl.ts` | `.agui.jsonl` → runs, records, issues via `run-builder` | 4 |
| `src/panel/common/layout.ts` | `NARROW_BREAKPOINT_PX`, `useIsNarrow` | 5 |
| `src/panel/common/window-range.ts` | Pure windowing maths | 5 |
| `src/panel/common/virtual-list.tsx` | `VirtualList` | 5 |
| `src/panel/common/format.ts` | Duration, bytes, event summary | 5 |
| `src/panel/shell/{scope-bar,run-selector,tab-strip,toolbar}.tsx` | The three fixed bands | 6 |
| `src/panel/tabs/timeline/{event-list,event-detail}.tsx` | List and detail pane | 7 |
| `src/panel/tabs/timeline/{waterfall,timeline}.tsx` | Waterfall and tab composition | 8 |
| `src/panel/import/drop-zone.tsx`, `src/panel/capture/{detect.ts,capture-status.tsx}`, `src/panel/tabs/session/session.tsx` | Import, detection, Session | 9 |
| `src/panel/app.tsx`, `src/panel/panel.tsx`, `src/panel/panel.css`, `scripts/screenshot-panel.mts` | Wiring and the visual gate | 10 |

Every module with behaviour has a sibling `*.test.ts(x)` written **before** it.

## Conventions

- Commands run from `packages/devtools/` unless a step says otherwise.
- Pure-logic tests carry a `// @vitest-environment node` docblock; everything else runs in jsdom.
- **Never write the string `@vitest-environment` in prose.** Vitest scans a test file's first
  comment for the directive and does not care that it appears inside an explanatory sentence. A
  header comment saying "this file does *not* use `@vitest-environment node`" silently runs the
  file in node — found the hard way in Task 2, where it cost five `document is not defined`
  failures in a jsdom test.
- Tests query by role and accessible name. Class names are not a contract.
- `noUncheckedIndexedAccess` is on and test files are typechecked — `.at(-1)`, never `[length - 1]`.
- `src/core/**` is not modified by this plan and stays behind its lint fence.
- Commit after every green cycle.

---

### Task 1: Panel test infrastructure

Split Vitest into two projects so `core/` keeps running under `node` (design §3 / D10 — core is
Chrome-free and Node-runnable) while `panel/` gets a jsdom DOM. Configuration only, so this task
ends with verification commands rather than a TDD loop.

**Files:**
- Modify: `packages/devtools/vitest.config.ts`
- Modify: `packages/devtools/package.json`
- Create: `packages/devtools/src/panel/test-setup.ts`
- Test: `packages/devtools/src/panel/test-setup.test.tsx`

Versions confirmed with `npm view` on 2026-08-14: `@testing-library/preact` **3.2.4**
(peer `preact: >=10`, satisfied by the installed `preact 10.29.8`), `jsdom` **29.1.1** — NOT 30.x. jsdom 30 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`, and with the repo's `engine-strict=true` that is a hard `ERR_PNPM_UNSUPPORTED_ENGINE` install failure on Node 22.14. jsdom 29.1.1 accepts `^22.13.0` and works in both local and CI.

Vitest API confirmed against the **installed** `vitest@4.1.10`, not assumed: `node_modules/vitest/
dist/chunks/reporters.d.DtoKVV2s.d.ts:2859` declares `projects?: TestProjectConfiguration[]` on
`InlineConfig`, i.e. the key is `test.projects` (each entry itself a `{ test: {...} }` object).
There is no `workspace` key in 4.1.10. Both project shapes below were executed end to end.

- [ ] **Step 1: Add the devDependencies**

Run:

```
pnpm --filter ag-ui-devtools add -D @testing-library/preact@^3.2.4 jsdom@^29.1.1
```

Resulting `packages/devtools/package.json`:

```json
{
  "name": "ag-ui-devtools",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Chrome DevTools panel for inspecting AG-UI protocol streams",
  "license": "MIT",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "package": "tsx scripts/package.ts",
    "test": "vitest run",
    "test:ci": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint .",
    "gen:events": "tsx scripts/gen-event-table.ts",
    "verify:build": "tsx scripts/verify-build.ts"
  },
  "dependencies": {
    "preact": "^10.29.8"
  },
  "devDependencies": {
    "@ag-ui/core": "0.0.57",
    "@crxjs/vite-plugin": "^2.7.1",
    "@eslint/js": "^9.39.5",
    "@preact/preset-vite": "^2.10.6",
    "@testing-library/preact": "^3.2.4",
    "@types/chrome": "^0.2.6",
    "@types/node": "^22.20.1",
    "eslint": "^9.39.5",
    "globals": "^17.11.0",
    "jsdom": "^29.1.1",
    "tsx": "^4.19.2",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.67.0",
    "vite": "^8.2.1",
    "vitest": "^4.1.10",
    "zod": "^3.25.76"
  }
}
```

- [ ] **Step 2: Convert `vitest.config.ts` to the two-project form**

Complete `packages/devtools/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the two halves of this package have incompatible environments.
 *
 * `core/` is deliberately Chrome-free and DOM-free (design §3 / D10, enforced by the
 * `no-restricted-globals` fence in eslint.config.js) and must keep running under plain `node` —
 * running it in jsdom would silently make `document` and `window` available and let the fence rot.
 * `panel/` renders Preact and needs a DOM, so it gets jsdom plus a setup file.
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
    ],
  },
});
```

JSX needs no plugin here. `vitest.config.ts` is standalone (it does not load `vite.config.ts`, so
`@preact/preset-vite` is not in play), and Vite's esbuild transform reads `jsx: "react-jsx"` /
`jsxImportSource: "preact"` straight from `tsconfig.base.json`. Verified by rendering a `.tsx`
component in Step 5.

- [ ] **Step 3: Create the panel setup file**

`packages/devtools/src/panel/test-setup.ts`:

```ts
/**
 * Vitest setup for the `panel` project.
 *
 * Two jobs. First, install a `chrome` stub: `src/panel/**` is outside the core lint fence and
 * legitimately reads `chrome.runtime` / `chrome.devtools`, which jsdom does not provide. Second,
 * unmount anything a test rendered — Testing Library appends each render to `document.body`, so
 * without `cleanup` the second test in a file queries a DOM still holding the first one's output.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

interface ChromeStub {
  runtime: { getManifest: () => { version: string } };
  devtools: {
    network: {
      onRequestFinished: {
        addListener: (listener: (request: unknown) => void) => void;
        removeListener: (listener: (request: unknown) => void) => void;
      };
    };
    inspectedWindow: { tabId: number; eval: (expression: string) => void };
  };
}

const chromeStub: ChromeStub = {
  runtime: { getManifest: () => ({ version: '0.1.0' }) },
  devtools: {
    network: {
      onRequestFinished: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    inspectedWindow: { tabId: 1, eval: () => {} },
  },
};

// `@types/chrome` types the global as the full API surface. The stub is deliberately a subset —
// widening it to the real type would mean stubbing hundreds of members no test touches — so the
// assignment goes through `unknown` rather than `any` (`no-explicit-any` is on).
(globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 4: Create the trivial panel component test**

`packages/devtools/src/panel/test-setup.test.tsx`:

```tsx
/**
 * Proves the `panel` Vitest project actually gives a component test what it needs: a jsdom
 * document, a `chrome` stub, and a working Preact render through `@testing-library/preact`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';

function Hello(props: { name: string }) {
  return <p data-testid="greeting">Hello, {props.name}</p>;
}

describe('panel test environment', () => {
  it('runs in jsdom', () => {
    expect(typeof document).toBe('object');
    expect(document.body).toBeDefined();
  });

  it('exposes the chrome stub from test-setup', () => {
    expect(chrome.runtime.getManifest().version).toBe('0.1.0');
  });

  it('renders a Preact component', () => {
    render(<Hello name="AG-UI" />);
    expect(screen.getByTestId('greeting').textContent).toBe('Hello, AG-UI');
  });

  it('cleans up between tests', () => {
    expect(screen.queryByTestId('greeting')).toBeNull();
  });
});
```

The fourth test is the one that earns its keep: it fails if `cleanup` is dropped from
`test-setup.ts`, because the `<Hello>` from the previous test would still be in the document.

- [ ] **Step 5: Verify**

Run, from `packages/devtools/`:

```
pnpm vitest run --project core
```

Expected — unchanged from the pre-split baseline (measured on `main` before any edit: 18 files,
355 tests):

```
 Test Files  18 passed (18)
      Tests  355 passed (355)
```

```
pnpm vitest run --project panel
```

Expected:

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

```
pnpm vitest run
```

Expected: `Test Files  19 passed (19)` / `Tests  359 passed (359)`, with rows prefixed `|core|`
and `|panel|`.

```
pnpm typecheck && pnpm lint
```

Expected: both clean, no output beyond the command echo.

**Verified, not assumed.** The two-project config above was executed against the real repo via
`npx vitest run --config <scratch>/vitest.repo-core.config.ts --project core` (a config outside the
tree, so nothing in the repo was modified), printing exactly `Test Files 18 passed (18)` /
`Tests 355 passed (355)`. The panel project, `test-setup.ts`, and `test-setup.test.tsx` were run in
a scratch package with the real `jsdom@29.1.1` + `@testing-library/preact@3.2.4` installed:
`Test Files 1 passed (1)` / `Tests 4 passed (4)`. `tsc --noEmit` under a copy of
`tsconfig.base.json` (`noUncheckedIndexedAccess` on, `types: ["chrome","node"]`) and `eslint` under
an equivalent flat config both came back clean.

- [ ] **Step 6: Commit**

```
git add packages/devtools/vitest.config.ts packages/devtools/package.json \
        packages/devtools/src/panel/test-setup.ts \
        packages/devtools/src/panel/test-setup.test.tsx pnpm-lock.yaml
git commit -m "test: split vitest into core (node) and panel (jsdom) projects"
```

---

### Task 2: Panel state model and store

`src/panel/model/panel-types.ts` (types + `initialPanelState`) and `src/panel/model/store.ts` (the
`PanelStore` observable and the eight pure actions). Strict TDD.

**Files:**
- Create: `packages/devtools/src/panel/model/panel-types.ts`
- Create: `packages/devtools/src/panel/model/store.ts`
- Test: `packages/devtools/src/panel/model/store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/devtools/src/panel/model/store.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { CaptureRecord, Run } from '../../core/model/types';
import { initialPanelState, type PanelState } from './panel-types';
import {
  createPanelStore,
  loadFailed,
  selectScope,
  selectSeq,
  selectTab,
  setCapture,
  setTextFilter,
  toggleExpandChunks,
  toggleIssuesOnly,
} from './store';

function makeRecord(seq: number): CaptureRecord {
  return {
    kind: 'event',
    seq,
    tMs: seq * 10,
    connId: 'conn-1',
    raw: null,
    event: { type: 'CUSTOM' },
    issues: [],
  };
}

function makeRun(runId: string, recordSeqs: number[]): Run {
  return {
    runId,
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs,
  };
}

/** Two runs, r_1 owning seqs 1-2 and r_2 owning seqs 3-4, with seq 2 selected. */
function loadedState(): PanelState {
  return {
    ...initialPanelState(),
    runs: [makeRun('r_1', [1, 2]), makeRun('r_2', [3, 4])],
    records: [makeRecord(1), makeRecord(2), makeRecord(3), makeRecord(4)],
    selectedSeq: 2,
  };
}

/**
 * Runs an action and asserts the two properties every action shares: a NEW state object out, and
 * the input left byte-for-byte as it was. `structuredClone` is used rather than a shallow copy so
 * a mutation buried in `filter` or in a `Run`'s maps still fails the comparison.
 */
function expectPure(s: PanelState, act: (input: PanelState) => PanelState): PanelState {
  const before = structuredClone(s);
  const next = act(s);
  expect(next).not.toBe(s);
  expect(s).toEqual(before);
  return next;
}

describe('initialPanelState', () => {
  it('starts empty, unscoped, on the timeline tab', () => {
    const s = initialPanelState();
    expect(s.source).toEqual({ kind: 'empty' });
    expect(s.droppedBefore).toBe(0);
    expect(s.tab).toBe('timeline');
    expect(s.scope).toBeNull();
  });

  it('starts with no data, no filter, and no error', () => {
    const s = initialPanelState();
    expect(s.capture).toEqual({ kind: 'unsupported' });
    expect(s.filter).toEqual({ text: '', issuesOnly: false });
    expect(s.runs).toEqual([]);
    expect(s.records).toEqual([]);
    expect(s.issues).toEqual([]);
    expect(s.expandChunks).toBe(false);
    expect(s.selectedSeq).toBeNull();
    expect(s.loadError).toBeNull();
  });

  it('returns a fresh object each call, so one panel cannot alias another', () => {
    const a = initialPanelState();
    const b = initialPanelState();
    expect(a).not.toBe(b);
    expect(a.filter).not.toBe(b.filter);
    expect(a.runs).not.toBe(b.runs);
  });
});

describe('selectTab', () => {
  it('sets the tab without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => selectTab(s, 'session'));
    expect(next.tab).toBe('session');
  });

  it('returns a new object even when the tab is unchanged', () => {
    const next = expectPure(initialPanelState(), (s) => selectTab(s, 'timeline'));
    expect(next.tab).toBe('timeline');
  });
});

describe('selectScope', () => {
  it('preserves selectedSeq when the new scope still contains it', () => {
    const next = expectPure(loadedState(), (s) => selectScope(s, 'r_1'));
    expect(next.scope).toBe('r_1');
    expect(next.selectedSeq).toBe(2);
  });

  it('clears selectedSeq when the new scope no longer contains it', () => {
    const next = expectPure(loadedState(), (s) => selectScope(s, 'r_2'));
    expect(next.scope).toBe('r_2');
    expect(next.selectedSeq).toBeNull();
  });

  it('preserves selectedSeq when widening to all runs', () => {
    const scoped = selectScope(loadedState(), 'r_1');
    const next = expectPure(scoped, (s) => selectScope(s, null));
    expect(next.scope).toBeNull();
    expect(next.selectedSeq).toBe(2);
  });

  it('clears selectedSeq for an unknown run id, whose record set is empty', () => {
    const next = expectPure(loadedState(), (s) => selectScope(s, 'r_missing'));
    expect(next.scope).toBe('r_missing');
    expect(next.selectedSeq).toBeNull();
  });

  it('clears a selectedSeq that matches no record at all under all runs', () => {
    const orphaned: PanelState = { ...loadedState(), selectedSeq: 99 };
    const next = expectPure(orphaned, (s) => selectScope(s, null));
    expect(next.selectedSeq).toBeNull();
  });

  it('leaves a null selectedSeq null', () => {
    const none: PanelState = { ...loadedState(), selectedSeq: null };
    const next = expectPure(none, (s) => selectScope(s, 'r_1'));
    expect(next.selectedSeq).toBeNull();
  });
});

describe('selectSeq', () => {
  it('sets the selected seq without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => selectSeq(s, 3));
    expect(next.selectedSeq).toBe(3);
  });

  it('clears the selection when given null', () => {
    const next = expectPure(loadedState(), (s) => selectSeq(s, null));
    expect(next.selectedSeq).toBeNull();
  });
});

describe('setTextFilter', () => {
  it('replaces the filter object rather than mutating it', () => {
    const s = loadedState();
    const next = expectPure(s, (input) => setTextFilter(input, 'RUN_STARTED'));
    expect(next.filter).not.toBe(s.filter);
    expect(next.filter).toEqual({ text: 'RUN_STARTED', issuesOnly: false });
  });

  it('keeps issuesOnly untouched', () => {
    const s: PanelState = { ...loadedState(), filter: { text: 'old', issuesOnly: true } };
    const next = expectPure(s, (input) => setTextFilter(input, 'new'));
    expect(next.filter).toEqual({ text: 'new', issuesOnly: true });
  });

  it('accepts the empty string as "no text filter"', () => {
    const s: PanelState = { ...loadedState(), filter: { text: 'old', issuesOnly: false } };
    const next = expectPure(s, (input) => setTextFilter(input, ''));
    expect(next.filter.text).toBe('');
  });
});

describe('toggleIssuesOnly', () => {
  it('flips false to true without mutating the input', () => {
    const s = loadedState();
    const next = expectPure(s, toggleIssuesOnly);
    expect(next.filter).not.toBe(s.filter);
    expect(next.filter.issuesOnly).toBe(true);
  });

  it('flips true back to false and keeps the text', () => {
    const s: PanelState = { ...loadedState(), filter: { text: 'tool', issuesOnly: true } };
    const next = expectPure(s, toggleIssuesOnly);
    expect(next.filter).toEqual({ text: 'tool', issuesOnly: false });
  });
});

describe('toggleExpandChunks', () => {
  it('flips the flag without mutating the input', () => {
    const next = expectPure(loadedState(), toggleExpandChunks);
    expect(next.expandChunks).toBe(true);
  });

  it('flips back on a second call', () => {
    const once = toggleExpandChunks(loadedState());
    const next = expectPure(once, toggleExpandChunks);
    expect(next.expandChunks).toBe(false);
  });

  it('only flips the flag — records and runs are left alone for the caller to rebuild', () => {
    const s = loadedState();
    const next = toggleExpandChunks(s);
    expect(next.records).toBe(s.records);
    expect(next.runs).toBe(s.runs);
  });
});

describe('setCapture', () => {
  it('replaces the capture status without mutating the input', () => {
    const next = expectPure(loadedState(), (s) =>
      setCapture(s, { kind: 'off', origin: 'https://example.test', aguiDetected: true }),
    );
    expect(next.capture).toEqual({
      kind: 'off',
      origin: 'https://example.test',
      aguiDetected: true,
    });
  });

  it('accepts the unsupported status', () => {
    const on: PanelState = { ...loadedState(), capture: { kind: 'on', origin: 'https://a.test' } };
    const next = expectPure(on, (s) => setCapture(s, { kind: 'unsupported' }));
    expect(next.capture).toEqual({ kind: 'unsupported' });
  });
});

describe('loadFailed', () => {
  it('records the message without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => loadFailed(s, 'unreadable file'));
    expect(next.loadError).toBe('unreadable file');
  });

  it('replaces an earlier error', () => {
    const failed = loadFailed(initialPanelState(), 'first');
    const next = expectPure(failed, (s) => loadFailed(s, 'second'));
    expect(next.loadError).toBe('second');
  });
});

describe('createPanelStore', () => {
  it('defaults to initialPanelState()', () => {
    expect(createPanelStore().get()).toEqual(initialPanelState());
  });

  it('uses the supplied initial state', () => {
    const s = loadedState();
    expect(createPanelStore(s).get()).toBe(s);
  });

  it('get() returns the state written by set()', () => {
    const store = createPanelStore();
    const next = selectTab(initialPanelState(), 'session');
    store.set(next);
    expect(store.get()).toBe(next);
  });

  it('update() applies the function to the current state', () => {
    const store = createPanelStore();
    store.update((prev) => selectTab(prev, 'session'));
    store.update((prev) => selectSeq(prev, 7));
    expect(store.get().tab).toBe('session');
    expect(store.get().selectedSeq).toBe(7);
  });

  it('notifies subscribers on set()', () => {
    const store = createPanelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(selectTab(store.get(), 'session'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on update()', () => {
    const store = createPanelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update((prev) => selectTab(prev, 'runs'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('gives listeners the new state when they read it', () => {
    const store = createPanelStore();
    const seen: string[] = [];
    store.subscribe(() => {
      seen.push(store.get().tab);
    });
    store.update((prev) => selectTab(prev, 'state'));
    expect(seen).toEqual(['state']);
  });

  it('notifies every subscriber', () => {
    const store = createPanelStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set(initialPanelState());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after the returned unsubscribe is called', () => {
    const store = createPanelStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set(initialPanelState());
    unsubscribe();
    store.set(initialPanelState());
    store.update((prev) => prev);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing one listener leaves the others subscribed', () => {
    const store = createPanelStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = store.subscribe(a);
    store.subscribe(b);
    unsubscribeA();
    store.set(initialPanelState());
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('tolerates a listener unsubscribing during notification', () => {
    const store = createPanelStore();
    const b = vi.fn();
    const unsubscribeA: () => void = store.subscribe(() => {
      unsubscribeA();
    });
    store.subscribe(b);
    store.set(initialPanelState());
    store.set(initialPanelState());
    expect(b).toHaveBeenCalledTimes(2);
  });
});
```

The explicit `const unsubscribeA: () => void` annotation in the last test is load-bearing: without
it TypeScript rejects the self-reference inside the listener as a circular initializer.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/model/store.test.ts`

Expected: FAIL, 0 tests collected, with:

```
Error: Failed to resolve import "./panel-types" from "src/panel/model/store.test.ts". Does the file exist?
  Plugin: vite:import-analysis
```

- [ ] **Step 3: Write the implementation**

`packages/devtools/src/panel/model/panel-types.ts`:

```ts
/**
 * The panel's own state model.
 *
 * Everything the UI renders is either core model data (`Run`, `CaptureRecord`, `Issue`) or one of
 * the view-level fields below. Nothing here is persisted — requirements §11 — and nothing here is
 * derived: derivations live in `selectors.ts` so state stays a single, comparable snapshot.
 */
import type { Run, Issue, CaptureRecord } from '../../core/model/types';

/** Where the panel's data came from. Drives empty states and which controls are live. */
export type PanelSource =
  | { kind: 'empty' }
  | { kind: 'imported'; filename: string; importedAtMs: number }
  | { kind: 'live'; origin: string };

/** Capture availability for the inspected origin. Phase 1 never reaches 'on'. */
export type CaptureStatus =
  | { kind: 'unsupported' }
  | { kind: 'off'; origin: string; aguiDetected: boolean }
  | { kind: 'on'; origin: string };

export type TabId = 'timeline' | 'runs' | 'state' | 'messages' | 'session';

/** `null` means "all runs". */
export type RunScope = string | null;

export interface EventFilter {
  /** Case-insensitive substring over the serialized record. Empty string means no text filter. */
  text: string;
  /** When true, only records carrying at least one issue are shown. */
  issuesOnly: boolean;
}

export interface PanelState {
  source: PanelSource;
  capture: CaptureStatus;
  tab: TabId;
  scope: RunScope;
  filter: EventFilter;
  runs: Run[];
  records: CaptureRecord[];
  issues: Issue[];
  /** Records evicted before the earliest retained one. Always 0 in phase 1; the UI reads it now so
   *  P9 needs no retrofit when capture lands. */
  droppedBefore: number;
  expandChunks: boolean;
  selectedSeq: number | null;
  /** Set when a load fails; cleared on the next successful load. */
  loadError: string | null;
}

/**
 * The state a freshly opened panel holds.
 *
 * Built fresh on every call rather than exported as a frozen constant: the actions treat state as
 * immutable, but a shared `runs: []` array leaking into two stores is the kind of aliasing bug that
 * only shows up once a second panel exists.
 *
 * `capture` starts `unsupported` because phase 1 ships no capture layer (design §7) — the panel is
 * driven entirely by import until `setCapture` is called with something better.
 */
export function initialPanelState(): PanelState {
  return {
    source: { kind: 'empty' },
    capture: { kind: 'unsupported' },
    tab: 'timeline',
    scope: null,
    filter: { text: '', issuesOnly: false },
    runs: [],
    records: [],
    issues: [],
    droppedBefore: 0,
    expandChunks: false,
    selectedSeq: null,
    loadError: null,
  };
}
```

`packages/devtools/src/panel/model/store.ts`:

```ts
/**
 * The panel's store and its actions.
 *
 * A ~40-line observable rather than a state library: the panel has one state object, one writer per
 * event, and a zero-runtime-dependency posture (design §6). Actions are plain pure functions kept
 * outside the store so they can be tested without constructing one, and so a component can compose
 * two of them into a single `update` without an intermediate render.
 */
import type { CaptureStatus, PanelState, RunScope, TabId } from './panel-types';
import { initialPanelState } from './panel-types';

export interface PanelStore {
  get(): PanelState;
  set(next: PanelState): void;
  update(fn: (prev: PanelState) => PanelState): void;
  subscribe(listener: () => void): () => void;
}

export function createPanelStore(initial: PanelState = initialPanelState()): PanelStore {
  let state = initial;
  const listeners = new Set<() => void>();

  function get(): PanelState {
    return state;
  }

  function set(next: PanelState): void {
    state = next;
    // Iterate a copy: a listener is allowed to unsubscribe itself (a component unmounting in
    // response to the very state change being announced), and mutating the Set mid-iteration
    // would otherwise skip whichever listener happened to come next.
    for (const listener of [...listeners]) listener();
  }

  function update(fn: (prev: PanelState) => PanelState): void {
    set(fn(state));
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { get, set, update, subscribe };
}

export function selectTab(s: PanelState, tab: TabId): PanelState {
  return { ...s, tab };
}

/**
 * Change the run scope, dropping the selection if it falls outside the new scope.
 *
 * Without this, switching from "all runs" to a specific run would leave the detail pane showing an
 * event the list no longer contains — the selection would be invisible but still live, and the next
 * keyboard navigation would jump somewhere unrelated.
 */
export function selectScope(s: PanelState, scope: RunScope): PanelState {
  return { ...s, scope, selectedSeq: scopeContainsSelection(s, scope) ? s.selectedSeq : null };
}

function scopeContainsSelection(s: PanelState, scope: RunScope): boolean {
  const seq = s.selectedSeq;
  if (seq === null) return true;
  // `null` scope is every record, so membership is a records lookup rather than a run lookup.
  if (scope === null) return s.records.some((record) => record.seq === seq);
  const run = s.runs.find((candidate) => candidate.runId === scope);
  // An unknown run id scopes to nothing, so nothing survives it.
  return run !== undefined && run.recordSeqs.includes(seq);
}

export function selectSeq(s: PanelState, seq: number | null): PanelState {
  return { ...s, selectedSeq: seq };
}

export function setTextFilter(s: PanelState, text: string): PanelState {
  return { ...s, filter: { ...s.filter, text } };
}

export function toggleIssuesOnly(s: PanelState): PanelState {
  return { ...s, filter: { ...s.filter, issuesOnly: !s.filter.issuesOnly } };
}

/**
 * Flip the chunk-expansion flag only.
 *
 * Rebuilding the records under the new setting needs the raw JSONL lines, which state does not
 * hold, so that is the caller's job — see the contract note on `toggleExpandChunks`.
 */
export function toggleExpandChunks(s: PanelState): PanelState {
  return { ...s, expandChunks: !s.expandChunks };
}

export function setCapture(s: PanelState, capture: CaptureStatus): PanelState {
  return { ...s, capture };
}

export function loadFailed(s: PanelState, message: string): PanelState {
  return { ...s, loadError: message };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/model/store.test.ts`

Expected:

```
 Test Files  1 passed (1)
      Tests  36 passed (36)
```

Then `pnpm typecheck && pnpm lint` — both clean. Then `pnpm vitest run`:
`Test Files  20 passed (20)` / `Tests  395 passed (395)`.

**Verified, not assumed.** Both source files and the test file above were written into a scratch
package that imports the **real** `src/core/model/types.ts` from the repo through a symlink at the
same relative path (`../../core/model/types`), then run:
`Test Files 2 passed (2)` / `Tests 40 passed (40)` (36 store + 4 from Task 1's setup test).
`tsc --noEmit` under `noUncheckedIndexedAccess` with test files included: clean.
`eslint` under the repo's rule set (`js.recommended` + `tseslint.recommended`, `no-explicit-any`
on): clean, exit 0.

- [ ] **Step 5: Commit**

```
git add packages/devtools/src/panel/model/panel-types.ts \
        packages/devtools/src/panel/model/store.ts \
        packages/devtools/src/panel/model/store.test.ts
git commit -m "feat(panel): panel state model and observable store"
```

---

### Task 3: Panel selectors — the six pure derivations

The whole of the panel's read path. Every tab renders from these, so they are the only place
scoping and filtering logic exists, and the only place it is tested.

Both test files in this section open with `// @vitest-environment node`. The contract's Vitest
`projects` config routes everything matching `src/panel/**/*.test.{ts,tsx}` into the `jsdom`
project; these two suites touch no DOM, and the docblock keeps them in `node` (verified: they pass
under a `jsdom` default with `jsdom` not even installed).

**Files:**
- Create: `packages/devtools/src/panel/model/selectors.ts`
- Test: `packages/devtools/src/panel/model/selectors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  makeIssue,
  type AguiEvent,
  type CaptureRecord,
  type Issue,
  type Run,
} from '../../core/model/types';
import { initialPanelState, type PanelState } from './panel-types';
import {
  visibleRecords,
  scopedIssues,
  issueCounts,
  scopedRun,
  selectedRecord,
  issuesBySeq,
} from './selectors';

function eventRecord(seq: number, event: AguiEvent): CaptureRecord {
  return { kind: 'event', seq, tMs: seq * 10, connId: 'c1', raw: event, event, issues: [] };
}

function keepaliveRecord(seq: number, comment: string): CaptureRecord {
  return {
    kind: 'keepalive',
    seq,
    tMs: seq * 10,
    connId: 'c1',
    raw: `:${comment}\n\n`,
    comment,
    issues: [],
  };
}

function run(runId: string, recordSeqs: number[]): Run {
  return {
    runId,
    threadId: 't_1',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs,
  };
}

const RECORDS: CaptureRecord[] = [
  eventRecord(1, { type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' }),
  eventRecord(2, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello Paris' }),
  eventRecord(3, { type: 'RUN_FINISHED', threadId: 't_1', runId: 'r_1' }),
  keepaliveRecord(4, 'ping'),
  eventRecord(5, { type: 'RUN_STARTED', threadId: 't_1', runId: 'r_2' }),
  eventRecord(6, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: '' }),
];

const ISSUES: Issue[] = [
  makeIssue('unclosed-message', 'Message m_1 never closed', 2, { runId: 'r_1' }),
  makeIssue('keepalive-gap', 'Keepalive gap of 20000ms', 2, { runId: 'r_1' }),
  makeIssue('empty-text-delta', 'TEXT_MESSAGE_CONTENT carried an empty delta', 6, {
    runId: 'r_2',
  }),
];

function state(overrides: Partial<PanelState> = {}): PanelState {
  return {
    ...initialPanelState(),
    runs: [run('r_1', [1, 2, 3]), run('r_2', [5, 6])],
    records: RECORDS,
    issues: ISSUES,
    ...overrides,
  };
}

const seqs = (records: CaptureRecord[]): number[] => records.map((record) => record.seq);

describe('visibleRecords', () => {
  it('returns every record, in order, when the scope is null', () => {
    expect(seqs(visibleRecords(state()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('scopes to one run’s records', () => {
    expect(seqs(visibleRecords(state({ scope: 'r_1' })))).toEqual([1, 2, 3]);
    expect(seqs(visibleRecords(state({ scope: 'r_2' })))).toEqual([5, 6]);
  });

  it('returns nothing for an unknown run id', () => {
    expect(visibleRecords(state({ scope: 'r_nope' }))).toEqual([]);
  });

  it('excludes keepalives from a run scope, because they never enter recordSeqs', () => {
    expect(seqs(visibleRecords(state({ scope: 'r_1' })))).not.toContain(4);
  });

  it('filters to records carrying issues when issuesOnly is set', () => {
    expect(seqs(visibleRecords(state({ filter: { text: '', issuesOnly: true } })))).toEqual([2, 6]);
  });

  it('filters by case-insensitive substring over the serialized record', () => {
    expect(seqs(visibleRecords(state({ filter: { text: 'PARIS', issuesOnly: false } })))).toEqual([
      2,
    ]);
    expect(seqs(visibleRecords(state({ filter: { text: 'paris', issuesOnly: false } })))).toEqual([
      2,
    ]);
    expect(
      seqs(visibleRecords(state({ filter: { text: 'RUN_STARTED', issuesOnly: false } }))),
    ).toEqual([1, 5]);
  });

  it('serializes a keepalive by its comment, not its event', () => {
    expect(seqs(visibleRecords(state({ filter: { text: 'ping', issuesOnly: false } })))).toEqual([
      4,
    ]);
  });

  it('composes the text filter with issuesOnly', () => {
    expect(seqs(visibleRecords(state({ filter: { text: 'hello', issuesOnly: true } })))).toEqual([
      2,
    ]);
    // 'hello' alone matches only seq 2; issuesOnly alone matches 2 and 6; together, 2.
    expect(seqs(visibleRecords(state({ filter: { text: 'hello', issuesOnly: false } })))).toEqual([
      2,
    ]);
    expect(
      seqs(visibleRecords(state({ filter: { text: 'RUN_STARTED', issuesOnly: true } }))),
    ).toEqual([]);
  });

  it('composes the scope with both filters', () => {
    expect(
      seqs(visibleRecords(state({ scope: 'r_1', filter: { text: '', issuesOnly: true } }))),
    ).toEqual([2]);
  });
});

describe('scopedIssues', () => {
  it('returns every issue when the scope is null', () => {
    expect(scopedIssues(state()).map((issue) => issue.code)).toEqual([
      'unclosed-message',
      'keepalive-gap',
      'empty-text-delta',
    ]);
  });

  it('returns only the scoped run’s issues', () => {
    expect(scopedIssues(state({ scope: 'r_2' })).map((issue) => issue.code)).toEqual([
      'empty-text-delta',
    ]);
  });

  it('returns nothing for an unknown run id', () => {
    expect(scopedIssues(state({ scope: 'r_nope' }))).toEqual([]);
  });
});

describe('issueCounts', () => {
  it('tallies by severity and total', () => {
    expect(issueCounts(state())).toEqual({ error: 1, warning: 1, info: 1, total: 3 });
  });

  it('tallies within the current scope', () => {
    expect(issueCounts(state({ scope: 'r_1' }))).toEqual({
      error: 0,
      warning: 1,
      info: 1,
      total: 2,
    });
  });

  it('is all zeroes with no issues', () => {
    expect(issueCounts(state({ issues: [] }))).toEqual({
      error: 0,
      warning: 0,
      info: 0,
      total: 0,
    });
  });
});

describe('issuesBySeq', () => {
  it('groups issues by seq, keeping several on one seq', () => {
    const bySeq = issuesBySeq(state());

    expect([...bySeq.keys()].sort((a, b) => a - b)).toEqual([2, 6]);
    expect(bySeq.get(2)?.map((issue) => issue.code)).toEqual(['unclosed-message', 'keepalive-gap']);
    expect(bySeq.get(6)?.map((issue) => issue.code)).toEqual(['empty-text-delta']);
    expect(bySeq.get(1)).toBeUndefined();
  });

  it('groups only the scoped issues', () => {
    expect([...issuesBySeq(state({ scope: 'r_2' })).keys()]).toEqual([6]);
  });
});

describe('scopedRun', () => {
  it('returns the named run', () => {
    expect(scopedRun(state({ scope: 'r_2' }))?.runId).toBe('r_2');
  });

  it('returns undefined for an unknown id', () => {
    expect(scopedRun(state({ scope: 'r_nope' }))).toBeUndefined();
  });

  it('returns undefined for the all-runs scope', () => {
    expect(scopedRun(state({ scope: null }))).toBeUndefined();
  });
});

describe('selectedRecord', () => {
  it('returns the record for selectedSeq', () => {
    expect(selectedRecord(state({ selectedSeq: 4 }))?.kind).toBe('keepalive');
  });

  it('returns undefined when selectedSeq is null', () => {
    expect(selectedRecord(state({ selectedSeq: null }))).toBeUndefined();
  });

  it('returns undefined for a seq that no record carries', () => {
    expect(selectedRecord(state({ selectedSeq: 99 }))).toBeUndefined();
  });

  it('ignores the scope and the filter, so a selection survives them', () => {
    const s = state({ scope: 'r_1', filter: { text: 'zzz', issuesOnly: true }, selectedSeq: 5 });

    expect(selectedRecord(s)?.seq).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/model/selectors.test.ts`
Expected: FAIL with `Error: Cannot find module './selectors' imported from
src/panel/model/selectors.test.ts` — the suite collects zero tests.

- [ ] **Step 3: Write the implementation**

```ts
import type { CaptureRecord, Issue, Run } from '../../core/model/types';
import type { PanelState } from './panel-types';

/**
 * The text a record is matched against.
 *
 * `CaptureRecord` is a union on `kind`, so this narrows before touching either arm: a
 * keepalive has a `comment` and never an `event`. Deliberately NOT `JSON.stringify(record)` —
 * that would fold `seq`, `tMs` and `connId` into the haystack, so typing `5` would match every
 * record whose timestamp happens to contain a 5.
 */
function serializeRecord(record: CaptureRecord): string {
  if (record.kind === 'keepalive') return `keepalive ${record.comment}`;
  if (record.event !== null) return JSON.stringify(record.event);
  // An unparseable frame still has to be findable, so fall back to the raw bytes.
  return record.raw === undefined ? '' : JSON.stringify(record.raw);
}

/** The run named by `scope`, or undefined for 'all runs' / unknown id. */
export function scopedRun(s: PanelState): Run | undefined {
  if (s.scope === null) return undefined;
  return s.runs.find((run) => run.runId === s.scope);
}

/** Issues within the current scope. */
export function scopedIssues(s: PanelState): Issue[] {
  if (s.scope === null) return s.issues;
  return s.issues.filter((issue) => issue.runId === s.scope);
}

/** Issues attached to a given seq, cheapest lookup for row rendering. */
export function issuesBySeq(s: PanelState): Map<number, Issue[]> {
  const bySeq = new Map<number, Issue[]>();
  for (const issue of scopedIssues(s)) {
    const existing = bySeq.get(issue.seq);
    if (existing === undefined) bySeq.set(issue.seq, [issue]);
    else existing.push(issue);
  }
  return bySeq;
}

/** Counts for the toolbar badge. */
export function issueCounts(s: PanelState): {
  error: number;
  warning: number;
  info: number;
  total: number;
} {
  const counts = { error: 0, warning: 0, info: 0, total: 0 };
  for (const issue of scopedIssues(s)) {
    counts[issue.severity] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Records within the current scope, then the filter. Order preserved.
 *
 * Scoping goes through `Run.recordSeqs`, which is the run builder's own attribution — so a
 * keepalive, which is a real record but never enters `recordSeqs`, is visible under 'all runs'
 * and hidden under a run scope. An unknown scope id yields nothing rather than everything.
 *
 * "Carries an issue" is decided by `issuesBySeq`, not by `CaptureRecord.issues`: the run
 * builder attaches issues to the RUN, and the import path hands back the records it fed in,
 * whose own `issues` array stays empty. The seq index is the single source of truth for which
 * row is annotated, which is also what P7 relies on.
 */
export function visibleRecords(s: PanelState): CaptureRecord[] {
  let records = s.records;

  if (s.scope !== null) {
    const seqs = new Set(scopedRun(s)?.recordSeqs ?? []);
    records = records.filter((record) => seqs.has(record.seq));
  }

  if (s.filter.issuesOnly) {
    const bySeq = issuesBySeq(s);
    records = records.filter((record) => bySeq.has(record.seq));
  }

  const needle = s.filter.text.toLowerCase();
  if (needle !== '') {
    records = records.filter((record) => serializeRecord(record).toLowerCase().includes(needle));
  }

  return records;
}

/** The record for `selectedSeq`, or undefined. */
export function selectedRecord(s: PanelState): CaptureRecord | undefined {
  if (s.selectedSeq === null) return undefined;
  return s.records.find((record) => record.seq === s.selectedSeq);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/model/selectors.test.ts`
Expected: PASS, 24 tests. Then `pnpm typecheck` and `pnpm lint` clean.

- [ ] **Step 5: Commit**

`git commit -m "Task 3: panel selectors — scope, filter, issue counts and seq index"`

---

### Task 4: JSONL import — the productionised fixture replay

The load-bearing task of phase 1. `loadJsonl` is the whole of P8: it replays a `.agui.jsonl` file
through the *same* `run-builder` fold live capture will use, so every tab can be built, demoed and
tested with no capture layer, no Chrome API and no service worker. It is the productionised form of
`src/test/integration.test.ts`'s `buildFrom`, and it stays deliberately consistent with it — the
malformed fixture's three issues are asserted at the same codes and seqs that test already pins.

**Files:**
- Create: `packages/devtools/src/panel/import/load-jsonl.ts`
- Test: `packages/devtools/src/panel/import/load-jsonl.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { loadJsonl } from './load-jsonl';

function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');
}

const key = (issues: { code: string; seq: number }[]): string[] =>
  issues.map((issue) => `${issue.code}@${issue.seq}`).sort();

describe('loadJsonl: happy-run', () => {
  it('rebuilds one clean run with its records in seq order', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.issues).toEqual([]);
    expect(loaded.runs).toHaveLength(1);

    const run = loaded.runs[0]!;
    expect(run.runId).toBe('r_happy');
    expect(run.threadId).toBe('t_happy');
    expect(run.outcome).toBe('finished');
    expect(run.messages.get('m_1')?.content).toBe(
      'The weather in Paris is sunny and 24 degrees.\nEnjoy!',
    );
    expect(run.toolCalls.get('tc_1')?.args).toEqual({ city: 'Paris', units: 'metric' });

    // Header and request lines are not records; every event and keepalive line is one.
    expect(loaded.records.map((record) => record.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('keeps the keepalive as a record but out of recordSeqs', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    const keepalive = loaded.records.find((record) => record.kind === 'keepalive');
    expect(keepalive).toBeDefined();
    expect(keepalive?.seq).toBe(11);
    // A19: the union is what makes `comment` reachable at all.
    expect(keepalive?.kind === 'keepalive' ? keepalive.comment : undefined).toBe('ping');

    expect(loaded.runs[0]!.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
    expect(loaded.runs[0]!.recordSeqs).not.toContain(11);
  });

  it('carries the POST body through as the run input', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    expect((loaded.runs[0]!.input as { threadId?: string }).threadId).toBe('t_happy');
  });
});

describe('loadJsonl: malformed', () => {
  it('surfaces exactly the three issues the integration test pins', () => {
    const loaded = loadJsonl(fixture('malformed.agui.jsonl'));

    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.issues).toHaveLength(3);
    expect(key(loaded.issues)).toEqual([
      'empty-text-delta@5',
      'run-never-terminated@10',
      'state-patch-failed@9',
    ]);

    expect(loaded.runs).toHaveLength(1);
    const run = loaded.runs[0]!;
    expect(run.runId).toBe('r_bad');
    // The connection is closed at the last frame's tMs, so a run still 'running' aborts.
    expect(run.outcome).toBe('aborted');
    // Every issue is attributed to the run that raised it, which is what `scopedIssues` reads.
    expect(loaded.issues.every((issue) => issue.runId === 'r_bad')).toBe(true);
  });
});

describe('loadJsonl: chunked-run', () => {
  it('reconstructs message content and parsed tool args with expandChunks: true', () => {
    const loaded = loadJsonl(fixture('chunked-run.agui.jsonl'), { expandChunks: true });

    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.issues).toEqual([]);
    expect(loaded.runs).toHaveLength(1);

    const run = loaded.runs[0]!;
    expect(run.runId).toBe('r_chunk');
    expect(run.outcome).toBe('finished');
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const message = run.messages.get('m_1');
    expect(message?.content).toBe('Hello, world!');
    expect(message?.closed).toBe(true);

    const toolCall = run.toolCalls.get('tc_1');
    expect(toolCall?.toolCallName).toBe('search_docs');
    expect(toolCall?.closed).toBe(true);
    expect(toolCall?.args).toEqual({ q: 'ag-ui', limit: 5 });
    expect(toolCall?.argsParseError).toBeUndefined();
  });

  it('leaves the chunks unexpanded when expandChunks is false', () => {
    const loaded = loadJsonl(fixture('chunked-run.agui.jsonl'), { expandChunks: false });

    const run = loaded.runs[0]!;
    expect(run.messages.size).toBe(0);
    expect(run.toolCalls.size).toBe(0);
    // The raw records are unchanged either way — only the model built from them differs.
    expect(loaded.records).toHaveLength(7);
  });
});

describe('loadJsonl: bad input', () => {
  it('reports a malformed line in decodeErrors and still loads the rest', () => {
    const text = [
      '{"kind":"event","connId":"c1","seq":1,"tMs":1,"event":{"type":"RUN_STARTED","threadId":"t","runId":"r"}}',
      '{oops',
      '{"kind":"event","connId":"c1","seq":2,"tMs":2,"event":{"type":"RUN_FINISHED","threadId":"t","runId":"r"}}',
    ].join('\n');

    const loaded = loadJsonl(text);

    expect(loaded.decodeErrors).toHaveLength(1);
    expect(loaded.decodeErrors[0]).toContain('line 2');
    expect(loaded.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0]!.outcome).toBe('finished');
  });

  it('returns empty everything for an empty string', () => {
    const loaded = loadJsonl('');

    expect(loaded).toEqual({ runs: [], records: [], issues: [], decodeErrors: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/import/load-jsonl.test.ts`
Expected: FAIL with `Error: Cannot find module './load-jsonl' imported from
src/panel/import/load-jsonl.test.ts` — the suite collects zero tests.

- [ ] **Step 3: Write the implementation**

```ts
import { decodeJsonl, type JsonlEvent, type JsonlKeepalive } from '../../core/jsonl/codec';
import { createRunBuilder } from '../../core/normalizer/run-builder';
import type { AguiEvent, CaptureRecord, Issue, Run } from '../../core/model/types';

export interface LoadedCapture {
  runs: Run[];
  records: CaptureRecord[];
  issues: Issue[];
  /** One entry per malformed line, from `decodeJsonl`. Surfaced, never swallowed. */
  decodeErrors: string[];
}

/**
 * A decoded payload is `unknown` — the codec deliberately does not validate event shape. A
 * non-object payload becomes `null`, which is the `event` arm's own "could not be parsed"
 * value: the run builder still records such a frame and still surfaces it, rather than
 * dropping it or letting a cast smuggle a string in as an `AguiEvent`.
 */
function asAguiEvent(value: unknown): AguiEvent | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AguiEvent)
    : null;
}

/** A19: `CaptureRecord` is a union on `kind`, so an event record must say so explicitly. */
function toEventRecord(line: JsonlEvent): CaptureRecord {
  return {
    kind: 'event',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: line.event,
    event: asAguiEvent(line.event),
    issues: [],
  };
}

/**
 * `raw` is reconstituted as the SSE comment bytes the frame occupied on the wire (Task 12's
 * convention), so `totalStreamBytes` counts an imported keepalive identically to a captured one.
 */
function toKeepaliveRecord(line: JsonlKeepalive): CaptureRecord {
  return {
    kind: 'keepalive',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: `:${line.comment}\n\n`,
    comment: line.comment,
    issues: [],
  };
}

/**
 * Decode `.agui.jsonl` text and replay it through the SAME run-builder path live capture uses.
 *
 * This is the whole of P8: no Chrome API, no service worker, no injection — the panel's model
 * comes out of the identical fold, so a capture-layer bug can never be confused with a
 * rendering bug.
 *
 * Never throws. A line that will not decode contributes one entry to `decodeErrors` and the
 * remaining lines still load, which is what makes a truncated capture openable.
 */
export function loadJsonl(text: string, options: { expandChunks?: boolean } = {}): LoadedCapture {
  const { lines, errors } = decodeJsonl(text);
  const builder = createRunBuilder({ expandChunks: options.expandChunks ?? true });
  const records: CaptureRecord[] = [];
  /** Every connection's last observed frame time — the moment it is closed at. */
  const lastTMsByConn = new Map<string, number>();

  for (const line of lines) {
    if (line.kind === 'request') {
      builder.addRequest(line.connId, line.method, line.url, line.input);
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'event') {
      const record = toEventRecord(line);
      records.push(record);
      builder.addRecord(record);
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'keepalive') {
      // A keepalive is a real frame: it extends the connection's lifetime and it is what a
      // `keepalive-gap` anchors to, even though it never enters `recordSeqs`.
      const record = toKeepaliveRecord(line);
      records.push(record);
      builder.addRecord(record);
      lastTMsByConn.set(line.connId, line.tMs);
    }
    // A `header` line carries no record; the Session tab reads it separately.
  }

  // Closing is what runs `finalizeRules`, so an unterminated run reports `run-never-terminated`
  // instead of sitting silently in 'running'.
  for (const [connId, tMs] of lastTMsByConn) builder.closeConnection(connId, tMs);

  return { runs: builder.runs(), records, issues: builder.allIssues(), decodeErrors: errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/import/load-jsonl.test.ts`
Expected: PASS, 8 tests. Then `pnpm vitest run` (whole package) to confirm the 355 existing core
tests plus `src/test/integration.test.ts` are untouched, and `pnpm typecheck && pnpm lint` clean.

- [ ] **Step 5: Commit**

`git commit -m "Task 4: loadJsonl — replay .agui.jsonl through the live-capture run builder"`

---

### Task 5a: Layout breakpoint and `useIsNarrow`

P4 fixes the narrow breakpoint at 600px and the contract requires it to exist exactly once. This
cycle establishes that single declaration before any component can be tempted to inline a `600`.

**Files:**
- Create: `packages/devtools/src/panel/common/layout.ts`
- Test: `packages/devtools/src/panel/common/layout.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/preact';
import type { JSX } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { NARROW_BREAKPOINT_PX, NARROW_MEDIA_QUERY, useIsNarrow } from './layout';

interface FakeMatchMedia {
  /** Every query string the hook asked for. */
  readonly queries: string[];
  /** Fire a `change` event, as a resize past the breakpoint would. */
  emit: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMatchMedia {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const queries: string[] = [];
  let matches = initialMatches;

  const mql = {
    get matches() {
      return matches;
    },
    media: '',
    addEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
      if (type === 'change') listeners.delete(listener);
    },
  };

  window.matchMedia = (query: string): MediaQueryList => {
    queries.push(query);
    mql.media = query;
    return mql as unknown as MediaQueryList;
  };

  return {
    queries,
    emit(next: boolean): void {
      matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
      });
    },
    listenerCount: () => listeners.size,
  };
}

function Probe(): JSX.Element {
  return <span data-testid="probe">{String(useIsNarrow())}</span>;
}

function probeText(): string {
  return screen.getByTestId('probe').textContent ?? '';
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('NARROW_BREAKPOINT_PX', () => {
  it('is the single 600px declaration from P4', () => {
    expect(NARROW_BREAKPOINT_PX).toBe(600);
  });

  it('derives the media query rather than restating the number', () => {
    expect(NARROW_MEDIA_QUERY).toBe(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);
  });
});

describe('useIsNarrow', () => {
  it('reports narrow when the breakpoint query matches on mount', () => {
    const media = installMatchMedia(true);
    render(<Probe />);
    expect(probeText()).toBe('true');
    expect(media.queries).toContain(NARROW_MEDIA_QUERY);
  });

  it('reports wide when the query does not match', () => {
    installMatchMedia(false);
    render(<Probe />);
    expect(probeText()).toBe('false');
  });

  it('follows a change event in both directions', () => {
    const media = installMatchMedia(false);
    render(<Probe />);

    media.emit(true);
    expect(probeText()).toBe('true');

    media.emit(false);
    expect(probeText()).toBe('false');
  });

  it('unsubscribes on unmount', () => {
    const media = installMatchMedia(true);
    const view = render(<Probe />);
    expect(media.listenerCount()).toBe(1);

    view.unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it('falls back to wide when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    render(<Probe />);
    expect(probeText()).toBe('false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/common/layout.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./layout" from "src/panel/common/layout.test.tsx". Does the file exist?`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Layout constants shared across the panel.
 *
 * Design decision P4 puts the Timeline's list/detail split — and the waterfall's collapse —
 * at the same ~600px width. That number is declared exactly once, here. A second copy in a
 * media query or a component would drift the moment one of them is tuned, and the symptom
 * (a detail pane that stacks at a width where the waterfall has not yet collapsed) is
 * invisible in unit tests.
 */
import { useEffect, useState } from 'preact/hooks';

/** P4: below this width the Timeline stacks and the waterfall collapses to one line. */
export const NARROW_BREAKPOINT_PX = 600;

/**
 * The media query `useIsNarrow` watches, derived from the constant rather than restated.
 * Exported so a stylesheet generator or a test can assert on it without re-deriving `599`.
 */
export const NARROW_MEDIA_QUERY = `(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`;

/**
 * `matchMedia` is missing in bare jsdom and in any non-browser host, so every access goes
 * through here. Returning `null` rather than throwing keeps the hook usable in a plain
 * `node` test, where "not narrow" is the right default.
 */
function narrowMediaQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(NARROW_MEDIA_QUERY);
}

/** True while the panel viewport is narrower than {@link NARROW_BREAKPOINT_PX}. */
export function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState<boolean>(() => narrowMediaQueryList()?.matches ?? false);

  useEffect(() => {
    const mql = narrowMediaQueryList();
    if (mql === null) return;

    const onChange = (event: MediaQueryListEvent): void => {
      setIsNarrow(event.matches);
    };

    // Re-read on subscribe: the width can change between the initial render and the effect.
    setIsNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, []);

  return isNarrow;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/common/layout.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```
git add packages/devtools/src/panel/common/layout.ts packages/devtools/src/panel/common/layout.test.tsx
git commit -m "feat(panel): single 600px breakpoint declaration and useIsNarrow (P4)"
```

---

### Task 5b: `windowRange` — the windowing maths

The arithmetic behind virtualization, isolated so its edge cases are cheap to enumerate. Design §6
makes windowing mandatory (a long run is comfortably 10k events) and the failure mode of getting it
slightly wrong is blank rows at a scroll position no component test happens to visit.

The test file carries a `@vitest-environment node` docblock: it lives under `src/panel/**`, so the
contract's project config would otherwise run it under jsdom. The docblock keeps it honest — the
maths must never grow a DOM dependency.

**Files:**
- Create: `packages/devtools/src/panel/common/window-range.ts`
- Test: `packages/devtools/src/panel/common/window-range.test.ts`

- [ ] **Step 6: Write the failing test**

```ts
/**
 * @vitest-environment node
 *
 * Pure arithmetic: no DOM needed, and running it under `node` keeps the guarantee that the
 * windowing logic never quietly grows a document dependency.
 */
import { describe, expect, it } from 'vitest';

import { windowRange } from './window-range';

describe('windowRange', () => {
  it('returns an empty range for an empty list', () => {
    expect(windowRange(0, 200, 20, 0, 4)).toEqual({ start: 0, end: 0 });
  });

  it('renders every row when the list is shorter than the viewport', () => {
    // 3 rows of 20px inside a 200px viewport: nothing to window.
    expect(windowRange(0, 200, 20, 3, 4)).toEqual({ start: 0, end: 3 });
  });

  it('starts at 0 and covers exactly the viewport at scrollTop 0 with no overscan', () => {
    expect(windowRange(0, 200, 20, 1000, 0)).toEqual({ start: 0, end: 10 });
  });

  it('treats end as exclusive', () => {
    const { start, end } = windowRange(0, 200, 20, 1000, 0);
    // 10 rows rendered — indices 0..9 — so index 10 is the first one outside.
    expect(end - start).toBe(10);
    expect(end).toBe(10);
  });

  it('includes the row straddling the top edge for a fractional scrollTop', () => {
    // Rows cover 10..210, i.e. indices 0 through 10 inclusive.
    expect(windowRange(10.5, 200, 20, 1000, 0)).toEqual({ start: 0, end: 11 });
  });

  it('keeps a partially scrolled window aligned to the rows it overlaps', () => {
    // 205..405 overlaps rows 10..20 inclusive.
    expect(windowRange(205, 200, 20, 1000, 0)).toEqual({ start: 10, end: 21 });
  });

  it('clamps end to count when scrolled to the exact end', () => {
    // 100 rows of 20px = 2000px of content in a 200px viewport: maxScrollTop is 1800.
    expect(windowRange(1800, 200, 20, 100, 0)).toEqual({ start: 90, end: 100 });
  });

  it('clamps start at 0 when overscan would run off the top', () => {
    expect(windowRange(0, 200, 20, 1000, 5)).toEqual({ start: 0, end: 15 });
  });

  it('clamps end at count when overscan would run off the bottom', () => {
    expect(windowRange(1800, 200, 20, 100, 5)).toEqual({ start: 85, end: 100 });
  });

  it('applies overscan at both ends in the middle of a long list', () => {
    expect(windowRange(2000, 200, 20, 1000, 3)).toEqual({ start: 97, end: 113 });
  });

  it('covers the partial final row when rowHeight does not divide the height evenly', () => {
    // 200 / 30 = 6.67: seven rows overlap the viewport, the last one only partly.
    expect(windowRange(0, 200, 30, 1000, 0)).toEqual({ start: 0, end: 7 });
    // 45..245 overlaps rows 1..8 inclusive.
    expect(windowRange(45, 200, 30, 1000, 0)).toEqual({ start: 1, end: 9 });
  });

  it('never returns a range outside [0, count] for any scroll position', () => {
    const count = 137;
    const rowHeight = 18;
    const height = 211;
    for (let scrollTop = -50; scrollTop <= count * rowHeight + 50; scrollTop += 7) {
      const { start, end } = windowRange(scrollTop, height, rowHeight, count, 6);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(count);
      expect(end).toBeGreaterThanOrEqual(start);
    }
  });

  it('covers every visible row for any scroll position', () => {
    const count = 137;
    const rowHeight = 18;
    const height = 211;
    for (let scrollTop = 0; scrollTop <= count * rowHeight - height; scrollTop += 3) {
      const { start, end } = windowRange(scrollTop, height, rowHeight, count, 0);
      // Anything painted between the viewport edges must be inside [start, end).
      expect(start * rowHeight).toBeLessThanOrEqual(scrollTop);
      expect(end * rowHeight).toBeGreaterThanOrEqual(scrollTop + height);
    }
  });

  it('clamps a negative scrollTop from elastic overscroll to the top of the list', () => {
    expect(windowRange(-120, 200, 20, 1000, 2)).toEqual({ start: 0, end: 12 });
  });

  it('returns an empty range for a non-positive rowHeight instead of dividing by zero', () => {
    expect(windowRange(0, 200, 0, 1000, 4)).toEqual({ start: 0, end: 0 });
    expect(windowRange(0, 200, -20, 1000, 4)).toEqual({ start: 0, end: 0 });
  });

  it('returns an empty range when scrolled past the end of a shrunken list', () => {
    expect(windowRange(5000, 200, 20, 10, 2)).toEqual({ start: 10, end: 10 });
  });

  it('rounds a fractional overscan up so it never under-renders', () => {
    expect(windowRange(400, 200, 20, 1000, 1.2)).toEqual({ start: 18, end: 32 });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/panel/common/window-range.test.ts`
Expected: FAIL with `Error: Cannot find module './window-range' imported from .../src/panel/common/window-range.test.ts`

- [ ] **Step 8: Write the implementation**

```ts
/**
 * The windowing maths behind `VirtualList`, kept pure and DOM-free.
 *
 * Design §6 makes virtualization mandatory — a long run is comfortably 10k events — and the
 * failure mode of getting it slightly wrong is blank rows at a scroll position no component
 * test happens to visit. Isolating the arithmetic is what makes those positions cheap to
 * enumerate.
 */

/**
 * The half-open range of item indices to render for a given scroll position.
 *
 * `start` is clamped to `>= 0` and `end` to `<= count`; `end` is exclusive. `overscan` rows
 * are added at each end and clamped with everything else, so a caller never has to re-clamp.
 */
export function windowRange(
  scrollTop: number,
  height: number,
  rowHeight: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  // A zero or negative row height would divide by zero and produce Infinity indices.
  if (!Number.isFinite(rowHeight) || rowHeight <= 0 || count <= 0) return { start: 0, end: 0 };

  // Elastic overscroll reports a negative scrollTop; NaN reaches here from an unlaid-out node.
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const viewport = Number.isFinite(height) && height > 0 ? height : 0;
  const pad = Number.isFinite(overscan) && overscan > 0 ? Math.ceil(overscan) : 0;

  // Exact cover: the first row overlapping the top edge through the last overlapping the
  // bottom edge. `ceil` on the bottom is what keeps a partially visible final row rendered.
  const firstVisible = Math.floor(top / rowHeight);
  const endVisible = Math.ceil((top + viewport) / rowHeight);

  const start = clamp(firstVisible - pad, 0, count);
  const end = clamp(endVisible + pad, start, count);
  return { start, end };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/panel/common/window-range.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 10: Commit**

```
git add packages/devtools/src/panel/common/window-range.ts packages/devtools/src/panel/common/window-range.test.ts
git commit -m "feat(panel): pure windowRange maths for the virtualized list"
```

---

### Task 5c: `VirtualList`

The Preact wrapper around `windowRange`: a scroll viewport, a sizer holding the full scroll height,
and an absolutely positioned window of rows offset by transform.

Two decisions worth stating up front, because the tests below encode them:

1. **Rows are not wrapped.** `renderRow` output goes straight into the window and the caller
   supplies the key. Wrapping each row in a `<div key={index}>` here would reintroduce exactly the
   array-index keying P7 forbids. Row height therefore comes from the `--agui-vlist-row-height`
   custom property, set on the window and applied by CSS to `> *`.
2. **Scroll position is component state, not a DOM read-back.** `scrollTo` writes both the element
   and the state. jsdom stores `scrollTop` but never emits a `scroll` event for a programmatic
   write, so a read-back design would make the follow behaviour untestable.

**Files:**
- Create: `packages/devtools/src/panel/common/virtual-list.tsx`
- Modify: `packages/devtools/src/panel/panel.css`
- Test: `packages/devtools/src/panel/common/virtual-list.test.tsx`

- [ ] **Step 11: Write the failing test**

```tsx
import { fireEvent, render } from '@testing-library/preact';
import type { JSX } from 'preact';
import { describe, expect, it } from 'vitest';

import { VirtualList } from './virtual-list';

const ROW_HEIGHT = 20;

function rows(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function renderRow(item: number): JSX.Element {
  return <div key={item}>row {item}</div>;
}

interface Parts {
  viewport: HTMLElement;
  sizer: HTMLElement;
  window: HTMLElement;
}

function parts(container: Element): Parts {
  const viewport = container.querySelector<HTMLElement>('.agui-vlist');
  const sizer = container.querySelector<HTMLElement>('.agui-vlist__sizer');
  const window_ = container.querySelector<HTMLElement>('.agui-vlist__window');
  if (viewport === null || sizer === null || window_ === null) throw new Error('list did not render');
  return { viewport, sizer, window: window_ };
}

function renderedIndices(container: Element): number[] {
  return [...parts(container).window.children].map((child) =>
    Number((child.textContent ?? '').replace('row ', '')),
  );
}

describe('VirtualList', () => {
  it('renders only a window of rows for a large list', () => {
    const { container } = render(
      <VirtualList
        items={rows(10_000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
      />,
    );

    // 200px / 20px = 10 visible rows, plus 2 rows of overscan below.
    expect(renderedIndices(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(container.textContent).toContain('row 0');
    expect(container.textContent).not.toContain('row 500');
  });

  it('sizes the spacer to the full scroll height, not the window', () => {
    const { container } = render(
      <VirtualList items={rows(10_000)} rowHeight={ROW_HEIGHT} height={200} renderRow={renderRow} />,
    );

    expect(parts(container).sizer.style.height).toBe('200000px');
    expect(parts(container).viewport.style.height).toBe('200px');
  });

  it('offsets the window so rendered rows sit at their real scroll position', () => {
    const { container } = render(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
      />,
    );

    const { viewport, window: listWindow } = parts(container);
    viewport.scrollTop = 4000;
    fireEvent.scroll(viewport);

    // start = floor(4000 / 20) - 2 = 198
    expect(renderedIndices(container)[0]).toBe(198);
    expect(listWindow.style.transform).toBe('translateY(3960px)');
  });

  it('scrolls a row into range for scrollToIndex', () => {
    const { container, rerender } = render(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
      />,
    );
    expect(renderedIndices(container)).not.toContain(500);

    rerender(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
        scrollToIndex={500}
      />,
    );

    // Scrolls the minimum distance: row 500's bottom edge lands on the viewport's.
    expect(parts(container).viewport.scrollTop).toBe(501 * ROW_HEIGHT - 200);
    expect(renderedIndices(container)).toContain(500);
  });

  it('scrolls backwards for an index above the window', () => {
    const props = {
      items: rows(1000),
      rowHeight: ROW_HEIGHT,
      height: 200,
      overscan: 2,
      renderRow,
    };
    const { container, rerender } = render(<VirtualList {...props} scrollToIndex={500} />);
    rerender(<VirtualList {...props} scrollToIndex={10} />);

    expect(parts(container).viewport.scrollTop).toBe(10 * ROW_HEIGHT);
    expect(renderedIndices(container)).toContain(10);
  });

  it('leaves the scroll position alone when the index is already visible', () => {
    const props = {
      items: rows(1000),
      rowHeight: ROW_HEIGHT,
      height: 200,
      overscan: 2,
      renderRow,
    };
    const { container, rerender } = render(<VirtualList {...props} scrollToIndex={500} />);
    const before = parts(container).viewport.scrollTop;

    rerender(<VirtualList {...props} scrollToIndex={495} />);
    expect(parts(container).viewport.scrollTop).toBe(before);
  });

  it('tails appended items while pinned to the bottom (P6)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow, follow: true };
    const { container, rerender } = render(<VirtualList {...props} items={rows(30)} />);

    expect(renderedIndices(container)).toContain(29);
    expect(parts(container).viewport.scrollTop).toBe(30 * ROW_HEIGHT - 100);

    rerender(<VirtualList {...props} items={rows(40)} />);
    expect(renderedIndices(container)).toContain(39);
    expect(parts(container).viewport.scrollTop).toBe(40 * ROW_HEIGHT - 100);
  });

  it('stops following the moment the user scrolls up (P6)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow, follow: true };
    const { container, rerender } = render(<VirtualList {...props} items={rows(40)} />);
    expect(renderedIndices(container)).toContain(39);

    const { viewport } = parts(container);
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(renderedIndices(container)).toContain(0);
    expect(renderedIndices(container)).not.toContain(39);

    rerender(<VirtualList {...props} items={rows(50)} />);
    expect(parts(container).viewport.scrollTop).toBe(0);
    expect(renderedIndices(container)).not.toContain(49);
    expect(renderedIndices(container)).toContain(0);
  });

  it('resumes following once the user scrolls back to the bottom', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow, follow: true };
    const { container, rerender } = render(<VirtualList {...props} items={rows(40)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 40 * ROW_HEIGHT - 100;
    fireEvent.scroll(viewport);

    rerender(<VirtualList {...props} items={rows(50)} />);
    expect(renderedIndices(container)).toContain(49);
  });

  it('does not tail when follow is off', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(30)} />);
    expect(renderedIndices(container)).toContain(0);

    rerender(<VirtualList {...props} items={rows(40)} />);
    expect(parts(container).viewport.scrollTop).toBe(0);
    expect(renderedIndices(container)).not.toContain(39);
  });

  /*
   * `scrollTop` is state but `count` is a prop, so a shrink re-renders with a scroll position
   * that no longer exists. Every other shrink test here has `follow` on, and the follow effect
   * re-pins before the render is seen — these three deliberately leave it off, which is the
   * filter case P7 hits on every keystroke.
   */
  it('renders the whole list when it shrinks under a scrolled viewport (follow off)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 200, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(1000)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 1000 * ROW_HEIGHT - 200;
    fireEvent.scroll(viewport);
    expect(renderedIndices(container)).toContain(999);

    rerender(<VirtualList {...props} items={rows(10)} />);

    // All ten rows fit the 200px viewport, so all ten must render.
    expect(renderedIndices(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('renders the tail when the list shrinks past the scroll position (follow off)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 200, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(1000)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 900 * ROW_HEIGHT;
    fireEvent.scroll(viewport);

    rerender(<VirtualList {...props} items={rows(300)} />);

    // Clamped to maxScrollTop = 300 * 20 - 200 = 5800, so start = 5800/20 - 2 = 288.
    expect(renderedIndices(container)).toEqual([288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299]);
  });

  it('recovers when the list empties and refills while scrolled (follow off)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 200, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(1000)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 1000 * ROW_HEIGHT - 200;
    fireEvent.scroll(viewport);

    rerender(<VirtualList {...props} items={rows(0)} />);
    expect(parts(container).window.children.length).toBe(0);

    rerender(<VirtualList {...props} items={rows(20)} />);
    expect(renderedIndices(container).length).toBeGreaterThan(0);
    expect(renderedIndices(container)).toContain(19);
  });

  it('renders nothing but a zero-height spacer for an empty list', () => {
    const { container } = render(
      <VirtualList items={[]} rowHeight={ROW_HEIGHT} height={200} renderRow={renderRow} />,
    );

    expect(parts(container).window.children.length).toBe(0);
    expect(parts(container).sizer.style.height).toBe('0px');
  });

  it('publishes the row height as a custom property so rows can size themselves', () => {
    const { container } = render(
      <VirtualList items={rows(5)} rowHeight={ROW_HEIGHT} height={200} renderRow={renderRow} />,
    );

    expect(parts(container).window.style.getPropertyValue('--agui-vlist-row-height')).toBe('20px');
  });

  it('passes the absolute index to renderRow, not the window offset', () => {
    const seen: number[] = [];
    const { container } = render(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={0}
        renderRow={(item: number, index: number) => {
          seen.push(index);
          return <div key={item}>row {item}</div>;
        }}
      />,
    );

    const { viewport } = parts(container);
    seen.length = 0;
    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);

    expect(seen[0]).toBe(50);
    expect(renderedIndices(container)[0]).toBe(50);
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/panel/common/virtual-list.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./virtual-list" from "src/panel/common/virtual-list.test.tsx". Does the file exist?`

- [ ] **Step 13: Write the implementation**

`packages/devtools/src/panel/common/virtual-list.tsx`:

```tsx
/**
 * A minimal fixed-height windowing list.
 *
 * Design §6 rules out a grid dependency, so this is the whole implementation: a scroll
 * viewport, a sizer that holds the full scroll height, and an absolutely positioned window
 * of rows offset by transform. The arithmetic lives in `./window-range` so it can be tested
 * without a DOM.
 *
 * Rows are rendered by the caller and are NOT wrapped in a keyed element here — P7 requires
 * event rows to be keyed by `CaptureRecord.seq`, and a wrapper keyed by array index would
 * quietly defeat that. `renderRow` must therefore return a single element; its height comes
 * from the `--agui-vlist-row-height` custom property set on the window.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { windowRange } from './window-range';

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Fixed row height in px. Phase 1 assumes uniform rows. */
  rowHeight: number;
  /** Viewport height in px. */
  height: number;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  renderRow: (item: T, index: number) => ComponentChildren;
  /** Scroll so this index is visible. Ignored when undefined. */
  scrollToIndex?: number;
  /** True while the list should tail new items (P6). */
  follow?: boolean;
}

const DEFAULT_OVERSCAN = 4;

/**
 * Slack when deciding "is the user still at the bottom". Fractional device pixel ratios put
 * scrollTop a hair below the maximum at rest, and an exact comparison would read that as the
 * user having scrolled up — turning follow off on the first appended row.
 */
const PIN_SLACK_PX = 2;

export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  const { items, rowHeight, height, renderRow, scrollToIndex, follow = false } = props;
  const overscan = props.overscan ?? DEFAULT_OVERSCAN;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  /** P6: starts pinned, and only a user scroll away from the bottom clears it. */
  const pinnedRef = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);

  const count = items.length;
  const totalHeight = count * rowHeight;
  const maxScrollTop = Math.max(0, totalHeight - height);

  // Read by the effects below without listing them as dependencies, so appending an item
  // cannot re-trigger a `scrollToIndex` that the user has already scrolled away from.
  const metricsRef = useRef({ count, rowHeight, height, maxScrollTop });
  metricsRef.current = { count, rowHeight, height, maxScrollTop };

  /**
   * State is the source of truth for what is rendered, and the element is written for real
   * scrolling. Both are set here: jsdom stores `scrollTop` but never emits a `scroll` event
   * for a programmatic write, so relying on the round-trip would make follow untestable.
   */
  const scrollTo = (top: number): void => {
    const el = viewportRef.current;
    if (el !== null) el.scrollTop = top;
    scrollTopRef.current = top;
    setScrollTop(top);
  };

  const handleScroll = (): void => {
    const el = viewportRef.current;
    if (el === null) return;
    const next = el.scrollTop;
    pinnedRef.current = next >= metricsRef.current.maxScrollTop - PIN_SLACK_PX;
    scrollTopRef.current = next;
    setScrollTop(next);
  };

  // P6: tail while pinned. `maxScrollTop` moves whenever an item is appended, which is
  // exactly when the tail needs re-pinning.
  useLayoutEffect(() => {
    if (!follow || !pinnedRef.current) return;
    if (scrollTopRef.current !== maxScrollTop) scrollTo(maxScrollTop);
  }, [follow, maxScrollTop]);

  // Declared after follow so an explicit request wins if both fire in the same commit.
  useLayoutEffect(() => {
    if (scrollToIndex === undefined) return;
    const metrics = metricsRef.current;
    if (metrics.count === 0) return;

    const index = clamp(Math.floor(scrollToIndex), 0, metrics.count - 1);
    const rowTop = index * metrics.rowHeight;
    const rowBottom = rowTop + metrics.rowHeight;
    const current = scrollTopRef.current;

    let next = current;
    if (rowTop < current) next = rowTop;
    else if (rowBottom > current + metrics.height) next = rowBottom - metrics.height;

    next = clamp(next, 0, metrics.maxScrollTop);
    if (next !== current) scrollTo(next);
  }, [scrollToIndex]);

  /*
   * `scrollTop` is state but `count` is a prop, so a shrink — a filter change, a cleared
   * capture — renders once with a scroll position the shortened list no longer has. Feeding
   * that stale value straight to `windowRange` clamps `start` to `count` and yields an empty
   * range: a list that looks like it lost its data. The browser fixes the element's own
   * scrollTop a frame later at best (and jsdom never does), so clamp at the point of use.
   */
  const effectiveScrollTop = Math.min(scrollTop, maxScrollTop);
  const { start, end } = windowRange(effectiveScrollTop, height, rowHeight, count, overscan);
  const rows = items.slice(start, end).map((item, offset) => renderRow(item, start + offset));

  return (
    <div
      ref={viewportRef}
      class="agui-vlist"
      style={{ height: `${height}px` }}
      onScroll={handleScroll}
    >
      <div class="agui-vlist__sizer" style={{ height: `${totalHeight}px` }}>
        <div
          class="agui-vlist__window"
          style={`transform: translateY(${start * rowHeight}px); --agui-vlist-row-height: ${rowHeight}px;`}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
```

Append to `packages/devtools/src/panel/panel.css` (structural only — no colours, so it inherits the
existing tokens and is legible in both schemes by construction):

```css
/**
 * Virtualized list (design §6). Purely structural: the list paints no colour of its own, so
 * rows inherit `--agui-fg` / `--agui-bg` from `:root` and work in both schemes unchanged.
 *
 * The sizer carries the full scroll height so the scrollbar reflects the whole list rather
 * than the rendered window, and the window is offset by transform rather than `top` so
 * scrolling never triggers layout.
 */
.agui-vlist {
  position: relative;
  /* `height` is set inline from the prop: the viewport height is data, not style. */
  overflow-y: auto;
  overflow-x: hidden;
}

.agui-vlist__sizer {
  position: relative;
  width: 100%;
}

.agui-vlist__window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  /* `transform` and `--agui-vlist-row-height` are set inline; both are data. */
}

/*
 * Rows are the caller's elements — VirtualList never wraps them, so that P7's `seq` keys are
 * the only keys in play. Fixed height is imposed here instead.
 */
.agui-vlist__window > * {
  box-sizing: border-box;
  height: var(--agui-vlist-row-height);
  overflow: hidden;
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/panel/common/virtual-list.test.tsx`
Expected: PASS, 16 tests.

- [ ] **Step 15: Commit**

```
git add packages/devtools/src/panel/common/virtual-list.tsx packages/devtools/src/panel/common/virtual-list.test.tsx packages/devtools/src/panel/panel.css
git commit -m "feat(panel): VirtualList with overscan, scrollToIndex and bottom-pinned follow (P6)"
```

---

### Task 5d: `format.ts`

Display formatting for list rows. `summarizeEvent` is the one-line summary column of design §3 and
is capped hard at 80 characters: a row that grew to fit a 40kB tool-call argument blob would break
the fixed row height virtualization depends on.

The event *type* is its own column in the row, so `summarizeEvent` deliberately does not repeat it.

**Files:**
- Create: `packages/devtools/src/panel/common/format.ts`
- Test: `packages/devtools/src/panel/common/format.test.ts`

- [ ] **Step 16: Write the failing test**

```ts
/**
 * @vitest-environment node
 *
 * Pure formatting: no DOM needed.
 */
import { describe, expect, it } from 'vitest';

import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import { formatBytes, formatDuration, summarizeEvent } from './format';

function eventRecord(event: AguiEvent | null): CaptureRecord {
  return { kind: 'event', seq: 1, tMs: 0, connId: 'c_1', raw: null, issues: [], event };
}

function keepaliveRecord(comment: string): CaptureRecord {
  return { kind: 'keepalive', seq: 1, tMs: 0, connId: 'c_1', raw: null, issues: [], comment };
}

/**
 * True if any UTF-16 code unit is an unpaired surrogate — the thing that renders as a
 * replacement box. Checks the whole string, not just the end: a part sliced mid-pair puts one
 * in the middle of the row, where the trailing-only check would miss it.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('formatDuration', () => {
  it('renders an em dash for undefined', () => {
    expect(formatDuration(undefined)).toBe('—');
  });

  it('renders sub-second values in milliseconds', () => {
    expect(formatDuration(240)).toBe('240ms');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders seconds to two decimals', () => {
    expect(formatDuration(1840)).toBe('1.84s');
    expect(formatDuration(1000)).toBe('1.00s');
  });

  it('promotes a value that would round up past its unit', () => {
    expect(formatDuration(999.6)).toBe('1.00s');
    expect(formatDuration(59_999)).toBe('1m 0s');
  });

  it('renders a minute or more as minutes and seconds', () => {
    expect(formatDuration(83_000)).toBe('1m 23s');
    expect(formatDuration(600_000)).toBe('10m 0s');
  });

  it('renders an em dash for values that cannot be a duration', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('renders bytes below a kilobyte unscaled', () => {
    expect(formatBytes(840)).toBe('840 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('renders decimal kilobytes to one decimal', () => {
    expect(formatBytes(12_400)).toBe('12.4 kB');
  });

  it('drops a trailing .0', () => {
    expect(formatBytes(1000)).toBe('1 kB');
  });

  it('promotes to the next unit rather than rendering 1000 of the smaller one', () => {
    expect(formatBytes(999_999)).toBe('1 MB');
  });

  /*
   * The byte unit renders with `Math.round`, not `toFixed(1)`, so its promotion threshold is
   * 999.5 — not the 999.95 the loop uses one unit up. A `bytes < 1000` guard admits 999.5 and
   * then rounds it to the `1000 B` the loop exists to prevent.
   */
  it('promotes at the byte boundary too, where rounding is to whole bytes', () => {
    expect(formatBytes(999.4)).toBe('999 B');
    expect(formatBytes(999.5)).toBe('1 kB');
  });

  it('never renders 1000 of a unit at any scale', () => {
    const near = [999.4, 999.5, 999.9, 999.94, 999.95, 999.99, 999.999, 1000];
    const bad: string[] = [];
    // B through GB: `1000 TB` is the top unit overflowing, which no promotion can fix.
    for (let exponent = 0; exponent <= 3; exponent += 1) {
      for (const value of near) {
        const rendered = formatBytes(value * 1000 ** exponent);
        if (/^1000\b/.test(rendered)) bad.push(`${value * 1000 ** exponent} -> ${rendered}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('scales through megabytes and gigabytes', () => {
    expect(formatBytes(8_400_000)).toBe('8.4 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });

  it('renders zero and nonsense as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('summarizeEvent', () => {
  it('renders an id and its text payload', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello' }),
    );
    expect(summary).toBe('m_1 · "Hello"');
  });

  it('does not repeat the event type, which is its own column', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello' }),
    );
    expect(summary).not.toContain('TEXT_MESSAGE_CONTENT');
  });

  it('renders a bare name unquoted after the id', () => {
    expect(
      summarizeEvent(eventRecord({ type: 'TOOL_CALL_START', toolCallId: 'tc_1', toolCallName: 'search' })),
    ).toBe('tc_1 · search');
    expect(
      summarizeEvent(eventRecord({ type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' })),
    ).toBe('m_1 · assistant');
  });

  it('prefers the run id over the thread id', () => {
    expect(summarizeEvent(eventRecord({ type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' }))).toBe(
      'r_1',
    );
  });

  it('collapses whitespace so a multi-line delta stays one row', () => {
    expect(
      summarizeEvent(eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'a\n  b\tc' })),
    ).toBe('m_1 · "a b c"');
  });

  it('renders a structured payload as compact JSON', () => {
    expect(
      summarizeEvent(eventRecord({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: 1 }] })),
    ).toBe('[{"op":"add","path":"/a","value":1}]');
  });

  it('summarizes a keepalive with its comment', () => {
    expect(summarizeEvent(keepaliveRecord('ping'))).toBe('keepalive · ping');
  });

  it('summarizes a bare keepalive heartbeat', () => {
    expect(summarizeEvent(keepaliveRecord(''))).toBe('keepalive');
    expect(summarizeEvent(keepaliveRecord('   '))).toBe('keepalive');
  });

  it('summarizes a record whose payload would not parse', () => {
    expect(summarizeEvent(eventRecord(null))).toBe('unparsed payload');
  });

  it('returns an empty summary for an event with no distinctive fields', () => {
    expect(summarizeEvent(eventRecord({ type: 'CUSTOM_PING' }))).toBe('');
  });

  it('never returns more than 80 characters', () => {
    const records: CaptureRecord[] = [
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'x'.repeat(5000) }),
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'y'.repeat(300), delta: 'z'.repeat(300) }),
      eventRecord({ type: 'STATE_SNAPSHOT', snapshot: { items: Array.from({ length: 200 }, (_, i) => i) } }),
      eventRecord({ type: 'TOOL_CALL_ARGS', toolCallId: 't'.repeat(120), delta: '{"q":"…"}' }),
      keepaliveRecord('k'.repeat(400)),
      eventRecord(null),
      eventRecord({ type: 'CUSTOM_PING' }),
    ];
    for (const record of records) {
      expect(summarizeEvent(record).length).toBeLessThanOrEqual(80);
    }
  });

  it('marks truncation with an ellipsis', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'x'.repeat(5000) }),
    );
    expect(summary.length).toBe(80);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.startsWith('m_1 · "xxx')).toBe(true);
  });

  it('never truncates in the middle of a surrogate pair', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', delta: `${'a'.repeat(77)}😀😀` }),
    );
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith('…')).toBe(true);
    const lastKept = summary.charCodeAt(summary.length - 2);
    expect(lastKept >= 0xd800 && lastKept <= 0xdbff).toBe(false);
  });

  /*
   * `truncate` repairs a split surrogate pair, but it only runs when the text is *over* the
   * cap. Each branch that pre-slices its own part to exactly 80 units lands on
   * `text.length <= max` and returns early, so the repair never sees it. Sweeping the emoji
   * across the cap is what distinguishes "the one branch we thought about" from "every branch".
   */
  it('never leaves a lone surrogate at any emoji offset, in any branch', () => {
    const payload = (n: number): string => `${'a'.repeat(n)}😀😀`;
    const shapes: Record<string, (text: string) => CaptureRecord> = {
      string: (text) => eventRecord({ type: 'TEXT_MESSAGE_CONTENT', delta: text }),
      id: (text) => eventRecord({ type: 'TEXT_MESSAGE_START', messageId: text }),
      name: (text) => eventRecord({ type: 'TOOL_CALL_START', toolCallName: text }),
      jsonArray: (text) => eventRecord({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: text }] }),
      jsonObject: (text) => eventRecord({ type: 'STATE_SNAPSHOT', snapshot: { t: text } }),
      keepalive: (text) => keepaliveRecord(text),
    };

    const broken: string[] = [];
    for (const [shape, make] of Object.entries(shapes)) {
      for (let n = 0; n <= 120; n += 1) {
        const summary = summarizeEvent(make(payload(n)));
        if (summary.length > 80) broken.push(`${shape} n=${n}: ${summary.length} chars`);
        if (hasLoneSurrogate(summary)) broken.push(`${shape} n=${n}: lone surrogate`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('survives a payload that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeEvent(eventRecord({ type: 'CUSTOM', value: circular }))).toBe('[unserializable]');
  });
});
```

- [ ] **Step 17: Run test to verify it fails**

Run: `pnpm vitest run src/panel/common/format.test.ts`
Expected: FAIL with `Error: Cannot find module './format' imported from .../src/panel/common/format.test.ts`

- [ ] **Step 18: Write the implementation**

```ts
/**
 * Display formatting for panel rows.
 *
 * Everything here is pure and DOM-free. `summarizeEvent` in particular is the one-line
 * summary column of design §3's event list, and it is capped hard: a row that grows to fit
 * a 40kB tool-call argument blob would break the fixed row height virtualization depends on.
 */
import type { AguiEvent, CaptureRecord } from '../../core/model/types';

/** Contract cap: a summary must fit one list row. Never exceeded, including the ellipsis. */
const MAX_SUMMARY_CHARS = 80;

/** `1.84s`, `240ms`, `—` for undefined. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';

  // Round before branching: 999.6ms is `1.00s`, not `1000ms`.
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;

  // 59.995 rather than 60: 59999ms renders as `60.00s` at two decimals, which should have
  // promoted to `1m 0s`.
  const seconds = ms / 1000;
  if (seconds < 59.995) return `${seconds.toFixed(2)}s`;

  const totalSeconds = Math.round(seconds);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * Decimal units, matching how Chrome's own Network panel reports transfer sizes — the panel
 * sits next to it and disagreeing by 2.4% on the same bytes would read as a bug.
 */
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** `12.4 kB`, `840 B`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  // Round before branching, like formatDuration: bytes render whole, so 999.5 is `1000 B` —
  // the same "1000 of the smaller unit" the loop below refuses to emit one unit up.
  if (Math.round(bytes) < 1000) return `${Math.round(bytes)} B`;

  // Past the guard the value must promote, so the first division is unconditional. Leaving it
  // to the loop would strand 999.5 <= bytes < 999.95 in the byte unit as `999.5 B` — a
  // fractional byte count, which is the other half of the same rounding mismatch.
  let value = bytes / 1000;
  let unit = 1;
  // 999.95 rather than 1000: 999999 B rounds to `1000.0 kB` at one decimal, which should
  // have promoted to `1 MB`.
  while (value >= 999.95 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return `${value.toFixed(1).replace(/\.0$/, '')} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** Identity of the thing the event is about. First match wins. */
const ID_KEYS = ['messageId', 'toolCallId', 'runId', 'threadId'] as const;
/** A bare name or label that reads better unquoted. */
const NAME_KEYS = ['toolCallName', 'stepName', 'activityType', 'role'] as const;
/** The payload itself. Quoted when it is text, compact JSON otherwise. */
const VALUE_KEYS = ['delta', 'content', 'message', 'reason', 'result', 'value', 'snapshot', 'args'] as const;

/**
 * One-line summary of an event for a list row, e.g. `m_1 · "Hello"` — never longer than 80
 * chars. The event *type* is a separate column (design §3), so it is deliberately not
 * repeated here.
 */
export function summarizeEvent(record: CaptureRecord): string {
  if (record.kind === 'keepalive') {
    const comment = collapse(record.comment);
    return truncate(comment === '' ? 'keepalive' : `keepalive · ${comment}`, MAX_SUMMARY_CHARS);
  }

  const event = record.event;
  // A frame whose payload would not parse is still shown, per the model's own comment.
  if (event === null) return 'unparsed payload';

  const parts: string[] = [];
  const id = pickString(event, ID_KEYS);
  if (id !== undefined) parts.push(sliceUnits(collapse(id), MAX_SUMMARY_CHARS));
  const name = pickString(event, NAME_KEYS);
  if (name !== undefined) parts.push(sliceUnits(collapse(name), MAX_SUMMARY_CHARS));
  const value = pickValue(event, VALUE_KEYS);
  if (value !== undefined) {
    const rendered = renderValue(value);
    // A value that renders to nothing must not leave a dangling separator.
    if (rendered !== '') parts.push(rendered);
  }

  return truncate(parts.join(' · '), MAX_SUMMARY_CHARS);
}

function pickString(event: AguiEvent, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickValue(event: AguiEvent, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (event[key] !== undefined) return event[key];
  }
  return undefined;
}

function renderValue(value: unknown): string {
  // The quotes push a full-length string part to 82 units, past the cap and into `truncate`'s
  // own repair, so this is the one pre-slice that cannot strand a surrogate. Verified by the
  // offset sweep in the tests, which covers this branch too.
  if (typeof value === 'string') return `"${collapse(value).slice(0, MAX_SUMMARY_CHARS)}"`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    // `STATE_DELTA.delta` is an array of patch ops, not text, so the value branch has to
    // cope with structure as well as strings.
    const json = JSON.stringify(value);
    if (json === undefined) return '';
    return sliceUnits(collapse(json), MAX_SUMMARY_CHARS);
  } catch {
    // Circular structures reach here; a summary is never worth throwing over.
    return '[unserializable]';
  }
}

/** Newlines and runs of whitespace would break the single-line row. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `slice(0, max)` that refuses to cut a surrogate pair in half.
 *
 * Every branch that caps its own part before the parts are joined needs this: a part that
 * lands on exactly `max` units makes the joined text exactly `max` long, `truncate` returns
 * early on `text.length <= max`, and its repair never runs — so a half emoji reaches the row
 * and renders as a replacement box.
 */
function sliceUnits(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  // Never leave a lone high surrogate: an emoji cut in half renders as a replacement box.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
```

- [ ] **Step 19: Run test to verify it passes**

Run: `pnpm vitest run src/panel/common/format.test.ts`
Expected: PASS, 29 tests.

- [ ] **Step 20: Commit**

```
git add packages/devtools/src/panel/common/format.ts packages/devtools/src/panel/common/format.test.ts
git commit -m "feat(panel): formatDuration, formatBytes and 80-char summarizeEvent"
```

---

### Task 6: The shell — scope bar, run selector, tab strip, toolbar

Three fixed bands above the tab content (design §2): scope bar, tab strip, toolbar. This task builds
the four components that fill them. `App` composes them in Task 10; nothing here renders tab content.

The band that matters most is the toolbar's **issue badge**. P2 removes the Issues tab and pays for
that removal with one persistent, colour-coded, clickable count. If the badge is wrong, the tool's
differentiator is invisible — so its tests pin the scoped total, the three colour tones, the toggle,
and the fact that a filtered list is visibly filtered.

**Prerequisites:** `@testing-library/preact` + `jsdom` devDependencies, the two-project
`vitest.config.ts`, and `src/panel/test-setup.ts` are already in place from the test-environment
task. `PanelStore`, the actions, the selectors, `VirtualList`, `windowRange` and `format.ts` exist.

**Files:**
- Create: `src/panel/model/use-panel-state.ts`
- Create: `src/panel/shell/scope-bar.tsx`
- Test: `src/panel/shell/scope-bar.test.tsx`
- Create: `src/panel/shell/run-selector.tsx`
- Test: `src/panel/shell/run-selector.test.tsx`
- Create: `src/panel/shell/tab-strip.tsx`
- Test: `src/panel/shell/tab-strip.test.tsx`
- Create: `src/panel/shell/toolbar.tsx`
- Test: `src/panel/shell/toolbar.test.tsx`
- Modify: `src/panel/panel.css` (append only — the existing tokens stay)

---

#### Cycle 1 — scope bar (P3)

- [ ] **Step 1: Write the failing test**

Create `src/panel/shell/scope-bar.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/preact';
import type { Run, RunMetrics, RunOutcome } from '../../core/model/types';
import { createPanelStore, selectScope } from '../model/store';
import { initialPanelState } from '../model/panel-types';
import { ScopeBar } from './scope-bar';

function metrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
    ...over,
  };
}

function makeRun(runId: string, threadId: string, outcome: RunOutcome, m: RunMetrics = metrics()): Run {
  return {
    runId,
    threadId,
    connId: 'c_1',
    startedAtMs: 0,
    outcome,
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: m,
    issues: [],
    recordSeqs: [],
  };
}

const RUNS: Run[] = [
  makeRun('r_1', 't_1', 'finished'),
  makeRun('r_2', 't_1', 'aborted', metrics({ durationMs: 1840, ttftMs: 240 })),
  makeRun('r_3', 't_2', 'error'),
  makeRun('r_4', 't_2', 'running'),
];

describe('ScopeBar', () => {
  it('names the scoped run, its position, thread and outcome', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<ScopeBar store={store} />);

    const bar = screen.getByRole('status');
    expect(within(bar).getByText('run r_2 of 4 · thread t_1 · aborted')).toBeTruthy();
  });

  it('shows duration and TTFT for the scoped run', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('duration 1.84s · TTFT 240ms')).toBeTruthy();
  });

  it('renders an em dash for metrics a still-running run has not produced', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_4' });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('duration — · TTFT —')).toBeTruthy();
  });

  it('reports the all-runs scope with a run count and no per-run metrics', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('all runs · 4 runs')).toBeTruthy();
    expect(screen.queryByText(/TTFT/)).toBeNull();
  });

  it('says so plainly when nothing has been captured', () => {
    const store = createPanelStore(initialPanelState());
    render(<ScopeBar store={store} />);

    expect(screen.getByText('no runs captured')).toBeTruthy();
  });

  it('does not silently fall back to all-runs when the scoped id is unknown', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_9' });
    render(<ScopeBar store={store} />);

    expect(screen.getByText('run r_9 · not in this capture')).toBeTruthy();
  });

  it('follows the store when the scope changes', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<ScopeBar store={store} />);

    act(() => {
      store.update((s) => selectScope(s, 'r_3'));
    });

    expect(screen.getByText('run r_3 of 4 · thread t_2 · error')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/shell/scope-bar.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./scope-bar" from "src/panel/shell/scope-bar.test.tsx". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `src/panel/model/use-panel-state.ts`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import type { PanelState } from './panel-types';
import type { PanelStore } from './store';

/**
 * Subscribe a component to the panel store.
 *
 * Every component takes `store` as a prop rather than reading a context, so each one needs its own
 * subscription. This is that subscription, in one place: the alternative is a copy of the same
 * `useState` + `useEffect` pair in every component, drifting apart.
 *
 * The effect re-reads before subscribing because a `set` that lands between render and effect would
 * otherwise be missed — the listener is not attached yet, and nothing would ever re-notify.
 */
export function usePanelState(store: PanelStore): PanelState {
  const [state, setState] = useState<PanelState>(() => store.get());
  useEffect(() => {
    setState(store.get());
    return store.subscribe(() => setState(store.get()));
  }, [store]);
  return state;
}
```

Create `src/panel/shell/scope-bar.tsx`:

```tsx
import type { JSX } from 'preact';
import { formatDuration } from '../common/format';
import { scopedRun } from '../model/selectors';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface ScopeBarProps {
  store: PanelStore;
}

/**
 * P3: the answer to "what am I looking at", visible from every tab.
 *
 * Display only. The run selector sits beside it in the same band; keeping the two apart means the
 * summary never has to know whether a dropdown is open.
 *
 * An unresolvable scope reads as `not in this capture` rather than falling back to the all-runs
 * summary. Silently widening the scope is exactly the class of lie P3 exists to prevent.
 */
export function ScopeBar({ store }: ScopeBarProps): JSX.Element {
  const state = usePanelState(store);
  const run = scopedRun(state);
  const total = state.runs.length;

  let summary: string;
  if (state.scope === null) {
    summary = total === 0 ? 'no runs captured' : `all runs · ${total} ${total === 1 ? 'run' : 'runs'}`;
  } else if (run === undefined) {
    summary = `run ${state.scope} · not in this capture`;
  } else {
    summary = `run ${run.runId} of ${total} · thread ${run.threadId} · ${run.outcome}`;
  }

  return (
    <div class="agui-scope" role="status" aria-label="Current scope">
      <span class="agui-scope__summary">{summary}</span>
      {run !== undefined && (
        <span class="agui-scope__metrics">
          {`duration ${formatDuration(run.metrics.durationMs)} · TTFT ${formatDuration(run.metrics.ttftMs)}`}
        </span>
      )}
    </div>
  );
}
```

Append to `src/panel/panel.css`:

```css
/* ── Shell ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Tokens for the three shell bands. Light is the base and dark is the override, matching the
 * existing block above: every colour is stated in both schemes, never inherited.
 *
 * Danger and warning exist only for the issue badge and the per-run issue counts (P2 reserves the
 * danger colour for issues — nothing else in the chrome may use it).
 */

:root {
  --agui-surface: #f8f9fa;
  --agui-surface-raised: #ffffff;
  --agui-hover: rgba(0, 0, 0, 0.06);
  --agui-accent: #1a73e8;
  --agui-danger: #c5221f;
  --agui-danger-bg: #fce8e6;
  --agui-danger-border: #f2b8b5;
  --agui-warning: #8a5700;
  --agui-warning-bg: #fef7e0;
  --agui-warning-border: #f9d67a;
}

@media (prefers-color-scheme: dark) {
  :root {
    --agui-surface: #292a2d;
    --agui-surface-raised: #35363a;
    --agui-hover: rgba(255, 255, 255, 0.08);
    --agui-accent: #8ab4f8;
    --agui-danger: #f28b82;
    --agui-danger-bg: #3b2422;
    --agui-danger-border: #5c3330;
    --agui-warning: #fdd663;
    --agui-warning-bg: #3a2f16;
    --agui-warning-border: #5c4a1e;
  }
}

.agui-shell {
  display: flex;
  flex-direction: column;
  background: var(--agui-bg);
  border-bottom: 1px solid var(--agui-border);
}

/* One horizontal band of the shell. `App` puts the scope bar and run selector in the first one. */
.agui-shell__band {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  padding: 2px 8px;
}

.agui-shell button:focus-visible,
.agui-shell input:focus-visible {
  outline: 2px solid var(--agui-accent);
  outline-offset: 1px;
}

.agui-scope {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.agui-scope__summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agui-scope__metrics {
  margin-left: auto;
  color: var(--agui-fg-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/shell/scope-bar.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

Message: `feat(panel): scope bar naming the current run scope (P3)`

---

#### Cycle 2 — run selector (P10)

- [ ] **Step 6: Write the failing test**

Create `src/panel/shell/run-selector.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import type { Issue, Run, RunMetrics, RunOutcome } from '../../core/model/types';
import { makeIssue } from '../../core/model/types';
import { initialPanelState } from '../model/panel-types';
import { createPanelStore } from '../model/store';
import { RunSelector } from './run-selector';

function metrics(): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
  };
}

function makeRun(runId: string, threadId: string, outcome: RunOutcome, issues: Issue[] = []): Run {
  return {
    runId,
    threadId,
    connId: 'c_1',
    startedAtMs: 0,
    outcome,
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: metrics(),
    issues,
    recordSeqs: [],
  };
}

const RUNS: Run[] = [
  makeRun('r_1', 't_1', 'finished'),
  makeRun('r_2', 't_1', 'aborted', [
    makeIssue('event-after-terminal', 'late event', 7, { runId: 'r_2' }),
    makeIssue('unclosed-message', 'message left open', 9, { runId: 'r_2' }),
  ]),
  makeRun('r_3', 't_2', 'error'),
];

function openSelector(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Run:/ }));
}

describe('RunSelector', () => {
  it('names the current scope on the trigger', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);

    expect(screen.getByRole('button', { name: 'Run: r_2' })).toBeTruthy();
  });

  it('offers an all-runs entry alongside the runs', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    expect(screen.getByRole('option', { name: /All runs/ })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('labels each run with thread, outcome and issue count', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    const option = screen.getByRole('option', { name: /r_2/ });
    expect(option.textContent).toContain('thread t_1 · aborted');
    expect(option.textContent).toContain('2 issues');
    expect(screen.getByRole('option', { name: /r_1/ }).textContent).toContain('no issues');
  });

  it('marks the scoped run as the selected option', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    expect(screen.getByRole('option', { name: /r_2/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: /r_1/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('option', { name: /All runs/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('sets the scope and closes when a run is chosen', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /r_3/ }));

    expect(store.get().scope).toBe('r_3');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run: r_3' })).toBeTruthy();
  });

  it('returns to all runs through the all-runs entry', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_3' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /All runs/ }));

    expect(store.get().scope).toBeNull();
    expect(screen.getByRole('button', { name: 'Run: all runs' })).toBeTruthy();
  });

  it('filters the list by the search query', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search runs' }), {
      target: { value: 't_2' },
    });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('r_3');
  });

  it('says so when nothing matches instead of showing an empty list', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search runs' }), {
      target: { value: 'nope' },
    });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('No run matches "nope"')).toBeTruthy();
  });

  it('virtualizes: 500 runs render a window, not 500 rows', () => {
    const many = Array.from({ length: 500 }, (_, i) => makeRun(`r_${i + 1}`, `t_${i % 7}`, 'finished'));
    const store = createPanelStore({ ...initialPanelState(), runs: many, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    const rendered = screen.getAllByRole('option').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(30);
  });

  it('finds a run deep in the list by search', () => {
    const many = Array.from({ length: 500 }, (_, i) => makeRun(`r_${i + 1}`, `t_${i % 7}`, 'finished'));
    const store = createPanelStore({ ...initialPanelState(), runs: many, scope: null });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search runs' }), {
      target: { value: 'r_487' },
    });
    fireEvent.click(screen.getByRole('option', { name: /r_487/ }));

    expect(store.get().scope).toBe('r_487');
  });

  it('closes on Escape without changing the scope', () => {
    const store = createPanelStore({ ...initialPanelState(), runs: RUNS, scope: 'r_2' });
    render(<RunSelector store={store} />);
    openSelector();

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search runs' }), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(store.get().scope).toBe('r_2');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/panel/shell/run-selector.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./run-selector" from "src/panel/shell/run-selector.test.tsx". Does the file exist?`

- [ ] **Step 8: Write the implementation**

Create `src/panel/shell/run-selector.tsx`:

```tsx
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Run } from '../../core/model/types';
import { VirtualList } from '../common/virtual-list';
import type { RunScope } from '../model/panel-types';
import { scopedRun } from '../model/selectors';
import type { PanelStore } from '../model/store';
import { selectScope } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface RunSelectorProps {
  store: PanelStore;
}

/** The "all runs" entry is an option like any other, so one list handles both scopes. */
type RunOption = { kind: 'all' } | { kind: 'run'; run: Run };

const ROW_HEIGHT_PX = 32;
const LIST_HEIGHT_PX = 256;

function issueText(count: number): string {
  if (count === 0) return 'no issues';
  return count === 1 ? '1 issue' : `${count} issues`;
}

function issueTone(run: Run): 'error' | 'warning' | 'none' {
  if (run.issues.some((i) => i.severity === 'error')) return 'error';
  if (run.issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'none';
}

function matches(run: Run, query: string): boolean {
  const haystack = [run.runId, run.threadId, run.outcome, run.agentId ?? ''].join(' ').toLowerCase();
  return haystack.includes(query);
}

/**
 * P10: searchable and virtualized, because a long session has many runs and a plain dropdown
 * assumes four.
 *
 * Each row carries thread, outcome and issue count so the interesting run is findable here rather
 * than by opening the Runs tab first.
 */
export function RunSelector({ store }: RunSelectorProps): JSX.Element {
  const state = usePanelState(store);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = scopedRun(state);

  const options = useMemo<RunOption[]>(() => {
    const q = query.trim().toLowerCase();
    const runs = q === '' ? state.runs : state.runs.filter((r) => matches(r, q));
    const head: RunOption[] = q === '' || 'all runs'.includes(q) ? [{ kind: 'all' }] : [];
    return [...head, ...runs.map((run): RunOption => ({ kind: 'run', run }))];
  }, [state.runs, query]);

  function choose(scope: RunScope): void {
    store.update((s) => selectScope(s, scope));
    setQuery('');
    setOpen(false);
  }

  const triggerText =
    state.scope === null
      ? 'Run: all runs'
      : current === undefined
        ? `Run: ${state.scope} (unknown)`
        : `Run: ${current.runId}`;

  return (
    <div
      class="agui-run-selector"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        class="agui-run-selector__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {triggerText}
        <span aria-hidden="true" class="agui-run-selector__caret">
          ▾
        </span>
      </button>

      {open && (
        <div class="agui-run-selector__popup">
          <input
            type="search"
            class="agui-run-selector__search"
            aria-label="Search runs"
            placeholder="Search runs"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          {options.length === 0 ? (
            <p class="agui-run-selector__empty">{`No run matches "${query}"`}</p>
          ) : (
            <div role="listbox" aria-label="Runs" class="agui-run-selector__list">
              <VirtualList<RunOption>
                items={options}
                rowHeight={ROW_HEIGHT_PX}
                height={LIST_HEIGHT_PX}
                overscan={4}
                renderRow={(option) =>
                  option.kind === 'all' ? (
                    <button
                      key="all"
                      type="button"
                      role="option"
                      aria-selected={state.scope === null}
                      class="agui-run-option"
                      onClick={() => choose(null)}
                    >
                      <span class="agui-run-option__id">All runs</span>
                      <span class="agui-run-option__meta">
                        {`${state.runs.length} ${state.runs.length === 1 ? 'run' : 'runs'}`}
                      </span>
                    </button>
                  ) : (
                    <button
                      key={option.run.runId}
                      type="button"
                      role="option"
                      aria-selected={state.scope === option.run.runId}
                      class="agui-run-option"
                      onClick={() => choose(option.run.runId)}
                    >
                      <span class="agui-run-option__id">{option.run.runId}</span>
                      <span class="agui-run-option__meta">
                        {`thread ${option.run.threadId} · ${option.run.outcome}`}
                      </span>
                      <span class="agui-run-option__issues" data-tone={issueTone(option.run)}>
                        {issueText(option.run.issues.length)}
                      </span>
                    </button>
                  )
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Append to `src/panel/panel.css`:

```css
/* ── Run selector (P10) ─────────────────────────────────────────────────────────────────────── */

.agui-run-selector {
  position: relative;
}

.agui-run-selector__trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: inherit;
  color: var(--agui-fg);
  background: var(--agui-surface);
  border: 1px solid var(--agui-border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agui-run-selector__trigger:hover {
  background: var(--agui-hover);
}

.agui-run-selector__caret {
  color: var(--agui-fg-muted);
}

.agui-run-selector__popup {
  position: absolute;
  z-index: 10;
  top: calc(100% + 2px);
  left: 0;
  width: 320px;
  max-width: 90vw;
  padding: 6px;
  background: var(--agui-surface-raised);
  border: 1px solid var(--agui-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgb(0 0 0 / 25%);
}

.agui-run-selector__search {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  color: var(--agui-fg);
  background: var(--agui-bg);
  border: 1px solid var(--agui-border);
  border-radius: 4px;
  padding: 3px 6px;
  margin-bottom: 4px;
}

.agui-run-selector__empty {
  margin: 8px 6px;
  color: var(--agui-fg-muted);
}

.agui-run-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 0 6px;
  font: inherit;
  text-align: left;
  color: var(--agui-fg);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

.agui-run-option:hover {
  background: var(--agui-hover);
}

/* Selection is marked by a rule as well as a tint, so it survives a colour-blind reading. */
.agui-run-option[aria-selected='true'] {
  background: var(--agui-hover);
  box-shadow: inset 2px 0 0 var(--agui-accent);
}

.agui-run-option__id {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.agui-run-option__meta {
  color: var(--agui-fg-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.agui-run-option__issues {
  margin-left: auto;
  white-space: nowrap;
  color: var(--agui-fg-muted);
}

.agui-run-option__issues[data-tone='error'] {
  color: var(--agui-danger);
}

.agui-run-option__issues[data-tone='warning'] {
  color: var(--agui-warning);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/panel/shell/run-selector.test.tsx`
Expected: PASS, 11 tests.

- [ ] **Step 10: Commit**

Message: `feat(panel): searchable virtualized run selector (P10)`

---

#### Cycle 3 — tab strip

- [ ] **Step 11: Write the failing test**

Create `src/panel/shell/tab-strip.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { initialPanelState } from '../model/panel-types';
import { createPanelStore, selectTab } from '../model/store';
import { TabStrip } from './tab-strip';

describe('TabStrip', () => {
  it('renders the five tabs in order as real tabs', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tablist', { name: 'Panel sections' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Timeline',
      'Runs',
      'State',
      'Messages',
      'Session',
    ]);
  });

  it('marks only the current tab as selected', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: 'Timeline', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Session' }).getAttribute('aria-selected')).toBe('false');
  });

  it('selects a tab through the store', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));

    expect(store.get().tab).toBe('session');
    expect(screen.getByRole('tab', { name: 'Session', selected: true })).toBeTruthy();
  });

  it('keeps the deferred tabs selectable', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    for (const [label, id] of [
      ['Runs', 'runs'],
      ['State', 'state'],
      ['Messages', 'messages'],
    ] as const) {
      const tab = screen.getByRole('tab', { name: label });
      expect(tab.hasAttribute('disabled')).toBe(false);
      fireEvent.click(tab);
      expect(store.get().tab).toBe(id);
    }
  });

  it('points each tab at the panel it controls', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: 'State' }).getAttribute('aria-controls')).toBe(
      'agui-tabpanel-state',
    );
  });

  it('roves the tab stop so the strip is a single stop in the tab order', () => {
    const store = createPanelStore({ ...initialPanelState(), tab: 'messages' });
    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: 'Messages' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('tabindex')).toBe('-1');
  });

  it('moves between tabs with the arrow keys, wrapping at the ends', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);
    const strip = screen.getByRole('tablist');

    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(store.get().tab).toBe('runs');

    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(store.get().tab).toBe('timeline');

    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(store.get().tab).toBe('session');

    fireEvent.keyDown(strip, { key: 'Home' });
    expect(store.get().tab).toBe('timeline');

    fireEvent.keyDown(strip, { key: 'End' });
    expect(store.get().tab).toBe('session');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Session' }));
  });

  it('follows a tab change made elsewhere in the panel', () => {
    const store = createPanelStore(initialPanelState());
    render(<TabStrip store={store} />);

    act(() => {
      store.update((s) => selectTab(s, 'runs'));
    });

    expect(screen.getByRole('tab', { name: 'Runs', selected: true })).toBeTruthy();
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/panel/shell/tab-strip.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./tab-strip" from "src/panel/shell/tab-strip.test.tsx". Does the file exist?`

- [ ] **Step 13: Write the implementation**

Create `src/panel/shell/tab-strip.tsx`:

```tsx
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import type { TabId } from '../model/panel-types';
import type { PanelStore } from '../model/store';
import { selectTab } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface TabStripProps {
  store: PanelStore;
}

/**
 * The five tabs from requirements §9. Runs, State and Messages are deferred to a later phase but
 * stay selectable — the panel renders a placeholder for them rather than hiding the tab, so the
 * shape of the finished tool is visible from the first build.
 *
 * Exported because `App` renders one tab panel per entry and needs the same order and ids.
 */
export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'runs', label: 'Runs' },
  { id: 'state', label: 'State' },
  { id: 'messages', label: 'Messages' },
  { id: 'session', label: 'Session' },
];

/** The id of the panel a tab controls. `App` must put this on the rendered tab panel. */
export function tabPanelId(tab: TabId): string {
  return `agui-tabpanel-${tab}`;
}

export function TabStrip({ store }: TabStripProps): JSX.Element {
  const state = usePanelState(store);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function select(tab: TabId): void {
    store.update((s) => selectTab(s, tab));
  }

  // Arrow-key movement is what makes `tablist` a single tab stop rather than five.
  function onKeyDown(e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void {
    const current = TABS.findIndex((t) => t.id === state.tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    const tab = TABS[next];
    if (tab === undefined) return;
    e.preventDefault();
    select(tab.id);
    buttons.current[next]?.focus();
  }

  return (
    <div class="agui-tabs" role="tablist" aria-label="Panel sections" onKeyDown={onKeyDown}>
      {TABS.map((tab, i) => {
        const selected = state.tab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`agui-tab-${tab.id}`}
            class="agui-tabs__tab"
            aria-selected={selected}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            onClick={() => select(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

Append to `src/panel/panel.css`:

```css
/* ── Tab strip ──────────────────────────────────────────────────────────────────────────────── */

.agui-tabs {
  display: flex;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--agui-border);
}

.agui-tabs__tab {
  appearance: none;
  font: inherit;
  color: var(--agui-fg-muted);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 6px 10px;
  cursor: pointer;
}

.agui-tabs__tab:hover {
  color: var(--agui-fg);
  background: var(--agui-hover);
}

/* The underline carries the selection on its own; the accent colour only reinforces it. */
.agui-tabs__tab[aria-selected='true'] {
  color: var(--agui-accent);
  border-bottom-color: var(--agui-accent);
}

.agui-tabs__tab:focus-visible {
  outline: 2px solid var(--agui-accent);
  outline-offset: -2px;
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/panel/shell/tab-strip.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 15: Commit**

Message: `feat(panel): tab strip for the five panel sections`

---

#### Cycle 4 — toolbar and the issue badge (P2)

- [ ] **Step 16: Write the failing test**

Create `src/panel/shell/toolbar.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import type { CaptureRecord, Issue } from '../../core/model/types';
import { makeIssue } from '../../core/model/types';
import { initialPanelState } from '../model/panel-types';
import type { PanelState } from '../model/panel-types';
import { createPanelStore, toggleIssuesOnly } from '../model/store';
import { Toolbar } from './toolbar';

function record(seq: number, issues: Issue[] = []): CaptureRecord {
  return {
    kind: 'event',
    seq,
    tMs: seq,
    connId: 'c_1',
    raw: { type: 'RUN_STARTED' },
    event: { type: 'RUN_STARTED' },
    issues,
  };
}

function stateWith(over: Partial<PanelState>): PanelState {
  return { ...initialPanelState(), ...over };
}

const ERROR_ISSUE = makeIssue('event-after-terminal', 'late event', 7, { runId: 'r_1' });
const WARNING_ISSUE = makeIssue('unclosed-message', 'message left open', 8, { runId: 'r_1' });
const INFO_ISSUE = makeIssue('keepalive-gap', 'gap of 31s', 9, { runId: 'r_2' });

function badge(): HTMLElement {
  return screen.getByRole('button', { name: /events with issues/ });
}

describe('Toolbar issue badge', () => {
  it('shows the total for the current scope, not the whole capture', () => {
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE, INFO_ISSUE], scope: 'r_1' }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().textContent).toContain('2 issues');
    expect(badge().getAttribute('aria-label')).toContain('2 issues: 1 error, 1 warning, 0 info');
  });

  it('counts every issue when the scope is all runs', () => {
    const store = createPanelStore(
      stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE, INFO_ISSUE], scope: null }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().textContent).toContain('3 issues');
  });

  it('uses the danger tone only when an error is present', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE, WARNING_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('error');
  });

  it('uses the warning tone when only warnings are present', () => {
    const store = createPanelStore(stateWith({ issues: [WARNING_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('warning');
  });

  it('stays neutral for an info-only count', () => {
    const store = createPanelStore(stateWith({ issues: [INFO_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('none');
    expect(badge().textContent).toContain('1 issue');
  });

  it('is neutral and reads as zero when there are no issues', () => {
    const store = createPanelStore(stateWith({ records: [record(1)] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('data-tone')).toBe('none');
    expect(badge().textContent).toContain('0 issues');
    expect(badge().getAttribute('aria-label')).toContain('0 issues');
  });

  it('toggles filter.issuesOnly when clicked', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    fireEvent.click(badge());
    expect(store.get().filter.issuesOnly).toBe(true);

    fireEvent.click(badge());
    expect(store.get().filter.issuesOnly).toBe(false);
  });

  it('is a pressed button that says it is filtering, so a filtered list cannot look clean', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(badge().getAttribute('aria-pressed')).toBe('false');
    expect(badge().textContent).not.toContain('filtered');

    fireEvent.click(badge());

    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge().textContent).toContain('filtered');
    expect(badge().getAttribute('aria-label')).toContain('filtered to events with issues');
  });

  it('reflects the filter being toggled from elsewhere', () => {
    const store = createPanelStore(stateWith({ issues: [ERROR_ISSUE] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    act(() => {
      store.update(toggleIssuesOnly);
    });

    expect(badge().getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Toolbar controls', () => {
  it('offers record as an inert control until capture lands', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Record' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('offers preserve-on-navigate as an inert control until capture lands', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Preserve log on navigate' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('disables clear when there is nothing to clear', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears the loaded capture but keeps the capture status', () => {
    const store = createPanelStore(
      stateWith({
        source: { kind: 'imported', filename: 'happy-run.agui.jsonl', importedAtMs: 5 },
        capture: { kind: 'off', origin: 'https://example.test', aguiDetected: true },
        records: [record(1)],
        issues: [ERROR_ISSUE],
        scope: 'r_1',
        selectedSeq: 1,
      }),
    );
    render(<Toolbar store={store} onImport={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    const after = store.get();
    expect(after.records).toEqual([]);
    expect(after.issues).toEqual([]);
    expect(after.runs).toEqual([]);
    expect(after.scope).toBeNull();
    expect(after.selectedSeq).toBeNull();
    expect(after.source).toEqual({ kind: 'empty' });
    expect(after.capture).toEqual({ kind: 'off', origin: 'https://example.test', aguiDetected: true });
  });

  it('toggles expand-chunks through the store', () => {
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Expand chunks' });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);

    expect(store.get().expandChunks).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('drives the text filter and shows the text already applied', () => {
    const store = createPanelStore(stateWith({ filter: { text: 'tool', issuesOnly: false } }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    const input = screen.getByRole('searchbox', { name: 'Filter events' }) as HTMLInputElement;
    expect(input.value).toBe('tool');

    fireEvent.input(input, { target: { value: 'RUN_ERROR' } });

    expect(store.get().filter.text).toBe('RUN_ERROR');
  });

  it('asks the host to import', () => {
    const onImport = vi.fn();
    const store = createPanelStore(initialPanelState());
    render(<Toolbar store={store} onImport={onImport} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('surfaces evicted events instead of dropping them silently', () => {
    const store = createPanelStore(stateWith({ droppedBefore: 12, records: [record(13)] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(screen.getByText('12 dropped')).toBeTruthy();
  });

  it('shows no dropped count when nothing was evicted', () => {
    const store = createPanelStore(stateWith({ records: [record(1)] }));
    render(<Toolbar store={store} onImport={() => undefined} />);

    expect(screen.queryByText(/dropped/)).toBeNull();
  });
});
```

- [ ] **Step 17: Run test to verify it fails**

Run: `pnpm vitest run src/panel/shell/toolbar.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./toolbar" from "src/panel/shell/toolbar.test.tsx". Does the file exist?`

- [ ] **Step 18: Write the implementation**

Create `src/panel/shell/toolbar.tsx`:

```tsx
import type { JSX } from 'preact';
import { issueCounts } from '../model/selectors';
import { initialPanelState } from '../model/panel-types';
import type { PanelStore } from '../model/store';
import { setTextFilter, toggleExpandChunks, toggleIssuesOnly } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface ToolbarProps {
  store: PanelStore;
  onImport: () => void;
}

export type IssueTone = 'error' | 'warning' | 'none';

interface Counts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/**
 * Danger is reserved for errors. Warnings get the warning colour; an info-only or empty count stays
 * neutral, so the one red thing in the panel always means a protocol error.
 */
export function issueTone(counts: Counts): IssueTone {
  if (counts.error > 0) return 'error';
  if (counts.warning > 0) return 'warning';
  return 'none';
}

export function issueBadgeText(total: number): string {
  return total === 1 ? '1 issue' : `${total} issues`;
}

/**
 * The visible text is a prefix of the accessible name, and the name states the filter state in
 * words — a filtered list must never be mistakable for a clean one, for a screen reader either.
 */
export function issueBadgeLabel(counts: Counts, issuesOnly: boolean): string {
  const head =
    counts.total === 0
      ? '0 issues'
      : `${issueBadgeText(counts.total)}: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`;
  const action = issuesOnly
    ? 'filtered to events with issues; activate to show all events'
    : 'activate to show only events with issues';
  return `${head}. Currently ${action}`;
}

/**
 * P2: with no Issues tab, this badge is where protocol problems stay visible. It is the scoped
 * count, the severity signal, and the issues-only filter in one control.
 *
 * Record and preserve-on-navigate are rendered disabled: phase 1 has no capture layer, and
 * `ToolbarProps` carries no callback for either. Showing them inert is more honest than hiding
 * them and more honest than wiring a control that does nothing.
 */
export function Toolbar({ store, onImport }: ToolbarProps): JSX.Element {
  const state = usePanelState(store);
  const counts = issueCounts(state);
  const tone = issueTone(counts);
  const recording = state.capture.kind === 'on';
  const hasData =
    state.source.kind !== 'empty' || state.records.length > 0 || state.runs.length > 0;

  return (
    <div class="agui-toolbar" role="toolbar" aria-label="Capture controls">
      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={recording}
        disabled
        title="Live capture is not available yet — import a .agui.jsonl to inspect a stream"
      >
        {recording ? 'Pause' : 'Record'}
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        disabled={!hasData}
        onClick={() => {
          // No `clearCapture` action exists; a reset to the initial state is exactly what clear
          // means. Capture status survives because it describes the inspected page, not the data.
          store.update((s) => ({ ...initialPanelState(), capture: s.capture }));
        }}
      >
        Clear
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={false}
        disabled
        title="Takes effect once live capture lands"
      >
        Preserve log on navigate
      </button>

      <button
        type="button"
        class="agui-toolbar__button"
        aria-pressed={state.expandChunks}
        onClick={() => store.update(toggleExpandChunks)}
      >
        Expand chunks
      </button>

      <input
        type="search"
        class="agui-toolbar__filter"
        aria-label="Filter events"
        placeholder="Filter"
        value={state.filter.text}
        onInput={(e) => {
          const { value } = e.currentTarget;
          store.update((s) => setTextFilter(s, value));
        }}
      />

      <button type="button" class="agui-toolbar__button" onClick={onImport}>
        Import
      </button>

      {state.droppedBefore > 0 && (
        <span
          class="agui-toolbar__dropped"
          title="Older events were evicted from the buffer before the first one shown"
        >
          {`${state.droppedBefore} dropped`}
        </span>
      )}

      <button
        type="button"
        class="agui-issue-badge"
        data-tone={tone}
        aria-pressed={state.filter.issuesOnly}
        aria-label={issueBadgeLabel(counts, state.filter.issuesOnly)}
        onClick={() => store.update(toggleIssuesOnly)}
      >
        <span aria-hidden="true" class="agui-issue-badge__dot" />
        <span class="agui-issue-badge__count">{issueBadgeText(counts.total)}</span>
        {state.filter.issuesOnly && <span class="agui-issue-badge__flag">filtered</span>}
      </button>
    </div>
  );
}
```

Append to `src/panel/panel.css`:

```css
/* ── Toolbar and issue badge (P2) ───────────────────────────────────────────────────────────── */

.agui-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 4px 8px;
}

.agui-toolbar__button {
  appearance: none;
  font: inherit;
  color: var(--agui-fg);
  background: var(--agui-surface);
  border: 1px solid var(--agui-border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
}

.agui-toolbar__button:hover:not(:disabled) {
  background: var(--agui-hover);
}

.agui-toolbar__button:disabled {
  opacity: 0.5;
  cursor: default;
}

.agui-toolbar__button[aria-pressed='true']:not(:disabled) {
  color: var(--agui-accent);
  border-color: var(--agui-accent);
  background: var(--agui-hover);
}

.agui-toolbar__filter {
  flex: 1 1 120px;
  min-width: 80px;
  font: inherit;
  color: var(--agui-fg);
  background: var(--agui-surface-raised);
  border: 1px solid var(--agui-border);
  border-radius: 4px;
  padding: 2px 6px;
}

.agui-toolbar__dropped {
  color: var(--agui-fg-muted);
  font-variant-numeric: tabular-nums;
}

/* The badge is pushed to the trailing edge so it holds the same spot at every width. */
.agui-issue-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--agui-fg-muted);
  background: var(--agui-surface);
  border: 1px solid var(--agui-border);
  border-radius: 10px;
  padding: 2px 8px;
  cursor: pointer;
}

.agui-issue-badge__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentcolor;
}

.agui-issue-badge[data-tone='error'] {
  color: var(--agui-danger);
  background: var(--agui-danger-bg);
  border-color: var(--agui-danger-border);
}

.agui-issue-badge[data-tone='warning'] {
  color: var(--agui-warning);
  background: var(--agui-warning-bg);
  border-color: var(--agui-warning-border);
}

/* Pressed state is a ring plus the visible `filtered` tag, never colour alone. */
.agui-issue-badge[aria-pressed='true'] {
  font-weight: 600;
  box-shadow: inset 0 0 0 1px currentcolor;
}

.agui-issue-badge__flag {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
```

- [ ] **Step 19: Run test to verify it passes**

Run: `pnpm vitest run src/panel/shell/toolbar.test.tsx`
Expected: PASS, 18 tests.

- [ ] **Step 20: Commit**

Message: `feat(panel): toolbar with the issue badge as the issues-only filter (P2)`

---

**Verification of this task as written:** all four components and their tests were built against
faithful stubs of `PanelStore`, the actions, the selectors, `VirtualList`/`windowRange` and
`format.ts`, and run under Vitest 4 + jsdom + `@testing-library/preact`: **44 tests passed
(7 + 11 + 8 + 18)**, and `tsc --noEmit` was clean under `strict` + `noUncheckedIndexedAccess` +
`verbatimModuleSyntax` with no `any`.

Two notes for the composing task (App):

- `TabStrip` sets `aria-controls={tabPanelId(tab)}`; the rendered tab panel must carry that id and
  `role="tabpanel"` with `aria-labelledby="agui-tab-<id>"`.
- `toggleExpandChunks` only flips the flag. The toolbar cannot rebuild — it has no access to the
  raw lines — so App must observe `expandChunks` and re-run `loadJsonl` with the new option.

---

## Section E — the Timeline tab (Tasks 7 and 8)

Paths are relative to `packages/devtools/`. Tasks 1–6 have landed: the store, the selectors,
`VirtualList`, `common/format.ts` and `common/layout.ts` all exist, and `vitest.config.ts` already
declares the `core` (node) and `panel` (jsdom) projects with `src/panel/test-setup.ts`.

Two conventions the tests in this section depend on, both verified before being written down:

- **Fixtures load with `?raw`, not `readFileSync`.** Under the jsdom project `import.meta.url` is
  not a filesystem URL, so `readFileSync(new URL('../../../test/fixtures/x', import.meta.url))`
  resolves to `/src/test/fixtures/x` and throws `ENOENT`. Vite's `?raw` import works in both
  projects. It needs `/// <reference types="vite/client" />` at the top of the test file; `vite` is
  already a devDependency of the package, so nothing new is installed.
- **Compound rows and bars carry an explicit `aria-label`.** An accessible name assembled from
  adjacent inline `<span>`s comes out with no separators (`1RUN_STARTEDr_bad`), which makes every
  `getByRole(..., { name })` query unusable. Each row and bar states its own name.

---

### Task 7: Timeline event list and detail pane

**Files:**
- Create: `src/panel/model/use-panel-state.ts`
- Create: `src/panel/tabs/timeline/event-list.tsx`
- Test: `src/panel/tabs/timeline/event-list.test.tsx`
- Create: `src/panel/tabs/timeline/event-detail.tsx`
- Test: `src/panel/tabs/timeline/event-detail.test.tsx`
- Edit: `src/panel/panel.css`

#### Cycle 1 — `EventList`

- [ ] **Step 1: Write the failing test**

`src/panel/tabs/timeline/event-list.test.tsx`

```tsx
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import { makeIssue, type CaptureRecord } from '../../../core/model/types';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { EventList } from './event-list';

/** The malformed fixture produces exactly three issues, at seqs 5, 9 and 10. */
function malformedState(): PanelState {
  const loaded = loadJsonl(malformedJsonl);
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    source: { kind: 'imported', filename: 'malformed.agui.jsonl', importedAtMs: 0 },
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function severityOf(name: RegExp): string | null {
  return screen.getByRole('button', { name }).getAttribute('data-severity');
}

describe('EventList', () => {
  it('renders one row per record, labelled by seq and not by array index', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.textContent).toContain('RUN_STARTED');
    expect(rows[0]?.textContent?.startsWith('1')).toBe(true);
    expect(rows[9]?.textContent?.startsWith('10')).toBe(true);
  });

  it('keeps the gutter on seq when a filter drops earlier rows', () => {
    const state = malformedState();
    const store = createPanelStore({ ...state, filter: { text: '', issuesOnly: true } });
    render(<EventList store={store} />);

    const rows = screen.getAllByRole('button');
    expect(rows.map((row) => row.textContent?.match(/^\d+/)?.[0])).toEqual(['5', '9', '10']);
  });

  it('tints rows that carry an issue with the issue severity and names the code', () => {
    const store = createPanelStore(malformedState());
    render(<EventList store={store} />);

    expect(severityOf(/empty-text-delta/)).toBe('error');
    expect(severityOf(/state-patch-failed/)).toBe('error');
    expect(severityOf(/run-never-terminated/)).toBe('error');
    expect(severityOf(/^seq 1 RUN_STARTED/)).toBeNull();
  });

  it('shows the worst severity when a seq carries more than one issue', () => {
    const state = malformedState();
    const store = createPanelStore({
      ...state,
      issues: [makeIssue('keepalive-gap', 'gap', 3), makeIssue('unknown-event-type', 'unknown', 3)],
    });
    render(<EventList store={store} />);

    // warning (unknown-event-type) outranks info (keepalive-gap).
    expect(severityOf(/keepalive-gap/)).toBe('warning');
  });

  it('selects the clicked row by seq and marks it pressed', () => {
    const store = createPanelStore(malformedState());
    const { rerender } = render(<EventList store={store} />);

    fireEvent.click(screen.getByRole('button', { name: /state-patch-failed/ }));
    expect(store.get().selectedSeq).toBe(9);

    rerender(<EventList store={store} />);
    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent?.startsWith('9')).toBe(true);
  });

  it('says so plainly when the filter matches nothing', () => {
    const store = createPanelStore({
      ...malformedState(),
      filter: { text: 'no-such-event', issuesOnly: false },
    });
    render(<EventList store={store} />);

    expect(screen.getByText('No events match the current filter.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders a keepalive row and an undecodable row without touching a missing event', () => {
    const records: CaptureRecord[] = [
      {
        kind: 'keepalive',
        seq: 1,
        tMs: 0,
        connId: 'c1',
        raw: ':ping\n\n',
        comment: 'ping',
        issues: [],
      },
      { kind: 'event', seq: 2, tMs: 10, connId: 'c1', raw: '{oops', event: null, issues: [] },
    ];
    const store = createPanelStore({ ...initialPanelState(), records });
    render(<EventList store={store} />);

    expect(screen.getByRole('button', { name: /keepalive/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /unparsed/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/tabs/timeline/event-list.test.tsx`
Expected: FAIL with `Failed to resolve import "./event-list" from "src/panel/tabs/timeline/event-list.test.tsx". Does the file exist?`

- [ ] **Step 3: Write the implementation**

`src/panel/model/use-panel-state.ts`

```ts
import { useEffect, useState } from 'preact/hooks';
import type { PanelState } from './panel-types';
import type { PanelStore } from './store';

/**
 * Subscribe a component to the panel store.
 *
 * The contract passes `store` explicitly to every component rather than using context, so the
 * subscription has to live somewhere shared; without this each tab would re-implement it.
 * `store.get()` is re-read on subscribe because the store may have changed between the initial
 * render and the effect firing.
 */
export function usePanelState(store: PanelStore): PanelState {
  const [state, setState] = useState<PanelState>(() => store.get());
  useEffect(() => {
    setState(store.get());
    return store.subscribe(() => {
      setState(store.get());
    });
  }, [store]);
  return state;
}
```

`src/panel/tabs/timeline/event-list.tsx`

```tsx
import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CaptureRecord, Issue, IssueSeverity } from '../../../core/model/types';
import { VirtualList } from '../../common/virtual-list';
import { summarizeEvent } from '../../common/format';
import { issuesBySeq, visibleRecords } from '../../model/selectors';
import { selectSeq, type PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface EventListProps {
  store: PanelStore;
}

/** Uniform row height, in px. `VirtualList` assumes uniform rows in phase 1. */
const ROW_HEIGHT_PX = 22;

/**
 * Viewport height used until the container has been measured. jsdom reports `clientHeight`
 * as 0 and has no `ResizeObserver`, so without a fallback the list would window down to zero
 * rows and render nothing at all under test.
 */
const FALLBACK_HEIGHT_PX = 480;

/** Worst severity wins the row's tint: an error must not be hidden by a co-located info. */
const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 3, warning: 2, info: 1 };

function worstSeverity(issues: Issue[]): IssueSeverity | undefined {
  let worst: IssueSeverity | undefined;
  for (const issue of issues) {
    if (worst === undefined || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[worst]) {
      worst = issue.severity;
    }
  }
  return worst;
}

/** `CaptureRecord` is a union on `kind`; only the `event` arm has an `event` to read a type off. */
function typeLabel(record: CaptureRecord): string {
  if (record.kind === 'keepalive') return 'keepalive';
  return record.event === null ? 'unparsed' : record.event.type;
}

function useMeasuredHeight(ref: RefObject<HTMLDivElement>): number {
  const [height, setHeight] = useState(FALLBACK_HEIGHT_PX);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      if (el.clientHeight > 0) setHeight(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return height;
}

export function EventList({ store }: EventListProps): JSX.Element {
  const state = usePanelState(store);
  const containerRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(containerRef);

  const records = visibleRecords(state);
  const bySeq = issuesBySeq(state);
  const selectedIndex = records.findIndex((record) => record.seq === state.selectedSeq);

  return (
    <div ref={containerRef} class="agui-event-list" aria-label="Event list" role="group">
      {records.length === 0 ? (
        <p class="agui-event-list__empty">No events match the current filter.</p>
      ) : (
        <VirtualList<CaptureRecord>
          items={records}
          rowHeight={ROW_HEIGHT_PX}
          height={height}
          scrollToIndex={selectedIndex === -1 ? undefined : selectedIndex}
          renderRow={(record) => {
            const issues = bySeq.get(record.seq) ?? [];
            const severity = worstSeverity(issues);
            const summary = summarizeEvent(record);
            // The tint carries no accessible information on its own, so the severity and the
            // codes go into the row's name. An explicit label rather than the concatenated
            // spans: adjacent inline spans produce a name with no separators.
            const label =
              severity === undefined
                ? `seq ${record.seq} ${typeLabel(record)} ${summary}`
                : `seq ${record.seq} ${typeLabel(record)} ${summary} — ${severity}: ${issues
                    .map((issue) => issue.code)
                    .join(', ')}`;
            return (
              // P7: keyed and gutter-labelled by `seq`, never by the array index — filtering
              // reorders visible rows and `Issue.seq` refers to this number.
              <button
                key={record.seq}
                type="button"
                class="agui-event-row"
                style={{ height: `${ROW_HEIGHT_PX}px` }}
                data-severity={severity}
                aria-label={label}
                aria-pressed={record.seq === state.selectedSeq}
                onClick={() => {
                  store.update((prev) => selectSeq(prev, record.seq));
                }}
              >
                <span class="agui-event-row__seq">{record.seq}</span>
                <span class="agui-event-row__type">{typeLabel(record)}</span>
                <span class="agui-event-row__summary">{summary}</span>
              </button>
            );
          }}
        />
      )}
    </div>
  );
}
```

Append to `src/panel/panel.css` — the shared tokens plus the list. Contrast was measured for
every pair below: the weakest is muted text on a tinted row at 4.65:1 (light) and 4.84:1 (dark).

```css
/* ---------------------------------------------------------------------------
 * Timeline tab. Light is the base and dark is the override, matching this
 * file's existing convention: Chrome propagates the DevTools theme to panel
 * documents as `prefers-color-scheme`, so both schemes are stated explicitly.
 * ------------------------------------------------------------------------- */

:root {
  --agui-accent: #1a73e8;
  --agui-row-selected: #d2e3fc;
  --agui-row-hover: rgb(0 0 0 / 6%);
  --agui-track: #f1f3f4;

  --agui-severity-error: #b3261e;
  --agui-severity-error-bg: #fce8e6;
  --agui-severity-warning: #8a5100;
  --agui-severity-warning-bg: #fef7e0;
  --agui-severity-info: #1967d2;
  --agui-severity-info-bg: #e8f0fe;

  --agui-bar-run: #80868b;
  --agui-bar-message: #1a73e8;
  --agui-bar-tool: #188038;
  --agui-bar-step: #8430ce;
}

@media (prefers-color-scheme: dark) {
  :root {
    --agui-accent: #8ab4f8;
    --agui-row-selected: #1f3350;
    --agui-row-hover: rgb(255 255 255 / 8%);
    --agui-track: #2b2c2f;

    --agui-severity-error: #f28b82;
    --agui-severity-error-bg: #3a2321;
    --agui-severity-warning: #fdd663;
    --agui-severity-warning-bg: #38321e;
    --agui-severity-info: #8ab4f8;
    --agui-severity-info-bg: #1f2b3e;

    --agui-bar-run: #9aa0a6;
    --agui-bar-message: #8ab4f8;
    --agui-bar-tool: #81c995;
    --agui-bar-step: #c58af9;
  }
}

.agui-event-list {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.agui-event-list__empty {
  margin: 12px;
  color: var(--agui-fg-muted);
}

.agui-event-row {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border: 0;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--agui-fg);
  font: inherit;
  text-align: left;
  cursor: default;
}

.agui-event-row:hover {
  background: var(--agui-row-hover);
}

.agui-event-row:focus-visible {
  outline: 2px solid var(--agui-accent);
  outline-offset: -2px;
}

.agui-event-row__seq {
  flex: 0 0 4ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--agui-fg-muted);
}

.agui-event-row__type {
  flex: 0 0 auto;
  font-weight: 600;
}

.agui-event-row__summary {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--agui-fg-muted);
}

.agui-event-row[data-severity='error'] {
  border-left-color: var(--agui-severity-error);
  background: var(--agui-severity-error-bg);
}

.agui-event-row[data-severity='warning'] {
  border-left-color: var(--agui-severity-warning);
  background: var(--agui-severity-warning-bg);
}

.agui-event-row[data-severity='info'] {
  border-left-color: var(--agui-severity-info);
  background: var(--agui-severity-info-bg);
}

/* Selection outranks the issue tint; the left border keeps the severity visible. */
.agui-event-row[aria-pressed='true'],
.agui-event-row[data-severity][aria-pressed='true'] {
  background: var(--agui-row-selected);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/tabs/timeline/event-list.test.tsx`
Expected: 7 passed.

- [ ] **Step 5: Commit**

`feat(panel): virtualized timeline event list with inline issue markers`

#### Cycle 2 — `EventDetail`

- [ ] **Step 6: Write the failing test**

`src/panel/tabs/timeline/event-detail.test.tsx`

```tsx
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import type { CaptureRecord } from '../../../core/model/types';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { EventDetail } from './event-detail';

function fixtureState(name: 'malformed' | 'happy'): PanelState {
  const loaded = loadJsonl(name === 'malformed' ? malformedJsonl : happyJsonl);
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    source: { kind: 'imported', filename: `${name}.agui.jsonl`, importedAtMs: 0 },
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function regionOrder(): string[] {
  return screen
    .getAllByRole('region')
    .map((region) => region.getAttribute('aria-label') ?? '')
    .filter((label) => label !== '');
}

describe('EventDetail', () => {
  it('asks for a selection when there is none', () => {
    const store = createPanelStore(fixtureState('malformed'));
    render(<EventDetail store={store} />);

    expect(screen.getByText('Select an event to see its detail.')).toBeTruthy();
  });

  it('puts the verdict above the payload and the raw toggle below both', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 9 });
    render(<EventDetail store={store} />);

    expect(regionOrder()).toEqual(['Event detail', 'Verdict', 'Payload', 'Raw frame']);
  });

  it('names the code, the severity, and the failing op index and reason for a failed patch', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 9 });
    render(<EventDetail store={store} />);

    const verdict = screen.getByRole('region', { name: 'Verdict' });
    expect(within(verdict).getByText('state-patch-failed')).toBeTruthy();
    expect(within(verdict).getByText('error')).toBeTruthy();
    // `opIndex` is on the Issue; `reason` is only on the delta arm of `StateFrame`. The
    // fixture adds /missing/child, so the parent — not the path itself — is what is missing.
    expect(within(verdict).getByText('operation index').nextElementSibling?.textContent).toBe('0');
    expect(within(verdict).getByText('reason').nextElementSibling?.textContent).toBe(
      'parent-not-found',
    );
    expect(within(verdict).getByText('path').nextElementSibling?.textContent).toBe('/missing/child');
  });

  it('renders a verdict with no patch detail for an issue that is not a patch failure', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 5 });
    render(<EventDetail store={store} />);

    const verdict = screen.getByRole('region', { name: 'Verdict' });
    expect(within(verdict).getByText('empty-text-delta')).toBeTruthy();
    expect(within(verdict).queryByText('operation index')).toBeNull();
  });

  it('shows no verdict region at all for a clean event', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 4 });
    render(<EventDetail store={store} />);

    expect(regionOrder()).toEqual(['Event detail', 'Payload', 'Raw frame']);
  });

  it('decodes the payload field by field', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 4 });
    render(<EventDetail store={store} />);

    const payload = within(screen.getByRole('region', { name: 'Payload' }));
    expect(payload.getByText('type').nextElementSibling?.textContent).toBe('TEXT_MESSAGE_CONTENT');
    expect(payload.getByText('messageId').nextElementSibling?.textContent).toBe('m_1');
    expect(payload.getByText('delta').nextElementSibling?.textContent).toBe('Let me check that');
  });

  it('toggles the raw frame exactly as received', () => {
    const store = createPanelStore({ ...fixtureState('malformed'), selectedSeq: 9 });
    render(<EventDetail store={store} />);

    const toggle = screen.getByRole('button', { name: 'raw' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'raw' }).getAttribute('aria-expanded')).toBe('true');
    const raw = screen.getByRole('region', { name: 'Raw frame' });
    expect(raw.textContent).toContain('"path": "/missing/child"');
  });

  it('renders a keepalive record without reaching for an event', () => {
    const store = createPanelStore({ ...fixtureState('happy'), selectedSeq: 11 });
    render(<EventDetail store={store} />);

    const payload = within(screen.getByRole('region', { name: 'Payload' }));
    expect(payload.getByText('kind').nextElementSibling?.textContent).toBe('keepalive');
    expect(payload.getByText('comment').nextElementSibling?.textContent).toBe('ping');
  });

  it('renders an undecodable event record and still offers its raw bytes', () => {
    const records: CaptureRecord[] = [
      { kind: 'event', seq: 7, tMs: 40, connId: 'c1', raw: 'data: {oops', event: null, issues: [] },
    ];
    const store = createPanelStore({ ...initialPanelState(), records, selectedSeq: 7 });
    render(<EventDetail store={store} />);

    expect(
      screen.getByText(
        'This frame could not be decoded into an event. The bytes are under raw, below.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'raw' }));
    expect(screen.getByRole('region', { name: 'Raw frame' }).textContent).toContain('data: {oops');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/panel/tabs/timeline/event-detail.test.tsx`
Expected: FAIL with `Failed to resolve import "./event-detail" from "src/panel/tabs/timeline/event-detail.test.tsx". Does the file exist?`

- [ ] **Step 8: Write the implementation**

`src/panel/tabs/timeline/event-detail.tsx`

```tsx
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { CaptureRecord, Issue, PatchFailure } from '../../../core/model/types';
import { formatDuration } from '../../common/format';
import { issuesBySeq, selectedRecord } from '../../model/selectors';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface EventDetailProps {
  store: PanelStore;
}

/**
 * The reason a JSON Patch op failed is not on `Issue` — only `opIndex` and `path` are. It lives
 * on the `delta` arm of `StateFrame`, so it has to be read back off the run's state timeline.
 * `StateFrame` is a union: `patch` and `failure` exist on `kind === 'delta'` only.
 */
function patchFailureReason(state: PanelState, issue: Issue): PatchFailure | undefined {
  const runs =
    issue.runId === undefined ? state.runs : state.runs.filter((r) => r.runId === issue.runId);
  for (const run of runs) {
    for (const frame of run.stateTimeline) {
      if (frame.kind !== 'delta') continue;
      if (frame.seq !== issue.seq) continue;
      if (frame.failure !== undefined) return frame.failure.reason;
    }
  }
  return undefined;
}

function renderValue(value: unknown): JSX.Element {
  if (typeof value === 'string') return <span class="agui-detail__scalar">{value}</span>;
  if (value === null || typeof value !== 'object') {
    return <span class="agui-detail__scalar">{String(value)}</span>;
  }
  return <pre class="agui-detail__json">{JSON.stringify(value, null, 2)}</pre>;
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const json = JSON.stringify(raw, null, 2);
  return json === undefined ? 'undefined' : json;
}

function Verdict({ issues, state }: { issues: Issue[]; state: PanelState }): JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <section class="agui-detail__verdict" aria-label="Verdict">
      <ul>
        {issues.map((issue) => {
          const reason =
            issue.code === 'state-patch-failed' ? patchFailureReason(state, issue) : undefined;
          return (
            <li key={`${issue.code}@${issue.seq}`} data-severity={issue.severity}>
              <p class="agui-detail__verdict-head">
                <span class="agui-detail__severity">{issue.severity}</span>{' '}
                <code>{issue.code}</code>
              </p>
              <p class="agui-detail__verdict-message">{issue.message}</p>
              {issue.code === 'state-patch-failed' ? (
                <dl class="agui-detail__fields">
                  <dt>operation index</dt>
                  <dd>{issue.opIndex === undefined ? '—' : String(issue.opIndex)}</dd>
                  <dt>reason</dt>
                  <dd>{reason ?? 'unknown'}</dd>
                  <dt>path</dt>
                  <dd>{issue.path ?? '—'}</dd>
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Payload({ record }: { record: CaptureRecord }): JSX.Element {
  if (record.kind === 'keepalive') {
    return (
      <section class="agui-detail__payload" aria-label="Payload">
        <dl class="agui-detail__fields">
          <dt>kind</dt>
          <dd>keepalive</dd>
          <dt>comment</dt>
          <dd>{record.comment === '' ? '(empty heartbeat)' : record.comment}</dd>
        </dl>
      </section>
    );
  }
  const event = record.event;
  if (event === null) {
    return (
      <section class="agui-detail__payload" aria-label="Payload">
        <p>This frame could not be decoded into an event. The bytes are under raw, below.</p>
      </section>
    );
  }
  const fields = Object.entries(event).filter(([key]) => key !== 'type');
  return (
    <section class="agui-detail__payload" aria-label="Payload">
      <dl class="agui-detail__fields">
        {/* HTML5 allows a dt/dd pair to be grouped in a div inside a dl, which is what gives
            each field a stable key without a keyless fragment. */}
        <div class="agui-detail__field">
          <dt>type</dt>
          <dd>{event.type}</dd>
        </div>
        {fields.map(([key, value]) => (
          <div class="agui-detail__field" key={key}>
            <dt>{key}</dt>
            <dd>{renderValue(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function EventDetail({ store }: EventDetailProps): JSX.Element {
  const state = usePanelState(store);
  const [showRaw, setShowRaw] = useState(false);
  const record = selectedRecord(state);

  if (record === undefined) {
    return (
      <section class="agui-detail" aria-label="Event detail">
        <p class="agui-detail__empty">Select an event to see its detail.</p>
      </section>
    );
  }

  const issues = issuesBySeq(state).get(record.seq) ?? [];

  return (
    <section class="agui-detail" aria-label="Event detail">
      <h2 class="agui-detail__title">
        seq {record.seq} · {formatDuration(record.tMs)} · {record.connId}
      </h2>
      {/* Order is load-bearing: verdict, then payload, then raw. P2 has no Issues tab, so this
          is the only place a validator finding is explained. */}
      <Verdict issues={issues} state={state} />
      <Payload record={record} />
      <section class="agui-detail__raw" aria-label="Raw frame">
        <button
          type="button"
          aria-expanded={showRaw}
          onClick={() => {
            setShowRaw((prev) => !prev);
          }}
        >
          raw
        </button>
        {showRaw ? <pre class="agui-detail__json">{rawText(record.raw)}</pre> : null}
      </section>
    </section>
  );
}
```

Append to `src/panel/panel.css`:

```css
.agui-detail {
  min-width: 0;
  padding: 8px 12px;
  overflow: auto;
}

.agui-detail__empty {
  margin: 4px 0;
  color: var(--agui-fg-muted);
}

.agui-detail__title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--agui-fg-muted);
}

.agui-detail__verdict ul {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}

.agui-detail__verdict li {
  padding: 6px 8px;
  border-left: 3px solid var(--agui-severity-info);
  border-radius: 2px;
  background: var(--agui-severity-info-bg);
}

.agui-detail__verdict li + li {
  margin-top: 6px;
}

.agui-detail__verdict li[data-severity='error'] {
  border-left-color: var(--agui-severity-error);
  background: var(--agui-severity-error-bg);
}

.agui-detail__verdict li[data-severity='warning'] {
  border-left-color: var(--agui-severity-warning);
  background: var(--agui-severity-warning-bg);
}

.agui-detail__verdict-head,
.agui-detail__verdict-message {
  margin: 0;
}

.agui-detail__severity {
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--agui-severity-info);
}

li[data-severity='error'] .agui-detail__severity {
  color: var(--agui-severity-error);
}

li[data-severity='warning'] .agui-detail__severity {
  color: var(--agui-severity-warning);
}

.agui-detail__fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  margin: 6px 0 0;
}

/* `display: contents` lets the dt/dd wrapper carry the key without breaking the grid. */
.agui-detail__field {
  display: contents;
}

.agui-detail__fields dt {
  color: var(--agui-fg-muted);
}

.agui-detail__fields dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.agui-detail__json {
  margin: 0;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
}

.agui-detail__raw {
  margin-top: 12px;
}

.agui-detail__raw button {
  padding: 2px 8px;
  border: 1px solid var(--agui-border);
  border-radius: 3px;
  background: transparent;
  color: var(--agui-fg);
  font: inherit;
  cursor: default;
}

.agui-detail__raw button:focus-visible {
  outline: 2px solid var(--agui-accent);
  outline-offset: 1px;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/panel/tabs/timeline/event-detail.test.tsx`
Expected: 9 passed.

- [ ] **Step 10: Commit**

`feat(panel): timeline detail pane with verdict-first ordering`

---

### Task 8: Timeline waterfall and composition

**Files:**
- Create: `src/panel/tabs/timeline/waterfall.tsx`
- Test: `src/panel/tabs/timeline/waterfall.test.tsx`
- Create: `src/panel/tabs/timeline/timeline.tsx`
- Test: `src/panel/tabs/timeline/timeline.test.tsx`
- Edit: `src/panel/panel.css`

#### Cycle 3 — `Waterfall`

- [ ] **Step 11: Write the failing test**

`src/panel/tabs/timeline/waterfall.test.tsx`

```tsx
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { Waterfall } from './waterfall';

function stateFrom(text: string): PanelState {
  const loaded = loadJsonl(text);
  expect(loaded.decodeErrors).toEqual([]);
  return {
    ...initialPanelState(),
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

function fixtureState(name: 'malformed' | 'happy'): PanelState {
  return stateFrom(name === 'malformed' ? malformedJsonl : happyJsonl);
}

/** A run whose message goes quiet for 3.18s — over the 2s default stall threshold. */
const STALLED_JSONL = [
  '{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/run","input":{}}',
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_s","runId":"r_s"}}',
  '{"kind":"event","connId":"c1","seq":2,"tMs":10,"event":{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}}',
  '{"kind":"event","connId":"c1","seq":3,"tMs":20,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"a"}}',
  '{"kind":"event","connId":"c1","seq":4,"tMs":3200,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"b"}}',
  '{"kind":"event","connId":"c1","seq":5,"tMs":3210,"event":{"type":"TEXT_MESSAGE_END","messageId":"m_1"}}',
  '{"kind":"event","connId":"c1","seq":6,"tMs":3220,"event":{"type":"RUN_FINISHED","threadId":"t_s","runId":"r_s"}}',
  '',
].join('\n');

describe('Waterfall', () => {
  it('charts a run bar, a message bar and a tool bar from the real run model', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^run r_happy · finished/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^message m_1 · text/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^tool get_weather/ })).toBeTruthy();
  });

  it('charts step bars', () => {
    const store = createPanelStore(fixtureState('malformed'));
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^step analyze 110ms/ })).toBeTruthy();
  });

  it('positions a bar proportionally within the charted span', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    // Span is 12ms..380ms. The tool starts at 110ms: (110 - 12) / 368 = 26.6%.
    const tool = screen.getByRole('button', { name: /^tool get_weather/ });
    expect(tool.style.left.startsWith('26.6')).toBe(true);
  });

  it('marks a stall inside the message it belongs to', () => {
    const store = createPanelStore(stateFrom(STALLED_JSONL));
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: 'stall 3.18s in m_1 · text' })).toBeTruthy();
  });

  it('selects the run’s first record when the run bar is clicked', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: /^run r_happy/ }));
    expect(store.get().selectedSeq).toBe(1);
  });

  it('selects the message’s first content event when a message bar is clicked', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: /^message m_1/ }));
    expect(store.get().selectedSeq).toBe(3);
  });

  it('selects the first record at or after a tool bar’s start, since tool calls carry no seqs', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: /^tool get_weather/ }));
    expect(store.get().selectedSeq).toBe(7);
  });

  it('marks the hovered bar and clears it on leave', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed={false} />);

    const bar = screen.getByRole('button', { name: /^tool get_weather/ });
    fireEvent.mouseEnter(bar);
    expect(screen.getByRole('button', { name: /^tool get_weather/ }).dataset.hovered).toBe('true');
    fireEvent.mouseLeave(bar);
    expect(screen.getByRole('button', { name: /^tool get_weather/ }).dataset.hovered).toBe('false');
  });

  it('collapses to one summary line that expands on click', () => {
    const store = createPanelStore(fixtureState('happy'));
    render(<Waterfall store={store} collapsed />);

    const toggle = screen.getByRole('button', { name: /^Waterfall · 1 run/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1 tool');
    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /^run r_happy/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Waterfall/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('charts only the scoped run when the scope bar names one', () => {
    const happy = fixtureState('happy');
    const malformed = fixtureState('malformed');
    const both: PanelState = {
      ...happy,
      runs: [...happy.runs, ...malformed.runs],
      records: [...happy.records, ...malformed.records],
      scope: 'r_bad',
    };
    const store = createPanelStore(both);
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^run r_bad/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();
  });

  it('charts every run when the scope is all runs', () => {
    const happy = fixtureState('happy');
    const malformed = fixtureState('malformed');
    const store = createPanelStore({
      ...happy,
      runs: [...happy.runs, ...malformed.runs],
      records: [...happy.records, ...malformed.records],
      scope: null,
    });
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByRole('button', { name: /^run r_happy/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^run r_bad/ })).toBeTruthy();
  });

  it('says there is nothing to chart rather than rendering an empty strip', () => {
    const store = createPanelStore(initialPanelState());
    render(<Waterfall store={store} collapsed={false} />);

    expect(screen.getByText('No runs to chart.')).toBeTruthy();
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/panel/tabs/timeline/waterfall.test.tsx`
Expected: FAIL with `Failed to resolve import "./waterfall" from "src/panel/tabs/timeline/waterfall.test.tsx". Does the file exist?`

- [ ] **Step 13: Write the implementation**

`src/panel/tabs/timeline/waterfall.tsx`

```tsx
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { CaptureRecord, Run } from '../../../core/model/types';
import { formatDuration } from '../../common/format';
import { scopedRun } from '../../model/selectors';
import type { PanelState } from '../../model/panel-types';
import { selectSeq, type PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface WaterfallProps {
  store: PanelStore;
  collapsed: boolean;
}

type Lane = 'run' | 'message' | 'tool' | 'step';

interface Bar {
  id: string;
  lane: Lane;
  label: string;
  startMs: number;
  /** `undefined` while the span is still open; resolved to the chart's end before drawing. */
  endMs: number | undefined;
  /** The event this bar points at, or `null` when no record falls inside it. */
  seq: number | null;
  /** Stalls belonging to this bar, drawn inside its track. Message bars only. */
  stalls: Array<{ startMs: number; endMs: number }>;
}

const LANE_LABEL: Record<Lane, string> = {
  run: 'run',
  message: 'message',
  tool: 'tool',
  step: 'step',
};

/**
 * The first record at or after `tMs`, among the records the run actually owns.
 *
 * `ToolCallRecord` and `StepRecord` carry timestamps but no seqs, so this is the only honest
 * way to point a tool or step bar at an event. `recordSeqs` is in arrival order, so a linear
 * scan finds the first match.
 */
function seqAtTime(run: Run, bySeq: Map<number, CaptureRecord>, tMs: number): number | null {
  for (const seq of run.recordSeqs) {
    const record = bySeq.get(seq);
    if (record !== undefined && record.tMs >= tMs) return seq;
  }
  return null;
}

function barsForRun(run: Run, bySeq: Map<number, CaptureRecord>): Bar[] {
  const stallsByMessage = new Map<string, Array<{ startMs: number; endMs: number }>>();
  for (const stall of run.metrics.stalls) {
    const existing = stallsByMessage.get(stall.messageId);
    const entry = { startMs: stall.startMs, endMs: stall.endMs };
    if (existing) existing.push(entry);
    else stallsByMessage.set(stall.messageId, [entry]);
  }

  const bars: Bar[] = [
    {
      id: `run:${run.runId}`,
      lane: 'run',
      label: `${run.runId} · ${run.outcome}`,
      startMs: run.startedAtMs,
      endMs: run.endedAtMs,
      seq: run.recordSeqs[0] ?? null,
      stalls: [],
    },
  ];

  for (const message of run.messages.values()) {
    bars.push({
      id: `message:${run.runId}:${message.messageId}`,
      lane: 'message',
      label: `${message.messageId} · ${message.kind}`,
      startMs: message.startedAtMs,
      endMs: message.endedAtMs,
      // `contentSeqs` is exactly "the events this message is made of", so it beats a time scan.
      seq: message.contentSeqs[0] ?? seqAtTime(run, bySeq, message.startedAtMs),
      stalls: stallsByMessage.get(message.messageId) ?? [],
    });
  }

  for (const toolCall of run.toolCalls.values()) {
    bars.push({
      id: `tool:${run.runId}:${toolCall.toolCallId}`,
      lane: 'tool',
      label: toolCall.toolCallName ?? toolCall.toolCallId,
      startMs: toolCall.startedAtMs,
      // The result is what the caller waited for, so it wins over the args-complete time.
      endMs: toolCall.resultAtMs ?? toolCall.endedAtMs,
      seq: seqAtTime(run, bySeq, toolCall.startedAtMs),
      stalls: [],
    });
  }

  for (const [index, step] of run.steps.entries()) {
    bars.push({
      id: `step:${run.runId}:${index}`,
      lane: 'step',
      label: step.stepName,
      startMs: step.startedAtMs,
      endMs: step.endedAtMs,
      seq: seqAtTime(run, bySeq, step.startedAtMs),
      stalls: [],
    });
  }

  return bars;
}

interface Chart {
  runs: Run[];
  bars: Bar[];
  startMs: number;
  endMs: number;
  stallCount: number;
}

function buildChart(state: PanelState): Chart {
  // Scoped to one run when the scope bar names one; otherwise every run is charted, which is
  // what keeps the cross-run view P3 asks for from going blank.
  const scoped = scopedRun(state);
  const runs = scoped === undefined ? state.runs : [scoped];
  const bySeq = new Map<number, CaptureRecord>(state.records.map((record) => [record.seq, record]));
  const bars = runs.flatMap((run) => barsForRun(run, bySeq));

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    startMs = Math.min(startMs, bar.startMs);
    endMs = Math.max(endMs, bar.endMs ?? bar.startMs);
    for (const stall of bar.stalls) endMs = Math.max(endMs, stall.endMs);
  }
  if (bars.length === 0) {
    startMs = 0;
    endMs = 0;
  }

  return {
    runs,
    bars,
    startMs,
    endMs,
    stallCount: bars.reduce((total, bar) => total + bar.stalls.length, 0),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function summarize(chart: Chart): string {
  const count = (lane: Lane): number => chart.bars.filter((bar) => bar.lane === lane).length;
  return [
    plural(chart.runs.length, 'run'),
    plural(count('message'), 'message'),
    plural(count('tool'), 'tool'),
    plural(count('step'), 'step'),
    plural(chart.stallCount, 'stall'),
    formatDuration(chart.endMs - chart.startMs),
  ].join(' · ');
}

function pct(value: number, startMs: number, span: number): number {
  return ((value - startMs) / span) * 100;
}

export function Waterfall({ store, collapsed }: WaterfallProps): JSX.Element {
  const state = usePanelState(store);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const chart = buildChart(state);
  const showChart = !collapsed || expanded;
  // A zero-length chart (a single instantaneous run) would divide by zero.
  const span = Math.max(1, chart.endMs - chart.startMs);

  const select = (seq: number | null): void => {
    if (seq === null) return;
    store.update((prev) => selectSeq(prev, seq));
  };

  return (
    <section class="agui-waterfall" aria-label="Waterfall" data-collapsed={collapsed}>
      {collapsed ? (
        <button
          type="button"
          class="agui-waterfall__toggle"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
        >
          Waterfall · {summarize(chart)}
        </button>
      ) : null}
      {showChart ? (
        chart.bars.length === 0 ? (
          <p class="agui-waterfall__empty">No runs to chart.</p>
        ) : (
          <ol class="agui-waterfall__lanes">
            {chart.bars.map((bar) => {
              const endMs = bar.endMs ?? chart.endMs;
              const left = pct(bar.startMs, chart.startMs, span);
              const width = Math.max(0.5, pct(endMs, chart.startMs, span) - left);
              const duration = formatDuration(endMs - bar.startMs);
              return (
                <li class="agui-waterfall__lane" key={bar.id} data-lane={bar.lane}>
                  <span class="agui-waterfall__lane-label">{bar.label}</span>
                  <span class="agui-waterfall__track">
                    <button
                      type="button"
                      class="agui-waterfall__bar"
                      data-lane={bar.lane}
                      data-open={bar.endMs === undefined}
                      data-hovered={hovered === bar.id}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      // A bar has no text of its own — it is a coloured rectangle — so its name
                      // is stated outright rather than assembled from child spans.
                      aria-label={`${LANE_LABEL[bar.lane]} ${bar.label} ${duration}${
                        bar.endMs === undefined ? ' (open)' : ''
                      }`}
                      // Hover is a local emphasis only. Highlighting the matching rows in the
                      // event list would need a `hoveredSeqs` field the locked contract does not
                      // have; clicking selects instead, which the list already reacts to.
                      onMouseEnter={() => {
                        setHovered(bar.id);
                      }}
                      onMouseLeave={() => {
                        setHovered(null);
                      }}
                      onFocus={() => {
                        setHovered(bar.id);
                      }}
                      onBlur={() => {
                        setHovered(null);
                      }}
                      onClick={() => {
                        select(bar.seq);
                      }}
                    />
                    {bar.stalls.map((stall) => {
                      const stallLeft = pct(stall.startMs, chart.startMs, span);
                      const stallWidth = Math.max(
                        0.5,
                        pct(stall.endMs, chart.startMs, span) - stallLeft,
                      );
                      return (
                        <button
                          type="button"
                          class="agui-waterfall__stall"
                          key={`${bar.id}:stall:${stall.startMs}`}
                          style={{ left: `${stallLeft}%`, width: `${stallWidth}%` }}
                          aria-label={`stall ${formatDuration(stall.endMs - stall.startMs)} in ${
                            bar.label
                          }`}
                          onClick={() => {
                            select(bar.seq);
                          }}
                        />
                      );
                    })}
                  </span>
                  <span class="agui-waterfall__duration">{duration}</span>
                </li>
              );
            })}
          </ol>
        )
      ) : null}
    </section>
  );
}
```

Append to `src/panel/panel.css`:

```css
.agui-waterfall {
  padding: 6px 12px;
  border-bottom: 1px solid var(--agui-border);
}

.agui-waterfall__toggle {
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--agui-fg-muted);
  font: inherit;
  text-align: left;
  cursor: default;
}

.agui-waterfall__toggle:focus-visible {
  outline: 2px solid var(--agui-accent);
  outline-offset: 1px;
}

.agui-waterfall__empty {
  margin: 4px 0;
  color: var(--agui-fg-muted);
}

.agui-waterfall__lanes {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.agui-waterfall__lane {
  display: grid;
  grid-template-columns: 16ch minmax(0, 1fr) 7ch;
  gap: 8px;
  align-items: center;
}

.agui-waterfall__lane-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--agui-fg-muted);
}

.agui-waterfall__track {
  position: relative;
  display: block;
  height: 10px;
  border-radius: 5px;
  background: var(--agui-track);
}

.agui-waterfall__bar {
  position: absolute;
  top: 0;
  height: 10px;
  min-width: 2px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: var(--agui-bar-run);
  cursor: default;
}

.agui-waterfall__bar[data-lane='message'] {
  background: var(--agui-bar-message);
}

.agui-waterfall__bar[data-lane='tool'] {
  background: var(--agui-bar-tool);
}

.agui-waterfall__bar[data-lane='step'] {
  background: var(--agui-bar-step);
}

/* An unterminated span is drawn to the edge of the chart, hatched so it does not
   read as a measured duration. */
.agui-waterfall__bar[data-open='true'] {
  background-image: repeating-linear-gradient(
    135deg,
    rgb(255 255 255 / 45%) 0 3px,
    transparent 3px 6px
  );
}

.agui-waterfall__bar[data-hovered='true'],
.agui-waterfall__bar:focus-visible {
  outline: 2px solid var(--agui-accent);
  outline-offset: 1px;
}

.agui-waterfall__stall {
  position: absolute;
  top: -3px;
  height: 16px;
  min-width: 3px;
  padding: 0;
  border: 1px solid var(--agui-severity-error);
  border-radius: 2px;
  background: repeating-linear-gradient(
    45deg,
    var(--agui-severity-error) 0 2px,
    transparent 2px 5px
  );
  cursor: default;
}

.agui-waterfall__duration {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--agui-fg-muted);
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/panel/tabs/timeline/waterfall.test.tsx`
Expected: 12 passed.

- [ ] **Step 15: Commit**

`feat(panel): timeline waterfall with run, message, tool and step lanes`

#### Cycle 4 — `Timeline`

- [ ] **Step 16: Write the failing test**

`src/panel/tabs/timeline/timeline.test.tsx`

```tsx
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';

// `useIsNarrow` reads the viewport, which jsdom does not resize. Overriding just the hook keeps
// the test independent of how the hook measures, while `NARROW_BREAKPOINT_PX` stays the real one.
const narrow = { value: false };
vi.mock('../../common/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/layout')>();
  return { ...actual, useIsNarrow: () => narrow.value };
});

const { Timeline } = await import('./timeline');

function fixtureState(): PanelState {
  const loaded = loadJsonl(happyJsonl);
  return {
    ...initialPanelState(),
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
  };
}

beforeEach(() => {
  narrow.value = false;
});

describe('Timeline', () => {
  it('composes the waterfall, the list and the detail pane', () => {
    const store = createPanelStore(fixtureState());
    render(<Timeline store={store} />);

    expect(screen.getByRole('region', { name: 'Waterfall' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Event list' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Event detail' })).toBeTruthy();
  });

  it('splits list and detail side by side above the narrow breakpoint', () => {
    const store = createPanelStore(fixtureState());
    const { container } = render(<Timeline store={store} />);

    expect(container.querySelector('.agui-timeline')?.getAttribute('data-layout')).toBe('split');
    // Not collapsed: the waterfall draws its bars rather than a summary toggle.
    expect(screen.queryByRole('button', { name: /^Waterfall ·/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^run r_happy/ })).toBeTruthy();
  });

  it('stacks the detail under the list and collapses the waterfall below it', () => {
    narrow.value = true;
    const store = createPanelStore(fixtureState());
    const { container } = render(<Timeline store={store} />);

    expect(container.querySelector('.agui-timeline')?.getAttribute('data-layout')).toBe('stacked');
    expect(screen.getByRole('button', { name: /^Waterfall ·/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^run r_happy/ })).toBeNull();
    // Both panes are still present; only their arrangement changed.
    expect(screen.getByRole('group', { name: 'Event list' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Event detail' })).toBeTruthy();
  });
});
```

- [ ] **Step 17: Run test to verify it fails**

Run: `pnpm vitest run src/panel/tabs/timeline/timeline.test.tsx`
Expected: FAIL with `Failed to resolve import "./timeline" from "src/panel/tabs/timeline/timeline.test.tsx". Does the file exist?`

- [ ] **Step 18: Write the implementation**

`src/panel/tabs/timeline/timeline.tsx`

```tsx
import type { JSX } from 'preact';
import { useIsNarrow } from '../../common/layout';
import type { PanelStore } from '../../model/store';
import { EventDetail } from './event-detail';
import { EventList } from './event-list';
import { Waterfall } from './waterfall';

export interface TimelineProps {
  store: PanelStore;
}

export function Timeline({ store }: TimelineProps): JSX.Element {
  // P4 and open question 1 share one answer: below `NARROW_BREAKPOINT_PX` the detail pane stacks
  // under the list and the waterfall collapses to a single line. The breakpoint is applied in JS
  // rather than a media query so `NARROW_BREAKPOINT_PX` stays the single definition of it.
  const narrow = useIsNarrow();
  return (
    <div class="agui-timeline" data-layout={narrow ? 'stacked' : 'split'}>
      <Waterfall store={store} collapsed={narrow} />
      <div class="agui-timeline__body">
        <EventList store={store} />
        <EventDetail store={store} />
      </div>
    </div>
  );
}
```

Append to `src/panel/panel.css`:

```css
/* --- layout (P4) ---------------------------------------------------------
 * The split is driven by `data-layout`, not a media query: NARROW_BREAKPOINT_PX
 * is defined once in common/layout.ts and nothing else may restate 600.
 */

.agui-timeline {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.agui-timeline__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.agui-timeline[data-layout='split'] .agui-timeline__body {
  flex-direction: row;
}

.agui-timeline[data-layout='split'] .agui-event-list {
  flex: 1 1 60%;
}

.agui-timeline[data-layout='split'] .agui-detail {
  flex: 1 1 40%;
  border-left: 1px solid var(--agui-border);
}

.agui-timeline[data-layout='stacked'] .agui-timeline__body {
  flex-direction: column;
}

.agui-timeline[data-layout='stacked'] .agui-detail {
  flex: 0 1 auto;
  max-height: 45%;
  border-top: 1px solid var(--agui-border);
}
```

- [ ] **Step 19: Run test to verify it passes**

Run: `pnpm vitest run src/panel/tabs/timeline/timeline.test.tsx`
Expected: 3 passed.

- [ ] **Step 20: Commit**

`feat(panel): compose the Timeline tab and resolve the narrow-layout question`

---

## Verification actually performed

Built in `scratchpad/verify-panel-E/` against a copy of the real `src/core` and the real
`src/test/fixtures`, with the store, selectors, `format.ts`, `layout.ts`, `virtual-list.tsx` and
`load-jsonl.ts` stubbed to the locked contract. `loadJsonl` replays through the real
`createRunBuilder`, so every number in the tests comes from the shipped run builder.

- `pnpm vitest run` → **21 files, 381 tests passed** (350 core + the 31 panel tests above).
- `tsc --noEmit` with `noUncheckedIndexedAccess`, `strict`, and test files included → **clean, no
  `any`**.
- Contrast measured for every foreground/background pair in both schemes. Worst text pair:
  4.65:1 (light, muted on a selected row) and 4.83:1 (dark, same). Body text on tinted rows ranges
  10.6:1 – 15.4:1. Bars against the track: 3.31:1 – 7.13:1. `--agui-row-selected` in dark was moved
  from `#274060` to `#1f3350` because the first measured 4.00:1 for muted text.

Two things the run found that were not obvious from reading:

1. The malformed fixture's failed patch reason is **`parent-not-found`**, not `path-not-found` —
   `add /missing/child` fails because `/missing` does not exist. The first draft of the test
   asserted the wrong constant and the implementation was right.
2. Rendered output for the malformed fixture, confirming the inline-issue treatment lands on
   exactly the three known seqs:

```html
<button class="agui-event-row" aria-label="seq 5 TEXT_MESSAGE_CONTENT m_1 · &quot;&quot; — error: empty-text-delta" data-severity="error">…
<button class="agui-event-row" aria-label="seq 9 STATE_DELTA [{&quot;op&quot;:&quot;add&quot;,…}] — error: state-patch-failed" data-severity="error" aria-pressed="true">…
<button class="agui-event-row" aria-label="seq 10 STEP_FINISHED analyze — error: run-never-terminated" data-severity="error">…
```

and the detail pane for seq 9:

```html
<section aria-label="Verdict"><li data-severity="error">
  <span class="agui-detail__severity">error</span> <code>state-patch-failed</code>
  <p>STATE_DELTA op 0 (add /missing/child) failed: parent-not-found</p>
  <dl><dt>operation index</dt><dd>0</dd><dt>reason</dt><dd>parent-not-found</dd>
      <dt>path</dt><dd>/missing/child</dd></dl>
</li></section>
```

---

### Task 9: Import, capture status, and Session

**Files:**
- Create: `packages/devtools/src/panel/import/drop-zone.tsx`
- Create: `packages/devtools/src/panel/import/apply-loaded.ts`
- Create: `packages/devtools/src/panel/capture/detect.ts`
- Create: `packages/devtools/src/panel/capture/capture-status.tsx`
- Create: `packages/devtools/src/panel/model/use-panel-state.ts`
- Create: `packages/devtools/src/panel/tabs/session/session.tsx`
- Test: `packages/devtools/src/panel/import/drop-zone.test.tsx`
- Test: `packages/devtools/src/panel/capture/detect.test.ts`
- Test: `packages/devtools/src/panel/capture/capture-status.test.tsx`
- Test: `packages/devtools/src/panel/tabs/session/session.test.tsx`

Four cycles: DropZone, `observeNetwork`, CaptureBanner, Session.

---

#### Cycle 1 — DropZone

- [ ] **Step 1: Write the failing test**

`packages/devtools/src/panel/import/drop-zone.test.tsx`

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { DropZone } from './drop-zone';
import type { LoadedCapture } from './load-jsonl';
import { createPanelStore } from '../model/store';

function fileOf(name: string, text: string): File {
  return new File([text], name, { type: 'application/jsonl' });
}

/** jsdom's DataTransfer has no usable `files`, so hand `drop` a minimal stand-in. */
function dropFile(target: HTMLElement, file: File): void {
  fireEvent.drop(target, {
    dataTransfer: { files: { item: (i: number) => (i === 0 ? file : null), length: 1 } },
  });
}

describe('DropZone', () => {
  it('invites a drop and offers a file picker', () => {
    render(<DropZone store={createPanelStore()} onLoaded={vi.fn()} />);
    expect(screen.getByText(/drop a \.agui\.jsonl capture here/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /choose file/i })).toBeTruthy();
    expect(screen.getByLabelText(/import \.agui\.jsonl capture/i)).toBeTruthy();
  });

  it('decodes a picked file and hands the result up', async () => {
    const onLoaded = vi.fn();
    render(<DropZone store={createPanelStore()} onLoaded={onLoaded} />);

    const input = screen.getByLabelText(/import \.agui\.jsonl capture/i) as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: {
        item: (i: number) =>
          i === 0
            ? fileOf(
                'happy.agui.jsonl',
                '{"kind":"header","schemaVersion":1,"tool":"t","capturedAt":"2026-01-01T00:00:00Z","url":"http://x"}\n' +
                  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
                  '{"kind":"event","connId":"c1","seq":2,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n',
              )
            : null,
      },
      configurable: true,
    });
    fireEvent.change(input);

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    const [loaded, filename] = onLoaded.mock.calls[0] as [LoadedCapture, string];
    expect(filename).toBe('happy.agui.jsonl');
    expect(loaded.records).toHaveLength(2);
    expect(loaded.decodeErrors).toEqual([]);
    expect(await screen.findByText(/every line decoded/i)).toBeTruthy();
  });

  it('decodes a dropped file', async () => {
    const onLoaded = vi.fn();
    render(<DropZone store={createPanelStore()} onLoaded={onLoaded} />);
    dropFile(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      fileOf(
        'x.agui.jsonl',
        '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n',
      ),
    );
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
  });

  it('surfaces every decode error so a partial file never looks clean', async () => {
    const onLoaded = vi.fn();
    render(<DropZone store={createPanelStore()} onLoaded={onLoaded} />);
    dropFile(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      fileOf(
        'partial.agui.jsonl',
        '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
          '{ this is not json\n' +
          '{"kind":"event","connId":"c1","seq":2,"tMs":5,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n' +
          'also not json\n',
      ),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/2 undecodable lines/i);
    expect(alert.textContent).toMatch(/incomplete/i);
    expect(alert.querySelectorAll('li')).toHaveLength(2);
    // The clean-load line must NOT also be on screen.
    expect(screen.queryByText(/every line decoded/i)).toBeNull();
  });

  it('records a failure on the store and reports it, without calling onLoaded', async () => {
    const store = createPanelStore();
    const onLoaded = vi.fn();
    const unreadable = fileOf('broken.agui.jsonl', 'x');
    // Simulate an unreadable file: FileReader is what the component uses.
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (
      this: FileReader,
    ) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>));
    });

    render(<DropZone store={store} onLoaded={onLoaded} />);
    dropFile(screen.getByText(/drop a \.agui\.jsonl capture here/i), unreadable);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/import failed/i);
    expect(store.get().loadError).toMatch(/^broken\.agui\.jsonl: /);
    expect(onLoaded).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/panel/import/drop-zone.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./drop-zone" from "src/panel/import/drop-zone.test.tsx". Does the file exist?`

- [ ] **Step 3: Write the implementation**

`packages/devtools/src/panel/import/drop-zone.tsx`

```tsx
import { useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PanelStore } from '../model/store';
import { loadFailed } from '../model/store';
import type { LoadedCapture } from './load-jsonl';
import { loadJsonl } from './load-jsonl';

/**
 * Read a picked or dropped file as text.
 *
 * `File.text()` would be the modern spelling, but jsdom implements neither `Blob.text()` nor
 * `Blob.arrayBuffer()`, so using it would make this component untestable outside a real browser.
 * `FileReader` is implemented everywhere including jsdom. Do not "modernize" this.
 */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not be read'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

export interface DropZoneProps {
  store: PanelStore;
  /** Called with a successfully decoded capture. The caller commits it (see `applyLoaded`). */
  onLoaded: (loaded: LoadedCapture, filename: string) => void;
}

/**
 * Import of a `.agui.jsonl` capture, by drag-and-drop or file picker.
 *
 * Requirements §10 makes this the shareable-bug-report path, not a fallback: a colleague who
 * cannot reproduce the issue gets your exact stream, read-only, with every tab working. Under
 * the design's §7 sequencing it is also the only way data reaches the panel until the capture
 * layer lands, so it is a first-class control rather than a corner of an empty state.
 *
 * Reading is a `FileReader` over the picked file and nothing else — no network, nothing
 * written to disk (requirements §11).
 *
 * `decodeErrors` is rendered here line by line and summarized into `loadError` by the caller's
 * commit. A file that half decoded must never render as a clean one.
 */
export function DropZone({ store, onLoaded }: DropZoneProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [decodeErrors, setDecodeErrors] = useState<string[]>([]);
  const [loadedName, setLoadedName] = useState<string | null>(null);

  function fail(filename: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const message = `${filename}: ${detail}`;
    setDecodeErrors([]);
    setLoadedName(null);
    setFailure(message);
    store.update((s) => loadFailed(s, message));
  }

  async function ingest(file: File): Promise<void> {
    let text: string;
    try {
      text = await readText(file);
    } catch (cause) {
      fail(file.name, cause);
      return;
    }
    let loaded: LoadedCapture;
    try {
      loaded = loadJsonl(text, { expandChunks: store.get().expandChunks });
    } catch (cause) {
      // `loadJsonl` is specified not to throw, so reaching here is a bug in the decoder rather
      // than bad input. Report it as a failed import instead of rendering an empty panel.
      fail(file.name, cause);
      return;
    }
    setFailure(null);
    setDecodeErrors(loaded.decodeErrors);
    setLoadedName(file.name);
    onLoaded(loaded, file.name);
  }

  function onDrop(event: JSX.TargetedDragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files.item(0);
    if (file) void ingest(file);
  }

  function onPick(event: JSX.TargetedEvent<HTMLInputElement, Event>): void {
    const input = event.currentTarget;
    const file = input.files?.item(0);
    // Clear the value so re-picking the same file fires `change` again.
    input.value = '';
    if (file) void ingest(file);
  }

  return (
    <div class="agui-drop">
      <div
        class={dragging ? 'agui-drop__target agui-drop__target--over' : 'agui-drop__target'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p class="agui-drop__hint">Drop a .agui.jsonl capture here</p>
        <button type="button" class="agui-drop__pick" onClick={() => inputRef.current?.click()}>
          Choose file
        </button>
        <input
          ref={inputRef}
          class="agui-drop__input"
          type="file"
          accept=".jsonl,.agui.jsonl,application/jsonl,text/plain"
          aria-label="Import .agui.jsonl capture"
          onChange={onPick}
        />
      </div>

      {failure !== null && (
        <p class="agui-drop__error" role="alert">
          Import failed — {failure}
        </p>
      )}

      {loadedName !== null && decodeErrors.length === 0 && (
        <p class="agui-drop__ok">Loaded {loadedName} — every line decoded.</p>
      )}

      {loadedName !== null && decodeErrors.length > 0 && (
        <div class="agui-drop__partial" role="alert">
          <p class="agui-drop__partial-head">
            Loaded {loadedName} with {decodeErrors.length} undecodable{' '}
            {decodeErrors.length === 1 ? 'line' : 'lines'} — this capture is incomplete.
          </p>
          <ul class="agui-drop__partial-list">
            {decodeErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/panel/import/drop-zone.test.tsx`
Expected: `Test Files 1 passed (1) / Tests 5 passed (5)`

- [ ] **Step 5: Commit**

`git commit -m "feat(panel): import .agui.jsonl by drop or picker, surfacing decode errors"`

---

#### Cycle 2 — observeNetwork

- [ ] **Step 6: Write the failing test**

`packages/devtools/src/panel/capture/detect.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { observeNetwork } from './detect';

type Listener = (request: chrome.devtools.network.Request) => void;

interface FakeEvent {
  addListener: (fn: Listener) => void;
  removeListener: (fn: Listener) => void;
  emit: (request: chrome.devtools.network.Request) => void;
  count: () => number;
}

function installNetwork(): FakeEvent {
  const listeners = new Set<Listener>();
  const event: FakeEvent = {
    addListener: (fn) => void listeners.add(fn),
    removeListener: (fn) => void listeners.delete(fn),
    emit: (request) => {
      for (const fn of [...listeners]) fn(request);
    },
    count: () => listeners.size,
  };
  Object.defineProperty(globalThis, 'chrome', {
    value: { devtools: { network: { onRequestFinished: event } } },
    writable: true,
    configurable: true,
  });
  return event;
}

function requestWith(mimeType: string, headerValue?: string): chrome.devtools.network.Request {
  return {
    response: {
      content: { mimeType, size: 0 },
      headers: headerValue === undefined ? [] : [{ name: 'Content-Type', value: headerValue }],
    },
  } as unknown as chrome.devtools.network.Request;
}

describe('observeNetwork', () => {
  it('reports a text/event-stream response by mime type', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('text/event-stream'));
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('reports one found only in the content-type header', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('', 'text/event-stream; charset=utf-8'));
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('ignores every other content type', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('application/json'));
    event.emit(requestWith('text/html', 'text/html'));
    expect(onDetected).not.toHaveBeenCalled();
  });

  it('fires at most once and detaches itself', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('text/event-stream'));
    event.emit(requestWith('text/event-stream'));
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(event.count()).toBe(0);
  });

  it('unsubscribes, and unsubscribing twice is harmless', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    const stop = observeNetwork(onDetected);
    expect(event.count()).toBe(1);
    stop();
    stop();
    expect(event.count()).toBe(0);
    event.emit(requestWith('text/event-stream'));
    expect(onDetected).not.toHaveBeenCalled();
  });

  it('returns a no-op unsubscribe when the DevTools network API is absent', () => {
    Object.defineProperty(globalThis, 'chrome', {
      value: {},
      writable: true,
      configurable: true,
    });
    const onDetected = vi.fn();
    expect(() => observeNetwork(onDetected)()).not.toThrow();
    expect(onDetected).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/panel/capture/detect.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./detect" from "src/panel/capture/detect.test.ts". Does the file exist?`

- [ ] **Step 8: Write the implementation**

`packages/devtools/src/panel/capture/detect.ts`

```ts
const EVENT_STREAM = 'text/event-stream';

/**
 * Is this finished request an SSE response?
 *
 * `content-type` is the ONLY header this extension ever reads (requirements §11); the HAR
 * entry's `content.mimeType` is preferred because DevTools fills it in even when the header
 * list is empty.
 */
function isEventStream(request: chrome.devtools.network.Request): boolean {
  const mimeType = request.response.content.mimeType;
  if (typeof mimeType === 'string' && mimeType.toLowerCase().includes(EVENT_STREAM)) {
    return true;
  }
  return request.response.headers.some(
    (header) =>
      header.name.toLowerCase() === 'content-type' &&
      header.value.toLowerCase().includes(EVENT_STREAM),
  );
}

/**
 * Passive AG-UI detection over the DevTools network log (design decision P5).
 *
 * This is the WEAKER of the two detection paths, and deliberately so. The strong path is the
 * content classifier in `core/detect`, which reads live frames off the wire and can tell an
 * AG-UI stream from any other SSE stream. This one only ever sees *completed* responses through
 * `chrome.devtools.network`, never a live frame, so it can report "an SSE endpoint exists on
 * this origin" and NOTHING MORE — it cannot decode, cannot validate, and cannot distinguish
 * AG-UI from a progress-bar stream. Design §10 records that keeping the two paths from
 * disagreeing is a real maintenance cost P5 accepts; the mitigation is that everything this
 * function drives is an offer to enable capture, never a claim about the stream's contents.
 *
 * It also makes no request of its own — it observes a log DevTools already keeps
 * (requirements §11, no egress).
 *
 * Fires `onDetected` at most once per subscription; unsubscribe and resubscribe to re-arm
 * (which is what a navigation to a new origin should do). Returns the unsubscribe, which is
 * safe to call more than once, and a no-op unsubscribe when the DevTools APIs are absent —
 * the panel HTML is also opened outside DevTools by the screenshot harness.
 */
export function observeNetwork(onDetected: () => void): () => void {
  const event = chrome.devtools?.network?.onRequestFinished;
  if (event === undefined) {
    return () => {};
  }

  let live = true;
  const listener = (request: chrome.devtools.network.Request): void => {
    if (!live || !isEventStream(request)) return;
    live = false;
    event.removeListener(listener);
    onDetected();
  };

  event.addListener(listener);
  return () => {
    if (!live) return;
    live = false;
    event.removeListener(listener);
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/panel/capture/detect.test.ts`
Expected: `Test Files 1 passed (1) / Tests 6 passed (6)`

- [ ] **Step 10: Commit**

`git commit -m "feat(panel): passive SSE detection over chrome.devtools.network (P5)"`

---

#### Cycle 3 — CaptureBanner

- [ ] **Step 11: Write the failing test**

`packages/devtools/src/panel/capture/capture-status.test.tsx`

```tsx
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { CaptureBanner } from './capture-status';
import { createPanelStore } from '../model/store';
import type { PanelStore } from '../model/store';
import { initialPanelState } from '../model/panel-types';
import type { CaptureStatus, PanelSource } from '../model/panel-types';

function storeWith(capture: CaptureStatus, source: PanelSource = { kind: 'empty' }): PanelStore {
  return createPanelStore({ ...initialPanelState(), capture, source });
}

describe('CaptureBanner', () => {
  it('offers Enable and states the reload requirement when AG-UI is detected', () => {
    const onEnable = vi.fn();
    render(
      <CaptureBanner
        store={storeWith({ kind: 'off', origin: 'https://app.example', aguiDetected: true })}
        onEnable={onEnable}
      />,
    );

    expect(screen.getByText(/detected on https:\/\/app\.example/i)).toBeTruthy();
    expect(screen.getByText(/requires a reload of the inspected page/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  it('says plainly that nothing has been detected, with no Enable button', () => {
    render(
      <CaptureBanner
        store={storeWith({ kind: 'off', origin: 'https://app.example', aguiDetected: false })}
        onEnable={vi.fn()}
      />,
    );

    expect(screen.getByText(/no ag-ui stream detected on https:\/\/app\.example yet/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says capture is on and idle while no records have arrived', () => {
    render(
      <CaptureBanner
        store={storeWith({ kind: 'on', origin: 'http://localhost:3000' })}
        onEnable={vi.fn()}
      />,
    );
    expect(screen.getByText(/capture is on for http:\/\/localhost:3000/i)).toBeTruthy();
    expect(screen.getByText(/waiting for a run/i)).toBeTruthy();
  });

  it('goes quiet once records are flowing', () => {
    const store = storeWith({ kind: 'on', origin: 'http://localhost:3000' });
    store.update((s) => ({
      ...s,
      records: [
        { kind: 'keepalive', seq: 1, tMs: 0, connId: 'c1', raw: '', comment: '', issues: [] },
      ],
    }));
    const { container } = render(<CaptureBanner store={store} onEnable={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('explains that this build has no capture layer rather than showing nothing', () => {
    render(<CaptureBanner store={storeWith({ kind: 'unsupported' })} onEnable={vi.fn()} />);
    expect(screen.getByText(/live capture is not available in this build/i)).toBeTruthy();
    expect(screen.getByText(/\.agui\.jsonl/)).toBeTruthy();
  });

  it('goes quiet while an imported capture is on screen', () => {
    const { container } = render(
      <CaptureBanner
        store={storeWith(
          { kind: 'unsupported' },
          { kind: 'imported', filename: 'bug.agui.jsonl', importedAtMs: 0 },
        )}
        onEnable={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('re-renders when capture status changes', () => {
    const store = storeWith({ kind: 'off', origin: 'https://app.example', aguiDetected: false });
    render(<CaptureBanner store={store} onEnable={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();

    act(() => {
      store.update((s) => ({
        ...s,
        capture: { kind: 'off', origin: 'https://app.example', aguiDetected: true },
      }));
    });
    expect(screen.getByRole('button', { name: /enable capture for/i })).toBeTruthy();
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/panel/capture/capture-status.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./capture-status" from "src/panel/capture/capture-status.test.tsx". Does the file exist?`

- [ ] **Step 13: Write the implementation**

`packages/devtools/src/panel/model/use-panel-state.ts` — **already created in Task 2** (appendix
R1). Four sections independently invented this hook because the contract forgot it; it is
consolidated into Task 2 and imported here. Do NOT recreate it — this block is reproduced only so
the file's contents are visible in context.

```ts
import { useEffect, useState } from 'preact/hooks';
import type { PanelStore } from './store';
import type { PanelState } from './panel-types';

/**
 * Subscribe a component to the store.
 *
 * `useSyncExternalStore` lives in `preact/compat`, which would pull the React shim into a
 * package that has exactly one runtime dependency. `PanelStore.subscribe` already returns its
 * own unsubscribe, so this is the whole of it.
 */
export function usePanelState(store: PanelStore): PanelState {
  const [state, setState] = useState<PanelState>(() => store.get());
  useEffect(() => store.subscribe(() => setState(store.get())), [store]);
  return state;
}
```

`packages/devtools/src/panel/capture/capture-status.tsx`

```tsx
import type { JSX } from 'preact';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

export interface CaptureBannerProps {
  store: PanelStore;
  onEnable: () => void;
}

/**
 * The three honest capture states of design §5, plus phase 1's fourth.
 *
 * P5's rule is that a capture-off origin gets detect-then-offer, never a dead panel: an empty
 * panel is indistinguishable from a broken one, and the extension ships inert on every
 * non-localhost origin (D3), so that state is the common first impression rather than an edge
 * case. Every branch here therefore says something true about why nothing is on screen.
 *
 * Renders nothing once an imported capture is on screen — the user is looking at data and does
 * not need to be told about a capture layer they are not using — and nothing once live records
 * are flowing, since "idle" is then false.
 */
export function CaptureBanner({ store, onEnable }: CaptureBannerProps): JSX.Element | null {
  const state = usePanelState(store);

  if (state.source.kind === 'imported') {
    return null;
  }

  const capture = state.capture;

  if (capture.kind === 'unsupported') {
    return (
      <div class="agui-banner agui-banner--info" role="status">
        <p class="agui-banner__head">Live capture is not available in this build.</p>
        <p class="agui-banner__body">
          The capture layer lands in a later milestone. Import a <code>.agui.jsonl</code> capture
          from the Session tab to inspect a stream now — that is the same path a shared bug report
          takes, and every tab works against it.
        </p>
      </div>
    );
  }

  if (capture.kind === 'on') {
    if (state.records.length > 0) {
      return null;
    }
    return (
      <div class="agui-banner agui-banner--info" role="status">
        <p class="agui-banner__head">Capture is on for {capture.origin}.</p>
        <p class="agui-banner__body">Waiting for a run — trigger one in the page.</p>
      </div>
    );
  }

  if (capture.aguiDetected) {
    return (
      <div class="agui-banner agui-banner--offer" role="status">
        <p class="agui-banner__head">An event stream was detected on {capture.origin}.</p>
        <p class="agui-banner__body">
          Capture is off for this origin. Enabling it grants access to {capture.origin} and{' '}
          <strong>requires a reload of the inspected page</strong> — the capture hooks install
          before the page&rsquo;s own scripts run, so a stream already in flight cannot be picked
          up.
        </p>
        <button type="button" class="agui-banner__action" onClick={onEnable}>
          Enable capture for {capture.origin}
        </button>
      </div>
    );
  }

  return (
    <div class="agui-banner agui-banner--quiet" role="status">
      <p class="agui-banner__head">No AG-UI stream detected on {capture.origin} yet.</p>
      <p class="agui-banner__body">
        Nothing is wrong — the panel is watching for a <code>text/event-stream</code> response and
        will offer to enable capture when it sees one. You can also import a{' '}
        <code>.agui.jsonl</code> capture from the Session tab.
      </p>
    </div>
  );
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/panel/capture/capture-status.test.tsx`
Expected: `Test Files 1 passed (1) / Tests 7 passed (7)`

- [ ] **Step 15: Commit**

`git commit -m "feat(panel): honest capture-off states with detect-then-offer (P5, design §5)"`

---

#### Cycle 4 — Session

- [ ] **Step 16: Write the failing test**

`packages/devtools/src/panel/tabs/session/session.test.tsx`

```tsx
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Session } from './session';
import { createPanelStore } from '../../model/store';
import { initialPanelState } from '../../model/panel-types';
import { makeIssue } from '../../../core/model/types';

const HAPPY =
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
  '{"kind":"event","connId":"c1","seq":2,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n';

function dropOn(target: HTMLElement, name: string, text: string): void {
  fireEvent.drop(target, {
    dataTransfer: {
      files: {
        item: (i: number) => (i === 0 ? new File([text], name, { type: 'text/plain' }) : null),
      },
    },
  });
}

describe('Session', () => {
  it('says nothing is loaded, and that capture is unavailable in this build', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('nothing loaded yet')).toBeTruthy();
    expect(screen.getByText('unavailable in this build')).toBeTruthy();
  });

  it('names the imported file as the source', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      source: { kind: 'imported', filename: 'bug.agui.jsonl', importedAtMs: 0 },
    });
    render(<Session store={store} />);
    expect(screen.getByText(/bug\.agui\.jsonl \(imported /)).toBeTruthy();
  });

  it('names the live origin as the source', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      source: { kind: 'live', origin: 'http://localhost:3000' },
      capture: { kind: 'on', origin: 'http://localhost:3000' },
    });
    render(<Session store={store} />);
    expect(screen.getByText('live capture from http://localhost:3000')).toBeTruthy();
    expect(screen.getByText('on for http://localhost:3000')).toBeTruthy();
  });

  it('reports undetected framework and endpoints rather than omitting them', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('Framework')).toBeTruthy();
    expect(screen.getByText('Endpoints')).toBeTruthy();
    expect(
      screen.getAllByText(/not detected — detection ships with the capture layer/).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('summarizes issues by severity', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      issues: [
        makeIssue('empty-text-delta', 'a', 1),
        makeIssue('unclosed-message', 'b', 2),
        makeIssue('unbalanced-steps', 'c', 3),
        makeIssue('keepalive-gap', 'd', 4),
      ],
    });
    render(<Session store={store} />);

    const value = (label: string): string =>
      screen.getByText(label).nextElementSibling?.textContent ?? '';
    expect(screen.getByText('Issues (all runs)')).toBeTruthy();
    expect(value('Errors')).toBe('1');
    expect(value('Warnings')).toBe('2');
    expect(value('Info')).toBe('1');
    expect(value('Total')).toBe('4');
  });

  it('states that export is not available rather than offering one', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('not available in phase 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('carries the import control and commits a dropped capture to the store', async () => {
    const store = createPanelStore();
    render(<Session store={store} />);

    dropOn(screen.getByText(/drop a \.agui\.jsonl capture here/i), 'shared.agui.jsonl', HAPPY);

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    expect(store.get().records).toHaveLength(2);
    expect(store.get().loadError).toBeNull();
    expect(screen.getByText(/shared\.agui\.jsonl \(imported /)).toBeTruthy();
  });

  it('records a partial decode in loadError so it survives leaving this tab', async () => {
    const store = createPanelStore();
    render(<Session store={store} />);

    dropOn(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      'partial.agui.jsonl',
      `${HAPPY}{ not json\n`,
    );

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    expect(store.get().loadError).toBe(
      'partial.agui.jsonl: 1 line could not be decoded — this capture is incomplete.',
    );
  });
});
```

- [ ] **Step 17: Run test to verify it fails**

Run: `pnpm vitest run src/panel/tabs/session/session.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./session" from "src/panel/tabs/session/session.test.tsx". Does the file exist?`

- [ ] **Step 18: Write the implementation**

`packages/devtools/src/panel/import/apply-loaded.ts`

```ts
import type { PanelState } from '../model/panel-types';
import type { LoadedCapture } from './load-jsonl';

/**
 * Commit a decoded capture into panel state.
 *
 * Both import entry points (the Session tab's drop zone and the empty-state drop zone in the
 * shell) route through this so they cannot drift apart.
 *
 * `decodeErrors` has no home of its own in `PanelState`, so a partial decode is recorded in
 * `loadError` as a one-line summary. That is deliberate: the alternative is a partially decoded
 * capture that renders exactly like a clean one, which is the trust failure design decision P9
 * rules out for eviction and which applies verbatim here. The drop zone renders the individual
 * lines; this is the part that survives leaving the tab.
 */
export function applyLoaded(
  s: PanelState,
  loaded: LoadedCapture,
  filename: string,
  importedAtMs: number,
): PanelState {
  const bad = loaded.decodeErrors.length;
  return {
    ...s,
    source: { kind: 'imported', filename, importedAtMs },
    runs: loaded.runs,
    records: loaded.records,
    issues: loaded.issues,
    scope: null,
    selectedSeq: null,
    droppedBefore: 0,
    loadError:
      bad === 0
        ? null
        : `${filename}: ${String(bad)} ${bad === 1 ? 'line' : 'lines'} could not be decoded — ` +
          'this capture is incomplete.',
  };
}
```

`packages/devtools/src/panel/tabs/session/session.tsx`

```tsx
import type { JSX } from 'preact';
import type { PanelState, PanelSource, CaptureStatus } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import { issueCounts } from '../../model/selectors';
import { DropZone } from '../../import/drop-zone';
import { applyLoaded } from '../../import/apply-loaded';

function describeSource(source: PanelSource): string {
  switch (source.kind) {
    case 'imported':
      return `${source.filename} (imported ${new Date(source.importedAtMs).toLocaleTimeString()})`;
    case 'live':
      return `live capture from ${source.origin}`;
    case 'empty':
      return 'nothing loaded yet';
  }
}

function describeCapture(capture: CaptureStatus): string {
  switch (capture.kind) {
    case 'unsupported':
      return 'unavailable in this build';
    case 'on':
      return `on for ${capture.origin}`;
    case 'off':
      return capture.aguiDetected
        ? `off for ${capture.origin} — an event stream was detected`
        : `off for ${capture.origin} — nothing detected yet`;
  }
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div class="agui-session__row">
      <dt class="agui-session__label">{label}</dt>
      <dd class="agui-session__value">{value}</dd>
    </div>
  );
}

/**
 * The Session tab: where the data came from, what is known about the page, and the import
 * control.
 *
 * Design §4 lists detected framework, versions, endpoints, transport, runtime mode and `/info`
 * agents here. All of those come from the capture layer, which does not exist yet, so each is
 * reported as "not detected" with the reason rather than omitted — an absent row reads as "there
 * is nothing to know", which is a different and false claim.
 *
 * Design §4 also lists export controls. Phase 1 has no export, so this states that plainly
 * instead of shipping a disabled button that looks like a bug.
 */
export function Session({ store }: { store: PanelStore }): JSX.Element {
  const state: PanelState = usePanelState(store);
  const counts = issueCounts(state);
  const scopeLabel = state.scope === null ? 'all runs' : `run ${state.scope}`;

  return (
    <section class="agui-session" aria-label="Session">
      <h2 class="agui-session__title">Session</h2>

      <h3 class="agui-session__heading">Source</h3>
      <dl class="agui-session__grid">
        <Row label="Data" value={describeSource(state.source)} />
        <Row label="Runs" value={String(state.runs.length)} />
        <Row label="Records" value={String(state.records.length)} />
        <Row
          label="Dropped before"
          value={
            state.droppedBefore === 0
              ? 'none — nothing has been evicted'
              : `${String(state.droppedBefore)} records evicted`
          }
        />
      </dl>

      <h3 class="agui-session__heading">Detected</h3>
      <dl class="agui-session__grid">
        <Row label="Framework" value="not detected — detection ships with the capture layer" />
        <Row label="Endpoints" value="not detected — detection ships with the capture layer" />
        <Row
          label="Transport"
          value={
            state.source.kind === 'imported'
              ? 'as recorded in the imported capture'
              : 'not detected — detection ships with the capture layer'
          }
        />
        <Row label="Agents" value="not detected — /info discovery ships with the capture layer" />
      </dl>

      <h3 class="agui-session__heading">Capture</h3>
      <dl class="agui-session__grid">
        <Row label="Status" value={describeCapture(state.capture)} />
        <Row label="Expand chunks" value={state.expandChunks ? 'on' : 'off'} />
        <Row label="Export" value="not available in phase 1" />
      </dl>

      <h3 class="agui-session__heading">Issues ({scopeLabel})</h3>
      <dl class="agui-session__grid">
        <Row label="Errors" value={String(counts.error)} />
        <Row label="Warnings" value={String(counts.warning)} />
        <Row label="Info" value={String(counts.info)} />
        <Row label="Total" value={String(counts.total)} />
      </dl>

      <h3 class="agui-session__heading">Import</h3>
      <p class="agui-session__note">
        A <code>.agui.jsonl</code> capture loads read-only with every tab working — the shareable
        bug report of requirements §10. Nothing is uploaded; the file is read in this panel.
      </p>
      <DropZone
        store={store}
        onLoaded={(loaded, filename) =>
          store.update((s) => applyLoaded(s, loaded, filename, Date.now()))
        }
      />
    </section>
  );
}
```

- [ ] **Step 19: Run test to verify it passes**

Run: `pnpm vitest run src/panel/tabs/session/session.test.tsx`
Expected: `Test Files 1 passed (1) / Tests 8 passed (8)`

- [ ] **Step 20: Commit**

`git commit -m "feat(panel): Session tab with source, detection, issue summary, and import"`

---

### Task 10: Wire the shell together and verify it visually

**Files:**
- Create: `packages/devtools/src/panel/app.tsx`
- Create: `packages/devtools/scripts/screenshot-panel.mts`
- Modify: `packages/devtools/src/panel/panel.tsx`
- Modify: `packages/devtools/src/panel/panel.css`
- Modify: `packages/devtools/package.json`
- Modify: `packages/devtools/.gitignore` (or the repo root `.gitignore`)
- Test: `packages/devtools/src/panel/app.test.tsx`

---

#### Cycle 1 — App

- [ ] **Step 21: Write the failing test**

`packages/devtools/src/panel/app.test.tsx`

```tsx
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from './app';
import { createPanelStore } from './model/store';
import { initialPanelState } from './model/panel-types';
import type { TabId } from './model/panel-types';

const HAPPY =
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
  '{"kind":"event","connId":"c1","seq":2,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n';

function dropOn(target: HTMLElement, name: string, text: string): void {
  fireEvent.drop(target, {
    dataTransfer: {
      files: {
        item: (i: number) => (i === 0 ? new File([text], name, { type: 'text/plain' }) : null),
      },
    },
  });
}

describe('App', () => {
  it('renders the three shell bands above the tab body', () => {
    render(<App store={createPanelStore()} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('shows the import invitation on Timeline while nothing is loaded', () => {
    render(<App store={createPanelStore()} />);
    expect(screen.getByText(/nothing to inspect yet/i)).toBeTruthy();
    expect(screen.getByText(/drop a \.agui\.jsonl capture here/i)).toBeTruthy();
  });

  it.each<[TabId, RegExp]>([
    ['runs', /Runs — not built yet/],
    ['state', /State — not built yet/],
    ['messages', /Messages — not built yet/],
  ])('names the milestone for the %s placeholder', (tab, heading) => {
    render(<App store={createPanelStore({ ...initialPanelState(), tab })} />);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByText(/milestone 2 of the design §7 sequencing/i)).toBeTruthy();
  });

  it('renders Session on the session tab', () => {
    render(<App store={createPanelStore({ ...initialPanelState(), tab: 'session' })} />);
    expect(screen.getByRole('heading', { name: 'Session' })).toBeTruthy();
  });

  it('surfaces a partial decode persistently, not only inside the drop zone', async () => {
    const store = createPanelStore();
    render(<App store={store} />);

    dropOn(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      'partial.agui.jsonl',
      `${HAPPY}{ not json\n`,
    );

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    // Still visible after leaving the tab the drop zone lived on.
    act(() => {
      store.update((s) => ({ ...s, tab: 'runs' }));
    });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((el) => /1 line could not be decoded/i.test(el.textContent ?? ''))).toBe(
      true,
    );
  });

  it('says why Enable cannot turn capture on in this build', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'off', origin: 'https://app.example', aguiDetected: true },
    });
    render(<App store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(screen.getByText(/capture cannot be enabled in this build/i)).toBeTruthy();
    expect(store.get().tab).toBe('session');
  });

  it('flips the capture offer when the network observer detects an event stream', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'off', origin: 'https://app.example', aguiDetected: false },
    });
    render(<App store={store} />);
    expect(screen.getByText(/no ag-ui stream detected/i)).toBeTruthy();

    const event = chrome.devtools.network.onRequestFinished as unknown as {
      emit: (request: unknown) => void;
    };
    act(() => {
      event.emit({
        response: { content: { mimeType: 'text/event-stream', size: 0 }, headers: [] },
      });
    });

    expect(store.get().capture).toEqual({
      kind: 'off',
      origin: 'https://app.example',
      aguiDetected: true,
    });
    expect(screen.getByRole('button', { name: /enable capture for/i })).toBeTruthy();
  });
});
```

> The last test needs the `chrome` stub in `src/panel/test-setup.ts` to expose an `emit` on
> `devtools.network.onRequestFinished` — that is part of the stub the contract's test-environment
> section already calls for.

- [ ] **Step 22: Run test to verify it fails**

Run: `pnpm vitest run src/panel/app.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./app" from "src/panel/app.test.tsx". Does the file exist?`

- [ ] **Step 23: Write the implementation**

`packages/devtools/src/panel/app.tsx`

```tsx
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PanelStore } from './model/store';
import { selectTab, setCapture } from './model/store';
import { usePanelState } from './model/use-panel-state';
import { applyLoaded } from './import/apply-loaded';
import { DropZone } from './import/drop-zone';
import type { LoadedCapture } from './import/load-jsonl';
import { observeNetwork } from './capture/detect';
import { CaptureBanner } from './capture/capture-status';
import { ScopeBar } from './shell/scope-bar';
import { TabStrip } from './shell/tab-strip';
import { Toolbar } from './shell/toolbar';
import { Timeline } from './tabs/timeline/timeline';
import { Session } from './tabs/session/session';

/** Which milestone of the design's §7 sequencing each unbuilt tab belongs to. */
const COMING_NEXT: Record<'runs' | 'state' | 'messages', string> = {
  runs: 'Runs is milestone 2 of the design §7 sequencing (Runs, then State, then Messages), built against the same imported fixtures as Timeline.',
  state:
    'State is milestone 2 of the design §7 sequencing, after Runs. It renders the reconstructed document with a scrubber over Run.stateTimeline.',
  messages:
    'Messages is milestone 2 of the design §7 sequencing, after State. It renders the conversation as the client would.',
};

function ComingNext({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <section class="agui-coming" aria-label={title}>
      <h2 class="agui-coming__title">{title} — not built yet</h2>
      <p class="agui-coming__detail">{detail}</p>
    </section>
  );
}

/**
 * Resolve the inspected page's origin, so the capture banner can name it.
 *
 * `chrome.devtools.inspectedWindow.eval` runs in the page; reading `location.origin` is the
 * whole of it. There is no `tabs` permission and no fetch — requirements §11.
 *
 * Absent outside DevTools (unit tests, the screenshot harness), in which case capture stays
 * `unsupported` and the banner says so rather than naming a page that is not there.
 */
function resolveOrigin(onOrigin: (origin: string) => void): void {
  const evalFn = chrome.devtools?.inspectedWindow?.eval;
  if (typeof evalFn !== 'function') return;
  chrome.devtools.inspectedWindow.eval('location.origin', (result: unknown) => {
    if (typeof result === 'string' && result !== '' && result !== 'null') onOrigin(result);
  });
}

/**
 * The panel shell: three fixed bands (design §2) over the active tab.
 *
 * Every component reads the store explicitly rather than through context, so each is
 * constructible in a test without this component.
 */
export function App({ store }: { store: PanelStore }): JSX.Element {
  const state = usePanelState(store);
  // Phase 1 has no capture layer, so Enable cannot turn capture on. Saying that when the button
  // is pressed is the honest alternative to a button that silently does nothing.
  const [enableBlocked, setEnableBlocked] = useState(false);

  useEffect(() => {
    resolveOrigin((origin) => {
      store.update((s) =>
        s.capture.kind === 'unsupported'
          ? setCapture(s, { kind: 'off', origin, aguiDetected: false })
          : s,
      );
    });
  }, [store]);

  // P5's weaker detection path. It can say "an event stream finished on this origin" and nothing
  // more, so all it does is flip `aguiDetected` — the offer to enable capture. It never claims
  // the stream is AG-UI and never produces a record.
  useEffect(
    () =>
      observeNetwork(() => {
        store.update((s) =>
          s.capture.kind === 'off' && !s.capture.aguiDetected
            ? setCapture(s, { ...s.capture, aguiDetected: true })
            : s,
        );
      }),
    [store],
  );

  const commit = (loaded: LoadedCapture, filename: string): void => {
    store.update((s) => applyLoaded(s, loaded, filename, Date.now()));
  };

  let body: JSX.Element;
  switch (state.tab) {
    case 'timeline':
      body =
        state.records.length === 0 ? (
          <section class="agui-empty" aria-label="No capture loaded">
            <h2 class="agui-empty__title">Nothing to inspect yet</h2>
            <p class="agui-empty__detail">
              Import a <code>.agui.jsonl</code> capture to inspect a stream. Requirements §10 makes
              this file the shareable bug report: it loads read-only with every tab working.
            </p>
            <DropZone store={store} onLoaded={commit} />
          </section>
        ) : (
          <Timeline store={store} />
        );
      break;
    case 'session':
      body = <Session store={store} />;
      break;
    case 'runs':
      body = <ComingNext title="Runs" detail={COMING_NEXT.runs} />;
      break;
    case 'state':
      body = <ComingNext title="State" detail={COMING_NEXT.state} />;
      break;
    case 'messages':
      body = <ComingNext title="Messages" detail={COMING_NEXT.messages} />;
      break;
  }

  return (
    <div class="agui-app">
      <ScopeBar store={store} />
      <TabStrip store={store} />
      <Toolbar store={store} onImport={() => store.update((s) => selectTab(s, 'session'))} />
      {state.loadError !== null && (
        <p class="agui-app__load-error" role="alert">
          {state.loadError}
        </p>
      )}
      <CaptureBanner
        store={store}
        onEnable={() => {
          setEnableBlocked(true);
          store.update((s) => selectTab(s, 'session'));
        }}
      />
      {enableBlocked && (
        <p class="agui-app__note" role="status">
          Capture cannot be enabled in this build — the capture layer lands in a later milestone.
          Import a <code>.agui.jsonl</code> capture below instead.
        </p>
      )}
      <main class="agui-app__body">{body}</main>
    </div>
  );
}
```

- [ ] **Step 24: Run test to verify it passes**

Run: `pnpm vitest run src/panel/app.test.tsx`
Expected: `Test Files 1 passed (1) / Tests 9 passed (9)`

- [ ] **Step 25: Commit**

`git commit -m "feat(panel): compose the shell, tabs, and honest coming-next placeholders"`

---

#### Cycle 2 — mount point and stylesheet

- [ ] **Step 26: Rewrite the panel entry point**

Replace the whole of `packages/devtools/src/panel/panel.tsx` with:

```tsx
/**
 * Panel UI root.
 *
 * Creates the one store the panel owns and mounts `App` on it. Everything below `App` takes the
 * store as a prop — no context, no module-level singleton reached into from components — which
 * is what lets each component be rendered in a test with a store built for that test.
 */
import { render } from 'preact';

// Without this the panel has no stylesheet at all: the class names below would resolve to
// nothing and the panel would render black-on-dark under the DevTools dark theme.
import './panel.css';

import { App } from './app';
import { createPanelStore } from './model/store';

const store = createPanelStore();
const mountPoint = document.getElementById('root') ?? document.body;
render(<App store={store} />, mountPoint);
```

- [ ] **Step 27: Extend the stylesheet**

In `packages/devtools/src/panel/panel.css`, keep the existing `:root` token blocks, the
`color-scheme` declaration and the `html, body` rules exactly as they are. Delete the three now
dead rules `.agui-panel`, `.agui-panel--empty`, `.agui-panel__title`, `.agui-panel__version` and
`.agui-panel__empty-state` — `panel.tsx` no longer renders those class names. Append:

```css
/* --- Shell tokens ---------------------------------------------------------
 *
 * The base block above defines bg/fg/muted/border. These add the surfaces and the three
 * severity accents the shell needs. Both schemes are stated explicitly — the DevTools theme
 * reaches this document only as `prefers-color-scheme`, so a colour defined in one block and
 * not the other is invisible in the other theme.
 */

:root {
  --agui-surface: #f7f8f9;
  --agui-surface-raised: #ffffff;
  --agui-accent: #0b57d0;
  --agui-accent-bg: #e8f0fe;
  --agui-danger: #b3261e;
  --agui-danger-bg: #fce8e6;
  --agui-warning: #8a5000;
  --agui-warning-bg: #fef4e0;
  --agui-focus: #0b57d0;
}

@media (prefers-color-scheme: dark) {
  :root {
    --agui-surface: #282a2d;
    --agui-surface-raised: #303134;
    --agui-accent: #8ab4f8;
    --agui-accent-bg: #1c2b45;
    --agui-danger: #f28b82;
    --agui-danger-bg: #3a201e;
    --agui-warning: #fdd663;
    --agui-warning-bg: #3a2f16;
    --agui-focus: #8ab4f8;
  }
}

/* --- Shell ---------------------------------------------------------------- */

.agui-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
}

.agui-app__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.agui-app__load-error,
.agui-app__note {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--agui-border);
}

.agui-app__load-error {
  background: var(--agui-danger-bg);
  color: var(--agui-danger);
  font-weight: 600;
}

.agui-app__note {
  background: var(--agui-surface);
  color: var(--agui-fg-muted);
}

/* The scope bar, tab strip and toolbar own their internals; the shell owns only the band. */
.agui-scope-bar,
.agui-tab-strip,
.agui-toolbar {
  flex: 0 0 auto;
  background: var(--agui-surface);
  border-bottom: 1px solid var(--agui-border);
}

/* --- Tab chrome ----------------------------------------------------------- */

.agui-tab-strip {
  display: flex;
  gap: 2px;
  padding: 0 8px;
}

.agui-tab {
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--agui-fg-muted);
  font: inherit;
  padding: 6px 10px;
  cursor: pointer;
}

.agui-tab:hover {
  color: var(--agui-fg);
}

.agui-tab[aria-selected='true'] {
  color: var(--agui-accent);
  border-bottom-color: var(--agui-accent);
}

:where(button, [href], input, [tabindex]):focus-visible {
  outline: 2px solid var(--agui-focus);
  outline-offset: 1px;
}

/* --- Capture banner ------------------------------------------------------- */

.agui-banner {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--agui-border);
  border-left: 3px solid transparent;
  background: var(--agui-surface);
}

.agui-banner--offer {
  background: var(--agui-accent-bg);
  border-left-color: var(--agui-accent);
}

.agui-banner--info {
  background: var(--agui-surface);
  border-left-color: var(--agui-fg-muted);
}

.agui-banner--quiet {
  background: transparent;
  border-left-color: var(--agui-border);
}

.agui-banner__head {
  margin: 0;
  font-weight: 600;
  color: var(--agui-fg);
}

.agui-banner__body {
  margin: 4px 0 0;
  max-width: 78ch;
  color: var(--agui-fg-muted);
}

.agui-banner__action {
  margin-top: 8px;
  padding: 4px 10px;
  font: inherit;
  color: var(--agui-bg);
  background: var(--agui-accent);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}

/* --- Import --------------------------------------------------------------- */

.agui-drop {
  margin-top: 8px;
}

.agui-drop__target {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px;
  border: 1px dashed var(--agui-border);
  border-radius: 6px;
  background: var(--agui-surface);
  text-align: center;
}

.agui-drop__target--over {
  border-color: var(--agui-accent);
  background: var(--agui-accent-bg);
}

.agui-drop__hint {
  margin: 0;
  color: var(--agui-fg-muted);
}

.agui-drop__pick {
  padding: 4px 10px;
  font: inherit;
  color: var(--agui-fg);
  background: var(--agui-surface-raised);
  border: 1px solid var(--agui-border);
  border-radius: 4px;
  cursor: pointer;
}

/* Visually hidden rather than display:none: the picker is opened programmatically, but the
 * input must stay in the accessibility tree so it keeps its label. */
.agui-drop__input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.agui-drop__error,
.agui-drop__partial {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-left: 3px solid var(--agui-danger);
  background: var(--agui-danger-bg);
  color: var(--agui-danger);
  border-radius: 0 4px 4px 0;
}

.agui-drop__partial-head {
  margin: 0;
  font-weight: 600;
}

.agui-drop__partial-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.agui-drop__ok {
  margin: 8px 0 0;
  color: var(--agui-fg-muted);
}

/* --- Session -------------------------------------------------------------- */

.agui-session {
  max-width: 92ch;
}

.agui-session__title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
}

.agui-session__heading {
  margin: 16px 0 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--agui-fg-muted);
}

.agui-session__grid {
  margin: 0;
  border: 1px solid var(--agui-border);
  border-radius: 6px;
  background: var(--agui-surface-raised);
  overflow: hidden;
}

.agui-session__row {
  display: grid;
  grid-template-columns: minmax(8rem, 14rem) 1fr;
  gap: 8px;
  padding: 5px 10px;
  border-top: 1px solid var(--agui-border);
}

.agui-session__row:first-child {
  border-top: 0;
}

.agui-session__label {
  margin: 0;
  color: var(--agui-fg-muted);
}

.agui-session__value {
  margin: 0;
  color: var(--agui-fg);
  overflow-wrap: anywhere;
}

.agui-session__note {
  margin: 0;
  max-width: 78ch;
  color: var(--agui-fg-muted);
}

/* --- Empty and not-yet-built states --------------------------------------- */

.agui-empty,
.agui-coming {
  max-width: 78ch;
  padding: 8px 0;
}

.agui-empty__title,
.agui-coming__title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--agui-fg);
}

.agui-empty__detail,
.agui-coming__detail {
  margin: 0;
  color: var(--agui-fg-muted);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.95em;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--agui-surface);
  color: var(--agui-fg);
}
```

> The `~600px` breakpoint of P4 appears nowhere in this stylesheet on purpose: the contract makes
> `NARROW_BREAKPOINT_PX` in `src/panel/common/layout.ts` the single home for it, and a CSS media
> query cannot read a custom property. Timeline applies it in JS.

- [ ] **Step 28: Add the headless screenshot gate**

Create `packages/devtools/scripts/screenshot-panel.mts`:

```ts
/**
 * Screenshot the built panel in both colour schemes, and fail if it is unstyled.
 *
 * WHY THIS EXISTS. The previous milestone shipped a `dist/` whose panel had NO STYLESHEET at
 * all. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm verify:build` all
 * passed on it, because none of them renders anything: the panel document is isolated and
 * inherits nothing, so with no CSS it rendered as UA defaults — black text on a transparent
 * background, invisible under the DevTools dark theme. A human loading the extension and
 * looking at it was the only gate that caught it. This script is that gate, automated.
 *
 * It serves `dist/` over a local static server (ES modules will not load over `file://`),
 * installs a small `chrome` shim so the panel bundle runs outside DevTools, loads
 * `src/panel/panel.html` once per colour scheme, asserts the page is actually painted, and
 * writes a PNG per scheme.
 *
 * Run: `pnpm build && pnpm screenshot:panel` (first run also needs
 * `pnpm exec playwright install chromium`).
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.PANEL_DIST ?? join(packageRoot, 'dist');
const outDir = join(packageRoot, '.screenshots');
const panelPath = 'src/panel/panel.html';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Enough of `chrome` for the panel bundle to boot outside DevTools. Deliberately minimal: the
 * point is to render the panel's own markup, not to simulate Chrome. `devtools` is left absent
 * so the detection and origin paths take their documented no-DevTools branch.
 */
const CHROME_SHIM = `
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.0.0-screenshot' }) },
  };
`;

function startServer(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      ready({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const failures: string[] = [];

async function main(): Promise<void> {
  if (!existsSync(join(distDir, panelPath))) {
    console.error(`FAIL: ${join(distDir, panelPath)} does not exist. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  // Diagnostic only. Whether a stylesheet reaches the document is decided by the computed
  // styles below, not by grepping the HTML — the CSS may arrive by link, by inline <style>, or
  // through the module graph, and only the browser knows which of those actually worked.
  const html = readFileSync(join(distDir, panelPath), 'utf8');
  const htmlMentionsCss = /<link[^>]+stylesheet/i.test(html) || /<style/i.test(html);

  mkdirSync(outDir, { recursive: true });
  const server = await startServer(distDir);
  const browser = await chromium.launch();

  const painted: Record<string, string> = {};
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 900, height: 700 },
        deviceScaleFactor: 2,
      });
      await context.addInitScript(CHROME_SHIM);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => consoleErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await page.goto(`${server.origin}/${panelPath}`, { waitUntil: 'networkidle' });

      const probe = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        return {
          background: body.backgroundColor,
          color: body.color,
          text: (document.body.innerText || '').trim().length,
          height: document.body.getBoundingClientRect().height,
        };
      });

      await page.screenshot({ path: join(outDir, `panel-${scheme}.png`), fullPage: true });

      if (consoleErrors.length > 0) {
        failures.push(`panel logged errors in ${scheme} scheme: ${consoleErrors.join(' | ')}`);
      }
      // Transparent body means no stylesheet reached the document.
      if (probe.background === 'rgba(0, 0, 0, 0)' || probe.background === 'transparent') {
        failures.push(
          `body has no background colour in ${scheme} scheme — the panel is unstyled, which is ` +
            'invisible under the DevTools dark theme. ' +
            (htmlMentionsCss
              ? `dist/${panelPath} does reference a stylesheet, so it failed to load.`
              : `dist/${panelPath} references no stylesheet at all.`),
        );
      }
      if (probe.text < 20) {
        failures.push(`panel rendered ${String(probe.text)} characters in ${scheme} scheme.`);
      }
      if (probe.height < 100) {
        failures.push(`panel body is ${String(probe.height)}px tall in ${scheme} scheme.`);
      }
      painted[scheme] = `${probe.background} / ${probe.color}`;
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }

  // A theme-blind panel passes every check above while ignoring the DevTools theme entirely.
  if (painted.light === painted.dark) {
    failures.push(
      `light and dark render identically (${String(painted.light)}). The panel is not ` +
        'responding to prefers-color-scheme, which is how Chrome propagates the DevTools theme.',
    );
  }

  if (failures.length > 0) {
    console.error(`FAIL: ${String(failures.length)} visual invariant(s) violated:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }

  console.log(`panel renders in both schemes:`);
  for (const [scheme, colours] of Object.entries(painted)) {
    console.log(`  ${scheme}: body ${colours} — ${join(outDir, `panel-${scheme}.png`)}`);
  }
}

await main();
```

In `packages/devtools/package.json`, add the script and the devDependency:

```json
"screenshot:panel": "tsx scripts/screenshot-panel.mts"
```

```json
"playwright": "^1.56.0"
```

Add `.screenshots/` to `.gitignore` — the PNGs are review artifacts, not source.

- [ ] **Step 29: Commit**

`git commit -m "feat(panel): mount App, extend the stylesheet, add the headless visual gate"`

---

#### Verification

These are commands with expected output, not tests. Run them from the repo root unless noted.

- [ ] **Step 30: `pnpm typecheck`**

Expected: exits 0 with no diagnostics. This typechecks test files too, so a `noUncheckedIndexedAccess`
violation in a `.test.tsx` fails here.

- [ ] **Step 31: `pnpm lint`**

Expected: exits 0 with no output. Note that `src/panel/**` is outside the `core/` fence, so the
`chrome` and DOM references in `detect.ts` and `app.tsx` are allowed; if ESLint reports
`no-restricted-globals` for `chrome` here, a file has been placed under `src/core/` by mistake.

- [ ] **Step 32: `pnpm test`**

Expected: both Vitest projects run — `core` in `node`, `panel` in `jsdom` — and every test passes.
The panel project should report at least the 35 tests added by Tasks 9 and 10
(5 + 6 + 7 + 8 + 9), on top of whatever earlier panel tasks contributed.

- [ ] **Step 33: `pnpm build`**

Expected: exits 0. Confirm the CSS became a real asset rather than being tree-shaken away:

```
ls packages/devtools/dist/assets/*.css
grep -o 'href="[^"]*\.css"' packages/devtools/dist/src/panel/panel.html
```

Expected: at least one `.css` file, and a `href="…css"` in the emitted panel HTML.

- [ ] **Step 34: `pnpm verify:build`**

Expected: `build output invariants OK`. This is the entry-chunk-identity and manifest-privacy
gate; it also asserts `dist/src/panel/panel.html` exists, which the screenshot step then loads.

- [ ] **Step 35: Headless visual check — NOT OPTIONAL**

```
pnpm --filter ag-ui-devtools exec playwright install chromium   # first run only
pnpm --filter ag-ui-devtools screenshot:panel
```

Expected, on success:

```
panel renders in both schemes:
  light: body rgb(255, 255, 255) / rgb(31, 31, 31) — …/packages/devtools/.screenshots/panel-light.png
  dark: body rgb(31, 31, 31) / rgb(232, 234, 237) — …/packages/devtools/.screenshots/panel-dark.png
```

Then **open both PNGs and look at them.** Confirm: the tab strip is visible with Timeline
selected; the capture banner reads "Live capture is not available in this build."; the drop
target is visible with its "Choose file" button; and every string is legible against its
background in both images.

Why this step exists, and why it cannot be skipped: **the previous milestone shipped a panel with
no stylesheet at all.** Typecheck, lint, tests, build and `verify:build` all passed on that
artifact, because not one of them renders anything — the panel document is isolated and inherits
nothing from DevTools, so with no CSS it was black text on a transparent background, invisible
under the dark theme. A screenshot was the only thing that caught it. The script above encodes
exactly that check: on an unstyled `dist/` it fails with

```
FAIL: 5 visual invariant(s) violated:

  - body has no background colour in light scheme — the panel is unstyled, which is invisible under the DevTools dark theme. dist/src/panel/panel.html references no stylesheet at all.
  - panel body is 76.4375px tall in light scheme.
  - body has no background colour in dark scheme — …
  - panel body is 76.4375px tall in dark scheme.
  - light and dark render identically (rgba(0, 0, 0, 0) / rgb(0, 0, 0)). The panel is not responding to prefers-color-scheme, which is how Chrome propagates the DevTools theme.
```

- [ ] **Step 36: MANUAL — load `dist/` unpacked in Chrome**

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   `packages/devtools/dist`.
2. Open any page, open DevTools, select the **AG-UI** panel.
3. Confirm, with the DevTools theme set to **light** and then to **dark**:
   - the panel opens with **no console errors** in the DevTools-on-DevTools console;
   - the scope bar, tab strip and toolbar are all visible;
   - the capture banner names the inspected origin — with a real page open this reaches the
     `{ kind: 'off', origin }` branch, so it should read "No AG-UI stream detected on
     `<origin>` yet.", not "Live capture is not available in this build.";
   - clicking **Runs**, **State** and **Messages** shows the "not built yet" placeholder naming
     milestone 2, and clicking **Session** shows the Session tab;
   - dragging one of `src/test/fixtures/happy-run.agui.jsonl` or
     `src/test/fixtures/malformed.agui.jsonl` onto the drop target loads it — `malformed`
     must show the undecodable-line alert and a non-zero issue summary, `happy-run` must show
     "every line decoded".
4. Confirm privacy (requirements §11): in the DevTools **Network** tab of the DevTools-on-DevTools
   window, the panel issues **no requests of its own**, and nothing is written to disk.

- [ ] **Step 37: Commit**

`git commit --allow-empty -m "chore(panel): record verification of the phase 1 panel shell"`

---

## Contract gaps

1. **No subscription hook.** Every component in the contract takes `store: PanelStore`, but
   nothing in the contract lets a component re-render when the store changes. Task 9 adds
   `src/panel/model/use-panel-state.ts` exporting `usePanelState(store): PanelState`. It is
   deliberately trivial (`useState` + `useEffect` over `PanelStore.subscribe`) rather than
   `useSyncExternalStore`, which lives in `preact/compat`. **Other plan sections need the same
   thing** — if two sections both create this file, keep one copy; the name and signature above
   are the proposal.

2. **`PanelState` has nowhere to put `decodeErrors`.** `LoadedCapture.decodeErrors` is specified
   and the requirement that a partial decode never look clean is explicit, but `PanelState`
   carries only `loadError: string | null`, described as "set when a load fails". Resolution
   used here: `DropZone` holds the individual lines in local state and renders them; the new
   `src/panel/import/apply-loaded.ts` writes a one-line summary into `loadError` so the warning
   survives leaving the tab. **Recommended for the next contract revision:**
   `decodeErrors: string[]` on `PanelState`, cleared on each load, with `loadError` returning to
   meaning only "the load failed".

3. **No action commits a successful load.** `store.ts` exports `loadFailed` but no counterpart
   for the success path, so nothing in the contract turns a `LoadedCapture` into a `PanelState`.
   Task 9 adds `applyLoaded(state, loaded, filename, importedAtMs): PanelState` in
   `src/panel/import/apply-loaded.ts` rather than extending `store.ts`, which another section
   owns. If a future revision folds it into `store.ts` as `loadSucceeded`, the body moves
   unchanged.

4. **`DropZone`'s `onLoaded` signature is unspecified.** The contract names the prop but not its
   parameters. Used here: `onLoaded(loaded: LoadedCapture, filename: string): void`. The filename
   is a second parameter rather than a field on `LoadedCapture` because `LoadedCapture` is the
   decoder's output and knows nothing about where the bytes came from.

5. **`CaptureStatus` cannot express "the user asked to enable capture and this build cannot".**
   Phase 1 has no capture layer, so `CaptureBanner`'s Enable button — required by design §5 —
   has nothing to call. `App` keeps a local `enableBlocked` flag and renders a note saying so.
   When the capture layer lands this should become a real state (an `off` variant carrying a
   pending permission request, or a fourth `kind`), not a component-local boolean.

6. **Nothing owns the inspected origin.** `CaptureStatus`'s `off`/`on` variants carry an
   `origin`, but the contract says nothing about who resolves it. `App` does, via
   `chrome.devtools.inspectedWindow.eval('location.origin')`, and leaves capture `unsupported`
   when the DevTools APIs are absent. It does not re-resolve on navigation —
   `chrome.devtools.network.onNavigated` is the hook for that when the capture layer lands.

7. **`observeNetwork` has no re-arm.** The contract's signature returns a plain unsubscribe, so
   the implementation latches after the first detection; re-arming means unsubscribe and
   resubscribe. That is the correct behaviour on navigation, but nothing in phase 1 does it.

8. **`panel.css` has no per-section ownership.** Several plan sections extend one stylesheet.
   Task 10's block is namespaced (`.agui-app`, `.agui-tab*`, `.agui-banner*`, `.agui-drop*`,
   `.agui-session*`, `.agui-empty*`, `.agui-coming*`) and adds tokens by appending a second
   `:root` block rather than editing the first, so sections compose by concatenation. Only the
   deletion of the dead `.agui-panel*` rules in Step 27 touches existing text.

9. **`test-setup.ts`'s `chrome` stub needs an emitter.** The contract says the stub installs
   `devtools.network`, but Task 10's App test drives detection through it, which requires the
   fake `onRequestFinished` to expose a way to fire listeners. The stub should give each event
   `addListener`, `removeListener` and an `emit`.

10. **Playwright becomes a devDependency.** The headless visual check needs a real browser
    engine. This is a dev-time tool only — it is not bundled, adds no runtime dependency, and
    does not weaken the "one runtime dependency" posture or requirements §11 (the served pages
    are local files on an ephemeral loopback port).

---
---

# Appendix — cross-section resolutions

Each task section was authored against a locked contract and independently verified by execution.
Where sections disagreed, the conflict is resolved here and the resolution is already applied to the
task text above. Per-section `## Contract gaps` notes are preserved as authored.

| # | Conflict or gap | Resolution |
|---|---|---|
| R1 | **Four sections independently invented the same missing subscription hook.** Components take `store` explicitly and the contract gave them no way to re-render. D and E created `model/use-panel-state.ts`; F created `model/use-store.ts` | One file: **`src/panel/model/use-panel-state.ts`** exporting `usePanelState(store): PanelState`, created in Task 2 and imported everywhere after. F's references were renamed at assembly. The contract should have named it. |
| R2 | **The `core` Vitest project glob drops 5 tests.** The contract's literal `src/core/**/*.test.ts` excludes `src/test/integration.test.ts` — measured 350 vs the 355 on `main` | Widen to `['src/core/**/*.test.ts', 'src/test/**/*.test.ts']`. Caught only because A ran the config against the real repo instead of trusting it. |
| R3 | `initialPanelState().capture` was unspecified | `{ kind: 'unsupported' }` — phase 1 ships no capture layer. Pinned by a test. |
| R4 | **`CaptureRecord.issues` is always empty on the import path.** The run builder attaches issues to the *run*, and `loadJsonl` returns the records it fed in | `issuesBySeq` is the **only** authoritative source for row annotation and `issuesOnly` filtering. A component rendering from `record.issues` would silently show nothing. Stated in Task 3 and honoured in Task 7. |
| R5 | "Serialized record" was ambiguous for the text filter | The filter matches the **event payload** (or `keepalive <comment>`), not `JSON.stringify(record)` — otherwise typing `5` matches every record with a 5 in its timestamp. |
| R6 | `decodeErrors` had no home in `PanelState`; no action committed a successful load | **CORRECTED during execution.** This row originally called for `PanelState.decodeErrors: string[]` and for `applyLoaded` to live in `store.ts` (Task 2). Both are wrong. `applyLoaded` imports `LoadedCapture` from `load-jsonl`, which Task 4 creates — writing it in Task 2 fails `typecheck` outright, or forces a duplicate type declaration. And the plan body already solves the visibility requirement without a new field: `DropZone` shows the failing lines at import time, and `applyLoaded` writes a one-line summary into `loadError` so the incompleteness survives leaving the tab. A `decodeErrors` field would be dead on arrival, since every specified consumer reads `loadError`. **Resolution: `applyLoaded` stays in `src/panel/import/apply-loaded.ts` (Task 9); no `decodeErrors` field is added.** The requirement — a partially-decoded file must never look clean — is met either way. |
| R7 | Pure-logic tests under `src/panel/**` would run in jsdom | `// @vitest-environment node` docblock per file. Verified honoured by Vitest 4. |
| R8 | `VirtualListProps.overscan` had no default; `follow` ownership was unspecified | Default `4`. `VirtualList` owns pinned-ness internally — `follow` is a capability switch, not a live pinned flag — so the store needs no field. |
| R9 | **Design §3 says hovering a waterfall bar highlights the corresponding events. Delivered as click, not hover** | Cross-component highlighting needs a `hoveredSeqs` field in `PanelState`, and writing hover into the store on every mousemove re-renders the panel. Hover applies local emphasis to the bar; **clicking** calls `selectSeq`, which the list already reacts to. This is a deliberate partial delivery of the design — recorded, not hidden. |
| R10 | `EventList` needs a viewport height `VirtualList` does not derive | Measures its container with `ResizeObserver`, falling back to 480px. jsdom has neither, hence the fallback. |
| R11 | Reading fixtures in jsdom throws `ENOENT` with the `readFileSync(new URL(...))` pattern `integration.test.ts` uses | Panel tests use Vite's `?raw` import. Any future jsdom test touching fixtures needs the same. |
| R12 | Compound rows produced accessible names with no separators (`1RUN_STARTEDr_bad`), breaking `getByRole({ name })` | Rows and bars carry an explicit `aria-label`. Applies to `EventList` rows, waterfall bars, and `RunSelector` rows. |
| R13 | **`VirtualList` rendered zero rows whenever `items` shrank under a scrolled viewport.** `scrollTop` is state and `count` is a prop, so the shrink render used a scroll position the shorter list no longer had; `windowRange` clamped `start` to `count` and returned an empty range. `follow: true` masked it — the follow effect re-pins first — which is why every shrink test in the original suite missed it | `VirtualList` clamps at the point of use: `Math.min(scrollTop, maxScrollTop)` feeds `windowRange`. Three `follow: false` shrink tests pin it. **Task 7 depends on this**: filtering a scrolled 10k list is a shrink, and the pre-fix symptom is an empty event list, which reads as data loss rather than a layout bug. |

## Carried forward from the Task 5 implementation

- **`VirtualList`'s `scrollToIndex` effect keys only on `scrollToIndex`, so requesting the same
  index twice does not re-scroll.** That is deliberate — appends must not re-trigger a stale scroll
  request — but it means a user who scrolls away and clicks the *same* row again gets no scroll.
  **Tasks 7 and 8 need a nonce or an imperative handle** if re-scroll-to-same-index is wanted, which
  for a click-to-locate interaction it probably is.
- ~~`summarizeEvent` can end in a lone UTF-16 surrogate when a structured payload's collapsed JSON
  lands at exactly the 80-char cap.~~ **FIXED, and the original note was under-scoped.** It read as
  a JSON-branch-only quirk; it was not. `summarizeEvent` pre-sliced at *three* sites — the `id` part,
  the `name` part, and the JSON value — and each one cuts blind at 80 UTF-16 units. When a part
  lands on exactly 80, the joined text is exactly 80, `truncate` returns early on
  `text.length <= max`, and its surrogate repair never runs. A sweep of emoji offsets 0–120 across
  six payload shapes found 8 failures in those three branches (`id` and `name` at n=77,79; the two
  JSON shapes at their own offsets) — the `id`/`name` cases being exactly what an
  "it's just the JSON branch" note would have let someone rediscover as a mystery.
  All three sites now go through a `sliceUnits` helper that refuses to cut a pair in half.
  The **string** branch is genuinely safe and deliberately left alone: its quotes push a
  full-length part to 82 units, past the cap and into `truncate`'s own repair. The offset sweep
  in `format.test.ts` covers it anyway, and asserts on the whole string rather than just its
  end, since a part sliced mid-pair strands a surrogate in the *middle* of the row.

## Carried forward from the Task 1–4 review

Both confirmed empirically against real fixtures. Neither is a defect; both will be visible in
tasks that have not been built yet, so they are recorded where those tasks will find them.

- **Filter changes deliberately do NOT clear `selectedSeq`.** `selectScope` guards the selection
  against falling outside the new scope, but `setTextFilter` and `toggleIssuesOnly` do not — so
  `selectedRecord()` can return a record that `visibleRecords()` no longer contains. That is the
  right trade (losing your selection mid-keystroke is worse than a stale detail pane), but **Task 7's
  detail pane must tolerate a selected-but-filtered-out record** rather than assuming the selection
  is always visible in the list.
- **The issue badge and the event list can legitimately disagree, by exactly the keepalive count.**
  A `keepalive-gap` issue carries a `runId`, so under a run scope it counts toward
  `issueCounts().total`, while `visibleRecords()` can never show its row — keepalives never enter
  `Run.recordSeqs`. Measured: with a >15s gap and `issuesOnly` on, the badge reads 2 and the list
  shows 1. **Task 6 must not present the badge as a count of visible rows.** This is plan open item
  4 surfacing early; it becomes common once capture lands.

## Deferred deliberately, with reasons

- **Record/pause and preserve-on-navigate render as disabled controls** with `aria-pressed` and a title explaining they activate with capture. They have nothing to control in phase 1; shipping them live would be a lie.
- **Export is omitted, not stubbed.** Design §2 lists it in the toolbar; phase 1 has no export, and a dead button is worse than an absent one. Session states its absence in words.
- **`VirtualListProps.follow` is never set by `EventList`** — there is no live/tailing flag in `PanelState` to drive it. P6 is implemented in the primitive and wired when capture lands.
- **P9's dropped-event count renders only when `droppedBefore > 0`**, which is never in phase 1. The field exists now so the UI needs no retrofit.

## Open items for the capture-layer plan

1. `CaptureStatus` cannot express "enable requested, unavailable in this build" — handled with a component-local flag in `App`; should become a real state.
2. Nothing owns the inspected origin across navigation. `App` resolves it once via `inspectedWindow.eval`.
3. `observeNetwork` latches after one detection and detaches. Re-arming needs a contract change.
4. **Keepalives are only visible under "all runs"**, because scoping goes through `Run.recordSeqs` and keepalives deliberately never enter it. A `keepalive-gap` issue is therefore scoped to a run whose record list cannot show the keepalive it anchors to. Worth resolving when capture makes keepalives common.
5. `loadJsonl` drops the `header` line, which carries framework, transport, URL, and `redacted[]` — everything Session is specified to show for an imported capture. Session currently reports provenance it can actually see.

## Definition of done

- [ ] `pnpm typecheck`, `pnpm lint` clean
- [ ] `pnpm test` green, with the `core` project still at its full pre-existing count
- [ ] `pnpm build` and `pnpm verify:build` pass
- [ ] Dragging `happy-run.agui.jsonl` onto the panel populates the shell, Timeline, and Session
- [ ] `malformed.agui.jsonl` shows exactly three inline issues, and the toolbar badge filters to them
- [ ] The panel is legible in both colour schemes, verified by screenshot — the previous milestone shipped a panel with no stylesheet at all, which every automated gate passed and only a screenshot caught
- [ ] Loading `dist/` unpacked in Chrome opens the panel with no console errors
