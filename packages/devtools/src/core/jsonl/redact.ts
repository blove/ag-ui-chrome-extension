import { EVENT_TABLE, EVENT_TYPES } from '../events/event-table.generated';
import type { JsonlLine } from './codec';

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

/**
 * AG-UI's own naming convention for `type` values (see `event-table.generated.ts`): all of
 * today's types match this. Used to decide whether an UNNAMED payload's unrecognised `type` is
 * still worth keeping as a future AG-UI type's Timeline label, vs. some other protocol's field
 * that merely happens to be called `type`.
 */
const AGUI_TYPE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export type RedactionGroup = 'text' | 'reasoning' | 'toolArgs' | 'toolResults' | 'state';

export const ALL_REDACTION_GROUPS: readonly RedactionGroup[] = [
  'text',
  'reasoning',
  'toolArgs',
  'toolResults',
  'state',
];

/**
 * The one and only placeholder shape. Size survives; content does not.
 *
 * The empty string is returned as itself. There is no content in a zero-length string to protect,
 * and replacing it changes what the VALIDATOR sees: requirements §7 makes an empty
 * `TEXT_MESSAGE_CONTENT` delta an error (`empty-text-delta`), and `«redacted: 0 chars»` is not
 * empty. Found by export (2026-08-15), this module's second consumer and the first to fold a
 * redacted capture back through the run builder — a redacted bug report about an empty-delta bug
 * reached its reader reporting no bug at all. §11 promises structure, types, ordering, sizes and
 * timings survive redaction, and the emptiness of an empty payload is that kind of fact.
 */
export function redactString(value: string): string {
  if (value === '') return '';
  return `«redacted: ${value.length} chars»`;
}

/** Leaves carry payload; `null`/`undefined` are structure and survive. */
function redactLeaf(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return redactString(String(value));
  return value;
}

/** Walks containers, replacing every leaf. Keys, array positions and nulls are preserved. */
function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(child);
    }
    return out;
  }
  return redactLeaf(value);
}

/**
 * Redacts `value` if `group` is selected. `redactDeep` rather than `redactLeaf`, so that a field
 * the protocol types as a string but a server sends as an object is still redacted, not skipped.
 */
function owned(
  value: unknown,
  group: RedactionGroup,
  groups: ReadonlySet<RedactionGroup>,
): unknown {
  return groups.has(group) ? redactDeep(value) : value;
}

/** Keeps an object's `keep` keys and redacts every other key's value; a non-object, wholesale. */
function keepOnly(value: unknown, keep: readonly string[]): unknown {
  if (!isPlainObject(value)) return redactDeep(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = keep.includes(key) ? child : redactDeep(child);
  }
  return out;
}

/**
 * A JSON Patch — `STATE_DELTA.delta` or `ACTIVITY_DELTA.patch`. `op`, `path` and `from` are
 * structure, and they are what decides whether a patch applies, so `state-patch-failed` fires
 * at the same ops redacted or not. `value` belongs to `state`; any other key is unclassifiable.
 */
function redactPatch(ops: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!Array.isArray(ops)) return redactDeep(ops);
  return ops.map((op) => {
    if (!isPlainObject(op)) return redactDeep(op);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(op)) {
      if (key === 'op' || key === 'path' || key === 'from') out[key] = child;
      else if (key === 'value') out[key] = owned(child, 'state', groups);
      else out[key] = redactDeep(child);
    }
    return out;
  });
}

/**
 * `RUN_FINISHED.outcome`: `{type: 'success'}`, or `{type: 'interrupt', interrupts: [...]}` whose
 * entries explain to the user why the run stopped. No group owns that text, so it goes under any
 * of them; an interrupt keeps its `id`, the `toolCallId` it pauses and its expiry.
 */
function redactOutcome(outcome: unknown): unknown {
  if (!isPlainObject(outcome)) return redactDeep(outcome);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(outcome)) {
    if (key === 'type') out[key] = child;
    else if (key === 'interrupts' && Array.isArray(child)) {
      out[key] = child.map((interrupt) => keepOnly(interrupt, ['id', 'toolCallId', 'expiresAt']));
    } else out[key] = redactDeep(child);
  }
  return out;
}

type FieldRule = (value: unknown, groups: ReadonlySet<RedactionGroup>) => unknown;

