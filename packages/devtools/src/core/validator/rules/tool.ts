import { makeIssue } from '../../model/types';
import type { ValidatorRule } from '../types';

export const unopenedToolCallIdRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_ARGS' && event.type !== 'TOOL_CALL_END') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  if (state.openToolCalls.has(toolCallId)) return [];
  return [
    makeIssue(
      'unopened-tool-call-id',
      `${event.type} references toolCallId "${toolCallId}" which is not open`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};

export const toolResultBeforeEndRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_RESULT') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  if (state.endedToolCalls.has(toolCallId)) return [];
  return [
    makeIssue(
      'tool-result-before-end',
      `TOOL_CALL_RESULT references toolCallId "${toolCallId}" which has not ended`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};

export const toolArgsNotJsonRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_END') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  const call = state.run.toolCalls.get(toolCallId);
  if (call === undefined) return [];
  if (call.argsText.trim() === '') return [];
  try {
    JSON.parse(call.argsText);
    return [];
  } catch {
    return [
      makeIssue(
        'tool-args-not-json',
        `Accumulated arguments for tool call "${toolCallId}" are not valid JSON`,
        record.seq,
        { runId: state.run.runId },
      ),
    ];
  }
};
