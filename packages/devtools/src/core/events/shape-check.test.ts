import { describe, it, expect } from 'vitest';
import { checkShape } from './shape-check';

describe('checkShape — non-events', () => {
  it('emits a single shape-invalid for a non-object', () => {
    for (const raw of [null, undefined, 42, 'RUN_STARTED', true, []]) {
      const issues = checkShape(raw, 7);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('shape-invalid');
      expect(issues[0]?.severity).toBe('error');
      expect(issues[0]?.seq).toBe(7);
    }
  });

  it('emits a single shape-invalid when `type` is missing or not a string', () => {
    for (const raw of [{}, { type: 5 }, { type: null }, { runId: 'r1' }]) {
      const issues = checkShape(raw, 3);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('shape-invalid');
      expect(issues[0]?.severity).toBe('error');
      expect(issues[0]?.path).toBe('type');
      expect(issues[0]?.seq).toBe(3);
    }
  });
});

describe('checkShape — unknown event types', () => {
  it('warns once and does not field-check', () => {
    const issues = checkShape({ type: 'NOT_A_REAL_EVENT' }, 11);
    expect(issues).toEqual([
      {
        code: 'unknown-event-type',
        severity: 'warning',
        message: 'unknown event type `NOT_A_REAL_EVENT`',
        seq: 11,
        path: 'type',
      },
    ]);
  });

  it('does not treat Object.prototype keys as known types', () => {
    const issues = checkShape({ type: 'constructor' }, 1);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unknown-event-type');
  });
});

describe('checkShape — valid payloads', () => {
  it('accepts a minimal RUN_STARTED', () => {
    expect(checkShape({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }, 1)).toEqual([]);
  });

  it('accepts optional fields when present and well typed', () => {
    expect(
      checkShape(
        {
          type: 'RUN_STARTED',
          threadId: 't1',
          runId: 'r1',
          parentRunId: 'r0',
          timestamp: 1700000000000,
          input: { messages: [] },
        },
        1,
      ),
    ).toEqual([]);
  });

  it('accepts optional fields that are explicitly undefined', () => {
    expect(
      checkShape({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1', timestamp: undefined }, 1),
    ).toEqual([]);
  });

  it('allows unknown extra properties (forward compat)', () => {
    expect(
      checkShape({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1', futureField: 'x' }, 1),
    ).toEqual([]);
  });

  it('accepts the other core events', () => {
    expect(
      checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' }, 1),
    ).toEqual([]);
    expect(
      checkShape({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }, 1),
    ).toEqual([]);
    expect(
      checkShape({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: 1 }] }, 1),
    ).toEqual([]);
    expect(checkShape({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } }, 1)).toEqual([]);
    expect(checkShape({ type: 'THINKING_START' }, 1)).toEqual([]);
  });

  it('does not type-constrain `literal` or `unknown` kinds', () => {
    // TOOL_CALL_RESULT.role is an optional ZodLiteral; STATE_SNAPSHOT.snapshot is z.any().
    expect(
      checkShape(
        { type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 'tc1', content: 'ok', role: 'tool' },
        1,
      ),
    ).toEqual([]);
    expect(checkShape({ type: 'STATE_SNAPSHOT', snapshot: 'a string' }, 1)).toEqual([]);
  });
});

describe('checkShape — missing required fields', () => {
  it('reports one issue per missing field, in field order', () => {
    const issues = checkShape({ type: 'TOOL_CALL_RESULT' }, 4);
    expect(issues.map((i) => i.path)).toEqual(['content', 'messageId', 'toolCallId']);
    for (const issue of issues) {
      expect(issue.code).toBe('shape-invalid');
      expect(issue.severity).toBe('error');
      expect(issue.seq).toBe(4);
    }
  });

  it('names the event and the field in the message', () => {
    const issues = checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1' }, 9);
    expect(issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT: missing required field `delta`',
        seq: 9,
        path: 'delta',
      },
    ]);
  });

  it('treats an explicit undefined as missing but null as a type error', () => {
    expect(checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: undefined }, 1)[0]
      ?.message).toBe('TEXT_MESSAGE_CONTENT: missing required field `delta`');
    expect(checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: null }, 1)[0]
      ?.message).toBe('TEXT_MESSAGE_CONTENT: field `delta` should be string, got null');
  });
});

describe('checkShape — wrong field types', () => {
  it('checks strings', () => {
    const issues = checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 1, delta: 'hi' }, 2);
    expect(issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT: field `messageId` should be string, got number',
        seq: 2,
        path: 'messageId',
      },
    ]);
  });

  it('checks numbers, and rejects NaN/Infinity', () => {
    const base = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };
    expect(checkShape({ ...base, timestamp: 'now' }, 1)[0]?.message).toBe(
      'RUN_STARTED: field `timestamp` should be number, got string',
    );
    expect(checkShape({ ...base, timestamp: Number.NaN }, 1)[0]?.message).toBe(
      'RUN_STARTED: field `timestamp` should be number, got number',
    );
    expect(checkShape({ ...base, timestamp: Number.POSITIVE_INFINITY }, 1)).toHaveLength(1);
  });

  it('checks booleans', () => {
    const issues = checkShape(
      {
        type: 'ACTIVITY_SNAPSHOT',
        activityType: 'a',
        messageId: 'm1',
        content: {},
        replace: 'yes',
      },
      1,
    );
    expect(issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: 'ACTIVITY_SNAPSHOT: field `replace` should be boolean, got string',
        seq: 1,
        path: 'replace',
      },
    ]);
  });

  it('checks objects — arrays and null are not objects', () => {
    const mk = (content: unknown) => ({
      type: 'ACTIVITY_SNAPSHOT',
      activityType: 'a',
      messageId: 'm1',
      content,
    });
    expect(checkShape(mk([]), 1)[0]?.message).toBe(
      'ACTIVITY_SNAPSHOT: field `content` should be object, got array',
    );
    expect(checkShape(mk(null), 1)[0]?.message).toBe(
      'ACTIVITY_SNAPSHOT: field `content` should be object, got null',
    );
  });

  it('checks arrays', () => {
    expect(checkShape({ type: 'STATE_DELTA', delta: { op: 'add' } }, 1)[0]?.message).toBe(
      'STATE_DELTA: field `delta` should be array, got object',
    );
  });

  it('reports every violated field, not just the first', () => {
    const issues = checkShape({ type: 'TOOL_CALL_START', toolCallId: 1, toolCallName: 2 }, 5);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toEqual(['toolCallId', 'toolCallName']);
  });

  it('mixes missing and mistyped fields in one pass', () => {
    const issues = checkShape({ type: 'RUN_STARTED', threadId: 5 }, 6);
    expect(issues.map((i) => i.path)).toEqual(['runId', 'threadId']);
    expect(issues.map((i) => i.message)).toEqual([
      'RUN_STARTED: missing required field `runId`',
      'RUN_STARTED: field `threadId` should be string, got number',
    ]);
  });
});

describe('checkShape — issue plumbing', () => {
  it('never sets runId or opIndex', () => {
    const issues = checkShape({ type: 'RUN_STARTED' }, 1);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.runId).toBeUndefined();
      expect(issue.opIndex).toBeUndefined();
    }
  });

  it('threads seq through every issue', () => {
    for (const issue of checkShape({ type: 'TOOL_CALL_RESULT' }, 123)) {
      expect(issue.seq).toBe(123);
    }
  });

  it('does not mutate the input', () => {
    const raw = { type: 'RUN_STARTED', threadId: 't1' };
    const before = JSON.stringify(raw);
    checkShape(raw, 1);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
