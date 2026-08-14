import { describe, it, expect } from 'vitest';
import {
  EVENT_TABLE,
  EVENT_TYPES,
  GENERATED_FROM_VERSION,
} from './event-table.generated';
import {
  DEPRECATED_EVENT_TYPES,
  chunkKindOf,
  getEventSpec,
  isDeprecatedEventType,
  isKnownEventType,
} from './table';

const ALL_EVENT_TYPES = [
  'ACTIVITY_DELTA',
  'ACTIVITY_SNAPSHOT',
  'CUSTOM',
  'MESSAGES_SNAPSHOT',
  'RAW',
  'REASONING_ENCRYPTED_VALUE',
  'REASONING_END',
  'REASONING_MESSAGE_CHUNK',
  'REASONING_MESSAGE_CONTENT',
  'REASONING_MESSAGE_END',
  'REASONING_MESSAGE_START',
  'REASONING_START',
  'RUN_ERROR',
  'RUN_FINISHED',
  'RUN_STARTED',
  'STATE_DELTA',
  'STATE_SNAPSHOT',
  'STEP_FINISHED',
  'STEP_STARTED',
  'TEXT_MESSAGE_CHUNK',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TEXT_MESSAGE_START',
  'THINKING_END',
  'THINKING_START',
  'THINKING_TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_END',
  'THINKING_TEXT_MESSAGE_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_CHUNK',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'TOOL_CALL_START',
];

describe('event-table.generated', () => {
  it('covers all 33 AG-UI event types (spec says 26; the real count is 33)', () => {
    expect(EVENT_TYPES.length).toBe(33);
    expect([...EVENT_TYPES]).toEqual(ALL_EVENT_TYPES);
  });

  it('records the @ag-ui/core version it was generated from', () => {
    expect(GENERATED_FROM_VERSION).toBe('@ag-ui/core@0.0.57');
  });

  it('has one table entry per event type, keyed by type', () => {
    expect(Object.keys(EVENT_TABLE).sort()).toEqual(ALL_EVENT_TYPES);
    for (const type of ALL_EVENT_TYPES) {
      expect(EVENT_TABLE[type]?.type).toBe(type);
    }
  });

  it('is deterministic: types and fields are sorted alphabetically', () => {
    expect([...EVENT_TYPES]).toEqual([...EVENT_TYPES].slice().sort());
    for (const type of EVENT_TYPES) {
      const names = EVENT_TABLE[type]?.fields.map((f) => f.name) ?? [];
      expect(names).toEqual(names.slice().sort());
    }
  });

  it('marks the discriminant `type` field as a required literal on every event', () => {
    for (const type of EVENT_TYPES) {
      const field = EVENT_TABLE[type]?.fields.find((f) => f.name === 'type');
      expect(field).toEqual({ name: 'type', kind: 'literal', required: true });
    }
  });
});

