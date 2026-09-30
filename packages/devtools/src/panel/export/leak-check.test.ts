/**
 * E6 — the independent leak check that gates a redacted export.
 *
 * This file deliberately RESTATES requirements §11's five groups — text deltas, reasoning
 * content, tool arguments, tool results, and state values — instead of importing anything from
 * `redact.ts`. A check that shares its subject's definition of the answer verifies nothing: it
 * would agree with the redactor about which fields exist, and therefore agree with it about which
 * fields do not.
 *
 * That is not hypothetical here. On 2026-08-15 `redact.ts`'s first consumer shipped a hole its
 * own tests could not see — `RUN_STARTED.input` echoes the whole `RunAgentInput`, so a live
 * recording carried the user's prompt through a redactor that every hand-written fixture agreed
 * was complete (`packages/harness/record.ts`, `leakedValues`). Export is `redact.ts`'s second
 * consumer, and the only one whose entire purpose is handing a file to another human. So the same
 * gate is restated here, over the lines an export actually writes: the request line as well as
 * the events, because the request line is where the user's own message lives.
 *
 * If `redact.ts` ever stops covering a field this file names, this fails. If the protocol grows a
 * payload field, this file is where it has to be added — and the failure is the reminder.
 */
import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import lgReasoningJsonl from '../../test/fixtures/lg-reasoning.agui.jsonl?raw';
import { aiChunk, langGraphJsonl } from '../../test/langgraph-capture';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import type { JsonlLine } from '../../core/jsonl/codec';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport, type ExportSource } from './build';

const OPTIONS = { toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every string leaf under `value`, however deeply nested. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
}

/**
 * Fields §11 promises survive: structure, not content. Restated here rather than imported, for
 * the reason at the top of this file. `role`, `name`, `toolCallName`, `stepName`, `activityType`,
 * `code` and `source` are developer-authored labels, not anything a user typed or a model wrote.
 *
 * Everything NOT on this list is treated as payload by `eventPayload` below. That makes this
 * check fail closed the same way the export must: @ag-ui/core's `BaseEventSchema` is
 * `.passthrough()`, so any event may carry fields no schema names, and the optional `rawEvent`
 * that every event may carry is typically the upstream provider's own chunk, content and all.
 */
const STRUCTURAL_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'timestamp',
  'threadId',
  'runId',
  'parentRunId',
  'messageId',
  'parentMessageId',
  'toolCallId',
  'toolCallName',
  'entityId',
  'subtype',
  'role',
  'name',
  'stepName',
  'activityType',
  'replace',
  'code',
  'source',
  // Not in the schema, but CopilotKit sends it on `RUN_STARTED` and it names the agent.
  'agentId',
]);

/** Every string leaf of `value` except the top-level keys `keep` names. */
function leavesExcept(value: unknown, keep: readonly string[], out: string[]): void {
  if (!isObject(value)) {
    stringLeaves(value, out);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!keep.includes(key)) stringLeaves(child, out);
  }
}

/**
 * The payload strings one message carries, in a `MESSAGES_SNAPSHOT` or a `RunAgentInput`.
 *
 * `id`, `role`, `name`, `toolCallId` and `activityType` are structure; a tool call keeps its `id`,
 * `type` and function `name`. Everything else — `content` whatever the role, `encryptedValue`, a
 * tool message's `error`, a tool call's arguments — is payload.
 */
function messagePayload(message: unknown, out: string[]): void {
  if (!isObject(message)) {
    stringLeaves(message, out);
    return;
  }
  for (const [key, child] of Object.entries(message)) {
    if (['id', 'role', 'name', 'toolCallId', 'activityType'].includes(key)) continue;
    if (key === 'toolCalls' && Array.isArray(child)) {
      for (const call of child) {
        if (!isObject(call)) {
          stringLeaves(call, out);
          continue;
        }
        for (const [callKey, callChild] of Object.entries(call)) {
          if (callKey === 'id' || callKey === 'type') continue;
          if (callKey === 'function') leavesExcept(callChild, ['name'], out);
          else stringLeaves(callChild, out);
        }
      }
      continue;
    }
    stringLeaves(child, out);
  }
}

/**
 * The top-level `RunAgentInput` keys `inputPayload` restates by field; `threadId`, `runId`,
 * `parentRunId` and `tools` are structure.
 */
const AGUI_BODY_KNOWN: ReadonlySet<string> = new Set([
  'threadId',
  'runId',
  'parentRunId',
  'tools',
  'messages',
  'state',
  'context',
  'forwardedProps',
  'resume',
]);

/** LangGraph Platform run settings: which assistant, which stream modes, how to schedule. */
const LG_SETTINGS: ReadonlySet<string> = new Set([
  'assistant_id',
  'stream_mode',
  'stream_subgraphs',
  'stream_resumable',
  'multitask_strategy',
  'on_completion',
  'on_disconnect',
  'if_not_exists',
  'after_seconds',
  'durability',
  'checkpoint_during',
  'interrupt_before',
  'interrupt_after',
  'feedback_keys',
  'checkpoint_id',
]);

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isScalarOrList(value: unknown): boolean {
  return isScalar(value) || (Array.isArray(value) && value.every(isScalar));
}

/**
 * The payload strings a `RunAgentInput` carries, wherever one appears: the captured request body,
 * or the copy the protocol echoes back in `RUN_STARTED.input`.
 *
 * `threadId`, `runId`, `parentRunId` and `tools` survive redaction by design — §11 names no
 * group that owns developer-authored structure — so treating them as payload would report a leak
 * on every clean export. A `resume` entry keeps its `interruptId` and `status`; its `payload`
 * is the user's answer to an interrupt.
 *
 * Any other top-level key is content nobody classified — unless it is a LangGraph Platform run
 * setting (`assistant_id`, `stream_mode`, …) holding a name, a flag or a list of them. A LangGraph
 * body behind a proxy path is classified AG-UI and its settings are then redacted too; that is
 * over-redaction, not a leak, so not listed. On a request line, a LangGraph body's `input` and
 * `command` are `lgOwners`'s (see `payloadStrings`).
 */
function inputPayload(input: unknown, out: string[]): void {
  if (!isObject(input)) return;
  for (const [key, child] of Object.entries(input)) {
    if (['threadId', 'runId', 'parentRunId', 'tools'].includes(key)) continue;
    if (LG_SETTINGS.has(key) && isScalarOrList(child)) continue;
    if (key === 'messages' && Array.isArray(child)) {
      for (const message of child) messagePayload(message, out);
    } else if (key === 'resume' && Array.isArray(child)) {
      for (const entry of child) leavesExcept(entry, ['interruptId', 'status'], out);
    } else {
      stringLeaves(child, out);
    }
  }
}

