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

/** One synthetic event and the run it belongs to: the scope's runKey (S1), `''` for the top level. */
export interface ExpandedEvent {
  readonly runKey: string;
  readonly event: AguiEvent;
}

/** One issue and the run it is about (S3). */
export interface ExpandedIssue {
  readonly runKey: string;
  readonly issue: Issue;
}

export interface LangGraphExpansion {
  /** The run this frame belongs to (S3): its record, bytes and wire name go there. */
  runKey: string;
  events: ExpandedEvent[];
  /**
   * Usually the frame's run's. Not always: `lg-no-metadata` is the top-level run's, and closing a
   * scope this frame cut off (S5) checks that scope's tool calls.
   */
  issues: ExpandedIssue[];
}

export interface LangGraphFinish {
  events: ExpandedEvent[];
  /** Raised at close, each on its own run, anchored to that run's last frame on this connection. */
  issues: ExpandedIssue[];
  /** The runKeys whose runs stopped at an interrupt (S7): the builder records them `interrupted` (L9). */
  interrupted: string[];
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

/**
 * Everything the expander tracks for one namespace (L11, S4). The top level is the scope keyed
 * `''`; a subgraph's is its namespace joined by `|` (S1).
 */
interface Scope {
  readonly key: string;
  readonly runId: string;
  open: OpenMessage | undefined;
  /**
   * Per message id. Two branches of one step can stream their LLM calls interleaved: each switch
   * of id closes the open message, and its tool calls must carry on under the same ids when it reopens.
   */
  readonly messageCalls: Map<string, MessageCalls>;
  /** Ended calls whose args are not yet checked: a close on a switch of id may be mid-call. */
  readonly uncheckedArgs: Set<OpenToolCall>;
  /** A wire id that arrived after its call started under L8's synthetic id → that synthetic id. */
  readonly syntheticIds: Map<string, string>;
  readonly partials: Map<string, PartialState>;
  readonly startedToolCalls: Set<string>;
  readonly resultedToolCalls: Set<string>;
  /**
   * A `values`, `messages/complete` or `checkpoints` — the set after which Threadplane's bridge
   * treats a close as a normal finish — arrived after the last message chunk. Read for the top
   * level only (S6).
   */
  settled: boolean;
  interrupted: boolean;
  errored: boolean;
  /**
   * The seq of this connection's last frame that belongs to this scope's run (S3): what an issue
   * about the scope raised away from its own frames — at close, or when an error cuts it off —
   * anchors to. Absent for a scope that has sent no frame of its own (an ancestor a nested frame opened).
   */
  lastSeq: number | undefined;
}

/** How many namespace segments a scope key has: 0 for the top level. */
function depthOf(key: string): number {
  return key === '' ? 0 : key.split('|').length;
}

/** `key` and every ancestor's key, outermost (the top level, `''`) first. */
function lineageOf(key: string): string[] {
  if (key === '') return [''];
  const segments = key.split('|');
  return ['', ...segments.map((_, i) => segments.slice(0, i + 1).join('|'))];
}

/** Whether `key` is a scope strictly inside `ancestor`. */
function isInside(key: string, ancestor: string): boolean {
  return key !== ancestor && (ancestor === '' || key.startsWith(`${ancestor}|`));
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
  const scopes = new Map<string, Scope>();

  function newScope(key: string, scopeRunId: string): Scope {
    const scope: Scope = {
      key,
      runId: scopeRunId,
      open: undefined,
      messageCalls: new Map(),
      uncheckedArgs: new Set(),
      syntheticIds: new Map(),
      partials: new Map(),
      startedToolCalls: new Set(),
      resultedToolCalls: new Set(),
      settled: false,
      interrupted: false,
      errored: false,
      lastSeq: undefined,
    };
    scopes.set(key, scope);
    return scope;
  }

  /** The top-level scope. `start` creates it, so it exists from the first frame on. */
  function topScope(): Scope {
    return scopes.get('')!;
  }

  /**
   * The scope for a namespace, opening it — and any ancestor not yet open, outermost first — with
   * a RUN_STARTED (S2): a frame from a nested namespace can be the first thing any ancestor sends.
   */
  function scopeFor(out: LangGraphExpansion, namespace: readonly string[]): Scope {
    let parent = topScope();
    for (let depth = 1; depth <= namespace.length; depth += 1) {
      const key = namespace.slice(0, depth).join('|');
      let scope = scopes.get(key);
      if (scope === undefined) {
        // LangGraph sends no run id for a subgraph, so the id is ours (S1, spec §9 Q2).
        scope = newScope(key, `${runId}/${key}`);
        out.events.push({
          runKey: key,
          event: { type: 'RUN_STARTED', runId: scope.runId, threadId, parentRunId: parent.runId },
        });
      }
      parent = scope;
    }
    return parent;
  }

  function issue(out: LangGraphExpansion, runKey: string, code: IssueCode, message: string, seq: number): void {
    out.issues.push({ runKey, issue: makeIssue(code, message, seq) });
  }

  /**
   * The scope that has ended the run a namespace belongs to: the namespace's own scope or the
   * nearest-to-top ancestor that errored (S5). Only scopes already open are looked at.
   */
  function cutOffBy(namespace: readonly string[]): Scope | undefined {
    for (let depth = 0; depth <= namespace.length; depth += 1) {
      const scope = scopes.get(namespace.slice(0, depth).join('|'));
      if (scope === undefined) return undefined;
      if (scope.errored) return scope;
    }
    return undefined;
  }

  /** Whether the scope, or any scope it is inside, errored: its run was cut off (S5, S6). */
  function isCutOff(scope: Scope): boolean {
    return lineageOf(scope.key).some((key) => scopes.get(key)?.errored === true);
  }

  function start(out: LangGraphExpansion, meta: Record<string, unknown> | undefined): void {
    started = true;
    runId = str(meta?.run_id) ?? route?.runId ?? `lg:${connId}`;
    threadId = route?.threadId ?? str(meta?.thread_id) ?? '';
    newScope('', runId);
    out.events.push({ runKey: '', event: { type: 'RUN_STARTED', runId, threadId } });
  }

  function ensureStarted(out: LangGraphExpansion, seq: number): void {
    if (started) return;
    // A join stream (its URL names the run) that attaches mid-run legitimately missed `metadata`:
    // the run id is the URL's, not synthesized, so there is nothing to report.
    if (route?.runId !== undefined) {
      start(out, undefined);
      return;
    }
    // About the top-level run, whichever scope the first frame came from.
    issue(
      out,
      '',
      'lg-no-metadata',
      'The stream sent no metadata event before its first event, so this run id is synthesized',
      seq,
    );
    start(out, undefined);
  }

  function emit(out: LangGraphExpansion, scope: Scope, event: AguiEvent): void {
    out.events.push({ runKey: scope.key, event });
  }

  function closeReasoning(out: LangGraphExpansion, scope: Scope, message: OpenMessage): void {
    if (!message.reasoningOpen) return;
    emit(out, scope, { type: 'REASONING_MESSAGE_END', messageId: reasoningIdOf(message.messageId) });
    message.reasoningOpen = false;
  }

  function checkArgs(out: LangGraphExpansion, scope: Scope, seq: number, calls: Iterable<OpenToolCall>): void {
    for (const call of [...calls]) {
      if (!scope.uncheckedArgs.delete(call) || call.argsText.trim() === '') continue;
      try {
        JSON.parse(call.argsText);
      } catch {
        issue(out, scope.key, 'lg-tool-args-invalid', `Tool call ${call.toolCallId} streamed arguments that are not valid JSON`, seq);
      }
    }
  }

  /**
   * Close the scope's open message. `switched` is a close because a chunk for another message
   * arrived: this message may resume, so its calls' args are checked later, when it ends for good.
   */
  function closeMessage(out: LangGraphExpansion, scope: Scope, seq: number, switched = false): void {
    const message = scope.open;
    if (message === undefined) return;
    scope.open = undefined;
    closeReasoning(out, scope, message);
    for (const call of message.calls) {
      if (call.ended) continue;
      call.ended = true;
      scope.uncheckedArgs.add(call);
      emit(out, scope, { type: 'TOOL_CALL_END', toolCallId: call.toolCallId });
    }
    if (!switched) checkArgs(out, scope, seq, message.calls);
    if (message.textOpen) emit(out, scope, { type: 'TEXT_MESSAGE_END', messageId: message.messageId });
  }

  /** The step, the run or the stream is over: close the open message and check every call's args. */
  function settle(out: LangGraphExpansion, scope: Scope, seq: number): void {
    closeMessage(out, scope, seq);
    checkArgs(out, scope, seq, scope.uncheckedArgs);
  }

  function foldToolChunk(out: LangGraphExpansion, scope: Scope, message: OpenMessage, chunk: ToolCallChunk): void {
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
      scope.startedToolCalls.add(call.toolCallId);
      closeReasoning(out, scope, message);
      emit(out, scope, {
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
      emit(out, scope, {
        type: 'TOOL_CALL_START',
        toolCallId: call.toolCallId,
        toolCallName: call.name,
        parentMessageId: message.messageId,
      });
    }
    if (!call.wireId && chunk.id !== undefined && !scope.syntheticIds.has(chunk.id)) {
      // The tool's result will name the call by this id: it must find the call's synthetic one.
      scope.syntheticIds.set(chunk.id, call.toolCallId);
    }
    if (chunk.args !== '') {
      call.ended = false;
      call.argsText += chunk.args;
      emit(out, scope, { type: 'TOOL_CALL_ARGS', toolCallId: call.toolCallId, delta: chunk.args });
    }
  }

  /** One assistant delta: new text, new reasoning and new tool-call fragments for one message. */
  function foldAiDelta(
    out: LangGraphExpansion,
    scope: Scope,
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
      if (scope.open !== undefined && messageId !== undefined && messageId !== scope.open.messageId) {
        closeMessage(out, scope, seq, true);
      }
      if (scope.open === undefined) {
        const id = messageId ?? `lg-msg-${seq}`;
        let calls = scope.messageCalls.get(id);
        if (calls === undefined) {
          calls = { calls: [], toolCalls: new Map() };
          scope.messageCalls.set(id, calls);
        }
        scope.open = { messageId: id, textOpen: false, reasoningOpen: false, ...calls };
      }
      const message = scope.open;
      if (reasoning !== '') {
        const reasoningId = reasoningIdOf(message.messageId);
        if (!message.reasoningOpen) {
          emit(out, scope, { type: 'REASONING_MESSAGE_START', messageId: reasoningId, role: 'assistant' });
          message.reasoningOpen = true;
        }
        emit(out, scope, { type: 'REASONING_MESSAGE_CONTENT', messageId: reasoningId, delta: reasoning });
      }
      if (text !== '') {
        closeReasoning(out, scope, message);
        if (!message.textOpen) {
          emit(out, scope, { type: 'TEXT_MESSAGE_START', messageId: message.messageId, role: 'assistant' });
          message.textOpen = true;
        }
        emit(out, scope, { type: 'TEXT_MESSAGE_CONTENT', messageId: message.messageId, delta: text });
      }
      for (const chunk of tools) foldToolChunk(out, scope, message, chunk);
    }
    if (!last) return;
    // The end of one message closes that message only: with interleaved branches, another may be open.
    if (messageId === undefined || messageId === scope.open?.messageId) {
      closeMessage(out, scope, seq);
    } else {
      const calls = scope.messageCalls.get(messageId);
      if (calls !== undefined) checkArgs(out, scope, seq, calls.calls);
    }
  }

  function toolResult(
    out: LangGraphExpansion,
    scope: Scope,
    seq: number,
    message: Record<string, unknown>,
    onlyIfStartedHere: boolean,
  ): void {
    const wireId = str(message.tool_call_id);
    if (wireId === undefined) return;
    const toolCallId = scope.syntheticIds.get(wireId) ?? wireId;
    if (scope.resultedToolCalls.has(toolCallId)) return;
    // `values.messages` is the whole thread's history: a result for a call an EARLIER run made is
    // not this run's. A `messages` tool chunk, by contrast, was produced by this run.
    if (onlyIfStartedHere && !scope.startedToolCalls.has(toolCallId)) return;
    // The call's TOOL_CALL_END precedes its result. Only its own message is closed: another branch's
    // message may be streaming.
    if (scope.open !== undefined && scope.open.calls.some((call) => call.toolCallId === toolCallId)) {
      closeMessage(out, scope, seq);
    }
    scope.resultedToolCalls.add(toolCallId);
    emit(out, scope, {
      type: 'TOOL_CALL_RESULT',
      messageId: str(message.id) ?? `${toolCallId}:result`,
      toolCallId,
      content: message.content,
      role: 'tool',
    });
  }

  function foldTupleMessage(out: LangGraphExpansion, scope: Scope, seq: number, message: Record<string, unknown>): void {
    const role = roleOf(message.type);
    if (role === 'tool') {
      toolResult(out, scope, seq, message, false);
      return;
    }
    // Human and system messages are the request's input, which the run already carries.
    if (role !== 'ai') return;
    const parts = contentParts(message.content);
    foldAiDelta(
      out,
      scope,
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
    scope: Scope,
    seq: number,
    message: Record<string, unknown>,
    complete: boolean,
  ): void {
    const role = roleOf(message.type);
    if (role === 'tool') {
      toolResult(out, scope, seq, message, false);
      return;
    }
    if (role !== 'ai') return;
    const id = str(message.id) ?? scope.open?.messageId ?? `lg-msg-${seq}`;
    const previous = scope.partials.get(id) ?? { text: '', reasoning: '', toolArgs: new Map<number, string>() };
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
        scope.key,
        complete ? 'lg-complete-mismatch' : 'lg-partial-regressed',
        complete
          ? `messages/complete for ${id} does not extend what its partials streamed`
          : `A messages/partial for ${id} does not extend the previous one: messages/partial is cumulative`,
        seq,
      );
    }
    previous.text = parts.text;
    previous.reasoning = parts.reasoning;
    scope.partials.set(id, previous);
    foldAiDelta(out, scope, seq, id, text ?? '', reasoning ?? '', tools, complete);
  }

