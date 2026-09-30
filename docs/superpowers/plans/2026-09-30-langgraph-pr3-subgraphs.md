# LangGraph PR 3 — Subgraphs as Child Runs: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subgraph events (`mode|node:task|…`, sent when `stream_subgraphs` is on — Threadplane's default) fold into **child runs** of the run that spawned them, with their own messages, tool calls, state, steps, outcome and metrics; and a join stream that reconnects to a run continues that run instead of fighting over it.

**Architecture:** Spec [`2026-09-29-langgraph-normalization-design.md`](../specs/2026-09-29-langgraph-normalization-design.md) **L11**, and §9 open question 5 (decided here). The expander's per-stream state becomes per-**scope**: one scope per namespace, the top level being the scope with key `''`. Every synthetic event carries the `runKey` of the scope it belongs to; the run builder keeps a per-connection map `runKey → runId` and routes each event to its run, opening child runs **without** taking over the connection's current run. This branch is stacked on `blove/langgraph-expander` (PR 2, #44); rebase onto `main` once #44 merges.

**Tech Stack:** TypeScript strict, Vitest, pnpm. Package `packages/devtools` (`ag-ui-devtools`).

**Conventions:** as PR 2 — colocated tests (`pnpm --filter ag-ui-devtools exec vitest run <path>`), optional fields absent, comments explain why and cite spec ids, no `// packages/...` path header comments, commit per task ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Decisions

| # | Decision | Why |
|---|---|---|
| **S1** | A scope's `runKey` is its namespace joined by `\|` (`research:t1`, `research:t1\|tools:c9`); the top level is `''`. A child's run id is `` `${topRunId}/${runKey}` ``; its `parentRunId` is the run of the namespace one segment shorter (the top-level run for a one-segment namespace). | Ids stay readable and unique per stream, and nesting mirrors LangGraph's own namespace nesting. LangGraph sends no run id for a subgraph (no namespaced `metadata`), so these ids are ours — spec §9 Q2 already records that. |
| **S2** | A child scope opens on its first frame: `RUN_STARTED {runId, threadId, parentRunId}` for any ancestor not yet open, outermost first, then for itself. | A frame from a nested namespace can be the first thing any of its ancestors sends. |
| **S3** | A frame belongs to the run of its own scope, and to that run only: its seq goes to that run's `recordSeqs`, its bytes and wire name to that run's metrics. An event the frame causes on another run (a top-level error closing a child's message, a nested frame opening an ancestor, a namespaced first frame opening the top run) is folded there as a **non-member**: stamped with the frame's seq and time, but not added to that run's `recordSeqs`, bytes or wire-name count, so an ancestor that sent no frame of its own holds no records. Every issue carries the runKey of the run it is about (usually the frame's; `lg-no-metadata` is always the top run's; a cut-off scope's bad args are that scope's) and one raised away from that run's own frames anchors to that run's last frame on this connection (falling back to the connection's last frame). | The Runs table, a run-scoped Timeline and a single-run export then show exactly the frames each subgraph sent, and the event count equals the wire-name count (L13). |
| **S4** | Within a scope, every mode folds exactly as at the top level (messages, partial/complete, values, updates, custom, checkpoints, error), with the scope's own message/tool/partial state. `metadata` is never namespaced. | One code path for all scopes; a subgraph is a graph. |
| **S5** | An `error` in a scope ends that scope **and its subtree**: every scope inside it is settled (open messages closed, args checked), innermost first, then the scope itself; `RUN_ERROR` goes to the errored scope only; the scopes inside it get no terminal event, so the builder records them `aborted`. Any later frame from that subtree is recorded on the errored scope's run, opens no scope and folds nothing. The errored scope's parent and siblings carry on. The top level is the case whose subtree is everything. | A subgraph failure the parent survives is a child error; a failure stops every subgraph inside the failed graph mid-flight — at any depth. |
| **S6** | At `finish`: every scope is settled, deepest first, each scope's issues anchored to its own last frame. If the top run finishes (normally or at an interrupt), every child that neither errored nor sits inside a scope that errored (S5) gets `RUN_FINISHED` before the top run's; a child that saw `__interrupt__` is reported interrupted. If the top run does not finish (error, or `lg-no-final-values`), children get nothing → `aborted`. `lg-no-final-values` is a top-level check only, anchored to the connection's last top-level frame (falling back to its last frame). | Children end with their parent; a subgraph cannot be "finished" inside a run that was cut off. |
| **S7** | `finish` returns `interrupted: string[]` — the runKeys whose runs stopped at an interrupt. | Interrupts are per run now. |
| **S8 (§9 Q5)** | **A join stream continues its run.** A LangGraph connection whose `RUN_STARTED` names a run that already exists folds onto it — its frames, and its finish when it saw the run end (its final `values`, or an interrupt) — but only the connection that **created** a run can abort it: a reused run is not registered on the joining connection, so a join that closes early, while the original connection may still be streaming, leaves the run as it was. A join GET has no body, so `values` is not assumed requested: no `lg-no-final-values` either. The builder never lets `aborted` overwrite a terminal outcome (it only aborts a `running` run), and a join that saw the run finish is authoritative — its `RUN_FINISHED` settles the run even while the original connection is open, and upgrades an `aborted` run to `finished`, which is what a reconnect means. A join that **replays** from the start (`stream_resumable` + `Last-Event-ID` 0) would append content twice; captures do not store SSE `id:`s, so this is recorded as a known limit, not handled. AG-UI's handling of a reused run id is unchanged. | The alternative — a second run with the same id — cannot exist in a `Map` keyed by run id, and "the later connection overwrites" loses the truth that the run did finish. |

---

## File map

| File | Change |
|---|---|
| `src/core/normalizer/langgraph/expander.ts` (+test) | scopes; `ExpandedEvent`; `runKey` on expansions; per-run finish |
| `src/core/normalizer/run-builder.ts` (+test) | `runKey` routing; child runs; join-stream registration |
| `src/test/langgraph-capture.ts` | `firstSeq` option |
| `src/test/langgraph.integration.test.ts` | subgraph, nesting, child/parent errors, interrupt, join-stream tests; replace the PR 2 "before PR 3" block |
| spec | L11 as built; S1–S8; §9 Q5 resolved; PR 2 notes that say subgraphs are raw-only updated |

---

### Task 1: the expander works in scopes

**Files:** Modify `packages/devtools/src/core/normalizer/langgraph/expander.ts`, `expander.test.ts`.

- [ ] **Step 1: New API types.** Replace `LangGraphExpansion` and `LangGraphFinish` with:

```ts
/** One synthetic event and the run it belongs to: the scope's runKey (S1), `''` for the top level. */
export interface ExpandedEvent {
  readonly runKey: string;
  readonly event: AguiEvent;
}

export interface LangGraphExpansion {
  /** The run this frame belongs to (S3): its record, bytes, wire name and issues go there. */
  runKey: string;
  events: ExpandedEvent[];
  issues: Issue[];
}

export interface LangGraphFinish {
  events: ExpandedEvent[];
  /** Raised at close; they belong to the top-level run. */
  issues: Issue[];
  /** The runKeys whose runs stopped at an interrupt (S7). */
  interrupted: string[];
}
```

- [ ] **Step 2: Update the existing tests to the new shape first** (they must keep passing unchanged in meaning). In `expander.test.ts`, change `drive` so it collects `out.events.map((expanded) => expanded.event)` into `events`, and also returns `keys: string[]` (each expanded event's `runKey`, in order). In the tests that read `finish(...)`, map `done.events` the same way, and change `done.interrupted` assertions: `toBe(false)` → `toEqual([])`, `toBe(true)` → `toEqual([''])`. Change the PR 2 test "records a namespaced event raw, folding nothing (PR 3 folds subgraphs)" to expect the new behaviour (Step 5 gives it). Run the file → it now fails to compile/run until Step 3 lands; that is expected.

- [ ] **Step 3: Refactor state into scopes.** Introduce:

```ts
/** Everything the expander tracks for one namespace (S4). The top level is the scope keyed `''`. */
interface Scope {
  readonly key: string;
  readonly runId: string;
  open: OpenMessage | undefined;
  readonly messageCalls: Map<string, MessageCalls>;
  readonly uncheckedArgs: Set<OpenToolCall>;
  readonly syntheticIds: Map<string, string>;
  readonly partials: Map<string, PartialState>;
  readonly startedToolCalls: Set<string>;
  readonly resultedToolCalls: Set<string>;
  settled: boolean;
  interrupted: boolean;
  errored: boolean;
}
```

Move every closure variable of that list (today: `open`, `messageCalls`, `uncheckedArgs`, `syntheticIds`, `partials`, `startedToolCalls`, `resultedToolCalls`, `settled`, `interrupted`, `errored`) into `Scope`. Keep `started`, `runId` (the top run id), `threadId`, `route` at expander level. Mechanically: every helper that reads or writes that state (`closeReasoning`, `checkArgs`, `closeMessage`, `settle`, `foldToolChunk`, `foldAiDelta`, `toolResult`, `foldTupleMessage`, `foldCumulativeMessage`) takes `scope: Scope` as its first parameter and uses `scope.x` instead of the closure variable; every `out.events.push(event)` becomes `out.events.push({ runKey: scope.key, event })`. Behaviour for the top level must not change.

Add the scope table and opening (S1, S2):

```ts
  const scopes = new Map<string, Scope>();

  function newScope(key: string, scopeRunId: string): Scope {
    const scope: Scope = {
      key,
      runId: scopeRunId,
      open: undefined,
      messageCalls: new Map(),
      uncheckedArgs: new Set(),
      syntheticIds: new Map(),
      partials: new Map(),
      startedToolCalls: new Set(),
      resultedToolCalls: new Set(),
      settled: false,
      interrupted: false,
      errored: false,
    };
    scopes.set(key, scope);
    return scope;
  }

  /**
   * The scope for a namespace, opening it — and any ancestor not yet open, outermost first — with
   * a RUN_STARTED (S2). The top-level scope must already exist.
   */
  function scopeFor(out: LangGraphExpansion, namespace: readonly string[]): Scope {
    let parent = scopes.get('')!;
    for (let depth = 1; depth <= namespace.length; depth += 1) {
      const key = namespace.slice(0, depth).join('|');
      let scope = scopes.get(key);
      if (scope === undefined) {
        scope = newScope(key, `${runId}/${key}`);
        out.events.push({
          runKey: key,
          event: { type: 'RUN_STARTED', runId: scope.runId, threadId, parentRunId: parent.runId },
        });
      }
      parent = scope;
    }
    return parent;
  }
```

`start` creates the top scope: after computing `runId`/`threadId`, call `newScope('', runId)` and push `{ runKey: '', event: { type: 'RUN_STARTED', runId, threadId } }`.

- [ ] **Step 4: Route `push` through scopes.** Replace the body of `push` after the `metadata` branch with:

```ts
    ensureStarted(out, seq);
    const top = scopes.get('')!;
    // A top-level error ends the run and every subgraph in it (S5): later frames are recorded as
    // they arrived, on the top-level run, and fold nothing.
    if (top.errored) return out;
    const scope = namespace.length === 0 ? top : scopeFor(out, namespace);
    out.runKey = scope.key;
    // A child that errored folds nothing more; its siblings and parent carry on (S5).
    if (scope.errored) return out;
    if (!isKnownMode(mode)) {
      issue(out, 'lg-unknown-event', `"${name}" is not an event LangGraph Platform emits`, seq);
      return out;
    }
    foldMode(out, scope, mode, name, seq, payload);
    return out;
```

where `out` is created as `{ runKey: '', events: [], issues: [] }`, and `foldMode(out, scope, mode, name, seq, payload)` is the existing `switch (mode)` moved into its own function, operating on `scope`, with these changes:
- `case 'error'`: if `scope.key === ''` (top level), settle **every** scope — `for (const each of [...scopes.values()].reverse()) settle(out, each, seq)` — before emitting the top `RUN_ERROR`; otherwise settle only `scope`. Set `scope.errored = true`. The `RUN_ERROR` goes to `scope.key`.
- `case 'metadata'` can now only be reached namespaced (the top-level branch returns earlier): treat it like the `default` (raw only).
- all other cases unchanged apart from using `scope`.

- [ ] **Step 5: `finish` per run (S6, S7).**

```ts
  function finish(seq: number): LangGraphFinish {
    const out: LangGraphExpansion = { runKey: '', events: [], issues: [] };
    const done = (interrupted: string[]): LangGraphFinish => ({ events: out.events, issues: out.issues, interrupted });
    if (!started) return done([]);
    // Deepest first: a child's messages close before its parent's (S6).
    const ordered = [...scopes.values()].sort((a, b) => depthOf(b.key) - depthOf(a.key));
    for (const scope of ordered) settle(out, scope, seq);
    const top = scopes.get('')!;
    if (top.errored) return done([]);
    if (!top.interrupted && valuesRequested(request.input) && !top.settled) {
      issue(out, 'lg-no-final-values', 'The stream closed without a final values event, although the request asked for values', seq);
      return done([]);
    }
    const interrupted: string[] = [];
    for (const scope of ordered) {
      if (scope.key !== '' && scope.errored) continue;
      out.events.push({ runKey: scope.key, event: { type: 'RUN_FINISHED', runId: scope.runId, threadId } });
      if (scope.interrupted) interrupted.push(scope.key);
    }
    return done(interrupted);
  }
```

with `function depthOf(key: string): number { return key === '' ? 0 : key.split('|').length; }` at module level. (`ordered` puts the top scope last, so the top `RUN_FINISHED` is emitted after every child's.)

- [ ] **Step 6: New expander tests** (append):

```ts
describe('createLangGraphExpander — subgraphs (L11)', () => {
  it('opens a child run on a namespace’s first frame, and routes its events there', () => {
    const { events, keys } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages|research:t1', ai('s1', 'Looking')],
    ]);
    expect(events[1]).toEqual({ type: 'RUN_STARTED', runId: 'r-1/research:t1', threadId: 't-1', parentRunId: 'r-1' });
    expect(keys).toEqual(['', 'research:t1', 'research:t1', 'research:t1']);
    expect(types(events).slice(2)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
  });

  it('opens every ancestor of a nested namespace, outermost first', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values|a:1|b:2', { x: 1 }],
    ]);
    expect(events.slice(1, 3)).toEqual([
      { type: 'RUN_STARTED', runId: 'r-1/a:1', threadId: 't-1', parentRunId: 'r-1' },
      { type: 'RUN_STARTED', runId: 'r-1/a:1|b:2', threadId: 't-1', parentRunId: 'r-1/a:1' },
    ]);
  });

  it('says which run a frame belongs to', () => {
    const expander = createLangGraphExpander('c1', REQUEST);
    expander.push({ seq: 1, sseEvent: 'metadata', payload: { run_id: 'r-1' } });
    expect(expander.push({ seq: 2, sseEvent: 'updates|research:t1', payload: { search: {} } }).runKey).toBe('research:t1');
    expect(expander.push({ seq: 3, sseEvent: 'values', payload: { x: 1 } }).runKey).toBe('');
  });

  it('keeps each scope’s message state apart: same message id, two runs', () => {
    const { events, keys } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', 'top')],
      ['messages|sub:1', ai('m1', 'child')],
    ]);
    // The child's chunk does not close the top-level message: they are different scopes.
    expect(types(events)).not.toContain('TEXT_MESSAGE_END');
    expect(keys.filter((key) => key === 'sub:1')).toHaveLength(3);
  });

  it('ends a child on its own error and lets the parent finish', () => {
    const { events, expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages|sub:1', ai('s1', 'x')],
      ['error|sub:1', { error: 'E', message: 'child boom' }],
      ['messages|sub:1', ai('s1', 'ignored')],
      ['values', { x: 1 }],
    ]);
    expect(events.filter((event) => event.type === 'RUN_ERROR')).toEqual([{ type: 'RUN_ERROR', message: 'child boom', code: 'E' }]);
    expect(events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').map((event) => event.delta)).toEqual(['x']);
    const done = expander.finish(5);
    expect(done.events.map((expanded) => [expanded.runKey, expanded.event.type])).toEqual([['', 'RUN_FINISHED']]);
  });

  it('a top-level error closes every scope and finishes no child (S5)', () => {
    const { events, keys, expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages|sub:1', ai('s1', 'x')],
      ['error', { error: 'E', message: 'boom' }],
    ]);
    const tail = events.slice(-2);
    expect(tail).toEqual([{ type: 'TEXT_MESSAGE_END', messageId: 's1' }, { type: 'RUN_ERROR', message: 'boom', code: 'E' }]);
    expect(keys.slice(-2)).toEqual(['sub:1', '']);
    expect(expander.finish(3).events).toEqual([]);
  });

  it('finishes children before the parent, and reports interrupts per run (S6, S7)', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages|sub:1', ai('s1', 'x')],
      ['updates|sub:1', { __interrupt__: [{ value: 'ok?' }] }],
      ['values', { __interrupt__: [{ value: 'ok?' }] }],
    ]);
    const done = expander.finish(4);
    expect(done.events.map((expanded) => [expanded.runKey, expanded.event.type])).toEqual([
      ['sub:1', 'TEXT_MESSAGE_END'],
      ['sub:1', 'RUN_FINISHED'],
      ['', 'RUN_FINISHED'],
    ]);
    expect(done.interrupted.sort()).toEqual(['', 'sub:1']);
  });

  it('finishes no child when the top run closed without its final values', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values|sub:1', { x: 1 }],
      ['messages', ai('m1', 'cut')],
    ]);
    const done = expander.finish(3);
    expect(done.events.map((expanded) => expanded.event.type)).toEqual(['TEXT_MESSAGE_END']);
    expect(done.issues.map((raised) => raised.code)).toEqual(['lg-no-final-values']);
  });
});
```

and replace the body of the old "records a namespaced event raw" test with: a `messages|research:abc` chunk produces `RUN_STARTED` (child) + `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT`, and no issues.

- [ ] **Step 7: Run** the expander tests → PASS; the whole normalizer folder; typecheck (the builder will not compile yet against the new types — **that is Task 2**; if you are executing Task 1 alone, run only the expander test file and skip typecheck until Task 2). Commit:

```bash
git add packages/devtools/src/core/normalizer/langgraph/expander.ts packages/devtools/src/core/normalizer/langgraph/expander.test.ts
git commit -m "feat(expander): scopes — subgraph events fold into child runs (L11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> Because Task 1 breaks the builder's compile, execute Tasks 1 and 2 back to back in one session, committing Task 1 first and running the full gates only after Task 2.

---

### Task 2: the run builder routes by runKey

**Files:** Modify `packages/devtools/src/core/normalizer/run-builder.ts`; test `run-builder.test.ts`.

- [ ] **Step 1: Failing tests** (append to the LangGraph describe in `run-builder.test.ts`, reusing its `lgRecord`, `lgBuilder`, `chunk` helpers):

```ts
  it('folds a subgraph into a child run that does not take over the connection', () => {
    const builder = lgBuilder();
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'messages|research:t1', chunk('s1', 'Looking', { chunk_position: 'last' })));
    builder.addRecord(lgRecord(3, 'messages', chunk('m1', 'Answer', { chunk_position: 'last' })));
    builder.addRecord(lgRecord(4, 'values', { messages: [] }));
    builder.closeConnection('c1', 50);

    const runs = builder.runs();
    expect(runs.map((run) => run.runId)).toEqual(['r-1', 'r-1/research:t1']);
    const [top, child] = runs;
    expect(child).toMatchObject({ parentRunId: 'r-1', threadId: 't-1', dialect: 'langgraph', outcome: 'finished' });
    expect(child?.recordSeqs).toEqual([2]);
    expect(child?.messages.get('s1')?.content).toBe('Looking');
    expect(child?.metrics.eventCountByType).toEqual({ 'messages|research:t1': 1 });
    // The top-level message after the subgraph still lands on the top-level run.
    expect(top?.recordSeqs).toEqual([1, 3, 4]);
    expect(top?.messages.get('m1')?.content).toBe('Answer');
    expect(top?.outcome).toBe('finished');
  });

  it('records a child the parent’s failure cut off as aborted', () => {
    const builder = lgBuilder();
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'messages|sub:1', chunk('s1', 'x')));
    builder.addRecord(lgRecord(3, 'error', { error: 'E', message: 'boom' }));
    builder.closeConnection('c1', 40);
    expect(builder.runs().map((run) => [run.runId, run.outcome])).toEqual([
      ['r-1', 'error'],
      ['r-1/sub:1', 'aborted'],
    ]);
  });

  it('marks each interrupted run interrupted', () => {
    const builder = lgBuilder();
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'updates|sub:1', { __interrupt__: [{ value: 'ok?' }] }));
    builder.addRecord(lgRecord(3, 'values', { __interrupt__: [{ value: 'ok?' }] }));
    builder.closeConnection('c1', 40);
    expect(builder.runs().map((run) => run.outcome)).toEqual(['interrupted', 'interrupted']);
  });

  it('a join stream continues its run: an abort is upgraded by the join’s finish (S8)', () => {
    const builder = lgBuilder(); // c1: POST /threads/t-1/runs/stream, asked for values
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'messages', chunk('m1', 'Hel')));
    builder.addRequest('c2', 'GET', 'http://localhost:2024/threads/t-1/runs/r-1/stream', undefined);
    builder.addRecord({ ...lgRecord(3, 'messages', chunk('m1', 'lo', { chunk_position: 'last' })), connId: 'c2' });
    builder.addRecord({ ...lgRecord(4, 'values', { messages: [] }), connId: 'c2' });
    builder.closeConnection('c1', 50); // the dropped connection: no final values
    builder.closeConnection('c2', 60);

    const runs = builder.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('finished');
    expect(runs[0]?.messages.get('m1')?.content).toBe('Hello');
    expect(runs[0]?.recordSeqs).toEqual([1, 2, 3, 4]);
    // Anchored to the dropped connection's own last frame, not the run's.
    expect(runs[0]?.issues.map((raised) => [raised.code, raised.seq])).toEqual([['lg-no-final-values', 2]]);
  });