/** A JSON Patch keeps its `op`, `path` and `from`: those are what decide whether it applies. */
function patchPayload(ops: unknown, out: string[]): void {
  if (!Array.isArray(ops)) {
    stringLeaves(ops, out);
    return;
  }
  for (const op of ops) leavesExcept(op, ['op', 'path', 'from'], out);
}

/** A `RUN_FINISHED.outcome` keeps its `type`, and each interrupt its ids and expiry. */
function outcomePayload(outcome: unknown, out: string[]): void {
  if (!isObject(outcome)) {
    stringLeaves(outcome, out);
    return;
  }
  for (const [key, child] of Object.entries(outcome)) {
    if (key === 'type') continue;
    if (key === 'interrupts' && Array.isArray(child)) {
      for (const interrupt of child) {
        leavesExcept(interrupt, ['id', 'toolCallId', 'expiresAt'], out);
      }
    } else {
      stringLeaves(child, out);
    }
  }
}

/**
 * The payload strings one event carries. §11's five groups, restated — plus everything no group
 * can claim (a `CUSTOM` value, a `RAW` event, `rawEvent`, a run's error message and result),
 * which a redacted export must not carry either.
 */
function eventPayload(event: unknown, out: string[]): void {
  if (!isObject(event)) return;
  const type = typeof event.type === 'string' ? event.type : '';
  for (const [key, child] of Object.entries(event)) {
    if (STRUCTURAL_EVENT_FIELDS.has(key)) continue;
    if (type === 'RUN_STARTED' && key === 'input') inputPayload(child, out);
    else if (type === 'MESSAGES_SNAPSHOT' && key === 'messages' && Array.isArray(child)) {
      for (const message of child) messagePayload(message, out);
    } else if (type === 'STATE_DELTA' && key === 'delta') patchPayload(child, out);
    else if (type === 'ACTIVITY_DELTA' && key === 'patch') patchPayload(child, out);
    else if (type === 'RUN_FINISHED' && key === 'outcome') outcomePayload(child, out);
    else stringLeaves(child, out);
  }
}

/*
 * LangGraph Platform, restated (spec L16). Not imported from `redact.ts` for the same reason as
 * everything above: a LangGraph frame is a `[chunk, meta]` tuple, a state snapshot or a node
 * write, dispatched on the mode its SSE event name carries, and this file says independently
 * which of its strings each §11 group owns.
 *
 * Each string is listed with its OWNERS — the groups any one of which must remove it. Content no
 * single group owns (`additional_kwargs`, a meta key LangGraph did not write, a `custom` payload,
 * request `config`) is owned by every group: selecting any one removes it.
 */
type Owned = readonly [string, readonly RedactionGroup[]];
const ANY: readonly RedactionGroup[] = ALL_REDACTION_GROUPS;

function owns(value: unknown, owners: readonly RedactionGroup[], out: Owned[]): void {
  const leaves: string[] = [];
  stringLeaves(value, leaves);
  for (const text of leaves) out.push([text, owners]);
}

/** `extra` adds owners: a message inside graph state is the state's as well as its own group's. */
function lcMessageOwners(message: unknown, extra: readonly RedactionGroup[], out: Owned[]): void {
  if (!isObject(message)) {
    owns(message, ANY, out);
    return;
  }
  const kind = typeof message.type === 'string' ? message.type : '';
  const textGroup: RedactionGroup = kind === 'tool' || kind === 'ToolMessage' || kind === 'ToolMessageChunk' ? 'toolResults' : 'text';
  const plus = (group: RedactionGroup): RedactionGroup[] => [group, ...extra];
  // A human message's `name` is the user's handle; an AI or tool message's is the developer's.
  const human = ['human', 'HumanMessage', 'HumanMessageChunk'].includes(kind) || message.role === 'user' || message.role === 'human';
  if (human) owns(message.name, plus('text'), out);
  // A structure slot holding anything but a scalar is not structure: every group removes it.
  const slot = (value: unknown): void => {
    if (!isScalar(value)) owns(value, ANY, out);
  };
  for (const key of ['type', 'role', 'id', 'tool_call_id', 'status', 'chunk_position', ...(human ? [] : ['name'])]) slot(message[key]);
  if (isObject(message.response_metadata)) {
    for (const key of ['finish_reason', 'stop_reason', 'model_name', 'model', 'model_provider', 'system_fingerprint', 'service_tier', 'id']) {
      slot(message.response_metadata[key]);
    }
  }
  if (typeof message.content === 'string') owns(message.content, plus(textGroup), out);
  else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      // A bare string element is text, as LangChain reads it; any other non-object is unclassified.
      if (typeof block === 'string') owns(block, plus(textGroup), out);
      else if (!isObject(block)) owns(block, ANY, out);
      else {
        if (['text', 'reasoning', 'thinking'].includes(block.type as string)) for (const key of ['id', 'index']) slot(block[key]);
        if (block.type === 'text') owns(block.text, plus(textGroup), out);
        else if (block.type === 'reasoning') {
          if (Array.isArray(block.summary)) for (const part of block.summary) if (isObject(part)) owns(part.text, plus('reasoning'), out);
          owns(block.reasoning, plus('reasoning'), out);
        } else if (block.type === 'thinking') owns(block.thinking, plus('reasoning'), out);
        else owns(block, ANY, out);
      }
    }
  } else {
    // Content that is neither a string nor a list of blocks is not known to belong to one group.
    owns(message.content, ANY, out);
  }
  for (const key of ['tool_call_chunks', 'tool_calls', 'invalid_tool_calls']) {
    const calls = message[key];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!isObject(call)) continue;
      owns(call.args, plus('toolArgs'), out);
      for (const slotKey of ['name', 'id', 'type', 'index']) slot(call[slotKey]);
    }
  }
  owns(message.artifact, plus('toolResults'), out);
  owns(message.additional_kwargs, ANY, out);
}