const ownedBy =
  (group: RedactionGroup): FieldRule =>
  (value, groups) =>
    owned(value, group, groups);

/**
 * Structure §11 promises survives: ids, roles, names, timestamps. Kept only on a type whose
 * schema declares the field (`EVENT_TABLE`), so a passthrough field that merely shares a name —
 * `name` on a `TEXT_MESSAGE_CONTENT` — is not structure by coincidence.
 *
 * `role`, `name`, `toolCallName`, `stepName`, `activityType`, `code` (a run error's code) and
 * `source` (a `RAW` event's provider) are developer-authored labels, the same kind of fact as a
 * tool's name. `subtype` is the enum `'tool-call' | 'message'`, and `replace` a boolean.
 */
const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'timestamp',
  'threadId',
  'runId',
  'parentRunId',
  'messageId',
  'parentMessageId',
  'toolCallId',
  'toolCallName',
  'entityId',
  'subtype',
  'role',
  'name',
  'stepName',
  'activityType',
  'replace',
  'code',
  'source',
]);

/**
 * Structure some servers send outside the schema, which the panel reads: CopilotKit's
 * `RUN_STARTED.agentId` is the Runs tab's agent column, and PRIVACY.md promises agent ids survive.
 */
const PASSTHROUGH_STRUCTURE: Record<string, readonly string[]> = { RUN_STARTED: ['agentId'] };

/**
 * Every content field @ag-ui/core 0.0.57 names, by event type, and the rule that redacts it.
 * Checked against the schemas, not the generated table's kinds: `REASONING_ENCRYPTED_VALUE`'s
 * field is `encryptedValue` (there is no `value`), and the deprecated `THINKING_*` events carry
 * reasoning under their own names.
 *
 * A field that is neither here nor structural — `rawEvent`, which any event may carry and which
 * is typically the upstream provider's own chunk; `CUSTOM.value`; `RAW.event`; `RUN_ERROR.message`;
 * `RUN_FINISHED.result`; anything `BaseEventSchema`'s `.passthrough()` let through — has content
 * this module cannot attribute to a group, and is redacted as soon as ANY group is selected.
 */
const FIELD_RULES: Record<string, Record<string, FieldRule>> = {
  TEXT_MESSAGE_CONTENT: { delta: ownedBy('text') },
  TEXT_MESSAGE_CHUNK: { delta: ownedBy('text') },
  REASONING_MESSAGE_CONTENT: { delta: ownedBy('reasoning') },
  REASONING_MESSAGE_CHUNK: { delta: ownedBy('reasoning') },
  REASONING_ENCRYPTED_VALUE: { encryptedValue: ownedBy('reasoning') },
  THINKING_START: { title: ownedBy('reasoning') },
  THINKING_TEXT_MESSAGE_CONTENT: { delta: ownedBy('reasoning') },
  TOOL_CALL_ARGS: { delta: ownedBy('toolArgs') },
  TOOL_CALL_CHUNK: { delta: ownedBy('toolArgs') },
  TOOL_CALL_RESULT: { content: ownedBy('toolResults') },
  STATE_SNAPSHOT: { snapshot: ownedBy('state') },
  STATE_DELTA: { delta: redactPatch },
  ACTIVITY_SNAPSHOT: { content: ownedBy('state') },
  ACTIVITY_DELTA: { patch: redactPatch },
  MESSAGES_SNAPSHOT: {
    messages: (messages, groups) =>
      Array.isArray(messages)
        ? messages.map((message) => redactMessage(message, groups))
        : redactDeep(messages),
  },
  /*
   * `RUN_STARTED` is a lifecycle event that can nonetheless carry a full payload: `input` is an
   * optional protocol field (@ag-ui/core `RunStartedEventSchema`) echoing the whole
   * `RunAgentInput` — the user's messages, the app's state, the forwarded props.
   *
   * Found by Tier B recording against a live agent. Every hand-written fixture omits `input`,
   * so the suite had agreed this event carries nothing to protect, while a real deployment
   * sends it on every run. Redacting the request body and not this one protects nothing: the
   * same prompt ships in the export either way.
   */
  RUN_STARTED: { input: (input, groups) => redactInput(input, groups) },
  RUN_FINISHED: { outcome: (outcome) => redactOutcome(outcome) },
};

