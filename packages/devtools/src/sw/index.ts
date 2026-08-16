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
import { cloneRuntimeInfo, isRuntimeInfo, type RuntimeInfo } from '../core/detect/info';
import type { AguiEvent, CaptureRecord } from '../core/model/types';
import type { WireFrame } from '../inject/protocol';
import {
  PANEL_PORT_NAME,
  RELAY_PORT_NAME,
  type ClosedConn,
  type PanelCommand,
  type RegistrationState,
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
        /** Whether any live document in any tab has reported the capture layer loaded in it. */
        loaded(): boolean;
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
        /**
         * The runtime metadata this worker has seen, read through `snapshotFor` like everything
         * else here — see the note on `everySnapshot`.
         *
         * `null` is the common answer and not a failure: most AG-UI apps never make an `/info`
         * request at all.
         */
        info(): RuntimeInfo | null;
        /**
         * Which origins the capture content scripts are registered for, and the last real
         * registration failure — the same `RegistrationState` a panel is sent.
         *
         * The fact the whole "capture dies after an extension update" defect turns on, and the one
         * the harness cannot get at any other way: the panel is unreachable from Playwright, and
         * `chrome.scripting.getRegisteredContentScripts()` read directly would say what Chrome
         * holds without saying what this worker BELIEVES, which is the half that was wrong.
         */
        registration(): RegistrationState;
        /**
         * Re-run the worker's boot-time reconciliation.
         *
         * The harness's only way to reproduce a second session against an existing grant: it
         * unregisters the scripts with the grant left in place and calls this, which is the same
         * function module scope calls.
         */
        reconcileRegistrations(): Promise<void>;
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
   * Frames of this tab whose relay has reported the capture layer loaded, mapped to the relay
   * port that reported it — or `null` for a frame restored from the session mirror, whose port
   * belonged to a previous incarnation of this worker.
   *
   * KEYED BY PORT, NOT JUST BY FRAME, for one reason: a reload reports the new document BEFORE
   * the old document's port disconnects, and a disconnect that removed a frame id outright would
   * therefore wipe the flag of the document that had just loaded. The port identifies the
   * DOCUMENT; the frame id identifies the slot it occupies.
   *
   * A restored (`null`) entry is never removed by a disconnect. The document it describes is
   * still open and still has its content scripts — it simply has nothing to say until it
   * navigates, and MV3 terminating an idle worker (§15) must not be mistaken for the page losing
   * them.
   */
  loadedFrames: Map<number, chrome.runtime.Port | null>;
  /**
   * The runtime metadata this tab has seen, or `null` when no `/info` response has arrived.
   *
   * RETAINED, not merely broadcast, for the same reason `closedConns` is: the discovery request
   * happens at the client's CONNECT, which is normally long before a panel is opened. A fact
   * delivered only to whoever was listening at the time would mean the agent list showed up for a
   * panel that happened to be open and never for the ordinary case — and the ordinary case is the
   * whole of done-when #2.
   *
   * LAST ANSWER WINS. A page that re-runs discovery — a client reconnect, a second runtime on the
   * same page — has told us something more current than the previous answer, and reporting the
   * stale one would describe a runtime that may no longer be the one in use. Nothing merges: two
   * runtimes' agent lists concatenated would be an agent list no runtime ever reported.
   */
  info: RuntimeInfo | null;
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
   * Frames that had reported the capture layer loaded when this was written.
   *
   * Mirrored for §15 risk row 1: the worker is terminated at ~30 s idle while the page stays open
   * and keeps its content scripts, and a flag that lived only in worker memory would come back
   * false — the panel would then warn about a page it had been capturing correctly a minute
   * earlier, which is the same false-report failure in the opposite direction.
   */
  loadedFrames: number[];
  /**
   * The runtime metadata this tab had seen when this was written.
   *
   * Mirrored for §15 risk row 1, and it is the field that needs it most: discovery happens ONCE,
   * at the client's connect. A worker terminated at ~30 s idle would come back having never seen
   * it and would never see it again for the life of that page — the Session tab would report an
   * absence for a page that answered, with no way to recover short of a reload.
   */
  info: RuntimeInfo | null;
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
    loadedFrames: new Map<number, chrome.runtime.Port | null>(),
    info: null,
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
 * Whether this tab holds a document whose relay reported the capture layer loaded.
 *
 * Read by `snapshotFor` and by the test hook through the same function, so the two cannot drift
 * into disagreeing about what the panel is being told.
 */
function loadedFor(state: TabState): boolean {
  return state.loadedFrames.size > 0;
}

/**
 * Record a report, replacing whatever the previous document reported.
 *
 * A new TOP-LEVEL document destroys every frame beneath it, so its report clears the map before
 * recording itself: a subframe of the page the user just navigated away from must not keep the
 * tab looking loaded. A subframe's own report only adds itself.
 *
 * This is why `capture-loaded` is a message rather than the bare port connection: replacing is
 * only correct for a NEW DOCUMENT, and a port cannot tell a new document from the relay
 * reconnecting after MV3 terminated an idle worker. The message is sent once per document.
 */
function markLoaded(state: TabState, frameId: number, port: chrome.runtime.Port): void {
  if (frameId === MAIN_FRAME_ID) state.loadedFrames.clear();
  state.loadedFrames.set(frameId, port);
}

/** Forget the frames a departing document held, without touching a replacement's. */
function forgetLoadedPort(port: chrome.runtime.Port): void {
  for (const [tabId, state] of tabs) {
    let changed = false;
    for (const [frameId, owner] of state.loadedFrames) {
      if (owner !== port) continue;
      state.loadedFrames.delete(frameId);
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
    loadedFrames: [...state.loadedFrames.keys()],
    info: state.info,
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
  const frames = value['loadedFrames'];
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
    loadedFrames: Array.isArray(frames) ? frames.filter((id) => typeof id === 'number') : [],
    // Re-validated on the way back in rather than trusted because it was ours on the way out:
    // `chrome.storage.session` is shared by the whole extension, and a mirror written by an older
    // build carries no `info` at all. `null` is the honest reading of both — nothing was recorded,
    // so nothing is claimed, and the next discovery response fills it in.
    info: isRuntimeInfo(value['info']) ? cloneRuntimeInfo(value['info']) : null,
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
      for (const frameId of mirrored.loadedFrames) state.loadedFrames.set(frameId, null);
      state.info = mirrored.info;
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
  'capture-loaded',
  'conn-open',
  'frames',
  'conn-close',
  'binary',
  'info',
]);

function asRelayMessage(value: unknown): RelayMessage | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !RELAY_KINDS.has(kind)) return null;
  // The relay's own report is the one message with no connection: it is about the document, and
  // a document may have the capture layer loaded and never open a stream at all — which is
  // exactly the case the panel has to be able to tell apart from a document with no content
  // scripts in it.
  if (kind === 'capture-loaded') return value as unknown as RelayMessage;
  if (typeof value['connId'] !== 'string') return null;
  if (kind === 'frames' && !Array.isArray(value['frames'])) return null;
  // Re-checked here as well as at the relay. The relay is the boundary the page reaches; this is
  // the boundary any extension-internal sender reaches, and `info` is the one arm whose payload is
  // a nested structure the panel renders and an export writes into a shared file.
  if (kind === 'info' && !isRuntimeInfo(value['info'])) return null;
  return value as unknown as RelayMessage;
}

