import { toStreamEvent, type ThreadplaneFrame } from './threadplane-normalizer';

/**
 * What `@threadplane/langgraph` 0.2.0 will show after a generated spec replays a capture (T4).
 * Every field is optional: a field is present only when it follows with certainty from the
 * frames, and an absent field means "make no assertion" — never "assert it is absent".
 */
export interface ThreadplaneExpectations {
  /**
   * `agent.status()` after `close()` and the submission settle. Absent when Threadplane would
   * still report `running` (an interruption it stays silent about because an interrupt is
   * showing), or when the replay could not be followed.
   */
  status?: 'idle' | 'error';
  /** `agent.interrupt()` is set. */
  interrupted?: boolean;
  /**
   * The text of the last assistant message in `agent.messages()`. Absent when there is none.
   * Note that Threadplane counts a submitted message with no `type` (or a `type` other than
   * `human`/`tool`/`system`) as an assistant message, so this can be the submitted text.
   */
  lastAssistantText?: string;
  /** Tool-call names in `agent.toolCalls()`, in order. Absent when Threadplane would show none. */
  toolCallNames?: string[];
}

/**
 * How the generated spec submits (T3): `submit({ state })` for a captured `input`,
 * `submit({ resume })` for a captured `command.resume`. It matters because Threadplane shows
 * the submitted messages straight away, and they take part in the transcript merge.
 */
export type ThreadplaneSubmission = { readonly state?: unknown } | { readonly resume: unknown };

/**
 * Derive the expectations by replaying `frames` through a line-by-line port of the parts of
 * Threadplane 0.2.0 that decide them (angular-agent-framework `79aabe3fd`,
 * `libs/langgraph/src/lib/`), for a fresh agent with no thread id, no `transcriptNodeNames`, no
 * `toMessage` and the `MockAgentTransport` (so the close-time history refresh never runs):
 *
 * - `agent.fn.ts` `submit`/`buildSubmitPayload` L510-536/L881-924: the payload is `state`
 *   (or `{}`), or `null` for a resume.
 * - `internals/stream-manager.bridge.ts` `runStream` L880-970: a new attempt, then the
 *   submitted messages are shown at once, stamped with an id when they have none.
 * - `processEvent` L1021-1250 — the message-event merge (tuple = delta, `messages/partial` =
 *   snapshot, other arrays = id-preserving replace), the root `values` snapshot merge, `error`,
 *   `interrupt`, `interrupts` and the `__interrupt__` key — with its helpers `mergeMessages`
 *   L1827, `collapseAdjacentAi` L1782, `accumulateContent` L2011, `preserveIds` L2101,
 *   `findContentMatch` L2182, `normalizeMessages` L1738, `extractInterrupts` L1589.
 * - The end of the run: `trackAssistantMessages` L493, `markNormalTerminal` L535,
 *   `finishOutcome` L375, `finalizeClosedAttempt` L380 and `publishInterruptionError` L466.
 * - What the agent shows: `mapStatus` L708, `toMessage`/`extractTextContent` L719/L770,
 *   `interruptNeutral` L422, and tool calls from `getToolCallsWithResults`
 *   (`@langchain/langgraph-sdk/utils`) via `syncToolCallsFromMessages` L1252.
 *
 * Should the replay throw where Threadplane's would too (malformed payloads), no expectation
 * is returned: the port does not follow Threadplane's error path for thrown exceptions.
 */
export function expectationsFor(
  frames: readonly ThreadplaneFrame[],
  submission: ThreadplaneSubmission = {},
): ThreadplaneExpectations {
  let replay: Replay;
  try {
    replay = replayThroughBridge(frames, submission);
  } catch {
    return {};
  }

  const out: ThreadplaneExpectations = {};
  if (replay.status === 'error') out.status = 'error';
  else if (replay.status === 'resolved') out.status = 'idle';
  out.interrupted = Boolean(replay.interrupt);

  const assistants = replay.messages.filter((message) => roleOf(message) === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last) out.lastAssistantText = extractText(last['content']);

  if (replay.toolCallNames === 'unknown') return out;
  if (replay.toolCallNames.length > 0) out.toolCallNames = replay.toolCallNames;
  return out;
}

