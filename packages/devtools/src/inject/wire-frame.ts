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
import type { SseFrame } from '../core/sse/parser';

import type { WireFrame } from './protocol';

/** An event frame. `raw` is the `data:` payload, with data lines already joined by `\n`. */
export function eventFrame(data: string, tMs: number): WireFrame {
  return { kind: 'event', tMs, raw: data };
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
 * `eventName`, `id` and `retry` are parsed by that module but are not part of `raw`: `raw` is
 * the payload, not the frame text. Nothing downstream reads them today; when something does,
 * they need fields of their own on `WireFrame` rather than being smuggled into `raw`.
 */
export function sseFrameToWireFrame(frame: SseFrame, tMs: number): WireFrame {
  return frame.kind === 'keepalive'
    ? keepaliveFrame(frame.comment, tMs)
    : eventFrame(frame.data, tMs);
}
