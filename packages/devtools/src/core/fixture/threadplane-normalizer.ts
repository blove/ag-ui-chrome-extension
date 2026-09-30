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
