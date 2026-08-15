import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../model/types';
import type { RunValidationState } from './types';
import { RULES, finalizeRules, runRules } from './index';

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
    redacted: [],
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

describe('RULES', () => {
  it('holds every per-event rule', () => {
    expect(RULES).toHaveLength(13);
    expect(RULES.every((rule) => typeof rule === 'function')).toBe(true);
  });
});

describe('runRules', () => {
  it('returns no issues for a clean event', () => {
    const state = makeState({
      run: makeRun({ input: { messages: [] } }),
      openTextMessages: new Set(['m1']),
    });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' };

    expect(runRules(event, makeRecord(event), state)).toEqual([]);
  });

  it('concatenates issues from every rule in RULES order', () => {
    const state = makeState({ terminated: true });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '' };

    expect(runRules(event, makeRecord(event, 5), state)).toEqual([
      {
        code: 'event-after-terminal',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT arrived after the run reached a terminal event',
        seq: 5,
        runId: 'run-1',
      },
      {
        code: 'empty-text-delta',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT has an empty delta',
        seq: 5,
        runId: 'run-1',
      },
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT references messageId "m1" which is not open',
        seq: 5,
        runId: 'run-1',
      },
    ]);
  });

  it('does not mutate the validation state', () => {
    const state = makeState({
      openTextMessages: new Set(['m1']),
      openToolCalls: new Set(['tc1']),
      openSteps: ['plan'],
    });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' };

    runRules(event, makeRecord(event), state);

    expect([...state.openTextMessages]).toEqual(['m1']);
    expect([...state.openReasoningMessages]).toEqual([]);
    expect([...state.openToolCalls]).toEqual(['tc1']);
    expect([...state.endedToolCalls]).toEqual([]);
    expect(state.openSteps).toEqual(['plan']);
    expect(state.terminated).toBe(false);
    expect(state.sawSnapshot).toBe(false);
    expect(state.run.issues).toEqual([]);
  });
});

describe('finalizeRules', () => {
  it('returns nothing for a clean, terminated run', () => {
    const state = makeState({
      run: makeRun({ recordSeqs: [1, 2, 3], outcome: 'finished' }),
      terminated: true,
    });

    expect(finalizeRules(state, 900)).toEqual([]);
  });

  it('reports a run that never terminated', () => {
    const state = makeState({ run: makeRun({ recordSeqs: [1, 2, 3] }) });

    expect(finalizeRules(state, 900)).toEqual([
      {
        code: 'run-never-terminated',
        severity: 'error',
        message: 'Connection closed without RUN_FINISHED or RUN_ERROR',
        seq: 3,
        tMs: 900,
        runId: 'run-1',
      },
    ]);
  });

  it('reports unclosed messages, tool calls and steps in order', () => {
    const state = makeState({
      run: makeRun({ recordSeqs: [1, 2, 3, 4] }),
      openTextMessages: new Set(['m1']),
      openReasoningMessages: new Set(['r1']),
      openToolCalls: new Set(['tc1']),
      openSteps: ['plan'],
      terminated: true,
    });

    expect(finalizeRules(state, 1200)).toEqual([
      {
        code: 'unclosed-message',
        severity: 'warning',
        message: 'Text message "m1" was never closed with TEXT_MESSAGE_END',
        seq: 4,
        tMs: 1200,
        runId: 'run-1',
      },
      {
        code: 'unclosed-message',
        severity: 'warning',
        message: 'Reasoning message "r1" was never closed with REASONING_MESSAGE_END',
        seq: 4,
        tMs: 1200,
        runId: 'run-1',
      },
      {
        code: 'unclosed-tool-call',
        severity: 'warning',
        message: 'Tool call "tc1" was never closed with TOOL_CALL_END',
        seq: 4,
        tMs: 1200,
        runId: 'run-1',
      },
      {
        code: 'unbalanced-steps',
        severity: 'warning',
        message: 'Step "plan" was still open at run end',
        seq: 4,
        tMs: 1200,
        runId: 'run-1',
      },
    ]);
  });

  it('uses seq 0 when the run recorded no events', () => {
    const state = makeState({ terminated: true, openToolCalls: new Set(['tc1']) });

    expect(finalizeRules(state, 10)).toEqual([
      {
        code: 'unclosed-tool-call',
        severity: 'warning',
        message: 'Tool call "tc1" was never closed with TOOL_CALL_END',
        seq: 0,
        tMs: 10,
        runId: 'run-1',
      },
    ]);
  });

  it('does not mutate the validation state', () => {
    const state = makeState({
      run: makeRun({ recordSeqs: [1] }),
      openTextMessages: new Set(['m1']),
      openSteps: ['plan'],
    });

    finalizeRules(state, 500);

    expect([...state.openTextMessages]).toEqual(['m1']);
    expect(state.openSteps).toEqual(['plan']);
    expect(state.terminated).toBe(false);
    expect(state.run.issues).toEqual([]);
  });
});