type Msg = Record<string, unknown>;
type StreamEvent = Record<string, unknown>;
type Outcome = 'success' | 'error' | 'interrupted' | 'paused' | 'aborted';

interface Attempt {
  rootTerminalEvidence: boolean;
  messageIds: Set<string>;
  finalizedMessageIds: Set<string>;
  baselineMessageIds: Set<string>;
  currentAssistantMessageId?: string;
  sawAssistantChunk: boolean;
  currentStepHasTerminalEvidence: boolean;
  terminalOutcome?: Outcome;
}

interface Replay {
  status: 'loading' | 'error' | 'resolved';
  interrupt: unknown;
  messages: Msg[];
  toolCallNames: string[] | 'unknown';
}

function replayThroughBridge(frames: readonly ThreadplaneFrame[], submission: ThreadplaneSubmission): Replay {
  // beginAttempt L292: a fresh agent has no messages, so the baseline is empty and there is
  // no eligible baseline tail even for a resume.
  const attempt: Attempt = {
    rootTerminalEvidence: false,
    messageIds: new Set(),
    finalizedMessageIds: new Set(),
    baselineMessageIds: new Set(),
    sawAssistantChunk: false,
    currentStepHasTerminalEvidence: false,
  };
  let status: Replay['status'] = 'loading';
  let hasError = false;
  let interrupt: unknown = undefined;
  let interrupts: unknown = [];
  let messages: Msg[] = [];
  let toolCallNames: Replay['toolCallNames'] = [];
  const canonicalMessageIds = new Set<string>();

  const payload = 'resume' in submission && submission.resume !== undefined
    ? null
    : ((submission as { state?: unknown }).state ?? {});
  const inputMessages = isRecord(payload) ? payload['messages'] : undefined;
  if (Array.isArray(inputMessages) && inputMessages.length > 0) {
    let n = 0;
    messages = [...messages, ...inputMessages.map((m) => {
      const raw = m as Msg;
      if (typeof raw['id'] === 'string' && raw['id']) return raw;
      // Threadplane stamps `optimistic-<time>-<random>`; any id no frame can carry will do.
      return { ...(m as object), id: `optimistic-devtools-${n++}` } as Msg;
    })];
  }

  function finalizeMessage(id: string): void {
    attempt.finalizedMessageIds.add(id);
  }

  function finalizeAttempt(outcome: Outcome): void {
    if (attempt.terminalOutcome) return;
    attempt.terminalOutcome = outcome;
    for (const id of attempt.messageIds) {
      if (!attempt.finalizedMessageIds.has(id)) finalizeMessage(id);
    }
  }

  function trackAssistantMessages(tracked: Msg[]): void {
    if (attempt.terminalOutcome) return;
    const assistantMessages = tracked.filter((message) => {
      const id = typeof message['id'] === 'string' ? message['id'] : undefined;
      return normalizeMessageType(message['type']) === 'ai' && id && !attempt.finalizedMessageIds.has(id);
    });
    // With an empty baseline every assistant message is new; the baseline-tail branch of
    // L509-513 never applies.
    const currentStepMessages = assistantMessages.filter((message) => {
      const id = message['id'];
      return typeof id === 'string' && !attempt.baselineMessageIds.has(id);
    });
    for (const message of currentStepMessages) {
      const id = message['id'] as string;
      if (attempt.currentAssistantMessageId && attempt.currentAssistantMessageId !== id) {
        finalizeMessage(attempt.currentAssistantMessageId);
        attempt.currentStepHasTerminalEvidence = false;
      }
      attempt.currentAssistantMessageId = id;
      attempt.messageIds.add(id);
      attempt.sawAssistantChunk = true;
      attempt.rootTerminalEvidence = false;
    }
  }

  function markNormalTerminal(event: StreamEvent): void {
    if (attempt.terminalOutcome || (getEventNamespace(event)?.length ?? 0) > 0) return;
    const baseType = getBaseEventType(event['type']);
    if (baseType === 'values' || baseType === 'messages/complete' || baseType === 'checkpoints') {
      if (hasDevelopmentEventPayload(event)) attempt.rootTerminalEvidence = true;
      if (attempt.sawAssistantChunk) attempt.currentStepHasTerminalEvidence = true;
    }
  }

  function syncToolCallsFromMessages(): void {
    toolCallNames = toolCallNamesOf(messages);
  }

  function extractInterruptsFrom(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const raw = (value as Msg)['__interrupt__'];
    if (Array.isArray(raw) && raw.length > 0) {
      interrupts = raw;
      interrupt = raw[raw.length - 1];
      return;
    }
    if (interrupt !== undefined) {
      interrupt = undefined;
      interrupts = [];
    }
  }

  function processEvent(event: StreamEvent): void {
    const baseType = getBaseEventType(event['type']);
    const namespace = getEventNamespace(event);

    if (baseType === 'checkpoints' || baseType === 'messages/complete') markNormalTerminal(event);

    if (isMessagesEvent(event['type'])) {
      const msgs = normalizeMessages(event);
      if (!msgs) return;
      const normalized = msgs as Msg[];
      // Namespaced message events feed a child stream, never the parent transcript.
      if (isChildNamespace(namespace)) return;

      if (event['type'] === 'messages/partial' || event['messageMetadata']) {
        const mode: MergeMode = event['messageMetadata'] ? 'delta' : 'snapshot';
        const affected = new Set<string>();
        const merged = mergeMessages(
          messages,
          normalized,
          mode,
          canonicalMessageIds,
          affected,
          attempt.currentAssistantMessageId !== undefined && attempt.currentStepHasTerminalEvidence !== true,
        );
        messages = merged;
        trackAssistantMessages(merged.filter((m) => typeof m['id'] === 'string' && affected.has(m['id'])));
      } else if (normalized.length === 0) {
        // An empty batch leaves the transcript alone (L1082-1085).
      } else {
        const affected = new Set<string>();
        const preserved = preserveIds(messages, normalized, affected);
        messages = preserved;
        trackAssistantMessages(preserved.filter((m) => typeof m['id'] === 'string' && affected.has(m['id'])));
      }
      markNormalTerminal(event);
      syncToolCallsFromMessages();
      return;
    }

    switch (baseType) {
      case 'values': {
        const vals = extractEventData(event);
        if (isChildNamespace(namespace)) break;
        if ((namespace?.length ?? 0) === 0) {
          if (hasInterrupts(vals)) finalizeAttempt('paused');
          else markNormalTerminal(event);
        }
        if (vals != null) {
          extractInterruptsFrom(vals);
          const stateMessages = (vals as Msg)['messages'];
          if (Array.isArray(stateMessages) && stateMessages.length > 0) {
            const projected = stateMessages as Msg[];
            // An empty assistant turn at the tail of `values` is dropped before merging (L1136).
            const filtered = projected.filter((m, i) => {
              if (i !== projected.length - 1) return true;
              if (normalizeMessageType(m['type']) !== 'ai') return true;
              return extractText(m['content']).length > 0;
            });
            const remapped = preserveIds(messages, filtered);
            messages = mergeMessages(messages, remapped, 'snapshot', canonicalMessageIds);
            syncToolCallsFromMessages();
          }
        }
        break;
      }
      case 'updates': {
        if (isChildNamespace(namespace)) break;
        const upd = extractEventData(event);
        if (upd != null) extractInterruptsFrom(upd);
        break;
      }
      // `error`, `interrupt` and `interrupts` count at any namespace: processEvent does not
      // filter them (L1203-1215).
      case 'error':
        finalizeAttempt('error');
        hasError = true;
        status = 'error';
        break;
      case 'interrupt':
        finalizeAttempt('paused');
        interrupt = event['interrupt'];
        break;
      case 'interrupts':
        finalizeAttempt('paused');
        interrupts = event['interrupts'];
        break;
    }
  }

  for (const frame of frames) processEvent(toStreamEvent(frame));

  // finalizeClosedAttempt L380: no thread id, so the refresh returns nothing and cannot
  // rescue an interruption.
  const outcome = attempt.terminalOutcome
    ?? (attempt.currentStepHasTerminalEvidence || attempt.rootTerminalEvidence ? 'success' : 'interrupted');
  finalizeAttempt(outcome);
  if (outcome === 'interrupted' && !hasError) {
    // publishInterruptionError L466 reads `interrupts$.value.length`; anything but an array
    // there is a shape the port does not claim to follow.
    if (!Array.isArray(interrupts)) throw new Error('interrupts is not a list');
    if (!interrupt && interrupts.length === 0) status = 'error';
  }
  if (outcome !== 'error' && outcome !== 'interrupted') status = 'resolved';
  return { status, interrupt, messages, toolCallNames };
}

