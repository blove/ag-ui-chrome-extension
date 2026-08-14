import type { CaptureRecord, Run, RunMetrics } from '../model/types';

/**
 * Nearest-rank percentile — no interpolation.
 *
 * For an ascending `sorted` array of N values and a percentile `p` in 0..100, the rank is
 * `ceil(p / 100 * N)` clamped into [1, N] and the result is `sorted[rank - 1]`.
 *
 * Example: sorted = [50, 100, 150, 500]
 *   p50 -> rank ceil(2.0) = 2 -> 100   (a linear-interpolation percentile would say 125)
 *   p95 -> rank ceil(3.8) = 4 -> 500
 */
function nearestRankPercentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/**
 * JSON byte length, treating non-serializable values as zero bytes. `record.raw` is
 * `undefined` when the bytes were already counted against a sibling record produced by
 * chunk expansion, so this doubles as the "don't double-count" guard for that contract.
 */
function byteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : json.length;
}

function pushTime(map: Map<string, number[]>, key: string, tMs: number): void {
  const existing = map.get(key);
  if (existing) existing.push(tMs);
  else map.set(key, [tMs]);
}

export function computeMetrics(
  run: Run,
  records: CaptureRecord[],
  stallThresholdMs: number,
): RunMetrics {
  const eventCountByType: Record<string, number> = {};
  const toolLatencyMs: Record<string, number> = {};
  const toolStartMs = new Map<string, number>();
  const contentTimesByMessage = new Map<string, number[]>();
  const textContentTimes: number[] = [];
  let totalStreamBytes = 0;
  let statePatchCount = 0;
  let statePatchBytes = 0;
  let ttftMs: number | undefined;
  let ttfrtMs: number | undefined;

  for (const record of records) {
    // A keepalive's bytes are real bytes on the wire — the whole point of tracking them is
    // diagnosing proxy buffering — so they count here regardless of kind.
    totalStreamBytes += byteLength(record.raw);

    // Narrow on `kind` before touching `event`: the keepalive arm of the `CaptureRecord`
    // union has no `event` property at all. This is also what keeps a keepalive out of
    // eventCountByType — requirements §5.4 requires it be recorded but excluded from the
    // event count.
    if (record.kind !== 'event') continue;
    const event = record.event;
    if (event === null) continue;

    eventCountByType[event.type] = (eventCountByType[event.type] ?? 0) + 1;
    const messageId = typeof event.messageId === 'string' ? event.messageId : undefined;
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;

    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        if (ttftMs === undefined) ttftMs = record.tMs - run.startedAtMs;
        textContentTimes.push(record.tMs);
        if (messageId !== undefined) pushTime(contentTimesByMessage, messageId, record.tMs);
        break;
      }
      case 'REASONING_MESSAGE_CONTENT': {
        if (ttfrtMs === undefined) ttfrtMs = record.tMs - run.startedAtMs;
        if (messageId !== undefined) pushTime(contentTimesByMessage, messageId, record.tMs);
        break;
      }
      case 'TOOL_CALL_START': {
        if (toolCallId !== undefined) toolStartMs.set(toolCallId, record.tMs);
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const startedMs = toolCallId === undefined ? undefined : toolStartMs.get(toolCallId);
        if (toolCallId !== undefined && startedMs !== undefined) {
          toolLatencyMs[toolCallId] = record.tMs - startedMs;
        }
        break;
      }
      case 'STATE_DELTA': {
        statePatchCount += 1;
        statePatchBytes += byteLength(event.delta);
        break;
      }
      default:
        break;
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < textContentTimes.length; i += 1) {
    gaps.push(textContentTimes[i]! - textContentTimes[i - 1]!);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);

  // Stalls: for each reconstructed message, walk the timestamps at which the message was
  // demonstrably alive — its start, each of its own content deltas, and its end once it
  // closed — and report every consecutive pair separated by STRICTLY more than the
  // threshold. Each such interval lies inside the message's open window by construction,
  // which is what requirements §8 means by a gap "with an open message".
  const stalls: RunMetrics['stalls'] = [];
  for (const message of run.messages.values()) {
    const times = [message.startedAtMs, ...(contentTimesByMessage.get(message.messageId) ?? [])];
    if (message.closed && message.endedAtMs !== undefined) times.push(message.endedAtMs);
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      const startMs = times[i - 1]!;
      const endMs = times[i]!;
      if (endMs - startMs > stallThresholdMs) {
        stalls.push({ startMs, endMs, messageId: message.messageId });
      }
    }
  }
  stalls.sort((a, b) => a.startMs - b.startMs);

  return {
    durationMs: run.endedAtMs === undefined ? undefined : run.endedAtMs - run.startedAtMs,
    ttftMs,
    ttfrtMs,
    gapP50Ms: nearestRankPercentile(sortedGaps, 50),
    gapP95Ms: nearestRankPercentile(sortedGaps, 95),
    gapMaxMs: sortedGaps.length === 0 ? undefined : sortedGaps[sortedGaps.length - 1],
    stalls,
    toolLatencyMs,
    statePatchCount,
    statePatchBytes,
    eventCountByType,
    totalStreamBytes,
  };
}
