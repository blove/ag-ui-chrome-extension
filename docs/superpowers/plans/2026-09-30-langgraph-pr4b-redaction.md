# LangGraph PR 4b — Field-level Redaction: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A redacted export of a LangGraph capture replaces exactly the content the selected §11 groups own — text, reasoning, tool arguments, tool results, state — and keeps everything developer-authored (event names, ids, node names, tool names, settings), instead of today's interim rule that redacts every LangGraph payload and request body in full whenever any group is selected. And re-importing a redacted LangGraph export invents no issue.

**Architecture:** Spec L16, L17. `redact.ts` gains LangGraph rules selected by the connection's dialect (the `dialect` argument `redactLine` already takes since #46), built from one reader of LangChain messages. Anything the rules cannot classify stays fail-closed (redacted in full when any group is selected) — the interim rule survives exactly for the unclassifiable. The LangGraph expander learns the source's redacted groups, as the AG-UI validator already does, and declines the claims redaction destroyed the evidence for.

**Tech Stack:** TypeScript strict, Vitest. Package `packages/devtools`.

**Conventions:** as before — colocated tests, absent-not-undefined, comments explain why and cite spec ids, no path-header comments, commit per task ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## The rules (L16)

As shipped (`packages/devtools/src/core/jsonl/redact.ts` is the source of truth). The first draft of these tables was refined in review; the refinements are marked *(review)*. "In full" means redacted deep as soon as ANY group is selected — the interim rule, surviving exactly for what cannot be attributed to one group. A "structure slot" keeps its value only while it is a scalar (string, number, boolean, null); an object or list there is redacted in full *(review)*.

Group ownership of a LangChain message (`redactLcMessage(message, groups)`; `type` read with `roleOf`; a tool message is `type` tool, the legacy `function` type, or `role` `tool`/`function`):

| Field | Owner |
|---|---|
| `content` as a string | `toolResults` if the message is a tool message, else `text` |
| `content` list: a bare string element, or block `{type:'text', text}` → `text` | `toolResults` for a tool message, else `text`; the block's `type`/`index`/`id` are structure slots, any other block key in full |
| `content` block `{type:'reasoning', reasoning, summary[].text}`, `{type:'thinking', thinking}` | `reasoning` |
| any other `content` block (image, file, tool-use, `redacted_thinking`), or `content` that is neither string nor list | in full |
| `tool_calls[].args`, `tool_call_chunks[].args`, `invalid_tool_calls[].args` | `toolArgs`; the call's `name`/`type`/`index`/`id` are structure slots; any other call key in full |
| `artifact` | `toolResults` on a tool message; in full otherwise |
| `name` on a human message (`type` human, or `role` `user`/`human`) | `text` — the user's own handle *(review)* |
| `type`, `role`, `id`, `name` (non-human), `tool_call_id`, `status`, `chunk_position` | kept, as structure slots |
| `response_metadata` | only `finish_reason`, `stop_reason`, `model_name`, `model`, `model_provider`, `system_fingerprint`, `service_tier`, `id` kept (structure slots); every other key in full — provider fields such as `logprobs` carry content *(review: allowlist)* |
| `usage_metadata` | numbers, booleans, nulls kept at any depth; any string redacted *(review)* |
| `additional_kwargs`, any other key | in full |

Per event mode (the mode part of `sseEvent`, namespaced or not); a payload of the wrong shape for its mode is redacted wholesale:

| Mode | Rule |
|---|---|
| `metadata` | only `run_id`, `attempt`, `thread_id`, `assistant_id` kept (structure slots); any other key in full *(review)* |
| `messages` | `[chunk, meta]`: chunk by `redactLcMessage`; meta: keys starting `langgraph_` (but not `langgraph_auth*` — the authenticated user, copied from `configurable` *(review)*) and `run_id`, `thread_id`, `graph_id`, `assistant_id`, `checkpoint_ns`, `created_by`, `ls_provider`, `ls_model_name`, `ls_model_type`, `ls_temperature`, `ls_integration` kept; every other meta key in full; any further tuple element in full |
| `messages/partial`, `messages/complete` | each element by `redactLcMessage` |
| `messages/metadata` | each value's `metadata` by the meta rule; its other keys in full |
| `values`, `updates` | graph state (`redactState`): keys survive (spec L16: state keys are structure); with `state` every leaf is redacted and every message in it goes through `redactLcMessage` with ALL groups. Without `state`, leaves are kept and messages — found by shape anywhere in state, and anything under a `messages` key — still go through `redactLcMessage` with the selected groups. An element under `messages` that is not an object is in full |
| `checkpoints` | `values` as graph state; `next` node names kept (structure slots); `config`, `metadata`, `tasks` and any other key in full |
| `error` | `error` kept only while it is a string (the exception class) *(review)*; `message` and every other key in full |
| `custom`, `debug`, `tasks`, `events`, `tools`, `feedback`, unknown | in full (fail closed) |

`__interrupt__` values (the question put to the user) are owned by `state` (they are graph state).

Request body (dialect `langgraph`, `redactLangGraphBody`); a body that is not an object is redacted wholesale:

| Key | Rule |
|---|---|
| settings: `assistant_id`, `stream_mode`, `stream_subgraphs`, `stream_resumable`, `multitask_strategy`, `on_completion`, `on_disconnect`, `if_not_exists`, `after_seconds`, `durability`, `checkpoint_during`, `interrupt_before`, `interrupt_after`, `feedback_keys`, `checkpoint_id` | kept, as structure slots (or lists of them) |
| `input.messages` | by `redactLcMessage` (a list, or one message; a non-object message in full) |
| any other `input` key | owned by `text` AND `state` — the graph's input schema is often the user's own words (a RAG graph's `question`) *(review)*: with `text`, in full; otherwise as graph state |
| `input` that is not an object | in full |
| `command.resume` | `text` (the user's answer to an interrupt) |
| `command.update` | graph state |
| `command.goto` | node names kept; a `Send` (`{node, input}`/`arg`) keeps `node` and its input is graph state *(review)*; other `goto` shapes in full |
| any other `command` key | in full |
| `config`, `context`, `metadata`, `checkpoint`, `webhook`, any unknown key | in full |

AG-UI request bodies (`redactInput`): `threadId`, `runId`, `parentRunId`, `tools` kept; `messages` by field (`content` under `text`, or `toolResults` on a tool message; `toolCalls[].function.arguments` under `toolArgs`); `state`, `context`, `forwardedProps` under `state`; any OTHER top-level key, and a body that is not an object, in full *(review: these used to be kept)*.

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