/** `toMessage` L719: the role comes from the raw `type`, defaulting to an assistant. */
function roleOf(message: Msg): 'user' | 'tool' | 'system' | 'assistant' {
  const type = message['type'] ?? 'ai';
  return type === 'human' ? 'user' : type === 'tool' ? 'tool' : type === 'system' ? 'system' : 'assistant';
}

/**
 * `getToolCallsWithResults` then `toToolCall`: every `tool_calls` entry of each `type: 'ai'`
 * message, by `call.name`. Anything but a list of records with string names is left to
 * Threadplane — `'unknown'` makes the caller omit the expectation.
 */
function toolCallNamesOf(messages: readonly Msg[]): string[] | 'unknown' {
  const names: string[] = [];
  for (const message of messages) {
    const calls = message['tool_calls'];
    if (message['type'] !== 'ai' || !calls) continue;
    if (!Array.isArray(calls)) return 'unknown';
    for (const call of calls) {
      if (!isRecord(call) || typeof call['name'] !== 'string') return 'unknown';
      names.push(call['name']);
    }
  }
  return names;
}

// ── Ported helpers (stream-manager.bridge.ts), kept in Threadplane's logic and order. ──

type MergeMode = 'delta' | 'snapshot';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChildNamespace(namespace: string[] | string | undefined): boolean {
  if (!namespace) return false;
  return namespace.length > 0;
}