/**
 * Fails closed on anything this module cannot classify into one of the five §11 groups.
 *
 * `redactEvent` only understands AG-UI events: a fixed table of `type` strings, each mapped to
 * the group and field that owns its payload. A capture of any other streaming protocol — a
 * LangGraph Platform run, most obviously, where the event name lives in the line's `sseEvent`
 * rather than in the payload, and payloads are `{run_id, ...}` objects, `[chunk, metadata]`
 * tuples, and `{messages: [...]}` state snapshots with no `type` field at all — used to fall
 * through every branch below to the final `return event`, and ship byte-for-byte, even with
 * every group selected. A raw frame that failed to parse as JSON is exported as its text string
 * for the same reason: it has no `type` to dispatch on either.
 *
 * An export that PRIVACY.md says keeps only structure must not, in fact, keep content it merely
 * failed to recognise — that is the same class of gap #38 corrected for empty-string deltas: a
 * redacted file that quietly isn't. So: an UNRECOGNISED payload — one that is not a plain object
 * with a `type` in `KNOWN_EVENT_TYPES` (the generated AG-UI event table) — OR any payload on a
 * line that names its own SSE event AND that name does not equal the payload's own `type` (see
 * `redactLine`'s matching-name exception; a named line whose name matches its payload's `type`
 * IS treated as AG-UI, everything else named is not) is redacted wholesale with `redactDeep` as
 * soon as ANY group is selected — deliberately group-agnostic, because an unrecognised payload
 * cannot be attributed to text vs. reasoning vs. tool args vs. state; the extension has no way to
 * know which of the five groups its content belongs to, and guessing wrong is worse than
 * redacting more than asked.
 *
 * `type` survives only on an UNNAMED payload (no `sseEvent`), and only when it is a string
 * matching AG-UI's own `UPPER_SNAKE` naming convention (`AGUI_TYPE_RE`): §11 promises event
 * types survive redaction, and a future AG-UI protocol version's event names are structure the
 * same way today's are. A `type`-shaped field on some OTHER protocol's object — free text, an
 * order number, anything not in that shape — is not an AG-UI type merely for being called
 * `type`, so `keepAguiType` gates it. A `type` that is present but not even a string (e.g. a
 * number) is set to `null` rather than redacted as a leaf: a redacted string still reads to the
 * validator as SOME `type` value and would turn a `shape-invalid` issue into a fabricated
 * `unknown-event-type` — the same "don't invent a claim" rule `redactPatch` follows for paths.
 * That parity reasoning is forward-looking, not currently observable: `checkShape`, the module
 * that raises `shape-invalid`/`unknown-event-type`, has no caller outside its own unit tests
 * today, so nothing in the live import/run-builder pipeline actually produces either code yet.
 *
 * Field-level LangGraph rules (spec decision L16) will replace this wholesale fallback for
 * LangGraph captures specifically, redacting message content, tool args and state precisely the
 * way AG-UI events do. Until that ships, this is the only honest behaviour for anything it
 * covers.
 */
function redactWholesale(event: unknown, opts: { keepAguiType: boolean }): unknown {
  if (event === null || event === undefined) return event;
  if (typeof event !== 'object') return redactLeaf(event);
  if (Array.isArray(event)) return redactDeep(event);

  const src = event as Record<string, unknown>;
  const out = redactDeep(src) as Record<string, unknown>;
  if ('type' in src) {
    if (typeof src.type !== 'string') {
      out.type = null;
    } else if (opts.keepAguiType && AGUI_TYPE_RE.test(src.type)) {
      out.type = src.type;
    }
    // A string `type` that isn't kept is left as `redactDeep` already redacted it.
  }
  return out;
}

/**
 * A known AG-UI event, field by field. Fails closed per field, not only per payload: every field
 * is structure the schema declares, content a group owns, or content no group can claim.
 * `groups` is never empty here — `redactLine` returns early on an empty selection.
 */
