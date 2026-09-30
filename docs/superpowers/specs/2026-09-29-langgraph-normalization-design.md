# LangGraph normalization — design

**Date:** 2026-09-29
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §14.1 (and §14.2, which depends on it)
**Status:** v0.1 is complete — all eight §13 done-when criteria are closed. Nothing in the codebase
knows LangGraph exists. A LangGraph stream is captured today (detection gates nothing), but its SSE
`event:` names are dropped at the world boundary and every record lands in the `__orphaned__` run.

---

## 1. Why this, and why first

§14.1: Threadplane's `@threadplane/langgraph` adapter talks to LangGraph Platform, which is not
AG-UI on the wire. Mapping it into the same run model means one panel covers both Threadplane
adapters, and an AG-UI stream and a LangGraph stream sit side by side in one capture.

It goes before §14.2 because §14.2's target, `MockAgentTransport`, lives in
`@threadplane/langgraph` and replays **LangGraph** `StreamEvent`s — `{type:'values', …}`,
`{type:'messages', messages:[chunk], messageMetadata}` — not AG-UI events. Until the extension
captures LangGraph faithfully, there is nothing to export into it. (The AG-UI seam,
`@threadplane/ag-ui`'s `FakeAgent`, wraps every script branch in its own `RUN_STARTED`/
`RUN_FINISHED` and so cannot reproduce a broken run boundary; that was considered and set aside.)

**Consequence for this design:** the raw LangGraph frame, *with its event name*, must survive
capture, storage, export and import untouched. §14.2 is built on it.

## 2. The wire format, briefly

Sources: `@langchain/langgraph-sdk` (`libs/sdk`), the JS reference server (`libs/langgraph-api`),
Threadplane's transport and bridge, and one real Python-server recording
(`angular-agent-framework/libs/langgraph/test/fixtures/streaming-reasoning-puzzle.json`).

- **Routes:** `POST /threads/{thread_id}/runs/stream`, `POST /runs/stream` (threadless), and the
  join streams `GET /threads/{thread_id}/runs/{run_id}/stream` / `GET /runs/{run_id}/stream`.
  Request body: `{assistant_id, input, command, config, stream_mode, stream_subgraphs, …}`.
- **Framing:** SSE, the type in `event:`, JSON in `data:`. The JS server pretty-prints, so one
  payload spans many `data:` lines. `id:` is present on thread routes only.
- **First event:** always `metadata` → `{run_id, attempt}`.
- **`messages` (the `messages-tuple` mode):** `[chunk, metadata]`, **per-chunk delta**. `content`
  is a string or a block array (`{type:'text', text, index}`, `{type:'reasoning', summary:[…]}`)
  merged by block `index`. `tool_call_chunks: [{name, args, id, index}]` — `args` are fragments,
  merged by `index`. Final chunk: `content: []`, `chunk_position: 'last'`, usage.
  **Id quirk:** the Python server opens with one empty-content chunk under a `resp_…` id; every
  later chunk uses `lc_run--…`.
- **`messages/partial` (legacy):** **cumulative** — the whole message so far. `messages/complete`
  and `messages/metadata` accompany it.
- **`values`:** full state. **`updates`:** `{[node]: partialState}`. Either may carry
  `__interrupt__`; a `values` whose only key is `__interrupt__` is an interrupt, not a state.
- **`custom`:** whatever the node wrote. **`error`:** `{error, message}`, last event.
- **Subgraphs:** `stream_subgraphs: true` names events `mode|node:task_id|…`. `metadata` is never
  namespaced.
- **There is no end event.** The run ends when the body closes.

Threadplane's default request: `stream_mode: ['values','messages-tuple','updates','custom']`,
`stream_subgraphs: true`.

## 3. Scope

**In:** `metadata`, `messages` (tuple), `messages/partial|complete|metadata`, `values`, `updates`,
`custom`, `error`, and namespaced forms of all of them, folded into child runs.

**Raw only (Timeline row, no derived events):** `debug`, `tasks`, `checkpoints`, `events`,
`tools`, `feedback`, and any unknown name (which also raises an issue — see L12).

**Out:** `EventSource`-transport LangGraph (named events are not mirrored on that path today; the
SDK uses `fetch`, so no known client is affected — documented, not fixed); resumed streams across
reconnects (`Last-Event-ID`) as one run; §14.2 itself.