  function undecodable(out: LangGraphExpansion, name: string, seq: number): void {
    issue(out, out.runKey, 'lg-undecodable', `The "${name}" event's payload is not the shape that event carries`, seq);
  }

  /** One frame of a known mode, folded within its scope exactly as at the top level (S4). */
  function foldMode(
    out: LangGraphExpansion,
    scope: Scope,
    mode: string,
    name: string,
    seq: number,
    payload: unknown,
  ): void {
    switch (mode) {
      case 'messages': {
        const message = Array.isArray(payload) ? (payload[0] as unknown) : undefined;
        if (!isObject(message)) {
          undecodable(out, name, seq);
          break;
        }
        scope.settled = false;
        foldTupleMessage(out, scope, seq, message);
        break;
      }
      case 'messages/partial':
      case 'messages/complete': {
        if (!Array.isArray(payload)) {
          undecodable(out, name, seq);
          break;
        }
        const complete = mode === 'messages/complete';
        scope.settled = complete;
        for (const message of payload) {
          if (isObject(message)) foldCumulativeMessage(out, scope, seq, message, complete);
        }
        break;
      }
      case 'values': {
        if (!isObject(payload)) {
          undecodable(out, name, seq);
          break;
        }
        // A values event marks a completed step: whatever message was streaming is done.
        settle(out, scope, seq);
        scope.settled = true;
        if ('__interrupt__' in payload) scope.interrupted = true;
        // `fromEntries` defines each key as an own property, so a `__proto__` key stays data.
        const snapshot: Record<string, unknown> = Object.fromEntries(
          Object.entries(payload).filter(([key]) => key !== '__interrupt__'),
        );
        // A values event whose only key is `__interrupt__` is an interrupt, not a state.
        if (Object.keys(snapshot).length > 0) emit(out, scope, { type: 'STATE_SNAPSHOT', snapshot });
        if (Array.isArray(snapshot.messages)) {
          for (const message of snapshot.messages) {
            if (isObject(message) && roleOf(message.type) === 'tool') toolResult(out, scope, seq, message, true);
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
            scope.interrupted = true;
            continue;
          }
          // An update arrives once its node has run, so the step starts and finishes together.
          emit(out, scope, { type: 'STEP_STARTED', stepName: node });
          emit(out, scope, { type: 'STEP_FINISHED', stepName: node });
        }
        break;
      }
      case 'custom':
        emit(out, scope, { type: 'CUSTOM', name: 'langgraph.custom', value: payload });
        break;
      case 'error': {
        // A failure stops every subgraph inside the failed graph mid-flight (S5): close what each
        // has open, innermost first (scopes open outermost first, so reversed open order), then
        // the failed scope itself. The cut-off scopes get no terminal event, so the builder records
        // them aborted; the failed scope's parent and siblings carry on. Their issues anchor to
        // their own last frame: this one is not theirs.
        for (const each of [...scopes.values()].reverse()) {
          if (isInside(each.key, scope.key)) settle(out, each, each.lastSeq ?? seq);
        }
        settle(out, scope, seq);
        scope.errored = true;
        const message = isObject(payload)
          ? (str(payload.message) ?? str(payload.error) ?? 'error')
          : (str(payload) ?? 'error');
        const code = isObject(payload) ? str(payload.error) : undefined;
        emit(out, scope, { type: 'RUN_ERROR', message, ...(code !== undefined ? { code } : {}) });
        break;
      }
      case 'checkpoints':
        scope.settled = true;
        break;
      default:
        // messages/metadata, debug, tasks, events, tools, feedback — and a namespaced `metadata`,
        // which carries no run of its own (S4): shown raw in Timeline only.
        break;
    }
  }

