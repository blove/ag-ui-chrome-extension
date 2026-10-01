/**
 * Coalesce the worker's report-only appends into one per burst.
 *
 * The worker pushes each Threadplane devtools report on its own `append` (records empty) the
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

function isSignalsOnly(message: SwMessage): message is Append & { signals: NonNullable<Append['signals']> } {
  return message.kind === 'append' && message.records.length === 0 && message.signals !== undefined;
}

export interface SignalCoalescer {
  push(message: SwMessage): void;
  /** Cancel the timer and forget anything waiting. */
  dispose(): void;
}

export function createSignalCoalescer(deliver: (message: SwMessage) => void): SignalCoalescer {
  let pending: (Append & { signals: NonNullable<Append['signals']> }) | null = null;
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
      if (!isSignalsOnly(message)) {
        flush();
        deliver(message);
        return;
      }
      pending =
        pending === null
          ? { ...message, signals: { ...message.signals, reports: [...message.signals.reports] } }
          : {
              kind: 'append',
              records: [],
              // Both totals are re-stated per message; absent means "no news", so keep the last.
              droppedBefore: message.droppedBefore ?? pending.droppedBefore,
              signals: {
                reports: [...pending.signals.reports, ...message.signals.reports],
                droppedBefore: message.signals.droppedBefore,
              },
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
