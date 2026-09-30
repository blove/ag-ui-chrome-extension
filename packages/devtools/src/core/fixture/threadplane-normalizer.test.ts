import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import lgReasoningJsonl from '../../test/fixtures/lg-reasoning.agui.jsonl?raw';
import { THREADPLANE_VERSION, TO_STREAM_EVENT_SOURCE, frameOf, toStreamEvent as runtimeToStreamEvent } from './threadplane-normalizer';

type Frame = { event: string; data: unknown };

/** Runs the embedded source the way a generated spec would, minus the type annotations. */
function compileToStreamEvent(): (frame: Frame) => Record<string, unknown> {
  const { outputText, diagnostics } = ts.transpileModule(TO_STREAM_EVENT_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  expect(diagnostics ?? []).toEqual([]);
  return new Function(`${outputText}\nreturn toStreamEvent;`)() as (frame: Frame) => Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Threadplane 0.2.0's mapping, restated independently from its source rather than derived from
 * the constant under test: the event name is `base|ns1|ns2…`; a `messages` tuple
 * `[message, metadata]` splits into `messages`/`messageMetadata`; any other array on a
 * `messages` or `messages/…` event becomes `messages`; a record payload's own keys are copied
 * onto the event after `type`/`namespace`; and `data` is always the raw payload, written last.
 */
function reference(frame: Frame): Record<string, unknown> {
  const [base = '', ...namespace] = frame.event.split('|');
  const data = frame.data;
  const out: Record<string, unknown> = { type: frame.event };
  if (namespace.length > 0) out.namespace = namespace;

  const messagesFamily = base === 'messages' || base.startsWith('messages/');
  if (base === 'messages' && Array.isArray(data) && data.length === 2 && isPlainRecord(data[1])) {
    out.messages = [data[0]];
    out.messageMetadata = data[1];
  } else if (messagesFamily && Array.isArray(data)) {
    out.messages = data;
  } else if (isPlainRecord(data)) {
    // defineProperty, not assignment, so a `__proto__` key lands as an own property the way a
    // spread puts it there.
    for (const key of Object.keys(data)) {
      Object.defineProperty(out, key, { value: data[key], enumerable: true, writable: true, configurable: true });
    }
  }
  Object.defineProperty(out, 'data', { value: data, enumerable: true, writable: true, configurable: true });
  return out;
}

function capturedFrames(jsonl: string): Frame[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string; sseEvent?: string; event?: unknown })
    .filter((line) => line.kind === 'event' && line.sseEvent !== undefined)
    .map((line) => ({ event: line.sseEvent as string, data: line.event }));
}

const message = { type: 'AIMessageChunk', id: 'm1', content: 'hi' };

const EDGE_FRAMES: Array<[string, Frame]> = [
  ['namespaced messages tuple', { event: 'messages|research:t1', data: [message, { langgraph_node: 'agent' }] }],
  ['two-segment namespace', { event: 'values|a:1|b:2', data: { messages: [message] } }],
  ['messages/partial array', { event: 'messages/partial', data: [message, { ...message, id: 'm2' }] }],
  ['namespaced messages/complete array', { event: 'messages/complete|sub:1', data: [message] }],
  ['messages tuple whose metadata is not a record', { event: 'messages', data: [message, ['not', 'a', 'record']] }],
  ['messages tuple whose metadata is null', { event: 'messages', data: [message, null] }],
  ['messages array of three', { event: 'messages', data: [message, {}, {}] }],
  ['metadata', { event: 'metadata', data: { run_id: 'r1', attempt: 1 } }],
  ['error', { event: 'error', data: { error: 'ValueError', message: 'boom' } }],
  ['custom scalar', { event: 'custom', data: 'progress 50%' }],
  ['custom number', { event: 'custom|tools:1', data: 42 }],
  ['non-messages array', { event: 'updates', data: [{ agent: {} }] }],
  ['messages-tuple is not the messages family', { event: 'messages-tuple', data: [message, { a: 1 }] }],
  ['state keys type and namespace overwrite', { event: 'values|sub:1', data: { type: 'state-type', namespace: 'state-ns', x: 1 } }],
  ['state key data is overwritten by the payload', { event: 'values', data: { data: 'inner', y: 2 } }],
  ['state key __proto__', { event: 'values', data: JSON.parse('{"__proto__":{"polluted":true},"z":3}') }],
  ['empty namespace segment', { event: 'values|', data: {} }],
  ['null data', { event: 'values', data: null }],
  ['undefined data', { event: 'end', data: undefined }],
];

