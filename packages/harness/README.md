# `ag-ui-harness`

A private test harness. It serves real AG-UI streams over real sockets and drives the extension's
capture layer through a real Chromium, because 900-odd unit tests can only ever agree with our own
idea of what a stream looks like (design §1).

Nothing here ships. The package is `private`, and the extension bundle depends on none of it.

| Directory | What it is |
|---|---|
| `fixtures/` | The `SCENARIOS` corpus — Tier A, hand-authored plus the three golden `.agui.jsonl` fixtures converted. |
| `server/` | `startHarnessServer` — `AGUIMock` for the scenarios it can serve, and a hand-written stream for the two it cannot (finding F1). |
| `page/` | A minimal page driving runs with the real `@ag-ui/client` `HttpAgent`, plus the server that hosts it. |
| `e2e/` | Playwright: loads the built extension unpacked and reads the ring buffer out of the MV3 service worker. |
| `record.ts` | Tier B recording. Local only — see below. |

Everything runs through Playwright, including the plain unit suites (`page/render.test.ts`,
`record.test.ts`): one runner, one report.

    pnpm --filter ag-ui-harness test

The e2e loads `packages/devtools/dist`, so `pnpm build` has to have run — `test/global-setup.ts`
does it for you.

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
