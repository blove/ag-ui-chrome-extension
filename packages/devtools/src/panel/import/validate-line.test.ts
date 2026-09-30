// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { redactionNote } from '../../core/fixture/redaction-note';
import { toThreadplaneSpec } from '../../core/fixture/threadplane';
import { encodeJsonl } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS } from '../../core/jsonl/redact';
import { buildExport } from '../export/build';
import { toFixtureModule } from '../export/fixture';
import { initialPanelState } from '../model/panel-types';
import { applyLoaded } from './apply-loaded';
import { loadJsonl } from './load-jsonl';

/*
 * Hostile input, field by field. Every value an imported file holds is whatever the file
 * happened to contain, so each field is tried with every wrong JSON type, with its key missing,
 * and with a `__proto__` key standing where it should be — and the result must be a load, never
 * a throw, with every repaired or dropped value reported.
 */

const HEADER = {
  kind: 'header',
  schemaVersion: 1,
  tool: 'ag-ui-devtools@test',
  capturedAt: '2026-09-30T12:00:00.000Z',
  url: 'http://localhost:2024',
  framework: 'langgraph',
  transport: 'sse',
  redacted: [],
};
const REQUEST = {
  kind: 'request',
  connId: 'c1',
  tMs: 0,
  method: 'POST',
  url: 'http://localhost:2024/threads/t-1/runs/stream',
  input: { assistant_id: 'agent', input: { messages: [{ type: 'human', content: 'hi' }] } },
};
const EVENT = {
  kind: 'event',
  connId: 'c1',
  seq: 1,
  tMs: 10,
  sseEvent: 'values',
  event: { messages: [{ type: 'human', content: 'hi', id: 'h1' }] },
};
const KEEPALIVE = { kind: 'keepalive', connId: 'c1', seq: 2, tMs: 20, comment: 'ping' };

/** Every JSON type, so each field meets all the ones it is not. */
const WRONG_TYPES: unknown[] = [null, 0, -1.5, true, false, '', 'text', [], ['x'], {}, { a: 1 }];

type Line = Record<string, unknown>;

/** `line` with `key` set to `value`, or removed when `value` is `undefined`. */
function withField(line: Line, key: string, value: unknown): Line {
  const copy: Line = { ...line };
  if (value === undefined) delete copy[key];
  else copy[key] = value;
  return copy;
}