```

- [ ] **Step 2: Run** → FAIL (compile errors from Task 1's API, then wrong routing).

- [ ] **Step 3: Implement.** In `ConnEntry` add:

```ts
  /** LangGraph: each scope's run (S1). `''` is the connection's top-level run. */
  langGraphRuns?: Map<string, string>;
  /** LangGraph: the seq of this connection's last frame — what its close-time issues anchor to. */
  lastLangGraphSeq?: number;
```

Replace `foldSynthetic` and `foldLangGraph` with:

```ts
  /**
   * Open the run a synthetic RUN_STARTED names. A child (non-empty runKey) must not take over the
   * connection: the next top-level frame still belongs to the top-level run (S3). Either way the
   * run is registered on this connection, so its close settles it — which is also what makes a
   * join stream continue the run it names (S8).
   */
  function openLangGraphRun(conn: ConnEntry, runKey: string, event: AguiEvent, record: EventRecord): RunEntry {
    const previous = conn.openRunId;
    const entry = openRunFromStarted(conn, event, record);
    if (runKey !== '') conn.openRunId = previous;
    if (!conn.runIds.includes(entry.run.runId)) conn.runIds.push(entry.run.runId);
    (conn.langGraphRuns ??= new Map()).set(runKey, entry.run.runId);
    return entry;
  }

  function langGraphEntry(conn: ConnEntry, runKey: string): RunEntry | undefined {
    const runId = conn.langGraphRuns?.get(runKey);
    return runId === undefined ? undefined : entries.get(runId);
  }

  /**
   * Fold a frame's synthetic events onto the runs their runKeys name, stamped with the frame (L10).
   * The frame's bytes and wire name are counted once, on the frame's own run (S3, L13).
   */
  function foldSynthetic(conn: ConnEntry, events: readonly ExpandedEvent[], record: EventRecord, frameKey: string): boolean {
    let counted = false;
    for (const { runKey, event } of events) {
      const entry =
        event.type === 'RUN_STARTED' ? openLangGraphRun(conn, runKey, event, record) : langGraphEntry(conn, runKey);
      if (entry === undefined) continue;
      entry.run.dialect = 'langgraph';
      const countBytes = !counted && runKey === frameKey;
      if (countBytes) counted = true;
      foldEvent(entry, event, record, countBytes, false);
    }
    return counted;
  }

  function foldLangGraph(conn: ConnEntry, record: EventRecord): void {
    conn.langGraph ??= createLangGraphExpander(conn.connId, {
      ...(conn.method !== undefined ? { method: conn.method } : {}),
      ...(conn.url !== undefined ? { url: conn.url } : {}),
      input: conn.input,
    });
    const expansion = conn.langGraph.push({
      seq: record.seq,
      ...(record.sseEvent !== undefined ? { sseEvent: record.sseEvent } : {}),
      payload: record.raw,
    });
    conn.lastLangGraphSeq = record.seq;
    const counted = foldSynthetic(conn, expansion.events, record, expansion.runKey);
    const target =
      langGraphEntry(conn, expansion.runKey) ?? langGraphEntry(conn, '') ?? ensureOrphanEntry(conn.connId, record.tMs);
    // A frame that folded nothing onto its own run — a `debug` frame, `messages/metadata`, a
    // frame after an error — is still that run's record, raw.
    if (!counted) noteRecord(target, record, null, true);
    attachIssues(target, expansion.issues);
    attachIssues(target, record.issues);
  }