function getBaseEventType(type: unknown): string {
  return String(type).split('|')[0] ?? '';
}

function getEventNamespace(event: StreamEvent): string[] | undefined {
  if (Array.isArray(event['namespace'])) return event['namespace'] as string[];
  const parts = String(event['type']).split('|');
  return parts.length > 1 ? parts.slice(1) : undefined;
}

function isMessagesEvent(type: unknown): boolean {
  const baseType = getBaseEventType(type);
  return baseType === 'messages' || baseType.startsWith('messages/');
}

function isMessageLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && ('content' in value || 'type' in value || 'id' in value);
}

function normalizeMessages(event: StreamEvent): unknown[] | null {
  const directMessages = event['messages'];
  if (Array.isArray(directMessages)) {
    const filtered = directMessages.filter(isMessageLike);
    return filtered.length > 0 ? filtered : null;
  }
  const data = event['data'];
  if (Array.isArray(data)) {
    if (data.every(isMessageLike)) return data;
    if (isMessageLike(data[0])) return [data[0]];
  }
  const indexedValues = Object.keys(event)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => event[key]);
  if (indexedValues.every(isMessageLike)) return indexedValues;
  if (isMessageLike(indexedValues[0])) return [indexedValues[0]];
  return null;
}

function safeReadEventError(event: StreamEvent): unknown {
  try {
    return Object.getOwnPropertyDescriptor(event, 'error')?.value;
  } catch {
    return undefined;
  }
}

