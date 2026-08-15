/**
 * The fold from sw→panel messages into `PanelState`.
 *
 * This is the live twin of `import/load-jsonl.ts`, and deliberately the same fold: both feed
 * `createRunBuilder`, so the panel's model comes out of one code path whether it was imported
 * or captured (design §7). What differs is only that this one is incremental — the builder is
 * held across messages instead of being run once over a finished file.
 *
 * No Chrome API is touched here. The port lives in `./port`, so every branch below is
 * reachable from a test with a plain object.
 */
import type { CaptureRecord } from '../../core/model/types';
import { createRunBuilder, type RunBuilder } from '../../core/normalizer/run-builder';
import type { RequestLine, SwMessage } from '../../sw/protocol';
import type { BinaryTransport, PanelState } from '../model/panel-types';

export interface LiveSessionOptions {
  expandChunks?: boolean;
  /**
   * How many records the PANEL keeps. Matches the service worker's ring-buffer default
   * (contract: `maxRecords` 5000) so the two ends evict at the same scale.
   */
  maxRecords?: number;
}

export interface LiveSession {
  /** Fold one message and return the next state. `s` is never mutated. */
  apply(s: PanelState, message: SwMessage): PanelState;
  /**
   * Re-run the whole fold under new options and return the resulting state.
   *
   * This is what makes Expand chunks mean something on a live capture: expansion happens
   * inside the run builder, so the only way to apply it is to feed the retained records
   * through a new one. The imported path solves the same problem by re-decoding the file
   * (`App`'s `retained` bytes); live capture has no file, so it retains the records instead.
   */
  refold(s: PanelState, options: LiveSessionOptions): PanelState;
  /** Throw the fold away and start empty. */
  restart(options?: LiveSessionOptions): void;
  /** Every record the session still holds. */
  records(): CaptureRecord[];
}

/**
 * The panel's own bound on retained records, mirroring the ring buffer's 5000 default.
 *
 * The panel needs its OWN bound: `append` carries records and a count, so a panel that simply
 * accumulated them would grow without limit across a long session — and design §9 says sessions
 * are long and ongoing. Evicting here is also what makes `droppedBefore` truthful: the field
 * means "records dropped before the earliest one SHOWN", and what is shown is this list. P9 then
 * does the rest — the toolbar count is never silent.
 */
const DEFAULT_MAX_RECORDS = 5000;

