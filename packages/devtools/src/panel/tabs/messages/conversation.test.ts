import { describe, it, expect } from 'vitest';
import type {
  ReconstructedMessage,
  Run,
  RunMetrics,
  ToolCallRecord,
} from '../../../core/model/types';
import { conversation, toolArgsStatus } from './conversation';

function emptyMetrics(): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
  };
}

function message(partial: Partial<ReconstructedMessage> & { messageId: string }): ReconstructedMessage {
  return {
    kind: 'text',
    content: '',
    startedAtMs: 0,
    closed: true,
    contentSeqs: [],
    ...partial,
  };
}

function toolCall(partial: Partial<ToolCallRecord> & { toolCallId: string }): ToolCallRecord {
  return { argsText: '', startedAtMs: 0, closed: true, ...partial };
}

function run(partial: Partial<Run> = {}): Run {
  return {
    runId: 'r_1',
    threadId: 't_1',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: emptyMetrics(),
    issues: [],
    recordSeqs: [],
    ...partial,
  };
}

function idsOf(run: Run): string[] {
  return conversation(run).map((item) => {
    if (item.kind === 'input') return `input:${item.message.role}`;
    if (item.kind === 'message') return item.message.messageId;
    return item.call.toolCallId;
  });
}

describe('conversation (M1)', () => {
  it('orders messages and tool calls together by startedAtMs', () => {
    const built = run({
      messages: new Map([
        ['m_1', message({ messageId: 'm_1', startedAtMs: 40 })],
        ['m_2', message({ messageId: 'm_2', startedAtMs: 320 })],
      ]),
      toolCalls: new Map([['tc_1', toolCall({ toolCallId: 'tc_1', startedAtMs: 110 })]]),
    });

    expect(idsOf(built)).toEqual(['m_1', 'tc_1', 'm_2']);
  });

  it('keeps wire order when two items start at the same instant', () => {
    // The maps are insertion-ordered by the run builder, which is wire order. A tie has no
    // better answer available — the model records no seq for a tool call — so the sort must at
    // least be stable rather than reordering on a re-render.
    const built = run({
      messages: new Map([['m_1', message({ messageId: 'm_1', startedAtMs: 100 })]]),
      toolCalls: new Map([
        ['tc_a', toolCall({ toolCallId: 'tc_a', startedAtMs: 100 })],
        ['tc_b', toolCall({ toolCallId: 'tc_b', startedAtMs: 100 })],
      ]),
    });

    expect(idsOf(built)).toEqual(['m_1', 'tc_a', 'tc_b']);
    expect(idsOf(built)).toEqual(idsOf(built));
  });

  it('puts the turns the app sent ahead of everything the server streamed', () => {
    const built = run({
      input: { messages: [{ role: 'system', content: 'be helpful' }, { role: 'user', content: 'hi' }] },
      messages: new Map([['m_1', message({ messageId: 'm_1', startedAtMs: 40 })]]),
    });

    expect(idsOf(built)).toEqual(['input:system', 'input:user', 'm_1']);
  });

  it('yields nothing at all for a run that carried neither input nor output', () => {
    expect(conversation(run())).toEqual([]);
  });

  it('includes a reasoning message, which M3 collapses but never drops', () => {
    const built = run({
      messages: new Map([
        ['m_r', message({ messageId: 'm_r', kind: 'reasoning', startedAtMs: 10 })],
        ['m_1', message({ messageId: 'm_1', startedAtMs: 20 })],
      ]),
    });

    expect(idsOf(built)).toEqual(['m_r', 'm_1']);
  });
});

describe('toolArgsStatus (M2)', () => {
  it('reports arguments that parsed', () => {
    const status = toolArgsStatus(
      toolCall({ toolCallId: 'tc_1', argsText: '{"city":"Paris"}', args: { city: 'Paris' } }),
    );

    expect(status).toBe('parsed');
  });

  it('reports arguments that never parsed — the bug this tab exists to make obvious', () => {
    const status = toolArgsStatus(
      toolCall({ toolCallId: 'tc_1', argsText: '{"city":"Paris"', argsParseError: 'Unexpected end' }),
    );

    expect(status).toBe('failed');
  });

  it('reports a still-open tool call as streaming rather than as a parse failure', () => {
    /*
     * The run builder only parses at TOOL_CALL_END, so an open call has `args` undefined and
     * `argsParseError` undefined — indistinguishable from a clean call by those fields alone.
     * Half of a JSON object is SUPPOSED not to parse yet. Calling that a failure would put a
     * red verdict on every tool call in a live capture, and a warning that is usually wrong
     * teaches the reader to ignore the one that matters.
     */
    const status = toolArgsStatus(
      toolCall({ toolCallId: 'tc_1', argsText: '{"city":"Par', closed: false }),
    );

    expect(status).toBe('streaming');
  });

  it('reports a call that streamed no arguments as none, not as a failure', () => {
    expect(toolArgsStatus(toolCall({ toolCallId: 'tc_1', argsText: '' }))).toBe('none');
    expect(toolArgsStatus(toolCall({ toolCallId: 'tc_1', argsText: '  \n ' }))).toBe('none');
  });

  it('reports a closed call with arguments and no recorded error as parsed', () => {
    // `args` is legitimately `undefined` when the arguments were the literal `null`, so the
    // verdict reads the recorded error rather than the presence of a parsed value.
    const status = toolArgsStatus(toolCall({ toolCallId: 'tc_1', argsText: 'null', args: null }));

    expect(status).toBe('parsed');
  });
});