```

(import `type ExpandedEvent` from `./langgraph/expander`). **Careful with `recordSeqs`:** `noteRecord` pushes the seq only if it differs from the run's last seq; a frame that STARTs a child and folds content onto it records its seq on the child — confirm the top run does not also receive the seq (the child `RUN_STARTED` is folded onto the child entry, so it should not).

Replace `finishLangGraph` with:

```ts
  function finishLangGraph(conn: ConnEntry, tMs: number): void {
    const top = conn.langGraph === undefined ? undefined : langGraphEntry(conn, '');
    if (conn.langGraph === undefined || top === undefined) return;
    // Anchored to THIS connection's last frame, not the run's: with a join stream (S8) the run's last
    // frame may be another connection's, and "this stream closed without its final values" is a
    // claim about this one.
    const finish = conn.langGraph.finish(conn.lastLangGraphSeq ?? top.run.recordSeqs.at(-1) ?? 0);
    for (const { runKey, event } of finish.events) {
      const entry = langGraphEntry(conn, runKey);
      if (entry === undefined) continue;
      // Nothing was on the wire for these: no bytes, no wire name, anchored to that run's last seq.
      const seq = entry.run.recordSeqs.at(-1) ?? 0;
      foldEvent(entry, event, { kind: 'event', seq, tMs, connId: conn.connId, raw: undefined, event, issues: [] }, false, false);
    }
    attachIssues(top, finish.issues.map((raised) => ({ ...raised, tMs })));
    for (const runKey of finish.interrupted) {
      const entry = langGraphEntry(conn, runKey);
      if (entry !== undefined) entry.run.outcome = 'interrupted';
    }
  }
