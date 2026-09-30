# Threadplane fixture export (§14.2) — design

**Date:** 2026-09-30
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §14.2
**Depends on:** LangGraph Platform support (§14.1; [`2026-09-29-langgraph-normalization-design.md`](2026-09-29-langgraph-normalization-design.md)), all merged.

§14.2: *"Captured run → a test file that replays it through Threadplane's transport seam … Prod bug to failing test in one click. Highest-value item on the list."*

---

## 1. The seam

`@threadplane/langgraph` (0.2.0) exports `MockAgentTransport`, `provideAgent`, `injectAgent` and the `StreamEvent` type. A test wires `provideAgent({ apiUrl: '', assistantId, transport, throttle: false })` in `TestBed`, gets the agent with `injectAgent()`, calls `submit(...)`, feeds events with `await transport.emit([...])`, then `await transport.close()` and awaits the submission. `MockAgentTransport` replays `StreamEvent`s — the objects `FetchStreamTransport` yields — **not** raw SSE frames.

The real transport maps each SDK frame `{event, data}` to a `StreamEvent` with `normalizeSdkEvent` (`fetch-stream.transport.ts`), which is **private**. The LangGraph SDK passes frames through unchanged (`event` is the SSE name, `data` the parsed payload), so the frames this extension captures are exactly the SDK's input to that function.

How the replay ends is decided by the bridge exactly as for a live run: a stream whose last root event is a top-level `values` (after the last assistant chunk) ends `idle` (success); a stream cut off mid-answer ends `error` (interruption); a final `values` with `__interrupt__` ends paused (`idle`, `interrupt()` set). All three are the faithful result of replaying that capture.

No existing Threadplane test replays a recorded stream through `MockAgentTransport`; this is the first.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **T1** | **The generated file holds the raw captured frames `{event, data}` plus an embedded copy of Threadplane's `normalizeSdkEvent`** (named `toStreamEvent`, with a comment naming the Threadplane version it mirrors), rather than pre-normalized `StreamEvent` literals. | The fixture stays exactly what was captured — readable, diffable, the same shape as the recording Threadplane already keeps. Pre-normalized events duplicate every record payload (`...data` spread plus `data`). The copy is ~20 lines; pinning its version makes a future drift visible. |
| **T2** | **One `it` per LangGraph connection in the export scope**, each with its own `MockAgentTransport` and `TestBed` module. Subgraph frames stay in their connection's replay. A join stream (S8) is its own connection and its own `it`. | One connection is one `stream()` call. Threadplane routes namespaced events to subagents itself, so splitting them out would replay something no client ever saw. |
| **T3** | **Submission replays the captured request:** `agent.submit({ state: request.input })` when the body has an `input`; `submit({ resume })` when the body is a `command.resume`; the `assistantId` is the body's `assistant_id`. The test also asserts `transport.streams[0].payload` equals what was submitted. | `submit({ state })` forwards `state` verbatim, so the transport sees the captured input. |
| **T4** | **Generated assertions are what the capture shows**, limited to what both the extension and Threadplane read the same way: `status()` (`idle` / `error`), `interrupt()` present or not, the last assistant message's text, and the tool-call names in order. A comment says: *these are what the capture shows — change them to the behaviour you want, and the test fails until it's fixed.* | The test passes on day one (proving the replay is faithful) and is one edit from a failing regression test. Richer assertions risk failing out of the box on interpretation differences between the extension's run model and Threadplane's. |
| **T5** | **Redaction applies.** The spec is built from the same export lines as every other format, so a redacted export yields a redacted spec, with the redaction note at the top (as E7 does). Assertions derived from redacted content use the redacted values, so a redacted spec still passes. | One policy path. A spec with placeholders is still a faithful replay of that file. |
| **T6** | **UI: a new Export button, "Download Threadplane test (.spec.ts)"**, beside the existing TypeScript fixture button, enabled when the scope holds at least one LangGraph connection; disabled otherwise with the reason stated plainly. Filename `threadplane-<host>-<capturedAt>.spec.ts`. | Discoverable next to E7; the reason text follows the panel's rule for absences. |
| **T7** | **Acceptance: generated specs run inside Threadplane.** A script in this repo (`pnpm verify:threadplane <path-to-threadplane-checkout>`) generates specs from `lg-reasoning`, the harness tools+subgraph capture and the interrupt capture, drops them into `libs/langgraph/src/lib/__devtools_replay__/`, runs Threadplane's Vitest on them, and removes them. Run on demand and before release, not in CI (CI has no Threadplane checkout). | The only real proof of "prod bug → failing test in one click". |

## 3. Structure

```
core/fixture/threadplane.ts      pure: JsonlLine[] (+ runs) → spec text; per-connection selection; toStreamEvent source
core/fixture/threadplane.test.ts shape, determinism, per-connection split, redaction note, assertions derivation
panel/export/export-panel.tsx    the button (T6)
panel/export/filename.ts         threadplaneFilename
scripts/verify-threadplane.ts    T7
```

`core/` because it is a pure function of export lines and runs (T0 of the export design), and a CLI could reuse it.

## 4. Testing

- Unit: the generated text for a small capture (golden snapshot of the whole file); one `it` per connection; the `toStreamEvent` copy is byte-identical to a pinned string (so a change is deliberate); assertions derived correctly for finished / interrupted / cut-off / tool-call captures; redaction note and placeholders.
- **Behavioural (in this repo):** the generated `toStreamEvent` is evaluated against the captured frames and compared with a reference implementation of Threadplane 0.2.0's mapping for every frame of `lg-reasoning` and the harness scenarios (catches a broken copy without Threadplane).
- Visual gate: the button enabled on `lg-reasoning`, disabled with its reason on `happy-run`; a real click downloads a `.spec.ts` whose text contains `new MockAgentTransport`.
- T7 acceptance run, with its output in the PR.

## 5. Out of scope

- Keeping `toStreamEvent` in sync automatically with a newer Threadplane: the pinned version comment and T7 surface drift.
- AG-UI captures → `@threadplane/ag-ui` `FakeAgent` scripts (discussed and set aside: `FakeAgent` re-wraps run boundaries).
- Replaying multiple connections of one thread in a single agent session.
