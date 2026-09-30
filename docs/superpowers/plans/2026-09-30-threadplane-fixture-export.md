# Threadplane Fixture Export (§14.2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click in the Export panel turns a captured LangGraph run into a ready-to-run `@threadplane/langgraph` spec that replays the capture through `MockAgentTransport` and passes — one edit away from a failing regression test.

**Architecture:** Spec [`2026-09-30-threadplane-fixture-export-design.md`](../specs/2026-09-30-threadplane-fixture-export-design.md) T1–T7. A pure generator in `core/fixture/threadplane.ts` takes the export's `JsonlLine[]` (already redacted per the chosen groups) and emits the spec text: the captured request, the raw frames per LangGraph connection, an embedded copy of Threadplane 0.2.0's `normalizeSdkEvent` (`toStreamEvent`), and assertions derived **by Threadplane's own rules** from the frames. The panel adds a button. A script runs generated specs inside a local Threadplane checkout as the acceptance test.

**Tech Stack:** TypeScript strict, Vitest, Preact; target: Angular `TestBed` + Vitest in Threadplane (`libs/langgraph`, Nx, `vite.config.mts`). Package `packages/devtools`.

**Conventions:** colocated tests (`pnpm --filter ag-ui-devtools exec vitest run <path>`); optional fields absent; comments explain why, cite T-ids; no path-header comments; absence wording without fault words; commit per task ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Threadplane facts the generator depends on** (verified at angular-agent-framework `79aabe3fd`, `@threadplane/langgraph` 0.2.0; re-read them in `~/repos/angular-agent-framework/libs/langgraph/src/lib/` when implementing):
- Public: `MockAgentTransport`, `provideAgent`, `injectAgent`, type `StreamEvent` (`public-api.ts`). `MockAgentTransport` methods: `emit(events)`, `close()`, `flush()`, `streams[]` (each `{threadId, payload, options}`).
- `normalizeSdkEvent` (`transport/fetch-stream.transport.ts` ~L273-308) — private; the copy must be byte-for-byte equivalent in behaviour (see Task 1).
- `submit({ state })` forwards `state` as the payload; `submit({ resume })` sends payload `null` with `options.command.resume`.
- Status and end-of-run (`internals/stream-manager.bridge.ts` `trackAssistantMessages` ~L493-528, `markNormalTerminal` ~L535-551, `finishOutcome` ~L375-378, `processEvent` ~L1021-1277; `agent.fn.ts` `mapStatus` ~L708-717): read these and mirror them exactly in Task 2.

---

### Task 1: `toStreamEvent` — the pinned copy and its reference check

**Files:** Create `packages/devtools/src/core/fixture/threadplane-normalizer.ts`, `threadplane-normalizer.test.ts`.

- [ ] **Step 1:** Export `THREADPLANE_VERSION = '0.2.0'` and `TO_STREAM_EVENT_SOURCE: string` — the TypeScript source of a function `toStreamEvent(frame: { event: string; data: unknown }): StreamEvent` (plus its private helpers) that is Threadplane's `normalizeSdkEvent(frame.event, frame.data)` verbatim in logic (namespace from `|`, the `messages` tuple branch, the `messages*` array branch, the record-spread branch with `data` last, the scalar branch). The string is what the generated spec embeds; keep it readable, with a leading comment: `// Mirrors @threadplane/langgraph ${THREADPLANE_VERSION} normalizeSdkEvent (transport/fetch-stream.transport.ts). Copied because it is not exported; if Threadplane changes it, regenerate this spec.`
- [ ] **Step 2: Tests.**
  - A pinned-text test: `TO_STREAM_EVENT_SOURCE` equals a snapshot string (so any edit is deliberate).
  - A behaviour test: transpile `TO_STREAM_EVENT_SOURCE` with `typescript.transpileModule` (devtools has `typescript`), evaluate it with `new Function`, and compare its output with a **separate hand-written reference** of Threadplane 0.2.0's mapping (written in the test file from the Threadplane source, not copied from the constant) for: every frame of `src/test/fixtures/lg-reasoning.agui.jsonl`; frames `messages|research:t1` (tuple), `values|a:1|b:2`, `messages/partial` (array), `metadata`, `error` `{error, message}`, `custom` scalar, a `values` whose state has keys `type` and `namespace` (the spread overwrites them — keep that quirk), and `data: null`. Deep-equal for all.
- [ ] **Step 3:** Commit `feat(fixture): a pinned copy of Threadplane's SSE → StreamEvent mapping (T1)`.

### Task 2: what Threadplane will conclude — expectations from the frames

**Files:** Create `packages/devtools/src/core/fixture/threadplane-expect.ts`, `threadplane-expect.test.ts`.

