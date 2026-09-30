# LangGraph PR 2 — The Expander: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LangGraph Platform stream captured by the extension folds into real `Run`s — messages, reasoning, tool calls, state, steps, outcome, metrics — through the same run builder AG-UI uses, with LangGraph-specific issues instead of AG-UI ones. Top-level runs only; subgraph events are recorded raw (PR 3 folds them into child runs).

**Architecture:** Spec [`2026-09-29-langgraph-normalization-design.md`](../specs/2026-09-29-langgraph-normalization-design.md) decisions **L4–L10, L12, L13, L18**. `dialectOf` (one pure function) classifies each connection as `agui` or `langgraph`. For a LangGraph connection the run builder hands each record to a per-connection `LangGraphExpander`, which returns zero or more **synthetic** AG-UI events plus LangGraph issues; the builder folds those events through its existing `applyTransition`, skipping AG-UI validator rules (L12). At connection close the expander's `finish` closes what is open and decides the outcome. Metrics count wire event names for LangGraph runs (L13). The E7 fixture export writes LangGraph connections as `{event, data}` pairs (L18).

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest (`?raw` imports), pnpm. Package `packages/devtools` (`ag-ui-devtools`).

**Conventions:**
- Colocated `*.test.ts`. Run one file: `pnpm --filter ag-ui-devtools exec vitest run <path relative to packages/devtools>`.
- Optional fields are **absent**, never `undefined`-valued (conditional spread).
- Comments explain *why* and cite spec ids.
- Commit after every task; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Key facts about the input (verified against a real Python-server recording):**
- Records reach the builder with `sseEvent` (the SSE event name) and `raw` (the parsed JSON payload). **Read `raw`, never `event`:** the service worker and the importer set `event: null` for any non-object payload, and the `messages` tuple is a JSON **array**.
- `messages` (the `messages-tuple` mode) is `[chunk, metadata]`, a per-chunk **delta**. `content` is a string or blocks: `{type:'text', text}`, `{type:'reasoning', summary:[{text}]}`. `tool_call_chunks: [{index, id?, name?, args}]`, `args` are fragments merged by `index`. The final chunk has `content: []` and `chunk_position: 'last'`.
- The Python server opens with one **empty** chunk under a `resp_…` id; every later chunk uses `lc_run--…`.
- `messages/partial` is **cumulative**; `messages/complete` closes; `messages/metadata` carries nothing we fold.
- `values` is full state; `updates` is `{[node]: partial}`; either can carry `__interrupt__`. `error` is `{error, message}`. There is **no end event** — the run ends when the connection closes.

---

## File map

| File | Change |
|---|---|
| `src/core/model/types.ts` | 7 `lg-*` issue codes + severities; `RunOutcome` gains `'interrupted'`; `Run.dialect?: 'langgraph'` |
| `src/core/normalizer/dialect.ts` (+test) | **Create.** `dialectOf` (L4) |
| `src/core/normalizer/langgraph/names.ts` (+test) | **Create.** event-name parsing, known modes |
| `src/core/normalizer/langgraph/messages.ts` (+test) | **Create.** message role, content parts, tool-call chunks |
| `src/core/normalizer/langgraph/expander.ts` (+test) | **Create.** the per-connection state machine (L6–L10, L12) |
| `src/core/normalizer/run-builder.ts` | LangGraph fold path; close → `finish`; `interrupted`; skip AG-UI rules |
| `src/core/metrics/run-metrics.ts` | wire-name counting for LangGraph runs (L13) |
| `src/test/langgraph-capture.ts` | **Create.** test helper building LangGraph `.agui.jsonl` text |
| `src/test/langgraph.integration.test.ts` | **Create.** end-to-end through `loadJsonl` |
| `src/test/fixtures/lg-reasoning.agui.jsonl`, `lg-reasoning.canonical.txt` | **Create.** trimmed real recording |
| `src/panel/export/fixture.ts` (+test) | L18 |
| spec | record the decisions this plan makes |

---

### Task 1: model additions

**Files:** Modify `packages/devtools/src/core/model/types.ts`.

- [ ] **Step 1: Add the issue codes.** Append to the `IssueCode` union (after `'run-started-without-input'`):

```ts
  | 'lg-unknown-event'
  | 'lg-no-metadata'
  | 'lg-undecodable'
  | 'lg-partial-regressed'
  | 'lg-complete-mismatch'
  | 'lg-tool-args-invalid'
  | 'lg-no-final-values';
```

and to `ISSUE_SEVERITY` (after `'run-started-without-input': 'info',`):

```ts
  // LangGraph Platform (spec L12). Raised by the expander, never by the AG-UI rules, which do
  // not run on synthetic events: an AG-UI issue there would be our translation bug reported as
  // the user's.
  'lg-unknown-event': 'warning',
  'lg-no-metadata': 'warning',
  'lg-undecodable': 'error',
  'lg-partial-regressed': 'error',
  'lg-complete-mismatch': 'warning',
  'lg-tool-args-invalid': 'error',
  'lg-no-final-values': 'warning',
```

- [ ] **Step 2: Add the outcome and the dialect.** Replace the `RunOutcome` line with:

```ts
/**
 * `interrupted` is LangGraph's human-in-the-loop pause (spec L9): the graph stopped at an
 * interrupt and is waiting to be resumed. Not an error, and not a plain finish. The AG-UI path
 * never sets it.
 */
export type RunOutcome = 'running' | 'finished' | 'interrupted' | 'error' | 'aborted' | 'orphaned';
```

In `interface Run`, after `redacted`, add:

```ts
  /**
   * Set to `'langgraph'` when this run was folded from a LangGraph Platform stream (spec L4);
   * absent for AG-UI, so every existing run and fixture is unchanged. Metrics read it (L13):
   * a LangGraph run counts wire event names, because its AG-UI events are synthetic.
   */
  dialect?: 'langgraph';
```

- [ ] **Step 3: Verify.** Run `pnpm --filter ag-ui-devtools typecheck` → exit 0 (if any `switch`/`Record` over `RunOutcome` or `IssueCode` now fails to compile, add the missing arm with the same treatment as `'finished'` / a matching severity, and note it in the commit body). Run `pnpm --filter ag-ui-devtools exec vitest run` → all pass.

- [ ] **Step 4: Commit.**

```bash
git add packages/devtools/src/core/model/types.ts
git commit -m "feat(model): LangGraph issue codes, the interrupted outcome, Run.dialect (L9, L12)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `dialectOf`

**Files:** Create `packages/devtools/src/core/normalizer/dialect.ts`, `dialect.test.ts`.

- [ ] **Step 1: Failing test.**

```ts
// packages/devtools/src/core/normalizer/dialect.test.ts
import { describe, expect, it } from 'vitest';

import { dialectOf } from './dialect';

const LG_URL = 'http://localhost:2024/threads/t-1/runs/stream';
const CK_URL = 'http://localhost:3000/api/copilotkit/agent/default/run';