**Acceptance:** a Threadplane LangGraph app, with its default stream modes and subgraphs on, is
captured with no configuration, and Timeline, Messages, State, Runs and Session all render it.

---

## 4. Approach

**Store the raw frame; translate when folding into runs.** Rejected alternatives:

- *A second run builder for LangGraph* — no synthetic events, but duplicates message, tool-call and
  state logic, and every future tab feature would be built twice.
- *Translate at capture, store AG-UI* — the least downstream work, and it destroys the original
  stream: §14.2 becomes impossible and exports stop being true.

Everything downstream of the run builder reads the derived `Run` (`messages`, `toolCalls`,
`stateTimeline`, `metrics`), not raw event types — confirmed for Messages, State, Waterfall and
Runs. The builder already has a slot that turns one record into zero or more events
(`expandChunk`). A LangGraph expander in that slot makes every tab work unchanged.

## 5. Decisions

### Capture and storage

| # | Decision | Rationale |
|---|---|---|
| **L1** | **`WireFrame` gains an optional `eventName`**, set by the fetch and XHR paths from `SseFrame.eventName`. `relay.ts` `toRelayMessage` copies it explicitly; `isWireFrame` accepts it only as an own string property. **An empty name and the SSE default `message` are normalized to absent.** | `protocol.ts` already says a frame field "needs a field of its own on this type". The relay rebuilds frames field by field, so a field it does not name is silently stripped — the one step easiest to forget, and it gets its own test. `raw-invariant.test.ts` is extended so fetch and XHR stay byte-identical *including* the name. `EventSource` cannot tell `event: message` from no `event:` line, so treating both as absent keeps all three transports in agreement. |
| **L2** | **`CaptureRecord` and `JsonlEvent` gain an optional `sseEvent`.** Absent when the frame had no `event:` line. `schemaVersion` stays `1`. | Same argument as #41's `runtime` header key: an older decoder ignores an unknown object key and shows the capture as before; a new line kind would make it report an intact file as damaged. Absent, not `null`, so there is no claim when there is nothing to say. |
| **L3** | **`RouteHint` gains `langgraph-run`**, matching the four routes in §2, carrying `threadId` from the URL when the route has one and `runId` on a join route. | The URL is the strongest signal and is available before any byte of the response. |

### Dialect

| # | Decision | Rationale |
|---|---|---|
| **L4** | **Dialect is per connection**: `'agui' \| 'langgraph'`, decided by one pure function `dialectOf(request, firstEvent)` in `core/`. `langgraph` if the request matches L3; otherwise if the first event record has `sseEvent === 'metadata'` and a string `run_id`; otherwise `agui`. | Per-session would forbid the side-by-side case §14.1 names. Deriving it from the request line and first event — both stored — means an imported file classifies exactly as the live capture did, with nothing new persisted. Every existing capture classifies as `agui`, so nothing changes for it. |
| **L5** | **Every consumer that branches on dialect calls `dialectOf`** — run builder, redaction, fixture export, Timeline labels. | One rule, one place. If redaction and the builder ever disagreed about which connections are LangGraph, a redacted export would leak. |

### The expander

`core/normalizer/langgraph/expander.ts`, one state per connection. Input: a record
(`sseEvent`, parsed data, `seq`, `tMs`). Output:

```ts
interface LangGraphExpansion {
  runKey: string; // the run this frame belongs to (S3): '' for the top level
  events: { runKey: string; event: AguiEvent }[]; // synthetic, stamped with the record's seq/tMs
  issues: { runKey: string; issue: Issue }[]; // each on the run it is about (S3)
}
```

The mapping below is per scope (S4): a namespaced event folds exactly as its top-level form, into
its scope's child run (L11).

**L6 — the mapping.**

