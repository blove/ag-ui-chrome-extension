import type { JsonlHeader, JsonlLine, JsonlRequest } from '../jsonl/codec';
import { dialectsOfLines } from '../normalizer/dialect';
import { commentSafe } from './comment-safe';
import { redactionNote } from './redaction-note';
import { expectationsFor, type ThreadplaneExpectations, type ThreadplaneSubmission } from './threadplane-expect';
import { frameOf, TO_STREAM_EVENT_SOURCE, type ThreadplaneFrame } from './threadplane-normalizer';

export interface ThreadplaneSpecOptions {
  /** The spec's own filename, stamped into its header so it can be traced back to the capture. */
  readonly filename: string;
  /** Where the spec imports Threadplane from. `@threadplane/langgraph` unless the spec runs inside Threadplane's own tree (T7). */
  readonly importFrom?: string;
}

/** One LangGraph connection of the export, as its replay needs it. */
interface Connection {
  readonly connId: string;
  readonly request: JsonlRequest | undefined;
  readonly frames: ThreadplaneFrame[];
}

/**
 * How a replay submits, decided from the captured request body (T3), with the TypeScript that
 * does it. The expression reads the emitted `request_N` constant, so the spec shows where the
 * submitted value came from.
 */
interface Submission {
  readonly forExpectations: ThreadplaneSubmission;
  readonly call: string;
  /** Set when the transport's payload is the submitted state, which the spec then asserts. */
  readonly payload?: string;
  readonly readsRequest: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerOf(lines: readonly JsonlLine[]): JsonlHeader | null {
  const first = lines[0];
  return first !== undefined && first.kind === 'header' ? first : null;
}

/** LangGraph connections in first-appearance order, each with its first request line and its frames (T2). */
function langGraphConnections(lines: readonly JsonlLine[]): Connection[] {
  const dialects = dialectsOfLines(lines);
  const byId = new Map<string, { request: JsonlRequest | undefined; frames: ThreadplaneFrame[] }>();
  for (const line of lines) {
    if (line.kind !== 'request' && line.kind !== 'event') continue;
    if (dialects.get(line.connId) !== 'langgraph') continue;
    let connection = byId.get(line.connId);
    if (connection === undefined) {
      connection = { request: undefined, frames: [] };
      byId.set(line.connId, connection);
    }
    if (line.kind === 'request') connection.request ??= line;
    else connection.frames.push(frameOf(line));
  }
  return [...byId].map(([connId, connection]) => ({ connId, ...connection }));
}

/**
 * T3. A `command.resume` is a resume, an `input` object is state, and anything else — a join
 * stream's GET has no body at all — submits `{}`, which is also what Threadplane sends for it.
 * The resume check comes first because a resume body carries `input: null` beside its command.
 */
function submissionOf(body: unknown, name: string): Submission {
  if (isRecord(body)) {
    const command = body['command'];
    if (isRecord(command) && 'resume' in command) {
      return {
        forExpectations: { resume: command['resume'] },
        call: `agent.submit({ resume: ${name}.command.resume })`,
        readsRequest: true,
      };
    }
    const input = body['input'];
    if (isRecord(input)) {
      return {
        forExpectations: { state: input },
        call: `agent.submit({ state: ${name}.input })`,
        payload: `${name}.input`,
        readsRequest: true,
      };
    }
  }
  return { forExpectations: {}, call: 'agent.submit({})', readsRequest: false };
}

/** The run a connection streamed: its `metadata` frame's `run_id`, else the run in a join URL. */
function runIdOf(connection: Connection): string {
  for (const frame of connection.frames) {
    if (frame.event === 'metadata' && isRecord(frame.data) && typeof frame.data['run_id'] === 'string') {
      return frame.data['run_id'];
    }
  }
  return /\/runs\/([^/]+)\/(?:stream|join)/.exec(connection.request?.url ?? '')?.[1] ?? 'unknown';
}

/**
 * The generated assertions (T4): exactly what `expectationsFor` derived, and nothing for an
 * absent field — an absent expectation means "no assertion", never "assert it is absent".
 */
function assertionsOf(expected: ThreadplaneExpectations): string[] {
  const out: string[] = [];
  if (expected.status !== undefined) out.push(`expect(agent.status()).toBe(${JSON.stringify(expected.status)});`);
  if (expected.interrupted === true) out.push('expect(agent.interrupt()).toBeDefined();');
  else if (expected.interrupted === false) out.push('expect(agent.interrupt()).toBeFalsy();');
  if (expected.lastAssistantText !== undefined) {
    out.push(`expect(lastAssistantText(agent)).toBe(${JSON.stringify(expected.lastAssistantText)});`);
  }
  if (expected.toolCallNames !== undefined) {
    out.push(`expect(agent.toolCalls().map((call) => call.name)).toEqual(${JSON.stringify(expected.toolCallNames)});`);
  }
  return out;
}

const LAST_ASSISTANT_TEXT_SOURCE = `/**
 * The text of the last assistant message, read from the neutral \`Message\` Threadplane exposes:
 * the LangGraph adapter flattens content to a string, and a block list is joined by its text blocks.
 */
function lastAssistantText(agent: ReturnType<typeof injectAgent>): string | undefined {
  const last = agent.messages().filter((message) => message.role === 'assistant').at(-1);
  if (last === undefined) return undefined;
  if (typeof last.content === 'string') return last.content;
  return last.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}
`;

/**
 * The frames as an array literal whose every element is cast to `CapturedFrame`. Without the
 * casts TypeScript infers the literal's type as the union of every frame's shape before checking
 * it against the annotation, and a real capture's thousand-odd frames exceed what it will
 * represent (TS2590) — the spec would run under Vitest but fail a type check.
 */
function framesLiteral(frames: readonly ThreadplaneFrame[]): string {
  if (frames.length === 0) return '[]';
  const elements = frames.map((frame) => `${indent(JSON.stringify(frame, null, 2), '  ')} as CapturedFrame`);
  return `[\n${elements.join(',\n')}\n]`;
}

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : by + line))
    .join('\n');
}

