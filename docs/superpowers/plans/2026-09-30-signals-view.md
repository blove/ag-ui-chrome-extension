# Signals view (§14.3) — Implementation Plans

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Threadplane apps in development report, per event, which agent signals the event wrote; the extension shows it as a Signals tab.

**Design:** [`2026-09-30-signals-view-design.md`](../specs/2026-09-30-signals-view-design.md) G1–G8. Two plans: **Part A** (this repo, PR first) and **Part B** (Threadplane, its own PR, user-reviewed).

**Shared contract** (both parts code against this; keep a copy as a test fixture on both sides):

```ts
// CustomEvent 'threadplane:devtools' on window, detail:
interface ThreadplaneDevtoolsReport {
  v: 1;
  agent: string;              // random per agent instance, ≤ 64 chars
  adapter: 'langgraph' | 'ag-ui';
  seq: number;                // per agent, starts at 1
  eventType: string;          // protocol event name or pseudo-event label, ≤ 128 chars
  wrote: string[];            // distinct names from the adapter's vocabulary (G4), in write order, 1..32
  tMs: number;                // performance.now()
}
```

LangGraph vocabulary: `status values messages error interrupt interrupts branch history isThreadLoading toolProgress toolCalls messageMetadata subagents queue custom`. AG-UI vocabulary: `messages status isLoading error toolCalls state interrupt customEvents activities interruptSession`. Pseudo-event labels: `run:start run:end history reset submit queue branch`.

---

## Part A — the extension (`packages/devtools`, `packages/harness`)

