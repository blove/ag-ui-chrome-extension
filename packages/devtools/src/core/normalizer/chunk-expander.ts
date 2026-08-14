import type { AguiEvent, Issue } from '../model/types';
import { makeIssue } from '../model/types';
import { chunkKindOf } from '../events/table';

export interface ChunkExpanderState {
  openTextMessageId?: string;
  openReasoningMessageId?: string;
  openToolCallId?: string;
}

export interface ChunkExpansion {
  events: AguiEvent[];
  issues: Issue[];
}

export function createChunkExpanderState(): ChunkExpanderState {
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function expandMessageChunk(
  event: AguiEvent,
  state: ChunkExpanderState,
  seq: number,
  kind: 'text' | 'reasoning',
): ChunkExpansion {
  const prefix = kind === 'text' ? 'TEXT_MESSAGE' : 'REASONING_MESSAGE';
  const openId =
    kind === 'text' ? state.openTextMessageId : state.openReasoningMessageId;
  const messageId = asString(event.messageId);
  const delta = asString(event.delta);
  const role = asString(event.role) ?? 'assistant';

  const events: AguiEvent[] = [];
  let activeId = openId;

  if (messageId !== undefined && messageId !== openId) {
    if (openId !== undefined) {
      events.push({ type: `${prefix}_END`, messageId: openId });
    }
    events.push({ type: `${prefix}_START`, messageId, role });
    activeId = messageId;
  }

  if (activeId === undefined) {
    return {
      events: [],
      issues: [
        makeIssue(
          'chunk-missing-message-id',
          `${event.type} has no messageId and no message is currently open`,
          seq,
        ),
      ],
    };
  }

  if (delta !== undefined) {
    events.push({ type: `${prefix}_CONTENT`, messageId: activeId, delta });
  }

  if (kind === 'text') {
    state.openTextMessageId = activeId;
  } else {
    state.openReasoningMessageId = activeId;
  }

  return { events, issues: [] };
}

function expandToolChunk(
  event: AguiEvent,
  state: ChunkExpanderState,
  seq: number,
): ChunkExpansion {
  const toolCallId = asString(event.toolCallId);
  const toolCallName = asString(event.toolCallName);
  const parentMessageId = asString(event.parentMessageId);
  const delta = asString(event.delta);
  const openId = state.openToolCallId;

  const events: AguiEvent[] = [];

  if (toolCallId !== undefined && toolCallId !== openId) {
    if (toolCallName === undefined) {
      return {
        events: [],
        issues: [
          makeIssue(
            'chunk-missing-tool-call-name',
            `TOOL_CALL_CHUNK opens tool call "${toolCallId}" without a toolCallName`,
            seq,
          ),
        ],
      };
    }
    if (openId !== undefined) {
      events.push({ type: 'TOOL_CALL_END', toolCallId: openId });
    }
    const start: AguiEvent = { type: 'TOOL_CALL_START', toolCallId, toolCallName };
    if (parentMessageId !== undefined) {
      start.parentMessageId = parentMessageId;
    }
    events.push(start);
    state.openToolCallId = toolCallId;
  }

  const activeId = state.openToolCallId;
  if (activeId === undefined) {
    return {
      events: [],
      issues: [
        makeIssue(
          'chunk-missing-tool-call-id',
          'TOOL_CALL_CHUNK has no toolCallId and no tool call is currently open',
          seq,
        ),
      ],
    };
  }

  if (delta !== undefined) {
    events.push({ type: 'TOOL_CALL_ARGS', toolCallId: activeId, delta });
  }

  return { events, issues: [] };
}

export function expandChunk(
  event: AguiEvent,
  state: ChunkExpanderState,
  seq: number,
): ChunkExpansion {
  const kind = chunkKindOf(event.type);
  if (kind === undefined) {
    return { events: [event], issues: [] };
  }
  if (kind === 'tool') {
    return expandToolChunk(event, state, seq);
  }
  return expandMessageChunk(event, state, seq, kind);
}
