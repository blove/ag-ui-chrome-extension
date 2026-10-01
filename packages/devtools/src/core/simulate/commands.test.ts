import { describe, expect, it } from 'vitest';
import {
  ACK_EVENT,
  ARM_EVENT,
  DISARM_EVENT,
  isAck,
  isArmCommand,
  MAX_ARM_CHARS,
  MAX_ITEMS_PER_RUN,
  MAX_JSON_DEPTH,
  MAX_RUNS,
  parseAck,
  parseArmCommand,
  parseDisarmCommand,
  type ArmCommand,
} from './commands';

const LG: ArmCommand = {
  v: 1,
  armId: 'arm-1',
  adapter: 'langgraph',
  runs: [
    {
      frames: [
        { event: 'metadata', data: { run_id: 'r-1' } },
        { event: 'values', data: { messages: [{ type: 'human', content: 'hi', id: 'h1' }], n: 1.5, ok: true, x: null } },
      ],
    },
  ],
};

const AG: ArmCommand = {
  v: 1,
  armId: 'arm-2',
  adapter: 'ag-ui',
  runs: [{ events: [{ type: 'RUN_STARTED', threadId: 't', runId: 'r' }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r' }] }],
};

function lgWith(patch: (command: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(LG) as unknown as Record<string, unknown>;
  patch(copy);
  return copy;
}

function frames(count: number): { event: string; data: unknown }[] {
  return Array.from({ length: count }, (_, i) => ({ event: 'values', data: { i } }));
}

describe('the event names', () => {
  it('are the ones R1 and R4 fix', () => {
    expect(ARM_EVENT).toBe('threadplane:devtools:arm');
    expect(DISARM_EVENT).toBe('threadplane:devtools:disarm');
    expect(ACK_EVENT).toBe('threadplane:devtools:ack');
  });
});

describe('parseArmCommand — accepts the contract', () => {
  it('accepts a LangGraph and an AG-UI command, returning an equal copy that is not the original', () => {
    for (const command of [LG, AG]) {
      const parsed = parseArmCommand(command);
      expect(parsed).toEqual({ ok: true, value: command });
      if (parsed.ok) {
        expect(parsed.value).not.toBe(command);
        expect(parsed.value.runs[0]).not.toBe(command.runs[0]);
      }
    }
  });

  it('accepts the limits themselves: 8 runs, 5,000 frames, a 64-char armId', () => {
    const runs = Array.from({ length: MAX_RUNS }, () => ({ frames: frames(1) }));
    expect(isArmCommand({ ...LG, runs })).toBe(true);
    expect(isArmCommand({ ...LG, runs: [{ frames: frames(MAX_ITEMS_PER_RUN) }] })).toBe(true);
    expect(isArmCommand({ ...LG, armId: 'a'.repeat(64) })).toBe(true);
  });

  it('accepts a structured clone and a null-prototype object', () => {
    expect(isArmCommand(structuredClone(LG))).toBe(true);
    expect(isArmCommand(Object.assign(Object.create(null) as object, LG))).toBe(true);
  });
});

describe('parseArmCommand — rejects, with a reason', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['an array', [LG]],
    ['version 2', { ...LG, v: 2 }],
    ['an extra key', { ...LG, extra: 1 }],
    ['a missing armId', lgWith((c) => delete c['armId'])],
    ['an empty armId', { ...LG, armId: '' }],
    ['a 65-char armId', { ...LG, armId: 'a'.repeat(65) }],
    ['an armId with markup', { ...LG, armId: '<b>' }],
    ['an unknown adapter', { ...LG, adapter: 'crewai' }],
    ['no runs', { ...LG, runs: [] }],
    ['nine runs', { ...LG, runs: Array.from({ length: MAX_RUNS + 1 }, () => ({ frames: frames(1) })) }],
    ['5,001 frames', { ...LG, runs: [{ frames: frames(MAX_ITEMS_PER_RUN + 1) }] }],
    ['an empty run', { ...LG, runs: [{ frames: [] }] }],
    ['a run with an extra key', { ...LG, runs: [{ frames: frames(1), x: 1 }] }],
    ['a frame with no data', { ...LG, runs: [{ frames: [{ event: 'values' }] }] }],
    ['a frame with an extra key', { ...LG, runs: [{ frames: [{ event: 'values', data: 1, id: 2 }] }] }],
    ['a frame with an empty name', { ...LG, runs: [{ frames: [{ event: '', data: 1 }] }] }],
    ['a LangGraph run on an AG-UI command', { ...AG, runs: LG.runs }],
    ['an AG-UI event without a type', { ...AG, runs: [{ events: [{ threadId: 't' }] }] }],
    ['an AG-UI event that is a string', { ...AG, runs: [{ events: ['RUN_STARTED'] }] }],
    ['a NaN in data', { ...LG, runs: [{ frames: [{ event: 'values', data: { n: Number.NaN } }] }] }],
    ['undefined in data', { ...LG, runs: [{ frames: [{ event: 'values', data: { n: undefined } }] }] }],
    ['a function in data', { ...LG, runs: [{ frames: [{ event: 'values', data: { f: () => 1 } }] }] }],
    ['a bigint in data', { ...LG, runs: [{ frames: [{ event: 'values', data: 1n }] }] }],
    ['a Date in data', { ...LG, runs: [{ frames: [{ event: 'values', data: new Date(0) }] }] }],
    // eslint-disable-next-line no-sparse-arrays
    ['a sparse array in data', { ...LG, runs: [{ frames: [{ event: 'values', data: [1, , 3] }] }] }],
    ['an own __proto__ key in data', { ...LG, runs: [{ frames: [{ event: 'values', data: JSON.parse('{"__proto__":{"x":1}}') }] }] }],
    ['a symbol key', { ...LG, [Symbol('x')]: 1 }],
    ['an inherited field', Object.assign(Object.create({ v: 1 }) as object, { armId: 'a', adapter: 'langgraph', runs: LG.runs })],
  ];

  it.each(cases)('rejects %s', (_name, value) => {
    const parsed = parseArmCommand(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it('names the limit it hit', () => {
    const parsed = parseArmCommand({ ...LG, runs: Array.from({ length: 9 }, () => ({ frames: frames(1) })) });
    expect(parsed).toEqual({ ok: false, reason: 'runs has 9 items; the limit is 8' });
  });

  it('rejects a command over 2 MB of JSON, and stops early on a huge one', () => {
    const big = 'x'.repeat(MAX_ARM_CHARS);
    const parsed = parseArmCommand({ ...LG, runs: [{ frames: [{ event: 'values', data: big }] }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/larger than/);
  });

  it('rejects a cycle without hanging, and nesting past the depth limit', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(isArmCommand({ ...LG, runs: [{ frames: [{ event: 'values', data: cyclic }] }] })).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < MAX_JSON_DEPTH + 2; i += 1) deep = [deep];
    expect(isArmCommand({ ...LG, runs: [{ frames: [{ event: 'values', data: deep }] }] })).toBe(false);
  });

  it('never runs a getter, and survives hostile traps', () => {
    let ran = 0;
    const getter = { ...LG };
    Object.defineProperty(getter, 'armId', {
      enumerable: true,
      get: () => {
        ran += 1;
        return 'arm-1';
      },
    });
    expect(isArmCommand(getter)).toBe(false);
    expect(ran).toBe(0);
    const proxy = new Proxy(LG, {
      ownKeys: () => {
        throw new Error('trap');
      },
    });
    expect(parseArmCommand(proxy)).toEqual({ ok: false, reason: 'the value is not plain data' });
  });

  it('rejects an array carrying an extra property', () => {
    const runs: unknown[] & { extra?: number } = [{ frames: frames(1) }];
    runs.extra = 1;
    expect(isArmCommand({ ...LG, runs })).toBe(false);
  });
});

describe('parseDisarmCommand', () => {
  it('accepts exactly { v: 1, armId }', () => {
    expect(parseDisarmCommand({ v: 1, armId: 'arm-1' })).toEqual({ ok: true, value: { v: 1, armId: 'arm-1' } });
    expect(parseDisarmCommand({ v: 1, armId: 'arm-1', runs: [] }).ok).toBe(false);
    expect(parseDisarmCommand({ v: 1 }).ok).toBe(false);
    expect(parseDisarmCommand('arm-1').ok).toBe(false);
  });
});

describe('parseAck', () => {
  it('accepts every state, with and without run and reason', () => {
    for (const state of ['armed', 'consumed', 'expired', 'disarmed', 'rejected']) {
      expect(isAck({ v: 1, armId: 'a', state })).toBe(true);
    }
    expect(parseAck({ v: 1, armId: 'a', state: 'consumed', run: 0 })).toEqual({
      ok: true,
      value: { v: 1, armId: 'a', state: 'consumed', run: 0 },
    });
    expect(isAck({ v: 1, armId: 'a', state: 'rejected', reason: 'too many runs' })).toBe(true);
    // 0-based, as Threadplane's hook counts (cacheplane/threadplane#1204): the last of 8 runs is 7.
    expect(isAck({ v: 1, armId: 'a', state: 'consumed', run: MAX_RUNS - 1 })).toBe(true);
  });

  const cases: Array<[string, unknown]> = [
    ['an unknown state', { v: 1, armId: 'a', state: 'done' }],
    ['an extra key', { v: 1, armId: 'a', state: 'armed', detail: 'x' }],
    ['a missing state', { v: 1, armId: 'a' }],
    ['a negative run', { v: 1, armId: 'a', state: 'consumed', run: -1 }],
    ['a fractional run', { v: 1, armId: 'a', state: 'consumed', run: 0.5 }],
    ['a run past the last index (runs are 0-based)', { v: 1, armId: 'a', state: 'consumed', run: MAX_RUNS }],
    ['an empty reason', { v: 1, armId: 'a', state: 'rejected', reason: '' }],
    ['a 201-char reason', { v: 1, armId: 'a', state: 'rejected', reason: 'x'.repeat(201) }],
    ['a bad armId', { v: 1, armId: 'a b', state: 'armed' }],
    ['version 2', { v: 2, armId: 'a', state: 'armed' }],
  ];

  it.each(cases)('rejects %s', (_name, value) => {
    expect(isAck(value)).toBe(false);
  });

  it('returns a copy carrying nothing but the contract', () => {
    const parsed = parseAck({ v: 1, armId: 'a', state: 'armed' });
    expect(parsed.ok && Object.keys(parsed.value)).toEqual(['v', 'armId', 'state']);
  });
});
