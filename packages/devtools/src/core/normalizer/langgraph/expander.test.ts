import { describe, expect, it } from 'vitest';

import type { AguiEvent } from '../../model/types';
import { createLangGraphExpander, type LangGraphExpander, type LangGraphRequest } from './expander';

const REQUEST = {
  method: 'POST',
  url: 'http://localhost:2024/threads/t-1/runs/stream',
  input: { assistant_id: 'agent', stream_mode: ['values', 'messages-tuple'] },
};

function ai(id: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return [{ type: 'AIMessageChunk', id, content, tool_call_chunks: [], ...extra }, { langgraph_node: 'agent' }];
}

function drive(frames: Array<[string, unknown]>, request: LangGraphRequest = REQUEST): {
  expander: LangGraphExpander;
  events: AguiEvent[];
  codes: Array<[string, number]>;
} {
  const expander = createLangGraphExpander('c1', request);
  const events: AguiEvent[] = [];
  const codes: Array<[string, number]> = [];
  frames.forEach(([sseEvent, payload], i) => {
    const out = expander.push({ seq: i + 1, sseEvent, payload });
    events.push(...out.events);
    codes.push(...out.issues.map((issue): [string, number] => [issue.code, issue.seq]));
  });
  return { expander, events, codes };
}

const types = (events: AguiEvent[]): string[] => events.map((event) => event.type);

