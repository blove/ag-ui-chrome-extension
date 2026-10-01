import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureRecord } from '../../core/model/types';
import type { ThreadplaneDevtoolsReport } from '../../core/signals/report';
import type { SwMessage } from '../../sw/protocol';
import { COALESCE_MS, createSignalCoalescer } from './coalesce';

function report(seq: number): ThreadplaneDevtoolsReport {
  return { v: 1, agent: 'a1', adapter: 'ag-ui', seq, eventType: 'X', wrote: ['status'], tMs: seq };
}

function signalsOnly(seq: number, droppedBefore = 0, signalsDropped = 0): SwMessage {
  return {
    kind: 'append',
    records: [],
    droppedBefore,
    signals: { reports: [report(seq)], droppedBefore: signalsDropped },
  };
}

const RECORD: CaptureRecord = {
  kind: 'event',
  seq: 1,
  tMs: 1,
  connId: 'c1',
  raw: '',
  issues: [],
  event: { type: 'RUN_STARTED' },
};

describe('createSignalCoalescer', () => {
  let delivered: SwMessage[];
  let coalescer: ReturnType<typeof createSignalCoalescer>;

  beforeEach(() => {
    vi.useFakeTimers();
    delivered = [];
    coalescer = createSignalCoalescer((message) => delivered.push(message));
  });

  afterEach(() => {
    coalescer.dispose();
    vi.useRealTimers();
  });

  it('folds a burst of report-only appends into one, delivered once the burst settles', () => {
    coalescer.push(signalsOnly(1));
    coalescer.push(signalsOnly(2, 0, 1));
    coalescer.push(signalsOnly(3, 4, 2));
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(COALESCE_MS);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({
      kind: 'append',
      records: [],
      // Both totals are re-stated on every message, so the last one is the current one.
      droppedBefore: 4,
      signals: { reports: [report(1), report(2), report(3)], droppedBefore: 2 },
    });
  });

  it('delivers every other message at once, after whatever reports were waiting', () => {
    coalescer.push(signalsOnly(1));
    const frames: SwMessage = { kind: 'append', records: [RECORD], droppedBefore: 0 };
    coalescer.push(frames);
    expect(delivered.map((m) => m.kind)).toEqual(['append', 'append']);
    expect(delivered[0]).toMatchObject({ signals: { reports: [report(1)] } });
    expect(delivered[1]).toBe(frames);

    // Nothing is left to deliver twice.
    vi.advanceTimersByTime(COALESCE_MS);
    expect(delivered).toHaveLength(2);
  });

  it('passes a message straight through when nothing is waiting', () => {
    coalescer.push({ kind: 'cleared' });
    expect(delivered).toEqual([{ kind: 'cleared' }]);
  });

  it('drops what is waiting on dispose — a new port answers with a snapshot', () => {
    coalescer.push(signalsOnly(1));
    coalescer.dispose();
    vi.advanceTimersByTime(COALESCE_MS * 4);
    expect(delivered).toEqual([]);
  });
});
