import { makeIssue } from '../../model/types';
import type { ValidatorRule } from '../types';

const CONTENT_TYPES = new Set(['TEXT_MESSAGE_CONTENT', 'REASONING_MESSAGE_CONTENT']);

export const emptyTextDeltaRule: ValidatorRule = (event, record, state) => {
  if (!CONTENT_TYPES.has(event.type)) return [];
  if (event.delta !== '') return [];
  return [
    makeIssue('empty-text-delta', `${event.type} has an empty delta`, record.seq, {
      runId: state.run.runId,
    }),
  ];
};

export const unopenedMessageIdRule: ValidatorRule = (event, record, state) => {
  let open: Set<string> | undefined;
  if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_END') {
    open = state.openTextMessages;
  } else if (
    event.type === 'REASONING_MESSAGE_CONTENT' ||
    event.type === 'REASONING_MESSAGE_END'
  ) {
    open = state.openReasoningMessages;
  }
  if (open === undefined) return [];

  const messageId = typeof event.messageId === 'string' ? event.messageId : undefined;
  if (messageId === undefined) return [];
  if (open.has(messageId)) return [];

  return [
    makeIssue(
      'unopened-message-id',
      `${event.type} references messageId "${messageId}" which is not open`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};

export const concurrentTextMessagesRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TEXT_MESSAGE_START') return [];
  if (state.openTextMessages.size === 0) return [];
  return [
    makeIssue(
      'concurrent-text-messages',
      `TEXT_MESSAGE_START while ${state.openTextMessages.size} text message(s) are still open`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};