describe('TO_STREAM_EVENT_SOURCE (T1)', () => {
  test('names the Threadplane version it mirrors', () => {
    expect(THREADPLANE_VERSION).toBe('0.2.0');
    expect(TO_STREAM_EVENT_SOURCE.startsWith(
      '// Mirrors @threadplane/langgraph 0.2.0 normalizeSdkEvent (transport/fetch-stream.transport.ts).',
    )).toBe(true);
  });

  test('is pinned: any edit to the embedded copy is deliberate', () => {
    expect(TO_STREAM_EVENT_SOURCE).toMatchInlineSnapshot(`
      "// Mirrors @threadplane/langgraph 0.2.0 normalizeSdkEvent (transport/fetch-stream.transport.ts). Copied because it is not exported; if Threadplane changes it, regenerate this spec.
      function toStreamEvent(frame: { event: string; data: unknown }): StreamEvent {
        const type = frame.event as StreamEvent['type'];
        const data = frame.data;
        const namespace = extractNamespace(type);
        const baseType = getBaseEventType(type);

        if (baseType === 'messages' && Array.isArray(data) && data.length === 2 && isRecord(data[1])) {
          return { type, ...(namespace ? { namespace } : {}), messages: [data[0]], messageMetadata: data[1], data };
        }

        if (isMessagesEvent(type) && Array.isArray(data)) {
          return { type, ...(namespace ? { namespace } : {}), messages: data, data };
        }

        if (isRecord(data)) {
          return { type, ...(namespace ? { namespace } : {}), ...data, data };
        }

        return { type, ...(namespace ? { namespace } : {}), data };
      }

      function isMessagesEvent(type: StreamEvent['type']): boolean {
        const baseType = getBaseEventType(type);
        return baseType === 'messages' || baseType.startsWith('messages/');
      }

      function getBaseEventType(type: StreamEvent['type']): string {
        return String(type).split('|')[0];
      }

      function extractNamespace(type: StreamEvent['type']): string[] | undefined {
        const parts = String(type).split('|');
        return parts.length > 1 ? parts.slice(1) : undefined;
      }

      function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      }
      "
    `);
  });

  test('maps every captured lg-reasoning frame as Threadplane does', () => {
    const toStreamEvent = compileToStreamEvent();
    const frames = capturedFrames(lgReasoningJsonl);
    expect(frames.length).toBeGreaterThan(1000);
    for (const frame of frames) {
      expect(toStreamEvent(frame)).toStrictEqual(reference(frame));
    }
  });

  test.each(EDGE_FRAMES)('maps %s as Threadplane does', (_name, frame) => {
    expect(compileToStreamEvent()(frame)).toStrictEqual(reference(frame));
  });

  test('keeps the quirks the reference encodes', () => {
    const toStreamEvent = compileToStreamEvent();
    const overwritten = toStreamEvent({ event: 'values|sub:1', data: { type: 't', namespace: 'n' } });
    expect(overwritten.type).toBe('t');
    expect(overwritten.namespace).toBe('n');
    const inner = { data: 'inner' };
    expect(toStreamEvent({ event: 'values', data: inner }).data).toBe(inner);
    expect(toStreamEvent({ event: 'updates', data: [1] })).toStrictEqual({ type: 'updates', data: [1] });
  });
});

describe('toStreamEvent, the runtime twin', () => {
  test('matches the embedded source on every lg-reasoning frame and every edge frame', () => {
    const compiled = compileToStreamEvent();
    const frames = [...capturedFrames(lgReasoningJsonl), ...EDGE_FRAMES.map(([, frame]) => frame)];
    for (const frame of frames) {
      expect(runtimeToStreamEvent(frame)).toStrictEqual(compiled(frame));
    }
  });
});

describe('frameOf', () => {
  test('reads the SSE name and payload of an event line', () => {
    expect(frameOf({ sseEvent: 'values', event: { a: 1 } })).toEqual({ event: 'values', data: { a: 1 } });
  });

  test('an unnamed frame is SSE\'s default event, message', () => {
    expect(frameOf({ event: [1] })).toEqual({ event: 'message', data: [1] });
  });
});
