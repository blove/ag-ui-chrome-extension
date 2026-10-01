import { describe, expect, it } from 'vitest';
import {
  AG_UI_SIGNALS,
  cloneReport,
  isThreadplaneReport,
  LANGGRAPH_SIGNALS,
  type ThreadplaneDevtoolsReport,
} from './report';

/**
 * The shared contract, as the plan states it and as Threadplane's emitter must produce it. Kept
 * here verbatim as a fixture so a drift on either side shows up as a failing test on this one.
 */
const LANGGRAPH_REPORT: ThreadplaneDevtoolsReport = {
  v: 1,
  agent: '6f1c2a9e-3b7d-4e1f-9a2b-8c4d5e6f7a8b',
  adapter: 'langgraph',
  seq: 1,
  eventType: 'messages',
  wrote: ['messages', 'messageMetadata', 'subagents', 'toolCalls'],
  tMs: 1234.5,
};

const AG_UI_REPORT: ThreadplaneDevtoolsReport = {
  v: 1,
  agent: 'a1',
  adapter: 'ag-ui',
  seq: 7,
  eventType: 'RUN_STARTED',
  wrote: ['status', 'isLoading', 'error', 'interrupt', 'customEvents', 'activities'],
  tMs: 0,
};

function withField(base: ThreadplaneDevtoolsReport, key: string, value: unknown): unknown {
  return { ...base, [key]: value };
}

function without(base: ThreadplaneDevtoolsReport, key: keyof ThreadplaneDevtoolsReport): unknown {
  const copy: Record<string, unknown> = { ...base };
  Reflect.deleteProperty(copy, key);
  return copy;
}

describe('the vocabularies (G4)', () => {
  it('are exactly the names the design fixes, in its order', () => {
    expect(LANGGRAPH_SIGNALS).toEqual([
      'status',
      'values',
      'messages',
      'error',
      'interrupt',
      'interrupts',
      'branch',
      'history',
      'isThreadLoading',
      'toolProgress',
      'toolCalls',
      'messageMetadata',
      'subagents',
      'queue',
      'custom',
    ]);
    expect(AG_UI_SIGNALS).toEqual([
      'messages',
      'status',
      'isLoading',
      'error',
      'toolCalls',
      'state',
      'interrupt',
      'customEvents',
      'activities',
      'interruptSession',
    ]);
  });
});

describe('isThreadplaneReport — accepts the contract', () => {
  it('accepts a LangGraph report and an AG-UI report', () => {
    expect(isThreadplaneReport(LANGGRAPH_REPORT)).toBe(true);
    expect(isThreadplaneReport(AG_UI_REPORT)).toBe(true);
  });

  it('accepts a pseudo-event label as the event type', () => {
    for (const label of ['run:start', 'run:end', 'history', 'reset', 'submit', 'queue', 'branch']) {
      expect(isThreadplaneReport({ ...LANGGRAPH_REPORT, eventType: label })).toBe(true);
    }
  });

  it('accepts the limits themselves: 128-char eventType, 64-char agent, 32 names', () => {
    expect(isThreadplaneReport({ ...AG_UI_REPORT, eventType: 'x'.repeat(128) })).toBe(true);
    expect(isThreadplaneReport({ ...AG_UI_REPORT, agent: 'a'.repeat(64) })).toBe(true);
    // The vocabularies are shorter than the cap, so the cap is reachable only in principle. The
    // full LangGraph vocabulary is the largest legal `wrote`.
    expect(isThreadplaneReport({ ...LANGGRAPH_REPORT, wrote: [...LANGGRAPH_SIGNALS] })).toBe(true);
  });

  it('accepts a null-prototype report, which is still only own data', () => {
    const bare = Object.assign(Object.create(null) as object, LANGGRAPH_REPORT);
    expect(isThreadplaneReport(bare)).toBe(true);
  });

  it('accepts a report that survived a structured clone', () => {
    expect(isThreadplaneReport(structuredClone(LANGGRAPH_REPORT))).toBe(true);
  });
});

