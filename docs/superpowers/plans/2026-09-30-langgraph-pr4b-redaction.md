# LangGraph PR 4b — Field-level Redaction: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A redacted export of a LangGraph capture replaces exactly the content the selected §11 groups own — text, reasoning, tool arguments, tool results, state — and keeps everything developer-authored (event names, ids, node names, tool names, settings), instead of today's interim rule that redacts every LangGraph payload and request body in full whenever any group is selected. And re-importing a redacted LangGraph export invents no issue.

**Architecture:** Spec L16, L17. `redact.ts` gains LangGraph rules selected by the connection's dialect (the `dialect` argument `redactLine` already takes since #46), built from one reader of LangChain messages. Anything the rules cannot classify stays fail-closed (redacted in full when any group is selected) — the interim rule survives exactly for the unclassifiable. The LangGraph expander learns the source's redacted groups, as the AG-UI validator already does, and declines the claims redaction destroyed the evidence for.

**Tech Stack:** TypeScript strict, Vitest. Package `packages/devtools`.

**Conventions:** as before — colocated tests, absent-not-undefined, comments explain why and cite spec ids, no path-header comments, commit per task ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## The rules (L16)

Group ownership of a LangChain message (`redactLcMessage(message, groups)`; `type` read with `roleOf`):

| Field | Owner |
|---|---|
| `content` as a string | `toolResults` if the message is a tool message, else `text` |
| `content` block `{type:'text', text}` → `text` | `toolResults` for a tool message, else `text` |
| `content` block `{type:'reasoning', summary[].text / reasoning}`, `{type:'thinking', thinking}` | `reasoning` |
| any other `content` block | redacted in full when any group is selected |
| `tool_call_chunks[].args`, `tool_calls[].args`, `invalid_tool_calls[].args` | `toolArgs` |
| `artifact` (tool messages) | `toolResults` |
| `additional_kwargs` | redacted in full when any group is selected (holds provider-specific reasoning and function-call arguments) |
| `type`, `id`, `name`, `tool_call_id`, `status`, `chunk_position`, `tool_calls[].name/id/type`, `tool_call_chunks[].name/id/index/type`, `response_metadata`, `usage_metadata` | kept — structure and developer-authored |

Per event mode (the mode part of `sseEvent`, namespaced or not):

| Mode | Rule |
|---|---|
| `metadata` | kept |
| `messages` | `[chunk, meta]`: chunk by `redactLcMessage`; meta: keys starting `langgraph_` and `run_id`, `thread_id`, `graph_id`, `assistant_id`, `checkpoint_ns`, `created_by`, `ls_provider`, `ls_model_name`, `ls_model_type`, `ls_temperature`, `ls_integration` kept; every other meta key redacted deep when any group is selected (it can carry config metadata the client sent) |
| `messages/partial`, `messages/complete` | each element by `redactLcMessage` |
| `messages/metadata` | each value's `metadata` by the meta rule |
| `values`, `updates`, `checkpoints` | with `state`: the whole payload redacted deep (keys kept — spec L16 notes state keys are structure). Without `state`: messages found at `values.messages` and `updates[node].messages` still go through `redactLcMessage`, so `text` reaches message text wherever it sits |
| `custom` | redacted in full when any group is selected |
| `error` | `error` (the exception class) kept; `message` redacted when any group is selected (it can echo input) |
| `debug`, `tasks`, `events`, `tools`, `feedback`, unknown | redacted in full when any group is selected (fail closed) |

Request body (dialect `langgraph`): settings keys kept as since #46; `input.messages[]` by `redactLcMessage`; the rest of `input` under `state`; `command.resume` under `text` (it is the user's answer to an interrupt); `command.update` under `state`; `command.goto` kept; `config`, `context`, `metadata`, `checkpoint`, `webhook` and any unknown key redacted in full when any group is selected.

`__interrupt__` values (the question put to the user) are owned by `state` (they are graph state).

## Parity (L17's companion)

