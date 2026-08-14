import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../../model/types';
import type { RunValidationState } from '../types';
import {
  concurrentTextMessagesRule,
  emptyTextDeltaRule,
  unopenedMessageIdRule,
} from './text';

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

describe('emptyTextDeltaRule', () => {
  it('flags an empty TEXT_MESSAGE_CONTENT delta', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '' };

    expect(emptyTextDeltaRule(event, makeRecord(event, 6), state)).toEqual([
      {
        code: 'empty-text-delta',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT has an empty delta',
        seq: 6,
        runId: 'run-1',
      },
    ]);
  });

  it('flags an empty REASONING_MESSAGE_CONTENT delta', () => {
    const state = makeState({ openReasoningMessages: new Set(['r1']) });
    const event: AguiEvent = { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '' };

    expect(emptyTextDeltaRule(event, makeRecord(event, 7), state)).toEqual([
      {
        code: 'empty-text-delta',
        severity: 'error',
        message: 'REASONING_MESSAGE_CONTENT has an empty delta',
        seq: 7,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts a non-empty delta and ignores other types', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const good: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };
    const other: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '' };

    expect(emptyTextDeltaRule(good, makeRecord(good), state)).toEqual([]);
    expect(emptyTextDeltaRule(other, makeRecord(other), state)).toEqual([]);
  });
});

describe('unopenedMessageIdRule', () => {
  it('flags TEXT_MESSAGE_CONTENT for an unopened messageId', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'x' };

    expect(unopenedMessageIdRule(event, makeRecord(event, 2), state)).toEqual([
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT references messageId "m2" which is not open',
        seq: 2,
        runId: 'run-1',
      },
    ]);
  });

  it('flags TEXT_MESSAGE_END for an unopened messageId', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_END', messageId: 'm1' };

    expect(unopenedMessageIdRule(event, makeRecord(event, 3), state)).toEqual([
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_END references messageId "m1" which is not open',
        seq: 3,
        runId: 'run-1',
      },
    ]);
  });

  it('checks reasoning events against the reasoning open set', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };

    expect(unopenedMessageIdRule(event, makeRecord(event, 4), state)).toEqual([
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'REASONING_MESSAGE_CONTENT references messageId "m1" which is not open',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts open ids and ignores unrelated types', () => {
    const state = makeState({
      openTextMessages: new Set(['m1']),
      openReasoningMessages: new Set(['r1']),
    });
    const text: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };
    const reasoning: AguiEvent = { type: 'REASONING_MESSAGE_END', messageId: 'r1' };
    const start: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm9', role: 'assistant' };

    expect(unopenedMessageIdRule(text, makeRecord(text), state)).toEqual([]);
    expect(unopenedMessageIdRule(reasoning, makeRecord(reasoning), state)).toEqual([]);
    expect(unopenedMessageIdRule(start, makeRecord(start), state)).toEqual([]);
  });

  it('ignores a non-string messageId (shape-check owns that)', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_END', messageId: 7 };

    expect(unopenedMessageIdRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('concurrentTextMessagesRule', () => {
  it('warns when a text message starts while another is open', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' };

    expect(concurrentTextMessagesRule(event, makeRecord(event, 5), state)).toEqual([
      {
        code: 'concurrent-text-messages',
        severity: 'warning',
        message: 'TEXT_MESSAGE_START while 1 text message(s) are still open',
        seq: 5,
        runId: 'run-1',
      },
    ]);
  });

  it('is silent for the first text message', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' };

    expect(concurrentTextMessagesRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores reasoning starts', () => {
    const state = makeState({ openReasoningMessages: new Set(['r1']) });
    const event: AguiEvent = { type: 'REASONING_MESSAGE_START', messageId: 'r2', role: 'assistant' };

    expect(concurrentTextMessagesRule(event, makeRecord(event), state)).toEqual([]);
  });
});
