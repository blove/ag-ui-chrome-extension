import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../../model/types';
import { ORPHANED_RUN_ID } from '../../model/types';
import type { RunValidationState } from '../types';
import {
  eventAfterTerminalRule,
  eventBeforeRunStartedRule,
  runStartedWithoutInputRule,
  unbalancedStepsRule,
} from './lifecycle';

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

describe('eventBeforeRunStartedRule', () => {
  it('flags a non-RUN_STARTED event on the orphaned run', () => {
    const state = makeState({
      run: makeRun({ runId: ORPHANED_RUN_ID, outcome: 'orphaned' }),
    });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' };

    expect(eventBeforeRunStartedRule(event, makeRecord(event, 3), state)).toEqual([
      {
        code: 'event-before-run-started',
        severity: 'error',
        message: 'TEXT_MESSAGE_START arrived before any RUN_STARTED',
        seq: 3,
        runId: ORPHANED_RUN_ID,
      },
    ]);
  });

  it('does not flag RUN_STARTED itself', () => {
    const state = makeState({
      run: makeRun({ runId: ORPHANED_RUN_ID, outcome: 'orphaned' }),
    });
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    expect(eventBeforeRunStartedRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('does not flag events on a real run', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' };

    expect(eventBeforeRunStartedRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('eventAfterTerminalRule', () => {
  it('flags any event once the run has terminated', () => {
    const state = makeState({ terminated: true });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };

    expect(eventAfterTerminalRule(event, makeRecord(event, 9), state)).toEqual([
      {
        code: 'event-after-terminal',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT arrived after the run reached a terminal event',
        seq: 9,
        runId: 'run-1',
      },
    ]);
  });

  it('flags a second terminal event too', () => {
    const state = makeState({ terminated: true });
    const event: AguiEvent = { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' };

    expect(eventAfterTerminalRule(event, makeRecord(event, 10), state)).toEqual([
      {
        code: 'event-after-terminal',
        severity: 'error',
        message: 'RUN_FINISHED arrived after the run reached a terminal event',
        seq: 10,
        runId: 'run-1',
      },
    ]);
  });

  it('is silent while the run is live', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' };

    expect(eventAfterTerminalRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('unbalancedStepsRule', () => {
  it('flags STEP_FINISHED with no matching open step', () => {
    const state = makeState({ openSteps: ['plan'] });
    const event: AguiEvent = { type: 'STEP_FINISHED', stepName: 'execute' };

    expect(unbalancedStepsRule(event, makeRecord(event, 4), state)).toEqual([
      {
        code: 'unbalanced-steps',
        severity: 'warning',
        message: 'STEP_FINISHED "execute" has no matching open STEP_STARTED',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts STEP_FINISHED matching an open step', () => {
    const state = makeState({ openSteps: ['plan', 'execute'] });
    const event: AguiEvent = { type: 'STEP_FINISHED', stepName: 'plan' };

    expect(unbalancedStepsRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores STEP_STARTED and a non-string stepName', () => {
    const state = makeState();
    const started: AguiEvent = { type: 'STEP_STARTED', stepName: 'plan' };
    const broken: AguiEvent = { type: 'STEP_FINISHED', stepName: 42 };

    expect(unbalancedStepsRule(started, makeRecord(started), state)).toEqual([]);
    expect(unbalancedStepsRule(broken, makeRecord(broken), state)).toEqual([]);
  });
});

describe('runStartedWithoutInputRule', () => {
  it('reports RUN_STARTED with no captured input', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    expect(runStartedWithoutInputRule(event, makeRecord(event, 1), state)).toEqual([
      {
        code: 'run-started-without-input',
        severity: 'info',
        message: 'RUN_STARTED has no captured request input; reproducing this run will be harder',
        seq: 1,
        runId: 'run-1',
      },
    ]);
  });

  it('is silent when input was captured', () => {
    const state = makeState({ run: makeRun({ input: { messages: [] } }) });
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    expect(runStartedWithoutInputRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('is silent for other event types', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'STEP_STARTED', stepName: 'plan' };

    expect(runStartedWithoutInputRule(event, makeRecord(event), state)).toEqual([]);
  });
});