A redacted export must re-import with no invented issue. Placeholders break two expander checks, so the builder passes `redacted` (the source header's groups, already on `RunBuilderOptions`) into `createLangGraphExpander`, and the expander:
- raises no `lg-tool-args-invalid` when `toolArgs` is redacted;
- raises no `lg-partial-regressed` / `lg-complete-mismatch` when `text` or `reasoning` is redacted (placeholders of different lengths do not extend each other).

---

### Task 1: the expander declines what redaction destroyed

**Files:** `src/core/normalizer/langgraph/expander.ts` (+test), `src/core/normalizer/run-builder.ts`.

- [ ] Failing tests: an expander created with `{ redacted: ['toolArgs'] }` in its options raises no `lg-tool-args-invalid` for args `«redacted: 8 chars»`; with `['text']`, partials `«redacted: 5 chars»` then `«redacted: 11 chars»` raise no `lg-partial-regressed` and a mismatching complete raises no `lg-complete-mismatch`; with `[]` all three are raised as today.
- [ ] Implement: `createLangGraphExpander(connId, request, options: { redacted?: readonly RedactionGroup[] } = {})`; the builder passes `{ redacted }`. Comment the rule as `validator/rules/tool.ts` does for AG-UI (a claim whose evidence a group destroyed is declined, not made falsely).
- [ ] Commit `fix(expander): decline the claims a redacted source cannot support (L17)`.

### Task 2: LangGraph field-level rules

**Files:** `src/core/jsonl/redact.ts` (+ `redact.test.ts`).

- [ ] Failing tests, per rule table row: for each group alone, exactly the owned fields become placeholders and nothing else changes (use a `messages` tuple with text + reasoning blocks and a tool_call_chunk; a tool-message chunk with `artifact`; `messages/partial`; `values` with messages + other state + `__interrupt__`; `updates`; `custom`; `error`; `debug`; an unknown mode; a request body with prompt, `command.resume`, `command.update`, `config`). Plus: every group together leaves only structure (assert a list of surviving strings — ids, node names, tool names, event names — and that every secret string is gone). Plus: groups `[]` returns the line by reference. Plus: an AG-UI named frame (`sseEvent === payload.type`) and AG-UI request bodies are unchanged.
- [ ] Implement `redactLcMessage`, `redactLangGraphEvent(mode, payload, set)`, and rework `redactLangGraphBody(input, set)` per the tables; in `redactLine`, when `dialect === 'langgraph'` and the line is an event, dispatch on `parseEventName(line.sseEvent).mode` (import from `core/normalizer/langgraph/names.ts`) instead of the wholesale branch; keep the AG-UI named-frame exception for non-LangGraph connections. Reuse `contentParts`/`roleOf` knowledge but write the redaction walkers here (they must preserve shape, not extract text). Update the doc comments that promised L16 would replace the wholesale rule.
- [ ] Commit `feat(redact): field-level rules for LangGraph Platform (L16)`.

### Task 3: the independent leak check covers LangGraph (L17)

**Files:** `src/panel/export/leak-check.test.ts`, `redaction-issue-parity.test.ts`, `sse-event.test.ts`, `core/jsonl/redact.test.ts` (named-line wholesale tests that now change meaning).

- [ ] In `leak-check.test.ts` — **restating §11, not importing the redactor** — add a LangGraph payload reader keyed on the mode of `line.sseEvent` that lists the strings each group owns (the rule tables above, restated), and a `byGroup` LangGraph capture (built with `langGraphJsonl`) carrying a distinct secret per group: prompt (text), reasoning summary (reasoning), tool args (toolArgs), tool result + artifact (toolResults), a state key's value and an interrupt question (state). Assert: each group alone removes its secrets and no other group's; all groups remove all; survivals (event names incl. `messages|research:t1`, `langgraph_node`, run id, tool name, message ids, `assistant_id`, `stream_mode`).
- [ ] `redaction-issue-parity.test.ts`: add the LangGraph capture above and `lg-subgraph.agui.jsonl` to `CAPTURES`; parity must hold for every group set (Task 1 makes it).
- [ ] `sse-event.test.ts` and the `redact.test.ts` wholesale tests: update the ones whose meaning changed (e.g. `langgraph_node` now survives) — each change named in the commit body.
- [ ] Commit `test(export): the leak check restates §11 for LangGraph (L17)`.

### Task 4: docs, gates, PR

- [ ] `PRIVACY.md` "Export and redaction": replace the LangGraph sentences (named frames and request bodies "redacted in full") with the field-level truth: on a LangGraph Platform capture each category replaces its own content — the prompt and message text, reasoning, tool arguments, tool results and artifacts, and graph state (including an interrupt's question) — while event names, node names, ids, tool names and request settings survive; `custom` payloads, `additional_kwargs`, request `config`/`context`/`metadata`, error messages, and any event type the extension does not classify are still redacted in full as soon as any category is selected. Keep the doc's plain voice. README's redaction bullet: check it stays true. `pnpm verify:listing`.
- [ ] Spec: L16 and L17 rows note "built in PR 4b" and point to this plan's tables.
- [ ] Mutations: drop `text` ownership of `content` → text leak-check case fails; drop `redacted` from the expander → parity fails for `toolArgs`/`text`; route LangGraph events back to wholesale → survival assertions fail.
- [ ] Gates: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e`.
- [ ] Push, PR (body + `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), auto-merge (squash).
