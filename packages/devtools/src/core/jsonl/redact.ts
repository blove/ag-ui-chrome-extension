import type { JsonlLine } from './codec';

export type RedactionGroup = 'text' | 'reasoning' | 'toolArgs' | 'toolResults' | 'state';

export const ALL_REDACTION_GROUPS: readonly RedactionGroup[] = [
  'text',
  'reasoning',
  'toolArgs',
  'toolResults',
  'state',
];

/** The one and only placeholder shape. Size survives; content does not. */
export function redactString(value: string): string {
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

function redactEvent(event: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return event;
  const src = event as Record<string, unknown>;
  const type = typeof src.type === 'string' ? src.type : '';

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

  return event;
}

function redactInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const src = input as Record<string, unknown>;
  if (!Array.isArray(src.messages)) return { ...src };

  const messages = src.messages.map((message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return message;
    const msg = message as Record<string, unknown>;
    if (!('content' in msg)) return { ...msg };
    return { ...msg, content: redactDeep(msg.content) };
  });

  return { ...src, messages };
}

/**
 * Returns a redacted copy. Never mutates its argument. Structure — `type`, ids, ordering,
 * timings, JSON Pointer paths, patch ops — always survives; only the value payloads named
 * by `groups` are replaced. Lines no group owns are returned as-is, by reference.
 */
export function redactLine(line: JsonlLine, groups: RedactionGroup[]): JsonlLine {
  if (groups.length === 0) return line;
  const set = new Set(groups);

  if (line.kind === 'event') {
    return { ...line, event: redactEvent(line.event, set) };
  }
  if (line.kind === 'request') {
    if (!set.has('state')) return line;
    return { ...line, input: redactInput(line.input) };
  }
  // `header` and `keepalive` fall through unchanged. Requirements §11's five groups are
  // text/reasoning/toolArgs/toolResults/state and none covers either kind: a keepalive
  // comment is proxy heartbeat metadata rather than agent or user content, and redacting
  // it would erase the signal keepalives are recorded for (proxy buffering). The header's
  // `redacted` field is likewise left to the export bundle builder.
  return line;
}
