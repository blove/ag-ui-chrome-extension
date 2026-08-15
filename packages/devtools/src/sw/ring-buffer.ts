/**
 * The service worker's per-tab capture buffer — requirements §11's "ring buffer caps on memory
 * (default 5k events / 8 MB, configurable), oldest dropped".
 *
 * Eviction is COUNTED, never silent. `droppedBefore()` is the whole reason this module reports
 * anything at all beyond its contents: panel design decision P9 established that sessions are
 * long and ongoing, so the default caps WILL evict in normal use, and a panel that renders a
 * truncated stream without saying so is the same class of trust failure as a hidden validator
 * issue — someone computes TTFT from a run whose start was evicted and never knows.
 */
import type { CaptureRecord } from '../core/model/types';
import type { RequestLine } from './protocol';

export interface RingBufferOptions {
  maxRecords?: number;
  maxBytes?: number;
}

export interface RingBuffer {
  push(record: CaptureRecord): void;
  addRequest(request: RequestLine): void;
  records(): CaptureRecord[];
  requests(): RequestLine[];
  /** Count evicted from the front. Feeds PanelState.droppedBefore (P9). */
  droppedBefore(): number;
  bytes(): number;
  clear(): void;
}

/** requirements §11. */
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How many evicted slots may sit at the front before the backing arrays are rebuilt.
 *
 * Eviction moves a head index instead of calling `shift()`, so a full buffer costs O(1) per push
 * rather than O(n); compaction bounds the stale references that trick leaves behind. 64 keeps the
 * over-retention small relative to the byte cap while making the O(n) rebuild a 1-in-64 event.
 */
const COMPACT_AFTER = 64;

/**
 * UTF-8 byte length of a value's JSON encoding.
 *
 * `TextEncoder`, not `String.length`: `String.length` counts UTF-16 code units, so a CJK
 * codepoint reports 1 for 3 bytes on the wire and an emoji 2 for 4. `core/metrics/run-metrics.ts`
 * carries the same note for the same reason — a buffer sized in code units would hold roughly 3x
 * its configured memory for a Japanese conversation, which is exactly the OOM the cap exists to
 * prevent.
 */
const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

export function createRingBuffer(options: RingBufferOptions = {}): RingBuffer {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let recordList: CaptureRecord[] = [];
  let recordSizes: number[] = [];
  let head = 0;
  let recordBytes = 0;

  let requestList: RequestLine[] = [];
  let requestSizes: number[] = [];
  let requestHead = 0;
  let requestBytes = 0;

  let dropped = 0;

  function recordCount(): number {
    return recordList.length - head;
  }

  function requestCount(): number {
    return requestList.length - requestHead;
  }

  function compact(): void {
    if (head >= COMPACT_AFTER) {
      recordList = recordList.slice(head);
      recordSizes = recordSizes.slice(head);
      head = 0;
    }
    if (requestHead >= COMPACT_AFTER) {
      requestList = requestList.slice(requestHead);
      requestSizes = requestSizes.slice(requestHead);
      requestHead = 0;
    }
  }

  /**
   * Drop oldest-first until both caps hold.
   *
   * The byte cap stops at one record on purpose: a single frame larger than `maxBytes` would
   * otherwise evict itself the instant it arrived, leaving a buffer that looks empty while
   * capture is plainly working. Holding the newest record over-runs the cap by exactly one
   * record — bounded, and visible in `bytes()` — instead of hiding the event.
   */
  function enforceCaps(): void {
    while (recordCount() > 0 && recordCount() > maxRecords) {
      recordBytes -= recordSizes[head] ?? 0;
      head += 1;
      dropped += 1;
    }
    while (recordCount() > 1 && recordBytes + requestBytes > maxBytes) {
      recordBytes -= recordSizes[head] ?? 0;
      head += 1;
      dropped += 1;
    }
    // Request lines are one per connection and are what `run-started-without-input` reads, so
    // they are capped by count only and their eviction does NOT touch `droppedBefore`: P9's
    // counter is a RECORD count that positions the panel's truncation marker in the event list.
    while (requestCount() > maxRecords) {
      requestBytes -= requestSizes[requestHead] ?? 0;
      requestHead += 1;
    }
    compact();
  }

  return {
    push(record: CaptureRecord): void {
      const size = byteLength(record);
      recordList.push(record);
      recordSizes.push(size);
      recordBytes += size;
      enforceCaps();
    },

    addRequest(request: RequestLine): void {
      const size = byteLength(request);
      requestList.push(request);
      requestSizes.push(size);
      requestBytes += size;
      enforceCaps();
    },

    records(): CaptureRecord[] {
      return recordList.slice(head);
    },

    requests(): RequestLine[] {
      return requestList.slice(requestHead);
    },

    droppedBefore(): number {
      return dropped;
    },

    bytes(): number {
      return recordBytes + requestBytes;
    },

    clear(): void {
      recordList = [];
      recordSizes = [];
      head = 0;
      recordBytes = 0;
      requestList = [];
      requestSizes = [];
      requestHead = 0;
      requestBytes = 0;
      // A cleared buffer has dropped nothing before its (empty) start, so the panel must stop
      // showing a truncation marker the moment the user clears.
      dropped = 0;
    },
  };
}