/** Graph state: every value is the state's; the messages in it are also their own groups'. */
function stateOwners(state: unknown, out: Owned[], also: readonly RedactionGroup[] = []): void {
  const owners: RedactionGroup[] = ['state', ...also];
  if (!isObject(state)) {
    owns(state, owners, out);
    return;
  }
  for (const [key, value] of Object.entries(state)) {
    if (key === 'messages' && Array.isArray(value)) {
      for (const message of value) lcMessageOwners(message, owners, out);
    } else {
      owns(value, owners, out);
    }
  }
}

/**
 * The meta keys LangGraph itself writes; anything else came from the run's config. The
 * authenticated user (`langgraph_auth_*`) is LangGraph-prefixed but is the platform copying the
 * run's `configurable` in: who the user is, not how the graph ran.
 */
function lgMetaOwners(meta: unknown, out: Owned[]): void {
  if (!isObject(meta)) return;
  const own = new Set(['run_id', 'thread_id', 'graph_id', 'assistant_id', 'checkpoint_ns', 'created_by']);
  for (const [key, value] of Object.entries(meta)) {
    const langGraphs = key.startsWith('langgraph_') && !key.startsWith('langgraph_auth');
    if (!langGraphs && !key.startsWith('ls_') && !own.has(key)) owns(value, ANY, out);
  }
}

/** The strings one LangGraph export line carries, each with its owners. */
function lgOwners(line: JsonlLine): Owned[] {
  const out: Owned[] = [];
  if (line.kind === 'request') {
    const body = line.input;
    // A body that is not an object at all is content nobody classified.
    if (!isObject(body)) {
      owns(body, ANY, out);
      return out;
    }
    if (isObject(body.input)) {
      // The graph's input schema beyond `messages` (a RAG graph's `question`) is the user's words
      // as much as it is state: `text` and `state` both own it.
      stateOwners(Object.fromEntries(Object.entries(body.input).filter(([key]) => key !== 'messages')), out, ['text']);
      // The prompt, in any form `add_messages` accepts: a list, one message, or a bare string.
      const messages = body.input.messages;
      if (Array.isArray(messages)) for (const message of messages) lcMessageOwners(message, [], out);
      else if (messages !== undefined) lcMessageOwners(messages, [], out);
    } else {
      owns(body.input, ANY, out);
    }
    if (isObject(body.command)) {
      for (const [key, value] of Object.entries(body.command)) {
        if (key === 'resume') owns(value, ['text'], out);
        else if (key === 'update') owns(value, ['state'], out);
        else if (key === 'goto') {
          // `goto` names nodes, or `Send`s a node its input: that input is state.
          for (const each of Array.isArray(value) ? value : [value]) {
            if (typeof each === 'string') continue;
            if (!isObject(each)) {
              owns(each, ANY, out);
              continue;
            }
            for (const [sendKey, sendValue] of Object.entries(each)) {
              if (sendKey === 'node' && typeof sendValue === 'string') continue;
              if (sendKey === 'input' || sendKey === 'arg') stateOwners(sendValue, out);
              else owns(sendValue, ANY, out);
            }
          }
        } else owns(value, ANY, out);
      }
    } else {
      owns(body.command, ANY, out);
    }
    // `config`, `context`, `metadata`, `checkpoint`, `webhook`, anything unheard of — and a setting
    // that holds more than names and flags: every group removes it.
    // (A `RunAgentInput`'s own keys are `inputPayload`'s: this reader runs on every request line.)
    for (const [key, value] of Object.entries(body)) {
      if (key === 'input' || key === 'command' || AGUI_BODY_KNOWN.has(key)) continue;
      if (LG_SETTINGS.has(key) && isScalarOrList(value)) continue;
      owns(value, ANY, out);
    }
    return out;
  }
  if (line.kind !== 'event') return out;
  const payload = line.event;
  const mode = (line.sseEvent ?? '').split('|')[0];
  switch (mode) {
    case 'metadata':
      // The run's identity; a key beyond it is one no reader here has classified.
      if (isObject(payload)) {
        for (const [key, value] of Object.entries(payload)) {
          if (!['run_id', 'attempt', 'thread_id', 'assistant_id'].includes(key) || !isScalar(value)) owns(value, ANY, out);
        }
      }
      break;
    case 'messages':
      if (Array.isArray(payload)) {
        lcMessageOwners(payload[0], [], out);
        lgMetaOwners(payload[1], out);
      }
      break;
    case 'messages/partial':
    case 'messages/complete':
      if (Array.isArray(payload)) for (const message of payload) lcMessageOwners(message, [], out);
      break;
    case 'values':
      stateOwners(payload, out);
      break;
    case 'updates':
      if (isObject(payload)) {
        for (const [node, write] of Object.entries(payload)) {
          if (node === '__interrupt__') owns(write, ['state'], out);
          else stateOwners(write, out);
        }
      }
      break;
    case 'error':
      if (isObject(payload)) {
        owns(payload.message, ANY, out);
        if (typeof payload.error !== 'string') owns(payload.error, ANY, out);
      }
      break;
    default:
      // `custom`, `debug`, `tasks`, anything unclassified: every group removes it.
      owns(payload, ANY, out);
  }
  return out;
}

/**
 * The owners of each string across `lines`. A string at two places is removed by a group only if
 * that group removes it at both, so its owners are the intersection.
 */
function ownersAcross(lines: readonly JsonlLine[]): Map<string, readonly RedactionGroup[]> {
  const owners = new Map<string, readonly RedactionGroup[]>();
  for (const line of lines) {
    for (const [text, groups] of lgOwners(line)) {
      if (text.trim().length < 3) continue;
      const before = owners.get(text);
      owners.set(text, before === undefined ? groups : before.filter((group) => groups.includes(group)));
    }
  }
  return owners;
}

/** Every payload string one export line carries, before redaction. */
function payloadStrings(line: JsonlLine): string[] {
  const out: string[] = [];
  // A named line is a LangGraph Platform frame (no AG-UI line in these captures is named).
  if (line.kind === 'event' && line.sseEvent !== undefined) {
    out.push(...lgOwners(line).map(([text]) => text));
  } else if (line.kind === 'event') {
    eventPayload(line.event, out);
  }
  // The request line is half of what a bug report leaks: the user's own message is in the POST
  // body and in no event at all.
  if (line.kind === 'request') {
    // A LangGraph Platform body's `input` and `command` are LangChain-shaped, with structure of
    // their own (a message's `type` and `id`), so `lgOwners` restates them rather than the
    // `RunAgentInput` walk, which would count that structure as payload. Every other key goes
    // through both walks.
    const body = isObject(line.input)
      ? Object.fromEntries(Object.entries(line.input).filter(([key]) => key !== 'input' && key !== 'command'))
      : line.input;
    inputPayload(body, out);
    out.push(...lgOwners(line).map(([text]) => text));
  }
  // Two characters cannot identify anyone and a stream is full of them; a short delta's LENGTH
  // survives redaction by design anyway, so the placeholder itself would match.
  return out.filter((text) => text.trim().length >= 3);
}