describe('isThreadplaneReport — rejects everything else', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'messages'],
    ['an array', [LANGGRAPH_REPORT]],
    ['an extra key', withField(LANGGRAPH_REPORT, 'value', 'secret')],
    ['an own __proto__ key', JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(LANGGRAPH_REPORT).slice(1)}`)],
    ['a symbol key', { ...LANGGRAPH_REPORT, [Symbol('extra')]: 1 }],
    ['a missing key', without(LANGGRAPH_REPORT, 'tMs')],
    ['a missing wrote', without(LANGGRAPH_REPORT, 'wrote')],
    ['version 2', withField(LANGGRAPH_REPORT, 'v', 2)],
    ['version as a string', withField(LANGGRAPH_REPORT, 'v', '1')],
    ['an empty agent', withField(LANGGRAPH_REPORT, 'agent', '')],
    ['a 65-char agent', withField(LANGGRAPH_REPORT, 'agent', 'a'.repeat(65))],
    ['a numeric agent', withField(LANGGRAPH_REPORT, 'agent', 7)],
    ['an unknown adapter', withField(LANGGRAPH_REPORT, 'adapter', 'crewai')],
    ['seq 0', withField(LANGGRAPH_REPORT, 'seq', 0)],
    ['a fractional seq', withField(LANGGRAPH_REPORT, 'seq', 1.5)],
    ['a NaN seq', withField(LANGGRAPH_REPORT, 'seq', Number.NaN)],
    ['a string seq', withField(LANGGRAPH_REPORT, 'seq', '1')],
    ['an unsafe seq', withField(LANGGRAPH_REPORT, 'seq', 2 ** 53)],
    ['an empty eventType', withField(LANGGRAPH_REPORT, 'eventType', '')],
    ['a 129-char eventType', withField(LANGGRAPH_REPORT, 'eventType', 'x'.repeat(129))],
    ['a non-string eventType', withField(LANGGRAPH_REPORT, 'eventType', { type: 'x' })],
    ['a NaN tMs', withField(LANGGRAPH_REPORT, 'tMs', Number.NaN)],
    ['an infinite tMs', withField(LANGGRAPH_REPORT, 'tMs', Number.POSITIVE_INFINITY)],
    ['a negative tMs', withField(LANGGRAPH_REPORT, 'tMs', -1)],
    ['a string tMs', withField(LANGGRAPH_REPORT, 'tMs', '12')],
    ['an empty wrote', withField(LANGGRAPH_REPORT, 'wrote', [])],
    ['a wrote that is not an array', withField(LANGGRAPH_REPORT, 'wrote', 'messages')],
    ['33 names', withField(LANGGRAPH_REPORT, 'wrote', Array.from({ length: 33 }, () => 'messages'))],
    ['a duplicate name', withField(LANGGRAPH_REPORT, 'wrote', ['messages', 'values', 'messages'])],
    ['a name outside every vocabulary', withField(LANGGRAPH_REPORT, 'wrote', ['messages', 'password'])],
    // Each adapter has its own vocabulary: `values` is LangGraph's, `state` is AG-UI's.
    ['an AG-UI name on a LangGraph report', withField(LANGGRAPH_REPORT, 'wrote', ['state'])],
    ['a LangGraph name on an AG-UI report', withField(AG_UI_REPORT, 'wrote', ['values'])],
    ['a non-string name', withField(LANGGRAPH_REPORT, 'wrote', ['messages', 3])],
    // A hole reads as `undefined`, and an inherited index must not stand in for an own one.
    // eslint-disable-next-line no-sparse-arrays
    ['a sparse wrote', withField(LANGGRAPH_REPORT, 'wrote', [, 'messages'])],
    ['an inherited key', Object.assign(Object.create({ tMs: 1 }) as object, without(LANGGRAPH_REPORT, 'tMs'))],
    ['a name that is a prototype key', withField(LANGGRAPH_REPORT, 'wrote', ['constructor'])],
    ['a name that is __proto__', withField(LANGGRAPH_REPORT, 'wrote', ['__proto__'])],
  ];

  it.each(cases)('rejects %s', (_name, value) => {
    expect(isThreadplaneReport(value)).toBe(false);
  });

  it('rejects a wrote whose index is inherited rather than owned', () => {
    const proto = Array.prototype as unknown as Record<string, unknown>;
    proto['0'] = 'messages';
    try {
      const wrote: string[] = [];
      wrote.length = 1;
      expect(isThreadplaneReport({ ...LANGGRAPH_REPORT, wrote })).toBe(false);
    } finally {
      Reflect.deleteProperty(proto, '0');
    }
  });

  it('returns false instead of throwing when a getter throws', () => {
    const hostile = { ...LANGGRAPH_REPORT };
    Object.defineProperty(hostile, 'wrote', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    expect(isThreadplaneReport(hostile)).toBe(false);
  });

  it('returns false instead of throwing for a Proxy with hostile traps', () => {
    const hostile = new Proxy(
      { ...LANGGRAPH_REPORT },
      {
        ownKeys(): never {
          throw new Error('boom');
        },
      },
    );
    expect(isThreadplaneReport(hostile)).toBe(false);
  });

  it('is not fooled by Object.prototype pollution', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto['tMs'] = 1;
    try {
      expect(isThreadplaneReport(without(LANGGRAPH_REPORT, 'tMs'))).toBe(false);
    } finally {
      Reflect.deleteProperty(proto, 'tMs');
    }
  });
});

describe('cloneReport', () => {
  it('copies every field of the contract and nothing else', () => {
    const clone = cloneReport(LANGGRAPH_REPORT);
    expect(clone).toEqual(LANGGRAPH_REPORT);
    expect(clone).not.toBe(LANGGRAPH_REPORT);
    expect(clone.wrote).not.toBe(LANGGRAPH_REPORT.wrote);
  });

  it('drops anything riding on the array or the object', () => {
    const wrote = Object.assign(['messages'], { smuggled: 'x' });
    const source = Object.assign({ ...LANGGRAPH_REPORT, wrote }, { alsoSmuggled: true });
    const clone = cloneReport(source);
    expect(JSON.stringify(clone)).not.toContain('muggled');
    expect(Object.keys(clone).sort()).toEqual(
      ['adapter', 'agent', 'eventType', 'seq', 'tMs', 'v', 'wrote'].sort(),
    );
  });

  it('produces a plain object with the ordinary prototype', () => {
    const bare = Object.assign(Object.create(null) as object, LANGGRAPH_REPORT) as ThreadplaneDevtoolsReport;
    expect(Object.getPrototypeOf(cloneReport(bare))).toBe(Object.prototype);
  });
});
