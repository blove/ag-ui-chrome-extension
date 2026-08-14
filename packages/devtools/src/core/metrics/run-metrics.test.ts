import { describe, it, expect } from 'vitest';
import { computeMetrics } from './run-metrics';
import type { AguiEvent, CaptureRecord, ReconstructedMessage, Run } from '../model/types';

function rec(seq: number, tMs: number, event: AguiEvent): CaptureRecord {
  return { kind: 'event', seq, tMs, connId: 'c1', raw: event, event, issues: [] };
}

/** A keepalive record. `raw` defaults to the SSE comment bytes actually on the wire. */
function keepalive(seq: number, tMs: number, comment: string): CaptureRecord {
  return { kind: 'keepalive', seq, tMs, connId: 'c1', raw: `:${comment}\n\n`, comment, issues: [] };
}

function message(overrides: Partial<ReconstructedMessage> & { messageId: string }): ReconstructedMessage {
  return {
    kind: 'text',
    content: '',
    startedAtMs: 0,
    closed: false,
    contentSeqs: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'r1',
    threadId: 't1',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('returns the empty shape for a run with no records', () => {
    const metrics = computeMetrics(makeRun(), [], 2000);

    expect(metrics).toEqual({
      durationMs: undefined,
      ttftMs: undefined,
      ttfrtMs: undefined,
      gapP50Ms: undefined,
      gapP95Ms: undefined,
      gapMaxMs: undefined,
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    });
  });

  it('leaves durationMs undefined while the run is still running', () => {
    const metrics = computeMetrics(makeRun({ startedAtMs: 100 }), [], 2000);

    expect(metrics.durationMs).toBeUndefined();
  });

  it('computes durationMs as endedAtMs - startedAtMs once the run ended', () => {
    const run = makeRun({ startedAtMs: 100, endedAtMs: 450, outcome: 'finished' });

    expect(computeMetrics(run, [], 2000).durationMs).toBe(350);
  });

  it('measures ttftMs and ttfrtMs from the run start to the first content delta of each kind', () => {
    const run = makeRun({ startedAtMs: 100 });
    const records = [
      rec(1, 110, { type: 'REASONING_MESSAGE_START', messageId: 'rm1', role: 'assistant' }),
      rec(2, 140, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'th' }),
      rec(3, 180, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'ink' }),
      rec(4, 200, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
      rec(5, 260, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      rec(6, 300, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' }),
    ];

    const metrics = computeMetrics(run, records, 2000);

    expect(metrics.ttfrtMs).toBe(40);
    expect(metrics.ttftMs).toBe(160);
  });

  it('leaves ttftMs and ttfrtMs undefined when no content delta of that kind arrived', () => {
    const records = [rec(1, 10, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' })];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.ttftMs).toBeUndefined();
    expect(metrics.ttfrtMs).toBeUndefined();
  });

  it('computes nearest-rank gap percentiles over consecutive TEXT_MESSAGE_CONTENT events', () => {
    // content arrivals: 100, 150, 250, 400, 900  ->  gaps [50, 100, 150, 500]
    // sorted ascending: [50, 100, 150, 500], N = 4
    //   p50 rank = ceil(0.50 * 4) = 2 -> 100   (linear interpolation would say 125)
    //   p95 rank = ceil(0.95 * 4) = 4 -> 500
    //   max                                -> 500
    const records = [
      rec(1, 100, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      rec(2, 150, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' }),
      rec(3, 250, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'c' }),
      rec(4, 400, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'd' }),
      rec(5, 900, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'e' }),
    ];

    const metrics = computeMetrics(makeRun(), records, 100000);

    expect(metrics.gapP50Ms).toBe(100);
    expect(metrics.gapP95Ms).toBe(500);
    expect(metrics.gapMaxMs).toBe(500);
  });

  it('leaves every gap metric undefined with fewer than two content events', () => {
    const one = computeMetrics(
      makeRun(),
      [rec(1, 30, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' })],
      2000,
    );

    expect(one.ttftMs).toBe(30);
    expect(one.gapP50Ms).toBeUndefined();
    expect(one.gapP95Ms).toBeUndefined();
    expect(one.gapMaxMs).toBeUndefined();

    const none = computeMetrics(makeRun(), [], 2000);

    expect(none.gapP50Ms).toBeUndefined();
    expect(none.gapP95Ms).toBeUndefined();
    expect(none.gapMaxMs).toBeUndefined();
  });

  it('reports stalls strictly longer than the threshold while a message is open', () => {
    // m1 alive at 10 (start), 20 (delta), 500 (delta), 520 (end) -> 10, 480, 20
    //   only 480 > 100, so exactly one stall from 20 to 500
    // m2 alive at 600 (start), 700 (delta) -> 100, which is NOT strictly greater than 100
    const run = makeRun({
      startedAtMs: 0,
      messages: new Map([
        ['m1', message({ messageId: 'm1', content: 'ab', startedAtMs: 10, endedAtMs: 520, closed: true, contentSeqs: [2, 3] })],
        ['m2', message({ messageId: 'm2', content: 'c', startedAtMs: 600, contentSeqs: [5] })],
      ]),
    });
    const records = [
      rec(1, 10, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
      rec(2, 20, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      rec(3, 500, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' }),
      rec(4, 520, { type: 'TEXT_MESSAGE_END', messageId: 'm1' }),
      rec(5, 600, { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' }),
      rec(6, 700, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'c' }),
    ];

    const metrics = computeMetrics(run, records, 100);

    expect(metrics.stalls).toEqual([{ startMs: 20, endMs: 500, messageId: 'm1' }]);
    expect(metrics.gapMaxMs).toBe(480);
  });

  it('keys tool latency by toolCallId and omits tool calls with no result', () => {
    const records = [
      rec(1, 10, { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }),
      rec(2, 20, { type: 'TOOL_CALL_START', toolCallId: 'tc2', toolCallName: 'lookup' }),
      rec(3, 40, { type: 'TOOL_CALL_END', toolCallId: 'tc1' }),
      rec(4, 95, { type: 'TOOL_CALL_RESULT', messageId: 'x', toolCallId: 'tc1', content: 'ok' }),
      rec(5, 99, { type: 'TOOL_CALL_END', toolCallId: 'tc2' }),
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.toolLatencyMs).toEqual({ tc1: 85 });
  });

  it('counts state patches and their serialized delta bytes', () => {
    const d1 = [{ op: 'replace', path: '/count', value: 2 }];
    const d2 = [{ op: 'add', path: '/items/-', value: 'x' }, { op: 'remove', path: '/tmp' }];
    const records = [
      rec(1, 10, { type: 'STATE_SNAPSHOT', snapshot: { count: 1 } }),
      rec(2, 20, { type: 'STATE_DELTA', delta: d1 }),
      rec(3, 30, { type: 'STATE_DELTA', delta: d2 }),
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.statePatchCount).toBe(2);
    expect(metrics.statePatchBytes).toBe(JSON.stringify(d1).length + JSON.stringify(d2).length);
  });

  it('counts events by type and sums raw bytes, skipping unparseable and raw-less records', () => {
    const raw1 = {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'hi',
      rawEvent: { padding: '0123456789' },
    };
    const records: CaptureRecord[] = [
      {
        kind: 'event',
        seq: 1,
        tMs: 10,
        connId: 'c1',
        raw: raw1,
        event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' },
        issues: [],
      },
      { kind: 'event', seq: 2, tMs: 20, connId: 'c1', raw: 'garbage', event: null, issues: [] },
      {
        kind: 'event',
        seq: 3,
        tMs: 30,
        connId: 'c1',
        raw: undefined,
        event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '!' },
        issues: [],
      },
      {
        kind: 'event',
        seq: 4,
        tMs: 40,
        connId: 'c1',
        raw: { type: 'RUN_FINISHED' },
        event: { type: 'RUN_FINISHED' },
        issues: [],
      },
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.eventCountByType).toEqual({ TEXT_MESSAGE_CONTENT: 2, RUN_FINISHED: 1 });
    expect(metrics.totalStreamBytes).toBe(
      JSON.stringify(raw1).length + JSON.stringify('garbage').length + JSON.stringify({ type: 'RUN_FINISHED' }).length,
    );
  });

  it('excludes keepalives from eventCountByType but still counts their bytes in totalStreamBytes', () => {
    // requirements §5.4: keepalives are recorded, never counted as events. Their bytes are
    // real bytes on the wire, so they still count toward totalStreamBytes.
    const records: CaptureRecord[] = [
      rec(1, 10, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
      keepalive(2, 20, ''),
      rec(3, 30, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      keepalive(4, 9000, 'ping'),
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.eventCountByType).toEqual({ TEXT_MESSAGE_START: 1, TEXT_MESSAGE_CONTENT: 1 });
    expect(metrics.totalStreamBytes).toBe(
      records.reduce((sum, r) => sum + JSON.stringify(r.raw).length, 0),
    );
  });
});