/**
 * Payload strings from `raw` that still appear verbatim among `redacted`'s string leaves.
 *
 * Leaf against leaf rather than against `JSON.stringify(redacted)`: serializing escapes the quotes
 * in a `TOOL_CALL_ARGS` delta — which carries JSON — so a substring search for the original text
 * would miss it and this gate would pass silently. That exact mistake is recorded in
 * `packages/harness/record.ts`.
 */
function leakedValues(raw: readonly JsonlLine[], redacted: readonly JsonlLine[]): string[] {
  const survivors: string[] = [];
  // The header's `redacted` list names the groups that ran — `text` among them — which is the
  // export describing itself, not captured content surviving. Left in, a user message part's
  // `{"type":"text"}` would read as a leak on every redacted export.
  for (const line of redacted) {
    stringLeaves(line.kind === 'header' ? { ...line, redacted: [] } : line, survivors);
  }
  const leaks = new Set<string>();
  for (const line of raw) {
    for (const text of payloadStrings(line)) {
      // `includes`, not equality: a payload embedded in a larger string is still a leak.
      if (survivors.some((survivor) => survivor.includes(text))) leaks.add(text);
    }
  }
  return [...leaks];
}

/**
 * A capture with something from every one of §11's five groups, plus the `RUN_STARTED.input`
 * echo that the redactor's first consumer missed.
 */
const EVERY_GROUP = [
  '{"kind":"header","schemaVersion":1,"tool":"t","capturedAt":"2026-08-15T00:00:00.000Z","url":"http://localhost:3000/","transport":"sse","redacted":[]}',
  '{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/run","input":{"threadId":"t1","runId":"r1","messages":[{"id":"u1","role":"user","content":"my private prompt about acquisition targets"},{"id":"a1","role":"assistant","toolCalls":[{"id":"tc0","function":{"name":"search","arguments":"{\\"q\\":\\"confidential query string\\"}"}}]},{"id":"t0","role":"tool","content":"a previous tool result with numbers"}],"state":{"apiToken":"sk-live-not-a-real-secret"},"context":[{"description":"the customer name is Contoso"}],"forwardedProps":{"session":"forwarded secret value"}}}',
  '{"kind":"event","connId":"c1","seq":1,"tMs":1,"event":{"type":"RUN_STARTED","threadId":"t1","runId":"r1","input":{"threadId":"t1","runId":"r1","messages":[{"id":"u1","role":"user","content":"my private prompt about acquisition targets"}],"state":{"apiToken":"sk-live-not-a-real-secret"},"context":[{"description":"the customer name is Contoso"}],"forwardedProps":{"session":"forwarded secret value"}}}}',
  '{"kind":"event","connId":"c1","seq":2,"tMs":2,"event":{"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}}',
  '{"kind":"event","connId":"c1","seq":3,"tMs":3,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"the answer mentions a real customer"}}',
  '{"kind":"event","connId":"c1","seq":4,"tMs":4,"event":{"type":"TEXT_MESSAGE_END","messageId":"m1"}}',
  '{"kind":"event","connId":"c1","seq":5,"tMs":5,"event":{"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","delta":"a chunked fragment of prose"}}',
  '{"kind":"event","connId":"c1","seq":6,"tMs":6,"event":{"type":"REASONING_MESSAGE_START","messageId":"rm1"}}',
  '{"kind":"event","connId":"c1","seq":7,"tMs":7,"event":{"type":"REASONING_MESSAGE_CONTENT","messageId":"rm1","delta":"the model is thinking about the customer"}}',
  '{"kind":"event","connId":"c1","seq":8,"tMs":8,"event":{"type":"REASONING_MESSAGE_CHUNK","messageId":"rm2","delta":"more private deliberation"}}',
  '{"kind":"event","connId":"c1","seq":9,"tMs":9,"event":{"type":"REASONING_ENCRYPTED_VALUE","messageId":"rm1","encryptedValue":"opaque-but-still-not-ours-to-share"}}',
  '{"kind":"event","connId":"c1","seq":10,"tMs":10,"event":{"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"search"}}',
  '{"kind":"event","connId":"c1","seq":11,"tMs":11,"event":{"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\\"query\\":\\"internal revenue figures\\"}"}}',
  '{"kind":"event","connId":"c1","seq":12,"tMs":12,"event":{"type":"TOOL_CALL_END","toolCallId":"tc1"}}',
  '{"kind":"event","connId":"c1","seq":13,"tMs":13,"event":{"type":"TOOL_CALL_CHUNK","toolCallId":"tc2","toolCallName":"lookup","delta":"{\\"id\\":\\"chunked argument payload\\"}"}}',
  '{"kind":"event","connId":"c1","seq":14,"tMs":14,"event":{"type":"TOOL_CALL_RESULT","messageId":"m3","toolCallId":"tc1","role":"tool","content":"{\\"revenue\\":\\"the actual number nobody should see\\"}"}}',
  '{"kind":"event","connId":"c1","seq":15,"tMs":15,"event":{"type":"STATE_SNAPSHOT","snapshot":{"customer":"Contoso Ltd","notes":["a note with real content"]}}}',
  '{"kind":"event","connId":"c1","seq":16,"tMs":16,"event":{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/customer","value":"Fabrikam Inc"},{"op":"add","path":"/notes/-","value":"a second real note"}]}}',
  '{"kind":"event","connId":"c1","seq":17,"tMs":17,"event":{"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}}',
  '',
].join('\n');

/**
 * The rest of the protocol's content: every field that is neither one of `EVERY_GROUP`'s single
 * payload fields nor structure, as of @ag-ui/core 0.0.57.
 *
 * Until LangGraph PR 4 each of these shipped verbatim with every group selected, disclosed in a
 * PRIVACY.md caveat: a `MESSAGES_SNAPSHOT`'s messages (whose content belongs to a different group
 * per role), the deprecated `THINKING_*` events, activities, `CUSTOM` and `RAW`, a run's error
 * message, result and interrupt outcome, a `resume` answer on the request, an unknown passthrough
 * field, and the `rawEvent` any event may carry — here on a `TEXT_MESSAGE_CONTENT`, whose own
 * `delta` the redactor already understood.
 */
