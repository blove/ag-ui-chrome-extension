import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../../model/types';
import type { RunValidationState } from '../types';
import { deprecatedEventRule } from './stream';

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

describe('deprecatedEventRule', () => {
  it('warns on each deprecated THINKING_* event type', () => {
    const state = makeState();
    const types = [
      'THINKING_START',
      'THINKING_END',
      'THINKING_TEXT_MESSAGE_START',
      'THINKING_TEXT_MESSAGE_CONTENT',
      'THINKING_TEXT_MESSAGE_END',
    ];

    for (const [index, type] of types.entries()) {
      const event: AguiEvent = { type };
      expect(deprecatedEventRule(event, makeRecord(event, index + 1), state)).toEqual([
        {
          code: 'deprecated-event',
          severity: 'warning',
          message: `${type} is deprecated in the AG-UI protocol`,
          seq: index + 1,
          runId: 'run-1',
        },
      ]);
    }
  });

  it('is silent for current event types', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'REASONING_MESSAGE_START', messageId: 'r1' };

    expect(deprecatedEventRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('is silent for an unknown type (unknown-event-type is shape-check territory)', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'SOMETHING_NEW' };

    expect(deprecatedEventRule(event, makeRecord(event), state)).toEqual([]);
  });
});
