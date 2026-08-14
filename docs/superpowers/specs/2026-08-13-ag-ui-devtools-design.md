# AG-UI DevTools — Workspace & `core/` Design

**Date:** 2026-08-13
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md)
**Scope of this pass:** pnpm workspace scaffold, one publishable extension package, and a
complete, tested `core/` layer. Capture, service worker, and panel ship as stubs.

---

## 1. Decisions

Taken from the requirements spec's §0 unless noted.

| # | Decision | Value |
|---|---|---|
| D1 | Name | `AG-UI DevTools`, package `ag-ui-devtools` |
| D2 | License | MIT, standalone public repo |
| D3 | Capture default | Opt-in per origin; localhost family auto-enabled |
| D4 | `@ag-ui/core` | devDependency only; generated event table is committed |
| D5 | Surface | DevTools panel only |
| D6 | Validation targets | AG-UI Dojo, CopilotKit v1.50 quickstart, malformed fixture |
| **D7** | **Scope of first pass** | **Scaffold + `core/` implemented test-first** |
| **D8** | **Publishing** | **Zip artifact attached to a GitHub release; manual CWS upload** |
| **D9** | **JSON Patch** | **Hand-rolled, apply-only RFC 6902; zero runtime dependencies** |
| **D10** | **`core/` boundary** | **SSE parser and classifier live in `core/`, not `inject/`** |

D7–D10 are new decisions made during this design session. D9 and D10 deviate from the
requirements spec and are justified in §4 and §3 respectively.

---

## 2. Workspace layout

```
pnpm-workspace.yaml          packages: ['packages/*']
package.json                 private root; scripts delegate with `pnpm -r`
tsconfig.base.json           strict, ES2022, moduleResolution: bundler
LICENSE                      MIT
README.md
.github/workflows/ci.yml
docs/
  spec/ag-ui-devtools-v0.1.md
  superpowers/specs/
packages/
  devtools/                  name: ag-ui-devtools, private, version 0.1.0
```

One package, matching the request. The root is a thin orchestrator rather than a
single-package repo so that a second consumer of `core/` — a CLI, or a VS Code panel, both
named as future reuse targets in the requirements — can be added without restructuring.

### Package internals

```
packages/devtools/
  manifest.config.ts         typed manifest, emits requirements §12 verbatim
  vite.config.ts             Vite 8 + CRXJS 2.7.1
  vitest.config.ts           node environment
  eslint.config.js
  tsconfig.json
  scripts/gen-event-table.ts
  public/icons/
  src/
    core/                    Chrome-free
    inject/                  stub
    relay/                   stub
    sw/                      stub
    panel/                   stub
    test/fixtures/
```

---

## 3. The `core/` boundary

`core/` contains no Chrome APIs, so it runs under Node in Vitest and can be lifted into a
CLI later. The boundary is enforced, not merely documented:

- an ESLint `no-restricted-globals` rule on `chrome`, scoped to `src/core/**`
- a test asserting no `chrome.` reference survives into `core/`'s build output

**Deviation from requirements §13 (D10).** The requirements place `sse-parser` and
`classifier` under `inject/`. Both are pure functions with no Chrome API surface, and both
carry the edge cases most in need of golden-fixture tests — frames split across chunk
boundaries, CRLF framing, heartbeat comments, content-based AG-UI classification. Leaving
them in `inject/` would put the most test-hungry logic on the wrong side of the testable
boundary. They move to `core/sse/parser.ts` and `core/detect/classifier.ts`; `inject/`
imports them.

### Modules

| Module | Responsibility |
|---|---|
| `events/event-table.generated.ts` | Emitted by `scripts/gen-event-table.ts` from `@ag-ui/core`'s Zod schemas. Per-`EventType` field names, types, required flags. Committed to the repo. |
| `events/table.ts` | Lookups over the generated table; deprecated set (`THINKING_*`); chunk → triad mapping |
| `events/shape-check.ts` | Raw object → `Issue[]`. Hand-rolled; no Zod in the shipped bundle |
| `sse/parser.ts` | Incremental frame parser. Chunk-boundary and CRLF safe. Keepalive comments surfaced separately from events |
| `detect/classifier.ts` | Content-first (§4.1), route hints second (§4.2). Returns `agui` / `provisional` / `not-agui` / `binary` |
| `model/types.ts` | `CaptureRecord`, `Run`, `Issue`, `ReconstructedMessage`, `ToolCallRecord`, `ActivityRecord`, `StepRecord`, `StateFrame`, `RunMetrics` |
| `normalizer/chunk-expander.ts` | `*_CHUNK` → start/content/end triads, matching the JS client's behaviour |
| `normalizer/run-builder.ts` | Incremental fold of `CaptureRecord`s into runs; synthetic `orphaned` run for parentless events |
| `state/json-patch.ts` | RFC 6902, apply-only |
| `state/timeline.ts` | Snapshot/delta frames; each frame retains the patch that produced it and any failure |
| `validator/rules/*.ts` | One file per requirements §7 category. Each rule is a pure `(record, runState) => Issue[]` registered in an array |
| `metrics/run-metrics.ts` | Duration, TTFT, inter-token gap p50/p95/max, stalls, per-tool latency, byte and event counts |
| `jsonl/codec.ts` | `.agui.jsonl` encode; streaming line-by-line decode |
| `jsonl/redact.ts` | Redaction profile; `«redacted: N chars»` |

