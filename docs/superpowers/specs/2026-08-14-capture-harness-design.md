# Capture harness — design

**Date:** 2026-08-14
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §5, §11, §13, §15
**Panel design:** [`2026-08-14-panel-ui-design.md`](2026-08-14-panel-ui-design.md)
**Status:** `core/` and the phase-1 panel are complete — 675 tests, CI green including a visual gate.
The capture layer (`inject/`, `relay/`, `sw/`) is not built.

This designs the test harness the capture layer will be built against. It is not a separate
milestone: it ships *with* capture, harness first, because capture currently has nothing to capture.

---

## 1. The problem it solves

Three of the last four defects in this project were found by running the software, not by testing
it — an invisible panel, rows that blended into one block, and detection that was technically
correct and practically useless. None were visible to the test suite.

The capture layer is about to be built with **no traffic to build against**. Nothing in existence
produces a `.agui.jsonl` except three fixtures we wrote by hand. Those fixtures encode our
*assumptions* about AG-UI; if an assumption is wrong, all 675 tests agree with us.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| H1 | **Use `@copilotkit/aimock`'s `AGUIMock`**, not a hand-rolled SSE server | Public npm (v1.38.0), maintained by the CopilotKit team, and already proven in the Threadplane monorepo. Its `AGUIFixture` is `{ match, events: AGUIEvent[], delayMs? }` — we control the event array outright, which is what makes malformed streams possible. Building our own would duplicate it and drift from the protocol. |
| H2 | **Deterministic loop first; real agents as a periodic check** | A real LLM-backed agent is slow, costs money, and emits a different stream every run. That is a bad dev loop and an impossible regression test. The scripted path runs free and instant in CI; realism arrives via recording, not via live calls. |
| H3 | **Drive the page with the real `@ag-ui/client` `HttpAgent`**, plus minimal message rendering | A hand-rolled `fetch` would test our idea of what a client does. The real client produces the exact request shape the capture layer must handle — measured on a production deployment: `fetch` POST with `Accept: text/event-stream`. Rendering additionally enables the panel-vs-app comparison that the Messages tab exists for. |
| H4 | **The automated loop stops at captured data, not rendered panel state** | Verified: Playwright loads the extension and the service worker registers, but the DevTools panel UI is unreachable — DevTools is shadow-encapsulated and its targets do not attach cleanly. Panel rendering is already covered by 320 jsdom tests and the screenshot gate. This tests the half that has no coverage. |
| H5 | **Assertions read the ring buffer out of the MV3 service worker** | Playwright can evaluate inside a service worker, and the SW is confirmed reachable. This is what makes H4 practical rather than aspirational — no panel, no export, no UI automation required. |
| H6 | **A new private workspace package, `packages/harness`** | Keeps Playwright, aimock, and `@ag-ui/client` out of the shipped extension's dependency tree, while `pnpm -r` picks it up for CI automatically. The shipped bundle stays Preact-only. |
| H7 | **Recorded fixtures are redacted before they are committed** | A fixture recorded from a real run contains real model output; recorded from production it could contain real user content. Requirements §11 is unambiguous. `redact.ts` is built, tested, and currently unreachable — recording is its first real consumer. |
| H8 | **The API key never enters the CI loop** | Recording is a local, occasional operation, mirroring the existing `aimock-drift` pattern. CI only ever replays committed fixtures. `.env` and `.env.*` are already gitignored; a committed `.env.example` documents the variable name and nothing else. |

---

## 3. Architecture

```
aimock AGUIMock ──── SSE ────▶ harness page ────▶ inject/ → relay/ → sw/
   ▲   fixture:                @ag-ui/client              (ring buffer)
   │   { match, events[],       HttpAgent                        │
   │     delayMs }              + minimal render                 │
   │                                                             ▼
   └── record mode                            Playwright evaluates in the
       from a real upstream                   service worker and asserts
```

The page is served over `localhost`, which decision D3 auto-enables — so the harness needs no
per-origin grant, and the opt-in flow can still be exercised deliberately by serving on `127.0.0.1`
versus a non-localhost host alias.

## 4. Layout

```
packages/harness/           private: true — never published, never bundled
  server/                   wraps AGUIMock; serves fixtures over real SSE
  page/                     minimal client: HttpAgent + plain message rendering
  fixtures/                 aimock fixtures — authored edge cases + recorded traffic
  record.ts                 record from a live upstream → redacted fixture
  e2e/                      Playwright: load extension, drive page, assert the ring buffer
```

## 5. The fixture symmetry

Two formats, with a deliberate relationship:

- an **aimock fixture** is the *input* — the events the server emits
- a **`.agui.jsonl`** is the *output* — what the capture pipeline reconstructed

