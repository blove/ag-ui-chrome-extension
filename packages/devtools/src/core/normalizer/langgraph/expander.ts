/**
 * LangGraph Platform → synthetic AG-UI events, one connection at a time (spec L6–L10, L12).
 *
 * The raw LangGraph frame is what is captured, stored and exported; this only decides how it
 * reads in the run model. Each `push` returns the AG-UI events one wire frame stands for, which
 * the run builder folds exactly as it folds AG-UI — so every tab works unchanged — while the
 * frame itself stays the Timeline row. The events are synthetic, so the AG-UI validator does not
 * see them (L12); what can actually be wrong with a LangGraph stream is reported here instead.
 */
import { routeHint } from '../../detect/classifier';
import { makeIssue, type AguiEvent, type Issue, type IssueCode } from '../../model/types';
import { contentParts, isObject, roleOf, toolCallChunks, type ToolCallChunk } from './messages';
import { isKnownMode, parseEventName } from './names';

export interface LangGraphRequest {
  readonly method?: string;
  readonly url?: string;
  /** The decoded request body: `{assistant_id, input, stream_mode, …}`. */
  readonly input?: unknown;
}

export interface LangGraphFrame {
  readonly seq: number;
  readonly sseEvent?: string;
  /** The parsed payload — `CaptureRecord.raw`, never `.event`, which is null for an array. */
  readonly payload: unknown;
}

export interface LangGraphExpansion {
  events: AguiEvent[];
  issues: Issue[];
}

export interface LangGraphFinish extends LangGraphExpansion {
  /** The run stopped at an interrupt: the builder records the outcome `interrupted` (L9). */
  interrupted: boolean;
}

export interface LangGraphExpander {
  push(frame: LangGraphFrame): LangGraphExpansion;
  /** Called once, when the connection closes. `seq` anchors any issue it raises. */
  finish(seq: number): LangGraphFinish;
}

interface OpenToolCall {
  readonly toolCallId: string;
  /** The id came from the wire, not L8's `messageId#index` stand-in. */
  readonly wireId: boolean;
  name?: string;
  argsText: string;
  /** A TOOL_CALL_END has been emitted and nothing has been added to the call since. */
  ended: boolean;
}

/** A message's tool calls. Kept past the message's close, so a message that reopens continues them. */
interface MessageCalls {
  /** Every call this message started, in start order: each gets a TOOL_CALL_END at close. */
  readonly calls: OpenToolCall[];
  /** The call a chunk's `index` currently continues. */
  readonly toolCalls: Map<number, OpenToolCall>;
}

interface OpenMessage extends MessageCalls {
  readonly messageId: string;
  textOpen: boolean;
  reasoningOpen: boolean;
}