describe('createLangGraphExpander', () => {
  it('opens the run from metadata, with the thread id from the URL', () => {
    const { events } = drive([['metadata', { run_id: 'r-1', attempt: 1 }]]);
    expect(events).toEqual([{ type: 'RUN_STARTED', runId: 'r-1', threadId: 't-1' }]);
  });

  it('opens a message only on a chunk with content, so the empty resp_ chunk invents nothing (L7)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('resp_x', [])],
      ['messages', ai('lc_1', [{ type: 'text', text: 'Hi' }])],
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'lc_1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'lc_1', delta: 'Hi' },
    ]);
  });

  it('streams reasoning as its own message and closes it when the text starts', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [{ type: 'reasoning', summary: [{ text: 'Hmm' }] }])],
      ['messages', ai('m1', [{ type: 'text', text: 'Yes' }])],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    expect(types(events)).toEqual([
      'RUN_STARTED',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(events[1]).toEqual({ type: 'REASONING_MESSAGE_START', messageId: 'm1:reasoning', role: 'assistant' });
  });

  it('streams tool-call args by index, and names a late-named call with a second START (L8)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, args: '{"a"' }] })],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, name: 'f', args: ':1}' }] })],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'm1#0', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'm1#0', delta: '{"a"' },
      { type: 'TOOL_CALL_START', toolCallId: 'm1#0', toolCallName: 'f', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'm1#0', delta: ':1}' },
      { type: 'TOOL_CALL_END', toolCallId: 'm1#0' },
    ]);
  });

  it('splits parallel calls that omit index on a change of id, and closes both', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ id: 'a', name: 'f', args: '{}' }] })],
      ['messages', ai('m1', [], { tool_call_chunks: [{ id: 'b', name: 'g', args: '{}' }] })],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    const calls = events.filter((event) => event.type === 'TOOL_CALL_START' || event.type === 'TOOL_CALL_END');
    expect(calls).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'f', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: 'g', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_END', toolCallId: 'a' },
      { type: 'TOOL_CALL_END', toolCallId: 'b' },
    ]);
  });

  it('keeps the synthetic id when a later chunk of the same call carries a real id (L8)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, args: '{' }] })],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_1', args: '}' }] })],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'm1#0', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'm1#0', delta: '{' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'm1#0', delta: '}' },
      { type: 'TOOL_CALL_END', toolCallId: 'm1#0' },
    ]);
  });

  it('finishes normally after a final values event', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', 'Hi')],
      ['values', { messages: [] }],
    ]);
    const done = expander.finish(3);
    expect(done.interrupted).toBe(false);
    expect(done.issues).toEqual([]);
    expect(done.events).toEqual([{ type: 'RUN_FINISHED', runId: 'r-1', threadId: 't-1' }]);
  });

  it('does not finish a run that asked for values and closed without them', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values', { messages: [] }],
      ['messages', ai('m1', 'Hi')],
    ]);
    const done = expander.finish(3);
    expect(types(done.events)).toEqual(['TEXT_MESSAGE_END']);
    expect(done.issues.map((issue) => [issue.code, issue.seq])).toEqual([['lg-no-final-values', 3]]);
  });

  it('finishes a run that did not ask for values, since there is nothing to wait for', () => {
    const { expander } = drive(
      [['metadata', { run_id: 'r-1' }], ['messages', ai('m1', 'Hi')]],
      { ...REQUEST, input: { stream_mode: ['messages-tuple'] } },
    );
    expect(types(expander.finish(2).events)).toEqual(['TEXT_MESSAGE_END', 'RUN_FINISHED']);
  });

  it('reports an interrupt as interrupted, not finished (L9)', () => {
    const { expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values', { __interrupt__: [{ value: 'approve?' }] }],
    ]);
    const done = expander.finish(2);
    expect(done.interrupted).toBe(true);
    expect(types(done.events)).toEqual(['RUN_FINISHED']);
  });

  it('ends on an error event, and folds nothing after it', () => {
    const { events, expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', 'Hi')],
      ['error', { error: 'ValueError', message: 'boom' }],
      ['values', { x: 1 }],
    ]);
    expect(types(events).slice(-2)).toEqual(['TEXT_MESSAGE_END', 'RUN_ERROR']);
    expect(events.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'boom', code: 'ValueError' });
    expect(expander.finish(4).events).toEqual([]);
  });

  it('synthesizes a run, and says so, when the first frame is not metadata', () => {
    const { events, codes } = drive([['messages', ai('m1', 'Hi')]]);
    expect(events[0]).toEqual({ type: 'RUN_STARTED', runId: 'lg:c1', threadId: 't-1' });
    expect(codes).toEqual([['lg-no-metadata', 1]]);
  });

  it('turns a cumulative partial into deltas', () => {
    const partial = (content: string): unknown => [{ type: 'ai', id: 'm1', content }];
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages/partial', partial('He')],
      ['messages/partial', partial('Hello')],
    ]);
    expect(events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').map((event) => event.delta)).toEqual([
      'He',
      'llo',
    ]);
  });

  it('records a namespaced event raw, folding nothing (PR 3 folds subgraphs)', () => {
    const { events, codes } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages|research:abc', ai('s1', 'sub')],
    ]);
    expect(types(events)).toEqual(['RUN_STARTED']);
    expect(codes).toEqual([]);
  });

  it('continues an interleaved message\'s tool call under its id, and ends only the message that ended', () => {
    const { events, codes, expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_a', name: 'f', args: '{"x"' }] })],
      ['messages', ai('m2', 'Hello')],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, args: ':1}' }] })],
      ['messages', ai('m2', [], { chunk_position: 'last' })],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
    ]);
    const done = expander.finish(7);
    expect(events.slice(1)).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'call_a', toolCallName: 'f', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'call_a', delta: '{"x"' },
      { type: 'TOOL_CALL_END', toolCallId: 'call_a' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'Hello' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm2' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'call_a', delta: ':1}' },
      // m2's last chunk arrived while m1 was open: m1 stays open until its own last chunk.
      { type: 'TOOL_CALL_END', toolCallId: 'call_a' },
    ]);
    // The args are checked once the call has ended for good, not at the mid-call switch.
    expect(codes).toEqual([]);
    expect(done.issues.filter((issue) => issue.code === 'lg-tool-args-invalid')).toEqual([]);
  });

  it('still reports invalid args of a call whose message was switched away from and never resumed', () => {
    const { codes, expander } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_a', name: 'f', args: '{"x"' }] })],
      ['messages', ai('m2', 'Hello')],
    ]);
    expect(codes).toEqual([]);
    const argIssues = expander.finish(4).issues.filter((issue) => issue.code === 'lg-tool-args-invalid');
    expect(argIssues.map((issue) => issue.seq)).toEqual([4]);
  });

  it('gives a tool result the synthetic id of the call its wire id arrived late on (L8)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, args: '{' }] })],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_1', args: '}' }] })],
      ['messages', [{ type: 'tool', id: 't1', tool_call_id: 'call_1', content: 'ok' }, {}]],
    ]);
    expect(events.slice(-2)).toEqual([
      { type: 'TOOL_CALL_END', toolCallId: 'm1#0' },
      { type: 'TOOL_CALL_RESULT', messageId: 't1', toolCallId: 'm1#0', content: 'ok', role: 'tool' },
    ]);
  });

  it('finds a values tool result for a synthetic-id call by its late wire id (L8)', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, args: '{}' }] })],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_1', args: '' }] })],
      ['values', { messages: [{ type: 'tool', id: 't1', tool_call_id: 'call_1', content: 'ok' }] }],
    ]);
    expect(events.at(-1)).toEqual({
      type: 'TOOL_CALL_RESULT',
      messageId: 't1',
      toolCallId: 'm1#0',
      content: 'ok',
      role: 'tool',
    });
  });

  it('does not close another branch\'s streaming message for a tool result', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['messages', ai('m1', [], { tool_call_chunks: [{ index: 0, id: 'call_a', name: 'f', args: '{}' }] })],
      ['messages', ai('m1', [], { chunk_position: 'last' })],
      ['messages', ai('m2', 'Hel')],
      ['messages', [{ type: 'tool', id: 't1', tool_call_id: 'call_a', content: 'ok' }, {}]],
      ['messages', ai('m2', 'lo')],
    ]);
    expect(types(events).slice(4)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_CONTENT',
    ]);
  });

  it('keeps a __proto__ key in a values snapshot as data', () => {
    const { events } = drive([
      ['metadata', { run_id: 'r-1' }],
      ['values', JSON.parse('{"__proto__": {"messages": [1]}, "a": 1}') as unknown],
    ]);
    const snapshot = events[1]?.snapshot as Record<string, unknown>;
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.keys(snapshot)).toEqual(['__proto__', 'a']);
    expect(snapshot.messages).toBeUndefined();
  });

  it('finishes a join stream, whose GET says nothing about stream_mode, without asking for values', () => {
    const { expander } = drive([['metadata', { run_id: 'r-9' }], ['messages', ai('m1', 'Hi')]], {
      method: 'GET',
      url: 'http://localhost:2024/threads/t-1/runs/r-9/stream',
    });
    const done = expander.finish(3);
    expect(done.issues).toEqual([]);
    expect(done.events.at(-1)).toEqual({ type: 'RUN_FINISHED', runId: 'r-9', threadId: 't-1' });
  });

  it('starts a join stream that attached mid-run under the URL\'s run id, with no lg-no-metadata', () => {
    const { events, codes } = drive([['messages', ai('m1', 'Hi')]], {
      method: 'GET',
      url: 'http://localhost:2024/threads/t-1/runs/r-9/stream',
    });
    expect(events[0]).toEqual({ type: 'RUN_STARTED', runId: 'r-9', threadId: 't-1' });
    expect(codes).toEqual([]);
  });

  it('still raises lg-no-metadata on a run-creation route, which always sends metadata first', () => {
    const { events, codes } = drive([['messages', ai('m1', 'Hi')]], {
      ...REQUEST,
      url: 'http://localhost:2024/runs/stream',
    });
    expect(events[0]).toEqual({ type: 'RUN_STARTED', runId: 'lg:c1', threadId: '' });
    expect(codes).toEqual([['lg-no-metadata', 1]]);
  });

  it('names an unnamed frame "message", as SSE dispatches it and as metrics and export count it', () => {
    const expander = createLangGraphExpander('c1', REQUEST);
    expander.push({ seq: 1, sseEvent: 'metadata', payload: { run_id: 'r-1' } });
    const out = expander.push({ seq: 2, payload: { a: 1 } });
    expect(out.issues.map((raised) => [raised.code, raised.message])).toEqual([
      ['lg-unknown-event', '"message" is not an event LangGraph Platform emits'],
    ]);
  });
});