const EVERY_OTHER_FIELD = [
  JSON.stringify({
    kind: 'header',
    schemaVersion: 1,
    tool: 't',
    capturedAt: '2026-09-30T00:00:00.000Z',
    url: 'http://localhost:3000/',
    transport: 'sse',
    redacted: [],
  }),
  JSON.stringify({
    kind: 'request',
    connId: 'c1',
    tMs: 0,
    method: 'POST',
    url: '/run',
    input: {
      threadId: 't1',
      runId: 'r1',
      messages: [
        {
          id: 'u0',
          role: 'user',
          content: 'request user prompt',
          encryptedValue: 'request encrypted blob',
        },
      ],
      resume: [
        {
          interruptId: 'int0',
          status: 'resolved',
          payload: { answer: 'resume payload the user typed' },
        },
      ],
    },
  }),
  ...[
    { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
    {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 's1', role: 'system', content: 'system prompt with house rules' },
        { id: 'd1', role: 'developer', content: 'developer instructions verbatim' },
        { id: 'u1', role: 'user', name: 'ada', content: 'snapshot user prompt text' },
        {
          id: 'u2',
          role: 'user',
          content: [
            { type: 'text', text: 'multimodal user part' },
            { type: 'binary', mimeType: 'image/png', data: 'base64 image bytes here' },
          ],
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'snapshot assistant reply',
          toolCalls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"snapshot tool arguments"}' },
              encryptedValue: 'encrypted tool call reasoning',
            },
          ],
        },
        {
          id: 'tm1',
          role: 'tool',
          toolCallId: 'tc1',
          content: 'snapshot tool result body',
          error: 'snapshot tool error text',
        },
        {
          id: 'rm1',
          role: 'reasoning',
          content: 'snapshot reasoning body',
          encryptedValue: 'encrypted reasoning blob',
        },
        {
          id: 'am1',
          role: 'activity',
          activityType: 'progress',
          content: { status: 'activity message content' },
        },
      ],
    },
    { type: 'THINKING_START', title: 'thinking title text' },
    { type: 'THINKING_TEXT_MESSAGE_START' },
    { type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: 'deprecated thinking delta' },
    { type: 'THINKING_TEXT_MESSAGE_END' },
    { type: 'THINKING_END' },
    {
      type: 'ACTIVITY_SNAPSHOT',
      messageId: 'am2',
      activityType: 'search',
      content: { query: 'activity snapshot content' },
    },
    {
      type: 'ACTIVITY_DELTA',
      messageId: 'am2',
      activityType: 'search',
      patch: [{ op: 'replace', path: '/query', value: 'activity patch value' }],
    },
    { type: 'CUSTOM', name: 'app.event', value: { note: 'custom event value' } },
    { type: 'RAW', source: 'provider', event: { chunk: 'raw provider chunk' } },
    { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'hi there friend',
      rawEvent: { choices: [{ delta: { content: 'rawEvent echo of a delta' } }] },
    },
    { type: 'TEXT_MESSAGE_END', messageId: 'm1', extraField: 'an unknown passthrough field' },
    {
      type: 'RUN_FINISHED',
      threadId: 't1',
      runId: 'r1',
      result: { answer: 'run finished result' },
      outcome: {
        type: 'interrupt',
        interrupts: [
          {
            id: 'int1',
            reason: 'approval needed for wire',
            message: 'interrupt message to user',
            toolCallId: 'tc1',
            responseSchema: { description: 'response schema text' },
            expiresAt: '2026-10-01T00:00:00.000Z',
            metadata: { k: 'interrupt metadata value' },
          },
        ],
      },
    },
    { type: 'RUN_STARTED', threadId: 't1', runId: 'r2' },
    { type: 'RUN_ERROR', code: 'RATE_LIMITED', message: 'run error message with detail' },
  ].map((event, index) =>
    JSON.stringify({ kind: 'event', connId: 'c1', seq: index + 1, tMs: index + 1, event }),
  ),
  '',
].join('\n');

/**
 * `EVERY_OTHER_FIELD`'s payload strings, by the group that owns them. §11 has five groups; what
 * no group can claim — content whose meaning the extension cannot know — is `anyGroup`: removed
 * by selecting any one of them, because guessing which group it belongs to and guessing wrong
 * would ship it.
 */
const OTHER_BY_GROUP: Record<RedactionGroup | 'anyGroup', string[]> = {
  text: [
    'request user prompt',
    'system prompt with house rules',
    'developer instructions verbatim',
    'snapshot user prompt text',
    'multimodal user part',
    'base64 image bytes here',
    'snapshot assistant reply',
    'hi there friend',
  ],
  reasoning: [
    'request encrypted blob',
    'encrypted tool call reasoning',
    'snapshot reasoning body',
    'encrypted reasoning blob',
    'thinking title text',
    'deprecated thinking delta',
  ],
  toolArgs: ['{"q":"snapshot tool arguments"}'],
  toolResults: ['snapshot tool result body', 'snapshot tool error text'],
  state: ['activity message content', 'activity snapshot content', 'activity patch value'],
  anyGroup: [
    'resume payload the user typed',
    'custom event value',
    'raw provider chunk',
    'rawEvent echo of a delta',
    'an unknown passthrough field',
    'run finished result',
    'approval needed for wire',
    'interrupt message to user',
    'response schema text',
    'interrupt metadata value',
    'run error message with detail',
  ],
};

/**
 * A LangGraph Platform capture whose request body carries a long prompt, a resume `command`, a
 * `config` holding a token and private `metadata` — the fields a LangGraph body has that a
 * `RunAgentInput` does not.
 */
const LANGGRAPH = langGraphJsonl(
  [
    { event: 'metadata', data: { run_id: 'r-lg', attempt: 1 } },
    aiChunk('m1', 'ok'),
    { event: 'values', data: { messages: [] } },
  ],
  {
    body: {
      assistant_id: 'agent',
      input: {
        messages: [{ type: 'human', content: 'what are the terms of the confidential merger' }],
      },
      command: { resume: 'approve the secret plan' },
      config: { configurable: { user_token: 'sk-secret-123' } },
      metadata: { note: 'private notes about the user' },
      stream_mode: ['values', 'messages-tuple'],
    },
  },
);