function redactEvent(event: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!isPlainObject(event)) return redactWholesale(event, { keepAguiType: true });
  const type = typeof event.type === 'string' ? event.type : '';
  const spec = EVENT_TABLE[type];
  if (!KNOWN_EVENT_TYPES.has(type) || spec === undefined) {
    return redactWholesale(event, { keepAguiType: true });
  }

  const declared = new Set(spec.fields.map((field) => field.name));
  const passthrough = PASSTHROUGH_STRUCTURE[type] ?? [];
  const rules = FIELD_RULES[type] ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    const rule = rules[key];
    if (rule !== undefined) out[key] = rule(value, groups);
    else if (STRUCTURAL_FIELDS.has(key) && declared.has(key)) out[key] = value;
    else if (passthrough.includes(key)) out[key] = value;
    else out[key] = redactDeep(value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Which group owns a message's `content`, by `role`. Ownership is per field rather than per
 * line: `content` is authored text on a user, assistant, system or developer message, but a tool
 * result on a `tool` message, reasoning on a `reasoning` one and app state on an `activity` one —
 * so deselecting `toolResults` must leave a tool message's body alone even with `text` selected.
 * An unknown role's content cannot be attributed, so it goes under any group.
 */
const CONTENT_GROUP_BY_ROLE: Record<string, RedactionGroup> = {
  user: 'text',
  assistant: 'text',
  system: 'text',
  developer: 'text',
  tool: 'toolResults',
  reasoning: 'reasoning',
  activity: 'state',
};

/** One tool call an assistant message replays: `id`, `type` and function `name` are structure. */
function redactToolCall(call: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!isPlainObject(call)) return redactDeep(call);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(call)) {
    if (key === 'id' || key === 'type') out[key] = child;
    else if (key === 'encryptedValue') out[key] = owned(child, 'reasoning', groups);
    else if (key === 'function' && isPlainObject(child)) {
      const fn: Record<string, unknown> = {};
      for (const [fnKey, fnChild] of Object.entries(child)) {
        if (fnKey === 'name') fn[fnKey] = fnChild;
        else if (fnKey === 'arguments') fn[fnKey] = owned(fnChild, 'toolArgs', groups);
        else fn[fnKey] = redactDeep(fnChild);
      }
      out[key] = fn;
    } else out[key] = redactDeep(child);
  }
  return out;
}

/**
 * One message, in a `MESSAGES_SNAPSHOT` or a `RunAgentInput.messages` array — the same
 * `MessageSchema` in both places, so the same rules.
 */
function redactMessage(message: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!isPlainObject(message)) return redactDeep(message);
  const role = typeof message.role === 'string' ? message.role : '';
  const contentGroup = CONTENT_GROUP_BY_ROLE[role] as RedactionGroup | undefined;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(message)) {
    if (['id', 'role', 'name', 'toolCallId', 'activityType'].includes(key)) out[key] = child;
    else if (key === 'content') {
      out[key] =
        contentGroup === undefined ? redactDeep(child) : owned(child, contentGroup, groups);
    } else if (key === 'encryptedValue') out[key] = owned(child, 'reasoning', groups);
    // A tool message's `error` is part of what the tool returned.
    else if (key === 'error') out[key] = owned(child, 'toolResults', groups);
    else if (key === 'toolCalls' && Array.isArray(child)) {
      out[key] = child.map((call) => redactToolCall(call, groups));
    } else out[key] = redactDeep(child);
  }
  return out;
}

/**
 * A `RunAgentInput`, wherever it appears — the captured request body, or the copy the protocol
 * echoes back in `RUN_STARTED.input`.
 *
 * `tools` deliberately survives: a tool schema is developer-authored structure, no §11 group
 * owns it, and it is most of what makes a captured run legible. `state`, `context` and
 * `forwardedProps` are app-supplied payloads, all of which can carry anything the page had in
 * scope. A `resume` entry is the user's answer to an interrupt: it keeps `interruptId` and
 * `status`, and its `payload` goes under any group.
 */
function redactInput(input: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (['threadId', 'runId', 'parentRunId', 'tools'].includes(key)) out[key] = child;
    else if (key === 'messages' && Array.isArray(child)) {
      out[key] = child.map((message) => redactMessage(message, groups));
    } else if (key === 'state' || key === 'context' || key === 'forwardedProps') {
      out[key] = owned(child, 'state', groups);
    } else if (key === 'resume' && Array.isArray(child)) {
      out[key] = child.map((entry) => keepOnly(entry, ['interruptId', 'status']));
    } else out[key] = redactDeep(child);
  }
  return out;
}

