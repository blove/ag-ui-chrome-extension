/**
 * The one place `WireFrame` values are built for the XHR and `EventSource` transports.
 *
 * `raw` has exactly one meaning across all three capture paths (design resolution C2, and see
 * the doc on `WireFrame` itself): for an event frame it is the `data:` payload — the string a
 * consumer hands straight to `JSON.parse` — and for a keepalive it is the reconstructed comment
 * frame. Anything else, in particular the full `event:`/`id:`/`data:` frame text, is wrong.
 *
 * `fetch-patch.ts` is the reference implementation and builds these two shapes inline; it is
 * deliberately left alone. `raw-invariant.test.ts` pins all three transports to byte-identical
 * output for the same logical frame, so the reference and these helpers cannot drift apart
 * silently — which is exactly how they drifted the first time.
 */
import { normalizeEventName } from '../core/sse/event-name';
import type { SseFrame } from '../core/sse/parser';

import type { WireFrame } from './protocol';

/**
 * An event frame. `raw` is the `data:` payload, with data lines already joined by `\n`.
 *
 * `eventName` is the frame's `event:` field. It is normalized here (spec L1) so every transport
 * applies the same rule, and it is ABSENT — not `undefined` — when there is no real name, so an
 * AG-UI frame is exactly the shape it always was.
 */
export function eventFrame(data: string, tMs: number, eventName?: string): WireFrame {
  const name = normalizeEventName(eventName);
  return { kind: 'event', tMs, raw: data, ...(name !== undefined ? { eventName: name } : {}) };
}

/**
 * A keepalive frame. `raw` is the comment frame as it occupied the wire, which is what
 * `panel/import/load-jsonl.ts` puts in `CaptureRecord.raw` for an imported keepalive.
 */
export function keepaliveFrame(comment: string, tMs: number): WireFrame {
  return { kind: 'keepalive', tMs, raw: `:${comment}\n\n`, comment };
}

/**
 * A frame straight out of `core/sse/parser`.
 *
 * `raw` is the payload, not the frame text. `eventName` travels in a field of its own (L1);
 * `id` and `retry` are still dropped, because nothing downstream reads them.
 */
export function sseFrameToWireFrame(frame: SseFrame, tMs: number): WireFrame {
  return frame.kind === 'keepalive'
    ? keepaliveFrame(frame.comment, tMs)
    : eventFrame(frame.data, tMs, frame.eventName);
}