function sourceOf(text: string): ExportSource {
  const loaded = loadJsonl(text);
  return {
    records: loaded.records,
    requests: loaded.requests,
    runs: loaded.runs,
    importedHeader: loaded.header,
    runtime: loaded.runtime,
    framework: null,
    binaryTransport: null,
    source: { kind: 'imported', filename: 'capture.agui.jsonl', importedAtMs: 0 },
  };
}

function exportWith(text: string, groups: RedactionGroup[]): JsonlLine[] {
  return buildExport(sourceOf(text), { scope: null, groups, ...OPTIONS }).lines;
}

describe('the leak check itself', () => {
  test('finds a payload string that survived, or it is not a gate at all', () => {
    // An "export" that redacted nothing must be reported as leaking. Without this the whole file
    // could be vacuously green — which is the failure mode E6 exists to rule out.
    const unredacted = exportWith(EVERY_GROUP, []);
    expect(leakedValues(unredacted, unredacted).sort()).toEqual(
      [
        'a chunked fragment of prose',
        'a note with real content',
        'a previous tool result with numbers',
        'a second real note',
        'forwarded secret value',
        'my private prompt about acquisition targets',
        'opaque-but-still-not-ours-to-share',
        'sk-live-not-a-real-secret',
        '{"revenue":"the actual number nobody should see"}',
        'the answer mentions a real customer',
        'the customer name is Contoso',
        'the model is thinking about the customer',
        '{"id":"chunked argument payload"}',
        '{"q":"confidential query string"}',
        '{"query":"internal revenue figures"}',
        'Contoso Ltd',
        'Fabrikam Inc',
        'more private deliberation',
      ].sort(),
    );
  });
});

describe('the leak check sees every field, not only the five groups’ own', () => {
  test('finds every payload string in the rest of the protocol when nothing is redacted', () => {
    const unredacted = exportWith(EVERY_OTHER_FIELD, []);
    // `image/png` is a user message part's MIME type: part of a payload no field-level rule can
    // see into, so it is reported with the rest of that part.
    expect(leakedValues(unredacted, unredacted).sort()).toEqual(
      [...Object.values(OTHER_BY_GROUP).flat(), 'image/png', 'text', 'binary'].sort(),
    );
  });
});