```

- [ ] **Step 4: Run** the run-builder tests, then the full devtools suite (the PR 2 integration test "subgraph events, before PR 3" will now fail — that is Task 3's job; leave it failing only until Task 3, or update it now to the new behaviour if executing both). typecheck, lint. Commit:

```bash
git add packages/devtools/src/core/normalizer/run-builder.ts packages/devtools/src/core/normalizer/run-builder.test.ts
git commit -m "feat(run-builder): route LangGraph events by run; child runs; a join stream continues its run (L11, S8)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: end-to-end subgraph tests

**Files:** Modify `packages/devtools/src/test/langgraph-capture.ts`, `langgraph.integration.test.ts`.

- [ ] **Step 1: `firstSeq`.** Add `readonly firstSeq?: number;` to `LangGraphCaptureOptions`; in `langGraphJsonl`, number frames from `options.firstSeq ?? 1` (seq), keeping `tMs = seq * 10`.

- [ ] **Step 2: Replace** the describe block "LangGraph: subgraph events, before PR 3" with:

```ts
describe('LangGraph: subgraphs fold into child runs (L11)', () => {
  const frames: LangGraphTestFrame[] = [
    { event: 'metadata', data: { run_id: 'r-1' } },
    { event: 'values', data: { messages: [{ type: 'human', content: 'hi' }] } },
    { ...aiChunk('s1', [{ type: 'text', text: 'Looking' }]), event: 'messages|research:t1' },
    { ...aiChunk('s1', [], { chunk_position: 'last' }), event: 'messages|research:t1' },
    { event: 'updates|research:t1', data: { search: { notes: 'x' } } },
    { event: 'values|research:t1', data: { notes: 'x' } },
    { event: 'updates', data: { research: { notes: 'x' } } },
    aiChunk('m1', 'Answer', { chunk_position: 'last' }),
    { event: 'values', data: { messages: [] } },
  ];

  it('gives the subgraph its own run, under its parent', () => {
    const loaded = load(frames);
    expect(loaded.runs.map((run) => [run.runId, run.parentRunId, run.outcome])).toEqual([
      ['r-1', undefined, 'finished'],
      ['r-1/research:t1', 'r-1', 'finished'],
    ]);
  });

  it('splits frames, messages, steps, state and counts between parent and child', () => {
    const [top, child] = load(frames).runs;
    expect(child?.recordSeqs).toEqual([3, 4, 5, 6]);
    expect(child?.messages.get('s1')).toMatchObject({ content: 'Looking', closed: true });
    expect(child?.steps.map((step) => step.stepName)).toEqual(['search']);
    expect(child?.stateTimeline).toHaveLength(1);
    expect(child?.metrics.eventCountByType).toEqual({
      'messages|research:t1': 2,
      'updates|research:t1': 1,
      'values|research:t1': 1,
    });
    expect(top?.recordSeqs).toEqual([1, 2, 7, 8, 9]);
    expect(top?.messages.get('m1')?.content).toBe('Answer');
    expect(top?.steps.map((step) => step.stepName)).toEqual(['research']);
    expect(top?.metrics.eventCountByType).toEqual({ metadata: 1, values: 2, updates: 1, messages: 1 });
    expect([...(top?.issues ?? []), ...(child?.issues ?? [])]).toEqual([]);
  });

  it('nests: a two-segment namespace is a child of the one-segment run', () => {
    const loaded = load([
      { event: 'metadata', data: { run_id: 'r-1' } },
      { event: 'values|a:1|b:2', data: { x: 1 } },
      { event: 'values', data: {} },
    ]);
    expect(loaded.runs.map((run) => [run.runId, run.parentRunId])).toEqual([
      ['r-1', undefined],
      ['r-1/a:1', 'r-1'],
      ['r-1/a:1|b:2', 'r-1/a:1'],
    ]);
    expect(loaded.runs[2]?.recordSeqs).toEqual([2]);
  });

  it('a child error is the child’s; a parent error aborts its children', () => {
    const childError = load([
      { event: 'metadata', data: { run_id: 'r-1' } },
      { ...aiChunk('s1', 'x'), event: 'messages|sub:1' },
      { event: 'error|sub:1', data: { error: 'E', message: 'child boom' } },
      { event: 'values', data: {} },
    ]);
    expect(childError.runs.map((run) => run.outcome)).toEqual(['finished', 'error']);

    const parentError = load([
      { event: 'metadata', data: { run_id: 'r-1' } },
      { ...aiChunk('s1', 'x'), event: 'messages|sub:1' },
      { event: 'error', data: { error: 'E', message: 'boom' } },
    ]);
    expect(parentError.runs.map((run) => run.outcome)).toEqual(['error', 'aborted']);
    expect(parentError.runs[1]?.messages.get('s1')?.closed).toBe(true);
  });
});

describe('LangGraph: a join stream continues the run it rejoins (S8)', () => {
  it('one run, the whole answer, finished by the joining connection', () => {
    const original = langGraphJsonl([
      { event: 'metadata', data: { run_id: 'r-1' } },
      aiChunk('m1', 'Hel'),
    ]);
    const join = langGraphJsonl([aiChunk('m1', 'lo', { chunk_position: 'last' }), { event: 'values', data: { messages: [] } }], {
      connId: 'c2',
      url: 'http://localhost:2024/threads/t-1/runs/r-1/stream',
      body: null,
      header: false,
      firstSeq: 3,
    });
    const loaded = loadJsonl(`${original}\n${join}`);
    const run = only(loaded);
    expect(run.outcome).toBe('finished');
    expect(run.messages.get('m1')?.content).toBe('Hello');
    expect(run.recordSeqs).toEqual([1, 2, 3, 4]);
    // True of the connection that dropped, and kept: it did close without its final values.
    expect(codes(run)).toEqual([['lg-no-final-values', 2]]);
  });
});
```

