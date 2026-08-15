/**
 * MV3 service worker — the port hub of requirements §3 (Architecture).
 *
 * It owns three things nothing else can:
 *   1. ONE ring buffer per `tabId`, so a panel opened after a run still sees it (§3 "survives
 *      panel-opened-late via replay").
 *   2. The `WireFrame` → `CaptureRecord` conversion: `seq`, `tMs`, `connId`, and `kind` are
 *      assigned HERE, because the SW is the first place with a per-tab view of the stream.
 *   3. The `chrome.storage.session` mirror that survives worker termination (§15 risk row 1:
 *      "MV3 service worker terminates at ~30 s idle, losing the buffer"). The panel port is the
 *      other half of that mitigation — an open port keeps the worker alive while a panel watches.
 *
 * It is also where an origin granted at runtime turns into actual capture (finding F4): a
 * successful `chrome.permissions.request` registers nothing by itself.
 *
 * Session storage is cleared by Chrome on browser close, which is what keeps requirements §11's
 * "no persistence by default" true: nothing here touches disk.
 */
import type { AguiEvent, CaptureRecord } from '../core/model/types';
import type { WireFrame } from '../inject/protocol';
import {
  PANEL_PORT_NAME,
  RELAY_PORT_NAME,
  type ClosedConn,
  type PanelCommand,
  type RelayMessage,
  type RequestLine,
  type SwMessage,
} from './protocol';
import { createRingBuffer, type RingBuffer } from './ring-buffer';

/**
 * The harness's window into the worker: Playwright can evaluate inside the MV3 service worker
 * but cannot drive the DevTools panel, so the e2e reads the buffer from here.
 *
 * Installed UNCONDITIONALLY, not behind a build flag. It exposes only data the extension already
 * holds for the tab being inspected, makes no network call, and gating it would mean the tested
 * artifact differs from the shipped one — the exact class of gap that let a silently broken build
 * pass every gate earlier in this project (see `scripts/verify-build.ts`).
 */
declare global {
  var __AGUI_DT_TEST__:
    | {
        records(): CaptureRecord[];
        requests(): RequestLine[];
        droppedBefore(): number;
        bytes(): number;
        /** Whether any live document in any tab has reported its capture hooks. */
        instrumented(): boolean;
        /**
         * Connections this worker has seen close, across every tab, each with the time it closed.
         *
         * The end of capture for a connection, and the only fact that says so. Everything else
         * the harness can observe — the page's own `status`, the response it rendered — describes
         * the PAGE's copy of the stream, which finishes independently of ours: `fetch-patch.ts`
         * tees the body and drains its branch on its own schedule, and the drained frames then
         * cross `postMessage` -> relay -> port -> here. A harness that snapshots the buffer when
         * the page says "done" is therefore reading a pipeline that is still in flight, and
         * measured, it is: the buffer has been observed empty ~600 ms after the page finished,
         * with the whole run landing intact a moment later.
         *
         * The `tMs` rides along because the harness reconstructs a run from this, and closing is
         * what runs `finalizeRules` — the run-end issues are anchored to that time.
         */
        closes(): ClosedConn[];
        clear(): void;
      }
    | undefined;
}