describe('dialectOf (L4)', () => {
  it('is langgraph when the request is a LangGraph run-stream route', () => {
    expect(dialectOf({ method: 'POST', url: LG_URL }, undefined)).toBe('langgraph');
    expect(dialectOf({ method: 'GET', url: 'http://h/runs/r-1/stream' }, undefined)).toBe('langgraph');
  });

  it('is langgraph when there is no telling request but the first frame is a metadata event with a run id', () => {
    const first = { sseEvent: 'metadata', payload: { run_id: 'r-1', attempt: 1 } };
    expect(dialectOf(undefined, first)).toBe('langgraph');
    expect(dialectOf({ method: 'POST', url: 'http://h/my/proxy' }, first)).toBe('langgraph');
  });

  it('is agui for a CopilotKit route, whatever the first frame says', () => {
    // The route is the stronger signal and is checked first, but a CopilotKit route is not a
    // LangGraph route, so it does not decide: the metadata fallback still applies.
    expect(dialectOf({ method: 'POST', url: CK_URL }, { payload: { type: 'RUN_STARTED' } })).toBe('agui');
  });

  it('is agui for an AG-UI server that names its events after the event type', () => {
    expect(
      dialectOf({ method: 'POST', url: 'http://h/agent' }, { sseEvent: 'RUN_STARTED', payload: { type: 'RUN_STARTED' } }),
    ).toBe('agui');
  });

  it('is agui when a metadata-named frame carries no run id', () => {
    expect(dialectOf(undefined, { sseEvent: 'metadata', payload: { attempt: 1 } })).toBe('agui');
    expect(dialectOf(undefined, { sseEvent: 'metadata', payload: 'r-1' })).toBe('agui');
  });

  it('is agui with nothing to go on', () => {
    expect(dialectOf(undefined, undefined)).toBe('agui');
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter ag-ui-devtools exec vitest run src/core/normalizer/dialect.test.ts` → FAIL (cannot resolve `./dialect`).

- [ ] **Step 3: Implement.**

```ts
// packages/devtools/src/core/normalizer/dialect.ts
/**
 * Which wire protocol a connection speaks (spec L4, L5).
 *
 * Per connection, not per session, so an AG-UI stream and a LangGraph stream can sit side by
 * side in one capture. Derived only from things every capture stores — the request line and the
 * first event record — so an imported file classifies exactly as the live capture did, and
 * nothing new is persisted. Every consumer that branches on dialect calls this one function: if
 * two of them disagreed about which connections are LangGraph, the panel and the export would
 * tell two different stories about the same file.
 */
import { routeHint } from '../detect/classifier';

export type Dialect = 'agui' | 'langgraph';

export interface DialectRequest {
  readonly method: string;
  readonly url: string;
}

export interface DialectFirstFrame {
  readonly sseEvent?: string;
  /** The parsed payload — `CaptureRecord.raw`, or a `.agui.jsonl` event line's `event`. */
  readonly payload: unknown;
}

export function dialectOf(
  request: DialectRequest | undefined,
  first: DialectFirstFrame | undefined,
): Dialect {
  // The URL is the strongest signal, and it is known before any byte of the response.
  if (request !== undefined && routeHint(request.url, request.method)?.kind === 'langgraph-run') {
    return 'langgraph';
  }
  // A LangGraph server behind a proxy path: its first event is always `metadata`, carrying the
  // run id. An AG-UI frame never has an SSE name `metadata` — AG-UI types are UPPER_SNAKE.
  const payload = first?.payload;
  if (
    first?.sseEvent === 'metadata' &&
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { run_id?: unknown }).run_id === 'string'
  ) {
    return 'langgraph';
  }
  return 'agui';
}
```

- [ ] **Step 4: Run** the test → PASS (6). `pnpm --filter ag-ui-devtools typecheck` and `lint` → exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/devtools/src/core/normalizer/dialect.ts packages/devtools/src/core/normalizer/dialect.test.ts
git commit -m "feat(core): dialectOf — AG-UI or LangGraph, per connection (L4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: LangGraph payload helpers

**Files:** Create `packages/devtools/src/core/normalizer/langgraph/names.ts`, `names.test.ts`, `messages.ts`, `messages.test.ts`.

- [ ] **Step 1: Failing tests.**

```ts
// packages/devtools/src/core/normalizer/langgraph/names.test.ts
import { describe, expect, it } from 'vitest';

import { isKnownMode, parseEventName } from './names';

describe('parseEventName', () => {
  it('splits a subgraph namespace off the mode', () => {
    expect(parseEventName('messages|research:9f1c|tools:ab')).toEqual({
      mode: 'messages',
      namespace: ['research:9f1c', 'tools:ab'],
    });
  });

  it('leaves a top-level name whole, slashes included', () => {
    expect(parseEventName('messages/partial')).toEqual({ mode: 'messages/partial', namespace: [] });
    expect(parseEventName('values')).toEqual({ mode: 'values', namespace: [] });
  });

  it('treats a missing name as the empty mode', () => {
    expect(parseEventName(undefined)).toEqual({ mode: '', namespace: [] });
  });
});

describe('isKnownMode', () => {
  it('knows every mode LangGraph Platform emits', () => {
    for (const mode of [
      'metadata', 'values', 'updates', 'messages', 'messages/partial', 'messages/complete',
      'messages/metadata', 'custom', 'error', 'debug', 'tasks', 'checkpoints', 'events', 'tools',
      'feedback',
    ]) {
      expect(isKnownMode(mode)).toBe(true);
    }
  });

  it('does not know anything else', () => {
    expect(isKnownMode('')).toBe(false);
    expect(isKnownMode('end')).toBe(false);
    expect(isKnownMode('RUN_STARTED')).toBe(false);
  });
});
```

```ts
// packages/devtools/src/core/normalizer/langgraph/messages.test.ts
import { describe, expect, it } from 'vitest';

import { contentParts, roleOf, toolCallChunks } from './messages';

describe('roleOf', () => {
  it('reads both serializations of a message type', () => {
    expect(roleOf('ai')).toBe('ai');
    expect(roleOf('AIMessageChunk')).toBe('ai');
    expect(roleOf('AIMessage')).toBe('ai');
    expect(roleOf('tool')).toBe('tool');
    expect(roleOf('ToolMessageChunk')).toBe('tool');
    expect(roleOf('human')).toBe('human');
    expect(roleOf('HumanMessage')).toBe('human');
    expect(roleOf('system')).toBe('system');
  });

  it('is other for anything unrecognised', () => {
    expect(roleOf('remove')).toBe('other');
    expect(roleOf(undefined)).toBe('other');
    expect(roleOf(3)).toBe('other');
  });
});

describe('contentParts', () => {
  it('takes a string as text', () => {
    expect(contentParts('Hello')).toEqual({ text: 'Hello', reasoning: '' });
  });

  it('splits content blocks into text and reasoning, in order', () => {
    expect(
      contentParts([
        { type: 'reasoning', index: 0, summary: [{ index: 0, type: 'summary_text', text: 'Think' }] },
        { type: 'text', index: 1, text: 'Hel' },
        { type: 'text', index: 1, text: 'lo' },
        { type: 'thinking', thinking: 'ing' },
      ]),
    ).toEqual({ text: 'Hello', reasoning: 'Thinking' });
  });

  it('ignores blocks it does not understand, and non-content', () => {
    expect(contentParts([{ type: 'image_url', image_url: 'x' }, null, 3])).toEqual({ text: '', reasoning: '' });
    expect(contentParts([])).toEqual({ text: '', reasoning: '' });
    expect(contentParts(undefined)).toEqual({ text: '', reasoning: '' });
  });
});

describe('toolCallChunks', () => {
  it('keeps index, id, name and the args fragment', () => {
    expect(
      toolCallChunks([{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci', type: 'tool_call_chunk' }]),
    ).toEqual([{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci' }]);
  });

  it('leaves id and name absent when the chunk does not carry them', () => {
    expect(toolCallChunks([{ index: 0, args: 'ty":"SF"}', id: null, name: '' }])).toEqual([
      { index: 0, args: 'ty":"SF"}' },
    ]);
  });

  it('falls back to array position for a missing index, and to empty args', () => {
    expect(toolCallChunks([{ id: 'a' }, { id: 'b', args: 7 }])).toEqual([
      { index: 0, id: 'a', args: '' },
      { index: 1, id: 'b', args: '' },
    ]);
  });

  it('is empty for anything that is not a list', () => {
    expect(toolCallChunks(undefined)).toEqual([]);
    expect(toolCallChunks({ index: 0 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter ag-ui-devtools exec vitest run src/core/normalizer/langgraph` → FAIL (modules missing).

- [ ] **Step 3: Implement.**

```ts
// packages/devtools/src/core/normalizer/langgraph/names.ts
/**
 * LangGraph Platform SSE event names (spec §2).
 *
 * With `stream_subgraphs` on, an event from inside a subgraph is named
 * `` `${mode}|${ns.join('|')}` `` — `messages|research:9f1c…` — where each namespace segment is
 * `node:task_id`. `metadata` and `feedback` are never namespaced.
 */
const KNOWN_MODES: ReadonlySet<string> = new Set([
  'metadata',
  'values',
  'updates',
  'messages',
  'messages/partial',
  'messages/complete',
  'messages/metadata',
  'custom',
  'error',
  'debug',
  'tasks',
  'checkpoints',
  'events',
  'tools',
  'feedback',
]);

export interface ParsedEventName {
  readonly mode: string;
  readonly namespace: readonly string[];
}

export function parseEventName(name: string | undefined): ParsedEventName {
  const [mode = '', ...namespace] = (name ?? '').split('|');
  return { mode, namespace };
}

export function isKnownMode(mode: string): boolean {
  return KNOWN_MODES.has(mode);
}
```

```ts
// packages/devtools/src/core/normalizer/langgraph/messages.ts
/**
 * Reading LangChain messages as LangGraph Platform serializes them.
 *
 * The JS server writes `type: 'ai'`; the Python server writes `type: 'AIMessageChunk'` inside
 * `messages` tuples. The LangGraph SDK normalizes the second to the first; so does this.
 */
export type MessageRole = 'ai' | 'tool' | 'human' | 'system' | 'other';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function roleOf(type: unknown): MessageRole {
  if (typeof type !== 'string') return 'other';
  let role = type;
  if (role.endsWith('MessageChunk')) role = role.slice(0, -'MessageChunk'.length).toLowerCase();
  else if (role.endsWith('Message')) role = role.slice(0, -'Message'.length).toLowerCase();
  return role === 'ai' || role === 'tool' || role === 'human' || role === 'system' ? role : 'other';
}

export interface ContentParts {
  readonly text: string;
  readonly reasoning: string;
}

/**
 * The text and the reasoning a message's `content` carries.
 *
 * `content` is a string, or a list of blocks: `{type:'text', text}`, OpenAI's
 * `{type:'reasoning', summary:[{text}]}`, Anthropic's `{type:'thinking', thinking}`. Anything
 * else (images, tool-use blocks) carries neither and is skipped.
 */
export function contentParts(content: unknown): ContentParts {
  if (typeof content === 'string') return { text: content, reasoning: '' };
  let text = '';
  let reasoning = '';
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'reasoning') {
        if (Array.isArray(block.summary)) {
          for (const part of block.summary) {
            if (isObject(part) && typeof part.text === 'string') reasoning += part.text;
          }
        }
        if (typeof block.reasoning === 'string') reasoning += block.reasoning;
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        reasoning += block.thinking;
      }
    }
  }
  return { text, reasoning };
}

export interface ToolCallChunk {
  /** Chunks of one tool call share an `index`; its `args` fragments concatenate in order. */
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly args: string;
}

export function toolCallChunks(value: unknown): ToolCallChunk[] {
  if (!Array.isArray(value)) return [];
  const chunks: ToolCallChunk[] = [];
  value.forEach((entry, position) => {
    if (!isObject(entry)) return;
    const id = nonEmpty(entry.id);
    const name = nonEmpty(entry.name);
    chunks.push({
      index: typeof entry.index === 'number' ? entry.index : position,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      args: typeof entry.args === 'string' ? entry.args : '',
    });
  });
  return chunks;
}
```

- [ ] **Step 4: Run** → PASS. typecheck + lint → exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/devtools/src/core/normalizer/langgraph
git commit -m "feat(core): read LangGraph event names and LangChain message chunks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the expander

**Files:** Create `packages/devtools/src/core/normalizer/langgraph/expander.ts`, `expander.test.ts`.

The contract: `push(frame)` returns the synthetic AG-UI events one wire frame produces, plus LangGraph issues anchored at `frame.seq`. `finish(seq)` is called once, when the connection closes; it closes whatever is still open and decides how the run ended.

**Decisions this task makes, beyond the spec table** (recorded in the spec in Task 9):
- The reasoning of message `m` is the separate message `` `${m}:reasoning` `` — AG-UI keeps reasoning and text in different messages. Reasoning closes when that message's text or first tool call starts.
- A new assistant message closes the open one only when the new chunk **carries content** (the id quirk, L7).
- A `values` event closes the open message: it marks a completed step.
- Tool results are emitted once per `tool_call_id`. From a `messages` tool chunk, always; from `values`, only for a call **this run started** — `values.messages` is the whole thread history, and earlier runs' tool results are not this run's.
- **How the run ends**, at `finish`: an `error` event already emitted `RUN_ERROR`. Otherwise, an interrupt seen → `RUN_FINISHED`, outcome `interrupted`. Otherwise, if the request asked for `values` (explicitly, or by omitting `stream_mode`, whose server default is `['values']`) and no top-level `values`, `messages/complete` or `checkpoints` arrived **after the last message chunk**, raise `lg-no-final-values` and emit nothing, so the builder marks the run `aborted` — that is the condition Threadplane's own bridge treats as not-a-normal-finish. Otherwise `RUN_FINISHED`.
- `lg-undecodable` means a payload that is not the shape its event name carries (e.g. `messages` that is not an array).
- After an `error` event, later frames are recorded raw and fold nothing.
- Namespaced events (`mode|ns…`) are recorded raw in this PR; PR 3 folds them into child runs.

- [ ] **Step 1: Failing tests** (direct, small; the builder-level tests in Task 6 cover the rest).

```ts
// packages/devtools/src/core/normalizer/langgraph/expander.test.ts
import { describe, expect, it } from 'vitest';

import type { AguiEvent } from '../../model/types';
import { createLangGraphExpander, type LangGraphExpander, type LangGraphRequest } from './expander';

const REQUEST = {
  method: 'POST',
  url: 'http://localhost:2024/threads/t-1/runs/stream',
  input: { assistant_id: 'agent', stream_mode: ['values', 'messages-tuple'] },
};

function ai(id: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return [{ type: 'AIMessageChunk', id, content, tool_call_chunks: [], ...extra }, { langgraph_node: 'agent' }];
}

function drive(frames: Array<[string, unknown]>, request: LangGraphRequest = REQUEST): {
  expander: LangGraphExpander;
  events: AguiEvent[];
  codes: Array<[string, number]>;
} {
  const expander = createLangGraphExpander('c1', request);
  const events: AguiEvent[] = [];
  const codes: Array<[string, number]> = [];
  frames.forEach(([sseEvent, payload], i) => {
    const out = expander.push({ seq: i + 1, sseEvent, payload });
    events.push(...out.events);
    codes.push(...out.issues.map((issue): [string, number] => [issue.code, issue.seq]));
  });
  return { expander, events, codes };
}

const types = (events: AguiEvent[]): string[] => events.map((event) => event.type);

describe('createLangGraphExpander', () => {
  it('opens the run from metadata, with the thread id from the URL', () => {
    const { events } = drive([['metadata', { run_id: 'r-1', attempt: 1 }]]);
    expect(events).toEqual([{ type: 'RUN_STARTED', runId: 'r-1', threadId: 't-1' }]);
  });

  it('opens a message only on a chunk with content, so the empty resp_ chunk invents nothing (L7)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('resp_x', [])],
      ['messages', ai('lc_1', [{ type: 'text', text: 'Hi' }])],
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'lc_1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'lc_1', delta: 'Hi' },
    ]);
  });

  it('streams reasoning as its own message and closes it when the text starts', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [{ type: 'reasoning', summary: [{ text: 'Hmm' }] }])],
      ['messages', ai('m1', [{ type: 'text', text: 'Yes' }])],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    expect(types(events)).toEqual([
      'RUN_STARTED',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(events[1]).toEqual({ type: 'REASONING_MESSAGE_START', messageId: 'm1:reasoning', role: 'assistant' });
  });

  it('streams tool-call args by index, and names a late-named call with a second START (L8)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, args: '{"a"' }] })],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, name: 'f', args: ':1}' }] })],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'm1#0', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'm1#0', delta: '{"a"' },
      { type: 'TOOL_CALL_START', toolCallId: 'm1#0', toolCallName: 'f', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'm1#0', delta: ':1}' },
      { type: 'TOOL_CALL_END', toolCallId: 'm1#0' },
    ]);
  });

  it('finishes normally after a final values event', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', 'Hi')],
      ['values', { messages: [] }],
    ]);
    const done = expander.finish(3);
    expect(done.interrupted).toBe(false);
    expect(done.issues).toEqual([]);
    expect(done.events).toEqual([{ type: 'RUN_FINISHED', runId: 'r-1', threadId: 't-1' }]);
  });

  it('does not finish a run that asked for values and closed without them', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values', { messages: [] }],
      ['messages', ai('m1', 'Hi')],
    ]);
    const done = expander.finish(3);
    expect(types(done.events)).toEqual(['TEXT_MESSAGE_END']);
    expect(done.issues.map((issue) => [issue.code, issue.seq])).toEqual([['lg-no-final-values', 3]]);
  });

  it('finishes a run that did not ask for values, since there is nothing to wait for', () => {
    const { expander } = drive(
      [['metadata', { run_id: 'r-1' }], ['messages', ai('m1', 'Hi')]],
      { ...REQUEST, input: { stream_mode: ['messages-tuple'] } },
    );
    expect(types(expander.finish(2).events)).toEqual(['TEXT_MESSAGE_END', 'RUN_FINISHED']);
  });

  it('reports an interrupt as interrupted, not finished (L9)', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values', { __interrupt__: [{ value: 'approve?' }] }],
    ]);
    const done = expander.finish(2);
    expect(done.interrupted).toBe(true);
    expect(types(done.events)).toEqual(['RUN_FINISHED']);
  });

  it('ends on an error event, and folds nothing after it', () => {
    const { events, expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', 'Hi')],
      ['error', { error: 'ValueError', message: 'boom' }],
      ['values', { x: 1 }],
    ]);
    expect(types(events).slice(-2)).toEqual(['TEXT_MESSAGE_END', 'RUN_ERROR']);
    expect(events.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'boom', code: 'ValueError' });
    expect(expander.finish(4).events).toEqual([]);
  });

  it('synthesizes a run, and says so, when the first frame is not metadata', () => {
    const { events, codes } = drive([['messages', ai('m1', 'Hi')]]);
    expect(events[0]).toEqual({ type: 'RUN_STARTED', runId: 'lg:c1', threadId: 't-1' });
    expect(codes).toEqual([['lg-no-metadata', 1]]);
  });

  it('turns a cumulative partial into deltas', () => {
    const partial = (content: string): unknown => [{ type: 'ai', id: 'm1', content }];
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages/partial', partial('He')],
      ['messages/partial', partial('Hello')],
    ]);
    expect(events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').map((event) => event.delta)).toEqual([
      'He',
      'llo',
    ]);
  });

  it('records a namespaced event raw, folding nothing (PR 3 folds subgraphs)', () => {
    const { events, codes } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages|research:abc', ai('s1', 'sub')],
    ]);
    expect(types(events)).toEqual(['RUN_STARTED']);
    expect(codes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter ag-ui-devtools exec vitest run src/core/normalizer/langgraph/expander.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement.**

```ts
// packages/devtools/src/core/normalizer/langgraph/expander.ts
/**
 * LangGraph Platform → synthetic AG-UI events, one connection at a time (spec L6–L10, L12).
 *
 * The raw LangGraph frame is what is captured, stored and exported; this only decides how it
 * reads in the run model. Each `push` returns the AG-UI events one wire frame stands for, which
 * the run builder folds exactly as it folds AG-UI — so every tab works unchanged — while the
 * frame itself stays the Timeline row. The events are synthetic, so the AG-UI validator does not
 * see them (L12); what can actually be wrong with a LangGraph stream is reported here instead.
 */
import { routeHint } from '../../detect/classifier';
import { makeIssue, type AguiEvent, type Issue, type IssueCode } from '../../model/types';
import { contentParts, isObject, roleOf, toolCallChunks, type ToolCallChunk } from './messages';
import { isKnownMode, parseEventName } from './names';

export interface LangGraphRequest {
  readonly method?: string;
  readonly url?: string;
  /** The decoded request body: `{assistant_id, input, stream_mode, …}`. */
  readonly input?: unknown;
}

export interface LangGraphFrame {
  readonly seq: number;
  readonly sseEvent?: string;
  /** The parsed payload — `CaptureRecord.raw`, never `.event`, which is null for an array. */
  readonly payload: unknown;
}

export interface LangGraphExpansion {
  events: AguiEvent[];
  issues: Issue[];
}

export interface LangGraphFinish extends LangGraphExpansion {
  /** The run stopped at an interrupt: the builder records the outcome `interrupted` (L9). */
  interrupted: boolean;
}

export interface LangGraphExpander {
  push(frame: LangGraphFrame): LangGraphExpansion;
  /** Called once, when the connection closes. `seq` anchors any issue it raises. */
  finish(seq: number): LangGraphFinish;
}

interface OpenToolCall {
  readonly toolCallId: string;
  name?: string;
  argsText: string;
}

interface OpenMessage {
  readonly messageId: string;
  textOpen: boolean;
  reasoningOpen: boolean;
  readonly toolCalls: Map<number, OpenToolCall>;
}

/** What a cumulative `messages/partial` stream has already said, per message. */
interface PartialState {
  text: string;
  reasoning: string;
  readonly toolArgs: Map<number, string>;
}

/** Top-level events after which a close is a normal finish — the set Threadplane's bridge uses. */
const TERMINAL_MODES: ReadonlySet<string> = new Set(['values', 'messages/complete', 'checkpoints']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function reasoningIdOf(messageId: string): string {
  return `${messageId}:reasoning`;
}

/** The part of `after` that extends `before`, or `undefined` when it does not extend it. */
function suffix(before: string, after: string): string | undefined {
  return after.startsWith(before) ? after.slice(before.length) : undefined;
}

/** Whether the request asked for `values`. An omitted `stream_mode` is the server default, `['values']`. */
function valuesRequested(input: unknown): boolean {
  const mode = isObject(input) ? input.stream_mode : undefined;
  if (mode === undefined || mode === null) return true;
  if (typeof mode === 'string') return mode === 'values';
  if (Array.isArray(mode)) return mode.length === 0 || mode.includes('values');
  return true;
}

export function createLangGraphExpander(connId: string, request: LangGraphRequest): LangGraphExpander {
  const hint =
    request.url !== undefined && request.method !== undefined
      ? routeHint(request.url, request.method)
      : undefined;
  const route = hint?.kind === 'langgraph-run' ? hint : undefined;

  let runId = '';
  let threadId = '';
  let started = false;
  let errored = false;
  let interrupted = false;
  /** A top-level terminal-eligible event arrived after the last message chunk. */
  let settled = false;
  let open: OpenMessage | undefined;
  const partials = new Map<string, PartialState>();
  const startedToolCalls = new Set<string>();
  const resultedToolCalls = new Set<string>();

  function issue(out: LangGraphExpansion, code: IssueCode, message: string, seq: number): void {
    out.issues.push(makeIssue(code, message, seq));
  }

  function start(out: LangGraphExpansion, meta: Record<string, unknown> | undefined): void {
    started = true;
    runId = str(meta?.run_id) ?? route?.runId ?? `lg:${connId}`;
    threadId = route?.threadId ?? str(meta?.thread_id) ?? '';
    out.events.push({ type: 'RUN_STARTED', runId, threadId });
  }

  function ensureStarted(out: LangGraphExpansion, seq: number): void {
    if (started) return;
    issue(
      out,
      'lg-no-metadata',
      'The stream sent no metadata event before its first event, so this run id is synthesized',
      seq,
    );
    start(out, undefined);
  }

  function closeReasoning(out: LangGraphExpansion, message: OpenMessage): void {
    if (!message.reasoningOpen) return;
    out.events.push({ type: 'REASONING_MESSAGE_END', messageId: reasoningIdOf(message.messageId) });
    message.reasoningOpen = false;
  }

  function closeMessage(out: LangGraphExpansion, seq: number): void {
    const message = open;
    if (message === undefined) return;
    open = undefined;
    closeReasoning(out, message);
    for (const call of message.toolCalls.values()) {
      out.events.push({ type: 'TOOL_CALL_END', toolCallId: call.toolCallId });
      if (call.argsText.trim() === '') continue;
      try {
        JSON.parse(call.argsText);
      } catch {
        issue(out, 'lg-tool-args-invalid', `Tool call ${call.toolCallId} streamed arguments that are not valid JSON`, seq);
      }
    }
    if (message.textOpen) out.events.push({ type: 'TEXT_MESSAGE_END', messageId: message.messageId });
  }

  function foldToolChunk(out: LangGraphExpansion, message: OpenMessage, chunk: ToolCallChunk): void {
    let call = message.toolCalls.get(chunk.index);
    if (call === undefined) {
      // L8: AG-UI needs the id at START. A call whose first chunk has none keeps this synthetic
      // id for its whole life — re-keying mid-call would split one call into two.
      call = { toolCallId: chunk.id ?? `${message.messageId}#${chunk.index}`, argsText: '' };
      if (chunk.name !== undefined) call.name = chunk.name;
      message.toolCalls.set(chunk.index, call);
      startedToolCalls.add(call.toolCallId);
      closeReasoning(out, message);
      out.events.push({
        type: 'TOOL_CALL_START',
        toolCallId: call.toolCallId,
        ...(call.name !== undefined ? { toolCallName: call.name } : {}),
        parentMessageId: message.messageId,
      });
    } else if (call.name === undefined && chunk.name !== undefined) {
      // AG-UI names a call only at START. A name that arrives late re-states it; the builder
      // folds a repeated START as an update, and no AG-UI rule sees synthetic events (L12).
      call.name = chunk.name;
      out.events.push({
        type: 'TOOL_CALL_START',
        toolCallId: call.toolCallId,
        toolCallName: call.name,
        parentMessageId: message.messageId,
      });
    }
    if (chunk.args !== '') {
      call.argsText += chunk.args;
      out.events.push({ type: 'TOOL_CALL_ARGS', toolCallId: call.toolCallId, delta: chunk.args });
    }
  }

  /** One assistant delta: new text, new reasoning and new tool-call fragments for one message. */
  function foldAiDelta(
    out: LangGraphExpansion,
    seq: number,
    messageId: string | undefined,
    text: string,
    reasoning: string,
    tools: readonly ToolCallChunk[],
    last: boolean,
  ): void {
    // L7: only a chunk that carries something opens (or switches) a message. The Python server's
    // stream opens with one empty chunk under an id no later chunk uses.
    if (text !== '' || reasoning !== '' || tools.length > 0) {
      if (open !== undefined && messageId !== undefined && messageId !== open.messageId) {
        closeMessage(out, seq);
      }
      open ??= {
        messageId: messageId ?? `lg-msg-${seq}`,
        textOpen: false,
        reasoningOpen: false,
        toolCalls: new Map(),
      };
      const message = open;
      if (reasoning !== '') {
        const reasoningId = reasoningIdOf(message.messageId);
        if (!message.reasoningOpen) {
          out.events.push({ type: 'REASONING_MESSAGE_START', messageId: reasoningId, role: 'assistant' });
          message.reasoningOpen = true;
        }
        out.events.push({ type: 'REASONING_MESSAGE_CONTENT', messageId: reasoningId, delta: reasoning });
      }
      if (text !== '') {
        closeReasoning(out, message);
        if (!message.textOpen) {
          out.events.push({ type: 'TEXT_MESSAGE_START', messageId: message.messageId, role: 'assistant' });
          message.textOpen = true;
        }
        out.events.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: message.messageId, delta: text });
      }
      for (const chunk of tools) foldToolChunk(out, message, chunk);
    }
    if (last) closeMessage(out, seq);
  }

  function toolResult(
    out: LangGraphExpansion,
    seq: number,
    message: Record<string, unknown>,
    onlyIfStartedHere: boolean,
  ): void {
    const toolCallId = str(message.tool_call_id);
    if (toolCallId === undefined || resultedToolCalls.has(toolCallId)) return;
    // `values.messages` is the whole thread's history: a result for a call an EARLIER run made is
    // not this run's. A `messages` tool chunk, by contrast, was produced by this run.
    if (onlyIfStartedHere && !startedToolCalls.has(toolCallId)) return;
    closeMessage(out, seq);
    resultedToolCalls.add(toolCallId);
    out.events.push({
      type: 'TOOL_CALL_RESULT',
      messageId: str(message.id) ?? `${toolCallId}:result`,
      toolCallId,
      content: message.content,
      role: 'tool',
    });
  }

  function foldTupleMessage(out: LangGraphExpansion, seq: number, message: Record<string, unknown>): void {
    const role = roleOf(message.type);
    if (role === 'tool') {
      toolResult(out, seq, message, false);
      return;
    }
    // Human and system messages are the request's input, which the run already carries.
    if (role !== 'ai') return;
    const parts = contentParts(message.content);
    foldAiDelta(
      out,
      seq,
      str(message.id),
      parts.text,
      parts.reasoning,
      toolCallChunks(message.tool_call_chunks),
      message.chunk_position === 'last',
    );
  }

  /** A cumulative message (`messages/partial`, `messages/complete`) folded as the delta it adds. */
  function foldCumulativeMessage(
    out: LangGraphExpansion,
    seq: number,
    message: Record<string, unknown>,
    complete: boolean,
  ): void {
    const role = roleOf(message.type);
    if (role === 'tool') {
      toolResult(out, seq, message, false);
      return;
    }
    if (role !== 'ai') return;
    const id = str(message.id) ?? open?.messageId ?? `lg-msg-${seq}`;
    const previous = partials.get(id) ?? { text: '', reasoning: '', toolArgs: new Map<number, string>() };
    const parts = contentParts(message.content);
    const text = suffix(previous.text, parts.text);
    const reasoning = suffix(previous.reasoning, parts.reasoning);
    let regressed = text === undefined || reasoning === undefined;
    const tools: ToolCallChunk[] = [];
    for (const chunk of toolCallChunks(message.tool_call_chunks)) {
      const before = previous.toolArgs.get(chunk.index);
      const delta = suffix(before ?? '', chunk.args);
      if (delta === undefined) regressed = true;
      // A call not seen before must reach `foldToolChunk` even with no new args, to be STARTed.
      if (before === undefined || (delta ?? '') !== '') tools.push({ ...chunk, args: delta ?? '' });
      previous.toolArgs.set(chunk.index, chunk.args);
    }
    if (regressed) {
      issue(
        out,
        complete ? 'lg-complete-mismatch' : 'lg-partial-regressed',
        complete
          ? `messages/complete for ${id} does not extend what its partials streamed`
          : `A messages/partial for ${id} does not extend the previous one: messages/partial is cumulative`,
        seq,
      );
    }
    previous.text = parts.text;
    previous.reasoning = parts.reasoning;
    partials.set(id, previous);
    foldAiDelta(out, seq, id, text ?? '', reasoning ?? '', tools, complete);
  }

  function undecodable(out: LangGraphExpansion, name: string, seq: number): void {
    issue(out, 'lg-undecodable', `The "${name}" event's payload is not the shape that event carries`, seq);
  }

  function push(frame: LangGraphFrame): LangGraphExpansion {
    const out: LangGraphExpansion = { events: [], issues: [] };
    const { seq, payload } = frame;
    const name = frame.sseEvent ?? '';
    const { mode, namespace } = parseEventName(frame.sseEvent);

    if (mode === 'metadata' && namespace.length === 0) {
      if (started) return out;
      if (!isObject(payload)) undecodable(out, name, seq);
      start(out, isObject(payload) ? payload : undefined);
      return out;
    }

    ensureStarted(out, seq);
    // An error ends the run; anything after it is recorded as it arrived and folds nothing.
    if (errored) return out;
    // PR 3 folds subgraph events into child runs (L11). Until then they are recorded, raw.
    if (namespace.length > 0) return out;
    if (!isKnownMode(mode)) {
      issue(out, 'lg-unknown-event', `"${name}" is not an event LangGraph Platform emits`, seq);
      return out;
    }

    switch (mode) {
      case 'messages': {
        const message = Array.isArray(payload) ? (payload[0] as unknown) : undefined;
        if (!isObject(message)) {
          undecodable(out, name, seq);
          break;
        }
        settled = false;
        foldTupleMessage(out, seq, message);
        break;
      }
      case 'messages/partial':
      case 'messages/complete': {
        if (!Array.isArray(payload)) {
          undecodable(out, name, seq);
          break;
        }
        const complete = mode === 'messages/complete';
        settled = complete;
        for (const message of payload) {
          if (isObject(message)) foldCumulativeMessage(out, seq, message, complete);
        }
        break;
      }
      case 'values': {
        if (!isObject(payload)) {
          undecodable(out, name, seq);
          break;
        }
        // A values event marks a completed step: whatever message was streaming is done.
        closeMessage(out, seq);
        settled = true;
        if ('__interrupt__' in payload) interrupted = true;
        const snapshot: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload)) {
          if (key !== '__interrupt__') snapshot[key] = value;
        }
        // A values event whose only key is `__interrupt__` is an interrupt, not a state.
        if (Object.keys(snapshot).length > 0) out.events.push({ type: 'STATE_SNAPSHOT', snapshot });
        if (Array.isArray(snapshot.messages)) {
          for (const message of snapshot.messages) {
            if (isObject(message) && roleOf(message.type) === 'tool') toolResult(out, seq, message, true);
          }
        }
        break;
      }
      case 'updates': {
        if (!isObject(payload)) {
          undecodable(out, name, seq);
          break;
        }
        for (const node of Object.keys(payload)) {
          if (node === '__interrupt__') {
            interrupted = true;
            continue;
          }
          // An update arrives once its node has run, so the step starts and finishes together.
          out.events.push({ type: 'STEP_STARTED', stepName: node });
          out.events.push({ type: 'STEP_FINISHED', stepName: node });
        }
        break;
      }
      case 'custom':
        out.events.push({ type: 'CUSTOM', name: 'langgraph.custom', value: payload });
        break;
      case 'error': {
        closeMessage(out, seq);
        errored = true;
        const message = isObject(payload)
          ? (str(payload.message) ?? str(payload.error) ?? 'error')
          : (str(payload) ?? 'error');
        const code = isObject(payload) ? str(payload.error) : undefined;
        out.events.push({ type: 'RUN_ERROR', message, ...(code !== undefined ? { code } : {}) });
        break;
      }
      case 'checkpoints':
        settled = true;
        break;
      default:
        // messages/metadata, debug, tasks, events, tools, feedback: shown raw in Timeline only.
        break;
    }
    return out;
  }

  function finish(seq: number): LangGraphFinish {
    const out: LangGraphExpansion = { events: [], issues: [] };
    if (!started) return { ...out, interrupted: false };
    closeMessage(out, seq);
    if (errored) return { ...out, interrupted: false };
    if (!interrupted && valuesRequested(request.input) && !settled) {
      // Threadplane's bridge reads this exact condition as "did not finish normally": the stream
      // stopped mid-answer. No RUN_FINISHED, so the run builder records the outcome `aborted`.
      issue(
        out,
        'lg-no-final-values',
        'The stream closed without a final values event, although the request asked for values',
        seq,
      );
      return { ...out, interrupted: false };
    }
    out.events.push({ type: 'RUN_FINISHED', runId, threadId });
    return { ...out, interrupted };
  }

  return { push, finish };
}
```

- [ ] **Step 4: Run** the expander tests → PASS (all 12). typecheck + lint → exit 0. If lint flags something (e.g. a non-null pattern), fix it without changing behaviour and say so.

- [ ] **Step 5: Commit.**

```bash
git add packages/devtools/src/core/normalizer/langgraph/expander.ts packages/devtools/src/core/normalizer/langgraph/expander.test.ts
git commit -m "feat(core): the LangGraph expander — wire frames to synthetic AG-UI events (L6-L10, L12)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: the run builder folds LangGraph connections

