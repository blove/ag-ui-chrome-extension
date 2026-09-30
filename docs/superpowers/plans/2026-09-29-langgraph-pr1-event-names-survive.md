# LangGraph PR 1 — Event Names Survive: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the SSE `event:` name from the page's `fetch`/XHR stream all the way into `CaptureRecord` and the `.agui.jsonl` file (export and import), and recognise LangGraph Platform's streaming routes. Unredacted AG-UI captures are unchanged; a redacted export now also redacts unparseable frames, unknown-type events, and named frames that are not the AG-UI event they name, in full — see Task 6b.

**Architecture:** Spec [`2026-09-29-langgraph-normalization-design.md`](../specs/2026-09-29-langgraph-normalization-design.md) decisions **L1, L2, L3**. One pure helper, `normalizeEventName`, decides what counts as a name (empty and the SSE default `message` do not). The name rides as an optional `eventName` on `WireFrame` (inject → relay → sw), becomes an optional `sseEvent` on `CaptureRecord` and `JsonlEvent`, and round-trips through export/import. `routeHint` gains a `langgraph-run` arm. Nothing reads any of it yet; PR 2 (the expander) does.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, pnpm workspace. Package: `packages/devtools`.

**Conventions you must follow:**
- Tests are colocated `*.test.ts`. Run one file with `pnpm --filter ag-ui-devtools exec vitest run <path relative to packages/devtools>`.
- Optional fields are **absent**, never `undefined`-valued: use a conditional spread `...(name !== undefined ? { eventName: name } : {})`. The relay test asserts exact `Object.keys`, and the codec rationale (spec L2) depends on absence.
- Match the surrounding comment style: comments explain *why*, cite spec decision ids (`L1`, `L2`, …).
- Commit after every task. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Change |
|---|---|
| `src/core/sse/event-name.ts` | **Create.** `normalizeEventName(value: unknown): string \| undefined` |
| `src/core/sse/event-name.test.ts` | **Create.** |
| `src/inject/protocol.ts` | `WireFrame` event arm gains `eventName?: string`; `isWireFrame` validates it; doc comment updated |
| `src/inject/protocol.test.ts` | guard tests |
| `src/inject/wire-frame.ts` | `eventFrame` takes an optional name; `sseFrameToWireFrame` passes it (XHR path) |
| `src/inject/fetch-patch.ts` | `emit` passes the name (fetch path) |
| `src/inject/raw-invariant.test.ts` | cross-transport name agreement |
| `src/relay/relay.ts` | `toRelayMessage` copies `eventName` |
| `src/relay/relay.test.ts` | forwarding + key-list tests |
| `src/core/model/types.ts` | `CaptureRecord` event arm gains `sseEvent?: string` |
| `src/sw/index.ts` | `toRecord` sets `sseEvent` |
| `src/sw/index.test.ts` | record test |
| `src/core/jsonl/codec.ts` | `JsonlEvent` gains `sseEvent?: string` |
| `src/panel/export/build.ts` | `toLine` writes `sseEvent` |
| `src/panel/import/load-jsonl.ts` | `toEventRecord` reads `sseEvent` (untrusted → normalized) |
| `src/panel/export/sse-event.test.ts` | **Create.** export → import → export round trip, redaction preserves the name |
| `src/core/detect/classifier.ts` | `RouteHint` gains `langgraph-run`; `routeHint` matches four routes |
| `src/core/detect/classifier.test.ts` | route tests |
| `src/core/jsonl/redact.ts` | (Task 6b) `redactLine`/`redactWholesale` fail closed on unrecognised and named payloads; matching-name exception |
| `src/core/jsonl/redact.test.ts` | (Task 6b) fail-closed tests; matching-name exception tests |
| `src/panel/export/redaction-issue-parity.test.ts` | (Task 6b) wholesale-redaction path added to the validator-parity sweep |

---

### Task 1: `normalizeEventName`

**Files:**
- Create: `packages/devtools/src/core/sse/event-name.ts`
- Test: `packages/devtools/src/core/sse/event-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/devtools/src/core/sse/event-name.test.ts
import { describe, expect, it } from 'vitest';

import { normalizeEventName } from './event-name';

describe('normalizeEventName', () => {
  it('keeps a real event name verbatim', () => {
    expect(normalizeEventName('values')).toBe('values');
    expect(normalizeEventName('messages|research:9f1c')).toBe('messages|research:9f1c');
    expect(normalizeEventName('messages/partial')).toBe('messages/partial');
  });

  it('treats the SSE default "message" as no name, because EventSource cannot tell them apart', () => {
    expect(normalizeEventName('message')).toBeUndefined();
  });

  it('treats an empty name as no name', () => {
    expect(normalizeEventName('')).toBeUndefined();
  });

  it('is case-sensitive, as the SSE grammar is', () => {
    expect(normalizeEventName('Message')).toBe('Message');
  });

  it('rejects anything that is not a string', () => {
    for (const value of [undefined, null, 0, 1, true, {}, [], ['values']]) {
      expect(normalizeEventName(value)).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/core/sse/event-name.test.ts`
