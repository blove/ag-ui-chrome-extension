# LangGraph PR 4a — The Panel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LangGraph capture reads as one in the panel: Timeline's detail pane shows the AG-UI events each wire frame was read as (L14), Session names each connection's protocol (L15), and the visual gate draws and asserts a real LangGraph capture, including subgraphs.

**Architecture:** Spec [`2026-09-29-langgraph-normalization-design.md`](../specs/2026-09-29-langgraph-normalization-design.md) L14, L15; PR 4 is split into 4a (this: panel), 4b (field-level redaction, L16/L17) and 4c (harness e2e). Derived events are recorded on the `Run` they fold onto (`Run.derived`, keyed by source seq), because the run builder never leaves `live-session.ts` / `load-jsonl.ts` — the panel only sees `Run[]`. Session's protocol row derives per-connection dialect with the core `dialectOf` rule (via `dialectsOfLines` if #46 has merged, else by the same rule over `state.requests` + first record per connection).

**Tech Stack:** TypeScript strict, Preact, Vitest + @testing-library/preact, Playwright (visual gate `scripts/screenshot-panel.mts`). Package `packages/devtools`.

**Conventions:** colocated tests (`pnpm --filter ag-ui-devtools exec vitest run <path>`); optional fields absent; comments explain why, cite spec ids; no path-header comments; wording that describes an absence must not use fault words (`FAULT_WORDS` in the visual gate); commit per task ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: `Run.derived` — what each LangGraph frame was read as

**Files:** `src/core/model/types.ts`, `src/core/normalizer/run-builder.ts`, `run-builder.test.ts`.

- [ ] **Step 1: Type.** In `interface Run`, after `dialect`:

```ts
  /**
   * LangGraph only (L14): the synthetic AG-UI events each wire frame was read as, keyed by the
   * frame's seq, in fold order. Includes events a frame caused on THIS run although the frame
   * belongs to another (S3: a top-level error closing a child's message). Excludes the events the
   * expander emits at connection close — no frame caused those. Absent on AG-UI runs.
   */
  derived?: Map<number, AguiEvent[]>;
```

- [ ] **Step 2: Failing tests** (append to the LangGraph describe in `run-builder.test.ts`, using its helpers):
  - A stream `metadata`, `messages` chunk 'Hi' (seq 2), `values` (seq 3), closed: `run.derived.get(1)` types `['RUN_STARTED']`; `.get(2)` types `['TEXT_MESSAGE_START','TEXT_MESSAGE_CONTENT']`; `.get(3)` types `['TEXT_MESSAGE_END','STATE_SNAPSHOT']`; no entry holds `RUN_FINISHED` (a close-time event).
  - A frame that produced nothing (`messages/metadata`) has no entry.
  - A top-level `error` closing a child's message: the child's `derived.get(errorSeq)` holds that `TEXT_MESSAGE_END`, although `errorSeq` is not in the child's `recordSeqs`.
  - An AG-UI run has `derived === undefined`.
- [ ] **Step 3: Implement.** In `foldEvent`, add a final parameter `derive = false`; when true, append `event` to `entry.run.derived` (create the `Map` lazily) under `record.seq`. Pass `derive = true` from `foldSynthetic` only (not from `finishLangGraph`, not from any AG-UI path). Keep every other behaviour identical.
- [ ] **Step 4:** Run the run-builder tests, the full devtools suite, typecheck, lint. Commit `feat(core): Run.derived — the AG-UI events each LangGraph frame was read as (L14)`.

### Task 2: Timeline detail — a "Derived" section

**Files:** `src/panel/tabs/timeline/event-detail.tsx`, `event-detail.test.tsx`, `src/panel/panel.css` (only if a new class needs styling; reuse existing detail classes where possible).