**Files:** Modify `packages/devtools/src/core/normalizer/run-builder.ts`, `packages/devtools/src/core/metrics/run-metrics.ts`. Test: `packages/devtools/src/core/normalizer/run-builder.test.ts` (append).

- [ ] **Step 1: Failing tests.** Append to `run-builder.test.ts` (read its imports first; add what is missing):

```ts
describe('run builder — LangGraph connections (L4, L10, L13)', () => {
  function lgRecord(seq: number, sseEvent: string, raw: unknown): CaptureRecord {
    return {
      kind: 'event',
      seq,
      tMs: seq * 10,
      connId: 'c1',
      raw,
      event: typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as AguiEvent) : null,
      sseEvent,
      issues: [],
    };
  }

  function lgBuilder(): RunBuilder {
    const builder = createRunBuilder();
    builder.addRequest('c1', 'POST', 'http://localhost:2024/threads/t-1/runs/stream', {
      assistant_id: 'agent',
      stream_mode: ['values', 'messages-tuple'],
    });
    return builder;
  }

  const chunk = (id: string, content: unknown, extra: Record<string, unknown> = {}): unknown => [
    { type: 'AIMessageChunk', id, content, tool_call_chunks: [], ...extra },
    { langgraph_node: 'agent' },
  ];

  it('folds a LangGraph stream into a run, stamping synthetic events with the frame seq and time', () => {
    const builder = lgBuilder();
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1', attempt: 1 }));
    builder.addRecord(lgRecord(2, 'messages', chunk('m1', 'Hel')));
    builder.addRecord(lgRecord(3, 'messages', chunk('m1', 'lo', { chunk_position: 'last' })));
    builder.addRecord(lgRecord(4, 'values', { messages: [] }));
    builder.closeConnection('c1', 50);

    const [run] = builder.runs();
    expect(run?.runId).toBe('r-1');
    expect(run?.threadId).toBe('t-1');
    expect(run?.dialect).toBe('langgraph');
    expect(run?.outcome).toBe('finished');
    expect(run?.input).toEqual({ assistant_id: 'agent', stream_mode: ['values', 'messages-tuple'] });
    expect(run?.messages.get('m1')).toMatchObject({ content: 'Hello', closed: true, contentSeqs: [2, 3] });
    expect(run?.recordSeqs).toEqual([1, 2, 3, 4]);
    expect(run?.issues).toEqual([]);
    expect(run?.metrics.ttftMs).toBe(10);
  });

  it('counts wire event names, one per frame, not synthetic event types (L13)', () => {
    const builder = lgBuilder();
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'messages', chunk('m1', 'Hi')));
    builder.addRecord(lgRecord(3, 'messages', chunk('m1', '!')));
    builder.addRecord(lgRecord(4, 'values', { messages: [] }));
    builder.closeConnection('c1', 50);
    expect(builder.runs()[0]?.metrics.eventCountByType).toEqual({ metadata: 1, messages: 2, values: 1 });
  });

  it('runs no AG-UI rule on a LangGraph run — no run-started-without-input, no unclosed-message', () => {
    const builder = createRunBuilder(); // no request at all
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'messages', chunk('m1', 'Hi')));
    builder.closeConnection('c1', 30);
    const codes = builder.allIssues().map((issue) => issue.code);
    expect(codes).toEqual(['lg-no-final-values']);
    expect(builder.runs()[0]?.outcome).toBe('aborted');
  });

  it('records the interrupted outcome (L9)', () => {
    const builder = lgBuilder();
    builder.addRecord(lgRecord(1, 'metadata', { run_id: 'r-1' }));
    builder.addRecord(lgRecord(2, 'values', { __interrupt__: [{ value: 'ok?' }] }));
    builder.closeConnection('c1', 30);
    expect(builder.runs()[0]?.outcome).toBe('interrupted');
  });

  it('leaves an AG-UI connection exactly as it was: no dialect, AG-UI types counted', () => {
    const builder = createRunBuilder();
    const record = (seq: number, event: AguiEvent): CaptureRecord => ({
      kind: 'event', seq, tMs: seq, connId: 'a1', raw: event, event, issues: [],
    });
    builder.addRecord(record(1, { type: 'RUN_STARTED', runId: 'r', threadId: 't' }));
    builder.addRecord(record(2, { type: 'RUN_FINISHED', runId: 'r', threadId: 't' }));
    builder.closeConnection('a1', 3);
    const [run] = builder.runs();
    expect(run?.dialect).toBeUndefined();
    expect(run?.metrics.eventCountByType).toEqual({ RUN_STARTED: 1, RUN_FINISHED: 1 });
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter ag-ui-devtools exec vitest run src/core/normalizer/run-builder.test.ts` → the new tests FAIL (the LangGraph stream lands in the orphaned run).