interface TabState {
  buffer: RingBuffer;
  /** Monotonic per tab. Fixtures and the JSONL codec start at 1. */
  nextSeq: number;
  recording: boolean;
  /**
   * Records dropped before this buffer existed — i.e. evicted by a PREVIOUS incarnation of the
   * worker, or trimmed from the session mirror. `RingBuffer` counts only its own evictions, so
   * P9's total is this plus `buffer.droppedBefore()`.
   */
  restoredDropped: number;
  /**
   * Connections whose `conn-open` has already been recorded.
   *
   * The relay's listener registers a tick after `document_start`, so the MAIN world re-states
   * `conn-open` with the first `frames` message of a connection rather than risk losing the
   * `RunAgentInput` it carries. On the normal path that means this worker sees the open twice,
   * and the second one must be a no-op: two request lines for one connection would double the
   * input the run builder reads.
   */
  seenConns: Set<string>;
  /**
   * Connections whose `conn-close` has arrived — the stream is over and nothing more will be
   * recorded for it.
   *
   * Kept because it is the one statement this worker can make about COMPLETENESS. Frames arrive
   * asynchronously and a buffer holding four of them looks exactly like a buffer that will hold
   * fourteen a moment later; only the close tells the two apart, and port messages are ordered,
   * so a close that has been handled means every frame ahead of it has been too.
   *
   * `RelayMessage`s are already broadcast as `closed`, but a broadcast is for whoever is
   * listening AT THE TIME. This is the same fact retained, which is what a reader arriving after
   * the event needs.
   *
   * A MAP, not a set, and the value is the page-side close time from the `conn-close` frame.
   * The id alone says a stream is over; only the time lets a late reader FINALISE it. Closing is
   * what runs `finalizeRules`, and every run-end issue it emits is anchored to that time, so a
   * snapshot carrying bare ids would force the panel to invent one — which misplaces the issues
   * instead of losing them, a quieter version of the same bug.
   *
   * First close wins: the time a connection ended is not restated, and a repeat must not move an
   * anchor that has already been reported.
   */
  closedConns: Map<string, number>;
  /**
   * Frames of this tab that have reported their capture hooks, mapped to the relay port that
   * reported it — or `null` for a frame restored from the session mirror, whose port belonged to
   * a previous incarnation of this worker.
   *
   * KEYED BY PORT, NOT JUST BY FRAME, for one reason: a reload announces the new document BEFORE
   * the old document's port disconnects, and a disconnect that removed a frame id outright would
   * therefore wipe the flag of the document that had just installed itself. The port identifies
   * the DOCUMENT; the frame id identifies the slot it occupies.
   *
   * A restored (`null`) entry is never removed by a disconnect. The document it describes is
   * still open and still patched — it simply has nothing to say until it navigates, and MV3
   * terminating an idle worker (§15) must not be mistaken for the page losing its hooks.
   */
  instrumentedFrames: Map<number, chrome.runtime.Port | null>;
}

/** `frameId` 0 is the top-level document. Everything else is a subframe (§12 `all_frames`). */
const MAIN_FRAME_ID = 0;

const tabs = new Map<number, TabState>();
/** Panel ports, mapped to the tab each has subscribed to. `null` until `subscribe` arrives. */
const panelPorts = new Map<chrome.runtime.Port, number | null>();

const SESSION_KEY_PREFIX = 'agui-dt:tab:';
/**
 * How much of a tab's tail is mirrored. The buffer holds up to 8 MB; `chrome.storage.session` has
 * a ~10 MB quota shared by the whole extension, and this write happens on a 250 ms debounce, so
 * mirroring the full buffer would spend the quota and the main thread on every burst. The records
 * left out are counted into `droppedBefore` on restore rather than vanishing — a restored buffer
 * that silently starts mid-run is precisely what P9 forbids.
 */
const MIRROR_MAX_RECORDS = 1000;
const MIRROR_DEBOUNCE_MS = 250;

interface MirroredTab {
  v: 1;
  records: CaptureRecord[];
  requests: RequestLine[];
  droppedBefore: number;
  nextSeq: number;
  recording: boolean;
  /**
   * Frames that had reported their capture hooks when this was written.
   *
   * Mirrored for §15 risk row 1: the worker is terminated at ~30 s idle while the page stays open
   * and stays patched, and a flag that lived only in worker memory would come back false — the
   * panel would then warn about a page it had been capturing correctly a minute earlier, which is
   * the same false-report failure in the opposite direction.
   */
  instrumentedFrames: number[];
  /**
   * Connections that had closed when this was written, with the time each closed at.
   *
   * Mirrored for the same reason as the flag above: the worker is terminated at ~30 s idle and a
   * fact that lived only in its memory would come back as "still open" for a connection that
   * ended minutes ago. A reader waiting for the stream to finish would then wait for a message
   * that has already been delivered and will never be sent again — and a panel opened after the
   * restart would never finalise the run.
   *
   * The time is mirrored alongside the id because a restored close is fed to the same
   * `finalizeRules` a live one is, and re-deriving the time from the records would anchor the
   * run-end issues at the last FRAME rather than at the close.
   */
  closedConns: ClosedConn[];
}