function jsonl(...lines: Line[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

function capture(overrides: { header?: Line; request?: Line; event?: Line; keepalive?: Line } = {}): string {
  return jsonl(
    overrides.header ?? HEADER,
    overrides.request ?? REQUEST,
    overrides.event ?? EVENT,
    overrides.keepalive ?? KEEPALIVE,
  );
}

/** Everything downstream of an import that reads these fields, run to completion. */
function exerciseDownstream(text: string): void {
  const loaded = loadJsonl(text);
  redactionNote(loaded.header);
  const state = applyLoaded(initialPanelState(), loaded, 'hostile.agui.jsonl', 0);
  for (const groups of [[], [...ALL_REDACTION_GROUPS]]) {
    const { lines } = buildExport(state, {
      scope: null,
      groups,
      toolVersion: 'test',
      exportedAtIso: '2026-09-30T13:00:00.000Z',
    });
    const written = encodeJsonl(lines);
    toFixtureModule(lines, 'hostile.fixture.ts');
    toThreadplaneSpec(lines, { filename: 'hostile.spec.ts' });
    // And the export reads back: a repaired capture re-exports as a well-formed one.
    expect(loadJsonl(written).decodeErrors).toEqual([]);
  }
}

describe('validate-line: every wrongly typed field loads, reports, and cannot throw downstream', () => {
  const cases: [string, string][] = [];
  const fields: ['header' | 'request' | 'event' | 'keepalive', Line, string[]][] = [
    ['header', HEADER, ['schemaVersion', 'tool', 'capturedAt', 'url', 'framework', 'transport', 'redacted', 'runtime']],
    ['request', REQUEST, ['connId', 'tMs', 'method', 'url', 'input']],
    ['event', EVENT, ['connId', 'seq', 'tMs', 'sseEvent', 'event']],
    ['keepalive', KEEPALIVE, ['connId', 'seq', 'tMs', 'comment']],
  ];
  for (const [kind, base, keys] of fields) {
    for (const key of keys) {
      for (const value of [undefined, ...WRONG_TYPES]) {
        cases.push([`${kind}.${key} = ${value === undefined ? 'missing' : JSON.stringify(value)}`, capture({ [kind]: withField(base, key, value) })]);
      }
    }
  }

  it.each(cases)('%s', (_name, text) => {
    expect(() => exerciseDownstream(text)).not.toThrow();
  });
});

describe('validate-line: header', () => {
  it('reads a well-formed header exactly as written, with no report', () => {
    const loaded = loadJsonl(capture());
    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.header).toEqual(HEADER);
  });

  it.each([
    ['tool', 5],
    ['capturedAt', null],
    ['url', { href: 'x' }],
  ])('repairs a non-string %s to "unknown" and says so', (key, value) => {
    const loaded = loadJsonl(capture({ header: withField(HEADER, key, value) }));
    expect(loaded.header?.[key as 'tool']).toBe('unknown');
    expect(loaded.decodeErrors).toEqual([
      `line 1: header: ${key} ${JSON.stringify(value)} is not a string; read as "unknown"`,
    ]);
  });

  it('reports a missing string field as missing', () => {
    const loaded = loadJsonl(capture({ header: withField(HEADER, 'url', undefined) }));
    expect(loaded.decodeErrors).toEqual(['line 1: header: url missing; read as "unknown"']);
  });

  it('reads an unknown transport as sse, and drops a non-string framework', () => {
    const loaded = loadJsonl(
      capture({ header: { ...HEADER, transport: 'carrier-pigeon', framework: ['x'] } }),
    );
    expect(loaded.header?.transport).toBe('sse');
    expect(loaded.header).not.toHaveProperty('framework');
    // One entry per line, however many of its fields were wrong: the notice counts lines.
    expect(loaded.decodeErrors).toEqual([
      'line 1: header: transport "carrier-pigeon" is not "sse" or "binary"; read as "sse"; ' +
        'framework ["x"] is not a string; dropped',
    ]);
  });

  it('reads any schemaVersion as 1 and says it did', () => {
    const loaded = loadJsonl(capture({ header: { ...HEADER, schemaVersion: 2 } }));
    expect(loaded.header?.schemaVersion).toBe(1);
    expect(loaded.decodeErrors).toEqual(['line 1: header: schemaVersion 2 is not 1; read as version 1']);
  });

  it('keeps only the declared keys', () => {
    const loaded = loadJsonl(capture({ header: { ...HEADER, extra: 'x' } }));
    expect(loaded.header).not.toHaveProperty('extra');
    // Unknown keys are what a newer build adds, not damage.
    expect(loaded.decodeErrors).toEqual([]);
  });

  it('does not let a __proto__ key stand in for a missing field', () => {
    const text =
      '{"kind":"header","schemaVersion":1,"tool":"t","capturedAt":"c","url":"u","transport":"sse",' +
      '"__proto__":{"redacted":["text"],"framework":"evil"}}';
    const loaded = loadJsonl(text);
    expect(loaded.header?.redacted).toEqual([]);
    expect(loaded.header).not.toHaveProperty('framework');
    expect(Object.getPrototypeOf(loaded.header)).toBe(Object.prototype);
    expect(Object.hasOwn(loaded.header ?? {}, '__proto__')).toBe(false);
    expect(loaded.decodeErrors).toEqual([
      'line 1: header: redacted missing; read as nothing redacted',
    ]);
  });
});

describe('validate-line: header.redacted never loses a claim (E3)', () => {
  function redactedOf(value: unknown): { header: string[]; errors: string[]; runs: string[] } {
    const loaded = loadJsonl(capture({ header: withField(HEADER, 'redacted', value) }));
    return {
      header: [...(loaded.header?.redacted ?? [])],
      errors: loaded.decodeErrors,
      runs: [...(loaded.runs[0]?.redacted ?? [])],
    };
  }

  it('keeps known groups, silently', () => {
    expect(redactedOf(['text', 'state'])).toEqual({ header: ['text', 'state'], errors: [], runs: ['text', 'state'] });
  });

  it('keeps an unknown string for re-export, but hands the fold only the groups it knows', () => {
    const read = redactedOf(['text', 'futureGroup', '__proto__']);
    expect(read.header).toEqual(['text', 'futureGroup', '__proto__']);
    expect(read.runs).toEqual(['text']);
    expect(read.errors).toEqual([]);
  });

  it('drops a non-string entry, with a warning, and keeps the rest', () => {
    const read = redactedOf(['text', 5, { group: 'state' }, null]);
    expect(read.header).toEqual(['text']);
    expect(read.errors).toEqual([
      'line 1: header: redacted entry 5 is not a group name; dropped; ' +
        'redacted entry {"group":"state"} is not a group name; dropped; ' +
        'redacted entry null is not a group name; dropped',
    ]);
  });

  it('reads a bare string as the one group it names', () => {
    const read = redactedOf('toolArgs');
    expect(read.header).toEqual(['toolArgs']);
    expect(read.runs).toEqual(['toolArgs']);
    expect(read.errors).toEqual(['line 1: header: redacted "toolArgs" is not a list; read as ["toolArgs"]']);
  });

  it.each([true, 1, {}, { text: true }])(
    'reads %j — a claim that says something was redacted but not what — as every group',
    (value) => {
      const read = redactedOf(value);
      expect(read.header).toEqual([...ALL_REDACTION_GROUPS]);
      expect(read.runs).toEqual([...ALL_REDACTION_GROUPS]);
      expect(read.errors).toHaveLength(1);
    },
  );

  it.each([null, false, 0, '', undefined])('reads %j as nothing redacted, and reports it', (value) => {
    const read = redactedOf(value);
    expect(read.header).toEqual([]);
    expect(read.errors).toHaveLength(1);
  });

  it('carries every kept claim, unknown ones included, into a re-export', () => {
    const loaded = loadJsonl(capture({ header: { ...HEADER, redacted: ['futureGroup', 7, 'reasoning'] } }));
    const state = applyLoaded(initialPanelState(), loaded, 'f.agui.jsonl', 0);
    const { header } = buildExport(state, { scope: null, groups: ['text'], toolVersion: 't', exportedAtIso: 'now' });
    expect(header.redacted).toEqual(['text', 'reasoning', 'futureGroup']);
    expect(redactionNote(loaded.header)).toContain('groups redacted: futureGroup, reasoning');
  });
});

describe('validate-line: stream lines', () => {
  it.each([
    ['request', REQUEST, 2],
    ['event', EVENT, 3],
    ['keepalive', KEEPALIVE, 4],
  ] as const)('drops a %s whose connId is not a string, and loads the rest', (kind, base, line) => {
    const loaded = loadJsonl(capture({ [kind]: { ...base, connId: 1 } }));
    expect(loaded.decodeErrors).toEqual([`line ${String(line)}: ${kind}: connId 1 is not a string; line dropped`]);
    expect(loaded.records.length + loaded.requests.length).toBe(2);
  });

  it.each([
    ['event', EVENT, 3],
    ['keepalive', KEEPALIVE, 4],
  ] as const)('drops a %s whose seq is not a non-negative integer, and loads the rest', (kind, base, line) => {
    const loaded = loadJsonl(capture({ [kind]: { ...base, seq: '1' } }));
    expect(loaded.decodeErrors).toEqual([
      `line ${String(line)}: ${kind}: seq "1" is not a non-negative integer; line dropped`,
    ]);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.requests).toHaveLength(1);
  });

  it.each([-1, 1.5, 2 ** 53, '1', null])('rejects %j as a seq', (seq) => {
    const loaded = loadJsonl(capture({ event: { ...EVENT, seq } }));
    expect(loaded.records.map((record) => record.kind)).toEqual(['keepalive']);
    expect(loaded.decodeErrors).toHaveLength(1);
  });

  it('places a frame with an unreadable tMs at its connection\'s last time, and says so', () => {
    const loaded = loadJsonl(capture({ keepalive: { ...KEEPALIVE, tMs: '20' } }));
    expect(loaded.records.map((record) => record.tMs)).toEqual([10, 10]);
    expect(loaded.decodeErrors).toEqual(['line 4: keepalive: tMs "20" is not a number; read as 10']);
  });

  it('reads an out-of-range number as unreadable rather than as Infinity', () => {
    const loaded = loadJsonl(capture().replace('"tMs":20', '"tMs":1e400'));
    expect(loaded.records.map((record) => record.tMs)).toEqual([10, 10]);
    expect(loaded.decodeErrors).toEqual(['line 4: keepalive: tMs Infinity is not a number; read as 10']);
  });

  it('places a connection\'s first line at 0 when its tMs is unreadable', () => {
    const loaded = loadJsonl(capture({ request: withField(REQUEST, 'tMs', undefined) }));
    expect(loaded.requests[0]?.tMs).toBe(0);
    expect(loaded.decodeErrors).toEqual(['line 2: request: tMs missing; read as 0']);
  });

  it('repairs a request\'s method and url to "unknown"', () => {
    const loaded = loadJsonl(capture({ request: { ...REQUEST, method: 5, url: ['x'] } }));
    expect(loaded.requests[0]).toMatchObject({ method: 'unknown', url: 'unknown' });
    expect(loaded.decodeErrors).toEqual([
      'line 2: request: method 5 is not a string; read as "unknown"; url ["x"] is not a string; read as "unknown"',
    ]);
  });

  it('accepts any JSON input — the live capture writes strings and null — and reports only a missing one', () => {
    for (const input of [null, 'raw body', 5, ['a'], true]) {
      const loaded = loadJsonl(capture({ request: { ...REQUEST, input } }));
      expect(loaded.requests[0]?.input).toEqual(input);
      expect(loaded.decodeErrors).toEqual([]);
    }
    const missing = loadJsonl(capture({ request: withField(REQUEST, 'input', undefined) }));
    expect(missing.requests[0]?.input).toBeNull();
    expect(missing.decodeErrors).toEqual(['line 2: request: input missing; read as null']);
  });

  it('drops a non-string sseEvent and keeps the event', () => {
    const loaded = loadJsonl(capture({ event: { ...EVENT, sseEvent: { name: 'values' } } }));
    const record = loaded.records[0];
    expect(record?.kind === 'event' ? record.sseEvent : 'not an event').toBeUndefined();
    expect(record?.raw).toEqual(EVENT.event);
    expect(loaded.decodeErrors).toEqual(['line 3: event: sseEvent {"name":"values"} is not a string; dropped']);
  });

  it('reads a missing event payload as null — the builder\'s own unparsed frame', () => {
    const loaded = loadJsonl(capture({ event: withField(EVENT, 'event', undefined) }));
    expect(loaded.records[0]).toMatchObject({ kind: 'event', raw: null, event: null });
    expect(loaded.decodeErrors).toEqual(['line 3: event: event missing; read as null']);
  });

  it('repairs a non-string keepalive comment to the bare heartbeat', () => {
    const loaded = loadJsonl(capture({ keepalive: { ...KEEPALIVE, comment: 7 } }));
    expect(loaded.records[1]).toMatchObject({ kind: 'keepalive', comment: '', raw: ':\n\n' });
    expect(loaded.decodeErrors).toEqual(['line 4: keepalive: comment 7 is not a string; read as ""']);
  });

  it('does not let a __proto__ key stand in for a missing seq, connId or tMs', () => {
    const text = jsonl(
      HEADER,
      REQUEST,
      { kind: 'event', connId: 'c1', tMs: 10, event: {} },
      { kind: 'keepalive', seq: 2, tMs: 20, comment: '' },
    ).replace('"tMs":10,', '"tMs":10,"__proto__":{"seq":1},')
      .replace('"seq":2,', '"seq":2,"__proto__":{"connId":"c1"},');
    const loaded = loadJsonl(text);
    expect(loaded.records).toEqual([]);
    expect(loaded.decodeErrors).toEqual([
      'line 3: event: seq missing; line dropped',
      'line 4: keepalive: connId missing; line dropped',
    ]);
  });

  it('builds every accepted line from its declared keys only', () => {
    const loaded = loadJsonl(capture({ request: { ...REQUEST, extra: 1 } }));
    expect(loaded.requests[0]).not.toHaveProperty('extra');
    expect(loaded.decodeErrors).toEqual([]);
  });
});

describe('validate-line: the partial-decode notice counts what was repaired', () => {
  it('reports one line per damaged line, after the undecodable ones', () => {
    const text = [
      JSON.stringify({ ...HEADER, url: 5, tool: 6 }),
      'not json',
      JSON.stringify(REQUEST),
      JSON.stringify({ ...EVENT, seq: 'x' }),
      JSON.stringify(KEEPALIVE),
    ].join('\n');
    const loaded = loadJsonl(text);
    expect(loaded.decodeErrors.map((message) => message.slice(0, message.indexOf(':')))).toEqual([
      'line 2',
      'line 1',
      'line 4',
    ]);
    const state = applyLoaded(initialPanelState(), loaded, 'damaged.agui.jsonl', 0);
    expect(state.loadError).toBe(
      'damaged.agui.jsonl: 3 lines could not be decoded — this capture is incomplete.',
    );
  });
});