- [ ] **Step 3: Implement in `run-builder.ts`.**

Imports — add:

```ts
import { dialectOf, type Dialect } from './dialect';
import { createLangGraphExpander, type LangGraphExpander } from './langgraph/expander';
```

`ConnEntry` — add two fields:

```ts
  /** Decided once, at the connection's first event record (L4). */
  dialect?: Dialect;
  /** Present exactly when `dialect` is `'langgraph'`. */
  langGraph?: LangGraphExpander;
```

`foldEvent` — add a `validate` parameter (every existing call keeps today's behaviour):

```ts
  function foldEvent(
    entry: RunEntry,
    event: AguiEvent,
    record: EventRecord,
    countBytes: boolean,
    validate = true,
  ): void {
    // L12: a synthetic event from the LangGraph expander is correct by construction. An AG-UI
    // issue raised against one would be our translation bug reported as the user's.
    const issues = validate ? runRules(event, record, entry.validation) : [];
    applyTransition(entry, event, record);
    noteRecord(entry, record, event, countBytes);
    attachIssues(entry, issues);
  }
```

Add, after `flushChunkStateOntoCurrentRun`:

```ts
  function dialectFor(conn: ConnEntry, record: EventRecord): Dialect {
    conn.dialect ??= dialectOf(
      conn.method !== undefined && conn.url !== undefined
        ? { method: conn.method, url: conn.url }
        : undefined,
      { ...(record.sseEvent !== undefined ? { sseEvent: record.sseEvent } : {}), payload: record.raw },
    );
    return conn.dialect;
  }

  /** Fold synthetic events onto the runs they resolve to, stamped with the source frame (L10). */
  function foldSynthetic(conn: ConnEntry, events: readonly AguiEvent[], record: EventRecord): RunEntry | undefined {
    let first: RunEntry | undefined;
    events.forEach((event, i) => {
      const entry = resolveRun(conn, event, record);
      entry.run.dialect = 'langgraph';
      first ??= entry;
      // Only the first carries the frame's bytes, so a frame is counted once (L13).
      foldEvent(entry, event, record, i === 0, false);
    });
    return first;
  }

  /**
   * A LangGraph frame. Read `raw`, not `event`: `event` is null for any non-object payload, and
   * the `messages` tuple is a JSON array. A frame that produces no synthetic event — a namespaced
   * event, `messages/metadata`, a `debug` frame — is still recorded on its run, raw.
   */
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
    const first = foldSynthetic(conn, expansion.events, record);
    const openEntry = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
    const target = first ?? openEntry ?? ensureOrphanEntry(conn.connId, record.tMs);
    if (expansion.events.length === 0) noteRecord(target, record, null, true);
    attachIssues(target, expansion.issues);
    attachIssues(target, record.issues);
  }

  /** The expander's end of stream: close what is open and settle the outcome (L6, L9). */
  function finishLangGraph(conn: ConnEntry, tMs: number): void {
    if (conn.langGraph === undefined || conn.openRunId === undefined) return;
    const entry = entries.get(conn.openRunId);
    if (entry === undefined) return;
    const seq = entry.run.recordSeqs.at(-1) ?? 0;
    const finish = conn.langGraph.finish(seq);
    // Nothing was on the wire for these: `raw: undefined` keeps them out of the byte count and
    // the wire-name count, and they anchor to the run's last real seq, like the chunk flush.
    const record: EventRecord = { kind: 'event', seq, tMs, connId: conn.connId, raw: undefined, event: null, issues: [] };
    for (const event of finish.events) foldEvent(entry, event, { ...record, event }, false, false);
    attachIssues(entry, finish.issues.map((raised) => ({ ...raised, tMs })));
    if (finish.interrupted) entry.run.outcome = 'interrupted';
  }
```

In `addRecord`, immediately after the keepalive branch (before `if (record.event === null)`), add:

```ts
    // 1b. A LangGraph connection folds through its expander (L4). Decided before the null check:
    //     a LangGraph `messages` tuple is an array, so its `event` is null by construction.
    if (dialectFor(conn, record) === 'langgraph') {
      foldLangGraph(conn, record);
      return;
    }
```

In `closeConnection`, after `flushChunkStateOntoCurrentRun(conn, tMs);`, add `finishLangGraph(conn, tMs);`, and change the `finalizeRules` line to:

```ts
        // L12: the run-end rules are AG-UI rules. A LangGraph run's end is settled by the
        // expander's `finish`, which closes what is open and raises its own issues.
        if (conn.dialect !== 'langgraph') attachIssues(entry, finalizeRules(entry.validation, tMs));
```

- [ ] **Step 4: Implement in `run-metrics.ts`.** Replace

```ts
    if (record.kind !== 'event') continue;
    const event = record.event;
    if (event === null) continue;
```

(keep the comment above it) with:

```ts
    if (record.kind !== 'event') continue;
    /*
     * L13: a LangGraph run counts WIRE event names — `metadata`, `messages`,
     * `messages|research:…` — one per frame, because its AG-UI events are synthetic and a count
     * of them would describe our translation, not the stream. `raw !== undefined` is "this
     * record carries a real frame": only the first synthetic event of a frame carries its bytes,
     * and the end-of-stream events carry none. A frame with no `event:` name was dispatched by
     * SSE as `message`, so it is counted under that name.
     */
    if (run.dialect === 'langgraph' && record.raw !== undefined) {
      const name = record.sseEvent ?? 'message';
      eventCountByType[name] = (eventCountByType[name] ?? 0) + 1;
    }
    const event = record.event;
    if (event === null) continue;
```

and change the existing counting line to:

```ts
    if (run.dialect !== 'langgraph') {
      eventCountByType[event.type] = (eventCountByType[event.type] ?? 0) + 1;
    }
```

- [ ] **Step 5: Run** `pnpm --filter ag-ui-devtools exec vitest run src/core` → all PASS, including every pre-existing run-builder, metrics and integration test (AG-UI must be untouched). Then the full suite, typecheck, lint → green.

- [ ] **Step 6: Commit.**

```bash
git add packages/devtools/src/core/normalizer/run-builder.ts packages/devtools/src/core/normalizer/run-builder.test.ts packages/devtools/src/core/metrics/run-metrics.ts
git commit -m "feat(core): the run builder folds LangGraph connections through the expander (L4, L10, L12, L13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: end-to-end through `loadJsonl`

**Files:** Create `packages/devtools/src/test/langgraph-capture.ts`, `packages/devtools/src/test/langgraph.integration.test.ts`.

- [ ] **Step 1: The helper.**

```ts
// packages/devtools/src/test/langgraph-capture.ts
/**
 * Build `.agui.jsonl` text for a LangGraph Platform capture, the way the extension writes one:
 * a request line, then one event line per SSE frame with its name in `sseEvent`.
 */
export interface LangGraphTestFrame {
  readonly event: string;
  readonly data: unknown;
}

export interface LangGraphCaptureOptions {
  readonly connId?: string;
  readonly url?: string;
  readonly body?: unknown;
  readonly header?: boolean;
}

export const DEFAULT_LG_URL = 'http://localhost:2024/threads/t-1/runs/stream';

export const DEFAULT_LG_BODY = {
  assistant_id: 'agent',
  input: { messages: [{ type: 'human', content: 'hi' }] },
  stream_mode: ['values', 'messages-tuple', 'updates', 'custom'],
};

export function langGraphJsonl(frames: readonly LangGraphTestFrame[], options: LangGraphCaptureOptions = {}): string {
  const connId = options.connId ?? 'c1';
  const lines: unknown[] = [];
  if (options.header ?? true) {
    lines.push({
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@test',
      capturedAt: '2026-09-30T12:00:00.000Z',
      url: 'http://localhost:2024',
      transport: 'sse',
      redacted: [],
    });
  }
  lines.push({
    kind: 'request',
    connId,
    tMs: 0,
    method: 'POST',
    url: options.url ?? DEFAULT_LG_URL,
    input: options.body ?? DEFAULT_LG_BODY,
  });
  frames.forEach((frame, i) => {
    const seq = i + 1;
    lines.push({ kind: 'event', connId, seq, tMs: seq * 10, ...(frame.event !== '' ? { sseEvent: frame.event } : {}), event: frame.data });
  });
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

/** A `messages` tuple frame carrying one assistant chunk. */
export function aiChunk(id: string, content: unknown, extra: Record<string, unknown> = {}): LangGraphTestFrame {
  return {
    event: 'messages',
    data: [{ type: 'AIMessageChunk', id, content, tool_call_chunks: [], ...extra }, { langgraph_node: 'agent' }],
  };
}
```

- [ ] **Step 2: The tests** (they should pass as soon as they are written, since Tasks 4–5 built the behaviour — **run them, and for each describe block temporarily break one line of the expander it depends on to watch it fail, then restore**; report which line you broke for each).

```ts
// packages/devtools/src/test/langgraph.integration.test.ts
/**
 * LangGraph Platform captures, end to end through `loadJsonl` — the same fold live capture uses.
 */
import { describe, expect, it } from 'vitest';

import happyJsonl from './fixtures/happy-run.agui.jsonl?raw';
import { encodeJsonl } from '../core/jsonl/codec';
import type { Run } from '../core/model/types';
import { buildExport } from '../panel/export/build';
import { loadJsonl } from '../panel/import/load-jsonl';
import { aiChunk, langGraphJsonl, type LangGraphTestFrame } from './langgraph-capture';

function load(frames: readonly LangGraphTestFrame[], options = {}): ReturnType<typeof loadJsonl> {
  return loadJsonl(langGraphJsonl(frames, options));
}

function only(loaded: ReturnType<typeof loadJsonl>): Run {
  expect(loaded.runs).toHaveLength(1);
  return loaded.runs[0]!;
}

const codes = (run: Run): Array<[string, number]> => run.issues.map((issue) => [issue.code, issue.seq]);

describe('LangGraph: text and reasoning', () => {
  const frames: LangGraphTestFrame[] = [
    { event: 'metadata', data: { run_id: 'r-1', attempt: 1 } },
    { event: 'values', data: { messages: [{ type: 'human', content: 'hi', id: 'h1' }] } },
    aiChunk('resp_x', []),
    aiChunk('m1', [{ type: 'reasoning', index: 0, summary: [{ index: 0, type: 'summary_text', text: 'Think' }] }]),
    aiChunk('m1', [{ type: 'reasoning', index: 0, summary: [{ index: 0, type: 'summary_text', text: 'ing' }] }]),
    aiChunk('m1', [{ type: 'text', index: 1, text: 'Hel' }]),
    aiChunk('m1', [{ type: 'text', index: 1, text: 'lo' }]),
    aiChunk('m1', [], { chunk_position: 'last', usage_metadata: { output_tokens: 5 } }),
    { event: 'updates', data: { agent: { messages: [] } } },
    { event: 'values', data: { messages: [{ type: 'human', content: 'hi' }, { type: 'ai', id: 'm1', content: 'Hello' }] } },
  ];

  it('reconstructs the answer and its reasoning, and invents no message for the empty resp_ chunk', () => {
    const run = only(load(frames));
    expect(run.runId).toBe('r-1');
    expect(run.threadId).toBe('t-1');
    expect(run.outcome).toBe('finished');
    expect([...run.messages.keys()].sort()).toEqual(['m1', 'm1:reasoning']);
    expect(run.messages.get('m1')).toMatchObject({ kind: 'text', content: 'Hello', closed: true, contentSeqs: [6, 7] });
    expect(run.messages.get('m1:reasoning')).toMatchObject({ kind: 'reasoning', content: 'Thinking', closed: true });
    expect(run.issues).toEqual([]);
  });

  it('keeps state, steps, timing and wire counts', () => {
    const run = only(load(frames));
    expect(run.stateTimeline).toHaveLength(2);
    expect(run.steps).toEqual([{ stepName: 'agent', startedAtMs: 90, endedAtMs: 90, closed: true }]);
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(run.metrics.ttftMs).toBe(50);
    expect(run.metrics.eventCountByType).toEqual({ metadata: 1, values: 2, messages: 6, updates: 1 });
  });
});

describe('LangGraph: tool calls', () => {
  it('accumulates streamed args by index, parses them, and takes the result once', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        aiChunk('m2', [], { tool_call_chunks: [{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci', type: 'tool_call_chunk' }] }),
        aiChunk('m2', [], { tool_call_chunks: [{ index: 0, args: 'ty":"SF"}' }] }),
        aiChunk('m2', [], { chunk_position: 'last' }),
        { event: 'messages', data: [{ type: 'tool', id: 'tm1', tool_call_id: 'call_1', content: 'Sunny' }, { langgraph_node: 'tools' }] },
        { event: 'values', data: { messages: [{ type: 'tool', id: 'tm1', tool_call_id: 'call_1', content: 'Sunny' }] } },
      ]),
    );
    const call = run.toolCalls.get('call_1');
    expect(call).toMatchObject({
      toolCallName: 'get_weather',
      parentMessageId: 'm2',
      argsText: '{"city":"SF"}',
      args: { city: 'SF' },
      closed: true,
      result: 'Sunny',
      resultAtMs: 50,
    });
    expect(run.issues).toEqual([]);
  });

  it('gives a call with no id a stable synthetic one (L8)', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        aiChunk('m3', [], { tool_call_chunks: [{ index: 0, name: 'lookup', args: '{}' }], chunk_position: 'last' }),
        { event: 'values', data: {} },
      ]),
    );
    expect([...run.toolCalls.keys()]).toEqual(['m3#0']);
  });

  it('does not attach an earlier run’s tool result from the thread history in values', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-2' } },
        { event: 'values', data: { messages: [{ type: 'tool', tool_call_id: 'old_call', content: 'from run 1' }] } },
      ]),
    );
    expect(run.toolCalls.size).toBe(0);
  });
});