| LangGraph | Synthetic AG-UI |
|---|---|
| `metadata {run_id}` | `RUN_STARTED {runId: run_id, threadId: URL ?? data.thread_id}`; the run's `input` is the request body, by the builder's existing fallback |
| first non-`metadata` event with no run open | `RUN_STARTED {runId: 'lg:' + connId}` plus issue `lg-no-metadata` — except on a join route (`/threads/:t/runs/:r/stream`), which may attach mid-run after `metadata` was sent: it starts under the URL's run id and raises nothing |
| `messages` chunk, `type` ai / `AIMessageChunk` | `TEXT_MESSAGE_START` on the first chunk **with content**, then `TEXT_MESSAGE_CONTENT` per text delta; reasoning blocks → `REASONING_MESSAGE_START/CONTENT`; `tool_call_chunks` → `TOOL_CALL_START` when an entry's `id` or `name` is first known, `TOOL_CALL_ARGS` per `args` fragment, merged by `index` |
| message end: `chunk_position: 'last'`, a chunk for a different message id, or run end | `REASONING_MESSAGE_END`, `TOOL_CALL_END` for each open call, `TEXT_MESSAGE_END` |
| `messages` chunk, `type` tool | `TOOL_CALL_RESULT {toolCallId: tool_call_id, content}` once per id |
| `messages` chunk, `type` human / system | nothing — input messages come from the request |
| `messages/partial [msg]` | the suffix beyond the previous partial for that id, as the same events as a tuple delta |
| `messages/complete [msg…]` | message end for each; issue `lg-complete-mismatch` when the complete message does not extend what its partials streamed (a complete with no prior partials is normal) |
| `messages/metadata` | nothing |
| `values {…}` | `STATE_SNAPSHOT {snapshot}`; each `type:'tool'` message not yet seen → `TOOL_CALL_RESULT` |
| `values`/`updates` carrying `__interrupt__` | recorded on the run as an interrupt (L9); a `values` whose only key is `__interrupt__` emits no snapshot |
| `updates {node: …}` | `STEP_STARTED` + `STEP_FINISHED {stepName: node}` per key other than `__interrupt__` |
| `custom` | `CUSTOM {name: 'langgraph.custom', value: data}` |
| `error {error, message}` | close open messages — its scope's and every scope inside it (S5) — then `RUN_ERROR {message, code: error}` |
| connection close after an interrupt | close open messages, `RUN_FINISHED`; outcome `interrupted` |
| connection close, no `error` | close open messages; `RUN_FINISHED` if the request did not ask for `values`, or a top-level `values` / `messages/complete` / `checkpoints` arrived after the last message chunk — otherwise `lg-no-final-values` and no finish, so the run is `aborted`. With no request body (a join stream's GET, or a body that did not decode) `values` is **not** assumed requested: a join stream carries whatever modes the run was created with. A capture does not store why a connection closed, so a client abort between steps reads as a finish. Children follow the top run (S6); a join stream's close speaks for a run it did not open only when it saw the run end (S8) |

| # | Decision | Rationale |
|---|---|---|
| **L7** | **The id quirk is absorbed, not special-cased by prefix:** a message opens only on its first chunk carrying text, reasoning or a tool-call chunk. An empty chunk under an unseen id opens nothing. | The real recording has one empty `resp_…` chunk and 1,209 `lc_run--…` chunks. Keying on id alone invents a phantom empty message; matching on `resp_` couples us to one provider's id scheme. |
| **L8** | **A tool call with no `id` in its first chunk gets `messageId + '#' + index`**, and keeps it for the life of the call even if a later chunk carries a real id. | AG-UI requires the id at `TOOL_CALL_START`. Re-keying mid-call would split one call into two in the Messages tab. |
| **L9** | **`RunOutcome` gains `'interrupted'`.** The expander marks the run; the builder sets the outcome when the run closes normally after an interrupt. No wire field is invented on the synthetic `RUN_FINISHED`. | An interrupt is the normal human-in-the-loop pause, not an error and not a plain finish. Runs shows it; the AG-UI path never sets it, so nothing existing changes. |
| **L10** | **Synthetic events are stamped with their source record's `seq` and `tMs`** and are never Timeline rows. | TTFT, stalls and Waterfall timing come out right with no special handling, and Timeline keeps its promise of showing what was on the wire. |

**Implementation notes (PR 2).** Reasoning is the separate message `` `${id}:reasoning` `` and closes
when text or a tool call starts. A `values` event closes the open message. Tool results come from
`values` only for calls this run started — `values.messages` is the whole thread's history. Frames
after `error` fold nothing. `lg-undecodable` means a payload that is not the shape its event name
carries. The expander returned events without a `runKey` in PR 2 (top-level only, namespaced
events raw); PR 3 adds it and folds namespaced events into child runs (L11). Parallel tool calls whose chunks carry no `index` are split when a wire `id` differs
from the call's; a call opened under L8's synthetic id is never split when its real id arrives —
that id becomes an alias, so the tool's result still finds the call. `chunk_position: 'last'`
closes only its own message. A tool result closes the open message only if that message owns the
call. Tool-args validity (`lg-tool-args-invalid`) is checked when a message truly ends — its
`last` chunk, a `values`, an `error`, or the finish — not when another branch's chunk interleaves
and closes it for the moment.

### Subgraphs

| # | Decision | Rationale |
|---|---|---|
| **L11** | **`mode|ns…` events fold into a child run.** The expander keeps one **scope** per namespace (the top level is the scope keyed `''`); a scope's `runKey` is its namespace joined by `|` (`research:t1`, `research:t1|tools:c9`). A child's run id is `` `${topRunId}/${runKey}` `` and its `parentRunId` the run of the namespace one segment shorter (the top-level run for one segment) — **S1**. A scope opens on its first frame with `RUN_STARTED {runId, threadId, parentRunId}`, first for any ancestor not yet open, outermost first — **S2**. **A frame belongs to exactly one run, its own scope's:** its seq joins that run's `recordSeqs`, its bytes and wire name that run's metrics. Effects it has on other runs (a top-level error closing a child's message, a nested frame opening an ancestor) keep its seq and time but not membership — no seq, bytes or wire-name count there, so an ancestor that sent no frame holds no records — **S3**. The builder keeps a per-connection map `runKey → runId` and routes each synthetic event by its `runKey`; **a child run never takes over the connection's current run** (`openRunId`), so the next top-level frame and the next keepalive stay with the top-level run. | `Run.parentRunId` already exists. Threadplane itself routes namespaced messages out of the main transcript into subagents; child runs are the same separation in this model. Ids mirror LangGraph's own namespace nesting (§9 Q2). One frame, one run keeps the Runs table, a run-scoped Timeline and a single-run export exact, and event count equal to wire-name count (L13). The AG-UI path uses no map and is unchanged. |

