# `ag-ui-harness`

A private test harness. It serves real AG-UI streams over real sockets and drives the extension's
capture layer through a real Chromium, because 900-odd unit tests can only ever agree with our own
idea of what a stream looks like (design §1).

Nothing here ships. The package is `private`, and the extension bundle depends on none of it.

| Directory | What it is |
|---|---|
| `fixtures/` | The `SCENARIOS` corpus — Tier A, hand-authored plus the three golden `.agui.jsonl` fixtures converted. `langgraph.ts` holds the LangGraph Platform scenarios (below). |
| `server/` | `startHarnessServer` — `AGUIMock` for the scenarios it can serve, and a hand-written stream for the two it cannot (finding F1). `langgraph-server.ts` — the LangGraph run-stream routes. |
| `page/` | A minimal page driving runs with the real `@ag-ui/client` `HttpAgent`, plus the server that hosts it. `langgraph.html` is the LangGraph client. |
| `e2e/` | Playwright: loads the built extension unpacked and reads the ring buffer out of the MV3 service worker. |
| `record.ts` | Tier B recording. Local only — see below. |

Everything runs through Playwright, including the plain unit suites (`page/render.test.ts`,
`record.test.ts`): one runner, one report.

    pnpm --filter ag-ui-harness test

The e2e loads `packages/devtools/dist`, so `pnpm build` has to have run — `test/global-setup.ts`
does it for you.

## LangGraph Platform scenarios

A LangGraph stream is not AG-UI on the wire: the event type is the SSE `event:` name, and the JS
server pretty-prints every payload across many `data:` lines. `server/langgraph-server.ts` writes
exactly that, cut into 256-character pieces with no regard for frame boundaries, from the PAGE
server's own origin — the `/agui` proxy rewrites paths, and `/threads/:threadId/runs/stream` is
the strongest dialect signal the extension has.

| Route | Answers |
|---|---|
| `POST /threads/:threadId/runs/stream` | The scenario named by the body's `assistant_id`; 404 for any other. |
| `GET /threads/:threadId/runs/:runId/stream` | A join: the `joinFrames` of the scenario whose `metadata.run_id` is `:runId`. |

| Scenario | Frames | What it is |
|---|---|---|
| `lg-reasoning` | 1213 (908 KB on the wire) | The real Python-server recording (`devtools/src/test/fixtures/lg-reasoning.agui.jsonl`), converted whole by `convertLangGraphGolden`. |
| `lg-tools-subgraph` | 13 | A subgraph under `research:t1`, a tool call with args split across chunks, its result, a final answer. |
| `lg-interrupt` | 5 | A run ending on `__interrupt__`. |
| `lg-join` | 2 + 2 | A POST that drops before its final `values`, and a join that finishes the run. |

`page/langgraph.html?scenario=<name>&thread=<id>[&join=<runId>][&agui=1]` drives them with a raw
`fetch` — no `@langchain/langgraph-sdk`: the extension patches `fetch`, so the SDK would add
nothing capture can see. `agui=1` runs the AG-UI `happy` scenario through `HttpAgent` first, for
one page carrying both dialects.

`e2e/langgraph.spec.ts` asserts every captured frame kept its name and decoded payload, the
request line and dialect, and the folded runs — through both `reconstruct` and `foldAsLatePanel`,
which must agree. `lg-reasoning` captures and settles in roughly 0.3–0.8 s.

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

The recorder itself is covered without a key, an upstream, or a cost: `record.test.ts` stands up
a local SSE server emitting unmistakable text, proxies it through a real `AGUIMock`, and asserts
the committed fixture is clean (decision H2 applied to the recorder itself).