describe('LangGraph: how a run ends', () => {
  it('interrupted', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        { event: 'values', data: { messages: [] } },
        { event: 'updates', data: { __interrupt__: [{ value: 'approve?', id: 'i1' }] } },
        { event: 'values', data: { __interrupt__: [{ value: 'approve?', id: 'i1' }] } },
      ]),
    );
    expect(run.outcome).toBe('interrupted');
    expect(run.stateTimeline).toHaveLength(1);
    expect(run.steps).toEqual([]);
    expect(run.issues).toEqual([]);
  });

  it('error, with the open message closed and no finish on top', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        aiChunk('m1', [{ type: 'text', text: 'partial' }]),
        { event: 'error', data: { error: 'ValueError', message: 'boom' } },
      ]),
    );
    expect(run.outcome).toBe('error');
    expect(run.endedAtMs).toBe(30);
    expect(run.messages.get('m1')).toMatchObject({ content: 'partial', closed: true });
    expect(run.issues).toEqual([]);
  });
});

describe('LangGraph: the legacy messages mode', () => {
  const body = { assistant_id: 'agent', stream_mode: ['messages', 'values'] };
  const partial = (content: string): LangGraphTestFrame => ({ event: 'messages/partial', data: [{ type: 'ai', id: 'm1', content }] });

  it('turns cumulative partials into one message', () => {
    const run = only(
      load(
        [
          { event: 'metadata', data: { run_id: 'r-1' } },
          { event: 'messages/metadata', data: { m1: { metadata: { langgraph_node: 'agent' } } } },
          partial('He'),
          partial('Hello'),
          partial('Hello world'),
          { event: 'messages/complete', data: [{ type: 'ai', id: 'm1', content: 'Hello world' }] },
          { event: 'values', data: { messages: [] } },
        ],
        { body },
      ),
    );
    expect(run.messages.get('m1')).toMatchObject({ content: 'Hello world', closed: true, contentSeqs: [3, 4, 5] });
    expect(run.outcome).toBe('finished');
    expect(run.issues).toEqual([]);
  });

  it('flags a partial that does not extend the last, and a complete that disagrees', () => {
    const run = only(
      load(
        [
          { event: 'metadata', data: { run_id: 'r-1' } },
          partial('Hello'),
          partial('Help'),
          { event: 'messages/complete', data: [{ type: 'ai', id: 'm1', content: 'Nope' }] },
          { event: 'values', data: {} },
        ],
        { body },
      ),
    );
    expect(codes(run)).toEqual([
      ['lg-partial-regressed', 3],
      ['lg-complete-mismatch', 4],
    ]);
  });
});