Expected: FAIL — cannot resolve `./event-name`.

- [ ] **Step 3: Implement**

```ts
// packages/devtools/src/core/sse/event-name.ts
/**
 * What counts as an SSE event name, for everything downstream of the parser (spec L1).
 *
 * LangGraph Platform puts its event type in the `event:` field, so the name has to survive
 * capture. But the three capture transports do not see it equally: `EventSource` dispatches a
 * frame with no `event:` line and a frame with `event: message` identically, to the `message`
 * listener, and cannot tell them apart. Normalizing both — and the empty name, which the SSE
 * grammar also dispatches as `message` — to "no name" is what lets `raw-invariant.test.ts` keep
 * all three transports in agreement. No protocol this extension reads uses `message` as a
 * meaningful name; LangGraph's is `messages`, plural.
 *
 * `unknown` in, so the same function guards untrusted input: a relayed frame and an imported
 * `.agui.jsonl` line.
 */
export function normalizeEventName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === '' || value === 'message') return undefined;
  return value;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/core/sse/event-name.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/devtools/src/core/sse/event-name.ts packages/devtools/src/core/sse/event-name.test.ts
git commit -m "feat(core): normalizeEventName — what counts as an SSE event name (L1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `WireFrame.eventName` and its guard

**Files:**
- Modify: `packages/devtools/src/inject/protocol.ts` (the `WireFrame` type and its doc comment, ~L15-36; `isWireFrame`, ~L134-142)
- Test: `packages/devtools/src/inject/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `protocol.test.ts` (it already imports `isInjectMessage`, `AGUI_DT_SOURCE`, `PROTOCOL_VERSION`, `WireFrame`):

```ts
describe('isInjectMessage — the event name on a frame (L1)', () => {
  function framesWith(frame: unknown): unknown {
    return { source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION, kind: 'frames', connId: 'c1', frames: [frame] };
  }

  it('accepts an event frame carrying a string eventName', () => {
    const named: WireFrame = { kind: 'event', tMs: 1, raw: '{"run_id":"r1"}', eventName: 'metadata' };
    expect(isInjectMessage(framesWith(named))).toBe(true);
  });

  it('accepts an event frame with no eventName, as every AG-UI frame is', () => {
    expect(isInjectMessage(framesWith({ kind: 'event', tMs: 1, raw: '{}' }))).toBe(true);
  });

  it('rejects an eventName that is not a string', () => {
    for (const eventName of [1, null, {}, ['values'], true]) {
      expect(isInjectMessage(framesWith({ kind: 'event', tMs: 1, raw: '{}', eventName }))).toBe(false);
    }
  });

  it('ignores an inherited eventName rather than trusting it', () => {
    const frame = Object.create({ eventName: 42 }) as Record<string, unknown>;
    frame.kind = 'event';
    frame.tMs = 1;
    frame.raw = '{}';
    expect(isInjectMessage(framesWith(frame))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/inject/protocol.test.ts`
Expected: FAIL — "rejects an eventName that is not a string": expected true to be false (the guard currently tolerates extra keys). Vitest does not typecheck, so the `eventName` in the typed literal is not what fails here.

- [ ] **Step 3: Implement**

In `protocol.ts`, change the `WireFrame` type:

```ts
export type WireFrame =
  | { kind: 'event'; tMs: number; raw: string; eventName?: string }
  | { kind: 'keepalive'; tMs: number; raw: string; comment: string };
```

In the doc comment above it, replace the sentence
`Those fields are parsed by \`core/sse/parser\` and dropped here; anything downstream that needs one needs a field of its own on this type, not a different encoding of \`raw\`.`
with:

```
 *    `id:` and `retry:` are parsed by `core/sse/parser` and dropped here. `event:` is the one
 *    that needed a field of its own, and has one: `eventName`, present only when the frame had
 *    a real name as `core/sse/event-name` defines it (spec L1). LangGraph Platform puts its
 *    event type there; `raw` stays the payload and nothing else.
```

Change `isWireFrame`:

```ts
function isWireFrame(value: unknown): value is WireFrame {
  if (!isRecord(value)) return false;
  if (!hasOwn(value, 'tMs') || !isTime(value.tMs)) return false;
  if (!hasOwn(value, 'raw') || typeof value.raw !== 'string') return false;
  if (!hasOwn(value, 'kind')) return false;
  if (value.kind === 'event') {
    // Own property only: an inherited `eventName` is not part of the message, and the relay's
    // field-by-field rebuild never reads one.
    return !hasOwn(value, 'eventName') || typeof value.eventName === 'string';
  }
  if (value.kind === 'keepalive') return hasOwn(value, 'comment') && typeof value.comment === 'string';
  return false;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/inject/protocol.test.ts`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/devtools/src/inject/protocol.ts packages/devtools/src/inject/protocol.test.ts
git commit -m "feat(inject): WireFrame carries the SSE event name (L1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: fetch and XHR set the name; all three transports agree