**PR 3 decisions.**

| # | Decision | Why |
|---|---|---|
| **S4** | Within a scope every mode folds exactly as at the top level, with the scope's own message, tool and partial state. `metadata` is never namespaced. | One code path; a subgraph is a graph. |
| **S5** | An `error` ends its scope **and its subtree**: every scope inside it is settled (open messages closed, args checked), innermost first, then the scope itself. `RUN_ERROR` goes to the errored scope only; scopes inside it get no terminal event and are recorded `aborted`. Later frames from that subtree are recorded on the errored scope's run and fold nothing. Its parent and siblings carry on; a top-level error's subtree is everything. | A failure stops every subgraph inside the failed graph mid-flight, at any depth; a subgraph failure the parent survives is a child error. |
| **S6** | At close every scope is settled, deepest first, each scope's issues anchored to its own last frame. If the top run finishes (normally or at an interrupt), every child not cut off by S5 gets `RUN_FINISHED` before the top run's. Otherwise children get nothing → `aborted`. `lg-no-final-values` is a top-level check, anchored to the connection's last top-level frame (falling back to its last frame). | Children end with their parent; a subgraph cannot finish inside a run that was cut off. |
| **S7** | `finish` reports the runKeys that stopped at an interrupt; each is recorded `interrupted`. **Issues carry their run:** every issue names the runKey it is about (`lg-no-metadata` is always the top run's; a cut-off scope's bad args are that scope's), and one raised away from that run's own frames anchors to that run's last frame on this connection. | Interrupts and issues are per run now. |
| **S8** | **A join stream continues its run** (§9 Q5). A LangGraph connection whose `RUN_STARTED` names a run that already exists folds onto it, but **only the connection that created a run can abort it**: a reused run is not registered on the joining connection. The join's finish settles the run only if the join saw the run end (its final `values`, or an interrupt) — then it is authoritative, even while the original connection is open, and upgrades an `aborted` run to `finished`. A join that closes before that leaves the run as it was. A join GET has no body, so `values` is not assumed requested and it raises no `lg-no-final-values`. `aborted` never overwrites a terminal outcome. | A second run with the same id cannot exist in a map keyed by run id; "the later connection's close wins" either aborts a run that is still streaming or loses the truth that it finished. |

### Validation and metrics

| # | Decision | Rationale |
|---|---|---|
| **L12** | **AG-UI validator rules do not run on synthetic events. The expander raises LangGraph issues instead:** `lg-unknown-event` (name not in the known set), `lg-no-metadata`, `lg-partial-regressed` (a partial that does not extend the previous one), `lg-tool-args-invalid` (accumulated args not JSON at call end), `lg-complete-mismatch`, `lg-no-final-values` (closed without a top-level `values`, **only** when the request's `stream_mode` included `values`), `lg-undecodable` (a payload that is not the shape its event name carries). | Synthetic events are correct by construction; an AG-UI issue on one would be our translation bug reported as the user's. `lg-no-final-values` is the condition Threadplane's own bridge treats as "interrupted", so it is a real diagnostic — but only meaningful if `values` was asked for. |
| **L13** | **`eventCountByType` counts wire event names for LangGraph runs** (`messages`, `values`, `messages|research:…`), not synthetic types. Other metrics read synthetic events. | The Runs table's event count must equal the number of Timeline rows for the run. |

### Panel

| # | Decision | Rationale |
|---|---|---|
| **L14** | **Timeline row label is `sseEvent` for LangGraph connections.** The detail pane keeps the raw payload and adds a **Derived** section listing the synthetic events the record produced (from a builder query, `derivedFor(seq)`). *Built in PR 4a:* the builder never leaves `live-session.ts` / `load-jsonl.ts`, so the derived events are recorded on the run they fold onto instead — `Run.derived`, keyed by source seq, excluding close-time events — and the Derived section gathers `run.derived.get(seq)` across all runs (a frame can close a child it does not belong to, S3). A frame read as nothing says so. A `messages` tuple's payload and row summary show what it decoded to, not "unparsed". | The user sees the wire as it was and how we read it, side by side — which is also how a translation bug gets reported. |
| **L15** | **Session's transport row names the dialect per connection** ("LangGraph Platform", "AG-UI"). *Built in PR 4a* as its own **Protocol** row after Transport, classifying each connection with `dialectOf` (request line + first event record): `AG-UI`, `LangGraph Platform`, or both with per-protocol connection counts; an empty capture reads as the Transport row does, "nothing on the wire yet, which is normal before the first message". | The side-by-side case is invisible otherwise. |

### Redaction and export

| # | Decision | Rationale |
|---|---|---|
| **L16** | **`redact.ts` gains LangGraph rules over the same five groups**, selected by `dialectOf`: message and text-block content → `text`; reasoning blocks and summaries → `reasoning`; `tool_call_chunks[].args`, `tool_calls[].args` → `toolArgs`; `type:'tool'` message content → `toolResults`; `values` / `updates` payloads (excluding `__interrupt__` structure) → `state`. The request line's `input` is redacted as today. | Without this the privacy policy's description of a redacted export is false for LangGraph captures. Messages appear inside `values` too, so `state` and `text` both apply there — a redacted `text` group must reach them either way. Until then (PR 1), `redactEvent` fails closed: any payload that is not a known AG-UI event is redacted in full when any group is selected, keeping only keys, shape, the line's `sseEvent`, and — on an unnamed payload only — a `type` that follows AG-UI's UPPER_SNAKE naming. Exception: a NAMED payload whose `sseEvent` equals its own `type`, and that `type` is a known AG-UI type, is treated as AG-UI and redacted through the normal per-field path instead — the one case where a named frame can be positively identified as AG-UI rather than merely not ruled out. |
| **L17** | **The E6 leak check runs on a redacted LangGraph fixture** and restates §11 for this format rather than importing the redactor. | Same reason as E6: `redact.ts` has shipped a hole its own tests could not see. |
| **L18** | **E7's fixture export writes `{event, data}` pairs for LangGraph connections** instead of bare payloads. | A bare `data` array without names is not replayable by anything. This is the minimum to stay truthful; the `MockAgentTransport` module is §14.2. |

## 6. Structure

```
core/detect/classifier.ts           + langgraph-run route hint (L3)
core/normalizer/dialect.ts          dialectOf (L4)
core/normalizer/langgraph/
  expander.ts                       per-connection state machine (L6–L11)
  messages.ts                       chunk/partial merging by id and index
  names.ts                          known event names, namespace parsing
core/normalizer/run-builder.ts      open-run map; route by runKey; skip AG-UI rules for synthetic
core/jsonl/codec.ts, redact.ts      sseEvent (L2); LangGraph rules (L16)
inject/protocol.ts, fetch-patch.ts, wire-frame.ts, relay/relay.ts, sw/index.ts   eventName (L1)
panel/tabs/timeline/, panel/tabs/session/                                        L14, L15
```

The expander is Chrome-free and pure over its state, like the rest of `core/`.

## 7. Testing

- **Golden fixtures** (`src/test/fixtures/lg-*.agui.jsonl`):
  - `lg-reasoning` — the real Python recording, trimmed to a few hundred chunks; covers reasoning
    and text blocks, the id quirk, the usage-only last chunk, final `values`. Asserts the Messages
    reconstruction equals the recording's `canonical_text`.
  - `lg-tools`, `lg-subgraph`, `lg-interrupt`, `lg-error` — built from `langgraph-api`'s test
    sequences (`api.test.mts`); tool args split across chunks, namespaced events, `__interrupt__`,
    `error` as last event.
  - `lg-legacy` — `messages/partial|complete|metadata`, including one regressing partial.
  - `lg-malformed` — exactly the L12 issues at known seqs, in the style of done-when #5.
- **Round-trip:** export → clear → import on each LangGraph fixture; tabs identical, `sseEvent`
  preserved, redacted and not.
- **Capture:** unit tests that the event name survives inject → relay → sw, including the relay's
  hostile-input guard; a pretty-printed multi-line `data:` payload decodes.
- **Harness:** the server gains `/threads/:id/runs/stream` writing named events with multi-line
  `data:`; a second page client uses `@langchain/langgraph-sdk` (harness dev dependency only — the
  extension gains none). One e2e captures a LangGraph run; one captures an AG-UI run and a
  LangGraph run from the same page.
- **Visual gate:** every tab on a LangGraph capture, a redacted one, and a subgraph one; Timeline
  labels are wire names; Runs shows `interrupted`.
- **Mutations to watch fail:** relay drops `eventName`; `dialectOf` returns `agui`; expander opens
  on empty chunks; redaction skips `values`.

## 8. Sequencing

One PR each, merged on green:

1. **Event names survive** — L1, L2, L3. Unredacted AG-UI captures are unchanged; LangGraph
   captures now keep their names. A redacted export now also redacts, in full, any frame that
   fails to parse, any unknown-type event, and any named frame that is not the AG-UI event it
   names — an interim rule (see L16) that fails closed rather than shipping unrecognised content
   verbatim.
2. **The expander** — L4–L10, L12, L13, L18 in `core/`, top-level runs only, golden fixtures.
   (L18 lives here, not in PR 1, because it branches on `dialectOf` per L5.)
3. **Subgraphs** — L11, S4–S8: expander scopes, the builder's per-connection `runKey → run` map,
   join streams.
4. **Panel and privacy** — L14–L17, harness e2e, visual gate. Split in three:
   - **4a — the panel:** L14, L15, and the visual gate drawing a real LangGraph capture and a
     subgraph.
   - **4b — field-level redaction:** L16, L17.
   - **4c — harness e2e.**

## 9. Open questions

1. `TOOL_CALL_RESULT` can arrive twice (as a `messages` tool chunk and inside `values`); L6 dedupes
   by `tool_call_id`. If a graph emits a tool message with no `tool_call_id`, it is kept in state
   only. Acceptable for v1?
2. Child-run ids (`parent/ns`) are ours, not LangGraph's. A namespaced `metadata` does not exist to
   give them a real id. Fine for display; worth noting before §14.2 exports per-run fixtures.
3. Interleaved parallel branches: the expander keeps one message open at a time, so chunks
   alternating between two message ids produce repeated START/END pairs for the same ids. The
   builder merges them into one message each, but per-message durations and stall detection are
   choppy. Keeping several messages open at once, each closed by its own `last` / `values` /
   `error` / finish, is the fix if this shows up in real captures.
4. Live-capture eviction: a snapshot rebuilt after the worker evicted a connection's first frame
   re-decides its dialect from what survives — the same degradation class as AG-UI losing
   `RUN_STARTED`.
5. **Decided in PR 3 (S8).** Two connections sharing one LangGraph run id (a join stream after the
   original POST) fold into the one run; only the creating connection can abort it, and a join that
   saw the run end finishes it. Known limit: a join that **replays** the stream from the start
   (`stream_resumable` with `Last-Event-ID: 0`) appends its content a second time — captures do not
   store SSE `id:`s, so the replay cannot be told from new content.
6. The URL wins over the payload in `dialectOf`: a non-LangGraph stream on a route that matches L3
   would be expanded, and every frame flagged `lg-unknown-event`.