export function createLiveSession(options: LiveSessionOptions = {}): LiveSession {
  let expandChunks = options.expandChunks ?? true;
  let maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  let builder: RunBuilder = createRunBuilder({ expandChunks });
  let records: CaptureRecord[] = [];
  /**
   * Retained so `refold` can rebuild. Verified fact 4: a run whose `RunAgentInput` is missing
   * reports `run-started-without-input`, so dropping these would make Expand chunks invent an
   * issue that the same capture did not have a moment earlier.
   */
  let requests: RequestLine[] = [];
  /** Connections already closed, replayed by `refold` so `finalizeRules` still runs. */
  let closed: Array<{ connId: string; tMs: number }> = [];
  /**
   * The worker's own eviction count, as of the last message that carried one, and the panel's.
   *
   * Kept apart because they move independently: C4 puts `droppedBefore` on `append` as well as
   * on `snapshot`, so the worker's figure is re-stated as it grows, while `trim()` below only
   * ever adds to ours. Summing a re-stated total with an accumulating one is the whole reason
   * this is two numbers rather than one.
   */
  let workerDropped = 0;
  let panelDropped = 0;
  /** §5.4: the labelled binary transport, if this capture saw one. */
  let binary: BinaryTransport | null = null;

  function restart(next: LiveSessionOptions = {}): void {
    expandChunks = next.expandChunks ?? expandChunks;
    maxRecords = next.maxRecords ?? maxRecords;
    builder = createRunBuilder({ expandChunks });
    records = [];
    requests = [];
    closed = [];
    workerDropped = 0;
    panelDropped = 0;
    binary = null;
  }

  /** Oldest-first eviction, counted. Never silent — that is the whole of P9. */
  function trim(): void {
    if (records.length <= maxRecords) return;
    const excess = records.length - maxRecords;
    records = records.slice(excess);
    panelDropped += excess;
  }

  function project(s: PanelState): PanelState {
    return {
      ...s,
      runs: builder.runs(),
      records,
      issues: builder.allIssues(),
      droppedBefore: workerDropped + panelDropped,
      binaryTransport: binary,
    };
  }

  function addRequest(request: RequestLine): void {
    requests.push(request);
    builder.addRequest(request.connId, request.method, request.url, request.input);
  }

  function refold(s: PanelState, next: LiveSessionOptions): PanelState {
    const heldRecords = records;
    const heldRequests = requests;
    const heldClosed = closed;
    const heldWorkerDropped = workerDropped;
    const heldPanelDropped = panelDropped;
    const heldBinary = binary;
    restart(next);
    for (const request of heldRequests) addRequest(request);
    for (const record of heldRecords) builder.addRecord(record);
    for (const entry of heldClosed) builder.closeConnection(entry.connId, entry.tMs);
    records = heldRecords;
    closed = heldClosed;
    workerDropped = heldWorkerDropped;
    panelDropped = heldPanelDropped;
    binary = heldBinary;
    return project(s);
  }

  function apply(s: PanelState, message: SwMessage): PanelState {
    switch (message.kind) {
      case 'snapshot': {
        // A snapshot replaces everything, so the builder is replaced too: re-feeding a fresh
        // one is the only way to get runs that describe exactly these records. The binary
        // label survives it — the worker's buffer never held that notice, so a reconnect would
        // otherwise un-explain an empty capture it had just explained.
        const heldBinary = binary;
        restart();
        binary = heldBinary;
        // Requests first, all of them. Verified fact 4: without the `RunAgentInput` behind it
        // every run additionally reports `run-started-without-input`, so a request that
        // arrived after its run's first record would put a spurious issue on screen. Order
        // among requests themselves does not matter — each is keyed by `connId`.
        for (const request of message.requests) addRequest(request);
        for (const record of message.records) builder.addRecord(record);
        records = [...message.records];
        // The worker's own eviction count is the floor: those records are gone before the
        // panel ever saw them, and `trim()` may add to it below.
        workerDropped = message.droppedBefore;
        trim();
        // The snapshot is a new dataset: a selection made against the previous one would point
        // at a seq this one may not contain, and a scope at a run it may not have.
        return { ...project(s), scope: null, selectedSeq: null };
      }
      case 'append': {
        for (const record of message.records) builder.addRecord(record);
        records = [...records, ...message.records];
        // C4: the worker re-states its total on every append. Absent means "no news", not zero
        // — a producer that omits it must not silently un-report eviction already reported.
        if (message.droppedBefore !== undefined) workerDropped = message.droppedBefore;
        trim();
        return project(s);
      }
      case 'request': {
        addRequest(message.request);
        return project(s);
      }
      case 'closed': {
        // Closing is what runs `finalizeRules`, so an unterminated run reports
        // `run-never-terminated` instead of sitting silently in 'running'.
        closed.push({ connId: message.connId, tMs: message.tMs });
        builder.closeConnection(message.connId, message.tMs);
        return project(s);
      }
      case 'binary': {
        /*
         * §5.4: label, never decode.
         *
         * Bytes accumulate while the connection is the same one, because a binary body arrives
         * in chunks and a size that reset on each notice would under-report the stream. A new
         * `connId` replaces the label outright rather than merging: two connections may use
         * different content types, and averaging them would describe neither.
         */
        binary =
          binary !== null && binary.connId === message.connId
            ? { ...binary, bytes: binary.bytes + message.bytes }
            : {
                connId: message.connId,
                tMs: message.tMs,
                contentType: message.contentType,
                bytes: message.bytes,
              };
        return project(s);
      }
      case 'cleared': {
        restart();
        return { ...project(s), scope: null, selectedSeq: null, loadError: null };
      }
    }
  }

  return {
    apply,
    refold,
    restart,
    records: () => records,
  };
}