**Files:**
- Modify: `packages/devtools/src/inject/wire-frame.ts`
- Modify: `packages/devtools/src/inject/fetch-patch.ts` (`emit`, ~L441-460)
- Test: `packages/devtools/src/inject/raw-invariant.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `raw-invariant.test.ts` (reuse its `captureViaFetch`, `captureViaXhr`, `captureViaEventSource`, `framesOf`):

```ts
/** A LangGraph-shaped stream: named events, one pretty-printed across several `data:` lines. */
const NAMED_WIRE =
  'event: metadata\ndata: {"run_id":"r1","attempt":1}\n\n' +
  'event: values\ndata: {\ndata:   "messages": []\ndata: }\n\n';

function eventNamesOf(posted: InjectMessage[]): (string | undefined)[] {
  return framesOf(posted)
    .filter((frame) => frame.kind === 'event')
    .map((frame) => (frame.kind === 'event' ? frame.eventName : undefined));
}

describe('WireFrame.eventName is identical across transports (L1)', () => {
  it('fetch and XHR both carry a real event name, frame for frame', async () => {
    const viaFetch = eventNamesOf(await captureViaFetch(NAMED_WIRE));
    const viaXhr = eventNamesOf(captureViaXhr(NAMED_WIRE));

    expect(viaFetch).toEqual(['metadata', 'values']);
    expect(viaXhr).toEqual(viaFetch);
  });

  it('fetch and XHR agree on raw for a named, multi-line payload', async () => {
    const viaFetch = rawOf(await captureViaFetch(NAMED_WIRE), 'event');
    expect(viaFetch).toEqual(['{"run_id":"r1","attempt":1}', '{\n  "messages": []\n}']);
    expect(rawOf(captureViaXhr(NAMED_WIRE), 'event')).toEqual(viaFetch);
  });

  it('no transport reports a name for "event: message", because EventSource cannot', async () => {
    // MULTILINE_WIRE opens with `event: message`.
    const viaFetch = framesOf(await captureViaFetch(MULTILINE_WIRE));
    const viaXhr = framesOf(captureViaXhr(MULTILINE_WIRE));
    const viaEventSource = framesOf(captureViaEventSource(MULTILINE_PAYLOAD));

    for (const frame of [...viaFetch, ...viaXhr, ...viaEventSource]) {
      expect(Object.keys(frame)).not.toContain('eventName');
    }
  });

  it('an unnamed frame has no eventName key at all, not an undefined one', async () => {
    const [frame] = framesOf(await captureViaFetch(`data: ${EVENT_PAYLOAD}\n\n`));
    expect(Object.keys(frame ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/inject/raw-invariant.test.ts`
Expected: FAIL — "fetch and XHR both carry a real event name": expected `[undefined, undefined]` to equal `['metadata', 'values']`.

- [ ] **Step 3: Implement — `wire-frame.ts` (XHR and EventSource)**

Replace `eventFrame` and `sseFrameToWireFrame`, and update the doc comment on the latter:

```ts
import { normalizeEventName } from '../core/sse/event-name';
import type { SseFrame } from '../core/sse/parser';

import type { WireFrame } from './protocol';

/**
 * An event frame. `raw` is the `data:` payload, with data lines already joined by `\n`.
 *
 * `eventName` is the frame's `event:` field. It is normalized here (spec L1) so every transport
 * applies the same rule, and it is ABSENT — not `undefined` — when there is no real name, so an
 * AG-UI frame is exactly the shape it always was.
 */
export function eventFrame(data: string, tMs: number, eventName?: string): WireFrame {
  const name = normalizeEventName(eventName);
  return { kind: 'event', tMs, raw: data, ...(name !== undefined ? { eventName: name } : {}) };
}
```

```ts
/**
 * A frame straight out of `core/sse/parser`.
 *
 * `raw` is the payload, not the frame text. `eventName` travels in a field of its own (L1);
 * `id` and `retry` are still dropped, because nothing downstream reads them.
 */
export function sseFrameToWireFrame(frame: SseFrame, tMs: number): WireFrame {
  return frame.kind === 'keepalive'
    ? keepaliveFrame(frame.comment, tMs)
    : eventFrame(frame.data, tMs, frame.eventName);
}
```

`eventsource-patch.ts` calls `eventFrame(data, now())` with two arguments and is intentionally left unchanged: it only ever sees the `message` listener, whose name normalizes to absent.

- [ ] **Step 4: Implement — `fetch-patch.ts`**

Add the import next to the existing `core/sse/parser` import:

```ts
import { normalizeEventName } from '../core/sse/event-name';
```

In `emit`, replace

```ts
        conn.frame({ kind: 'event', tMs, raw: frame.data });
```

with

```ts
        // The name rides in a field of its own (L1), normalized by the same rule the XHR path
        // applies in `wire-frame.ts` — `raw-invariant.test.ts` holds the two to it.
        const eventName = normalizeEventName(frame.eventName);
        conn.frame({
          kind: 'event',
          tMs,
          raw: frame.data,
          ...(eventName !== undefined ? { eventName } : {}),
        });
```

- [ ] **Step 5: Run the inject suite**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/inject`
Expected: PASS — the 4 new tests, and every existing `fetch-patch`, `xhr-patch`, `eventsource-patch` and `raw-invariant` test unchanged. If an existing test fails on an unexpected `eventName` key, it is feeding `event: <name>` wire text: check the name is not `message` before changing any expectation, and update the expectation only to add the real name.

- [ ] **Step 6: Commit**

```bash
git add packages/devtools/src/inject/wire-frame.ts packages/devtools/src/inject/fetch-patch.ts packages/devtools/src/inject/raw-invariant.test.ts
git commit -m "feat(inject): fetch and XHR capture the SSE event name, and agree on it (L1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the relay copies the name

**Files:**
- Modify: `packages/devtools/src/relay/relay.ts` (`toRelayMessage`, `case 'frames'`, ~L113-122)
- Test: `packages/devtools/src/relay/relay.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('relay — forwarding', …)`, beside `'forwards both frame kinds'` (reuse its `post` and `forwarded` helpers):

```ts
  it('forwards an event frame’s name, which the rebuild must name explicitly (L1)', () => {
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: 'c1',
      frames: [
        { kind: 'event', tMs: 1, raw: '{"run_id":"r1"}', eventName: 'metadata' },
        { kind: 'event', tMs: 2, raw: '{"type":"RUN_STARTED"}' },
      ],
    });
    const [message] = forwarded(chromeHarness) as Record<string, unknown>[];
    const frames = (message ?? {}).frames as Record<string, unknown>[];
    expect(frames[0]).toEqual({ kind: 'event', tMs: 1, raw: '{"run_id":"r1"}', eventName: 'metadata' });
    // An unnamed frame gains no key: AG-UI frames are forwarded exactly as before.
    expect(Object.keys(frames[1] ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });

  it('normalizes a page-posted "message" name away rather than forwarding it', () => {
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: 'c1',
      frames: [{ kind: 'event', tMs: 1, raw: '{}', eventName: 'message' }],
    });
    const [message] = forwarded(chromeHarness) as Record<string, unknown>[];
    const frames = (message ?? {}).frames as Record<string, unknown>[];
    expect(Object.keys(frames[0] ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/relay/relay.test.ts`
Expected: FAIL — the first new test: the forwarded frame lacks `eventName`.

- [ ] **Step 3: Implement**

Add the import at the top of `relay.ts` with the other imports:

```ts
import { normalizeEventName } from '../core/sse/event-name';
```

Replace the `case 'frames'` return with:

```ts
    case 'frames':
      return {
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId: message.connId,
        frames: message.frames.map((frame) => {
          if (frame.kind === 'keepalive') {
            return { kind: 'keepalive', tMs: frame.tMs, raw: frame.raw, comment: frame.comment };
          }
          // Named explicitly, like every other field (L1): this rebuild is what strips anything
          // the contract does not name, so a field left out here is silently lost. Normalized
          // again because the page, not our patch, is the sender this code has to assume.
          const eventName = normalizeEventName(frame.eventName);
          return {
            kind: 'event',
            tMs: frame.tMs,
            raw: frame.raw,
            ...(eventName !== undefined ? { eventName } : {}),
          };
        }),
      };
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/relay/relay.test.ts`
Expected: PASS, including the existing `'drops properties the contract does not name…'` test, whose unnamed frame still has exactly `['kind', 'raw', 'tMs']`.

- [ ] **Step 5: Commit**

```bash
git add packages/devtools/src/relay/relay.ts packages/devtools/src/relay/relay.test.ts
git commit -m "feat(relay): forward the SSE event name, by name (L1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `CaptureRecord.sseEvent`, set by the service worker

**Files:**
- Modify: `packages/devtools/src/core/model/types.ts` (`CaptureRecord` event arm, ~L150-157)
- Modify: `packages/devtools/src/sw/index.ts` (`toRecord`, ~L362-383)
- Test: `packages/devtools/src/sw/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('service worker', …)` after `'parses full SSE frame text as well as a bare data payload'` (reuse `relayPort`, `stub`, `send`, `testHook`, `eventFrame`):

```ts
  it('keeps a frame’s SSE event name on its record, and adds nothing to an unnamed one (L2)', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [
        { kind: 'event', tMs: 5, raw: '{"run_id":"r1","attempt":1}', eventName: 'metadata' },
        eventFrame(6, { type: 'RUN_STARTED' }),
      ],
    });

    const [named, unnamed] = testHook().records();
    if (named?.kind !== 'event' || unnamed?.kind !== 'event') throw new Error('expected event records');
    expect(named.sseEvent).toBe('metadata');
    expect(named.raw).toEqual({ run_id: 'r1', attempt: 1 });
    expect('sseEvent' in unnamed).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/sw/index.test.ts -t "SSE event name"`
Expected: FAIL — `named.sseEvent` is `undefined`.

- [ ] **Step 3: Implement — the type**

In `types.ts`, in the `kind: 'event'` arm of `CaptureRecord`, after the `event` field:

```ts
      /**
       * The frame's SSE `event:` name, when it had a real one (spec L1/L2). Absent for every
       * AG-UI frame, which carries its type inside the payload. LangGraph Platform carries its
       * type HERE — `metadata`, `values`, `messages|research:9f1c…` — and the payload has none.
       */
      readonly sseEvent?: string;
```

- [ ] **Step 4: Implement — `toRecord`**

In `sw/index.ts`, change the event branch of `toRecord`:

```ts
  const decoded = decodeEventFrame(frame.raw);
  return {
    kind: 'event',
    seq,
    tMs: frame.tMs,
    connId,
    raw: decoded.raw,
    event: decoded.event,
    // Copied, never derived: the relay already normalized it (L1).
    ...(frame.eventName !== undefined ? { sseEvent: frame.eventName } : {}),
    issues: [],
  };
```

- [ ] **Step 5: Run the sw suite**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/sw`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/devtools/src/core/model/types.ts packages/devtools/src/sw/index.ts packages/devtools/src/sw/index.test.ts
git commit -m "feat(sw): CaptureRecord keeps the SSE event name (L2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the name round-trips through `.agui.jsonl`

**Files:**
- Modify: `packages/devtools/src/core/jsonl/codec.ts` (`JsonlEvent`, ~L57-63)
- Modify: `packages/devtools/src/panel/export/build.ts` (`toLine`, ~L100-128)
- Modify: `packages/devtools/src/panel/import/load-jsonl.ts` (`toEventRecord`, ~L61-71)
- Create: `packages/devtools/src/panel/export/sse-event.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/devtools/src/panel/export/sse-event.test.ts
/**
 * Spec L2: the SSE event name survives export, import, re-export and redaction — and an older
 * file, which has no name anywhere, is untouched by the new field.
 */
import { describe, expect, test } from 'vitest';

import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import { decodeJsonl, encodeJsonl, type JsonlLine } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport } from './build';

/** A minimal LangGraph-shaped capture: one request, three named events. */
const LANGGRAPH_JSONL = [
  {
    kind: 'header',
    schemaVersion: 1,
    tool: 'ag-ui-devtools@0.1.0',
    capturedAt: '2026-09-29T12:00:00.000Z',
    url: 'http://localhost:2024',
    transport: 'sse',
    redacted: [],
  },
  {
    kind: 'request',
    connId: 'c1',
    tMs: 0,
    method: 'POST',
    url: 'http://localhost:2024/threads/t1/runs/stream',
    input: { assistant_id: 'agent', input: { messages: [{ type: 'human', content: 'hi' }] } },
  },
  { kind: 'event', connId: 'c1', seq: 1, tMs: 5, sseEvent: 'metadata', event: { run_id: 'r1', attempt: 1 } },
  {
    kind: 'event',
    connId: 'c1',
    seq: 2,
    tMs: 9,
    sseEvent: 'messages',
    event: [{ type: 'AIMessageChunk', id: 'm1', content: 'Hello' }, { langgraph_node: 'agent' }],
  },
  { kind: 'event', connId: 'c1', seq: 3, tMs: 12, sseEvent: 'values', event: { messages: [] } },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

function reExport(text: string, groups: RedactionGroup[] = []): JsonlLine[] {
  const loaded = loadJsonl(text);
  return buildExport(
    {
      records: loaded.records,
      requests: loaded.requests,
      runs: loaded.runs,
      importedHeader: loaded.header,
      runtime: loaded.runtime,
      framework: null,
      binaryTransport: null,
      source: { kind: 'imported', filename: 'lg.agui.jsonl', importedAtMs: 0 },
    },
    { scope: null, groups, toolVersion: '0.1.0', exportedAtIso: '2026-09-29T12:00:00.000Z' },
  ).lines;
}

function namesOf(lines: readonly JsonlLine[]): (string | undefined)[] {
  return lines.flatMap((line) => (line.kind === 'event' ? [line.sseEvent] : []));
}

describe('the SSE event name in .agui.jsonl (L2)', () => {
  test('import puts it on the record', () => {
    const records = loadJsonl(LANGGRAPH_JSONL).records;
    expect(records.map((record) => (record.kind === 'event' ? record.sseEvent : null))).toEqual([
      'metadata',
      'messages',
      'values',
    ]);
  });

  test('export → import → export keeps every name, in order', () => {
    const once = reExport(LANGGRAPH_JSONL);
    expect(namesOf(once)).toEqual(['metadata', 'messages', 'values']);
    const twice = reExport(encodeJsonl(once));
    expect(namesOf(twice)).toEqual(['metadata', 'messages', 'values']);
  });

  test('redaction keeps the name: it is structure, not content', () => {
    expect(namesOf(reExport(LANGGRAPH_JSONL, [...ALL_REDACTION_GROUPS]))).toEqual([
      'metadata',
      'messages',
      'values',
    ]);
  });

  test('an AG-UI capture gains no sseEvent key on any line', () => {
    for (const line of reExport(happyJsonl)) {
      expect(Object.keys(line)).not.toContain('sseEvent');
    }
  });

  test('an imported name is untrusted: a non-string or "message" is dropped, the event kept', () => {
    const hostile = [
      JSON.stringify({ kind: 'event', connId: 'c1', seq: 1, tMs: 1, sseEvent: 42, event: { a: 1 } }),
      JSON.stringify({ kind: 'event', connId: 'c1', seq: 2, tMs: 2, sseEvent: 'message', event: { a: 2 } }),
    ].join('\n');
    const records = loadJsonl(hostile).records;
    expect(records).toHaveLength(2);
    for (const record of records) expect('sseEvent' in record).toBe(false);
  });

  test('the codec passes the key through without validating it, like every event field', () => {
    const { lines, errors } = decodeJsonl(LANGGRAPH_JSONL);
    expect(errors).toEqual([]);
    expect(namesOf(lines)).toEqual(['metadata', 'messages', 'values']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/panel/export/sse-event.test.ts`
Expected: FAIL — `tsc` is not run by Vitest, so the observable failures are "import puts it on the record" (`[undefined, undefined, undefined]`) and the round-trip test. "the codec passes the key through" may already pass; that is fine — it pins current behaviour.

- [ ] **Step 3: Implement — codec type**

In `codec.ts`, `JsonlEvent`:

```ts
export interface JsonlEvent {
  kind: 'event';
  connId: string;
  seq: number;
  tMs: number;
  /**
   * The frame's SSE `event:` name, when it had one (spec L2). An optional KEY rather than a new
   * line kind, for the same reason `runtime` is a header key: `decodeJsonl` rejects an unknown
   * `kind`, so a new kind would make an older build report this intact file as damaged, while
   * an unknown key is ignored by every JSON decoder ever written. `schemaVersion` stays 1.
   */
  sseEvent?: string;
  event: unknown;
}
```

- [ ] **Step 4: Implement — export**

In `build.ts` `toLine`, the event return becomes:

```ts
  return {
    kind: 'event',
    connId: record.connId,
    seq: record.seq,
    tMs: record.tMs,
    ...(record.sseEvent !== undefined ? { sseEvent: record.sseEvent } : {}),
    event: record.raw ?? record.event,
  };
```

- [ ] **Step 5: Implement — import**

In `load-jsonl.ts`, add the import:

```ts
import { normalizeEventName } from '../../core/sse/event-name';
```

and change `toEventRecord`:

```ts
/**
 * A19: `CaptureRecord` is a union on `kind`, so an event record must say so explicitly.
 *
 * `sseEvent` is a field of an untrusted file, so it goes through the same rule the capture path
 * applies (L1) rather than being copied: a non-string or a `message` name is dropped, and the
 * event itself is kept.
 */
function toEventRecord(line: JsonlEvent): CaptureRecord {
  const sseEvent = normalizeEventName(line.sseEvent);
  return {
    kind: 'event',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: line.event,
    event: asAguiEvent(line.event),
    ...(sseEvent !== undefined ? { sseEvent } : {}),
    issues: [],
  };
}
```

(Replace the existing one-line doc comment on `toEventRecord` with the one above.) `redactLine` already spreads `...line`, so `sseEvent` is preserved on every path — including the wholesale-redaction path added in Task 6b — the redaction test proves it.

- [ ] **Step 6: Run the panel and core suites**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/panel src/core`
Expected: PASS — the new file's 6 tests and every existing round-trip, redaction, leak-check and fixture test unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/devtools/src/core/jsonl/codec.ts packages/devtools/src/panel/export/build.ts packages/devtools/src/panel/import/load-jsonl.ts packages/devtools/src/panel/export/sse-event.test.ts
git commit -m "feat(jsonl): the SSE event name round-trips through export and import (L2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `routeHint` recognises LangGraph Platform's stream routes

**Files:**
- Modify: `packages/devtools/src/core/detect/classifier.ts` (`RouteHint`, ~L11-24; regex constants, ~L80-84; `routeHint`, ~L137-183)
- Test: `packages/devtools/src/core/detect/classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `classifier.test.ts` (it already imports `routeHint`):

```ts
describe('routeHint: LangGraph Platform streams (L3)', () => {
  it('recognizes POST {base}/threads/:threadId/runs/stream', () => {
    expect(routeHint('http://localhost:2024/threads/t-1/runs/stream', 'POST')).toEqual({
      kind: 'langgraph-run',
      basePath: '',
      threadId: 't-1',
    });
  });

  it('keeps a base path in front of the route', () => {
    expect(routeHint('https://app.example.com/api/langgraph/threads/t-1/runs/stream', 'POST')).toEqual({
      kind: 'langgraph-run',
      basePath: '/api/langgraph',
      threadId: 't-1',
    });
  });

  it('recognizes the threadless POST {base}/runs/stream', () => {
    expect(routeHint('http://localhost:2024/runs/stream', 'POST')).toEqual({
      kind: 'langgraph-run',
      basePath: '',
    });
  });

  it('recognizes the join stream GET {base}/threads/:threadId/runs/:runId/stream', () => {
    expect(routeHint('http://localhost:2024/threads/t-1/runs/r-9/stream', 'GET')).toEqual({
      kind: 'langgraph-run',
      basePath: '',
      threadId: 't-1',
      runId: 'r-9',
    });
  });

  it('recognizes the threadless join stream GET {base}/runs/:runId/stream', () => {
    expect(routeHint('http://localhost:2024/runs/r-9/stream?stream_mode=values', 'GET')).toEqual({
      kind: 'langgraph-run',
      basePath: '',
      runId: 'r-9',
    });
  });

  it('does not match the wrong verb, or a near miss', () => {
    expect(routeHint('http://localhost:2024/threads/t-1/runs/stream', 'GET')).toBeUndefined();
    expect(routeHint('http://localhost:2024/threads/t-1/runs/r-9/stream', 'POST')).toBeUndefined();
    expect(routeHint('http://localhost:2024/threads/t-1/runs', 'POST')).toBeUndefined();
    expect(routeHint('http://localhost:2024/threads/t-1/runs/stream/extra', 'POST')).toBeUndefined();
    expect(routeHint('http://localhost:2024/threads//runs/stream', 'POST')).toBeUndefined();
  });

  it('leaves the CopilotKit routes exactly as they were', () => {
    expect(routeHint('/api/copilotkit/agent/my-agent/run', 'POST')).toEqual({
      kind: 'copilotkit-run',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/core/detect/classifier.test.ts`
Expected: FAIL — the five positive LangGraph tests get `undefined`.

- [ ] **Step 3: Implement — the type**

Add a final arm to `RouteHint`:

```ts
  | { kind: 'copilotkit-inspector-metadata'; basePath: string }
  /**
   * A LangGraph Platform run stream (spec L3) — not AG-UI on the wire: the event type is in the
   * SSE `event:` field. `threadId` is absent on the threadless routes; `runId` is present only
   * on a join stream, whose URL names the run it rejoins. A new run's id arrives in its first
   * `metadata` event instead.
   */
  | { kind: 'langgraph-run'; basePath: string; threadId?: string; runId?: string };
```

- [ ] **Step 4: Implement — the grammar**

Beside the other route regexes:

```ts
// LangGraph Platform (spec L3). Ids are one non-empty path segment; the SDK URL-encodes them.
// The threadless forms require a base path that does not end in `/`, so a malformed
// `/threads//runs/stream` is not read as a threadless run under the base `/threads/`.
const LG_THREAD_RUN_RE = /^(.*)\/threads\/([^/]+)\/runs\/stream$/;
const LG_RUN_RE = /^((?:.*[^/])?)\/runs\/stream$/;
const LG_THREAD_JOIN_RE = /^(.*)\/threads\/([^/]+)\/runs\/([^/]+)\/stream$/;
const LG_JOIN_RE = /^((?:.*[^/])?)\/runs\/([^/]+)\/stream$/;
```

In `routeHint`, in the `GET` branch, **before** `return undefined;`:

```ts
    // The thread form first: its path also ends `/runs/:id/stream`, and the threadless grammar
    // would otherwise claim it with `/threads/:id` folded into the base path.
    const threadJoin = LG_THREAD_JOIN_RE.exec(path);
    if (threadJoin) {
      const [, basePath = '', threadId = '', runId = ''] = threadJoin;
      return { kind: 'langgraph-run', basePath, threadId, runId };
    }
    const join = LG_JOIN_RE.exec(path);
    if (join) {
      const [, basePath = '', runId = ''] = join;
      return { kind: 'langgraph-run', basePath, runId };
    }
```

In the `POST` branch, after the `STOP_RE` block and **before** the single-route info envelope check:

```ts
    // Same ordering argument as the GET branch: thread form first.
    const threadRun = LG_THREAD_RUN_RE.exec(path);
    if (threadRun) {
      const [, basePath = '', threadId = ''] = threadRun;
      return { kind: 'langgraph-run', basePath, threadId };
    }
    const lgRun = LG_RUN_RE.exec(path);
    if (lgRun) {
      const [, basePath = ''] = lgRun;
      return { kind: 'langgraph-run', basePath };
    }
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter ag-ui-devtools exec vitest run src/core/detect`
Expected: PASS, all existing `routeHint` tests included.

- [ ] **Step 6: Check nothing switches exhaustively on `RouteHint`**

Run: `pnpm --filter ag-ui-devtools typecheck`
Expected: exit 0. (Today the only consumer is `fetch-patch.ts`, which tests `hint.kind !== 'copilotkit-info'`; a new arm cannot change its behaviour. `fetch-patch` needs no change: it tees every `text/event-stream` response already.)

- [ ] **Step 7: Commit**

```bash
git add packages/devtools/src/core/detect/classifier.ts packages/devtools/src/core/detect/classifier.test.ts
git commit -m "feat(detect): recognise LangGraph Platform run-stream routes (L3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6b (added during execution): redaction fails closed

Not in the original plan. Found while reviewing this PR against a real LangGraph Platform
capture: `redactEvent`'s dispatch table only understands AG-UI `type` strings, and every branch
that didn't match fell through to `return event` — the payload shipped byte-for-byte, unredacted,
even with every §11 category selected. This is pre-existing on `main` (any payload lacking a
known AG-UI `type` already had this hole; LangGraph just makes it easy to hit, since none of its
payloads carry one), not something L1–L3 introduced. The user chose to fail closed in this PR
rather than leave it for PR 4 / L16's field-level LangGraph rules, since shipping a "redacted"
export that isn't is a privacy defect, not a missing feature.

Four commits cover it:

- **`55db6f8` fix(redact): fail closed on payloads that are not AG-UI events** — `redactWholesale`
  now runs on any payload `redactEvent` cannot classify (no `type`, unknown `type`, non-object,
  unparseable raw string), gated by group selection like every other path. `type` survives only
  when it looks like an AG-UI type (`AGUI_TYPE_RE`), and a non-string `type` is nulled rather than
  redacted as a leaf, to avoid fabricating a validator issue (`unknown-event-type` for what should
  read as `shape-invalid`).
- **`b9c7357` fix(redact): a named SSE event is never AG-UI; keep only AG-UI-shaped types** —
  a line's `sseEvent` (L2) means the frame came off some other protocol's SSE framing, so its
  payload was routed to `redactWholesale` unconditionally, with `type` NOT kept (`keepAguiType:
  false`): a LangGraph payload's `type`-shaped field (if any) is app data, not an AG-UI label, and
  could collide with a real AG-UI type name by coincidence.
- **`fed6b22` docs(redact): name every AG-UI field still exported as captured; truthful parity
  comments** — PRIVACY.md and code comments corrected to name the fields the new fail-closed
  behaviour does NOT yet cover (§8's per-event gaps), and the parity-test comments updated to
  describe what the new wholesale path actually exercises.
- **This commit** — added the matching-name exception: a named line whose `sseEvent` equals its
  own payload's `type`, where that `type` is a known AG-UI type, IS treated as AG-UI (Hono's
  `writeSSE({ event, data })` pattern). LangGraph's own names can never produce this match by
  coincidence (`metadata`, `values`, `messages|<ns>` are lowercase/namespaced, never
  `UPPER_SNAKE`), so this recovers precision for AG-UI-over-named-SSE servers without reopening
  the LangGraph gap the three commits above closed.

Field-level LangGraph redaction rules (precise, not wholesale) remain PR 4 / spec decision L16.

---

### Task 8: mutation checks, full gates, PR

- [ ] **Step 1: Watch each gate fail before believing it**

Apply each mutation, run the named suite, confirm it FAILS, then revert with `git checkout -- <file>`:

| Mutation | Run | Must fail |
|---|---|---|
| `relay.ts`: drop the `...(eventName …)` spread | `vitest run src/relay` | the new forwarding test |
| `fetch-patch.ts`: drop the spread | `vitest run src/inject/raw-invariant.test.ts` | "fetch and XHR both carry a real event name" |
| `event-name.ts`: remove the `'message'` check | `vitest run src/inject src/core/sse` | "no transport reports a name for event: message" |
| `sw/index.ts`: drop the `sseEvent` spread | `vitest run src/sw` | the new record test |
| `build.ts`: drop the `sseEvent` spread | `vitest run src/panel/export/sse-event.test.ts` | the round-trip test |
| `load-jsonl.ts`: copy `line.sseEvent` without normalizing | same | the hostile-import test |
| `redact.ts`: make the unrecognised-payload fallback return the payload unchanged instead of `redactWholesale` | `vitest run src/core/jsonl/redact.test.ts src/panel/export` | the fail-closed tests, and the sse-event leak-check test |
| `redact.ts`: remove the `line.sseEvent !== undefined` branch (route every event line through `redactEvent`) | `vitest run src/core/jsonl/redact.test.ts` | "a named SSE event is never an AG-UI frame" |
| `redact.ts`: remove the matching-name exception (always take the wholesale path when `sseEvent` is set) | `vitest run src/core/jsonl/redact.test.ts` | the new "a named line whose SSE event name matches its own payload type IS AG-UI" `TEXT_MESSAGE_CONTENT` test |

Record each result for the PR description.

- [ ] **Step 2: Run every gate from the repo root**

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing
```

Expected: every stage exits 0. Note the unit-test and harness counts before (on `main`) and after. `pnpm test:e2e` too: no e2e scenario sends `event:` lines, so it must be unchanged — that is the "unredacted AG-UI captures are unchanged" claim (a redacted export's behaviour DOES change for unrecognised payloads — see Task 6b).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "LangGraph PR 1: the SSE event name survives capture, export and import" --body-file <body>
```

The body states: what L1–L3 do; that nothing reads the name yet (PR 2 does); the `message` normalization and why (EventSource); the mutation table; before/after test counts; the known gap that `EventSource` still cannot see named events. End it with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