Conventions as before (colocated tests, TDD, absent-not-undefined, comments explain why, no path headers, commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

### A1: the contract and its validator (core)
- [ ] `src/core/signals/report.ts`: the type, the two vocabularies, `isThreadplaneReport(value: unknown): value is ThreadplaneDevtoolsReport` (own-property-strict, exact key set, types, limits, vocabulary per adapter, `wrote` distinct and non-empty), `cloneReport` (field-by-field copy). Tests: valid reports for both adapters; every rejection (extra key, inherited key, wrong type, unknown adapter, name outside its adapter's vocabulary, 129-char eventType, 33 names, duplicates, NaN seq/tMs, `__proto__`).
- [ ] Commit `feat(signals): the Threadplane devtools report contract (G2, G4)`.

### A2: capture → relay → worker
- [ ] `inject/`: a listener for `threadplane:devtools` on `window` (installed with the other patches; only in the top frame and frames the capture runs in), validating with `isThreadplaneReport` and posting `{ source, v, kind: 'signals', report }` (a new `InjectMessage` arm; extend `isInjectMessage`). Never throw into the page's dispatch.
- [ ] `relay/relay.ts`: rebuild the arm with `cloneReport`; hostile-input tests like the existing ones.
- [ ] `sw/`: per-tab bounded ring (e.g. 5,000 reports, eviction counted) cleared with the tab's buffer; included in `snapshot` and `append` messages to the panel (extend `SwMessage`); the test hook exposes them.
- [ ] Tests at each layer, plus an e2e (`packages/harness`): a page that dispatches valid and hostile synthetic reports → only the valid ones reach the worker, in order.
- [ ] Commit(s) `feat(signals): capture Threadplane devtools reports (G3, G5)`.

### A3: the Signals tab
- [ ] `PanelState.signals` (from live session snapshot/append; empty for imports — G8); `src/panel/tabs/signals/` — the matrix (G6): per agent instance a block; rows = vocabulary names seen (fixed vocabulary order); columns = reports by `seq`; header = `eventType`; lit cells; virtualise columns if > 500 (reuse `common/virtual-list` if it supports horizontal, else cap with a "showing the last N events" note).
- [ ] Frame matching (pure, `src/core/signals/match.ts`): for a report, the wire record it most likely came from — same event name (LangGraph: `sseEvent`; AG-UI: `event.type`) and order within the window, falling back to nearest `tMs`. Verify the clocks: check what `now()` the inject uses for frame `tMs` and use the same in the matcher; document it. Clicking a column selects that record in Timeline (`selectedSeq`).
- [ ] Empty state (G7). The tab appears in the tab bar always (consistent with others).
- [ ] Tests: matrix rendering, empty state wording without fault words, matching (exact, by order, by time, none).
- [ ] Visual gate: a `checkSignals` block that injects a snapshot with reports through the panel's test hook or store (whichever the gate already uses for live data — read `scripts/screenshot-panel.mts`/`panel-harness.ts`) and asserts lit cells and a click selecting a Timeline row; screenshot `signals.png`.
- [ ] Commit `feat(panel): the Signals tab (G6, G7)`.

### A4: docs, gates, PR
- [ ] README Status line; spec §14.3 "Built (extension side); Threadplane hook in cacheplane/threadplane#<n>"; PRIVACY.md one sentence (the panel shows which signals a Threadplane dev app reported writing — names only).
- [ ] Mutations: relay forwards an un-cloned report → hostile test fails; validator accepts a name outside the vocabulary → test fails; matcher ignores event names → matching test fails.
- [ ] Gates: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e`. Push, PR, auto-merge (squash).

---

## Part B — Threadplane (`~/repos/angular-agent-framework`, worktree on a new branch; PR to cacheplane/threadplane, NOT auto-merged)

Follow that repo's conventions (read its CONTRIBUTING / CLAUDE.md / AGENTS.md if present, its lint and test setup: Nx + Vitest). Work in a git worktree (`git -C ~/repos/angular-agent-framework worktree add …`) — never touch the user's main checkout, which has untracked files.

### B1: the emitter (`libs/chat`)
- [ ] `libs/chat/src/lib/devtools/devtools-emitter.ts` (export from the package's public API under an `ɵ` name, matching the repo's private-export precedent, e.g. `ɵcreateDevtoolsEmitter`): `createDevtoolsEmitter(adapter): Emitter | null` returning `null` unless the G1 gate passes; `Emitter = { begin(eventType: string): void; wrote(name: string): void; end(): void; outside(label: string, run: () => void): void }` — `begin/end` bracket an event, `wrote` records a name (deduped, ordered), `end` dispatches the report (G3) if any name was written, increments `seq`; `outside(label, fn)` brackets non-event writes under a pseudo-event label. Agent id via `crypto.randomUUID()` (fallback counter). Never throws (wrap dispatch in try/catch).
- [ ] Tests: report shape; dedupe/order; no dispatch with zero names; gate off (`isDevMode` false / `ngDevMode` false / opt-out flag) → `null`; dispatch errors swallowed.

### B2: LangGraph instrumentation
- [ ] In `agent.fn.ts`, when an emitter exists, wrap each subject in the bag so `.next` calls `emitter.wrote('<name>')` before delegating (no value read); in `stream-manager.bridge.ts`, bracket `processEvent` with `begin(event.type)` / `end()` and the run-start, run-end, history-refresh, queue, reset paths with `outside(label, …)`.
- [ ] Tests (MockAgentTransport): a `messages` tuple event reports `['messages', 'messageMetadata', 'subagents', 'toolCalls']` (assert against what the code actually writes — read processEvent); a root `values` reports `values`/`messages`/…; an `error` reports `error`/`status`; `submit` reports `run:start` with `status`…; the emitter is never created in production mode; **no value is read** — use a test where the subject values are objects with throwing getters, or spy that the wrapper never touches its argument.

### B3: AG-UI instrumentation
- [ ] In `to-agent.ts`, when an emitter exists, wrap each store `WritableSignal`'s `set`/`update` to call `wrote('<field>')`; bracket `reduceEvent` calls in `onEvent` with `begin(event.type)`/`end()`; `outside` for submit/stop/reset/hydrate/failRun.
- [ ] Tests (FakeAgent script): `TEXT_MESSAGE_CONTENT` → `['messages']`; `RUN_STARTED` → `status, isLoading, error, interrupt, customEvents, activities` (as the reducer writes); `STATE_DELTA` → `state, messages`; production mode → no events.

### B4: production stripping, docs, PR
- [ ] A bundle check in the spirit of `libs/telemetry/scripts/verify-development-bundle.mjs`: build/esbuild a consumer entry with `ngDevMode=false` and assert the string `threadplane:devtools` is absent; wire it where that repo runs similar checks (CI) if straightforward.
- [ ] Docs: a short section in the langgraph and ag-ui READMEs (or the docs site page on testing/devtools) — what the hook reports (names and timing only), dev-only, the opt-out flag, and the AG-UI DevTools extension link.
- [ ] Full Threadplane checks for the touched libs (lint, test, build — find the Nx targets).
- [ ] Push the branch, open a PR to cacheplane/threadplane (body: the contract, privacy model, tests). **Do not enable auto-merge** — the user reviews it.
- [ ] Acceptance: with the built extension (Part A) loaded in a browser, run a Threadplane example app in dev against a LangGraph backend if one is runnable locally (see that repo's examples/cockpit) and confirm the Signals tab populates; if a backend isn't available, run the Threadplane test that dispatches real reports and replay them into the extension's harness page. Record what was done in the extension spec.