- [ ] **Step 1: Failing tests** (follow the file's `fixtureState` / `regionOrder` / `within(region)` style; build the LangGraph state from `langGraphJsonl` in `src/test/langgraph-capture.ts` loaded through `loadJsonl`):
  - Selecting a LangGraph `messages` frame shows regions `['Event detail','Payload','Derived','Raw frame']` (Verdict absent when no issues) — Derived sits between Payload and Raw.
  - The Derived region lists one item per synthetic event, in order, each showing the event `type` and, where present, the id it acts on (`messageId` / `toolCallId` / `stepName`) and a short value (`delta` for CONTENT/ARGS events, truncated to 80 chars with an ellipsis). E.g. for a chunk 'Hi' on message m1: `TEXT_MESSAGE_START m1`, `TEXT_MESSAGE_CONTENT m1 "Hi"`.
  - A LangGraph frame that produced nothing shows the Derived region with the text: `Shown as it arrived — this frame is not read as any AG-UI event.` (no fault words).
  - A child run's events and the top run's events for one seq are both listed (gather `run.derived?.get(seq)` across all `state.runs`, in `state.runs` order).
  - An AG-UI record (happy-run fixture) shows NO Derived region — `regionOrder` unchanged from today.
- [ ] **Step 2: Implement** a `<Derived>` component (`<section aria-label="Derived" class="agui-detail__derived">`) rendered only when `record.kind === 'event' && record.sseEvent !== undefined` **and** some run is a LangGraph run holding this record's connection (i.e. `state.runs.some((run) => run.dialect === 'langgraph' && run.connId === record.connId)`). Items as an ordered list. A one-line lead-in: `Read as these AG-UI events — derived by the panel, not sent on the wire:`.
- [ ] **Step 3:** Tests, suite, typecheck, lint. Commit `feat(timeline): a Derived section shows how each LangGraph frame was read (L14)`.

### Task 3: Session — the Protocol row

**Files:** `src/panel/tabs/session/session.tsx`, `session.test.tsx`; a selector in `src/panel/model/selectors.ts`.

- [ ] **Step 1: Failing tests:**
  - Empty capture: a `Protocol` row reading `nothing on the wire yet` (matching the Transport row's no-data wording style; check the exact existing phrase and mirror it).
  - AG-UI only (happy-run): `AG-UI`.
  - LangGraph only: `LangGraph Platform`.
  - Mixed (happy-run + a LangGraph connection): `AG-UI and LangGraph Platform — 1 connection each` (for n/m: `AG-UI (n connections) and LangGraph Platform (m connections)`, singular `connection` when 1; when both are 1 use the short form).
  - None of these contain a `FAULT_WORDS` term.
- [ ] **Step 2: Implement** `connectionDialects(state): Map<string, Dialect>` in `selectors.ts` using the core rule: if `dialectsOfLines` exists in `src/core/normalizer/dialect.ts` (from #46), build it from `state.requests` + the first event record per connection; otherwise call `dialectOf(request, { sseEvent, payload: record.raw })` per connection directly. Render the row in the Detected section right after Transport.
- [ ] **Step 3:** Tests, suite, typecheck, lint. Commit `feat(session): name each connection's protocol (L15)`.

### Task 4: the visual gate draws a LangGraph capture

**Files:** `scripts/screenshot-panel.mts`; a new fixture `src/test/fixtures/lg-subgraph.agui.jsonl` (generate once from `langGraphJsonl` with the frames of the integration test "LangGraph: subgraphs fold into child runs" — write a tiny one-off script or a vitest that prints it, commit only the `.jsonl`).

- [ ] **Step 1:** Add `checkLangGraph(browser, origin, scheme)` wired into `main()` after `checkRuns`, following the existing block shape (`openPanel` → `importFixture` → click tab → screenshot → assert → `fail(...)`), with a summary line. Assertions:
  - `lg-reasoning.agui.jsonl` → Timeline: 1,213 event rows; the row labels include `metadata`, `messages`, `values`; **no** row labelled `unparsed`; badge `0 issues`. Click the first `messages` row that carries text (find one whose Derived lists `TEXT_MESSAGE_CONTENT`) → the Derived region is visible and lists `TEXT_MESSAGE_CONTENT`. Screenshot `langgraph-timeline.png`.
  - Messages tab: the answer text is visible and begins with `Step-by-step reasoning` (the recording's canonical text); the reasoning is collapsed until expanded (mirror the messages-edge reasoning assertion). Screenshot `langgraph-messages.png`.
  - Runs tab: one run, outcome `finished`, event count `1213`. Screenshot `langgraph-runs.png`.
  - Session: Protocol row reads `LangGraph Platform`. Screenshot `langgraph-session.png`.
  - `lg-subgraph.agui.jsonl` → Runs tab: 2 runs, the second's id ends `/research:t1`; both `finished`. Screenshot `langgraph-subgraph-runs.png`.
  - No console errors on any page.
- [ ] **Step 2:** Run `pnpm build && pnpm screenshot:panel` → exit 0; look at the five PNGs (open them) and confirm they render the content (not blank/black). Mutation: temporarily revert Task 2's label/Derived rendering → the gate fails; restore.
- [ ] **Step 3:** Commit `test(visual): the gate draws and asserts a real LangGraph capture and a subgraph`.

### Task 5: record, gates, PR

- [ ] Spec: L14/L15 rows note "built in PR 4a"; §8 sequencing: PR 4 split into 4a/4b/4c.
- [ ] Mutation checks: `foldSynthetic` stops passing `derive` → Task 1 + Task 2 tests fail; Derived renders for AG-UI records → the "no Derived region" test fails; Protocol row ignores dialect → Task 3 tests fail.
- [ ] Gates: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e`.
- [ ] Push, PR (body + `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), auto-merge (squash).