describe('getEventSpec', () => {
  it('returns the spec for a known type', () => {
    const spec = getEventSpec('RUN_STARTED');
    expect(spec?.type).toBe('RUN_STARTED');
    expect(spec?.fields).toEqual([
      { name: 'input', kind: 'object', required: false },
      { name: 'parentRunId', kind: 'string', required: false },
      { name: 'rawEvent', kind: 'unknown', required: false },
      { name: 'runId', kind: 'string', required: true },
      { name: 'threadId', kind: 'string', required: true },
      { name: 'timestamp', kind: 'number', required: false },
      { name: 'type', kind: 'literal', required: true },
    ]);
  });

  it('maps Zod field types onto FieldKind', () => {
    expect(getEventSpec('TEXT_MESSAGE_CONTENT')?.fields).toContainEqual({
      name: 'delta',
      kind: 'string',
      required: true,
    });
    expect(getEventSpec('STATE_DELTA')?.fields).toContainEqual({
      name: 'delta',
      kind: 'array',
      required: true,
    });
    expect(getEventSpec('ACTIVITY_SNAPSHOT')?.fields).toContainEqual({
      name: 'content',
      kind: 'object',
      required: true,
    });
    expect(getEventSpec('ACTIVITY_SNAPSHOT')?.fields).toContainEqual({
      name: 'replace',
      kind: 'boolean',
      required: false,
    });
    // STATE_SNAPSHOT.snapshot is `z.any()` — kind 'unknown', and z.any() is
    // optional in Zod, so `required` is false. Both facts are load-bearing.
    expect(getEventSpec('STATE_SNAPSHOT')?.fields).toContainEqual({
      name: 'snapshot',
      kind: 'unknown',
      required: false,
    });
  });

  it('unwraps ZodOptional so the inner kind survives', () => {
    expect(getEventSpec('TOOL_CALL_CHUNK')?.fields).toContainEqual({
      name: 'toolCallId',
      kind: 'string',
      required: false,
    });
    expect(getEventSpec('TOOL_CALL_CHUNK')?.fields).toContainEqual({
      name: 'delta',
      kind: 'string',
      required: false,
    });
  });

  it('returns undefined for an unknown type', () => {
    expect(getEventSpec('NOT_A_REAL_EVENT')).toBeUndefined();
  });

  it('does not leak Object.prototype members', () => {
    expect(getEventSpec('toString')).toBeUndefined();
    expect(getEventSpec('constructor')).toBeUndefined();
    expect(getEventSpec('__proto__')).toBeUndefined();
  });
});

describe('isKnownEventType', () => {
  it('is true for every generated type', () => {
    for (const type of EVENT_TYPES) expect(isKnownEventType(type)).toBe(true);
  });

  it('is false for unknown types and prototype keys', () => {
    expect(isKnownEventType('NOT_A_REAL_EVENT')).toBe(false);
    expect(isKnownEventType('')).toBe(false);
    expect(isKnownEventType('constructor')).toBe(false);
    expect(isKnownEventType('hasOwnProperty')).toBe(false);
  });
});

describe('DEPRECATED_EVENT_TYPES', () => {
  it('contains exactly the five THINKING_* events', () => {
    expect([...DEPRECATED_EVENT_TYPES].sort()).toEqual([
      'THINKING_END',
      'THINKING_START',
      'THINKING_TEXT_MESSAGE_CONTENT',
      'THINKING_TEXT_MESSAGE_END',
      'THINKING_TEXT_MESSAGE_START',
    ]);
  });

  it('only lists types that are actually in the table', () => {
    for (const type of DEPRECATED_EVENT_TYPES) {
      expect(isKnownEventType(type)).toBe(true);
    }
  });

  it('isDeprecatedEventType agrees with the set', () => {
    expect(isDeprecatedEventType('THINKING_START')).toBe(true);
    expect(isDeprecatedEventType('THINKING_TEXT_MESSAGE_CONTENT')).toBe(true);
    expect(isDeprecatedEventType('REASONING_START')).toBe(false);
    expect(isDeprecatedEventType('TEXT_MESSAGE_START')).toBe(false);
    expect(isDeprecatedEventType('NOT_A_REAL_EVENT')).toBe(false);
  });
});

describe('chunkKindOf', () => {
  it('maps the three chunk events', () => {
    expect(chunkKindOf('TEXT_MESSAGE_CHUNK')).toBe('text');
    expect(chunkKindOf('TOOL_CALL_CHUNK')).toBe('tool');
    expect(chunkKindOf('REASONING_MESSAGE_CHUNK')).toBe('reasoning');
  });

  it('returns undefined for everything else', () => {
    expect(chunkKindOf('TEXT_MESSAGE_CONTENT')).toBeUndefined();
    expect(chunkKindOf('RUN_STARTED')).toBeUndefined();
    expect(chunkKindOf('NOT_A_REAL_EVENT')).toBeUndefined();
    expect(chunkKindOf('')).toBeUndefined();
  });

  it('covers every table type whose name ends in _CHUNK', () => {
    const chunkTypes = EVENT_TYPES.filter((t) => t.endsWith('_CHUNK'));
    expect(chunkTypes.length).toBe(3);
    for (const type of chunkTypes) expect(chunkKindOf(type)).toBeDefined();
  });
});