/**
 * Returns a redacted copy. Never mutates its argument. Structure survives by design at the
 * LINE level — `connId`, `seq`, `tMs`, `sseEvent` — and, on a payload this module can classify
 * as AG-UI (an unnamed event with a `type` in `KNOWN_EVENT_TYPES`, or a named event whose
 * `sseEvent` matches its own `type`; see below), the fields `redactEvent` leaves alone: ids,
 * ordering, JSON Pointer paths, patch ops, and `type` itself, including on an unnamed payload
 * whose `type` merely follows AG-UI's own naming convention. That is not a blanket promise for
 * every payload, though: a payload this module cannot classify as AG-UI — an unrecognised
 * `type`, no `type` at all, or a named line whose `sseEvent` does not match its own `type` — is
 * redacted WHOLESALE as soon as any group is selected, per `redactWholesale`, and wholesale
 * redaction does not spare ids or other structure inside that payload — it has no way to know
 * which fields are safe. Lines no group owns, and only those, are returned as-is, by reference:
 * a `header` or `keepalive` line, or an event/request line when `groups` is empty.
 */
export function redactLine(line: JsonlLine, groups: RedactionGroup[]): JsonlLine {
  if (groups.length === 0) return line;
  const set = new Set(groups);

  if (line.kind === 'event') {
    /*
     * A line's `sseEvent` key means the frame carried an explicit `event:` name on the wire
     * (spec L1/L2). The capture and loader paths normalize the default name away — a bare
     * `message` event, or a frame with none at all, never sets this key — so ANY `sseEvent`
     * value means this line came off a protocol other than AG-UI's own SSE framing, UNLESS the
     * name matches the payload's own `type`: an AG-UI server that names its SSE events after the
     * event type (e.g. Hono's `writeSSE({ event, data })`) produces exactly that. LangGraph
     * Platform's own names (`metadata`, `values`, `messages|<ns>`) are lowercase and/or
     * namespaced and can never equal an AG-UI `UPPER_SNAKE` `type`, so this match cannot be
     * produced by coincidence with a LangGraph frame — only by an AG-UI server naming its own
     * events after themselves. A matching line is therefore dispatched through the normal AG-UI
     * path below, exactly as an unnamed line would be.
     *
     * Any OTHER named line — `sseEvent` present but not equal to the payload's `type` (including
     * every payload with no `type`, or a non-object payload) — still goes through
     * `redactWholesale` with `keepAguiType: false`: this module has no idea what that other
     * protocol's fields mean, so `type` is treated as opaque app data rather than kept. Spec
     * L16's field-level LangGraph rules will replace this wholesale fallback for LangGraph
     * specifically; until then this is the only honest behaviour for anything it covers.
     *
     * This still errs safe, not precise: a named AG-UI server whose `event:` names do NOT match
     * their own payload's `type` is over-redacted here — never under-redacted. Treating a named,
     * non-matching line as AG-UI by mistake is the direction that would leak.
     */
    if (line.sseEvent !== undefined) {
      const payload = line.event;
      const payloadType = isPlainObject(payload) ? payload.type : undefined;
      const isMatchingAguiEvent =
        typeof payloadType === 'string' &&
        payloadType === line.sseEvent &&
        KNOWN_EVENT_TYPES.has(payloadType);
      if (isMatchingAguiEvent) {
        return { ...line, event: redactEvent(payload, set) };
      }
      return { ...line, event: redactWholesale(payload, { keepAguiType: false }) };
    }
    return { ...line, event: redactEvent(line.event, set) };
  }
  if (line.kind === 'request') {
    // Gated per field inside `redactInput`, not wholesale on `state`. Gating the whole body on
    // one group meant selecting `text` left the user's own messages verbatim.
    return { ...line, input: redactInput(line.input, set) };
  }
  // `header` and `keepalive` fall through unchanged. Requirements §11's five groups are
  // text/reasoning/toolArgs/toolResults/state and none covers either kind: a keepalive
  // comment is proxy heartbeat metadata rather than agent or user content, and redacting
  // it would erase the signal keepalives are recorded for (proxy buffering). The header's
  // `redacted` field is likewise left to the export bundle builder.
  return line;
}
