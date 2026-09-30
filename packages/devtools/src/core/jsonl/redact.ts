import { EVENT_TYPES } from '../events/event-table.generated';
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

/** Single-field replacements: event type -> the group that owns it and the field it names. */
const SINGLE_FIELD: Record<string, { group: RedactionGroup; field: string }> = {
  TEXT_MESSAGE_CONTENT: { group: 'text', field: 'delta' },
  TEXT_MESSAGE_CHUNK: { group: 'text', field: 'delta' },
  REASONING_MESSAGE_CONTENT: { group: 'reasoning', field: 'delta' },
  REASONING_MESSAGE_CHUNK: { group: 'reasoning', field: 'delta' },
  // Field is `encryptedValue`, verified against @ag-ui/core@0.0.57's
  // ReasoningEncryptedValueEventSchema shape (type, timestamp, rawEvent,
  // subtype, entityId, encryptedValue). There is no `value` field.
  REASONING_ENCRYPTED_VALUE: { group: 'reasoning', field: 'encryptedValue' },
  TOOL_CALL_ARGS: { group: 'toolArgs', field: 'delta' },
  TOOL_CALL_CHUNK: { group: 'toolArgs', field: 'delta' },
  TOOL_CALL_RESULT: { group: 'toolResults', field: 'content' },
};

function redactPatchOp(op: unknown): unknown {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return op;
  const src = op as Record<string, unknown>;
  if (!('value' in src)) return { ...src };
  return { ...src, value: redactDeep(src.value) };
}

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
 * with a `type` in `KNOWN_EVENT_TYPES` (the generated AG-UI event table) — OR ANY payload on a
 * line that names its own SSE event (see `redactLine`; a named line is never AG-UI, whatever its
 * `type` looks like) is redacted wholesale with `redactDeep` as soon as ANY group is selected —
 * deliberately group-agnostic, because an unrecognised payload cannot be attributed to text vs.
 * reasoning vs. tool args vs. state; the extension has no way to know which of the five groups
 * its content belongs to, and guessing wrong is worse than redacting more than asked.
 *
 * `type` survives only on an UNNAMED payload (no `sseEvent`), and only when it is a string
 * matching AG-UI's own `UPPER_SNAKE` naming convention (`AGUI_TYPE_RE`): §11 promises event
 * types survive redaction, and a future AG-UI protocol version's event names are structure the
 * same way today's are. A `type`-shaped field on some OTHER protocol's object — free text, an
 * order number, anything not in that shape — is not an AG-UI type merely for being called
 * `type`, so `keepAguiType` gates it. A `type` that is present but not even a string (e.g. a
 * number) is set to `null` rather than redacted as a leaf: a redacted string still reads to the
 * validator as SOME `type` value and would turn a `shape-invalid` issue into a fabricated
 * `unknown-event-type` — the same "don't invent a claim" rule `redactPatchOp` follows for paths.
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

function redactEvent(event: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return redactWholesale(event, { keepAguiType: true });
  }
  const src = event as Record<string, unknown>;
  const type = typeof src.type === 'string' ? src.type : '';

  if (!KNOWN_EVENT_TYPES.has(type)) {
    return redactWholesale(event, { keepAguiType: true });
  }

  const single = SINGLE_FIELD[type];
  if (single && groups.has(single.group) && single.field in src) {
    return { ...src, [single.field]: redactLeaf(src[single.field]) };
  }

  if (groups.has('state')) {
    if (type === 'STATE_SNAPSHOT' && 'snapshot' in src) {
      return { ...src, snapshot: redactDeep(src.snapshot) };
    }
    if (type === 'STATE_DELTA' && Array.isArray(src.delta)) {
      return { ...src, delta: src.delta.map((op) => redactPatchOp(op)) };
    }
  }

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
  if (type === 'RUN_STARTED' && 'input' in src) {
    return { ...src, input: redactInput(src.input, groups) };
  }

  return event;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One message of a `RunAgentInput.messages` array.
 *
 * Group ownership is per field rather than per line. A message's `content` is authored text
 * except on a `tool`-role message, where it is a tool result — so `toolResults` owns it there
 * and `text` must not reach it, or deselecting `toolResults` could not protect it.
 */