### Data flow

```
bytes → sse/parser → frames → detect/classifier → CaptureRecord
      → normalizer/chunk-expander (optional, toggleable)
      → normalizer/run-builder → Run
          ├─ validator/rules  → Issue[]
          ├─ state/timeline   → StateFrame[]  (via state/json-patch)
          └─ metrics          → RunMetrics
      → jsonl/codec ⇄ .agui.jsonl   (jsonl/redact applied on export)
```

`run-builder` is incremental — one record at a time — so the panel can render a live
stream without rebuilding the model on every frame, and so import replays through exactly
the same path as live capture. That shared path is what makes requirements Done-when #6
(export → clear → re-import → identical) meaningful rather than a separate code path that
happens to agree.

---

## 4. JSON Patch: hand-rolled (D9)

Apply-only RFC 6902, roughly 150 lines, no dependency.

Requirements §7 asks the validator to highlight *the specific failing operation* inside a
`STATE_DELTA`. A library that throws on the first bad op gives a message, not a position.
The hand-rolled applier returns a discriminated result instead:

```ts
type PatchResult =
  | { ok: true; value: unknown }
  | { ok: false; opIndex: number; op: PatchOp; reason: PatchFailure };
```

`opIndex` is what the State tab's scrubber needs to mark the failure in place. Writing it
also keeps requirements §11's "verifiable by reading the manifest" posture honest at the
dependency level: the shipped bundle has zero runtime dependencies, full stop.

Apply-only is sufficient. Nothing in Phase 1 generates patches — the tool observes them.

---

## 5. Testing

Vitest, node environment, test-first.

- **Unit tests** per module, written before the implementation.
- **Golden fixtures** in `src/test/fixtures/` as real `.agui.jsonl` files, so the fixture
  format and the export format cannot drift apart.
- **`malformed.agui.jsonl`** — a missing `RUN_FINISHED`, an empty `delta`, and a bad patch
  path. The test asserts **exactly three** validator entries, at the correct sequence
  positions. This is requirements Done-when #5, provable in this pass.
- **Round-trip test** — encode → decode → deep-equal on the run model (Done-when #6).
- **Redaction test** — redacted export contains no message text, still validates, still
  produces the same run structure and timings (Done-when #7).

Done-when items 1–4 and 8 depend on the capture layer and panel, and are explicitly out of
scope for this pass.

---

## 6. Build and publish

Vite 8 + CRXJS 2.7.1 (peer range covers Vite 8), Preact 10 for the panel.

`manifest.config.ts` is a typed TypeScript module producing requirements §12's manifest
exactly — `world: "MAIN"` content script at `document_start`, `all_frames: true`, no
`debugger`, no `webRequest`, no static remote host permissions, `optional_host_permissions`
only.

| Script | Effect |
|---|---|
| `pnpm dev` | CRXJS watch build for load-unpacked development |
| `pnpm build` | `packages/devtools/dist/` |
| `pnpm package` | `ag-ui-devtools-0.1.0.zip` |
| `pnpm test` | Vitest |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / ESLint |
| `pnpm gen:events` | Regenerate the event table from `@ag-ui/core` |

**Publishing (D8).** CI runs typecheck, lint, test, and build on push and pull request. A
version tag additionally attaches the zip to a GitHub release. Chrome Web Store upload is
manual — the first submission has to be anyway, and it keeps CWS API credentials out of
the repo until there is a listing to update.

---

## 7. Done when

This pass is complete when:

1. `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes from a
   clean checkout.
2. `pnpm build` produces a `dist/` that loads unpacked in Chrome and opens an (empty)
   AG-UI DevTools panel without console errors.
3. `pnpm package` produces `ag-ui-devtools-0.1.0.zip`.
4. The `core/` suite covers every requirements §7 rule, chunk expansion, state patching
   with a positioned failure, metrics, and JSONL round-trip including redaction.
5. `pnpm gen:events` regenerates `event-table.generated.ts` and the result is unchanged
   against the committed file.

---

## 8. Deferred

Phase 1 capture (`inject/`, `relay/`, `sw/`), the five panel tabs, fixture export, and all
of Phase 2 (requirements §14). Requirements §16's open questions remain open; none of them
gate this pass, because all four concern capture-time or panel-time behaviour.