/* -------------------------------------------------------------------------- */
/* Tab state                                                                    */
/* -------------------------------------------------------------------------- */

function ensureTab(tabId: number): TabState {
  const existing = tabs.get(tabId);
  if (existing) return existing;
  const created: TabState = {
    buffer: createRingBuffer(),
    nextSeq: 1,
    recording: true,
    restoredDropped: 0,
    seenConns: new Set<string>(),
    closedConns: new Map<string, number>(),
    instrumentedFrames: new Map<number, chrome.runtime.Port | null>(),
  };
  tabs.set(tabId, created);
  return created;
}

function droppedFor(state: TabState): number {
  return state.restoredDropped + state.buffer.droppedBefore();
}

/**
 * The closes this tab holds, in the shape the panel and the mirror both take.
 *
 * One function, so the snapshot a panel is sent, the mirror written to session storage and the
 * harness's read cannot drift into disagreeing about which connections ended and when.
 */
function closesFor(state: TabState): ClosedConn[] {
  return [...state.closedConns].map(([connId, tMs]) => ({ connId, tMs }));
}

/**
 * Whether this tab holds a document that reported its capture hooks.
 *
 * Read by `snapshotFor` and by the test hook through the same function, so the two cannot drift
 * into disagreeing about what the panel is being told.
 */
function instrumentedFor(state: TabState): boolean {
  return state.instrumentedFrames.size > 0;
}

/**
 * Record an announcement, replacing whatever the previous document reported.
 *
 * A new TOP-LEVEL document destroys every frame beneath it, so its announcement clears the map
 * before recording itself: a subframe of the page the user just navigated away from must not keep
 * the tab looking instrumented. A subframe's own announcement only adds itself.
 */
function markInstrumented(state: TabState, frameId: number, port: chrome.runtime.Port): void {
  if (frameId === MAIN_FRAME_ID) state.instrumentedFrames.clear();
  state.instrumentedFrames.set(frameId, port);
}

/** Forget the frames a departing document held, without touching a replacement's. */
function forgetInstrumentedPort(port: chrome.runtime.Port): void {
  for (const [tabId, state] of tabs) {
    let changed = false;
    for (const [frameId, owner] of state.instrumentedFrames) {
      if (owner !== port) continue;
      state.instrumentedFrames.delete(frameId);
      changed = true;
    }
    if (changed) scheduleMirror(tabId);
  }
}

function broadcast(tabId: number, message: SwMessage): void {
  for (const [port, subscribed] of panelPorts) {
    if (subscribed === tabId) port.postMessage(message);
  }
}

/* -------------------------------------------------------------------------- */
/* WireFrame -> CaptureRecord                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `data:` payload of an SSE frame.
 *
 * `WireFrame.raw` for an event is pinned to the `data:` payload — the string `JSON.parse`
 * consumes — and all three transports agree on it. This still accepts full frame text, because
 * a frame carrying `event:`/`id:` lines would otherwise fail to parse for no good reason. A
 * payload that merely CONTAINS `data:` inside a string keeps its own text: no line starts with
 * the field name, so the loop yields nothing and the original is returned.
 */
function dataPayload(text: string): string {
  if (!text.includes('data:')) return text;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice('data:'.length);
    lines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return lines.length > 0 ? lines.join('\n') : text;
}

/**
 * Decode one event frame the same way the JSONL import path does: a non-object payload becomes
 * `event: null` and is still recorded, never dropped, so a malformed frame is surfaced and
 * flagged rather than disappearing. `raw` holds the decoded value when there is one — matching
 * `panel/import/load-jsonl.ts`, so `totalStreamBytes` counts a captured frame identically to a
 * re-imported one.
 */