function redactMessage(message: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!isPlainObject(message)) return message;
  const out: Record<string, unknown> = { ...message };

  const contentGroup: RedactionGroup = message.role === 'tool' ? 'toolResults' : 'text';
  if ('content' in message && groups.has(contentGroup)) {
    out.content = redactDeep(message.content);
  }

  // An assistant message replays its tool calls, arguments included, as a JSON string.
  if (groups.has('toolArgs') && Array.isArray(message.toolCalls)) {
    out.toolCalls = message.toolCalls.map((call) => {
      if (!isPlainObject(call) || !isPlainObject(call.function)) return call;
      const fn = call.function;
      if (!('arguments' in fn)) return call;
      return { ...call, function: { ...fn, arguments: redactLeaf(fn.arguments) } };
    });
  }

  return out;
}

/**
 * A `RunAgentInput`, wherever it appears — the captured request body, or the copy the protocol
 * echoes back in `RUN_STARTED.input`.
 *
 * `tools` deliberately survives: a tool schema is developer-authored structure, no §11 group
 * owns it, and it is most of what makes a captured run legible.
 */
function redactInput(input: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = { ...input };

  if (Array.isArray(input.messages)) {
    out.messages = input.messages.map((message) => redactMessage(message, groups));
  }

  // App-supplied payloads, all of which can carry anything the page had in scope.
  if (groups.has('state')) {
    for (const key of ['state', 'context', 'forwardedProps']) {
      if (key in input) out[key] = redactDeep(input[key]);
    }
  }

  return out;
}

/**
 * Returns a redacted copy. Never mutates its argument. Structure survives by design — ids,
 * ordering, timings, JSON Pointer paths, patch ops always do, and so does `type` on a
 * recognised AG-UI event, or on an unnamed payload whose `type` merely follows AG-UI's own
 * naming convention. Beyond that, this is not a promise that only the value payloads named by
 * `groups` are replaced: a payload this module cannot classify as an AG-UI event — including
 * every payload on a line that names its own SSE event, which by definition is not one (see
 * below) — is redacted WHOLESALE as soon as any group is selected, per `redactWholesale`. Lines
 * no group owns, and only those, are returned as-is, by reference: a `header` or `keepalive`
 * line, or an event/request line when `groups` is empty.
 */
export function redactLine(line: JsonlLine, groups: RedactionGroup[]): JsonlLine {
  if (groups.length === 0) return line;
  const set = new Set(groups);

  if (line.kind === 'event') {
    /*
     * A line's `sseEvent` key means the frame carried an explicit `event:` name on the wire
     * (spec L1/L2). The capture and loader paths normalize the default name away — a bare
     * `message` event, or a frame with none at all, never sets this key — so ANY `sseEvent`
     * value means this line came off a protocol other than AG-UI's own SSE framing (LangGraph
     * Platform, today). Its payload must never reach the AG-UI dispatch table below: a
     * LangGraph frame can carry a `type` field that happens to collide with an AG-UI type name
     * (`CUSTOM`, say) by coincidence, and this module has no idea what that OTHER protocol's
     * field actually means. `redactWholesale` with `keepAguiType: false` treats the whole
     * payload, `type` included, as opaque app data. Spec L16's field-level LangGraph rules will
     * replace this wholesale fallback for LangGraph specifically; until then this is the only
     * honest behaviour.
     *
     * This errs safe, not precise: an AG-UI server that also happened to send its own `event:
     * <TYPE>` name on every frame would have those lines over-redacted here — their `type` label
     * dropped along with everything else `redactWholesale` cannot attribute to a group — never
     * under-redacted. Treating a named line as AG-UI by mistake is the direction that would leak.
     */
    if (line.sseEvent !== undefined) {
      return { ...line, event: redactWholesale(line.event, { keepAguiType: false }) };
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