- [ ] **Step 1:** `expectationsFor(frames: readonly { event: string; data: unknown }[]): ThreadplaneExpectations` where

```ts
export interface ThreadplaneExpectations {
  /** `agent.status()` after `close()` and the submission settle. */
  status: 'idle' | 'error';
  /** `agent.interrupt()` is set. */
  interrupted: boolean;
  /** The text of the last assistant message in `agent.messages()`, or undefined when there is none. */
  lastAssistantText?: string;
  /** Tool-call names in `agent.toolCalls()`, in order. Omitted when Threadplane would show none. */
  toolCallNames?: string[];
}
```

Derive each **by Threadplane's rules, not the extension's run model** (T4): mirror `trackAssistantMessages` / `markNormalTerminal` / `finishOutcome` / the `error` and interrupt cases of `processEvent` for `status` and `interrupted` (root events only; namespaced events never count); mirror how the bridge builds the transcript for `lastAssistantText` (root `messages` tuple deltas merged by id with content blocks flattened to text, then root `values.messages` merged in snapshot mode — read the bridge; if the rule is too intricate to mirror exactly, restrict `lastAssistantText` to the case the tests prove and omit it otherwise); `toolCallNames` from where Threadplane reads tool calls (read `getToolCallsWithResults` and its callers). **Omit** any expectation the implementation cannot derive with certainty — a missing assertion costs nothing; a wrong one breaks the promise that the generated test passes.
- [ ] **Step 2: Tests** — hand-built frame lists (reuse `src/test/langgraph-capture.ts` shapes): finished with final `values` → `idle`, not interrupted, text; cut off after chunks (no trailing root `values`) → `error`; root `values` with `__interrupt__` → `idle`, interrupted; root `error` frame → `error`; tool call streamed then final `values` whose AI message has `tool_calls` → names; subgraph frames don't affect `status`/text; `lg-reasoning` → `idle`, text = `lg-reasoning.canonical.txt`. Each expectation here is re-verified for real in Task 5.
- [ ] **Step 3:** Commit `feat(fixture): what Threadplane will conclude from a replayed capture (T4)`.

### Task 3: the spec generator

**Files:** Create `packages/devtools/src/core/fixture/threadplane.ts`, `threadplane.test.ts`; modify `src/panel/export/filename.ts` (+test).

- [ ] **Step 1:** `toThreadplaneSpec(lines: readonly JsonlLine[], options: { filename: string; importFrom?: string }): string | null` — `null` when no connection is LangGraph (use `dialectsOfLines` from `core/normalizer/dialect.ts`). For each LangGraph connection, in first-appearance order: its request line (T3) and its event lines as `{ event: line.sseEvent ?? 'message', data: line.event }`. Emit:
  - header comment: source filename, origin, capturedAt, redaction note (reuse the wording approach of `panel/export/fixture.ts` `redactionNote` — move that helper to core if needed so both use one), and one sentence: *these assertions are what the capture shows — change them to the behaviour you want, and the test fails until it's fixed.*
  - `import { TestBed } from '@angular/core/testing'; import { MockAgentTransport, injectAgent, provideAgent, type StreamEvent } from '<importFrom ?? '@threadplane/langgraph'>';`
  - `TO_STREAM_EVENT_SOURCE`
  - a `lastAssistantText(agent)` helper only if any `it` asserts text (read the neutral `Message` shape in `libs/chat/src/lib/agent/agent.ts`; handle string and block content).
  - per connection: `const request_N = <JSON>; const frames_N: Array<{ event: string; data: unknown }> = <JSON>;` and one `it('replays connection <connId> (run <runId or "unknown">)', async () => { … })` inside one `describe('AG-UI DevTools capture replay: <filename>')`, with `afterEach(() => TestBed.resetTestingModule())`. The `it`: `MockAgentTransport`; `provideAgent({ apiUrl: '', assistantId: request.assistant_id ?? 'agent', transport, throttle: false })`; `injectAgent()` in `runInInjectionContext`; submission per T3 (`{ state: request.input }` / `{ resume: request.command.resume }` / `{}` when neither — join GETs have no body); `for (const frame of frames) await transport.emit([toStreamEvent(frame)]);` `await transport.close(); await submitted.catch(() => undefined);` then the `expectationsFor` assertions (and `expect(transport.streams[0]?.payload).toEqual(request.input)` when submitting state).
  - JSON via `JSON.stringify(value, null, 2)`; the whole output deterministic.