function decodeEventFrame(text: string): { raw: unknown; event: AguiEvent | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataPayload(text));
  } catch {
    return { raw: text, event: null };
  }
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  return { raw: parsed, event: isObject ? (parsed as AguiEvent) : null };
}

/**
 * `tMs` is COPIED from the frame, not minted here. Requirements §5.5 wants the page-side arrival
 * time of the frame's first byte; a worker-side clock read would fold in postMessage and port
 * latency and quietly corrupt TTFT.
 */
function toRecord(frame: WireFrame, seq: number, connId: string): CaptureRecord {
  if (frame.kind === 'keepalive') {
    return {
      kind: 'keepalive',
      seq,
      tMs: frame.tMs,
      connId,
      raw: frame.raw,
      comment: frame.comment,
      issues: [],
    };
  }
  const decoded = decodeEventFrame(frame.raw);
  return {
    kind: 'event',
    seq,
    tMs: frame.tMs,
    connId,
    raw: decoded.raw,
    event: decoded.event,
    issues: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Session mirror                                                               */
/* -------------------------------------------------------------------------- */

const mirrorTimers = new Map<number, ReturnType<typeof setTimeout>>();

function sessionKey(tabId: number): string {
  return `${SESSION_KEY_PREFIX}${String(tabId)}`;
}

async function writeMirror(tabId: number): Promise<void> {
  const state = tabs.get(tabId);
  if (!state) return;
  const all = state.buffer.records();
  const kept = all.length > MIRROR_MAX_RECORDS ? all.slice(all.length - MIRROR_MAX_RECORDS) : all;
  const mirrored: MirroredTab = {
    v: 1,
    records: kept,
    requests: state.buffer.requests(),
    droppedBefore: droppedFor(state) + (all.length - kept.length),
    nextSeq: state.nextSeq,
    recording: state.recording,
    instrumentedFrames: [...state.instrumentedFrames.keys()],
    closedConns: closesFor(state),
  };
  await chrome.storage.session.set({ [sessionKey(tabId)]: mirrored });
}

function scheduleMirror(tabId: number): void {
  if (mirrorTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    mirrorTimers.delete(tabId);
    void writeMirror(tabId);
  }, MIRROR_DEBOUNCE_MS);
  mirrorTimers.set(tabId, timer);
}

/** Write now — used at connection close, the one moment a lost tail would lose a whole run. */
function flushMirror(tabId: number): void {
  const timer = mirrorTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    mirrorTimers.delete(tabId);
  }
  void writeMirror(tabId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Light structural check — this is our own data, and a corrupt entry is discarded, not trusted. */
function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!isRecord(value)) return false;
  const kind = value['kind'];
  return (
    (kind === 'event' || kind === 'keepalive') &&
    typeof value['seq'] === 'number' &&
    typeof value['tMs'] === 'number' &&
    typeof value['connId'] === 'string' &&
    Array.isArray(value['issues'])
  );
}

/**
 * A mirrored close, which must carry BOTH halves to be usable.
 *
 * A mirror written by an older build holds bare id strings, which fail this check and are
 * dropped. That is deliberate: the connection then reads as still open — exactly the behaviour
 * that build already had — rather than being finalised at a time this worker made up. A close
 * with a fabricated `tMs` would anchor `run-never-terminated` and every `unclosed-*` somewhere
 * they did not happen, which is worse than not claiming them at all. The next capture writes a
 * mirror in the current shape, so the gap closes itself.
 */
function isClosedConn(value: unknown): value is ClosedConn {
  return isRecord(value) && typeof value['connId'] === 'string' && typeof value['tMs'] === 'number';
}

function isRequestLine(value: unknown): value is RequestLine {
  return (
    isRecord(value) &&
    typeof value['connId'] === 'string' &&
    typeof value['tMs'] === 'number' &&
    typeof value['method'] === 'string' &&
    typeof value['url'] === 'string'
  );
}

