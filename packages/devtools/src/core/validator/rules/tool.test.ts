import { describe, it, expect } from 'vitest';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../jsonl/redact';
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

/**
 * Redaction removes evidence, so the rule that judged that evidence weakens its claim.
 *
 * `toolArgs` owns both args-bearing deltas, so once it is redacted `argsText` is a run of
 * `«redacted: N chars»` placeholders and the verdict is decided before the capture is even
 * read. The recipient of a shared bug report is who this protects: they see the badge, the run
 * heading and the timeline tint, and none of them may accuse their agent of a defect the
 * redactor introduced.
 */
describe('toolArgsNotJsonRule under redaction', () => {
  const REDACTED_ARGS = '«redacted: 16 chars»«redacted: 16 chars»';
  const end: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

  function stateWith(argsText: string, redacted: RedactionGroup[]): RunValidationState {
    return makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall(argsText)]]), redacted }),
      openToolCalls: new Set(['tc1']),
    });
  }

  it('declines to claim the arguments are not JSON when toolArgs was redacted', () => {
    const state = stateWith(REDACTED_ARGS, ['toolArgs']);

    expect(JSON.parse.bind(null, REDACTED_ARGS)).toThrow();
    expect(toolArgsNotJsonRule(end, makeRecord(end, 12), state)).toEqual([]);
  });

  it('declines under every group set that includes toolArgs, not just that one group', () => {
    for (const groups of [
      ['toolArgs'],
      ['text', 'toolArgs'],
      [...ALL_REDACTION_GROUPS],
    ] satisfies RedactionGroup[][]) {
      expect(toolArgsNotJsonRule(end, makeRecord(end), stateWith(REDACTED_ARGS, groups))).toEqual(
        [],
      );
    }
  });

  it('still fires when some OTHER group was redacted — those leave the arguments intact', () => {
    // Redacting message text does not touch `TOOL_CALL_ARGS.delta`, so the arguments in hand are
    // still the agent's own and the claim is still supportable. Suppressing here would hide a
    // real protocol error in the exact bug report a user redacted their prose to be able to send.
    const groups = ALL_REDACTION_GROUPS.filter((group) => group !== 'toolArgs');
    const state = stateWith('{"q":', [...groups]);

    expect(toolArgsNotJsonRule(end, makeRecord(end, 12), state)).toEqual([
      {
        code: 'tool-args-not-json',
        severity: 'error',
        message: 'Accumulated arguments for tool call "tc1" are not valid JSON',
        seq: 12,
        runId: 'run-1',
      },
    ]);
  });

  it('withdraws the claim even when the arguments were genuinely broken before redaction', () => {
    // The deliberate cost, stated. `{"city": "Par` really is malformed, but the shared file no
    // longer holds it — every reader sees the same placeholder either way, so the file cannot
    // support the claim and the rule must not make it. This is why the export panel says to
    // leave `toolArgs` unticked when the bug IS the arguments.
    expect(toolArgsNotJsonRule(end, makeRecord(end), stateWith('{"city": "Par', []))).toHaveLength(1);
    expect(
      toolArgsNotJsonRule(end, makeRecord(end), stateWith('«redacted: 13 chars»', ['toolArgs'])),
    ).toEqual([]);
  });

  it('still says nothing about a redacted call that streamed no arguments at all', () => {
    // `redactString('')` returns the empty string by design, so "no arguments" survives
    // redaction — and an absent argument stream was never this rule's subject anyway.
    expect(toolArgsNotJsonRule(end, makeRecord(end), stateWith('', ['toolArgs']))).toEqual([]);
  });
});