- [ ] **Step 2:** `threadplaneFilename(url, iso)` → `threadplane-<host>-<stamp>.spec.ts` in `filename.ts` (mirror `fixtureFilename`).
- [ ] **Step 3: Tests:** golden text for a 5-frame capture (store the expected file under `src/core/fixture/__golden__/small.spec.ts.txt` and compare); `null` for `happy-run`; two LangGraph connections → two `it`s in order; a join connection (GET, no body) submits `{}`; a redacted export (build via `buildExport` with all groups) carries the redaction note and placeholder values, and its assertions use the redacted text; the output parses as TypeScript (transpile with `typescript` and assert no diagnostics of category Error from `transpileModule`'s `reportDiagnostics`).
- [ ] **Step 4:** Commit `feat(fixture): generate a Threadplane replay spec from a LangGraph capture (T2, T3, T5)`.

### Task 4: the Export button

**Files:** `src/panel/export/export-panel.tsx` (+test), `scripts/screenshot-panel.mts`.

- [ ] **Step 1: Tests** (export-panel.test.tsx style): the button "Download Threadplane test (.spec.ts)" is enabled for a LangGraph capture and downloads `threadplane-….spec.ts` with type `text/typescript` whose text contains `new MockAgentTransport`; for an AG-UI-only capture it is disabled and a reason is shown: `This capture has no LangGraph Platform connection — the Threadplane test replays LangGraph streams.` (no fault words); redaction checkboxes apply (a redacted spec contains no secret from the capture).
- [ ] **Step 2: Implement** `onThreadplane()` beside `onFixture()` using `build()` and `toThreadplaneSpec(built.lines, { filename })`; compute enablement from the unredacted state's connections (`connectionDialects` from `panel/model/selectors.ts`).
- [ ] **Step 3: Visual gate:** in `checkExport` (or `checkLangGraph`), `lg-reasoning` → the button enabled; a real click downloads a file whose text contains `MockAgentTransport` and `frames_1`; `happy-run` → disabled with the reason visible. Run `pnpm build && pnpm screenshot:panel`.
- [ ] **Step 4:** Commit `feat(export): Download Threadplane test (T6)`.

### Task 5: acceptance inside Threadplane (T7)

**Files:** Create `packages/devtools/scripts/verify-threadplane.ts`; add `"verify:threadplane": "tsx scripts/verify-threadplane.ts"` to `packages/devtools/package.json` and a root passthrough.

- [ ] **Step 1:** The script takes the Threadplane checkout path (arg or `THREADPLANE_DIR`, default `~/repos/angular-agent-framework`). It builds captures: `src/test/fixtures/lg-reasoning.agui.jsonl`; the harness scenarios `lg-tools-subgraph`, `lg-interrupt`, `lg-join` (import `packages/harness/fixtures/langgraph.ts` frames and wrap them with `src/test/langgraph-capture.ts`'s `langGraphJsonl`, including a join GET request line); and an all-groups **redacted** export of each (via `loadJsonl` + `buildExport`). For each it writes `toThreadplaneSpec(lines, { filename, importFrom: '../../public-api' })` to `<threadplane>/libs/langgraph/src/lib/__devtools_replay__/<name>.spec.ts`, runs Threadplane's Vitest on that directory (find the right command: e.g. `npx vitest run --config libs/langgraph/vite.config.mts libs/langgraph/src/lib/__devtools_replay__` from the Threadplane root, or `npx nx test langgraph -- …` — read the workspace's `project.json` test target), prints the result, and **always** removes the directory in a `finally`. Exit non-zero if any spec fails. It must refuse to run if the directory already exists (don't clobber) and must not modify anything else in the Threadplane checkout (`git -C <threadplane> status --porcelain` before and after must match).
- [ ] **Step 2:** Run it. Every generated spec must pass. For each failure, find the cause: a wrong `toStreamEvent` (fix Task 1), a wrong expectation (fix Task 2 — prefer omitting an expectation to guessing), or a submission mismatch (fix Task 3); re-run until green. Then prove it can fail: edit one generated expectation in the script's output path (e.g. `status` flipped) behind a `--mutate` flag and confirm the run fails.
- [ ] **Step 3:** Commit `test(fixture): generated Threadplane specs pass inside Threadplane (T7)` with the passing run's summary in the commit body.

### Task 6: record, gates, PR

- [ ] Spec: mark T1–T7 built; note any expectation that had to be omitted and why. `docs/spec/ag-ui-devtools-v0.1.md` §14.2: a one-line "built" note. README: one line under Export for the new button.
- [ ] Mutations: break `toStreamEvent` (drop the `data` field) → Task 1 behaviour test and T7 fail; flip the terminal rule in `expectationsFor` → Task 2 tests fail; generator emits frames of every connection into one `it` → Task 3 test fails.
- [ ] Gates: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e`, plus `pnpm verify:threadplane` (paste its output in the PR).
- [ ] Push, PR (body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), auto-merge (squash).