(`body: null` — check how `langGraphJsonl` writes `input` when `body` is `null`; a join GET has no body, so the request line's `input` should be `null`. Adjust the helper's `options.body ?? DEFAULT_LG_BODY` to `'body' in options ? options.body : DEFAULT_LG_BODY` so an explicit `null` is kept.)

- [ ] **Step 3: Run** the integration file → PASS; break-check each new block (break one line in the expander or builder, see it fail, restore). Run the full devtools suite, typecheck, lint. Commit:

```bash
git add packages/devtools/src/test/langgraph-capture.ts packages/devtools/src/test/langgraph.integration.test.ts
git commit -m "test: subgraphs as child runs, and a join stream that continues its run, end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: record it, gates, PR

- [ ] **Step 1: Spec.** In `docs/superpowers/specs/2026-09-29-langgraph-normalization-design.md`:
  - L11: replace the "The builder's single `conn.openRunId` becomes a per-connection map…" wording with the design as built: S1–S3 (runKey, ids, parent ids, frame ownership), and that child runs never take over the connection's current run.
  - Add S4–S8 as a short "PR 3 decisions" table after L11 (copy the Decisions table of this plan, condensed).
  - §3 Scope: remove "namespaced forms … recorded raw" wording that PR 2 added, if present; the PR 2 implementation note saying namespaced events are raw-only → "(PR 2 only; PR 3 folds them)".
  - §9: mark Q5 **decided (S8)**, keeping the replay limit as a sentence.
- [ ] **Step 2: Mutation checks** — apply, confirm FAIL, revert:

| Mutation | Must fail |
|---|---|
| builder: a child `RUN_STARTED` takes over the connection (drop the `openRunId` restore) | "does not take over the connection", subgraph integration split |
| builder: count bytes on the first event regardless of runKey | child/top `eventCountByType` tests |
| expander `finish`: finish children even when the top run did not finish | "finishes no child when the top run closed without its final values", parent-error integration |
| expander: top-level `error` settles only the top scope | "a top-level error closes every scope" |
| builder: don't register a reused run on the joining connection | join-stream tests |
| expander `scopeFor`: parent is always the top run | nesting tests |

- [ ] **Step 3: Gates** from the repo root: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e`.
- [ ] **Step 4:** If #44 has merged, rebase onto `origin/main` (`git rebase --onto origin/main blove/langgraph-expander`), re-run the suite; commit the spec; push; open the PR (body: what, S1–S8, mutation table, counts; ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`); enable auto-merge (squash). If #44 has not merged, open the PR with base `blove/langgraph-expander` and say so in the body.