describe('E6: a fully redacted export leaks nothing', () => {
  test('no payload string from any of §11’s five groups survives', () => {
    const raw = exportWith(EVERY_GROUP, []);
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
  });

  test('the same holds for the golden happy-run capture', () => {
    const raw = exportWith(happyJsonl, []);
    const redacted = exportWith(happyJsonl, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
  });

  test('the same holds for every field outside the five groups’ own', () => {
    const raw = exportWith(EVERY_OTHER_FIELD, []);
    const redacted = exportWith(EVERY_OTHER_FIELD, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
  });

  test('a LangGraph request body leaks nothing: prompt, command, config, metadata', () => {
    const raw = exportWith(LANGGRAPH, []);
    // The restatement must see the payload first, or the next assertion is vacuous. The
    // `metadata` frame's run id `r-lg` and the message's `type` `human` are not in this list: since
    // L16 they are LangGraph structure, and survive.
    expect(leakedValues(raw, raw).sort()).toEqual(
      [
        'approve the secret plan',
        'private notes about the user',
        'sk-secret-123',
        'what are the terms of the confidential merger',
      ].sort(),
    );
    const redacted = exportWith(LANGGRAPH, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
  });

  test('the same holds for the real LangGraph reasoning capture, whose prompt is in the body', () => {
    const raw = exportWith(lgReasoningJsonl, []);
    expect(leakedValues(raw, raw).length).toBeGreaterThan(0);
    const redacted = exportWith(lgReasoningJsonl, [...ALL_REDACTION_GROUPS]);
    /*
     * Since L16 structure survives on a LangGraph capture, and two payload strings of this real
     * capture are substrings of it: the reasoning fragment "ing" of the content block type
     * `reasoning`, and the app state's `model: "gpt-5"` of the kept
     * `response_metadata.model_name` "gpt-5-2025-08-07". Neither leaf itself survives: no string
     * in the redacted file EQUALS either.
     */
    const leaks = leakedValues(raw, redacted);
    expect(leaks.sort()).toEqual(['gpt-5', 'ing']);
    const leaves: string[] = [];
    stringLeaves(redacted, leaves);
    for (const leak of leaks) expect(leaves).not.toContain(leak);
  });

  test('a run-scoped redacted export leaks nothing either', () => {
    const source = sourceOf(EVERY_GROUP);
    const raw = buildExport(source, { scope: 'r1', groups: [], ...OPTIONS }).lines;
    const redacted = buildExport(source, {
      scope: 'r1',
      groups: [...ALL_REDACTION_GROUPS],
      ...OPTIONS,
    }).lines;
    expect(leakedValues(raw, redacted)).toEqual([]);
  });
});

describe('E6: each group protects its own payload', () => {
  /**
   * Group by group, because §11 lets the user opt back into full fidelity PER GROUP. A redactor
   * that only worked when all five were selected would leak on every partial choice — and a
   * partial choice is the normal one for a bug report about tool arguments.
   */
  const byGroup: Record<RedactionGroup, string[]> = {
    text: ['the answer mentions a real customer', 'a chunked fragment of prose'],
    reasoning: [
      'the model is thinking about the customer',
      'more private deliberation',
      'opaque-but-still-not-ours-to-share',
    ],
    toolArgs: ['{"query":"internal revenue figures"}', '{"id":"chunked argument payload"}'],
    toolResults: ['{"revenue":"the actual number nobody should see"}'],
    state: ['Contoso Ltd', 'Fabrikam Inc', 'a note with real content', 'a second real note'],
  };

  for (const group of ALL_REDACTION_GROUPS) {
    test(`selecting only \`${group}\` removes everything that group owns`, () => {
      const redacted = exportWith(EVERY_GROUP, [group]);
      const survivors: string[] = [];
      stringLeaves(redacted, survivors);
      for (const secret of byGroup[group]) {
        expect(survivors.some((survivor) => survivor.includes(secret))).toBe(false);
      }
    });
  }
});

describe('E6: each group protects its own share of the rest of the protocol', () => {
  for (const group of ALL_REDACTION_GROUPS) {
    test(`selecting only \`${group}\` removes what it owns and what no group can own`, () => {
      const redacted = exportWith(EVERY_OTHER_FIELD, [group]);
      const survivors: string[] = [];
      stringLeaves(redacted, survivors);
      for (const secret of [...OTHER_BY_GROUP[group], ...OTHER_BY_GROUP.anyGroup]) {
        expect(survivors.some((survivor) => survivor.includes(secret)), secret).toBe(false);
      }
    });

    test(`selecting only \`${group}\` leaves every other group’s content alone`, () => {
      // Per-field ownership is the point: a `MESSAGES_SNAPSHOT` tool message's content is a tool
      // RESULT, so selecting \`text\` must not reach it — or deselecting \`toolResults\` to share
      // a tool bug would silently strip the very thing being reported.
      const redacted = exportWith(EVERY_OTHER_FIELD, [group]);
      const survivors: string[] = [];
      stringLeaves(redacted, survivors);
      for (const other of ALL_REDACTION_GROUPS.filter((g) => g !== group)) {
        for (const kept of OTHER_BY_GROUP[other]) {
          expect(survivors.some((survivor) => survivor.includes(kept)), kept).toBe(true);
        }
      }
    });
  }
});

describe('E6: what must NOT be redacted, or the file stops being a bug report', () => {
  test('structure, ids, ordering and timings survive', () => {
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    const events = redacted.filter((line) => line.kind === 'event');
    expect(events.map((line) => (line.event as { type: string }).type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TEXT_MESSAGE_CHUNK',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CHUNK',
      'REASONING_ENCRYPTED_VALUE',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_CHUNK',
      'TOOL_CALL_RESULT',
      'STATE_SNAPSHOT',
      'STATE_DELTA',
      'RUN_FINISHED',
    ]);
    expect(events.map((line) => line.tMs)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  test('a tool call keeps its NAME — a bug report about the wrong tool needs it', () => {
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    const start = redacted.find(
      (line) => line.kind === 'event' && (line.event as { type: string }).type === 'TOOL_CALL_START',
    );
    expect((start as { event: { toolCallName: string } }).event.toolCallName).toBe('search');
  });

  test('a state patch keeps its JSON Pointer paths and its ops', () => {
    const redacted = exportWith(EVERY_GROUP, [...ALL_REDACTION_GROUPS]);
    const delta = redacted.find(
      (line) => line.kind === 'event' && (line.event as { type: string }).type === 'STATE_DELTA',
    );
    const ops = (delta as { event: { delta: { op: string; path: string }[] } }).event.delta;
    expect(ops.map((op) => `${op.op} ${op.path}`)).toEqual(['replace /customer', 'add /notes/-']);
  });

  test('the rest of the protocol keeps its structure: ids, roles, names, codes, paths', () => {
    const redacted = exportWith(EVERY_OTHER_FIELD, [...ALL_REDACTION_GROUPS]);
    const byType = (type: string): Record<string, unknown> => {
      const line = redacted.find(
        (candidate) =>
          candidate.kind === 'event' && (candidate.event as { type: string }).type === type,
      );
      return (line as { event: Record<string, unknown> }).event;
    };

    const messages = byType('MESSAGES_SNAPSHOT').messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => `${String(m.id)}:${String(m.role)}`)).toEqual([
      's1:system',
      'd1:developer',
      'u1:user',
      'u2:user',
      'a1:assistant',
      'tm1:tool',
      'rm1:reasoning',
      'am1:activity',
    ]);
    expect(messages).toMatchObject([
      {},
      {},
      { name: 'ada' },
      {},
      { toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'search' } }] },
      { toolCallId: 'tc1' },
      {},
      { activityType: 'progress' },
    ]);

    expect(byType('ACTIVITY_DELTA').patch).toEqual([
      { op: 'replace', path: '/query', value: '«redacted: 20 chars»' },
    ]);
    expect(byType('ACTIVITY_SNAPSHOT').activityType).toBe('search');
    expect(byType('CUSTOM').name).toBe('app.event');
    expect(byType('RAW').source).toBe('provider');
    expect(byType('RUN_ERROR').code).toBe('RATE_LIMITED');
    expect(byType('RUN_FINISHED').outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ id: 'int1', toolCallId: 'tc1' }],
    });
  });

  test('the placeholder keeps the size, which is what a protocol bug report is about', () => {
    const redacted = exportWith(EVERY_GROUP, ['text']);
    const content = redacted.find(
      (line) =>
        line.kind === 'event' && (line.event as { type: string }).type === 'TEXT_MESSAGE_CONTENT',
    );
    expect((content as { event: { delta: string } }).event.delta).toBe('«redacted: 35 chars»');
  });
});