function handleRelayMessage(
  tabId: number,
  message: RelayMessage,
  source: { frameId: number; port: chrome.runtime.Port },
): void {
  const state = ensureTab(tabId);

  /*
   * Handled BEFORE the recording gate, on purpose. Pausing is about data; the capture layer is
   * still loaded in the page, and reporting otherwise would make Pause look as if it had
   * uninstalled it. It is also broadcast on every report rather than on a change — see the note
   * on the `capture-loaded` arm in `./protocol`.
   */
  if (message.kind === 'capture-loaded') {
    markLoaded(state, source.frameId, source.port);
    broadcast(tabId, { kind: 'capture-loaded' });
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
    case 'info': {
      // Retained AND broadcast: retained so a panel opened later still gets it on its snapshot,
      // broadcast so a panel already watching does not have to wait for one. Rebuilt on the way
      // in for the same reason the relay rebuilds it.
      const info = cloneRuntimeInfo(message.info);
      state.info = info;
      broadcast(tabId, {
        kind: 'info',
        connId: message.connId,
        tMs: message.tMs,
        url: message.url,
        info,
      });
      // Discovery happens once per page, so losing it to a worker termination loses it for good —
      // this one writes through rather than waiting out the debounce, like a connection close.
      flushMirror(tabId);
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
  // this fix was found on is an `/embed` route — so ANY frame's report counts. The id matters
  // only for telling a top-level document from a subframe of it.
  //
  // Read from `port.sender`, which Chrome fills in. The relay never states which frame it is, so
  // frame identity is not something a compromised page could influence even if it could reach
  // this channel at all — which it cannot.
  const frameId = port.sender?.frameId ?? MAIN_FRAME_ID;
  port.onMessage.addListener((raw: unknown): void => {
    const message = asRelayMessage(raw);
    if (!message) return;
    afterRestore(() => {
      handleRelayMessage(tabId, message, { frameId, port });
    });
  });
  port.onDisconnect.addListener((): void => {
    // The document is gone. Its capture layer goes with it, which is what stops a fresh page
    // load from inheriting the previous document's flag.
    afterRestore(() => {
      forgetLoadedPort(port);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Panel port                                                                   */
/* -------------------------------------------------------------------------- */

type Snapshot = Extract<SwMessage, { kind: 'snapshot' }>;

function snapshotFor(tabId: number): Snapshot {
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
    // How a panel opened AFTER the page loaded learns that the relay reported itself — which is
    // the ordinary case, since the report fires at `document_start` and the panel is usually
    // opened later.
    loaded: loadedFor(state),
    // How a panel opened AFTER the client connected learns which agents the runtime reported —
    // which is the ordinary case, and the one done-when #2 is about. The push arm covers the
    // panel that happened to already be watching.
    info: state.info,
    // Whether the capture scripts are registered for the origin at all — the fact that separates
    // "this document predates the registration, so reload it" from "there is no registration, so
    // reloading achieves nothing". Not per tab: registration is per origin and global.
    registration: registrationState(),
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
  /*
   * The runtime metadata goes too, and this is the one place the decision is not obvious.
   *
   * KEEPING it would be nicer for a user who presses Clear: discovery happens once per page, so a
   * cleared tab does not get a second `/info` response and the agent list is gone until a reload.
   * But Clear is also what a NAVIGATION performs when preserve-log is off, and the next document
   * may be a different app entirely, on a different runtime, or on no runtime at all. Metadata
   * that survived a navigation would describe the previous page while the panel showed this one's
   * stream — a stale claim presented as a current one, which is the failure this project has been
   * corrected for twice. Losing a true fact is recoverable with a reload; showing a false one is
   * not recoverable at all, because the reader has no way to tell.
   */
  state.info = null;
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
    case 'reconcile-registrations': {
      /*
       * The panel's own repair path, and the reason it exists: after an extension reload or update
       * the origin is still granted and the registration is gone, so `permissions.onAdded` will
       * never fire again and the user has no way back short of revoking and re-granting. The
       * startup reconciliation covers the ordinary case; this covers the panel that is looking at
       * a broken tab RIGHT NOW and can say what it is doing about it.
       *
       * It takes no argument. The origin comes from `chrome.permissions.getAll()`, so nothing that
       * reaches this port can cause an origin the user never opted in to to be registered.
       */
      void reconcileRegistrations();
      return;
    }
  }
}

/**
 * Narrow a panel port payload to `PanelCommand`.
 *
 * OWN PROPERTIES ONLY. The panel is our own document rather than a hostile peer — the relay is the
 * boundary the page reaches, not this — but `Object.create({ kind: 'clear' })` would otherwise
 * validate here, and a guard whose safety rests on who happens to be calling it is a guard that
 * stops being safe the first time someone adds a sender. `reconcile-registrations` is the arm that
 * made this worth tightening: it is the one command that causes the extension to inject code
 * anywhere.
 */
function ownKind(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (!Object.hasOwn(value, 'kind')) return null;
  const kind = value['kind'];
  return typeof kind === 'string' ? kind : null;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function asPanelCommand(value: unknown): PanelCommand | null {
  const kind = ownKind(value);
  if (kind === null || !isRecord(value)) return null;
  if (kind === 'subscribe') {
    const tabId = ownValue(value, 'tabId');
    return typeof tabId === 'number' ? { kind, tabId } : null;
  }
  if (kind === 'clear') return { kind };
  if (kind === 'reconcile-registrations') return { kind };
  if (kind === 'set-recording') {
    const recording = ownValue(value, 'recording');
    return typeof recording === 'boolean' ? { kind, recording } : null;
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
 *
 * AND IT USED TO BE DRIVEN BY EXACTLY ONE EVENT, WHICH IS THE SECOND HALF OF THE SAME BUG.
 * `chrome.permissions.onAdded` fires when an origin is granted and never again, while a dynamic
 * registration does NOT reliably outlive the worker that made it — the permission survives, the
 * registration does not. So from the user's second day onwards capture silently stopped for every
 * origin they had ever granted, permanently, and re-granting could not repair it because the origin
 * was still granted and `onAdded` had nothing left to fire about.
 *
 * The `catch` below used to assert the opposite, in a comment: "registerContentScripts persists
 * across sessions by default". Measured, on this build, with `persistAcrossSessions: true` stated
 * explicitly and a probe registration the reconciliation below cannot touch: a registration made in
 * one session was GONE in the next, across a plain browser restart on the same profile and across a
 * version bump alike. The precise cause does not matter and is deliberately not encoded anywhere
 * here — reload, update, restart and idle respawn all reach the same place, and the reconciliation
 * repairs the state it finds rather than predicting how it got there.
 */

/**
 * Every script this worker registers carries this prefix, so `getRegisteredContentScripts()` can
 * be read back without claiming registrations that belong to nobody-knows-what.
 */
const SCRIPT_ID_PREFIX = 'agui-dt-';

/**
 * Match patterns this worker has DYNAMICALLY registered capture scripts for.
 *
 * REBUILT FROM `chrome.scripting.getRegisteredContentScripts()`, NEVER ASSUMED. It used to be a
 * plain in-memory `Set` that only ever grew, from `onAdded` — which meant that on every worker
 * respawn (MV3 terminates an idle worker at ~30 s, §15) it came back empty while the real
 * registrations were still in place. Revoking an origin then unregistered nothing, because
 * `unregisterForMatches` skipped any match the Set had never heard of: an origin the user had
 * explicitly opted OUT of went on being captured. That is the same class of error as the bug this
 * file is being corrected for — worker memory treated as the record of a fact that lives in
 * Chrome — so the record is read back from Chrome every time.
 */
const registeredMatches = new Set<string>();

/**
 * The last registration failure that was not a benign duplicate, or `null`.
 *
 * Retained rather than only logged: a service worker's console is not somewhere a user looks, and
 * a swallowed failure here is indistinguishable from capture simply not being wired up. It rides
 * on every `snapshot` and every `registration` push, so the panel can say what went wrong.
 */
let registrationError: string | null = null;

function scriptId(index: number, match: string): string {
  return `${SCRIPT_ID_PREFIX}${String(index)}-${match}`;
}

function manifestContentScripts(): NonNullable<chrome.runtime.ManifestV3['content_scripts']> {
  return chrome.runtime.getManifest().content_scripts ?? [];
}

/**
 * The patterns the MANIFEST already covers.
 *
 * Skipped by every dynamic path below. `chrome.permissions.getAll()` reports content-script
 * matches among its origins, so a reconciliation that did not exclude them would register a SECOND
 * copy of both scripts for the localhost family under ids of its own — and the manifest's copy
 * cannot be unregistered, so those pages would get the capture layer injected twice.
 */
function staticMatches(): ReadonlySet<string> {
  return new Set(manifestContentScripts().flatMap((entry) => entry.matches ?? []));
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

/** The registrations one match needs, copied from the manifest's own declarations. */
function scriptsFor(match: string): chrome.scripting.RegisteredContentScript[] {
  return manifestContentScripts().map((entry, index) => ({
    id: scriptId(index, match),
    matches: [match],
    js: entry.js ?? [],
    runAt: runAtOf(entry.run_at),
    world: worldOf(entry.world),
    allFrames: entry.all_frames ?? true,
  }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What Chrome says is registered, ours only. A failed read reports itself and claims nothing. */
async function readOurScripts(): Promise<chrome.scripting.RegisteredContentScript[]> {
  try {
    const all = await chrome.scripting.getRegisteredContentScripts();
    return all.filter((script) => script.id.startsWith(SCRIPT_ID_PREFIX));
  } catch (error) {
    registrationError = describeError(error);
    return [];
  }
}

/**
 * Rebuild `registeredMatches` from what Chrome actually holds.
 *
 * A match counts as registered only when EVERY script the manifest declares is present for it. A
 * half-registered origin — the MAIN-world patcher without the ISOLATED-world relay, say — is not a
 * working capture layer, and calling it registered would put the panel straight back to reporting
 * capture it does not have.
 */
function rebuildRegisteredMatches(
  scripts: readonly chrome.scripting.RegisteredContentScript[],
): void {
  const wanted = manifestContentScripts().length;
  const seen = new Map<string, number>();
  for (const script of scripts) {
    for (const match of script.matches ?? []) seen.set(match, (seen.get(match) ?? 0) + 1);
  }
  registeredMatches.clear();
  if (wanted === 0) return;
  for (const [match, count] of seen) {
    if (count >= wanted) registeredMatches.add(match);
  }
}

/**
 * Is this rejection the one that is genuinely fine?
 *
 * `registerContentScripts` rejects with `Duplicate script ID '<id>'` when an id is already
 * registered. That is the END STATE WE WANTED, so it is not reported. Everything else is a real
 * failure, and used to go into the same silent `catch` — which is precisely how a registration
 * that never happened stayed invisible through a release.
 */
function isDuplicateIdError(error: unknown): boolean {
  return /duplicate script id/i.test(describeError(error));
}

/**
 * One registration operation at a time.
 *
 * Each is a read-modify-write against Chrome's own list — read what is registered, register what
 * is missing — and two of those interleaved would both see the same gap and both try to fill it,
 * which is exactly the duplicate-id rejection the old code papered over. The startup
 * reconciliation racing a concurrent `permissions.onAdded` is the real pairing; a panel's
 * `reconcile-registrations` is a third. Serializing removes the race rather than tolerating it.
 *
 * The chain never rejects: each unit of work catches its own failure into `registrationError`, and
 * the `catch` here is the belt to that's braces — an unhandled rejection in a worker is a broken
 * worker.
 */
let registrationQueue: Promise<void> = Promise.resolve();

function serializeRegistration(work: () => Promise<void>): Promise<void> {
  registrationQueue = registrationQueue.then(work, work).catch(() => undefined);
  return registrationQueue;
}

/** The registration picture, as the panel is told it. One function, so the two cannot drift. */
function registrationState(): RegistrationState {
  return { matches: [...registeredMatches].sort(), error: registrationError };
}

function broadcastRegistration(): void {
  const message: SwMessage = { kind: 'registration', ...registrationState() };
  // Every panel, not only the ones subscribed to a tab: registration is per ORIGIN and global to
  // the extension, and a panel that has not sent `subscribe` yet still needs the answer.
  for (const port of panelPorts.keys()) port.postMessage(message);
}

/**
 * Register whatever `matches` needs and does not already have. Idempotent, and safe to call with
 * matches that are already registered, statically covered, or both.
 *
 * Per match rather than one batch call: `registerContentScripts` rejects the WHOLE batch on a
 * single bad entry, so batching would let one unregisterable origin silently take out every other
 * origin the user had granted.
 *
 * `registrationError` is cleared at the START of the pass rather than on each success, so it always
 * describes THIS attempt. Clearing it only on a successful write would strand a failure forever
 * once the steady state had nothing left to register, and the panel would go on naming a failure
 * for an origin that was working.
 */
async function registerMissing(matches: readonly string[]): Promise<void> {
  const declared = manifestContentScripts();
  if (declared.length === 0) return;
  const statics = staticMatches();
  registrationError = null;
  const existing = await readOurScripts();
  rebuildRegisteredMatches(existing);
  const existingIds = new Set(existing.map((script) => script.id));

  for (const match of matches) {
    if (statics.has(match)) continue;
    const missing = scriptsFor(match).filter((script) => !existingIds.has(script.id));
    if (missing.length === 0) continue;
    try {
      await chrome.scripting.registerContentScripts(missing);
      for (const script of missing) existingIds.add(script.id);
    } catch (error) {
      if (isDuplicateIdError(error)) continue;
      // A real failure. Recorded rather than logged: it reaches the panel on the next snapshot or
      // push, which is somewhere a user and a test can both see it.
      registrationError = describeError(error);
    }
  }
  // Re-read rather than trusting the writes above: what is registered is Chrome's fact, and a
  // partial failure would otherwise leave this worker claiming an origin it does not have.
  rebuildRegisteredMatches(await readOurScripts());
}

function registerForMatches(matches: readonly string[]): Promise<void> {
  return serializeRegistration(async () => {
    await registerMissing(matches);
    broadcastRegistration();
  });
}

/**
 * THE FIX. Bring registrations back in line with the origins the user has actually granted.
 *
 * Read what is granted, read what is registered, register the difference. Idempotent, so it is
 * safe on every worker spawn — which is exactly where it is called from.
 *
 * WHY MODULE SCOPE RATHER THAN `onInstalled` + `onStartup`. Those two are the obvious answer and
 * they are not sufficient: neither fires when Chrome respawns a worker it terminated for idleness,
 * which is the single most common way this worker starts. Module scope runs on EVERY spawn —
 * install, update, browser start, idle respawn — so it is a strict superset of both, and it is one
 * code path instead of three that have to agree with each other.
 *
 * The three objections, considered and answered:
 *
 *   - WORKER STARTUP COST. Two IPC round-trips (`permissions.getAll`,
 *     `getRegisteredContentScripts`) and, in the steady state, no write at all. It is async and
 *     nothing waits on it.
 *   - ORDERING AGAINST `onConnect`. The listeners at the bottom of this file are added
 *     synchronously at module scope, before this ever awaits, so a port that connects during the
 *     reconciliation is still caught — Chrome's requirement is only that listeners are registered
 *     in the first turn. Buffer traffic is gated on the session restore (`afterRestore`) and
 *     deliberately not on this: reconciliation touches no tab state, and making frames wait on a
 *     `permissions` round-trip would be a real cost for no benefit.
 *   - A CONCURRENT `onAdded`. Serialized — see `serializeRegistration`.
 */
function reconcileRegistrations(): Promise<void> {
  return serializeRegistration(async () => {
    let granted: string[];
    try {
      granted = (await chrome.permissions.getAll()).origins ?? [];
    } catch (error) {
      registrationError = describeError(error);
      broadcastRegistration();
      return;
    }
    await registerMissing(granted);
    broadcastRegistration();
  });
}

function unregisterForMatches(matches: readonly string[]): Promise<void> {
  return serializeRegistration(async () => {
    const statics = staticMatches();
    // Cleared first, for the same reason `registerMissing` clears first: the field describes THIS
    // attempt, not the last one that happened to write to it.
    registrationError = null;
    const existingIds = new Set((await readOurScripts()).map((script) => script.id));
    // Driven by what Chrome holds, NOT by `registeredMatches`: the old code skipped any match its
    // in-memory Set had not seen, so after a worker respawn a revoked origin kept its scripts and
    // went on being captured.
    const ids = matches
      .filter((match) => !statics.has(match))
      .flatMap((match) => scriptsFor(match).map((script) => script.id))
      .filter((id) => existingIds.has(id));
    if (ids.length > 0) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids });
      } catch (error) {
        registrationError = describeError(error);
      }
    }
    rebuildRegisteredMatches(await readOurScripts());
    broadcastRegistration();
  });
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
 * Every tab's snapshot — literally the message `subscribe` sends a panel, built by the same
 * function.
 *
 * READ THROUGH `snapshotFor`, NOT OUT OF THE STATE BESIDE IT. The harness's whole claim is that
 * what it asserts on is what a panel is told; a hook that assembled its own view of the same
 * state could keep passing while the panel's message lost a field, which is exactly the defect
 * this hook is now used to hold. Measured: with the hook reading state directly, deleting
 * `closed` from `snapshotFor` left the entire e2e green.
 */
function everySnapshot(): Snapshot[] {
  return [...tabs.keys()].map(snapshotFor);
}

/**
 * Aggregated across tabs: the hook's signature takes no `tabId`, and the harness drives exactly
 * one page. Ordering is per tab — `seq` is per tab too — so a multi-tab read is a concatenation,
 * not an interleave.
 */
globalThis.__AGUI_DT_TEST__ = {
  records(): CaptureRecord[] {
    return everySnapshot().flatMap((snapshot) => snapshot.records);
  },
  requests(): RequestLine[] {
    return everySnapshot().flatMap((snapshot) => snapshot.requests);
  },
  droppedBefore(): number {
    return everySnapshot().reduce((total, snapshot) => total + snapshot.droppedBefore, 0);
  },
  bytes(): number {
    // The one figure no panel is sent: it describes the buffer's own occupancy, not the capture.
    return [...tabs.values()].reduce((total, state) => total + state.buffer.bytes(), 0);
  },
  loaded(): boolean {
    return everySnapshot().some((snapshot) => snapshot.loaded);
  },
  closes(): ClosedConn[] {
    return everySnapshot().flatMap((snapshot) => snapshot.closed);
  },
  info(): RuntimeInfo | null {
    // First non-null across tabs. The harness drives one page; a `find` rather than a `flatMap`
    // because this is one fact per tab, not a list, and concatenating two tabs' runtimes would
    // describe neither.
    return everySnapshot().map((snapshot) => snapshot.info).find((info) => info !== null) ?? null;
  },
  registration(): RegistrationState {
    /*
     * The SAME function `snapshotFor` embeds, not a second view of the same state.
     *
     * It cannot go through `everySnapshot()` like the fields above, because registration is not per
     * tab and the harness has to be able to read it before any page exists — which is exactly the
     * moment the reconciliation being tested happens. The drift risk `everySnapshot` exists to
     * prevent is closed instead by `sw/index.test.ts`, which asserts a real panel's `snapshot`
     * carries the identical value.
     */
    return registrationState();
  },
  reconcileRegistrations(): Promise<void> {
    // Literally the worker's boot path, called again. The harness uses this to reproduce a second
    // session against an existing grant — the case no test could reach while the only trigger was
    // `permissions.onAdded`, because every e2e granted inside the test.
    return reconcileRegistrations();
  },
  clear(): void {
    for (const [tabId, state] of tabs) clearTab(tabId, state);
  },
};

void restoreFromSession();

/**
 * Reconcile registrations on EVERY worker spawn — install, update, browser start, idle respawn.
 *
 * This line is the fix. See `reconcileRegistrations` for why it is here rather than under
 * `chrome.runtime.onInstalled` + `onStartup`, which between them miss the most common spawn there
 * is.
 */
void reconcileRegistrations();

export {};