describe('LangGraph: a malformed stream produces exactly its issues, at the right frames', () => {
  it('unknown event, undecodable payload, bad tool args, no final values', () => {
    const run = only(
      load(
        [
          { event: 'metadata', data: { run_id: 'r-1' } },
          { event: 'wat', data: { x: 1 } },
          { event: 'messages', data: { not: 'an array' } },
          aiChunk('m1', [], { tool_call_chunks: [{ index: 0, id: 'c1', name: 'f', args: 'not json' }], chunk_position: 'last' }),
        ],
        { body: { assistant_id: 'agent', stream_mode: ['values', 'messages-tuple'] } },
      ),
    );
    expect(codes(run)).toEqual([
      ['lg-unknown-event', 2],
      ['lg-undecodable', 3],
      ['lg-tool-args-invalid', 4],
      ['lg-no-final-values', 4],
    ]);
    expect(run.outcome).toBe('aborted');
  });

  it('a stream that opens without metadata', () => {
    const run = only(load([aiChunk('m1', 'Hi'), { event: 'values', data: {} }]));
    expect(run.runId).toBe('lg:c1');
    expect(codes(run)).toEqual([['lg-no-metadata', 1]]);
  });
});

describe('LangGraph: subgraph events, before PR 3', () => {
  it('are recorded on the run and counted, and fold nothing', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        { ...aiChunk('s1', [{ type: 'text', text: 'sub' }]), event: 'messages|research:abc' },
        { event: 'values', data: { x: 1 } },
      ]),
    );
    expect(run.messages.size).toBe(0);
    expect(run.recordSeqs).toEqual([1, 2, 3]);
    expect(run.metrics.eventCountByType).toEqual({ metadata: 1, 'messages|research:abc': 1, values: 1 });
    expect(run.issues).toEqual([]);
  });
});

