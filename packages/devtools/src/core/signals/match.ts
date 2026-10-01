/**
 * Which wire frame a Threadplane devtools report most likely describes (design G6).
 *
 * Pure, Chrome-free, DOM-free. The panel calls it on a click, never per render.
 *
 * WHAT THERE IS TO MATCH ON. Neither side carries an identifier the other knows: a record has the
 * capture's own `seq` and `connId`, a report has the hook's per-agent `seq` and a random `agent`
 * id, and neither carries a frame (document) id. So the match is evidence, in order of strength:
 *
 *   1. NAME. The report's `eventType` must equal the frame's event name, read the way the
 *      report's adapter reads it — AG-UI's `event.type`; LangGraph's SSE `event:` (`sseEvent`)
 *      VERBATIM, namespace included. Threadplane's LangGraph bridge reports `StreamEvent.type`,
 *      which is the SDK's SSE event name unchanged (`messages|research:t1` stays that), cut to
 *      128 characters — so the frame's name is cut the same way before comparing. Reading both
 *      as a base name would pool a parent's `messages` with every subgraph's, and the order rule
 *      below would then count frames the report never described. A report without a same-named
 *      frame (a pseudo-event such as `run:start`, or a frame captured nowhere) matches nothing.
 *   2. ORDER. When this agent's reports of that name are exactly as many as the frames of that
 *      name, the k-th report (by report `seq`) is the k-th frame (by record `seq`). That is the
 *      common, complete case and it does not depend on any clock.
 *   3. TIME. Otherwise — an eviction on either side, a hook that started after the stream, two
 *      agents speaking the same event names — the same-named frame nearest in `tMs`, within
 *      `MATCH_WINDOW_MS`.
 *
 * THE CLOCK. A record's `tMs` is `performance.now()` in the document that CAPTURED the frame
 * (`inject/install.ts`); a report's is `performance.now()` in the document that DISPATCHED it
 * (`inject/signals-listener.ts`). They are the same clock only within one document, and nothing on
 * either side says which document it came from — hence time is the last resort and is bounded:
 * a report from a subframe, whose clock started elsewhere, is far more likely to land outside the
 * window than to land on a wrong frame inside it.
 */
import type { CaptureRecord } from '../model/types';
import {
  MAX_EVENT_TYPE_LENGTH,
  type ThreadplaneAdapter,
  type ThreadplaneDevtoolsReport,
} from './report';

export type FrameMatch =
  | { kind: 'order'; seq: number }
  | { kind: 'time'; seq: number; deltaMs: number }
  | { kind: 'none' };

/**
 * How far apart a report and a frame may be stamped and still be matched by time. A hook reports
 * after the frame is decoded and reduced, which is milliseconds; a second is generous for a busy
 * main thread and still tight enough that an unrelated document's clock rarely lands inside it.
 */
export const MATCH_WINDOW_MS = 1000;

/**
 * A frame's protocol event name as `adapter`'s hook names it, or `null` for a keepalive, an AG-UI
 * frame that did not parse, or a frame the adapter would not have seen.
 *
 * Adapter-aware because a frame can carry both: an AG-UI server is free to set an SSE `event:`
 * field, and the AG-UI hook names the payload's `type`, never that field.
 */
export function recordEventName(record: CaptureRecord, adapter: ThreadplaneAdapter): string | null {
  if (record.kind !== 'event') return null;
  if (adapter === 'langgraph') {
    return record.sseEvent === undefined ? null : record.sseEvent.slice(0, MAX_EVENT_TYPE_LENGTH);
  }
  const type = record.event?.type;
  return typeof type === 'string' ? type.slice(0, MAX_EVENT_TYPE_LENGTH) : null;
}

/**
 * The frame `report` most likely came from.
 *
 * `reports` is every report held (it must include `report`); only this agent's same-named ones
 * are counted. `records` is every record held, in any order.
 */
export function matchReport(
  report: ThreadplaneDevtoolsReport,
  reports: readonly ThreadplaneDevtoolsReport[],
  records: readonly CaptureRecord[],
): FrameMatch {
  const candidates = records
    .filter((record) => recordEventName(record, report.adapter) === report.eventType)
    .sort((a, b) => a.seq - b.seq);
  if (candidates.length === 0) return { kind: 'none' };

  const peers = reports
    .filter((other) => other.agent === report.agent && other.eventType === report.eventType)
    .sort((a, b) => a.seq - b.seq);
  const index = peers.findIndex((other) => other.seq === report.seq);
  if (index !== -1 && peers.length === candidates.length) {
    const frame = candidates[index];
    if (frame !== undefined) return { kind: 'order', seq: frame.seq };
  }

  let best: CaptureRecord | null = null;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate.tMs - report.tMs);
    // Strictly less: on a tie the earlier frame (lower seq) stands.
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  if (best === null || bestDelta > MATCH_WINDOW_MS) return { kind: 'none' };
  return { kind: 'time', seq: best.seq, deltaMs: bestDelta };
}