  function push(frame: LangGraphFrame): LangGraphExpansion {
    const out: LangGraphExpansion = { runKey: '', events: [], issues: [] };
    const { seq, payload } = frame;
    // An unnamed frame is dispatched by SSE as `message`: the name metrics and export count it under.
    const name = frame.sseEvent ?? 'message';
    const { mode, namespace } = parseEventName(frame.sseEvent);

    if (mode === 'metadata' && namespace.length === 0) {
      if (!started) {
        if (!isObject(payload)) undecodable(out, name, seq);
        start(out, isObject(payload) ? payload : undefined);
      }
      topScope().lastSeq = seq;
      return out;
    }

    ensureStarted(out, seq);
    // An error ends its graph and every subgraph inside it (S5): a later frame from anywhere in
    // that subtree is recorded as it arrived, on the errored scope's run, and folds nothing —
    // and opens no scope. The errored scope's parent and siblings carry on.
    const ended = cutOffBy(namespace);
    const scope = ended ?? (namespace.length === 0 ? topScope() : scopeFor(out, namespace));
    out.runKey = scope.key;
    scope.lastSeq = seq;
    if (ended !== undefined) return out;
    if (!isKnownMode(mode)) {
      issue(out, scope.key, 'lg-unknown-event', `"${name}" is not an event LangGraph Platform emits`, seq);
      return out;
    }
    foldMode(out, scope, mode, name, seq, payload);
    return out;
  }

