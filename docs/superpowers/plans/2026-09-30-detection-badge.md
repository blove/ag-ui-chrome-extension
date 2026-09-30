# Detection Badge (§14.6) — Design and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The toolbar icon shows, per tab, that the extension has seen AG-UI or LangGraph Platform traffic there, and its tooltip names the stack.

**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §14.6 — *"Toolbar icon lights up on any AG-UI page and names the stack."*

## Design (approved 2026-09-30)

| # | Decision | Why |
|---|---|---|
| **B1** | **Granted origins only** (the localhost family plus origins the user granted). §14.6's "any AG-UI page" is not attempted. | The extension only sees traffic where its content scripts run. Seeing every site needs broad host permissions, which §11 rules out, and would change the store review and PRIVACY.md. Decided with the user. |
| **B2** | **Badge text per tab:** none until something is seen; `AG` (AG-UI only), `LG` (LangGraph Platform only), `A+L` (both). One background colour that reads on light and dark toolbars. | Short enough for Chrome's badge; names the protocol at a glance. |
| **B3** | **Tooltip (action title) names the stack:** `AG-UI DevTools — <parts> — open DevTools → AG-UI`, where parts are joined by ` · `: `AG-UI` and/or `LangGraph Platform`; `CopilotKit runtime <version> (<mode>)` when a `/info` response was seen; `<n> connection(s)`. Default title `AG-UI DevTools` when nothing is seen. | "Names the stack" with what the worker actually knows. The page framework (Angular …) is probed from the panel, not the worker, so it is not in the tooltip. |
| **B4** | **Strict detection:** a connection counts as **AG-UI** once one of its event records has a `type` in the AG-UI event table (`EVENT_TYPES`); as **LangGraph** when `dialectOf` (request line + first event record) says so. A binary (protobuf) AG-UI connection counts as AG-UI. Any other `text/event-stream` does not light the badge. | Capture takes every SSE stream on a granted origin; a random SSE app on localhost must not light it. |
| **B5** | **One pure function decides:** `core/detect/stack.ts` `detectStack({ requests, records, runtime, binaryConnections }) → { agui: number; langGraph: number; runtime?: RuntimeInfo }` (counts of connections), and `badgeFor(stack) → { text: string; title: string }`. The worker recomputes after each batch of records / a conn-open / an info message / a binary notice for that tab (cheaply — only when the tab's result could change), and calls `chrome.action.setBadgeText`, `setBadgeBackgroundColor`, `setTitle` with `{ tabId }`; clearing the tab's buffer (clear command, tab close) resets them. | Testable without Chrome; one rule. |
| **B6** | **Manifest:** add `action: { default_title: 'AG-UI DevTools', default_icon: { 16, 32 } }` using the existing icons. No permission change. No popup; clicking does nothing. | `chrome.action` needs the `action` key; nothing else. |
| **B7** | **Privacy unchanged.** The badge and title live in the browser's toolbar; the page cannot read them, so #39's property ("the page never learns the extension is there") holds. | — |

---

### Task 1: `detectStack` and `badgeFor`

**Files:** Create `packages/devtools/src/core/detect/stack.ts`, `stack.test.ts`.

- [ ] Read `src/core/detect/info.ts` (`RuntimeInfo`), `src/core/events/event-table.generated.ts` (`EVENT_TYPES`), `src/core/normalizer/dialect.ts` (`dialectOf`), `src/sw/protocol.ts` (`RequestLine`), `src/core/model/types.ts` (`CaptureRecord`).
- [ ] Tests first: empty → `{agui:0, langGraph:0}` and `badgeFor` → `{ text: '', title: 'AG-UI DevTools' }`; an AG-UI connection (one `RUN_STARTED` record) → agui 1, text `AG`; a connection whose only records are non-AG-UI JSON SSE (`{"hello":1}`) and unparseable frames → nothing; a LangGraph connection (LangGraph route, or `metadata` first frame with `run_id`) → langGraph 1, text `LG` (and NOT also counted as AG-UI even if a payload happens to have a known `type`); both → `A+L`; a binary connection → agui; runtime info → title contains `CopilotKit runtime 1.52.1 (multi-route)`; counts pluralise (`1 connection`, `2 connections`); exact title strings for each case, e.g. `AG-UI DevTools — AG-UI · CopilotKit runtime 1.52.1 (multi-route) · 3 connections — open DevTools → AG-UI`.
- [ ] Implement per B3–B5. Commit `feat(detect): which stacks a tab has spoken, and the badge that says so (§14.6)`.

### Task 2: the worker drives the badge

**Files:** `packages/devtools/manifest.config.ts`, `packages/devtools/src/sw/index.ts` (+ `index.test.ts`), `packages/devtools/scripts/verify-build.ts` (only if it pins manifest keys).

- [ ] Manifest: add `action` per B6 (with a comment: no permission; the page cannot read it). Check `verify-build.ts` / `verify-listing` for manifest-key allowlists and update them if needed.
- [ ] Tests first in `sw/index.test.ts` (extend its chrome stub with `action.setBadgeText/setBadgeBackgroundColor/setTitle` recorders): frames with a `RUN_STARTED` on tab 7 → badge `AG` and the title for tab 7 only; a LangGraph conn-open + metadata frame on tab 8 → `LG`; plain SSE JSON frames → no badge call with non-empty text; an `info` message updates the title; the clear command resets tab 7 to `''` / default title; a tab close forgets it; repeated frames don't call `setBadgeText` again when nothing changed.
- [ ] Implement: a per-tab last-applied `{text,title}`; recompute `detectStack` from the tab buffer's requests/records/runtime/binary state after each handled relay message for that tab; apply only on change. Keep it cheap: detection per connection is sticky once decided (cache per `connId` in the tab state) so a 1,213-frame stream doesn't rescan.
- [ ] Commit `feat(sw): light the toolbar badge for the stack a tab speaks (§14.6)`.

### Task 3: end to end through the real extension

**Files:** `packages/harness/e2e/badge.spec.ts` (new), `packages/harness/e2e/fixtures.ts` (a `readBadge(ctx, page)` helper evaluating `chrome.action.getBadgeText({ tabId })` and `getTitle` in the service worker; get the tab id via `chrome.tabs.query` for the page's URL).
- [ ] Tests: the existing AG-UI `happy` scenario page → `AG` and a title containing `AG-UI`; the `lg-reasoning` LangGraph page (`page/langgraph.ts`) → `LG`; the mixed page (`?agui=1`) → `A+L`; a page making a plain non-AG-UI SSE request (add a tiny route in `page/serve.ts` that streams `data: {"tick":1}` frames and a page button/query flag to fetch it) → badge stays `''`.
- [ ] Watch-fail: make `detectStack` count every connection as AG-UI → the plain-SSE test fails; restore.
- [ ] Commit `test(e2e): the toolbar badge lights for AG-UI and LangGraph, and not for other SSE`.

### Task 4: docs, gates, PR

- [ ] README: one line under Status for the badge (granted origins only). PRIVACY.md: only if it enumerates what the extension displays — check; the badge reads nothing new. `docs/spec/ag-ui-devtools-v0.1.md` §14.6: "Built — granted origins only (see this plan's B1)". Listing copy: if it lists features, consider one short line, run `pnpm verify:listing`.
- [ ] Mutations: badge applied without `tabId` (global) → the tab-isolation sw test fails; drop the B4 type check → the plain-SSE unit + e2e tests fail.
- [ ] Gates: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e`.
- [ ] Push, PR (body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), auto-merge (squash).
