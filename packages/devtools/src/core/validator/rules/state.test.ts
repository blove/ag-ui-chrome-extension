import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run, StateFrame } from '../../model/types';
import type { RunValidationState } from '../types';
import { deltaBeforeSnapshotRule, statePatchFailedRule } from './state';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
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

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { kind: 'event', seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

function snapshotFrame(value: unknown): StateFrame {
  return { seq: 1, tMs: 10, kind: 'snapshot', value };
}

describe('statePatchFailedRule', () => {
  it('flags the failing operation with its index and path', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [
        { op: 'add', path: '/b', value: 2 },
        { op: 'test', path: '/a', value: 99 },
      ],
    };

    expect(statePatchFailedRule(event, makeRecord(event, 14), state)).toEqual([
      {
        code: 'state-patch-failed',
        severity: 'error',
        message: 'STATE_DELTA op 1 (test /a) failed: test-failed',
        seq: 14,
        runId: 'run-1',
        path: '/a',
        opIndex: 1,
      },
    ]);
  });

  it('renders an op that is not a well-formed {op, path} pair without printing undefined', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    // `PatchResult.op` is `unknown`: this one comes back off the wire as a bare string.
    const event: AguiEvent = { type: 'STATE_DELTA', delta: ['add'] };

    expect(statePatchFailedRule(event, makeRecord(event, 15), state)).toEqual([
      {
        code: 'state-patch-failed',
        severity: 'error',
        message: 'STATE_DELTA op 0 (unrecognized op "add") failed: invalid-op',
        seq: 15,
        runId: 'run-1',
        opIndex: 0,
      },
    ]);
  });

  it('accepts a patch that applies cleanly', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'replace', path: '/a', value: 2 }],
    };

    expect(statePatchFailedRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores a non-array delta and non-STATE_DELTA events', () => {
    const state = makeState();
    const broken: AguiEvent = { type: 'STATE_DELTA', delta: { op: 'add' } };
    const snapshot: AguiEvent = { type: 'STATE_SNAPSHOT', snapshot: { a: 1 } };

    expect(statePatchFailedRule(broken, makeRecord(broken), state)).toEqual([]);
    expect(statePatchFailedRule(snapshot, makeRecord(snapshot), state)).toEqual([]);
  });
});

describe('deltaBeforeSnapshotRule', () => {
  it('warns on the first STATE_DELTA when no snapshot was seen', () => {
    const state = makeState();
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/a', value: 1 }],
    };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event, 2), state)).toEqual([
      {
        code: 'delta-before-snapshot',
        severity: 'warning',
        message: 'STATE_DELTA arrived before any STATE_SNAPSHOT',
        seq: 2,
        runId: 'run-1',
      },
    ]);
  });

  it('does not warn again once a state frame exists', () => {
    const state = makeState({
      run: makeRun({
        stateTimeline: [{ seq: 2, tMs: 20, kind: 'delta', value: { a: 1 }, patch: [] }],
      }),
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/b', value: 2 }],
    };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event, 3), state)).toEqual([]);
  });

  it('does not warn after a snapshot', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/b', value: 2 }],
    };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores non-STATE_DELTA events', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'STATE_SNAPSHOT', snapshot: { a: 1 } };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event), state)).toEqual([]);
  });
});
