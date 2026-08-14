import type { AguiEvent, CaptureRecord, Issue } from '../model/types';
import { makeIssue } from '../model/types';
import type { RunValidationState, ValidatorRule } from './types';
import {
  eventAfterTerminalRule,
  eventBeforeRunStartedRule,
  runStartedWithoutInputRule,
  unbalancedStepsRule,
} from './rules/lifecycle';
import {
  concurrentTextMessagesRule,
  emptyTextDeltaRule,
  unopenedMessageIdRule,
} from './rules/text';
import {
  toolArgsNotJsonRule,
  toolResultBeforeEndRule,
  unopenedToolCallIdRule,
} from './rules/tool';
import { deltaBeforeSnapshotRule, statePatchFailedRule } from './rules/state';
import { deprecatedEventRule } from './rules/stream';

export type { RunValidationState, ValidatorRule } from './types';

export const RULES: readonly ValidatorRule[] = [
  eventBeforeRunStartedRule,
  eventAfterTerminalRule,
  runStartedWithoutInputRule,
  unbalancedStepsRule,
  concurrentTextMessagesRule,
  emptyTextDeltaRule,
  unopenedMessageIdRule,
  unopenedToolCallIdRule,
  toolResultBeforeEndRule,
  toolArgsNotJsonRule,
  deltaBeforeSnapshotRule,
  statePatchFailedRule,
  deprecatedEventRule,
];

export function runRules(
  event: AguiEvent,
  record: CaptureRecord,
  state: RunValidationState,
): Issue[] {
  const issues: Issue[] = [];
  for (const rule of RULES) {
    issues.push(...rule(event, record, state));
  }
  return issues;
}

/**
 * Rules that can only fire once the connection carrying the run has closed.
 * Called by the run builder from `closeConnection`, not per event.
 *
 * These are exactly the four codes with no owning record. Each anchors to the seq of the
 * LAST record attributed to the run — `recordSeqs.at(-1) ?? 0`, since indexing with
 * `[length - 1]` is `number | undefined` under `noUncheckedIndexedAccess` and does not
 * compile — and carries the close timestamp in `Issue.tMs`. `keepalive-gap` is NOT one of
 * them: a keepalive is itself a record, so Task 13c anchors it to that record's own seq.
 */
export function finalizeRules(state: RunValidationState, tMs: number): Issue[] {
  const { run } = state;
  const seq = run.recordSeqs.at(-1) ?? 0;
  const at = { runId: run.runId, tMs };
  const issues: Issue[] = [];

  if (!state.terminated) {
    issues.push(
      makeIssue(
        'run-never-terminated',
        'Connection closed without RUN_FINISHED or RUN_ERROR',
        seq,
        at,
      ),
    );
  }

  for (const messageId of state.openTextMessages) {
    issues.push(
      makeIssue(
        'unclosed-message',
        `Text message "${messageId}" was never closed with TEXT_MESSAGE_END`,
        seq,
        at,
      ),
    );
  }

  for (const messageId of state.openReasoningMessages) {
    issues.push(
      makeIssue(
        'unclosed-message',
        `Reasoning message "${messageId}" was never closed with REASONING_MESSAGE_END`,
        seq,
        at,
      ),
    );
  }

  for (const toolCallId of state.openToolCalls) {
    issues.push(
      makeIssue(
        'unclosed-tool-call',
        `Tool call "${toolCallId}" was never closed with TOOL_CALL_END`,
        seq,
        at,
      ),
    );
  }

  for (const stepName of state.openSteps) {
    issues.push(
      makeIssue('unbalanced-steps', `Step "${stepName}" was still open at run end`, seq, at),
    );
  }

  return issues;
}
