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
}

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
  };
  tabs.set(tabId, created);
  return created;
}

function droppedFor(state: TabState): number {
  return state.restoredDropped + state.buffer.droppedBefore();
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
  return {
    v: 1,
    records: records.filter(isCaptureRecord),
    requests: requests.filter(isRequestLine),
    droppedBefore,
    nextSeq,
    recording: value['recording'] !== false,
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

const RELAY_KINDS: ReadonlySet<string> = new Set(['conn-open', 'frames', 'conn-close', 'binary']);

function asRelayMessage(value: unknown): RelayMessage | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !RELAY_KINDS.has(kind)) return null;
  if (typeof value['connId'] !== 'string') return null;
  if (kind === 'frames' && !Array.isArray(value['frames'])) return null;
  return value as unknown as RelayMessage;
}

function handleRelayMessage(tabId: number, message: RelayMessage): void {
  const state = ensureTab(tabId);
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
  port.onMessage.addListener((raw: unknown): void => {
    const message = asRelayMessage(raw);
    if (!message) return;
    afterRestore(() => {
      handleRelayMessage(tabId, message);
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
    droppedBefore: droppedFor(state),
  };
}

function clearTab(tabId: number, state: TabState): void {
  state.buffer.clear();
  state.restoredDropped = 0;
  state.seenConns.clear();
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
 * KNOWN GAP, one layer further out and NOT fixable from here: CRXJS emits both content scripts
 * as loaders that dynamic-import their real chunk, and `web_accessible_resources` in the built
 * manifest scopes those chunks to the localhost family only. A MAIN-world script runs in the
 * page's world, so on a granted origin such as `https://example.com` that import is subject to
 * `web_accessible_resources` and is expected to fail. Registering here is necessary but may not
 * be sufficient until `manifest.config.ts` widens that list — which is a privacy trade (§11
 * wants the extension undetectable) and belongs with the manifest, not with the worker.
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
  clear(): void {
    for (const [tabId, state] of tabs) clearTab(tabId, state);
  },
};

void restoreFromSession();

export {};
