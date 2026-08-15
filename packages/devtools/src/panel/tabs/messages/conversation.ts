/**
 * The Messages tab's view of a run: what to show, and in what order (design decisions M1, M2).
 *
 * Pure and DOM-free, so the ordering rule and the arguments verdict are testable without
 * rendering anything — and so the component below is left with nothing to decide.
 */
import type { InputMessage } from '../../../core/model/input-messages';
import { inputMessages } from '../../../core/model/input-messages';
import type { ReconstructedMessage, Run, ToolCallRecord } from '../../../core/model/types';

/**
 * One row of the conversation.
 *
 * `input` is what the APP sent, read from the captured request body; the other two are what the
 * server streamed back. They are separate arms rather than one message type because the
 * distinction is the tab's entire subject — a turn that came from the page is not evidence about
 * the stream, and rendering them alike would let a reader attribute one to the other.
 */
export type ConversationItem =
  | { kind: 'input'; index: number; message: InputMessage }
  | { kind: 'message'; message: ReconstructedMessage }
  | { kind: 'tool'; call: ToolCallRecord };

/**
 * The verdict on a tool call's streamed arguments (M2).
 *
 * `streaming` is not a hedge. The run builder parses `argsText` at `TOOL_CALL_END` and only
 * there, so an open call carries neither `args` nor `argsParseError` — and half of a JSON object
 * is *supposed* not to parse yet. Reporting that as a failure would put a red verdict on every
 * tool call in a live capture.
 */
export type ToolArgsStatus = 'streaming' | 'none' | 'parsed' | 'failed';

export function toolArgsStatus(call: ToolCallRecord): ToolArgsStatus {
  if (!call.closed) return 'streaming';
  if (call.argsText.trim() === '') return 'none';
  // The recorded error, not the presence of `args`: arguments that are the literal `null` parse
  // successfully to `undefined`-looking data, and calling that a failure would be a lie.
  return call.argsParseError === undefined ? 'parsed' : 'failed';
}

/**
 * The run as a conversation: request turns first, then everything streamed, ordered by
 * `startedAtMs` with tool calls inline at their position (M1).
 *
 * Request turns lead because they are the request — they existed before the first frame came
 * back. They carry no timestamp of their own, so they are not sorted with the rest; they are
 * kept in body order, which is the order the app wrote them in.
 *
 * `Array.prototype.sort` is specified stable, and `Map` iterates in insertion order, which for
 * both maps is wire order. That is what decides a tie: two items with the same `startedAtMs`
 * cannot be ordered from the model — a `ToolCallRecord` records no seq — so the guarantee made
 * here is that the answer is at least the wire's own and does not change between renders.
 */
export function conversation(run: Run): ConversationItem[] {
  const streamed: ConversationItem[] = [
    ...[...run.messages.values()].map((message): ConversationItem => ({ kind: 'message', message })),
    ...[...run.toolCalls.values()].map((call): ConversationItem => ({ kind: 'tool', call })),
  ];
  streamed.sort((a, b) => startOf(a) - startOf(b));

  const requested = inputMessages(run.input).map(
    (message, index): ConversationItem => ({ kind: 'input', index, message }),
  );

  return [...requested, ...streamed];
}

function startOf(item: ConversationItem): number {
  if (item.kind === 'message') return item.message.startedAtMs;
  if (item.kind === 'tool') return item.call.startedAtMs;
  // Unreachable: request turns never enter the sort. Returning 0 rather than throwing keeps a
  // future caller that does pass one from taking the tab down.
  return 0;
}