/** Only the event kinds `markNormalTerminal` asks about need to agree with Threadplane here. */
function hasDevelopmentEventPayload(event: StreamEvent): boolean {
  const baseType = getBaseEventType(event['type']);
  if (isMessagesEvent(event['type'])) {
    const payload = Array.isArray(event['messages']) ? event['messages'] : event['data'];
    if (Array.isArray(payload)) {
      return payload.length === 0 || (normalizeMessages(event)?.length ?? 0) > 0;
    }
    return Object.keys(event).some((key) => /^\d+$/.test(key)) && (normalizeMessages(event)?.length ?? 0) > 0;
  }
  const payload = 'data' in event ? event['data']
    : baseType in event ? event[baseType]
    : Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'namespace', 'messageMetadata'].includes(key)));
  switch (baseType) {
    case 'values':
    case 'updates':
    case 'checkpoints':
    case 'metadata':
      return isRecord(payload) && ('data' in event || baseType in event || Object.keys(payload).length > 0);
    case 'error':
      return safeReadEventError(event) !== undefined;
    default:
      return false;
  }
}

function extractEventData(event: StreamEvent): unknown {
  const d = event['data'];
  if (d != null && typeof d === 'object' && !Array.isArray(d)) return d;
  const named = event[event['type'] as string];
  if (named != null && typeof named === 'object' && !Array.isArray(named)) return named;
  const rest = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type' && key !== 'data'));
  return Object.keys(rest).length > 0 ? rest : d;
}

function hasInterrupts(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const raw = (payload as Msg)['__interrupt__'];
  return Array.isArray(raw) && raw.length > 0;
}

function normalizeMessageType(t: unknown): unknown {
  if (!t) return t;
  if (t === 'AIMessageChunk' || t === 'AIMessage' || t === 'assistant') return 'ai';
  if (t === 'HumanMessage' || t === 'HumanMessageChunk' || t === 'user') return 'human';
  if (t === 'ToolMessage') return 'tool';
  if (t === 'SystemMessage') return 'system';
  return t;
}