function asMirroredTab(value: unknown): MirroredTab | null {
  if (!isRecord(value) || value['v'] !== 1) return null;
  const records = value['records'];
  const requests = value['requests'];
  const droppedBefore = value['droppedBefore'];
  const nextSeq = value['nextSeq'];
  if (!Array.isArray(records) || !Array.isArray(requests)) return null;
  if (typeof droppedBefore !== 'number' || typeof nextSeq !== 'number') return null;
  const frames = value['instrumentedFrames'];
  const closed = value['closedConns'];
  return {
    v: 1,
    records: records.filter(isCaptureRecord),
    requests: requests.filter(isRequestLine),
    droppedBefore,
    nextSeq,
    recording: value['recording'] !== false,
    // Absent in a mirror written by an older build. Empty is the honest reading: nothing was
    // recorded, so nothing is claimed.
    instrumentedFrames: Array.isArray(frames) ? frames.filter((id) => typeof id === 'number') : [],
    closedConns: Array.isArray(closed) ? closed.filter(isClosedConn) : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Restore gate                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Restore is async and port messages are not, so everything that touches a buffer is queued
 * behind it and drained IN ORDER. Handling a frame before the mirror loads would give it a seq
 * that the restored records then reuse.
 */
let restored = false;
const queued: (() => void)[] = [];

function afterRestore(work: () => void): void {
  if (restored) work();
  else queued.push(work);
}

async function restoreFromSession(): Promise<void> {
  try {
    const stored: Record<string, unknown> = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(SESSION_KEY_PREFIX)) continue;
      const tabId = Number(key.slice(SESSION_KEY_PREFIX.length));
      if (!Number.isInteger(tabId)) continue;
      const mirrored = asMirroredTab(value);
      if (!mirrored) continue;
      const state = ensureTab(tabId);
      for (const request of mirrored.requests) {
        state.buffer.addRequest(request);
        // A connection that outlives the worker will re-state its open; the restored request
        // line is the one that already answers it.
        state.seenConns.add(request.connId);
      }
      for (const record of mirrored.records) state.buffer.push(record);
      state.restoredDropped = mirrored.droppedBefore;
      state.nextSeq = mirrored.nextSeq;
      state.recording = mirrored.recording;
      // `null`: the port that reported each of these belonged to the worker incarnation that has
      // just been terminated. The documents are still open and still patched, so these entries
      // survive until a new announcement replaces them.
      for (const frameId of mirrored.instrumentedFrames) state.instrumentedFrames.set(frameId, null);
      for (const close of mirrored.closedConns) state.closedConns.set(close.connId, close.tMs);
    }
  } finally {
    restored = true;
    // Splice rather than iterate: a queued unit of work may itself queue more.
    while (queued.length > 0) {
      const work = queued.shift();
      if (work) work();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Relay port                                                                   */
/* -------------------------------------------------------------------------- */

const RELAY_KINDS: ReadonlySet<string> = new Set([
  'capture-installed',
  'conn-open',
  'frames',
  'conn-close',
  'binary',
]);

function asRelayMessage(value: unknown): RelayMessage | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !RELAY_KINDS.has(kind)) return null;
  // The announcement is the one message with no connection: it reports on the document, and a
  // document may be instrumented and never open a stream at all — which is exactly the case the
  // panel has to be able to tell apart from a document with no hooks in it.
  if (kind === 'capture-installed') return value as unknown as RelayMessage;
  if (typeof value['connId'] !== 'string') return null;
  if (kind === 'frames' && !Array.isArray(value['frames'])) return null;
  return value as unknown as RelayMessage;
}

function handleRelayMessage(
  tabId: number,
  message: RelayMessage,
  source: { frameId: number; port: chrome.runtime.Port },
): void {
  const state = ensureTab(tabId);

  /*
   * Handled BEFORE the recording gate, on purpose. Pausing is about data; the hooks are still
   * installed in the page, and reporting otherwise would make Pause look as if it had uninstalled
   * them. It is also broadcast on every announcement rather than on a change — see the note on
   * the `capture-installed` arm in `./protocol`.
   */
  if (message.kind === 'capture-installed') {
    markInstrumented(state, source.frameId, source.port);
    broadcast(tabId, { kind: 'capture-installed' });
    scheduleMirror(tabId);
    return;
  }
  // Not recording means not capturing: a paused panel must not fill the buffer behind the user's
  // back, and requirements §11's opt-in posture is meaningless if a "stopped" capture keeps data.
  if (!state.recording) return;

  switch (message.kind) {
    case 'conn-open': {
      // Idempotent by `connId`: this message is deliberately sent twice for most connections
      // (see `TabState.seenConns`), and the second copy must not add a second request line.
      if (state.seenConns.has(message.connId)) return;
      state.seenConns.add(message.connId);
      const request: RequestLine = {
        connId: message.connId,
        tMs: message.tMs,
        method: message.method,
        url: message.url,
        input: message.input,
      };
      state.buffer.addRequest(request);
      broadcast(tabId, { kind: 'request', request });
      scheduleMirror(tabId);
      return;
    }
    case 'frames': {
      const appended: CaptureRecord[] = [];
      for (const frame of message.frames) {
        const record = toRecord(frame, state.nextSeq, message.connId);
        state.nextSeq += 1;
        state.buffer.push(record);
        appended.push(record);
      }
      if (appended.length > 0) {
        // `droppedBefore` rides along on every append, not just the snapshot: eviction happens
        // during long sessions, which is exactly when P9's truncation marker has to be right.
        broadcast(tabId, {
          kind: 'append',
          records: appended,
          droppedBefore: droppedFor(state),
        });
      }
      scheduleMirror(tabId);
      return;
    }
    case 'conn-close': {
      // First close wins. The moment a connection ended does not change, and letting a repeat
      // overwrite it would move an anchor the panel has already been told about.
      if (!state.closedConns.has(message.connId)) {
        state.closedConns.set(message.connId, message.tMs);
      }
      broadcast(tabId, { kind: 'closed', connId: message.connId, tMs: message.tMs });
      // The end of a connection is the moment a lost tail costs a whole run, so this one writes
      // through instead of waiting out the debounce.
      flushMirror(tabId);
      return;
    }
    case 'binary': {
      // Requirements §5.4: detect and LABEL a binary transport, never decode it in this phase.
      // Recording it as a `CaptureRecord` would be a lie about what was seen; dropping it
      // entirely would make a protobuf stream indistinguishable from capture being broken,
      // which §15 names as the failure mode to avoid. So it is forwarded as its own arm.
      broadcast(tabId, {
        kind: 'binary',
        connId: message.connId,
        tMs: message.tMs,
        contentType: message.contentType,
        bytes: message.bytes,
      });
      return;
    }
  }
}

function attachRelayPort(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    // A relay port with no tab cannot be attributed to a buffer. Nothing to do but let it go.
    port.disconnect();
    return;
  }
  // §12 declares `all_frames: true` — agent chat is frequently in an iframe, and the deployment
  // this fix was found on is an `/embed` route — so ANY frame's announcement counts. The id
  // matters only for telling a top-level document from a subframe of it.
  const frameId = port.sender?.frameId ?? MAIN_FRAME_ID;
  port.onMessage.addListener((raw: unknown): void => {
    const message = asRelayMessage(raw);
    if (!message) return;
    afterRestore(() => {
      handleRelayMessage(tabId, message, { frameId, port });
    });
  });
  port.onDisconnect.addListener((): void => {
    // The document is gone. Its instrumentation goes with it, which is what stops a fresh page
    // load from inheriting the previous document's flag.
    afterRestore(() => {
      forgetInstrumentedPort(port);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Panel port                                                                   */
/* -------------------------------------------------------------------------- */

function snapshotFor(tabId: number): SwMessage {
  const state = ensureTab(tabId);
  return {
    kind: 'snapshot',
    records: state.buffer.records(),
    requests: state.buffer.requests(),
    // The connections that ended before this panel existed. Without them a panel opened after
    // the run never finalises it: the run sits in `outcome: 'running'` and every run-end issue
    // — `run-never-terminated` and the rest — is silently missing, while the identical bytes
    // exported and re-imported report all of them.
    closed: closesFor(state),
    droppedBefore: droppedFor(state),
    // How a panel opened AFTER the page loaded learns that the page announced itself — which is
    // the ordinary case, since the announcement fires at `document_start` and the panel is
    // usually opened later.
    instrumented: instrumentedFor(state),
  };
}

function clearTab(tabId: number, state: TabState): void {
  state.buffer.clear();
  state.restoredDropped = 0;
  state.seenConns.clear();
  // A clear empties the buffer, so the connections it held are no longer described by anything
  // here. Keeping their closes would let a reader mistake the previous scenario's finished
  // stream for the next one's.
  state.closedConns.clear();
  void chrome.storage.session.remove(sessionKey(tabId));
  broadcast(tabId, { kind: 'cleared' });
}

function handlePanelCommand(port: chrome.runtime.Port, command: PanelCommand): void {
  switch (command.kind) {
    case 'subscribe': {
      panelPorts.set(port, command.tabId);
      port.postMessage(snapshotFor(command.tabId));
      return;
    }
    case 'clear': {
      const tabId = panelPorts.get(port) ?? null;
      if (tabId === null) return;
      clearTab(tabId, ensureTab(tabId));
      return;
    }
    case 'set-recording': {
      const tabId = panelPorts.get(port) ?? null;
      if (tabId === null) return;
      ensureTab(tabId).recording = command.recording;
      scheduleMirror(tabId);
      return;
    }
  }
}

function asPanelCommand(value: unknown): PanelCommand | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (kind === 'subscribe') {
    return typeof value['tabId'] === 'number' ? { kind, tabId: value['tabId'] } : null;
  }
  if (kind === 'clear') return { kind };
  if (kind === 'set-recording') {
    return typeof value['recording'] === 'boolean' ? { kind, recording: value['recording'] } : null;
  }
  return null;
}

function attachPanelPort(port: chrome.runtime.Port): void {
  // Registered before the first command so the port counts as open — §15's keepalive half of the
  // termination mitigation is simply that a connected port keeps the worker alive.
  panelPorts.set(port, null);
  port.onMessage.addListener((raw: unknown): void => {
    const command = asPanelCommand(raw);
    if (!command) return;
    afterRestore(() => {
      handlePanelCommand(port, command);
    });
  });
  port.onDisconnect.addListener((): void => {
    panelPorts.delete(port);
  });
}

/* -------------------------------------------------------------------------- */
/* Runtime origin grants (D3, finding F4)                                       */
/* -------------------------------------------------------------------------- */

/**
 * `chrome.permissions.request` succeeding does NOT start capture: the manifest registers content
 * scripts for the localhost family only, and a runtime grant adds a permission, not a script.
 * Something has to call `chrome.scripting.registerContentScripts` for the new origin, and this is
 * that something — without it the grant succeeds and capture silently never starts, which is the
 * worst available outcome and worse than failing loudly.
 *
 * The scripts are copied from the manifest's own declarations rather than named here, because
 * the built filenames are content-hashed: `dist/inject.ts-<hash>.js` changes every build and a
 * hardcoded path would rot into a silent no-op.
 *
 * THIS USED TO BE NECESSARY BUT NOT SUFFICIENT, and the missing half was in the build. CRXJS
 * emitted both content scripts as loaders that dynamic-imported their real chunk, with those
 * chunks listed in `web_accessible_resources` scoped to the localhost family. A MAIN-world script
 * runs in the page's world, so on an origin granted here the import was denied outright: the
 * registration below succeeded and capture still never started. `vite.config.ts` now builds both
 * scripts as self-contained IIFEs (`contentScripts.standaloneFiles`), the built manifest has no
 * `web_accessible_resources` key at all, and registering an origin here is now sufficient on its
 * own. `packages/harness/e2e/non-localhost.spec.ts` holds that end to end; `scripts/verify-build.ts`
 * holds the emitted shape.
 */
const registeredMatches = new Set<string>();

function scriptId(index: number, match: string): string {
  return `agui-dt-${String(index)}-${match}`;
}

function manifestContentScripts(): chrome.runtime.ManifestV3['content_scripts'] {
  return chrome.runtime.getManifest().content_scripts ?? [];
}

function runAtOf(value: string | undefined): chrome.scripting.RegisteredContentScript['runAt'] {
  return value === 'document_end' || value === 'document_idle' ? value : 'document_start';
}

/**
 * `@types/chrome` declares `world` as `` `${ExecutionWorld}` `` — the string form of the enum,
 * not the enum itself — so the return type has to be the template-literal form or the two
 * literals below do not assign.
 */
function worldOf(value: string | undefined): `${chrome.scripting.ExecutionWorld}` {
  return value === 'MAIN' ? 'MAIN' : 'ISOLATED';
}

async function registerForMatches(matches: readonly string[]): Promise<void> {
  for (const match of matches) {
    if (registeredMatches.has(match)) continue;
    const declared = manifestContentScripts() ?? [];
    const scripts: chrome.scripting.RegisteredContentScript[] = declared.map((entry, index) => ({
      id: scriptId(index, match),
      matches: [match],
      js: entry.js ?? [],
      runAt: runAtOf(entry.run_at),
      world: worldOf(entry.world),
      allFrames: entry.all_frames ?? true,
    }));
    if (scripts.length === 0) continue;
    // Mark before awaiting: two grants for the same origin in the same tick would otherwise both
    // register and the second would reject with a duplicate id.
    registeredMatches.add(match);
    try {
      await chrome.scripting.registerContentScripts(scripts);
    } catch {
      // Already registered from a previous browser session — `registerContentScripts` persists
      // across sessions by default. Nothing to do, and nothing to log: a rejected promise left
      // unhandled in a worker is a broken worker.
    }
  }
}

async function unregisterForMatches(matches: readonly string[]): Promise<void> {
  for (const match of matches) {
    if (!registeredMatches.delete(match)) continue;
    const declared = manifestContentScripts() ?? [];
    const ids = declared.map((_entry, index) => scriptId(index, match));
    if (ids.length === 0) continue;
    try {
      await chrome.scripting.unregisterContentScripts({ ids });
    } catch {
      // Never registered, or already gone. Either way the end state is the one we want.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                       */
/* -------------------------------------------------------------------------- */

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port): void => {
  if (port.name === RELAY_PORT_NAME) attachRelayPort(port);
  else if (port.name === PANEL_PORT_NAME) attachPanelPort(port);
});

chrome.tabs.onRemoved.addListener((tabId: number): void => {
  tabs.delete(tabId);
  mirrorTimers.delete(tabId);
  void chrome.storage.session.remove(sessionKey(tabId));
});

chrome.permissions.onAdded.addListener((permissions: chrome.permissions.Permissions): void => {
  void registerForMatches(permissions.origins ?? []);
});

chrome.permissions.onRemoved.addListener((permissions: chrome.permissions.Permissions): void => {
  // §11 is opt-in per origin, so a revoked origin must stop being captured.
  void unregisterForMatches(permissions.origins ?? []);
});

/**
 * Aggregated across tabs: the hook's signature takes no `tabId`, and the harness drives exactly
 * one page. Ordering is per tab — `seq` is per tab too — so a multi-tab read is a concatenation,
 * not an interleave.
 */
globalThis.__AGUI_DT_TEST__ = {
  records(): CaptureRecord[] {
    return [...tabs.values()].flatMap((state) => state.buffer.records());
  },
  requests(): RequestLine[] {
    return [...tabs.values()].flatMap((state) => state.buffer.requests());
  },
  droppedBefore(): number {
    return [...tabs.values()].reduce((total, state) => total + droppedFor(state), 0);
  },
  bytes(): number {
    return [...tabs.values()].reduce((total, state) => total + state.buffer.bytes(), 0);
  },
  instrumented(): boolean {
    return [...tabs.values()].some(instrumentedFor);
  },
  closes(): ClosedConn[] {
    return [...tabs.values()].flatMap(closesFor);
  },
  clear(): void {
    for (const [tabId, state] of tabs) clearTab(tabId, state);
  },
};

void restoreFromSession();

export {};
