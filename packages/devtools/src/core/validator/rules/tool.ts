import { makeIssue } from '../../model/types';
import type { RunValidationState, ValidatorRule } from '../types';

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

/**
 * Whether the arguments this rule would judge are still the ones the agent emitted.
 *
 * `toolArgs` owns `TOOL_CALL_ARGS.delta` and `TOOL_CALL_CHUNK.delta` (see `jsonl/redact.ts`),
 * so once it is redacted `ToolCallRecord.argsText` is a run of `«redacted: N chars»`
 * placeholders. No per-event placeholder can compose into valid JSON across an arbitrary split
 * of a JSON string, so the accumulated text is guaranteed not to parse — for every capture,
 * clean or broken alike. A verdict that is fixed in advance is not evidence about anything.
 */
function argsAreEvidence(state: RunValidationState): boolean {
  return !state.run.redacted.includes('toolArgs');
}

/**
 * `tool-args-not-json`, and the one condition under which it must not be raised.
 *
 * Redaction removes evidence, so this rule weakens its claim to match. When the capture's own
 * header declares `toolArgs` redacted, the accumulated arguments are placeholders and whether
 * the AGENT's arguments parsed is no longer knowable from this file — so the rule declines to
 * answer rather than answering "no" every time.
 *
 * SUPPRESSED, not downgraded. The recipient of a redacted bug report is the person this
 * protects, and they read the issue badge and the row tints; an issue of any severity there is
 * a claim about the capture, and the honest count of claims this file supports is zero. The
 * FACT that the bytes in hand do not parse is not lost — the Messages tab reports the call as
 * `arguments redacted` and says whether they parsed cannot be known from this file, which is
 * where the arguments themselves are on screen.
 *
 * The cost is deliberate and it is the redactor's, not this rule's: a run whose arguments
 * really were malformed reports nothing here once `toolArgs` is redacted, because the file no
 * longer holds the evidence for it. That is why the export panel says to leave the group
 * unticked when the bug IS the arguments.
 */
export const toolArgsNotJsonRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_END') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  const call = state.run.toolCalls.get(toolCallId);
  if (call === undefined) return [];
  if (call.argsText.trim() === '') return [];
  if (!argsAreEvidence(state)) return [];
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