/** The bridge's `extractText`; `toMessage`'s `extractTextContent` is the same rule. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (typeof block === 'string') { out += block; continue; }
    if (block == null || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    const t = rec['type'];
    if (t === 'text' || t === 'output_text' || t === undefined) {
      const text = rec['text'];
      if (typeof text === 'string') out += text;
    }
  }
  return out;
}

function extractReasoning(content: unknown): string {
  if (typeof content === 'string') return '';
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    const t = rec['type'];
    if (t === 'reasoning' || t === 'thinking') {
      const text = rec['text'];
      if (typeof text === 'string') out += text;
      const summary = rec['summary'];
      if (Array.isArray(summary)) {
        for (const item of summary) {
          if (item == null || typeof item !== 'object') continue;
          const itemText = (item as Record<string, unknown>)['text'];
          if (typeof itemText === 'string') out += itemText;
        }
      }
    }
  }
  return out;
}

function accumulateReasoning(existing: unknown, incoming: unknown): string {
  const existingText = typeof existing === 'string' ? existing : extractReasoning(existing);
  const incomingText = typeof incoming === 'string' ? incoming : extractReasoning(incoming);
  if (existingText.length === 0) return incomingText;
  if (incomingText.length === 0) return existingText;
  if (incomingText.startsWith(existingText)) return incomingText;
  if (existingText.startsWith(incomingText)) return existingText;
  return existingText + incomingText;
}

function isFinalCanonicalReasoningContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let hasReasoning = false;
  let hasText = false;
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue;
    const t = (block as Record<string, unknown>)['type'];
    if (t === 'reasoning' || t === 'thinking') hasReasoning = true;
    else if (t === 'text' || t === 'output_text') hasText = true;
  }
  return hasReasoning && hasText;
}

function accumulateContent(existing: unknown, incoming: unknown, mode: MergeMode): string {
  const existingText = extractText(existing);
  const incomingText = extractText(incoming);
  if (existingText.length === 0) return incomingText;
  if (incomingText.length === 0) return existingText;
  if (isFinalCanonicalReasoningContent(incoming)) return incomingText;
  if (mode === 'delta') return existingText + incomingText;
  if (incomingText.startsWith(existingText)) return incomingText;
  if (existingText.startsWith(incomingText)) return existingText;
  return existingText + incomingText;
}

function collapseAdjacentAi(messages: Msg[], affectedMessageIds?: Set<string>, allowCrossIdAiMerge = true): Msg[] {
  if (messages.length < 2) return messages;
  const out: Msg[] = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (!last) { out.push(msg); continue; }
    if (normalizeMessageType(last['type']) === 'ai' && normalizeMessageType(msg['type']) === 'ai') {
      const lastText = extractText(last['content']);
      const msgText = extractText(msg['content']);
      const differentIds = last['id'] !== msg['id'];
      if (!(differentIds && !allowCrossIdAiMerge) && (lastText.length === 0
          || msgText.length === 0
          || lastText === msgText
          || lastText.startsWith(msgText)
          || msgText.startsWith(lastText))) {
        const longerText = msgText.length >= lastText.length ? msgText : lastText;
        const lastId = last['id'];
        const msgId = msg['id'];
        if (typeof msgId === 'string' && affectedMessageIds?.delete(msgId) && typeof lastId === 'string') {
          affectedMessageIds.add(lastId);
        }
        out[out.length - 1] = { ...last, content: longerText };
        continue;
      }
    }
    out.push(msg);
  }
  return out;
}

function canMergeCrossIdAi(candidate: Msg, incoming: Msg, allowCrossIdAiMerge: boolean): boolean {
  if (candidate['id'] === incoming['id']) return true;
  return allowCrossIdAiMerge;
}

function mergeMessages(
  existing: Msg[],
  incoming: Msg[],
  mode: MergeMode,
  canonicalMessageIds?: Set<string>,
  affectedMessageIds?: Set<string>,
  allowCrossIdAiMerge = true,
): Msg[] {
  const merged = [...existing];
  for (const msg of incoming) {
    const id = msg['id'];
    let idx = id ? merged.findIndex((m) => m['id'] === id) : -1;
    if (idx < 0) {
      idx = findContentMatch(merged, msg);
      if (idx >= 0 && !canMergeCrossIdAi(merged[idx]!, msg, allowCrossIdAiMerge)) idx = -1;
    }
    if (idx < 0 && normalizeMessageType(msg['type']) === 'ai') {
      for (let i = merged.length - 1; i >= 0; i--) {
        const t = normalizeMessageType(merged[i]!['type']);
        if (t === 'ai') {
          if (!canMergeCrossIdAi(merged[i]!, msg, allowCrossIdAiMerge)) break;
          idx = i;
          break;
        }
        if (t === 'human' || t === 'tool' || t === 'system') break;
      }
    }
    if (idx >= 0) {
      const current = merged[idx]!;
      const existingId = current['id'];
      const targetId = (existingId ?? msg['id']) as string | undefined;
      if (mode === 'delta' && targetId && canonicalMessageIds?.has(targetId)
          && !isFinalCanonicalReasoningContent(msg['content'])) {
        continue;
      }
      const accumulatedContent = accumulateContent(current['content'], msg['content'], mode);
      if (targetId && isFinalCanonicalReasoningContent(msg['content'])) canonicalMessageIds?.add(targetId);
      const incomingReasoningSource = 'reasoning' in msg
        ? msg['reasoning']
        : (Array.isArray(msg['content']) ? msg['content'] : undefined);
      const accumulatedReasoning = accumulateReasoning(current['reasoning'], incomingReasoningSource);
      const next: Msg = { ...msg, content: accumulatedContent };
      next['reasoning'] = accumulatedReasoning;
      if (existingId) next['id'] = existingId;
      const changed = mode === 'delta' || messageChangedForDelivery(current, next);
      merged[idx] = next;
      if (targetId && changed) affectedMessageIds?.add(targetId);
    } else {
      const initialReasoningSource = 'reasoning' in msg
        ? msg['reasoning']
        : (Array.isArray(msg['content']) ? msg['content'] : undefined);
      const next: Msg = { ...msg };
      next['reasoning'] = accumulateReasoning(undefined, initialReasoningSource);
      merged.push(next);
      const nextId = next['id'];
      if (typeof nextId === 'string') affectedMessageIds?.add(nextId);
    }
  }
  return collapseAdjacentAi(merged, affectedMessageIds, allowCrossIdAiMerge);
}

function preserveIds(existing: Msg[], incoming: Msg[], affectedMessageIds?: Set<string>): Msg[] {
  if (existing.length === 0) {
    for (const message of incoming) {
      const id = message['id'];
      if (typeof id === 'string') affectedMessageIds?.add(id);
    }
    return collapseAdjacentAi(incoming, affectedMessageIds);
  }
  const usedExisting = new Set<number>();
  const remapped = incoming.map((msg, i) => {
    const inId = msg['id'];
    let matchIdx = -1;
    if (i < existing.length && !usedExisting.has(i) && sameRoleAndContent(existing[i]!, msg)) {
      matchIdx = i;
    } else {
      matchIdx = existing.findIndex((m, j) => !usedExisting.has(j) && sameRoleAndContent(m, msg));
    }
    if (matchIdx < 0) {
      if (typeof inId === 'string') affectedMessageIds?.add(inId);
      return msg;
    }
    usedExisting.add(matchIdx);
    const existingId = existing[matchIdx]!['id'];
    const remappedMessage = !existingId || existingId === inId ? msg : { ...msg, id: existingId };
    if (typeof existingId === 'string' && messageChangedForDelivery(existing[matchIdx]!, remappedMessage)) {
      affectedMessageIds?.add(existingId);
    }
    return remappedMessage;
  });
  return collapseAdjacentAi(remapped, affectedMessageIds);
}

function messageChangedForDelivery(existing: Msg, incoming: Msg): boolean {
  if (normalizeMessageType(existing['type']) !== normalizeMessageType(incoming['type'])
      || extractText(existing['content']) !== extractText(incoming['content'])) {
    return true;
  }
  const existingReasoning = typeof existing['reasoning'] === 'string' ? existing['reasoning'] : extractReasoning(existing['reasoning']);
  const incomingReasoning = typeof incoming['reasoning'] === 'string' ? incoming['reasoning'] : extractReasoning(incoming['reasoning']);
  if (existingReasoning !== incomingReasoning) return true;
  return JSON.stringify(existing['tool_calls'] ?? null) !== JSON.stringify(incoming['tool_calls'] ?? null);
}

function contentKey(content: unknown): unknown {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function sameRoleAndContent(a: Msg, b: Msg): boolean {
  const aType = normalizeMessageType(a['type']);
  if (aType !== normalizeMessageType(b['type'])) return false;
  const aContent = contentKey(a['content']);
  const bContent = contentKey(b['content']);
  if (aContent === bContent) return true;
  if (aType === 'ai' && typeof aContent === 'string' && typeof bContent === 'string') {
    return aContent.length > 0 && (bContent.startsWith(aContent) || aContent.startsWith(bContent));
  }
  return false;
}

function findContentMatch(merged: Msg[], incoming: Msg): number {
  const inType = normalizeMessageType(incoming['type']);
  const inContent = contentKey(incoming['content']);
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i]!;
    const mType = normalizeMessageType(m['type']);
    if (mType !== inType) continue;
    const mContent = contentKey(m['content']);
    if (inType === 'human' && mContent === inContent) return i;
    if (inType === 'ai') {
      const aSafe = typeof mContent === 'string' ? mContent : '';
      const bSafe = typeof inContent === 'string' ? inContent : '';
      if (aSafe.length === 0 || bSafe.length === 0) continue;
      if (mContent === inContent || aSafe.startsWith(bSafe) || bSafe.startsWith(aSafe)) return i;
    }
  }
  return -1;
}
