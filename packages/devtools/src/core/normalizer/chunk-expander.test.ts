import { describe, it, expect } from 'vitest';
import type { AguiEvent } from '../model/types';
import { createChunkExpanderState, expandChunk } from './chunk-expander';

describe('createChunkExpanderState', () => {
  it('starts with nothing open', () => {
    expect(createChunkExpanderState()).toEqual({});
  });
});

describe('expandChunk — non-chunk events', () => {
  it('passes a non-chunk event through unchanged', () => {
    const state = createChunkExpanderState();
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    const result = expandChunk(event, state, 1);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toBe(event);
    expect(result.issues).toEqual([]);
    expect(state).toEqual({});
  });

  it('passes a plain TEXT_MESSAGE_CONTENT through unchanged', () => {
    const state = createChunkExpanderState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' };

    const result = expandChunk(event, state, 2);

    expect(result.events).toEqual([event]);
    expect(result.issues).toEqual([]);
  });
});

describe('expandChunk — TEXT_MESSAGE_CHUNK', () => {
  it('opens a new message with START then CONTENT', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Hel' },
      state,
      1,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openTextMessageId).toBe('m1');
  });

  it('honours an explicit role on the opening chunk', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'x', role: 'assistant' },
      state,
      1,
    );

    expect(result.events[0]).toEqual({
      type: 'TEXT_MESSAGE_START',
      messageId: 'm1',
      role: 'assistant',
    });
  });

  it('emits START only when the opening chunk carries no delta', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1' }, state, 1);

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openTextMessageId).toBe('m1');
  });

  it('emits CONTENT only for a chunk with the same messageId', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Hel' }, state, 1);

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'lo' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('emits CONTENT only for a chunk that omits messageId while one is open', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Hel' }, state, 1);

    const result = expandChunk({ type: 'TEXT_MESSAGE_CHUNK', delta: 'lo' }, state, 2);

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('produces one START and two CONTENT across two same-id chunks', () => {
    const state = createChunkExpanderState();

    const first = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
      state,
      1,
    );
    const second = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'b' },
      state,
      2,
    );

    expect([...first.events, ...second.events]).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' },
    ]);
  });

  it('ends the open message before starting a new one mid-stream', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', delta: 'b' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'b' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openTextMessageId).toBe('m2');
  });

  it('emits an empty delta as CONTENT so the validator can flag it', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: '' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '' },
    ]);
  });

  it('reports chunk-missing-message-id when nothing is open', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'TEXT_MESSAGE_CHUNK', delta: 'orphan' }, state, 7);

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_CHUNK has no messageId and no message is currently open',
        seq: 7,
      },
    ]);
    expect(state.openTextMessageId).toBeUndefined();
  });
});

describe('expandChunk — REASONING_MESSAGE_CHUNK', () => {
  it('opens a reasoning message with START then CONTENT', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'think' },
      state,
      1,
    );

    expect(result.events).toEqual([
      { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'assistant' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openReasoningMessageId).toBe('r1');
    expect(state.openTextMessageId).toBeUndefined();
  });

  it('switches reasoning messages independently of text messages', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);
    expandChunk({ type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'x' }, state, 2);

    const result = expandChunk(
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r2', delta: 'y' },
      state,
      3,
    );

    expect(result.events).toEqual([
      { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
      { type: 'REASONING_MESSAGE_START', messageId: 'r2', role: 'assistant' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r2', delta: 'y' },
    ]);
    expect(state.openTextMessageId).toBe('m1');
    expect(state.openReasoningMessageId).toBe('r2');
  });

  it('reports chunk-missing-message-id for reasoning with nothing open', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'REASONING_MESSAGE_CHUNK', delta: 'x' }, state, 4);

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-message-id',
        severity: 'error',
        message:
          'REASONING_MESSAGE_CHUNK has no messageId and no message is currently open',
        seq: 4,
      },
    ]);
  });
});

describe('expandChunk — TOOL_CALL_CHUNK', () => {
  it('opens a new tool call with START then ARGS', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      {
        type: 'TOOL_CALL_CHUNK',
        toolCallId: 'tc1',
        toolCallName: 'search',
        delta: '{"q":',
      },
      state,
      1,
    );

    expect(result.events).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openToolCallId).toBe('tc1');
  });

  it('carries parentMessageId onto the synthesized START', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      {
        type: 'TOOL_CALL_CHUNK',
        toolCallId: 'tc1',
        toolCallName: 'search',
        parentMessageId: 'm1',
      },
      state,
      1,
    );

    expect(result.events).toEqual([
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'tc1',
        toolCallName: 'search',
        parentMessageId: 'm1',
      },
    ]);
  });

  it('emits ARGS only for a chunk with the same toolCallId', () => {
    const state = createChunkExpanderState();
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":' },
      state,
      1,
    );

    const result = expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', delta: '"x"}' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '"x"}' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('emits ARGS only for a chunk that omits toolCallId while one is open', () => {
    const state = createChunkExpanderState();
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search' },
      state,
      1,
    );

    const result = expandChunk({ type: 'TOOL_CALL_CHUNK', delta: '{}' }, state, 2);

    expect(result.events).toEqual([{ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{}' }]);
    expect(result.issues).toEqual([]);
  });

  it('ends the open tool call before starting a new one mid-stream', () => {
    const state = createChunkExpanderState();
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{}' },
      state,
      1,
    );

    const result = expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc2', toolCallName: 'fetch', delta: '{"u":1}' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TOOL_CALL_END', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_START', toolCallId: 'tc2', toolCallName: 'fetch' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tc2', delta: '{"u":1}' },
    ]);
    expect(state.openToolCallId).toBe('tc2');
  });

  it('reports chunk-missing-tool-call-name when opening without a name', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', delta: '{}' },
      state,
      5,
    );

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-tool-call-name',
        severity: 'error',
        message: 'TOOL_CALL_CHUNK opens tool call "tc1" without a toolCallName',
        seq: 5,
      },
    ]);
    expect(state.openToolCallId).toBeUndefined();
  });

  it('reports chunk-missing-tool-call-id when nothing is open', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'TOOL_CALL_CHUNK', delta: '{}' }, state, 6);

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-tool-call-id',
        severity: 'error',
        message: 'TOOL_CALL_CHUNK has no toolCallId and no tool call is currently open',
        seq: 6,
      },
    ]);
    expect(state.openToolCallId).toBeUndefined();
  });
});

describe('expandChunk — state across calls', () => {
  it('carries text, reasoning and tool state independently across calls', () => {
    const state = createChunkExpanderState();

    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);
    expandChunk({ type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'b' }, state, 2);
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{}' },
      state,
      3,
    );
    expandChunk({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }, state, 4);

    expect(state).toEqual({
      openTextMessageId: 'm1',
      openReasoningMessageId: 'r1',
      openToolCallId: 'tc1',
    });
  });
});