describe('LangGraph and AG-UI side by side in one capture', () => {
  it('folds each connection in its own dialect', () => {
    const lg = langGraphJsonl(
      [{ event: 'metadata', data: { run_id: 'lg-run' } }, aiChunk('m1', 'Hi'), { event: 'values', data: {} }],
      { connId: 'lg1', header: false },
    );
    const loaded = loadJsonl(`${happyJsonl.trimEnd()}\n${lg}`);
    const alone = loadJsonl(happyJsonl);
    const aguiRun = loaded.runs.find((run) => run.dialect === undefined);
    const lgRun = loaded.runs.find((run) => run.dialect === 'langgraph');
    expect(lgRun?.runId).toBe('lg-run');
    expect(lgRun?.messages.get('m1')?.content).toBe('Hi');
    // The AG-UI run is exactly what it is without the LangGraph connection beside it.
    expect(aguiRun?.issues).toEqual(alone.runs[0]?.issues);
    expect(aguiRun?.metrics).toEqual(alone.runs[0]?.metrics);
    expect([...(aguiRun?.messages.values() ?? [])]).toEqual([...(alone.runs[0]?.messages.values() ?? [])]);
  });
});

describe('LangGraph: export, clear, re-import — the tabs are identical', () => {
  function project(run: Run): unknown {
    return {
      runId: run.runId,
      threadId: run.threadId,
      outcome: run.outcome,
      dialect: run.dialect,
      messages: [...run.messages.values()],
      toolCalls: [...run.toolCalls.values()],
      steps: run.steps,
      stateTimeline: run.stateTimeline,
      issues: run.issues.map((issue) => [issue.code, issue.seq]),
      counts: run.metrics.eventCountByType,
    };
  }

  it('round-trips a LangGraph capture', () => {
    const text = langGraphJsonl([
      { event: 'metadata', data: { run_id: 'r-1' } },
      aiChunk('m1', [], { tool_call_chunks: [{ index: 0, id: 'c1', name: 'f', args: '{"a":1}' }] }),
      aiChunk('m1', 'done', { chunk_position: 'last' }),
      { event: 'values', data: { messages: [] } },
    ]);
    const first = loadJsonl(text);
    const exported = buildExport(
      {
        records: first.records,
        requests: first.requests,
        runs: first.runs,
        importedHeader: first.header,
        runtime: first.runtime,
        framework: null,
        binaryTransport: null,
        source: { kind: 'imported', filename: 'lg.agui.jsonl', importedAtMs: 0 },
      },
      { scope: null, groups: [], toolVersion: 'test', exportedAtIso: '2026-09-30T12:00:00.000Z' },
    );
    const again = loadJsonl(encodeJsonl(exported.lines));
    expect(again.runs.map(project)).toEqual(first.runs.map(project));
  });
});
```

- [ ] **Step 3: Run** `pnpm --filter ag-ui-devtools exec vitest run src/test/langgraph.integration.test.ts` → PASS. If an expectation fails, **do not change the expectation to match the code** until you have worked out which one is wrong — the numbers above are derived from the spec (seq n has `tMs = n*10`; the first text chunk is seq 6 → TTFT 60−10 = 50). Report any disagreement.

- [ ] **Step 4: Commit.**

```bash
git add packages/devtools/src/test/langgraph-capture.ts packages/devtools/src/test/langgraph.integration.test.ts
git commit -m "test: LangGraph captures end to end through loadJsonl

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: the golden fixture from a real recording

**Files:** Create `packages/devtools/src/test/fixtures/lg-reasoning.agui.jsonl`, `lg-reasoning.canonical.txt`; append to `langgraph.integration.test.ts`.

Source: `/Users/blove/repos/angular-agent-framework/libs/langgraph/test/fixtures/streaming-reasoning-puzzle.json` — Threadplane's recording from a Python `langgraph dev` server (api 0.8.7, langgraph 1.1.10), gpt-5 through the Responses API, `stream_mode: ['messages-tuple','values']`. 1,213 events: 1 `metadata`, 1,210 `messages`, 2 `values`. Its text blocks concatenate to exactly `canonical_text` (841 chars).

- [ ] **Step 1: Generate the fixture** (run from the repo root; it trims each chunk to the fields the expander reads, so the file stays small and carries no provider metadata):

```bash
python3 - <<'EOF'
import json
src = json.load(open('/Users/blove/repos/angular-agent-framework/libs/langgraph/test/fixtures/streaming-reasoning-puzzle.json'))
out = 'packages/devtools/src/test/fixtures/'
keep_chunk = ('type', 'id', 'content', 'tool_call_chunks', 'chunk_position', 'usage_metadata')
keep_meta = ('langgraph_node', 'langgraph_step', 'run_id', 'thread_id')
lines = [
  {'kind': 'header', 'schemaVersion': 1, 'tool': 'ag-ui-devtools@fixture', 'capturedAt': '2026-05-08T00:00:00.000Z',
   'url': 'http://127.0.0.1:2024', 'transport': 'sse', 'redacted': []},
  {'kind': 'request', 'connId': 'c1', 'tMs': 0, 'method': 'POST',
   'url': 'http://127.0.0.1:2024/threads/%s/runs/stream' % src['thread_id'],
   'input': {'assistant_id': 'chat', 'input': {'messages': [{'type': 'human', 'content': 'Three friends start with 14 apples. They share them so each gets a different prime number of apples and one gets exactly twice as many as another. How many does each get? Walk through your reasoning step by step.'}]},
             'stream_mode': ['messages-tuple', 'values']}},
]
for i, ev in enumerate(src['events']):
  data = ev['data']
  if ev['event'] == 'messages':
    chunk, meta = data
    data = [{k: chunk[k] for k in keep_chunk if k in chunk}, {k: meta[k] for k in keep_meta if k in meta}]
  lines.append({'kind': 'event', 'connId': 'c1', 'seq': i + 1, 'tMs': (i + 1) * 5, 'sseEvent': ev['event'], 'event': data})
with open(out + 'lg-reasoning.agui.jsonl', 'w') as f:
  f.write('\n'.join(json.dumps(line, ensure_ascii=False, separators=(',', ':')) for line in lines) + '\n')
with open(out + 'lg-reasoning.canonical.txt', 'w') as f:
  f.write(src['canonical_text'])
EOF
ls -la packages/devtools/src/test/fixtures/lg-reasoning.*
```

