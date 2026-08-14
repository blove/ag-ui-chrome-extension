import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run, ToolCallRecord } from '../../model/types';
import type { RunValidationState } from '../types';
import {
  toolArgsNotJsonRule,
  toolResultBeforeEndRule,
  unopenedToolCallIdRule,
} from './tool';

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

function makeToolCall(argsText: string): ToolCallRecord {
  return {
    toolCallId: 'tc1',
    toolCallName: 'search',
    argsText,
    startedAtMs: 0,
    closed: false,
  };
}

describe('unopenedToolCallIdRule', () => {
  it('flags TOOL_CALL_ARGS for an unopened toolCallId', () => {
    const state = makeState({ openToolCalls: new Set(['tc1']) });
    const event: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc2', delta: '{}' };

    expect(unopenedToolCallIdRule(event, makeRecord(event, 3), state)).toEqual([
      {
        code: 'unopened-tool-call-id',
        severity: 'error',
        message: 'TOOL_CALL_ARGS references toolCallId "tc2" which is not open',
        seq: 3,
        runId: 'run-1',
      },
    ]);
  });

  it('flags TOOL_CALL_END for an unopened toolCallId', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(unopenedToolCallIdRule(event, makeRecord(event, 4), state)).toEqual([
      {
        code: 'unopened-tool-call-id',
        severity: 'error',
        message: 'TOOL_CALL_END references toolCallId "tc1" which is not open',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts an open toolCallId and ignores other types', () => {
    const state = makeState({ openToolCalls: new Set(['tc1']) });
    const args: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{}' };
    const start: AguiEvent = { type: 'TOOL_CALL_START', toolCallId: 'tc9', toolCallName: 'x' };

    expect(unopenedToolCallIdRule(args, makeRecord(args), state)).toEqual([]);
    expect(unopenedToolCallIdRule(start, makeRecord(start), state)).toEqual([]);
  });
});

describe('toolResultBeforeEndRule', () => {
  it('flags a result for a tool call that never ended', () => {
    const state = makeState({ openToolCalls: new Set(['tc1']) });
    const event: AguiEvent = {
      type: 'TOOL_CALL_RESULT',
      messageId: 'm1',
      toolCallId: 'tc1',
      content: 'ok',
    };

    expect(toolResultBeforeEndRule(event, makeRecord(event, 8), state)).toEqual([
      {
        code: 'tool-result-before-end',
        severity: 'error',
        message: 'TOOL_CALL_RESULT references toolCallId "tc1" which has not ended',
        seq: 8,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts a result for an ended tool call', () => {
    const state = makeState({ endedToolCalls: new Set(['tc1']) });
    const event: AguiEvent = {
      type: 'TOOL_CALL_RESULT',
      messageId: 'm1',
      toolCallId: 'tc1',
      content: 'ok',
    };

    expect(toolResultBeforeEndRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores other event types', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolResultBeforeEndRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('toolArgsNotJsonRule', () => {
  it('flags accumulated args that do not parse at TOOL_CALL_END', () => {
    const state = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('{"q":')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolArgsNotJsonRule(event, makeRecord(event, 12), state)).toEqual([
      {
        code: 'tool-args-not-json',
        severity: 'error',
        message: 'Accumulated arguments for tool call "tc1" are not valid JSON',
        seq: 12,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts args that parse', () => {
    const state = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('{"q":"x"}')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolArgsNotJsonRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('treats empty and whitespace-only args as acceptable', () => {
    const empty = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const blank = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('   ')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolArgsNotJsonRule(event, makeRecord(event), empty)).toEqual([]);
    expect(toolArgsNotJsonRule(event, makeRecord(event), blank)).toEqual([]);
  });

  it('is silent when the tool call is unknown or the type is not TOOL_CALL_END', () => {
    const state = makeState();
    const end: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc9' };
    const args: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: 'nope' };

    expect(toolArgsNotJsonRule(end, makeRecord(end), state)).toEqual([]);
    expect(toolArgsNotJsonRule(args, makeRecord(args), state)).toEqual([]);
  });
});