/**
 * A ready-to-run `@threadplane/langgraph` spec replaying every LangGraph connection of an export
 * through `MockAgentTransport` (T1–T5), or `null` when the export holds none.
 *
 * `lines` are the export's lines — already redacted per the chosen groups — so the spec's frames,
 * request and assertions all come from the same redacted values and the spec still passes (T5).
 * The output is a pure function of its inputs: the same export always yields the same text.
 */
export function toThreadplaneSpec(lines: readonly JsonlLine[], options: ThreadplaneSpecOptions): string | null {
  const connections = langGraphConnections(lines);
  if (connections.length === 0) return null;
  const header = headerOf(lines);

  const constants: string[] = [];
  const cases: string[] = [];
  let assertsText = false;

  connections.forEach((connection, i) => {
    const n = i + 1;
    const requestName = `request_${String(n)}`;
    const framesName = `frames_${String(n)}`;
    const body = connection.request?.input;
    const submission = submissionOf(body, requestName);
    const expected = expectationsFor(connection.frames, submission.forExpectations);
    if (expected.lastAssistantText !== undefined) assertsText = true;

    const assistantId = isRecord(body) && typeof body['assistant_id'] === 'string' ? `${requestName}.assistant_id` : "'agent'";
    const emitsRequest = submission.readsRequest || assistantId !== "'agent'";
    const origin = connection.request === undefined ? 'no request line was captured' : commentSafe(`${connection.request.method} ${connection.request.url}`);

    constants.push(`// Connection ${commentSafe(connection.connId)}: ${origin}.`);
    if (emitsRequest) constants.push(`const ${requestName} = ${JSON.stringify(body, null, 2)};`);
    else if (connection.request !== undefined) constants.push('// The captured request carries no input or resume, so the replay submits {}.');
    constants.push(`const ${framesName}: CapturedFrame[] = ${framesLiteral(connection.frames)};`);
    constants.push('');

    const statements = [
      'const transport = new MockAgentTransport();',
      'TestBed.configureTestingModule({',
      `  providers: [provideAgent({ apiUrl: '', assistantId: ${assistantId}, transport, throttle: false })],`,
      '});',
      'const agent = TestBed.runInInjectionContext(() => injectAgent());',
      '',
      `const submitted = ${submission.call};`,
      `await transport.emit(${framesName}.map(toStreamEvent));`,
      'await transport.close();',
      'await submitted.catch(() => undefined);',
      '',
      ...(submission.payload === undefined ? [] : [`expect(transport.streams[0]?.payload).toEqual(${submission.payload});`]),
      ...assertionsOf(expected),
    ];
    cases.push(
      `  it(${JSON.stringify(`replays connection ${connection.connId} (run ${runIdOf(connection)})`)}, async () => {\n` +
        `${indent(statements.join('\n'), '    ')}\n  });`,
    );
  });

  const importFrom = options.importFrom ?? '@threadplane/langgraph';
  return `/**
 * Threadplane replay test, generated by AG-UI DevTools from a LangGraph Platform capture.
 *
 * Source: ${commentSafe(options.filename)}
 * Origin: ${commentSafe(header?.url ?? 'unknown')}
 * Captured: ${commentSafe(header?.capturedAt ?? 'unknown')}
 *
 * ${commentSafe(redactionNote(header))}
 *
 * Each \`it\` replays one captured connection, frame for frame, through @threadplane/langgraph's
 * MockAgentTransport. These assertions are what the capture shows — change them to the behaviour
 * you want, and the test fails until it's fixed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MockAgentTransport, injectAgent, provideAgent, type StreamEvent } from '${importFrom}';

${TO_STREAM_EVENT_SOURCE}
/** One captured SSE frame: its \`event:\` name and parsed payload, exactly as recorded. */
type CapturedFrame = { event: string; data: unknown };

${assertsText ? `${LAST_ASSISTANT_TEXT_SOURCE}\n` : ''}${constants.join('\n')}
describe(${JSON.stringify(`AG-UI DevTools capture replay: ${options.filename}`)}, () => {
  afterEach(() => TestBed.resetTestingModule());

${cases.join('\n\n')}
});
`;
}