The three existing golden fixtures convert to aimock fixtures mechanically, so the same streams
that already test `core/` offline also test the capture layer online — **one corpus, two levels**.
The round trip is then an equivalence proof: what the server emitted must equal what capture
produced, modulo the fields capture legitimately adds (`seq`, `tMs`, `connId`).

## 6. What this covers that nothing does today

| Behaviour | Today | With the harness |
|---|---|---|
| Malformed streams | handwritten fixtures, offline only | served over the wire on demand |
| `tee()` back-pressure (§15) | untested | `delayMs` plus a deliberately slow consumer |
| Keepalive gaps > 15 s | code path unreachable | scriptable, so `keepalive-gap` finally fires |
| MV3 SW termination (§15) | untested | idle past the timeout, assert buffer recovery |
| Protobuf transport (§5.4) | untested | serve `application/vnd.ag-ui.event+proto`, assert the binary-labelled state |
| Per-origin opt-in (D3) | untested | localhost auto-enables; a host alias exercises the grant |
| Chunk cadence realism | assumed | recorded from a real run |

## 7. Recording, and why it matters most

`AGUIRecordConfig` is `{ upstream, fixturePath?, proxyOnly? }` — aimock can sit in front of a real
AG-UI endpoint and record what it emits.

This is the highest-value part of the harness, because it is the only thing that can tell us our
handwritten fixtures are wrong. Two tiers:

- **Tier A — authored, no key, no backend.** Hand-written aimock fixtures for edge cases: empty
  deltas, bad patch paths, missing terminal events, long keepalive gaps. This is the CI corpus.
- **Tier B — recorded, local only.** With `OPENAI_API_KEY` in the root `.env`, run a real agent and
  record genuine traffic. Grounds Tier A against reality and answers the outstanding protobuf
  question as a side effect, since we would observe what the real deployment negotiates.

Tier B output passes through `redact.ts` before it is committed (H7).

## 8. Sequencing

The harness is built **first**, then the capture layer against it. That is the same move that made
the phase-1 panel buildable — reuse the path already known to be correct, one layer further out.

Concretely: harness serving a fixture over SSE, with a page that fetches it and a Playwright test
asserting the service worker saw *nothing* (because `inject/` is still a stub) — is a legitimate
first green test. Every subsequent capture commit turns more of that assertion positive.

## 9. Open questions

1. ~~**aimock's `AGUIMock` is unproven for us.**~~ Resolved during planning: stood up, and two
   limits found (F1) — it cannot emit SSE comments or a non-`text/event-stream` content type, so
   the harness server writes those two scenarios itself.
2. ~~**What real agent does Tier B record from?**~~ **Resolved: the AG-UI Dojo**, `builtin`
   integration → `BuiltInAgent` (`openai/gpt-5-mini`) at
   `/api/copilotkitnext/builtin/agent/default/run`. No Python backend, no second process — just
   `OPENAI_API_KEY` (F6). Recorded 2026-08-15; see `packages/harness/fixtures/recorded/`.
3. **How much rendering does the harness page need?** Enough to compare against the Messages tab is
   more than enough to test capture. Start minimal; grow only if the comparison earns it.

## 10. What Tier B found on its first run

Recorded 2026-08-15. The recording was **refused**: the H7 redaction gate caught a payload string
surviving `redact.ts`, wrote nothing, and named the file to fix. The defect behind it:

**`RUN_STARTED` carries an optional `input` field** (`@ag-ui/core`'s `RunStartedEventSchema`) that
echoes the whole `RunAgentInput` back over the wire — the user's messages, the app's state, its
forwarded props. `redact.ts` handled that payload on the captured *request* line and had no case
for it on the *event*, so the identical content shipped unredacted from a different field.

This is the failure mode §1 predicts, arriving exactly as predicted: all three hand-written golden
fixtures omit `input`, so 355 core tests agreed that lifecycle events carry nothing to protect,
while a real deployment sends it on every run. Nothing in the suite could have found it, because
the suite and the fixtures shared one assumption.

A second hole surfaced in the same function while fixing the first: the captured request body was
gated wholesale on the `state` group, so selecting `text` — the group whose plain meaning is "my
prompts" — still exported the user's own messages verbatim. Group ownership is now per field:
message content → `text`, a `tool`-role message body → `toolResults`, tool call arguments →
`toolArgs`, and `state`/`context`/`forwardedProps` → `state`. A tool *schema* survives under every
group: it is developer-authored structure, no §11 group owns it, and it is most of what makes a
captured run legible.

The harness's own leak checker shared the blind spot — it deliberately restates §11 rather than
importing `redact.ts`, but it restated the same incomplete list — so `payloadStrings` in
`record.ts` now covers `RUN_STARTED.input` too.