/** What a cumulative `messages/partial` stream has already said, per message. */
interface PartialState {
  text: string;
  reasoning: string;
  readonly toolArgs: Map<number, string>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function reasoningIdOf(messageId: string): string {
  return `${messageId}:reasoning`;
}

/** The part of `after` that extends `before`, or `undefined` when it does not extend it. */
function suffix(before: string, after: string): string | undefined {
  return after.startsWith(before) ? after.slice(before.length) : undefined;
}

/**
 * Whether the request asked for `values`. An omitted `stream_mode` is the server default, `['values']`.
 * No body — a join stream's GET, or a body that did not decode — says nothing: a join stream carries
 * whatever modes the run was created with, so it is not assumed to include `values`.
 */
function valuesRequested(input: unknown): boolean {
  if (!isObject(input)) return false;
  const mode = input.stream_mode;
  if (mode === undefined || mode === null) return true;
  if (typeof mode === 'string') return mode === 'values';
  if (Array.isArray(mode)) return mode.length === 0 || mode.includes('values');
  return true;
}

export function createLangGraphExpander(connId: string, request: LangGraphRequest): LangGraphExpander {
  const hint =
    request.url !== undefined && request.method !== undefined
      ? routeHint(request.url, request.method)
      : undefined;
  const route = hint?.kind === 'langgraph-run' ? hint : undefined;

  let runId = '';
  let threadId = '';
  let started = false;
  let errored = false;
  let interrupted = false;
  /**
   * A top-level `values`, `messages/complete` or `checkpoints` — the set after which Threadplane's
   * bridge treats a close as a normal finish — arrived after the last message chunk.
   */
  let settled = false;
  let open: OpenMessage | undefined;
  /**
   * Per message id. Two branches of one step can stream their LLM calls interleaved: each switch
   * of id closes the open message, and its tool calls must carry on under the same ids when it reopens.
   */
  const messageCalls = new Map<string, MessageCalls>();
  /** Ended calls whose args are not yet checked: a close on a switch of id may be mid-call. */
  const uncheckedArgs = new Set<OpenToolCall>();
  /** A wire id that arrived after its call started under L8's synthetic id → that synthetic id. */
  const syntheticIds = new Map<string, string>();
  const partials = new Map<string, PartialState>();
  const startedToolCalls = new Set<string>();
  const resultedToolCalls = new Set<string>();

  function issue(out: LangGraphExpansion, code: IssueCode, message: string, seq: number): void {
    out.issues.push(makeIssue(code, message, seq));
  }

  function start(out: LangGraphExpansion, meta: Record<string, unknown> | undefined): void {
    started = true;
    runId = str(meta?.run_id) ?? route?.runId ?? `lg:${connId}`;
    threadId = route?.threadId ?? str(meta?.thread_id) ?? '';
    out.events.push({ type: 'RUN_STARTED', runId, threadId });
  }

  function ensureStarted(out: LangGraphExpansion, seq: number): void {
    if (started) return;
    issue(
      out,
      'lg-no-metadata',
      'The stream sent no metadata event before its first event, so this run id is synthesized',
      seq,
    );
    start(out, undefined);
  }

  function closeReasoning(out: LangGraphExpansion, message: OpenMessage): void {
    if (!message.reasoningOpen) return;
    out.events.push({ type: 'REASONING_MESSAGE_END', messageId: reasoningIdOf(message.messageId) });
    message.reasoningOpen = false;
  }

  function checkArgs(out: LangGraphExpansion, seq: number, calls: Iterable<OpenToolCall>): void {
    for (const call of [...calls]) {
      if (!uncheckedArgs.delete(call) || call.argsText.trim() === '') continue;
      try {
        JSON.parse(call.argsText);
      } catch {
        issue(out, 'lg-tool-args-invalid', `Tool call ${call.toolCallId} streamed arguments that are not valid JSON`, seq);
      }
    }
  }

  /**
   * Close the open message. `switched` is a close because a chunk for another message arrived:
   * this message may resume, so its calls' args are checked later, when the message ends for good.
   */
  function closeMessage(out: LangGraphExpansion, seq: number, switched = false): void {
    const message = open;
    if (message === undefined) return;
    open = undefined;
    closeReasoning(out, message);
    for (const call of message.calls) {
      if (call.ended) continue;
      call.ended = true;
      uncheckedArgs.add(call);
      out.events.push({ type: 'TOOL_CALL_END', toolCallId: call.toolCallId });
    }
    if (!switched) checkArgs(out, seq, message.calls);
    if (message.textOpen) out.events.push({ type: 'TEXT_MESSAGE_END', messageId: message.messageId });
  }

  /** The step, the run or the stream is over: close the open message and check every call's args. */
  function settle(out: LangGraphExpansion, seq: number): void {
    closeMessage(out, seq);
    checkArgs(out, seq, uncheckedArgs);
  }

  function foldToolChunk(out: LangGraphExpansion, message: OpenMessage, chunk: ToolCallChunk): void {
    let call = message.toolCalls.get(chunk.index);
    // `toolCallChunks` falls back to array position when `index` is absent, so two parallel calls
    // in two chunks can both arrive as index 0. A different `id` at an occupied index is a new
    // call; the old one stays open until the message closes. A call under L8's synthetic id is
    // never split this way: its first real id is the same call's, arriving late.
    if (call === undefined || (call.wireId && chunk.id !== undefined && chunk.id !== call.toolCallId)) {
      // L8: AG-UI needs the id at START. A call whose first chunk has none keeps this synthetic
      // id for its whole life — re-keying mid-call would split one call into two.
      call = {
        toolCallId: chunk.id ?? `${message.messageId}#${chunk.index}`,
        wireId: chunk.id !== undefined,
        argsText: '',
        ended: false,
      };
      if (chunk.name !== undefined) call.name = chunk.name;
      message.toolCalls.set(chunk.index, call);
      message.calls.push(call);
      startedToolCalls.add(call.toolCallId);
      closeReasoning(out, message);
      out.events.push({
        type: 'TOOL_CALL_START',
        toolCallId: call.toolCallId,
        ...(call.name !== undefined ? { toolCallName: call.name } : {}),
        parentMessageId: message.messageId,
      });
    } else if (call.name === undefined && chunk.name !== undefined) {
      call.ended = false;
      // AG-UI names a call only at START. A name that arrives late re-states it; the builder
      // folds a repeated START as an update, and no AG-UI rule sees synthetic events (L12).
      call.name = chunk.name;
      out.events.push({
        type: 'TOOL_CALL_START',
        toolCallId: call.toolCallId,
        toolCallName: call.name,
        parentMessageId: message.messageId,
      });
    }
    if (!call.wireId && chunk.id !== undefined && !syntheticIds.has(chunk.id)) {
      // The tool's result will name the call by this id: it must find the call's synthetic one.
      syntheticIds.set(chunk.id, call.toolCallId);
    }
    if (chunk.args !== '') {
      call.ended = false;
      call.argsText += chunk.args;
      out.events.push({ type: 'TOOL_CALL_ARGS', toolCallId: call.toolCallId, delta: chunk.args });
    }
  }

  /** One assistant delta: new text, new reasoning and new tool-call fragments for one message. */
  function foldAiDelta(
    out: LangGraphExpansion,
    seq: number,
    messageId: string | undefined,
    text: string,
    reasoning: string,
    tools: readonly ToolCallChunk[],
    last: boolean,
  ): void {
    // L7: only a chunk that carries something opens (or switches) a message. The Python server's
    // stream opens with one empty chunk under an id no later chunk uses.
    if (text !== '' || reasoning !== '' || tools.length > 0) {
      if (open !== undefined && messageId !== undefined && messageId !== open.messageId) {
        closeMessage(out, seq, true);
      }
      if (open === undefined) {
        const id = messageId ?? `lg-msg-${seq}`;
        let calls = messageCalls.get(id);
        if (calls === undefined) {
          calls = { calls: [], toolCalls: new Map() };
          messageCalls.set(id, calls);
        }
        open = { messageId: id, textOpen: false, reasoningOpen: false, ...calls };
      }
      const message = open;
      if (reasoning !== '') {
        const reasoningId = reasoningIdOf(message.messageId);
        if (!message.reasoningOpen) {
          out.events.push({ type: 'REASONING_MESSAGE_START', messageId: reasoningId, role: 'assistant' });
          message.reasoningOpen = true;
        }
        out.events.push({ type: 'REASONING_MESSAGE_CONTENT', messageId: reasoningId, delta: reasoning });
      }
      if (text !== '') {
        closeReasoning(out, message);
        if (!message.textOpen) {
          out.events.push({ type: 'TEXT_MESSAGE_START', messageId: message.messageId, role: 'assistant' });
          message.textOpen = true;
        }
        out.events.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: message.messageId, delta: text });
      }
      for (const chunk of tools) foldToolChunk(out, message, chunk);
    }
    if (!last) return;
    // The end of one message closes that message only: with interleaved branches, another may be open.
    if (messageId === undefined || messageId === open?.messageId) {
      closeMessage(out, seq);
    } else {
      const calls = messageCalls.get(messageId);
      if (calls !== undefined) checkArgs(out, seq, calls.calls);
    }
  }

  function toolResult(
    out: LangGraphExpansion,
    seq: number,
    message: Record<string, unknown>,
    onlyIfStartedHere: boolean,
  ): void {
    const wireId = str(message.tool_call_id);
    if (wireId === undefined) return;
    const toolCallId = syntheticIds.get(wireId) ?? wireId;
    if (resultedToolCalls.has(toolCallId)) return;
    // `values.messages` is the whole thread's history: a result for a call an EARLIER run made is
    // not this run's. A `messages` tool chunk, by contrast, was produced by this run.
    if (onlyIfStartedHere && !startedToolCalls.has(toolCallId)) return;
    // The call's TOOL_CALL_END precedes its result. Only its own message is closed: another branch's
    // message may be streaming.
    if (open !== undefined && open.calls.some((call) => call.toolCallId === toolCallId)) closeMessage(out, seq);
    resultedToolCalls.add(toolCallId);
    out.events.push({
      type: 'TOOL_CALL_RESULT',
      messageId: str(message.id) ?? `${toolCallId}:result`,
      toolCallId,
      content: message.content,
      role: 'tool',
    });
  }

  function foldTupleMessage(out: LangGraphExpansion, seq: number, message: Record<string, unknown>): void {
    const role = roleOf(message.type);
    if (role === 'tool') {
      toolResult(out, seq, message, false);
      return;
    }
    // Human and system messages are the request's input, which the run already carries.
    if (role !== 'ai') return;
    const parts = contentParts(message.content);
    foldAiDelta(
      out,
      seq,
      str(message.id),
      parts.text,
      parts.reasoning,
      toolCallChunks(message.tool_call_chunks),
      message.chunk_position === 'last',
    );
  }

  /** A cumulative message (`messages/partial`, `messages/complete`) folded as the delta it adds. */
  function foldCumulativeMessage(
    out: LangGraphExpansion,
    seq: number,
    message: Record<string, unknown>,
    complete: boolean,
  ): void {
    const role = roleOf(message.type);
    if (role === 'tool') {
      toolResult(out, seq, message, false);
      return;
    }
    if (role !== 'ai') return;
    const id = str(message.id) ?? open?.messageId ?? `lg-msg-${seq}`;
    const previous = partials.get(id) ?? { text: '', reasoning: '', toolArgs: new Map<number, string>() };
    const parts = contentParts(message.content);
    const text = suffix(previous.text, parts.text);
    const reasoning = suffix(previous.reasoning, parts.reasoning);
    let regressed = text === undefined || reasoning === undefined;
    const tools: ToolCallChunk[] = [];
    for (const chunk of toolCallChunks(message.tool_call_chunks)) {
      const before = previous.toolArgs.get(chunk.index);
      const delta = suffix(before ?? '', chunk.args);
      if (delta === undefined) regressed = true;
      // A call not seen before must reach `foldToolChunk` even with no new args, to be STARTed.
      if (before === undefined || (delta ?? '') !== '') tools.push({ ...chunk, args: delta ?? '' });
      previous.toolArgs.set(chunk.index, chunk.args);
    }
    if (regressed) {
      issue(
        out,
        complete ? 'lg-complete-mismatch' : 'lg-partial-regressed',
        complete
          ? `messages/complete for ${id} does not extend what its partials streamed`
          : `A messages/partial for ${id} does not extend the previous one: messages/partial is cumulative`,
        seq,
      );
    }
    previous.text = parts.text;
    previous.reasoning = parts.reasoning;
    partials.set(id, previous);
    foldAiDelta(out, seq, id, text ?? '', reasoning ?? '', tools, complete);
  }

  function undecodable(out: LangGraphExpansion, name: string, seq: number): void {
    issue(out, 'lg-undecodable', `The "${name}" event's payload is not the shape that event carries`, seq);
  }

  function push(frame: LangGraphFrame): LangGraphExpansion {
    const out: LangGraphExpansion = { events: [], issues: [] };
    const { seq, payload } = frame;
    const name = frame.sseEvent ?? '';
    const { mode, namespace } = parseEventName(frame.sseEvent);

    if (mode === 'metadata' && namespace.length === 0) {
      if (started) return out;
      if (!isObject(payload)) undecodable(out, name, seq);
      start(out, isObject(payload) ? payload : undefined);
      return out;
    }

    ensureStarted(out, seq);
    // An error ends the run; anything after it is recorded as it arrived and folds nothing.
    if (errored) return out;
    // PR 3 folds subgraph events into child runs (L11). Until then they are recorded, raw.
    if (namespace.length > 0) return out;
    if (!isKnownMode(mode)) {
      issue(out, 'lg-unknown-event', `"${name}" is not an event LangGraph Platform emits`, seq);
      return out;
    }

    switch (mode) {
      case 'messages': {
        const message = Array.isArray(payload) ? (payload[0] as unknown) : undefined;
        if (!isObject(message)) {
          undecodable(out, name, seq);
          break;
        }
        settled = false;
        foldTupleMessage(out, seq, message);
        break;
      }
      case 'messages/partial':
      case 'messages/complete': {
        if (!Array.isArray(payload)) {
          undecodable(out, name, seq);
          break;
        }
        const complete = mode === 'messages/complete';
        settled = complete;
        for (const message of payload) {
          if (isObject(message)) foldCumulativeMessage(out, seq, message, complete);
        }
        break;
      }
      case 'values': {
        if (!isObject(payload)) {
          undecodable(out, name, seq);
          break;
        }
        // A values event marks a completed step: whatever message was streaming is done.
        settle(out, seq);
        settled = true;
        if ('__interrupt__' in payload) interrupted = true;
        // `fromEntries` defines each key as an own property, so a `__proto__` key stays data.
        const snapshot: Record<string, unknown> = Object.fromEntries(
          Object.entries(payload).filter(([key]) => key !== '__interrupt__'),
        );
        // A values event whose only key is `__interrupt__` is an interrupt, not a state.
        if (Object.keys(snapshot).length > 0) out.events.push({ type: 'STATE_SNAPSHOT', snapshot });
        if (Array.isArray(snapshot.messages)) {
          for (const message of snapshot.messages) {
            if (isObject(message) && roleOf(message.type) === 'tool') toolResult(out, seq, message, true);
          }
        }
        break;
      }
      case 'updates': {
        if (!isObject(payload)) {
          undecodable(out, name, seq);
          break;
        }
        for (const node of Object.keys(payload)) {
          if (node === '__interrupt__') {
            interrupted = true;
            continue;
          }
          // An update arrives once its node has run, so the step starts and finishes together.
          out.events.push({ type: 'STEP_STARTED', stepName: node });
          out.events.push({ type: 'STEP_FINISHED', stepName: node });
        }
        break;
      }
      case 'custom':
        out.events.push({ type: 'CUSTOM', name: 'langgraph.custom', value: payload });
        break;
      case 'error': {
        settle(out, seq);
        errored = true;
        const message = isObject(payload)
          ? (str(payload.message) ?? str(payload.error) ?? 'error')
          : (str(payload) ?? 'error');
        const code = isObject(payload) ? str(payload.error) : undefined;
        out.events.push({ type: 'RUN_ERROR', message, ...(code !== undefined ? { code } : {}) });
        break;
      }
      case 'checkpoints':
        settled = true;
        break;
      default:
        // messages/metadata, debug, tasks, events, tools, feedback: shown raw in Timeline only.
        break;
    }
    return out;
  }

  function finish(seq: number): LangGraphFinish {
    const out: LangGraphExpansion = { events: [], issues: [] };
    if (!started) return { ...out, interrupted: false };
    settle(out, seq);
    if (errored) return { ...out, interrupted: false };
    if (!interrupted && valuesRequested(request.input) && !settled) {
      // Threadplane's bridge reads this exact condition as "did not finish normally": the stream
      // stopped mid-answer. No RUN_FINISHED, so the run builder records the outcome `aborted`.
      issue(
        out,
        'lg-no-final-values',
        'The stream closed without a final values event, although the request asked for values',
        seq,
      );
      return { ...out, interrupted: false };
    }
    out.events.push({ type: 'RUN_FINISHED', runId, threadId });
    return { ...out, interrupted };
  }

  return { push, finish };
}
