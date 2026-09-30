/**
 * The Threadplane release whose private SSE → `StreamEvent` mapping `TO_STREAM_EVENT_SOURCE`
 * mirrors (T1). Bump it only together with a re-read of that release's
 * `transport/fetch-stream.transport.ts`.
 */
export const THREADPLANE_VERSION = '0.2.0';

/**
 * TypeScript source embedded verbatim in every generated Threadplane spec (T1). Threadplane's
 * `normalizeSdkEvent` is not exported, so the spec carries its own copy and replays the raw
 * captured frames `{event, data}` through it. The logic, quirks included, is Threadplane's:
 * a record payload is spread AFTER `type`/`namespace` (so state keys named `type` or
 * `namespace` overwrite them) and `data` is always set last. It compiles inside Threadplane
 * with `StreamEvent` imported from `@threadplane/langgraph`; the cast on `frame.event` is the
 * same one Threadplane's transport applies at its call site.
 */
export const TO_STREAM_EVENT_SOURCE = `// Mirrors @threadplane/langgraph ${THREADPLANE_VERSION} normalizeSdkEvent (transport/fetch-stream.transport.ts). Copied because it is not exported; if Threadplane changes it, regenerate this spec.
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
`;

/**
 * One captured LangGraph SSE frame as Threadplane's SDK hands it to `normalizeSdkEvent`: the
 * SSE `event:` name and the parsed payload (T1). Shared by the spec generator and by
 * `expectationsFor`, so both read a capture as the same frames.
 */
export interface ThreadplaneFrame {
  readonly event: string;
  readonly data: unknown;
}

/**
 * The frame an exported event line stands for. A frame without an `event:` field is SSE's
 * default event, `message` — the name the SDK then passes through.
 */
export function frameOf(line: { readonly sseEvent?: string; readonly event: unknown }): ThreadplaneFrame {
  return { event: line.sseEvent ?? 'message', data: line.event };
}

/**
 * The runtime twin of `TO_STREAM_EVENT_SOURCE`, for code in this extension that has to see
 * the events a generated spec will feed Threadplane (`expectationsFor`). It must stay the same
 * logic as the embedded source; a test compiles that source and compares the two frame by frame.
 */
export function toStreamEvent(frame: ThreadplaneFrame): Record<string, unknown> {
  const type = frame.event;
  const data = frame.data;
  const parts = type.split('|');
  const namespace = parts.length > 1 ? parts.slice(1) : undefined;
  const baseType = parts[0] ?? '';
  const withNamespace = namespace ? { namespace } : {};

  if (baseType === 'messages' && Array.isArray(data) && data.length === 2 && isRecord(data[1])) {
    return { type, ...withNamespace, messages: [data[0]], messageMetadata: data[1], data };
  }
  if ((baseType === 'messages' || baseType.startsWith('messages/')) && Array.isArray(data)) {
    return { type, ...withNamespace, messages: data, data };
  }
  if (isRecord(data)) {
    return { type, ...withNamespace, ...data, data };
  }
  return { type, ...withNamespace, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