describe('E6 for LangGraph Platform (L16, L17): each group removes what it owns, and only that', () => {
  /** A distinct secret per group, each where LangGraph actually puts it. */
  const SECRETS: Record<RedactionGroup, string[]> = {
    text: ['what is the Zanzibar merger price', 'the answer names Contoso', 'the subgraph researched Fabrikam', 'Priya Kowalski'],
    reasoning: ['weighing the Contoso numbers privately'],
    toolArgs: ['{"account":"ACME-7731"}'],
    toolResults: ['revenue was 4.2M for ACME', 'artifact row with ACME ledger'],
    state: ['state note about the Zurich account', 'approve the transfer to Zurich?', 'the Send carries the Zurich ledger'],
  };
  const EVERY: string[] = [
    'meta note the client sent',
    'custom progress for ACME',
    'a metadata key a newer server sent',
    'user-42@example.com',
    'a status slot smuggling ACME',
  ];
  /** The graph's input schema beyond `messages`: the user's words, and state. */
  const TEXT_AND_STATE: string[] = ['the question about the Zanzibar deal'];

  const CAPTURE = langGraphJsonl(
    [
      { event: 'metadata', data: { run_id: 'r-lg', attempt: 1, extra: 'a metadata key a newer server sent' } },
      {
        event: 'messages',
        data: [
          {
            type: 'AIMessageChunk',
            id: 'm1',
            content: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'weighing the Contoso numbers privately' }] }],
            tool_call_chunks: [],
          },
          {
            langgraph_node: 'agent',
            langgraph_step: 1,
            user_note: 'meta note the client sent',
            langgraph_auth_user_id: 'user-42@example.com',
          },
        ],
      },
      aiChunk('m1', [{ type: 'text', text: 'the answer names Contoso' }], { chunk_position: 'last' }),
      {
        event: 'messages|research:t1',
        data: [{ type: 'AIMessageChunk', id: 'm-sub', content: 'the subgraph researched Fabrikam', tool_call_chunks: [], chunk_position: 'last' }, { langgraph_node: 'researcher' }],
      },
      aiChunk('m2', [], {
        tool_call_chunks: [{ index: 0, id: 'call_1', name: 'lookup_revenue', args: '{"account":"ACME-7731"}' }],
        chunk_position: 'last',
      }),
      {
        event: 'messages',
        data: [
          {
            type: 'tool',
            id: 't1',
            name: 'lookup_revenue',
            tool_call_id: 'call_1',
            status: { note: 'a status slot smuggling ACME' },
            content: 'revenue was 4.2M for ACME',
            artifact: { rows: ['artifact row with ACME ledger'] },
          },
          { langgraph_node: 'tools' },
        ],
      },
      { event: 'custom', data: { progress: 'custom progress for ACME' } },
      {
        event: 'values',
        data: {
          messages: [{ type: 'human', id: 'h1', name: 'Priya Kowalski', content: 'what is the Zanzibar merger price' }],
          account_note: 'state note about the Zurich account',
        },
      },
      { event: 'updates', data: { __interrupt__: [{ value: { question: 'approve the transfer to Zurich?' }, id: 'int-1' }] } },
    ],
    {
      body: {
        assistant_id: 'agent',
        input: {
          messages: [{ type: 'human', id: 'h1', name: 'Priya Kowalski', content: 'what is the Zanzibar merger price' }],
          question: 'the question about the Zanzibar deal',
        },
        command: { goto: [{ node: 'ledger', input: { ledger: 'the Send carries the Zurich ledger' } }] },
        stream_mode: ['values', 'messages-tuple', 'updates', 'custom'],
        stream_subgraphs: true,
      },
    },
  );

  const survivors = (lines: readonly JsonlLine[]): string[] => {
    const out: string[] = [];
    stringLeaves(lines, out);
    return out;
  };
  const present = (lines: readonly JsonlLine[], secret: string): boolean =>
    survivors(lines).some((survivor) => survivor.includes(secret));

  test('the restatement sees every secret, with the owners this file says it has', () => {
    const owners = ownersAcross(exportWith(CAPTURE, []));
    for (const group of ALL_REDACTION_GROUPS) {
      for (const secret of SECRETS[group]) expect([secret, owners.get(secret)]).toEqual([secret, [group]]);
    }
    for (const secret of EVERY) expect([secret, owners.get(secret)]).toEqual([secret, ANY]);
    for (const secret of TEXT_AND_STATE) expect([secret, owners.get(secret)]).toEqual([secret, ['state', 'text']]);
  });

  for (const group of ALL_REDACTION_GROUPS) {
    test(`selecting only \`${group}\` removes its secrets and no other group's`, () => {
      const raw = exportWith(CAPTURE, []);
      const redacted = exportWith(CAPTURE, [group]);
      for (const [secret, owners] of ownersAcross(raw)) {
        expect([secret, present(redacted, secret)]).toEqual([secret, !owners.includes(group)]);
      }
      // The hand-written list too, so a secret the restatement lost cannot pass silently.
      for (const secret of SECRETS[group]) expect([secret, present(redacted, secret)]).toEqual([secret, false]);
      for (const other of ALL_REDACTION_GROUPS.filter((each) => each !== group)) {
        for (const secret of SECRETS[other]) expect([secret, present(redacted, secret)]).toEqual([secret, true]);
      }
      for (const secret of EVERY) expect([secret, present(redacted, secret)]).toEqual([secret, false]);
      const textOrState = group === 'text' || group === 'state';
      for (const secret of TEXT_AND_STATE) expect([secret, present(redacted, secret)]).toEqual([secret, !textOrState]);
    });
  }

  test('every group together removes every secret', () => {
    const raw = exportWith(CAPTURE, []);
    const redacted = exportWith(CAPTURE, [...ALL_REDACTION_GROUPS]);
    expect(leakedValues(raw, redacted)).toEqual([]);
    for (const secret of [...Object.values(SECRETS).flat(), ...EVERY, ...TEXT_AND_STATE]) expect(present(redacted, secret)).toBe(false);
  });

  test('a LangGraph body behind a proxy path, classified AG-UI, still loses its content to any group', () => {
    // No LangGraph route in the URL and no `metadata` first: dialect detection says AG-UI, so the
    // body meets the RunAgentInput rules, whose unknown top-level keys fail closed.
    const proxied = langGraphJsonl(
      [{ event: 'values', data: { messages: [{ type: 'human', id: 'h1', content: 'the proxied Zanzibar prompt' }] } }],
      {
        url: 'http://localhost:3000/api/agent',
        body: {
          assistant_id: 'agent',
          input: { messages: [{ type: 'human', content: 'the proxied Zanzibar prompt' }] },
          command: { resume: 'the proxied resume answer' },
        },
      },
    );
    const raw = exportWith(proxied, []);
    expect(present(raw, 'the proxied Zanzibar prompt')).toBe(true);
    for (const group of ALL_REDACTION_GROUPS) {
      const redacted = exportWith(proxied, [group]);
      for (const secret of ['the proxied Zanzibar prompt', 'the proxied resume answer']) {
        expect([group, secret, present(redacted, secret)]).toEqual([group, secret, false]);
      }
    }
    expect(leakedValues(raw, exportWith(proxied, [...ALL_REDACTION_GROUPS]))).toEqual([]);
  });

  test('structure survives every group: event names, node names, ids, tool names, settings', () => {
    const redacted = exportWith(CAPTURE, [...ALL_REDACTION_GROUPS]);
    expect(redacted.flatMap((line) => (line.kind === 'event' ? [line.sseEvent] : []))).toEqual([
      'metadata',
      'messages',
      'messages',
      'messages|research:t1',
      'messages',
      'messages',
      'custom',
      'values',
      'updates',
    ]);
    const leaves = survivors(redacted);
    for (const kept of ['r-lg', 'agent', 'researcher', 'tools', 'm1', 'm2', 'm-sub', 'h1', 'call_1', 'lookup_revenue', 'AIMessageChunk', 'values', 'messages-tuple']) {
      expect([kept, leaves.includes(kept)]).toEqual([kept, true]);
    }
    const file = JSON.stringify(redacted);
    for (const key of ['"langgraph_node"', '"assistant_id"', '"stream_mode"', '"__interrupt__"', '"account_note"']) {
      expect(file).toContain(key);
    }
  });
});