  function finish(seq: number): LangGraphFinish {
    const out: LangGraphExpansion = { runKey: '', events: [], issues: [] };
    const done = (interrupted: string[]): LangGraphFinish => ({ events: out.events, issues: out.issues, interrupted });
    if (!started) return done([]);
    // Deepest first: a child's messages close before its parent's, and the top-level run's
    // RUN_FINISHED comes after every child's (S6). `sort` is stable, so siblings keep open order.
    const ordered = [...scopes.values()].sort((a, b) => depthOf(b.key) - depthOf(a.key));
    // Each scope's close-time issues anchor to its own last frame; one with none, to the close.
    for (const scope of ordered) settle(out, scope, scope.lastSeq ?? seq);
    const top = topScope();
    // A run cut off by its error, or by a close before its final values, finishes no child (S6).
    if (top.errored) return done([]);
    if (!top.interrupted && valuesRequested(request.input) && !top.settled) {
      // Threadplane's bridge reads this exact condition as "did not finish normally": the stream
      // stopped mid-answer. No RUN_FINISHED, so the run builder records the outcome `aborted`.
      // A top-level check only: a subgraph's own `values` are not the run's (S6).
      // Anchored to the last top-level frame: the claim is about the top-level run (S6).
      issue(
        out,
        '',
        'lg-no-final-values',
        'The stream closed without a final values event, although the request asked for values',
        top.lastSeq ?? seq,
      );
      return done([]);
    }
    const interrupted: string[] = [];
    for (const scope of ordered) {
      // A child that errored already ended; one inside it was cut off (S5). The top level cannot
      // be either here.
      if (isCutOff(scope)) continue;
      emit(out, scope, { type: 'RUN_FINISHED', runId: scope.runId, threadId });
      if (scope.interrupted) interrupted.push(scope.key);
    }
    return done(interrupted);
  }

  return { push, finish };
}
