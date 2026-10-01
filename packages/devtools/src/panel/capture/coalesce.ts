/**
 * Coalesce the worker's report-only appends into one per burst.
 *
 * The worker pushes each Threadplane devtools report — signals or render — on its own `append` (records empty) the
 * moment it arrives, and a streaming run produces one per protocol event — dozens a second. Folded
 * one at a time, each would be its own store write and its own render of every tab. This holds
 * them for `COALESCE_MS` and delivers a single `append` carrying all of them.
 *
 * WHY THE PANEL AND NOT THE WORKER. A worker-side debounce would hold reports the ring already
 * contains, so a panel subscribing inside the window would get them on its snapshot and then
 * again on the delayed broadcast. Here, every message that is not a report-only append flushes
 * the waiting reports first and is delivered at once, so order is kept and frames, closes,
 * snapshots and clears are never delayed — a snapshot or a clear simply supersedes what it
 * follows, exactly as it would have without the batching.
 */
import type { SwMessage } from '../../sw/protocol';

/** About one frame: a burst is folded into a single render without the matrix visibly lagging. */
export const COALESCE_MS = 16;

type Append = Extract<SwMessage, { kind: 'append' }>;

/** An append that carries reports and no records: what the worker pushes per signals or render report. */
function isReportOnly(message: SwMessage): message is Append {
  return (
    message.kind === 'append' &&
    message.records.length === 0 &&
    (message.signals !== undefined || message.renders !== undefined)
  );
}

export interface SignalCoalescer {
  push(message: SwMessage): void;
  /** Cancel the timer and forget anything waiting. */
  dispose(): void;
}

/** Concatenate two optional report lists; the later message's eviction total is the current one. */
function mergeReports<T>(
  held: { reports: T[]; droppedBefore: number } | undefined,
  next: { reports: T[]; droppedBefore: number } | undefined,
): { reports: T[]; droppedBefore: number } | undefined {
  if (next === undefined) return held;
  if (held === undefined) return { reports: [...next.reports], droppedBefore: next.droppedBefore };
  return { reports: [...held.reports, ...next.reports], droppedBefore: next.droppedBefore };
}

/**
 * Signals reports (§14.3) and render reports (UI inspector U5) both ride record-less appends, and
 * both are held here; the merged append carries each list only when some message carried it.
 */
export function createSignalCoalescer(deliver: (message: SwMessage) => void): SignalCoalescer {
  let pending: Append | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const held = pending;
    pending = null;
    if (held !== null) deliver(held);
  }

  return {
    push(message) {
      if (!isReportOnly(message)) {
        flush();
        deliver(message);
        return;
      }
      const signals = mergeReports(pending?.signals, message.signals);
      const renders = mergeReports(pending?.renders, message.renders);
      // Both totals are re-stated per message; absent means "no news", so keep the last.
      const droppedBefore = message.droppedBefore ?? pending?.droppedBefore;
      pending = {
        kind: 'append',
        records: [],
        ...(droppedBefore !== undefined ? { droppedBefore } : {}),
        ...(signals !== undefined ? { signals } : {}),
        ...(renders !== undefined ? { renders } : {}),
      };
      timer ??= setTimeout(flush, COALESCE_MS);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