Expected: the `.jsonl` is well under 1 MB. If it is larger than 1 MB, report the size before committing.

- [ ] **Step 2: Append the test** to `langgraph.integration.test.ts` (add the two `?raw` imports at the top with the other imports):

```ts
import lgReasoningJsonl from './fixtures/lg-reasoning.agui.jsonl?raw';
import lgReasoningCanonical from './fixtures/lg-reasoning.canonical.txt?raw';
```

```ts
describe('LangGraph golden: a real Python-server recording (gpt-5, reasoning then text)', () => {
  const loaded = loadJsonl(lgReasoningJsonl);

  it('reconstructs the streamed answer byte for byte', () => {
    const run = only(loaded);
    const text = [...run.messages.values()].filter((message) => message.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.content).toBe(lgReasoningCanonical);
  });

  it('has one reasoning message, streamed before the text, and nothing under the resp_ id', () => {
    const run = only(loaded);
    const reasoning = [...run.messages.values()].filter((message) => message.kind === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.content.length).toBeGreaterThan(0);
    expect([...run.messages.keys()].some((id) => id.startsWith('resp_'))).toBe(false);
    expect(run.metrics.ttfrtMs).toBeLessThan(run.metrics.ttftMs ?? 0);
  });

  it('finishes cleanly, with the wire counts of the recording', () => {
    const run = only(loaded);
    expect(run.runId).toBe('019e0a0b-6976-7c72-8d57-479ba0c859f6');
    expect(run.outcome).toBe('finished');
    expect(run.issues).toEqual([]);
    expect(run.metrics.eventCountByType).toEqual({ metadata: 1, messages: 1210, values: 2 });
  });
});
```

- [ ] **Step 3: Run** → PASS. Break-check: temporarily make `foldAiDelta` open a message on empty chunks too (remove the content condition) and confirm "nothing under the resp_ id" fails; restore.

- [ ] **Step 4: Commit.**

```bash
git add packages/devtools/src/test/fixtures/lg-reasoning.agui.jsonl packages/devtools/src/test/fixtures/lg-reasoning.canonical.txt packages/devtools/src/test/langgraph.integration.test.ts
git commit -m "test: golden LangGraph fixture from a real Python-server recording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: fixture export writes LangGraph as named frames (L18)

**Files:** Modify `packages/devtools/src/panel/export/fixture.ts`; test `packages/devtools/src/panel/export/fixture.test.ts` (append).

- [ ] **Step 1: Failing tests.** Append (reuse the file's `linesOf` helper and imports; add `import { langGraphJsonl, aiChunk } from '../../test/langgraph-capture';`):

```ts
describe('toFixtureModule — LangGraph connections (L18)', () => {
  const lgText = langGraphJsonl([
    { event: 'metadata', data: { run_id: 'r-1' } },
    aiChunk('m1', 'Hi'),
    { event: 'values', data: { messages: [] } },
  ]);

  test('writes LangGraph frames as {event, data} pairs, named, in order', () => {
    const module = toFixtureModule(linesOf(lgText), 'lg.fixture.ts');
    expect(module).toContain('export const langGraphEvents: LangGraphFrame[] = [');
    const names = [...module.matchAll(/"event": "([a-z/|:]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(['metadata', 'messages', 'values']);
  });

  test('a LangGraph-only capture has an empty AG-UI array and defaults to its LangGraph frames', () => {
    const module = toFixtureModule(linesOf(lgText), 'lg.fixture.ts');
    expect(module).toContain('export const events: AguiEvent[] = [] as AguiEvent[];');
    expect(module).toContain('export default langGraphEvents;');
  });

  test('an AG-UI capture has no LangGraph block at all', () => {
    const module = toFixtureModule(linesOf(), 'f.fixture.ts');
    expect(module).not.toContain('langGraphEvents');
    expect(module).toContain('export default events;');
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter ag-ui-devtools exec vitest run src/panel/export/fixture.test.ts` → the new tests FAIL.

- [ ] **Step 3: Implement.** In `fixture.ts`, add the import `import { dialectOf, type Dialect } from '../../core/normalizer/dialect';` and `import type { JsonlEvent } from '../../core/jsonl/codec';` (merge with the existing codec import), then add:

```ts
/**
 * Each connection's dialect, by the one rule the run builder uses (L5): its request line, and its
 * first event line. A header or keepalive decides nothing.
 */
function dialectsOf(lines: readonly JsonlLine[]): Map<string, Dialect> {
  const requests = new Map<string, { method: string; url: string }>();
  const firstEvents = new Map<string, JsonlEvent>();
  for (const line of lines) {
    if (line.kind === 'request' && !requests.has(line.connId)) {
      requests.set(line.connId, { method: line.method, url: line.url });
    } else if (line.kind === 'event' && !firstEvents.has(line.connId)) {
      firstEvents.set(line.connId, line);
    }
  }
  const dialects = new Map<string, Dialect>();
  for (const connId of new Set([...requests.keys(), ...firstEvents.keys()])) {
    const first = firstEvents.get(connId);
    dialects.set(
      connId,
      dialectOf(
        requests.get(connId),
        first === undefined
          ? undefined
          : { ...(first.sseEvent !== undefined ? { sseEvent: first.sseEvent } : {}), payload: first.event },
      ),
    );
  }
  return dialects;
}
```

In `toFixtureModule`, replace the `const events = …` line with:

```ts
  const dialects = dialectsOf(lines);
  const eventLines = lines.flatMap((line) => (line.kind === 'event' ? [line] : []));
  const events = eventLines.filter((line) => dialects.get(line.connId) !== 'langgraph').map((line) => line.event);
  /*
   * L18: a LangGraph frame's type is its SSE event name, not a field of its payload, so a bare
   * payload array is not replayable by anything. These are written as the named frames they were.
   * §14.2 grows this into a `MockAgentTransport` module; this is the minimum that stays true.
   */
  const langGraphFrames = eventLines
    .filter((line) => dialects.get(line.connId) === 'langgraph')
    .map((line) => ({ event: line.sseEvent ?? 'message', data: line.event }));
  const langGraphBlock =
    langGraphFrames.length === 0
      ? ''
      : `
/** LangGraph Platform frames: \`event\` is the SSE event name, \`data\` its payload. */
export type LangGraphFrame = { event: string; data: unknown };

export const langGraphEvents: LangGraphFrame[] = ${JSON.stringify(langGraphFrames, null, 2)};
`;
  const defaultExport = events.length === 0 && langGraphFrames.length > 0 ? 'langGraphEvents' : 'events';
```

and in the returned template, replace the tail

```
export const events: AguiEvent[] = ${JSON.stringify(events, null, 2)} as AguiEvent[];

export default events;
```

with

```
export const events: AguiEvent[] = ${JSON.stringify(events, null, 2)} as AguiEvent[];
${langGraphBlock}
export default ${defaultExport};
```

Check: for an AG-UI-only capture `langGraphBlock` is `''`, and the template's `;\n${langGraphBlock}\nexport default` then yields exactly today's `;\n\nexport default events;` — the AG-UI output is byte-identical. Verify that with a quick diff of the happy-run module before and after.

- [ ] **Step 4: Run** the fixture tests (all, old and new) → PASS; full panel suite → PASS; typecheck, lint → exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/devtools/src/panel/export/fixture.ts packages/devtools/src/panel/export/fixture.test.ts
git commit -m "feat(export): the fixture writes LangGraph connections as named frames (L18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: record the decisions, mutation checks, gates, PR

- [ ] **Step 1: Update the spec** `docs/superpowers/specs/2026-09-29-langgraph-normalization-design.md`:
  - In the L6 mapping table, replace the last row (`connection close, complete, no error seen`) with two rows:
    - `connection close after an interrupt` → `close open messages, RUN_FINISHED; outcome interrupted`
    - `connection close, no error` → `close open messages; RUN_FINISHED if the request did not ask for values, or a top-level values / messages/complete / checkpoints arrived after the last message chunk — otherwise lg-no-final-values and no finish, so the run is aborted`
  - Add after the L10 row a short paragraph **"Implementation notes (PR 2)"**: reasoning is the separate message `` `${id}:reasoning` `` and closes when text or a tool call starts; a `values` event closes the open message; tool results from `values` only for calls this run started; frames after `error` fold nothing; `lg-undecodable` means a payload that is not the shape its event name carries; the expander returns events without a `runKey` in PR 2 (top-level only) — PR 3 adds it with child runs.
- [ ] **Step 2: Mutation checks** — apply each, run the named tests, confirm a FAIL, revert (`git checkout -- <file>`):

| Mutation | Must fail |
|---|---|
| `dialect.ts`: always return `'agui'` | builder LangGraph tests, integration tests |
| expander: emit `TEXT_MESSAGE_START` on an empty chunk (opening without emitting is unobservable) | "invents no message for the empty resp_ chunk", golden resp_ test |
| expander: `values` path emits results for any tool call (drop `onlyIfStartedHere`) | "does not attach an earlier run’s tool result" |
| expander `finish`: always emit `RUN_FINISHED` | "does not finish a run that asked for values", malformed issues test |
| run-builder: validate synthetic events (`validate` ignored) | "runs no AG-UI rule on a LangGraph run" |
| run-metrics: count synthetic `event.type` for LangGraph | "counts wire event names" |
| fixture.ts: ignore dialect | L18 tests |

- [ ] **Step 3: Gates** from the repo root: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing && pnpm test:e2e` → all exit 0. Record unit and harness counts against `main`.
- [ ] **Step 4: Commit the spec update**, push, open the PR (body: what the expander does, the decisions list above, the mutation table, counts; ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), and enable auto-merge (squash).
