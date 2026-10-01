import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureRecord } from '../core/model/types';
import type { WireFrame } from '../inject/protocol';
import { MAX_RENDER_RING_CHARS, renderReportChars } from '../core/signals/render-report';
import { maxSizeRenderReport } from '../test/render-reports';
import {
  PANEL_PORT_NAME,
  RELAY_PORT_NAME,
  type PanelCommand,
  type RelayMessage,
  type SwMessage,
} from './protocol';

/* -------------------------------------------------------------------------- */
/* A `chrome` stub covering exactly the surface the worker touches.             */
/* -------------------------------------------------------------------------- */

type Listener<A extends unknown[]> = (...args: A) => void;

class FakeEvent<A extends unknown[]> {
  private readonly listeners: Listener<A>[] = [];
  addListener(fn: Listener<A>): void {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener<A>): void {
    const index = this.listeners.indexOf(fn);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  emit(...args: A): void {
    for (const fn of [...this.listeners]) fn(...args);
  }
}

class FakePort {
  readonly onMessage = new FakeEvent<[unknown, FakePort]>();
  readonly onDisconnect = new FakeEvent<[FakePort]>();
  /** Everything the worker has sent to this port. */
  readonly sent: SwMessage[] = [];
  constructor(
    readonly name: string,
    readonly sender?: { tab?: { id: number }; frameId?: number; id?: string; url?: string },
  ) {}
  postMessage(message: unknown): void {
    this.sent.push(message as SwMessage);
  }
  disconnect(): void {
    this.onDisconnect.emit(this);
  }
}

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** The two content scripts `manifest.config.ts` declares, as `getManifest()` reports them. */
const MANIFEST_CONTENT_SCRIPTS = [
  {
    matches: ['http://localhost/*'],
    js: ['inject.js'],
    run_at: 'document_start',
    world: 'MAIN',
    all_frames: true,
  },
  {
    matches: ['http://localhost/*'],
    js: ['relay-loader.js'],
    run_at: 'document_start',
    world: 'ISOLATED',
    all_frames: true,
  },
];

interface RegisteredScript {
  id: string;
  matches?: string[];
  js?: string[];
  runAt?: string;
  world?: string;
  allFrames?: boolean;
}

/** One `chrome.action` call, as the worker made it. */
interface ActionCall {
  method: 'setBadgeText' | 'setBadgeBackgroundColor' | 'setTitle';
  details: { tabId?: number; text?: string; title?: string; color?: string };
}

interface ChromeStub {
  session: Map<string, unknown>;
  /** Every `chrome.action` call, in order. */
  actions: ActionCall[];
  connect(port: FakePort): void;
  removeTab(tabId: number): void;
  /** Resolve reads held back by `deferGet` — lets a test pin the worker mid-restore. */
  releaseGet(): void;
  /** Fire `chrome.permissions.onAdded` for a runtime origin grant (D3 / finding F4). */
  grantOrigins(origins: string[]): void;
  removeOrigins(origins: string[]): void;
  registered: RegisteredScript[];
  /**
   * Origins `chrome.permissions.getAll()` reports as granted, ALONE — nothing here registers a
   * content script.
   *
   * That separation is the whole point: it is what lets a test express "the origin is granted and
   * nothing is registered for it", which is the state Chrome leaves behind after an extension
   * reload or update and the state no test in this suite could previously describe.
   */
  grantedOrigins: string[];
  /** Resolve reads held back by `deferScriptRead`. */
  releaseScriptRead(): void;
  /** `chrome.storage.local` — where Developer mode lives (§14.4, R6). */
  local: Map<string, unknown>;
  /** Every `chrome.tabs.sendMessage`, in order. */
  tabMessages: Array<{ tabId: number; message: unknown; options: unknown }>;
  /** What the tab's relay answers; rejects (no receiving end) by default. */
  tabAnswer: (tabId: number, message: unknown) => Promise<unknown>;
}

interface StubOptions {
  deferGet?: boolean;
  /** Registrations Chrome already holds — a worker respawning onto live registrations. */
  registered?: RegisteredScript[];
  /** Origins granted before this worker ever ran. Registers nothing. */
  granted?: string[];
  /** Make `registerContentScripts` reject with this message, for the error-reporting path. */
  failRegistration?: string;
  /**
   * Hold `getRegisteredContentScripts` open until `releaseScriptRead()`.
   *
   * The real shape of a freshly spawned worker: the read is two async IPC hops and a panel can
   * subscribe before it lands. This is the only way to pin the worker in the moment where it does
   * not yet know what is registered.
   */
  deferScriptRead?: boolean;
}

function installChrome(session: Map<string, unknown> = new Map(), options: StubOptions = {}): ChromeStub {
  const onConnect = new FakeEvent<[FakePort]>();
  const onRemoved = new FakeEvent<[number]>();
  const onAdded = new FakeEvent<[{ origins?: string[] }]>();
  const onPermissionsRemoved = new FakeEvent<[{ origins?: string[] }]>();
  const held: (() => void)[] = [];
  const registered: RegisteredScript[] = [...(options.registered ?? [])];
  const heldScriptReads: (() => void)[] = [];
  const grantedOrigins: string[] = [...(options.granted ?? [])];
  const actions: ActionCall[] = [];
  const recordAction =
    (method: ActionCall['method']) =>
    (details: ActionCall['details']): Promise<void> => {
      actions.push({ method, details: { ...details } });
      return Promise.resolve();
    };

  const local = new Map<string, unknown>();
  const storageLocal = {
    get(key: string | null): Promise<Record<string, unknown>> {
      if (key === null) return Promise.resolve(Object.fromEntries(local));
      return Promise.resolve(local.has(key) ? { [key]: local.get(key) } : {});
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) local.set(key, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) local.delete(key);
      return Promise.resolve();
    },
  };
  const tabMessages: ChromeStub['tabMessages'] = [];

  const storageSession = {
    get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      if (keys === null) {
        Object.assign(out, Object.fromEntries(session));
      } else {
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          if (session.has(key)) out[key] = session.get(key);
        }
      }
      if (options.deferGet !== true) return Promise.resolve(out);
      return new Promise<Record<string, unknown>>((resolve) => {
        held.push(() => {
          resolve(out);
        });
      });
    },
    set(items: Record<string, unknown>): Promise<void> {
      // The real API structured-clones on the way in. Round-tripping through JSON here proves
      // the mirror is actually serializable instead of discovering it in Chrome.
      for (const [key, value] of Object.entries(items)) {
        session.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      }
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) session.delete(key);
      return Promise.resolve();
    },
  };

  const scripting = {
    registerContentScripts(scripts: RegisteredScript[]): Promise<void> {
      if (options.failRegistration !== undefined) {
        return Promise.reject(new Error(options.failRegistration));
      }
      for (const script of scripts) {
        if (registered.some((existing) => existing.id === script.id)) {
          // Chrome rejects the WHOLE batch on a duplicate id, and rejects it before registering
          // anything — modelled exactly, because the worker's "is this rejection benign" check
          // reads the message.
          return Promise.reject(new Error(`Duplicate script ID '${script.id}'`));
        }
      }
      registered.push(...scripts);
      return Promise.resolve();
    },
    unregisterContentScripts(filter: { ids?: string[] }): Promise<void> {
      for (const id of filter.ids ?? []) {
        const index = registered.findIndex((script) => script.id === id);
        if (index >= 0) registered.splice(index, 1);
      }
      return Promise.resolve();
    },
    /**
     * What Chrome holds, which is the only authority the worker now trusts. A COPY, so a caller
     * cannot mutate the stub's list through the value it was handed.
     */
    getRegisteredContentScripts(): Promise<RegisteredScript[]> {
      const answer = (): RegisteredScript[] => registered.map((script) => ({ ...script }));
      if (options.deferScriptRead !== true) return Promise.resolve(answer());
      return new Promise<RegisteredScript[]>((resolve) => {
        heldScriptReads.push(() => {
          resolve(answer());
        });
      });
    },
  };

  globalThis.chrome = {
    runtime: {
      onConnect,
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => ({ content_scripts: MANIFEST_CONTENT_SCRIPTS }),
    },
    storage: { session: storageSession, local: storageLocal },
    tabs: {
      onRemoved,
      sendMessage: (tabId: number, message: unknown, options: unknown): Promise<unknown> => {
        tabMessages.push({ tabId, message, options });
        return stub.tabAnswer(tabId, message);
      },
    },
    permissions: {
      onAdded,
      onRemoved: onPermissionsRemoved,
      /**
       * The origins the user has actually granted, INDEPENDENT of what is registered.
       *
       * The whole defect lives in the gap between these two lists: a grant survives an extension
       * reload or update and the registration made from it does not, so a stub that derived one
       * from the other could not express the broken state at all — which is precisely why no test
       * caught this.
       *
       * Seeded with the manifest's own content-script matches, because real Chrome reports those
       * among `getAll().origins`. A reconciliation that did not exclude them would register a
       * second, dynamic copy of both scripts for the localhost family.
       */
      contains: (query: { origins?: string[] }): Promise<boolean> =>
        Promise.resolve(
          (query.origins ?? []).every((origin) =>
            grantedOrigins.some(
              // Exact, or the scheme-wide `https://*/*` that Chrome's "On all sites" grants.
              (granted) => granted === origin || (/^https?:\/\/\*\/\*$/.test(granted) && origin.startsWith(granted.slice(0, -3))),
            ),
          ),
        ),
      getAll: (): Promise<{ origins: string[] }> =>
        Promise.resolve({
          origins: [
            ...MANIFEST_CONTENT_SCRIPTS.flatMap((entry) => entry.matches),
            ...grantedOrigins,
          ],
        }),
    },
    scripting,
    action: {
      setBadgeText: recordAction('setBadgeText'),
      setBadgeBackgroundColor: recordAction('setBadgeBackgroundColor'),
      setTitle: recordAction('setTitle'),
    },
  } as unknown as typeof chrome;

  const stub: ChromeStub = {
    local,
    tabMessages,
    tabAnswer: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    session,
    actions,
    registered,
    grantedOrigins,
    connect: (port) => {
      onConnect.emit(port);
    },
    removeTab: (tabId) => {
      onRemoved.emit(tabId);
    },
    releaseScriptRead: () => {
      while (heldScriptReads.length > 0) {
        const resolve = heldScriptReads.shift();
        if (resolve) resolve();
      }
    },
    releaseGet: () => {
      while (held.length > 0) {
        const resolve = held.shift();
        if (resolve) resolve();
      }
    },
    grantOrigins: (origins) => {
      // A real grant does BOTH: the permission becomes granted, and `onAdded` fires once.
      for (const origin of origins) {
        if (!grantedOrigins.includes(origin)) grantedOrigins.push(origin);
      }
      onAdded.emit({ origins });
    },
    removeOrigins: (origins) => {
      for (const origin of origins) {
        const index = grantedOrigins.indexOf(origin);
        if (index >= 0) grantedOrigins.splice(index, 1);
      }
      onPermissionsRemoved.emit({ origins });
    },
  };
  return stub;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every test here loads a fresh worker module, and the previous one does not go away: its pending
 * 250 ms mirror write still fires, and it writes through whatever `chrome` stub is installed BY
 * THEN — a later test's session storage. Measured: with the restart tests on tab 7 (the tab most
 * tests drive), an earlier test's leftover write overwrote the mirror they had just made, and
 * `re-applies the badge for a restored tab` failed 3 runs out of 3.
 *
 * Chrome ends a terminated worker's timers with it, so `loadWorker` does the same: `setTimeout` is
 * faked for this file (and only it — `shouldAdvanceTime` keeps it running on the real clock, so
 * `settle(300)` still waits 300 ms and still lets a debounced write land), and a new incarnation
 * starts by clearing whatever the last one left pending.
 */
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'],
    shouldAdvanceTime: true,
    // The fake clock follows the real one in steps of this size; the 20 ms default made every
    // `settle()` cost up to 20 ms, which more than doubled this file's run time.
    advanceTimeDelta: 1,
  });
});

afterAll(() => {
  vi.useRealTimers();
});

async function loadWorker(): Promise<void> {
  vi.clearAllTimers();
  vi.resetModules();
  await import('./index');
}

/** Let the restore promise and any pending mirror write settle. */
async function settle(ms = 0): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function testHook(): NonNullable<typeof globalThis.__AGUI_DT_TEST__> {
  const hook = globalThis.__AGUI_DT_TEST__;
  if (!hook) throw new Error('__AGUI_DT_TEST__ was not installed');
  return hook;
}

/** `frameId` 0 is the top-level document; anything else is an iframe (§12 `all_frames: true`). */
function relayPort(tabId: number, frameId = 0): FakePort {
  return new FakePort(RELAY_PORT_NAME, { tab: { id: tabId }, frameId });
}

const loadedReport: RelayMessage = { v: 1, kind: 'capture-loaded' };

/** A DevTools panel: an extension page, as Chrome describes its sender. */
function panelPort(): FakePort {
  return new FakePort(PANEL_PORT_NAME, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/panel/panel.html` });
}

function send(port: FakePort, message: RelayMessage | PanelCommand): void {
  port.onMessage.emit(message, port);
}

function eventFrame(tMs: number, event: Record<string, unknown>): WireFrame {
  return { kind: 'event', tMs, raw: JSON.stringify(event) };
}

function connOpen(connId: string, tMs = 0): RelayMessage {
  return {
    v: 1,
    kind: 'conn-open',
    connId,
    tMs,
    method: 'POST',
    url: '/agent',
    contentType: 'text/event-stream',
    input: { threadId: 't1' },
  };
}

function messagesOfKind<K extends SwMessage['kind']>(
  port: FakePort,
  kind: K,
): Extract<SwMessage, { kind: K }>[] {
  return port.sent.filter(
    (message): message is Extract<SwMessage, { kind: K }> => message.kind === kind,
  );
}

function snapshotOf(port: FakePort): Extract<SwMessage, { kind: 'snapshot' }> {
  const snapshot = messagesOfKind(port, 'snapshot')[0];
  if (!snapshot) throw new Error('no snapshot was sent');
  return snapshot;
}

function appendedRecords(port: FakePort): CaptureRecord[] {
  return messagesOfKind(port, 'append').flatMap((message) => message.records);
}

/* -------------------------------------------------------------------------- */

describe('service worker', () => {
  let stub: ChromeStub;

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('installs the test hook unconditionally, with no port ever connected', () => {
    const hook = testHook();
    expect(hook.records()).toEqual([]);
    expect(hook.requests()).toEqual([]);
    expect(hook.droppedBefore()).toBe(0);
    expect(hook.bytes()).toBe(0);
  });

  it('assigns seq, tMs, connId and kind when turning wire frames into records', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [
        eventFrame(12, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
        { kind: 'keepalive', tMs: 15, raw: ': ping\n\n', comment: 'ping' },
        eventFrame(20, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }),
      ],
    });

    const records = testHook().records();
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.tMs)).toEqual([12, 15, 20]);
    expect(records.every((record) => record.connId === 'c1')).toBe(true);
    expect(records.map((record) => record.kind)).toEqual(['event', 'keepalive', 'event']);

    const first = records[0];
    if (first?.kind !== 'event') throw new Error('expected an event record');
    expect(first.event?.['type']).toBe('RUN_STARTED');
    expect(first.issues).toEqual([]);

    const second = records[1];
    if (second?.kind !== 'keepalive') throw new Error('expected a keepalive record');
    expect(second.comment).toBe('ping');
    expect(second.raw).toBe(': ping\n\n');
  });

  it('records an unparseable frame with event null instead of dropping it', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [{ kind: 'event', tMs: 5, raw: '{not json' }],
    });

    const record = testHook().records()[0];
    if (record?.kind !== 'event') throw new Error('expected an event record');
    expect(record.event).toBeNull();
    expect(record.raw).toBe('{not json');
  });

  it('parses full SSE frame text as well as a bare data payload', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [{ kind: 'event', tMs: 5, raw: 'event: message\ndata: {"type":"RUN_STARTED"}\n\n' }],
    });

    const record = testHook().records()[0];
    if (record?.kind !== 'event') throw new Error('expected an event record');
    expect(record.event?.['type']).toBe('RUN_STARTED');
  });

  it('keeps a frame’s SSE event name on its record, and adds nothing to an unnamed one (L2)', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [
        { kind: 'event', tMs: 5, raw: '{"run_id":"r1","attempt":1}', eventName: 'metadata' },
        eventFrame(6, { type: 'RUN_STARTED' }),
      ],
    });

    const [named, unnamed] = testHook().records();
    if (named?.kind !== 'event' || unnamed?.kind !== 'event') throw new Error('expected event records');
    expect(named.sseEvent).toBe('metadata');
    expect(named.raw).toEqual({ run_id: 'r1', attempt: 1 });
    expect('sseEvent' in unnamed).toBe(false);
  });

  it('replays a snapshot to a panel that subscribes after the run', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const snapshot = snapshotOf(panel);
    expect(snapshot.records.map((record) => record.seq)).toEqual([1]);
    expect(snapshot.requests.map((request) => request.url)).toEqual(['/agent']);
    expect(snapshot.droppedBefore).toBe(0);
    // Nothing has closed yet, and the snapshot says so rather than omitting the question.
    expect(snapshot.closed).toEqual([]);
  });

  /**
   * The whole point of the replay, for a run that is already over.
   *
   * Closing is the sole trigger for `finalizeRules`, which is the sole owner of every run-end
   * issue. A snapshot that carried records and requests but not the closes left a panel opened
   * after the run unable to finalise it: the run sat in `outcome: 'running'` and
   * `run-never-terminated` was silently missing, while the same bytes exported and re-imported
   * reported it. See `panel/capture/late-panel-parity.test.ts` for that comparison.
   */
  it('replays the closes to a late panel, with the time each connection ended', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 88, reason: 'complete' });

    // Subscribing only NOW — the ordinary case, since DevTools is opened when something looks
    // wrong, which is after the run.
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    // The time, not just the id: every run-end issue is anchored to it, so an id alone would
    // force the panel to invent one.
    expect(snapshotOf(panel).closed).toEqual([{ connId: 'c1', tMs: 88 }]);
    // And no `closed` push was needed to learn it — this panel was not there for that message.
    expect(messagesOfKind(panel, 'closed')).toEqual([]);
  });

  it('reports only the closes of the tab the panel is watching', () => {
    const seven = relayPort(7);
    const nine = relayPort(9);
    stub.connect(seven);
    stub.connect(nine);
    send(seven, connOpen('c1'));
    send(nine, connOpen('c2'));
    send(seven, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 10, reason: 'complete' });
    send(nine, { v: 1, kind: 'conn-close', connId: 'c2', tMs: 20, reason: 'complete' });

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 9 });

    expect(snapshotOf(panel).closed).toEqual([{ connId: 'c2', tMs: 20 }]);
  });

  it('keeps the first close time when a connection reports closing twice', () => {
    // The moment a connection ended does not change. Letting a repeat overwrite it would move an
    // anchor the panel has already been told about.
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 900, reason: 'error' });

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    expect(snapshotOf(panel).closed).toEqual([{ connId: 'c1', tMs: 40 }]);
  });

  it('drops the closes from the snapshot when the buffer is cleared', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'clear' });

    const later = panelPort();
    stub.connect(later);
    send(later, { kind: 'subscribe', tabId: 7 });

    // A clear empties the records, so a close left behind would finalise a run that is no longer
    // there — and would answer for the NEXT scenario's connection if it reused the id.
    expect(snapshotOf(later).closed).toEqual([]);
  });

  it('appends to the subscribed panel only, never to a panel watching another tab', () => {
    const watcher = panelPort();
    stub.connect(watcher);
    send(watcher, { kind: 'subscribe', tabId: 7 });
    const other = panelPort();
    stub.connect(other);
    send(other, { kind: 'subscribe', tabId: 9 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });

    expect(appendedRecords(watcher).map((record) => record.seq)).toEqual([1]);
    expect(appendedRecords(other)).toEqual([]);
  });

  it('forwards conn-open as a request line and conn-close as closed', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1', 3));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 99, reason: 'complete' });

    expect(messagesOfKind(panel, 'request')[0]?.request).toEqual({
      connId: 'c1',
      tMs: 3,
      method: 'POST',
      url: '/agent',
      input: { threadId: 't1' },
    });
    expect(messagesOfKind(panel, 'closed')[0]).toEqual({ kind: 'closed', connId: 'c1', tMs: 99 });
  });

  it('ignores a re-stated conn-open instead of duplicating the request line', () => {
    // The relay's listener registers a tick after `document_start` (see the plan's decision for
    // this task), so the MAIN world re-states `conn-open` alongside the first `frames` message
    // for a connection. On the normal path that means the worker sees it twice, and the second
    // one must change nothing: two request lines for one connection would double-count the
    // `RunAgentInput` the run builder reads.
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1', 3));
    send(relay, connOpen('c1', 3));
    send(relay, connOpen('c2', 8));

    expect(testHook().requests().map((request) => request.connId)).toEqual(['c1', 'c2']);
    expect(messagesOfKind(panel, 'request').length).toBe(2);
  });

  it('accepts a conn-open that arrives only with the first frames message', () => {
    // The window the re-statement exists for: the ORIGINAL `conn-open` was posted before the
    // relay was listening and never arrived, so the first thing the worker sees for `c1` is the
    // re-stated open. It must be treated as the connection's request line, not discarded for
    // arriving late — otherwise the run surfaces as `run-started-without-input`, which reads as
    // a finding about the user's server rather than a defect in our capture.
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1', 3));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });

    expect(testHook().requests().map((request) => request.input)).toEqual([{ threadId: 't1' }]);
    expect(testHook().records().length).toBe(1);
  });

  it('honours set-recording in both directions', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);

    send(panel, { kind: 'set-recording', recording: false });
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { type: 'RUN_STARTED' })],
    });
    expect(testHook().records()).toEqual([]);

    send(panel, { kind: 'set-recording', recording: true });
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(2, { type: 'RUN_STARTED' })],
    });
    expect(testHook().records().map((record) => record.tMs)).toEqual([2]);
  });

  it('clears the buffer, the mirror, and the panel on the clear command', async () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { type: 'RUN_STARTED' })],
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9, reason: 'complete' });
    await settle();
    expect(stub.session.has('agui-dt:tab:7')).toBe(true);

    send(panel, { kind: 'clear' });
    await settle();

    expect(testHook().records()).toEqual([]);
    expect(testHook().droppedBefore()).toBe(0);
    expect(messagesOfKind(panel, 'cleared').length).toBe(1);
    expect(stub.session.has('agui-dt:tab:7')).toBe(false);
  });

  it('labels a binary notice to the panel rather than mis-encoding it as a record', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'binary',
      connId: 'c1',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 512,
    });

    // §5.4: detected and labelled, never decoded. A record would be a lie about what was seen;
    // silence would be indistinguishable from capture being broken.
    expect(testHook().records()).toEqual([]);
    expect(messagesOfKind(panel, 'binary')[0]).toEqual({
      kind: 'binary',
      connId: 'c1',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 512,
    });
  });

  it('reports eviction to the panel on append, not only in the first snapshot (P9)', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);

    // One past the default 5000-record cap, so exactly one record is evicted.
    const frames: WireFrame[] = [];
    for (let i = 0; i < 5001; i += 1) {
      frames.push(eventFrame(i, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' }));
    }
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames });

    expect(testHook().records().length).toBe(5000);
    expect(testHook().droppedBefore()).toBe(1);
    // A long session evicts continuously; a count delivered only with the initial snapshot
    // would be stale by exactly the amount that matters.
    expect(messagesOfKind(panel, 'append').at(-1)?.droppedBefore).toBe(1);
  });

  it('drops a tab buffer and its mirror when the tab closes', async () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { type: 'RUN_STARTED' })],
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9, reason: 'complete' });
    await settle();

    stub.removeTab(7);
    await settle();

    expect(testHook().records()).toEqual([]);
    expect(stub.session.has('agui-dt:tab:7')).toBe(false);
  });

  it('mirrors on a debounce as frames arrive, without waiting for a close', async () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { type: 'RUN_STARTED' })],
    });

    expect(stub.session.has('agui-dt:tab:7')).toBe(false);
    await settle(300);
    expect(stub.session.has('agui-dt:tab:7')).toBe(true);
  });

  it('registers content scripts for an origin granted at runtime (F4)', async () => {
    stub.grantOrigins(['https://example.com/*']);
    await settle();

    // Without this the grant succeeds and capture silently never starts — the worst available
    // outcome, and worse than failing loudly. Both worlds must be registered: MAIN does the
    // patching, ISOLATED is the only one that can reach `chrome.runtime`.
    expect(stub.registered.map((script) => script.world)).toEqual(['MAIN', 'ISOLATED']);
    for (const script of stub.registered) {
      expect(script.matches).toEqual(['https://example.com/*']);
      expect(script.runAt).toBe('document_start');
      expect(script.allFrames).toBe(true);
    }
    expect(stub.registered.map((script) => script.js)).toEqual([
      ['inject.js'],
      ['relay-loader.js'],
    ]);
  });

  it('does not re-register an origin it has already registered', async () => {
    stub.grantOrigins(['https://example.com/*']);
    await settle();
    stub.grantOrigins(['https://example.com/*']);
    await settle();

    // `registerContentScripts` rejects a duplicate id; an unhandled rejection in the worker is
    // a broken worker, so the second grant must be a no-op rather than a throw.
    expect(stub.registered.length).toBe(2);
  });

  it('unregisters when the user revokes an origin', async () => {
    stub.grantOrigins(['https://example.com/*']);
    await settle();
    stub.removeOrigins(['https://example.com/*']);
    await settle();

    // §11 is opt-in by origin: a revoked origin must stop being captured.
    expect(stub.registered).toEqual([]);
  });

  it('queues relay traffic that arrives before the restore completes', async () => {
    const session = new Map<string, unknown>([
      [
        'agui-dt:tab:7',
        {
          v: 1,
          records: [
            {
              kind: 'event',
              seq: 50,
              tMs: 1,
              connId: 'c0',
              raw: { type: 'RUN_STARTED' },
              event: { type: 'RUN_STARTED' },
              issues: [],
            },
          ],
          requests: [],
          closed: [],
          droppedBefore: 4,
          nextSeq: 51,
          recording: true,
        },
      ],
    ]);
    // `deferGet` pins the read open, which is the real shape of a woken worker: the mirror load
    // is async and port traffic is not.
    stub = installChrome(session, { deferGet: true });
    await loadWorker();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(60, { type: 'RUN_FINISHED' })],
    });
    expect(testHook().records()).toEqual([]);

    stub.releaseGet();
    await settle();

    const records = testHook().records();
    expect(records.map((record) => record.seq)).toEqual([50, 51]);
    expect(testHook().droppedBefore()).toBe(4);
  });
});


/**
 * THE SECOND SESSION — an origin that was granted in an earlier run of this extension.
 *
 * The case nothing in this repository could reach, by construction, until now. Every test above
 * and every harness e2e grants the origin INSIDE the test, so `chrome.permissions.onAdded` always
 * fires and the one registration trigger the worker had always ran. That is not what a user's
 * second day looks like: the grant is already there, Chrome has dropped the dynamic content-script
 * registrations across the extension reload or update, and `onAdded` has nothing left to fire
 * about because nothing was added.
 *
 * Measured in the user's own Chrome on 2026-08-15, on an origin granted that morning:
 * `window.fetch` unpatched, `XMLHttpRequest.prototype.open` unpatched, `window.__AGUI_DEVTOOLS__`
 * absent — before AND after a page reload, which is what rules out the already-known "the document
 * was open before the grant" case. Capture was dead for that origin permanently, and revoking and
 * re-granting was the only way back.
 *
 * Every test below therefore fires NO `onAdded` event at all. The trigger is the worker booting.
 */
describe('service worker — a second session against an existing grant', () => {
  const GRANTED = 'https://app.example.com/*';

  it('registers an origin that is already granted and has nothing registered for it', async () => {
    const stub = installChrome(new Map(), { granted: [GRANTED] });
    await loadWorker();
    await settle();

    // No grant happened during this test. The registration is the worker's boot path reconciling
    // what Chrome says is granted against what Chrome says is registered, which is the whole fix.
    expect(stub.registered.map((script) => script.id)).toEqual([
      `agui-dt-0-${GRANTED}`,
      `agui-dt-1-${GRANTED}`,
    ]);
    expect(stub.registered.map((script) => script.world)).toEqual(['MAIN', 'ISOLATED']);
    for (const script of stub.registered) expect(script.matches).toEqual([GRANTED]);
    expect(testHook().registration()).toEqual({ matches: [GRANTED], error: null });
  });

  it('does not register a second, dynamic copy of the manifest’s own localhost matches', async () => {
    const stub = installChrome(new Map(), { granted: [GRANTED] });
    await loadWorker();
    await settle();

    // `chrome.permissions.getAll()` reports content-script matches among its origins, so a
    // reconciliation that took that list at face value would register a SECOND copy of both
    // scripts for `http://localhost/*`. The manifest's copy cannot be unregistered, so the page
    // would get the capture layer injected twice — and the panel would report a registration for
    // an origin the worker does not actually own.
    expect(stub.registered.flatMap((script) => script.matches ?? [])).toEqual([GRANTED, GRANTED]);
    expect(testHook().registration()?.matches).not.toContain('http://localhost/*');
  });

  it('leaves live registrations alone rather than registering them twice', async () => {
    const already = [
      { id: `agui-dt-0-${GRANTED}`, matches: [GRANTED], js: ['inject.js'] },
      { id: `agui-dt-1-${GRANTED}`, matches: [GRANTED], js: ['relay-loader.js'] },
    ];
    const stub = installChrome(new Map(), { granted: [GRANTED], registered: already });
    await loadWorker();
    await settle();

    // The ordinary spawn: an idle worker respawning onto registrations that are still in place.
    // Reconciliation runs on EVERY spawn, so it has to be idempotent or every respawn would
    // rediscover the same duplicate-id rejection this worker used to swallow.
    expect(stub.registered.length).toBe(2);
    expect(testHook().registration()).toEqual({ matches: [GRANTED], error: null });
  });

  it('rebuilds what it believes is registered from Chrome, so a revoke after a respawn works', async () => {
    const already = [
      { id: `agui-dt-0-${GRANTED}`, matches: [GRANTED], js: ['inject.js'] },
      { id: `agui-dt-1-${GRANTED}`, matches: [GRANTED], js: ['relay-loader.js'] },
    ];
    const stub = installChrome(new Map(), { granted: [GRANTED], registered: already });
    await loadWorker();
    await settle();

    stub.removeOrigins([GRANTED]);
    await settle();

    /*
     * The same class of error as the bug this file was corrected for, pointing the other way.
     *
     * `registeredMatches` used to be an in-memory Set that only ever grew from `onAdded`, so on a
     * worker respawn it came back empty while the real registrations were still in place —
     * `unregisterForMatches` then skipped every match it had never heard of, and an origin the
     * user had explicitly REVOKED went on being captured. §11 is opt-in per origin, and this is
     * the opt-out half of it.
     */
    expect(stub.registered).toEqual([]);
    expect(testHook().registration()).toEqual({ matches: [], error: null });
  });

  it('completes a half-registration rather than calling it registered', async () => {
    // The MAIN-world patcher without the ISOLATED-world relay is not a working capture layer: it
    // patches the page and has no way to reach `chrome.runtime` to report anything.
    const half = [{ id: `agui-dt-0-${GRANTED}`, matches: [GRANTED], js: ['inject.js'] }];
    const stub = installChrome(new Map(), { granted: [GRANTED], registered: half });
    await loadWorker();
    await settle();

    expect(stub.registered.map((script) => script.id)).toEqual([
      `agui-dt-0-${GRANTED}`,
      `agui-dt-1-${GRANTED}`,
    ]);
    expect(testHook().registration()?.matches).toEqual([GRANTED]);
  });

  it('reports a real registration failure instead of swallowing it', async () => {
    const stub = installChrome(new Map(), {
      granted: [GRANTED],
      failRegistration: 'Invalid value for parameter matches',
    });
    await loadWorker();
    await settle();

    /*
     * The `catch` used to discard everything, which is how a registration that never happened
     * stayed invisible through a release. A failure has to be observable somewhere a panel or a
     * test can see it — and it must NOT be an unhandled rejection, which in a worker is a broken
     * worker.
     */
    expect(stub.registered).toEqual([]);
    expect(testHook().registration()).toEqual({
      matches: [],
      error: 'Invalid value for parameter matches',
    });
  });

  it('does not report a duplicate-id rejection, which is the end state it wanted', async () => {
    const stub = installChrome(new Map(), {
      granted: [GRANTED],
      failRegistration: "Duplicate script ID 'agui-dt-0-https://app.example.com/*'",
    });
    await loadWorker();
    await settle();

    // Genuinely fine: something else registered it first. Reporting it would put a failure in
    // front of the user for a capture layer that is working.
    expect(testHook().registration()?.error).toBeNull();
    expect(stub.registered).toEqual([]);
  });

  it('says "not known yet" rather than "nothing registered" before it has read Chrome', async () => {
    // `deferScriptRead` pins the worker in the moment that actually happens on every spawn: the
    // reconciliation is async, and a panel can subscribe before it lands.
    const stub = installChrome(new Map(), { granted: [GRANTED], deferScriptRead: true });
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    /*
     * NULL, NOT AN EMPTY LIST.
     *
     * Answering with the empty set the worker happens to be holding would make the panel flash
     * "the capture scripts are not registered" on every open — P12's false-warning failure,
     * reintroduced by the very change that was meant to stop the panel being confidently wrong.
     */
    expect(snapshotOf(panel).registration).toBeNull();
    expect(testHook().registration()).toBeNull();
    expect(stub.registered).toEqual([]);

    stub.releaseScriptRead();
    await settle();
    stub.releaseScriptRead();
    await settle();

    // And it stops being null the moment there is a real answer, rather than staying unknown.
    expect(testHook().registration()).toEqual({ matches: [GRANTED], error: null });
  });

  it('puts the registration on the snapshot a panel is actually sent', async () => {
    const stub = installChrome(new Map(), { granted: [GRANTED] });
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    /*
     * The drift the test hook cannot hold on its own.
     *
     * `registration()` is read through the same function `snapshotFor` embeds, but it does not go
     * through `everySnapshot()` — registration is not per tab, and the harness has to read it
     * before any page exists. This is the assertion that closes the gap: the fact the harness
     * asserts on is the fact the panel receives. A hook that built its own view of worker state is
     * exactly how an earlier e2e stayed green while the shipped message lost a field.
     */
    expect(snapshotOf(panel).registration).toEqual(testHook().registration());
    expect(snapshotOf(panel).registration).toEqual({ matches: [GRANTED], error: null });
  });

  it('re-registers on the panel’s command and answers every panel with the result', async () => {
    const stub = installChrome(new Map(), { granted: [GRANTED] });
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    // Chrome has dropped the registrations underneath a running worker — an extension update while
    // a panel is open. Nothing fires; the panel's own command is the only way back.
    stub.registered.length = 0;
    send(panel, { kind: 'reconcile-registrations' });
    await settle();

    expect(stub.registered.map((script) => script.id)).toEqual([
      `agui-dt-0-${GRANTED}`,
      `agui-dt-1-${GRANTED}`,
    ]);
    const pushed = messagesOfKind(panel, 'registration').at(-1);
    expect(pushed).toEqual({
      kind: 'registration',
      registration: { matches: [GRANTED], error: null },
    });
  });

  it('takes no origin from the panel: the command names nothing to register', async () => {
    const stub = installChrome(new Map(), { granted: [] });
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    // Whatever else rides on the message, the origin list comes from `chrome.permissions.getAll()`
    // and nowhere else — so this command cannot cause an origin the user never opted in to to have
    // code injected into it.
    panel.onMessage.emit(
      { kind: 'reconcile-registrations', origins: ['https://evil.example/*'] },
      panel,
    );
    await settle();

    expect(stub.registered).toEqual([]);

    // And the command IS being processed — otherwise the assertion above would hold for a message
    // that was simply dropped, which is the vacuous version of this test. The same message, once
    // the user has actually granted an origin, registers that one and still not the named one.
    stub.grantedOrigins.push(GRANTED);
    send(panel, { kind: 'reconcile-registrations' });
    await settle();

    expect(stub.registered.flatMap((script) => script.matches ?? [])).toEqual([GRANTED, GRANTED]);
  });

  it('rejects a command whose kind is inherited rather than its own', async () => {
    const stub = installChrome(new Map(), { granted: [GRANTED] });
    await loadWorker();
    await settle();
    stub.registered.length = 0;

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    // A guard that reads properties rather than own-properties validates this. The panel is our
    // own document rather than a hostile peer, but a guard whose safety rests on who happens to be
    // calling it stops being safe the first time someone adds a sender — and this is the one
    // command that makes the extension inject code somewhere.
    panel.onMessage.emit(Object.create({ kind: 'reconcile-registrations' }), panel);
    await settle();

    expect(stub.registered).toEqual([]);
  });
});

/**
 * Instrumentation — the fact the DOCUMENT reports, as opposed to the permission the panel used to
 * infer.
 *
 * `chrome.scripting.registerContentScripts` affects only FUTURE navigations, so "this origin is
 * granted" and "this document has capture hooks in it" are different facts that routinely
 * disagree: after a grant in a previous session, after an extension reload with the page open,
 * and after a grant the user never acts on. The worker is where the two are told apart, because
 * it is the only place that hears from the document itself.
 */
/*
 * The completeness fact, and the reason it is retained rather than only broadcast.
 *
 * A ring buffer holding four frames is indistinguishable from one that will hold fourteen a
 * moment later — the capture path is asynchronous end to end, so "how much is in here" answers
 * nothing about "is there more coming". `conn-close` is the answer, and it is a one-shot message:
 * whoever was not listening when it went out has no way to learn it afterwards. Retaining it is
 * what lets a reader that arrives later — the harness, which is the only thing that watches the
 * whole path — wait for the end of a stream instead of guessing at a duration.
 */
describe('service worker — connections that have closed', () => {
  let stub: ChromeStub;

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('reports nothing closed until the close arrives, then reports it', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    // A request line and a frame, and the stream is still open: this is precisely the state a
    // reader must not mistake for a finished capture.
    expect(testHook().closes()).toEqual([]);

    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 99, reason: 'complete' });
    // The TIME rides along with the id. Closing is what runs `finalizeRules`, and every run-end
    // issue it emits is anchored to this number, so an id on its own is not a usable close.
    expect(testHook().closes()).toEqual([{ connId: 'c1', tMs: 99 }]);
  });

  it('records a close per connection, not per tab', () => {
    const first = relayPort(7);
    const second = relayPort(8);
    stub.connect(first);
    stub.connect(second);
    send(first, connOpen('c1'));
    send(second, connOpen('c2'));
    send(first, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 1, reason: 'complete' });

    expect(testHook().closes()).toEqual([{ connId: 'c1', tMs: 1 }]);

    send(second, { v: 1, kind: 'conn-close', connId: 'c2', tMs: 2, reason: 'error' });
    expect([...testHook().closes()].sort((a, b) => a.connId.localeCompare(b.connId))).toEqual([
      { connId: 'c1', tMs: 1 },
      { connId: 'c2', tMs: 2 },
    ]);
  });

  it('forgets closes on clear, so a finished stream cannot answer for the next one', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 1, reason: 'complete' });
    expect(testHook().closes()).toEqual([{ connId: 'c1', tMs: 1 }]);

    testHook().clear();
    expect(testHook().closes()).toEqual([]);
  });

  it('survives the worker being terminated, because the stream did not reopen', async () => {
    const session = new Map<string, unknown>();

    let live = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    live.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });
    await settle();

    // ---- terminated at ~30 s idle (§15); a new incarnation reads the mirror ----
    live = installChrome(session);
    await loadWorker();
    await settle();

    // Without this the connection would read as still open forever: the close has already been
    // delivered and will never be sent again.
    expect(testHook().closes()).toEqual([{ connId: 'c1', tMs: 40 }]);
  });
});

describe('service worker — instrumentation reported by the document', () => {
  let stub: ChromeStub;

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('reports a tab whose relay reported the capture layer, and one that never did', () => {
    const quiet = panelPort();
    stub.connect(quiet);
    send(quiet, { kind: 'subscribe', tabId: 9 });
    expect(snapshotOf(quiet).loaded).toBe(false);

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).loaded).toBe(true);
  });

  /*
   * The report is extension-internal state about our own capture layer. The Timeline claims to
   * show AG-UI protocol events reconstructed from the wire, so a record here would make the panel
   * assert something false about the user's application — and it would consume a `seq`, shifting
   * every anchor the validator's issues are reported against.
   */
  it('never turns a load report into a record, and never spends a seq on one', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    send(relay, loadedReport);

    expect(testHook().records().map((record) => record.seq)).toEqual([1]);
    expect(testHook().requests().map((request) => request.connId)).toEqual(['c1']);
  });

  // §12 declares `all_frames: true` because agent chat is frequently in an iframe — the real
  // deployment this was found on is an `/embed` route. A tab whose only loaded document is an
  // iframe is a loaded tab.
  it('counts a load report from any frame, not only the top one', () => {
    const iframe = relayPort(7, 5);
    stub.connect(iframe);
    send(iframe, loadedReport);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).loaded).toBe(true);
  });

  it('tells a panel that is already subscribed, rather than only a late one', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(messagesOfKind(panel, 'capture-loaded')).toEqual([]);

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);

    // Without this the reload affordance would be a dead end: the user reloads, the new document
    // reports, and a panel that only ever learns from its own subscribe keeps warning.
    expect(messagesOfKind(panel, 'capture-loaded')).toEqual([{ kind: 'capture-loaded' }]);
    expect(messagesOfKind(panel, 'append')).toEqual([]);
  });

  it('re-states to the panel on every report, not only on a change', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const first = relayPort(7);
    stub.connect(first);
    send(first, loadedReport);
    // A reload: same tab, same frame, a new document and therefore a new port. Nothing about the
    // worker's own view changed, and the panel — which resets to "checking" on navigation — still
    // has to hear it, or it warns about a page that just reported itself.
    const second = relayPort(7);
    stub.connect(second);
    send(second, loadedReport);

    expect(messagesOfKind(panel, 'capture-loaded')).toHaveLength(2);
  });

  // Pausing is about DATA. A paused panel is still attached to a document with the capture layer
  // loaded in it, and reporting otherwise would make Pause look like it had unloaded it.
  it('records the load report even while recording is paused', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'set-recording', recording: false });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { type: 'RUN_STARTED' })],
    });

    expect(testHook().records()).toEqual([]);
    expect(testHook().loaded()).toBe(true);
  });

  /*
   * A document that has gone away stops counting. This is the "replace on each new document"
   * half: a fresh page load must not inherit the previous document's flag, and the honest signal
   * that a document is gone is its relay port disconnecting.
   */
  it('stops reporting the capture layer once the document that reported it is gone', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);
    expect(testHook().loaded()).toBe(true);

    relay.disconnect();

    expect(testHook().loaded()).toBe(false);
  });

  it('keeps the new document loaded when the old one disconnects after it', () => {
    // The ordering a real reload produces: the new document reports, and only then does the
    // previous document's port go away. Keying by port rather than by frame is what stops the
    // late disconnect from wiping the live document's flag.
    const before = relayPort(7);
    stub.connect(before);
    send(before, loadedReport);

    const after = relayPort(7);
    stub.connect(after);
    send(after, loadedReport);

    before.disconnect();

    expect(testHook().loaded()).toBe(true);
  });

  it('drops the previous document’s subframes when a new top-level document reports', () => {
    const iframe = relayPort(7, 5);
    stub.connect(iframe);
    send(iframe, loadedReport);
    const top = relayPort(7, 0);
    stub.connect(top);
    send(top, loadedReport);

    // A new top-level document destroys every frame under it, so a subframe of the OLD document
    // must not keep the tab looking loaded after the new one is gone.
    const reloaded = relayPort(7, 0);
    stub.connect(reloaded);
    send(reloaded, loadedReport);
    reloaded.disconnect();

    expect(testHook().loaded()).toBe(false);
  });

  it('keeps the load report per tab', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);

    const other = panelPort();
    stub.connect(other);
    send(other, { kind: 'subscribe', tabId: 9 });
    expect(snapshotOf(other).loaded).toBe(false);
  });

  it('keeps the load report across a clear, which empties data and unloads nothing', async () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'clear' });
    await settle();

    // Clearing drops records. It does not unload the page's capture layer, and a panel that
    // started warning about it because the user pressed Clear would be lying.
    expect(testHook().loaded()).toBe(true);
  });
});

describe('service worker restore after termination', () => {
  it('restores records, requests, seq, and droppedBefore from the session mirror', async () => {
    const session = new Map<string, unknown>();

    // ---- first worker incarnation ----
    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' }), eventFrame(30, { type: 'RUN_FINISHED' })],
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });
    await settle();
    expect(session.has('agui-dt:tab:7')).toBe(true);

    // ---- worker terminated; a new one starts against the same session storage ----
    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const snapshot = snapshotOf(panel);
    expect(snapshot.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(snapshot.records.map((record) => record.kind)).toEqual(['event', 'event']);
    expect(snapshot.requests.map((request) => request.url)).toEqual(['/agent']);
    expect(snapshot.droppedBefore).toBe(0);

    // seq continues from the restored high-water mark instead of colliding with it.
    const revived = relayPort(7);
    stub.connect(revived);
    send(revived, {
      v: 1,
      kind: 'frames',
      connId: 'c2',
      frames: [eventFrame(90, { type: 'RUN_STARTED' })],
    });
    expect(appendedRecords(panel).map((record) => record.seq)).toEqual([3]);
  });

  /**
   * The two mitigations compose: the worker is terminated at ~30 s idle (§15), and the panel is
   * opened after that. Neither the close nor the time it happened at is in memory any more, and
   * neither will ever be re-sent — the stream ended before the restart. Only the mirror can
   * answer, and a mirror holding bare ids could not: the panel would have to invent the anchor
   * for every run-end issue.
   */
  it('restores the closes WITH their times, so a late panel can still finalise the run', async () => {
    const session = new Map<string, unknown>();

    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });
    await settle();

    // ---- terminated at ~30 s idle; a new incarnation reads the mirror ----
    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    expect(snapshotOf(panel).closed).toEqual([{ connId: 'c1', tMs: 40 }]);
  });

  /**
   * A mirror written by an older build holds bare id strings. There is no true close time in it,
   * so none is claimed: the entry is dropped and the connection reads as still open — exactly
   * what that build already did — rather than being finalised at a number this worker made up.
   * An invented anchor misplaces every run-end issue, which is a quieter version of the bug this
   * change fixes rather than a fix for it. The next capture writes the current shape.
   */
  it('declines a mirrored close that carries no time, rather than inventing one', async () => {
    const session = new Map<string, unknown>([
      [
        'agui-dt:tab:7',
        {
          v: 1,
          records: [],
          requests: [],
          droppedBefore: 0,
          nextSeq: 1,
          recording: true,
          loadedFrames: [],
          // The pre-fix shape: ids, no times.
          closedConns: ['c1'],
        },
      ],
    ]);

    const stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    expect(snapshotOf(panel).closed).toEqual([]);
    expect(testHook().closes()).toEqual([]);
  });

  /*
   * MV3 terminates an idle worker at ~30 s (§15 risk row 1). The document is still there, still
   * patched, and will not announce again until it navigates — so an instrumentation flag that
   * lived only in worker memory would come back false, and the panel would warn about a page it
   * had been correctly capturing a minute earlier. It rides the same session mirror the ring
   * buffer already uses.
   */
  it('restores instrumentation from the session mirror after the worker is terminated', async () => {
    const session = new Map<string, unknown>();

    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);
    // The announcement alone has to reach the mirror: a document that never makes a request is
    // exactly the case this whole message exists for, so waiting for a frame would lose it.
    await settle(300);
    expect(session.has('agui-dt:tab:7')).toBe(true);

    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).loaded).toBe(true);
  });

  it('does not restore instrumentation for a tab that never reported any', async () => {
    const session = new Map<string, unknown>();

    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 4, reason: 'complete' });
    await settle();

    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).loaded).toBe(false);
  });

  it('does not duplicate a restored request line when the open is re-stated', async () => {
    const session = new Map<string, unknown>();

    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 40, reason: 'complete' });
    await settle();

    stub = installChrome(session);
    await loadWorker();
    await settle();

    // The page is still streaming on `c1`; its next batch re-states the open.
    const revived = relayPort(7);
    stub.connect(revived);
    send(revived, connOpen('c1'));

    expect(testHook().requests().map((request) => request.connId)).toEqual(['c1']);
  });

  it('counts records the mirror could not hold as dropped, rather than losing them silently', async () => {
    const session = new Map<string, unknown>();

    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    stub.connect(relay);
    const frames: WireFrame[] = [];
    for (let i = 0; i < 1200; i += 1) {
      frames.push(eventFrame(i, { type: 'TEXT_MESSAGE_CONTENT', delta: 'x' }));
    }
    send(relay, { v: 1, kind: 'frames', connId: 'c1', frames });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9999, reason: 'complete' });
    await settle();

    stub = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const snapshot = snapshotOf(panel);
    expect(snapshot.records.length).toBe(1000);
    expect(snapshot.records[0]?.seq).toBe(201);
    // P9: the 200 records that did not fit in the mirror are reported, not silently missing.
    expect(snapshot.droppedBefore).toBe(200);
  });
});

/**
 * `/info` agent discovery in the worker (spec §13 done-when #2).
 *
 * The worker's job here is RETENTION. The discovery request happens once, at the client's connect,
 * and a panel is normally opened long afterwards — so a fact that was only broadcast would reach a
 * panel that happened to be watching and never the ordinary case.
 */
describe('service worker — /info agent discovery', () => {
  let stub: ChromeStub;

  const RUNTIME = {
    version: '1.52.1-next.1',
    mode: 'multi-route' as const,
    agents: [
      { id: 'a2ui_chat', name: 'a2ui_chat', description: '' },
      { id: 'default', name: 'default', description: '' },
    ],
  };

  function infoMessage(overrides: Partial<Record<string, unknown>> = {}): RelayMessage {
    return {
      v: 1,
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: 'http://localhost:3000/api/copilotkit/info',
      info: RUNTIME,
      ...overrides,
    } as RelayMessage;
  }

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('reports nothing until a discovery response arrives — the common case', () => {
    // Most AG-UI apps never call `/info` at all. Measured across three page loads of a production
    // deployment: no such request, ever. `null` is not a failure and nothing here treats it as one.
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).info).toBeNull();
    expect(testHook().info()).toBeNull();
  });

  it('pushes it to a panel that is already watching', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, infoMessage());

    expect(messagesOfKind(panel, 'info')).toEqual([
      {
        kind: 'info',
        connId: 'c-info',
        tMs: 3,
        url: 'http://localhost:3000/api/copilotkit/info',
        info: RUNTIME,
      },
    ]);
  });

  it('gives it to a panel that subscribes AFTERWARDS, which is the ordinary case', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, infoMessage());

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).info).toEqual(RUNTIME);
  });

  it('creates no record and consumes no seq', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, infoMessage());
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    // A Timeline row for a discovery response would be the panel asserting a protocol event the
    // user's stream never contained, and it would take a seq every validator issue is anchored to.
    expect(testHook().records().map((record) => record.seq)).toEqual([1]);
    expect(testHook().requests()).toEqual([]);
  });

  it('keeps only the most recent answer, rather than merging two runtimes', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, infoMessage());
    send(relay, {
      ...infoMessage(),
      info: { version: '2.0.0', mode: 'single-route', agents: [{ id: 'solo', name: null, description: null }] },
    } as RelayMessage);

    expect(testHook().info()).toEqual({
      version: '2.0.0',
      mode: 'single-route',
      agents: [{ id: 'solo', name: null, description: null }],
    });
  });

  it('rebuilds the payload rather than forwarding the object it was handed', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      ...infoMessage(),
      info: {
        version: '1',
        mode: 'multi-route',
        agents: [{ id: 'a', name: null, description: null, smuggled: 'x' }],
        alsoSmuggled: true,
      },
    } as unknown as RelayMessage);
    expect(JSON.stringify(testHook().info())).not.toContain('muggled');
  });

  it('drops a malformed payload instead of storing it', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { ...infoMessage(), info: { version: '1', agents: null } } as RelayMessage);
    send(relay, { ...infoMessage(), info: null } as unknown as RelayMessage);
    send(relay, { ...infoMessage(), info: 'agents' } as unknown as RelayMessage);
    expect(testHook().info()).toBeNull();
  });

  it('does not record it while recording is paused', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'set-recording', recording: false });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, infoMessage());
    // §11's opt-in posture: a stopped capture keeps nothing, and metadata is data.
    expect(testHook().info()).toBeNull();
  });

  it('forgets it on a clear, so a navigation cannot leave a previous page described', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, infoMessage());
    expect(testHook().info()).toEqual(RUNTIME);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'clear' });

    // Clear is also what a navigation performs with preserve-log off. Metadata that survived one
    // would describe the previous app beside this one's stream.
    expect(testHook().info()).toBeNull();
    expect(messagesOfKind(panel, 'cleared')).toHaveLength(1);
    // And a panel opening afterwards is told the same thing, rather than inheriting the snapshot
    // the first one was sent before the clear.
    const later = panelPort();
    stub.connect(later);
    send(later, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(later).info).toBeNull();
  });

  it('survives a worker termination, because discovery does not happen twice', async () => {
    const session = new Map<string, unknown>();

    let restarted = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    restarted.connect(relay);
    send(relay, infoMessage());
    // Written through rather than on the debounce: the response arrives once and never again.
    await settle();
    expect(session.has('agui-dt:tab:7')).toBe(true);

    restarted = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).info).toEqual(RUNTIME);
  });

  it('declines a mirror whose runtime field is not readable, rather than trusting it', async () => {
    const session = new Map<string, unknown>();
    session.set('agui-dt:tab:7', {
      v: 1,
      records: [],
      requests: [],
      droppedBefore: 0,
      nextSeq: 1,
      recording: true,
      loadedFrames: [],
      closedConns: [],
      info: { version: '1', agents: 'nonsense' },
    });

    const restarted = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    // No claim, rather than a claim assembled from something this build cannot read. The next
    // discovery response fills it in.
    expect(snapshotOf(panel).info).toBeNull();
  });
});

/**
 * The registration failure reported is the one from THIS attempt.
 *
 * Its own block because it needs a stub whose `registerContentScripts` fails once and then works,
 * which `failRegistration` cannot express — it is permanent by design, so that the error-reporting
 * test above cannot pass by accident.
 */
describe('service worker — a registration failure does not outlive the attempt that caused it', () => {
  it('clears a recorded failure once a later pass has nothing left to fail at', async () => {
    const GRANTED = 'https://app.example.com/*';
    const stub = installChrome(new Map(), {
      granted: [GRANTED],
      failRegistration: 'Invalid value for parameter matches',
    });
    await loadWorker();
    await settle();
    expect(testHook().registration()?.error).toBe('Invalid value for parameter matches');

    // Whatever fixed it — a newer build, a retry, another path — the origin is now registered.
    // A field only ever cleared by a successful WRITE would strand this failure for the life of
    // the worker, and the panel would go on naming it for an origin that works.
    stub.registered.push(
      { id: `agui-dt-0-${GRANTED}`, matches: [GRANTED], js: ['inject.js'] },
      { id: `agui-dt-1-${GRANTED}`, matches: [GRANTED], js: ['relay-loader.js'] },
    );
    await testHook().reconcileRegistrations();
    await settle();

    expect(testHook().registration()).toEqual({ matches: [GRANTED], error: null });
  });
});

/* -------------------------------------------------------------------------- */
/* The toolbar badge (§14.6)                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_TITLE = 'AG-UI DevTools';

function actionsFor(stub: ChromeStub, tabId: number, method?: ActionCall['method']): ActionCall[] {
  return stub.actions.filter(
    (call) => call.details.tabId === tabId && (method === undefined || call.method === method),
  );
}

/** What the tab's badge shows now: the last value the worker set, or Chrome's default. */
function badgeOf(stub: ChromeStub, tabId: number): { text: string; title: string } {
  const text = actionsFor(stub, tabId, 'setBadgeText').at(-1)?.details.text ?? '';
  const title = actionsFor(stub, tabId, 'setTitle').at(-1)?.details.title ?? DEFAULT_TITLE;
  return { text, title };
}

function runStarted(connId: string, tMs = 1): RelayMessage {
  return { v: 1, kind: 'frames', connId, frames: [eventFrame(tMs, { type: 'RUN_STARTED' })] };
}

describe('service worker — the toolbar badge', () => {
  let stub: ChromeStub;

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('lights AG for the tab that spoke AG-UI, and only that tab', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, runStarted('c1'));

    expect(badgeOf(stub, 7)).toEqual({
      text: 'AG',
      title: 'AG-UI DevTools — AG-UI · 1 connection — open DevTools → AG-UI',
    });
    expect(actionsFor(stub, 7, 'setBadgeBackgroundColor')).toEqual([
      { method: 'setBadgeBackgroundColor', details: { tabId: 7, color: '#1a73e8' } },
    ]);
    // Every call is scoped to a tab. A global call would light the icon on every tab in the
    // window, including ones that never spoke AG-UI.
    expect(stub.actions.every((call) => call.details.tabId === 7)).toBe(true);
  });

  it('lights LG for a LangGraph Platform stream', () => {
    const relay = relayPort(8);
    stub.connect(relay);
    send(relay, {
      ...connOpen('lg1'),
      url: 'http://localhost:2024/threads/t1/runs/stream',
    } as RelayMessage);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'lg1',
      frames: [{ kind: 'event', tMs: 1, raw: '{"run_id":"r1"}', eventName: 'metadata' }],
    });

    expect(badgeOf(stub, 8)).toEqual({
      text: 'LG',
      title: 'AG-UI DevTools — LangGraph Platform · 1 connection — open DevTools → AG-UI',
    });
  });

  it('stays dark for an SSE stream that is not AG-UI (B4)', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, { ...connOpen('c1'), url: '/ticks', method: 'GET' } as RelayMessage);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { tick: 1 }), eventFrame(2, { hello: 1 })],
    });

    expect(testHook().records().length).toBe(2);
    expect(stub.actions.filter((call) => call.details.text !== undefined && call.details.text !== ''))
      .toEqual([]);
  });

  it('lights AG for a binary AG-UI transport, which leaves no records', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, {
      v: 1,
      kind: 'binary',
      connId: 'b1',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 512,
    });
    expect(badgeOf(stub, 7).text).toBe('AG');
  });

  it('names the runtime in the title when an /info response arrives', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    send(relay, {
      v: 1,
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: 'http://localhost:3000/api/copilotkit/info',
      info: { version: '1.52.1', mode: 'multi-route', agents: [] },
    });

    expect(badgeOf(stub, 7)).toEqual({
      text: 'AG',
      title:
        'AG-UI DevTools — AG-UI · CopilotKit runtime 1.52.1 (multi-route) · 1 connection — open DevTools → AG-UI',
    });
    // The text did not change, so it was not set again.
    expect(actionsFor(stub, 7, 'setBadgeText').length).toBe(1);
  });

  it('does not touch the badge again while nothing changes', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, connOpen('c1'));
    send(relay, runStarted('c1'));
    const before = stub.actions.length;

    for (let i = 0; i < 50; i += 1) {
      send(relay, {
        v: 1,
        kind: 'frames',
        connId: 'c1',
        frames: [eventFrame(i, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' })],
      });
    }
    send(relay, connOpen('c1'));
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 99, reason: 'complete' });

    expect(stub.actions.length).toBe(before);
  });

  it('counts a second connection in the title without re-setting the text', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    send(relay, runStarted('c2'));

    expect(badgeOf(stub, 7).title).toBe(
      'AG-UI DevTools — AG-UI · 2 connections — open DevTools → AG-UI',
    );
    expect(actionsFor(stub, 7, 'setBadgeText').length).toBe(1);
  });

  it('resets the tab on the clear command', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    expect(badgeOf(stub, 7).text).toBe('AG');

    send(panel, { kind: 'clear' });

    expect(badgeOf(stub, 7)).toEqual({ text: '', title: DEFAULT_TITLE });
    // Reset explicitly, not left to a default: Chrome keeps a tab's badge until told otherwise.
    expect(actionsFor(stub, 7, 'setBadgeText').at(-1)?.details.text).toBe('');
    expect(actionsFor(stub, 7, 'setTitle').at(-1)?.details.title).toBe(DEFAULT_TITLE);
  });

  it('forgets a closed tab, so nothing it decided answers for a later one', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    stub.removeTab(7);
    const before = actionsFor(stub, 7, 'setBadgeText').length;

    // Were the last-applied badge still held, this would be skipped as "unchanged".
    const again = relayPort(7);
    stub.connect(again);
    send(again, runStarted('c9'));
    expect(actionsFor(stub, 7, 'setBadgeText').length).toBe(before + 1);
    expect(badgeOf(stub, 7).title).toBe(
      'AG-UI DevTools — AG-UI · 1 connection — open DevTools → AG-UI',
    );
  });

  it('re-applies the badge when the tab loads a new document, because Chrome reset it', () => {
    // Measured in the e2e harness: Chrome clears a tab's action state on every cross-document
    // navigation. With the panel closed nothing clears the buffer, so the worker still holds 'AG'
    // as last applied — and skipping the write as "unchanged" left the badge dark for good, even
    // after the new page spoke AG-UI.
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, loadedReport);
    send(relay, runStarted('c1'));
    expect(actionsFor(stub, 7, 'setBadgeText').at(-1)?.details.text).toBe('AG');
    const texts = actionsFor(stub, 7, 'setBadgeText').length;

    const next = relayPort(7);
    stub.connect(next);
    send(next, loadedReport);

    expect(actionsFor(stub, 7, 'setBadgeText').length).toBe(texts + 1);
    expect(actionsFor(stub, 7, 'setBadgeText').at(-1)?.details.text).toBe('AG');
    expect(actionsFor(stub, 7, 'setBadgeBackgroundColor').length).toBe(2);
    expect(actionsFor(stub, 7, 'setTitle').at(-1)?.details.title).toBe(
      'AG-UI DevTools — AG-UI · 1 connection — open DevTools → AG-UI',
    );
  });

  it('leaves the badge alone when only a subframe loads, which Chrome does not reset for', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    const before = stub.actions.length;

    const sub = relayPort(7, 3);
    stub.connect(sub);
    send(sub, loadedReport);
    expect(stub.actions.length).toBe(before);
  });

  it('does not light while recording is paused, because nothing is captured', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'set-recording', recording: false });
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    expect(stub.actions).toEqual([]);
  });
});

/**
 * Tab 7, the one most tests above drive, on purpose: `loadWorker` clears an earlier incarnation's
 * pending mirror write, so a leftover can no longer land in this block's session storage.
 */
const RESTORED_TAB = 7;

describe('service worker — the toolbar badge after a worker restart', () => {
  it('re-applies the badge for a restored tab, including what the records alone cannot show', async () => {
    const session = new Map<string, unknown>();
    let stub = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(RESTORED_TAB);
    stub.connect(relay);
    send(relay, runStarted('c1'));
    // A binary stream leaves no record behind; only the mirrored decision remembers it.
    send(relay, {
      v: 1,
      kind: 'binary',
      connId: 'b1',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 512,
    });
    send(relay, { v: 1, kind: 'conn-close', connId: 'c1', tMs: 9, reason: 'complete' });
    await settle(300);

    // ---- worker terminated; a new one restores from the same session storage ----
    stub = installChrome(session);
    await loadWorker();
    await settle();

    // Recomputed and applied even though Chrome keeps tab-scoped action state across a worker
    // restart: applying from the restored state is what guarantees the two cannot disagree.
    expect(badgeOf(stub, RESTORED_TAB)).toEqual({
      text: 'AG',
      title: 'AG-UI DevTools — AG-UI · 2 connections — open DevTools → AG-UI',
    });

    // And the restored decisions are live: the same connection does not re-apply.
    const before = stub.actions.length;
    const revived = relayPort(RESTORED_TAB);
    stub.connect(revived);
    send(revived, runStarted('c1', 20));
    expect(stub.actions.length).toBe(before);
  });

  it('rebuilds from the records when the mirror was written by a build without decisions', async () => {
    const session = new Map<string, unknown>([
      [
        `agui-dt:tab:${String(RESTORED_TAB)}`,
        {
          v: 1,
          records: [
            {
              kind: 'event',
              seq: 1,
              tMs: 1,
              connId: 'c1',
              raw: { type: 'RUN_STARTED' },
              event: { type: 'RUN_STARTED' },
              issues: [],
            },
          ],
          requests: [],
          droppedBefore: 0,
          nextSeq: 2,
          recording: true,
        },
      ],
    ]);
    const stub = installChrome(session);
    await loadWorker();
    await settle();

    expect(badgeOf(stub, RESTORED_TAB).text).toBe('AG');
  });

  it('applies nothing for a restored tab that never spoke a known stack', async () => {
    const session = new Map<string, unknown>([
      [
        `agui-dt:tab:${String(RESTORED_TAB)}`,
        { v: 1, records: [], requests: [], droppedBefore: 0, nextSeq: 1, recording: true },
      ],
    ]);
    const stub = installChrome(session);
    await loadWorker();
    await settle();

    expect(badgeOf(stub, RESTORED_TAB)).toEqual({ text: '', title: DEFAULT_TITLE });
  });
});

/**
 * Threadplane devtools reports in the worker (design G5).
 *
 * A bounded per-tab ring, retained for a late panel, pushed to a watching one, cleared with the
 * tab's buffer, mirrored (its tail) across a worker termination. Never a record, never a seq.
 */
describe('service worker — Threadplane signal reports', () => {
  let stub: ChromeStub;

  const REPORT = {
    v: 1 as const,
    agent: 'agent-1',
    adapter: 'langgraph' as const,
    seq: 1,
    eventType: 'values',
    wrote: ['values', 'messages'],
    tMs: 10,
  };

  function signalsMessage(overrides: Partial<typeof REPORT> = {}): RelayMessage {
    return { v: 1, kind: 'signals', report: { ...REPORT, ...overrides } };
  }

  function seqs(reports: readonly { seq: number }[]): number[] {
    return reports.map((report) => report.seq);
  }

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('holds none until a report arrives — the common case', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).signals).toEqual({ reports: [], droppedBefore: 0 });
    expect(testHook().signals()).toEqual([]);
    expect(testHook().signalsDropped()).toBe(0);
  });

  it('retains reports in arrival order and gives them to a panel that subscribes afterwards', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    for (const seq of [1, 2, 3]) send(relay, signalsMessage({ seq }));

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(seqs(snapshotOf(panel).signals.reports)).toEqual([1, 2, 3]);
    expect(snapshotOf(panel).signals.reports[0]).toEqual(REPORT);
    expect(seqs(testHook().signals())).toEqual([1, 2, 3]);
  });

  it('pushes each report to the panel watching that tab, and only that tab', () => {
    const watcher = panelPort();
    stub.connect(watcher);
    send(watcher, { kind: 'subscribe', tabId: 7 });
    const other = panelPort();
    stub.connect(other);
    send(other, { kind: 'subscribe', tabId: 9 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, signalsMessage());

    expect(messagesOfKind(watcher, 'append')).toEqual([
      {
        kind: 'append',
        records: [],
        droppedBefore: 0,
        signals: { reports: [REPORT], droppedBefore: 0 },
      },
    ]);
    expect(messagesOfKind(other, 'append')).toEqual([]);
  });

  it('creates no record and consumes no seq', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, signalsMessage());
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    expect(testHook().records().map((record) => record.seq)).toEqual([1]);
  });

  it('keeps at most 5,000 per tab and counts what it evicted', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);
    for (let seq = 1; seq <= 5003; seq += 1) send(relay, signalsMessage({ seq }));

    const held = testHook().signals();
    expect(held).toHaveLength(5000);
    expect(held[0]?.seq).toBe(4);
    expect(held.at(-1)?.seq).toBe(5003);
    expect(testHook().signalsDropped()).toBe(3);
    // Re-stated on every push, not only on the snapshot (P9's reasoning, for this ring).
    expect(messagesOfKind(panel, 'append').at(-1)?.signals?.droppedBefore).toBe(3);

    const late = panelPort();
    stub.connect(late);
    send(late, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(late).signals.droppedBefore).toBe(3);
    expect(snapshotOf(late).signals.reports).toHaveLength(5000);
  });

  it('rebuilds each report rather than keeping the object it was handed', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    const wrote = Object.assign(['values'], { smuggled: 'x' });
    send(relay, { v: 1, kind: 'signals', report: { ...REPORT, wrote } });
    expect(JSON.stringify(testHook().signals())).not.toContain('muggled');
    expect(testHook().signals()[0]?.wrote).not.toBe(wrote);
  });

  it('drops a malformed report instead of storing it', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, signalsMessage({ wrote: ['password'] }));
    send(relay, { v: 1, kind: 'signals', report: null } as unknown as RelayMessage);
    send(relay, { v: 1, kind: 'signals' } as unknown as RelayMessage);
    send(relay, { v: 1, kind: 'signals', report: { ...REPORT, extra: 1 } } as unknown as RelayMessage);
    expect(testHook().signals()).toEqual([]);
  });

  it('does not record while recording is paused', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'set-recording', recording: false });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, signalsMessage());
    expect(testHook().signals()).toEqual([]);
    expect(messagesOfKind(panel, 'append')).toEqual([]);
  });

  it('forgets them, and the eviction count, on a clear', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    for (let seq = 1; seq <= 5001; seq += 1) send(relay, signalsMessage({ seq }));
    expect(testHook().signalsDropped()).toBe(1);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'clear' });

    expect(testHook().signals()).toEqual([]);
    expect(testHook().signalsDropped()).toBe(0);
    const later = panelPort();
    stub.connect(later);
    send(later, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(later).signals).toEqual({ reports: [], droppedBefore: 0 });
  });

  it('survives a worker termination through the mirror, counting the tail it could not hold', async () => {
    const session = new Map<string, unknown>();
    let restarted = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    restarted.connect(relay);
    for (let seq = 1; seq <= 1200; seq += 1) send(relay, signalsMessage({ seq }));
    await settle(300);

    restarted = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const { signals } = snapshotOf(panel);
    expect(signals.reports).toHaveLength(1000);
    expect(signals.reports[0]?.seq).toBe(201);
    expect(signals.droppedBefore).toBe(200);

    // And the ring goes on from there rather than starting over.
    const next = relayPort(7);
    restarted.connect(next);
    send(next, signalsMessage({ seq: 1201 }));
    expect(testHook().signals().at(-1)?.seq).toBe(1201);
    expect(testHook().signalsDropped()).toBe(200);
  });

  it('declines mirrored reports it cannot read, rather than trusting its own storage', async () => {
    const session = new Map<string, unknown>();
    session.set('agui-dt:tab:7', {
      v: 1,
      records: [],
      requests: [],
      droppedBefore: 0,
      nextSeq: 1,
      recording: true,
      loadedFrames: [],
      closedConns: [],
      info: null,
      signals: [REPORT, { ...REPORT, seq: 2, wrote: ['password'] }, 'nonsense', { ...REPORT, seq: 3 }],
      signalsDropped: 'many',
    });

    const restarted = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(seqs(snapshotOf(panel).signals.reports)).toEqual([1, 3]);
    expect(snapshotOf(panel).signals.droppedBefore).toBe(0);
  });

  it('restores a mirror written by a build without signals as holding none', async () => {
    const session = new Map<string, unknown>();
    session.set('agui-dt:tab:7', {
      v: 1,
      records: [],
      requests: [],
      droppedBefore: 0,
      nextSeq: 1,
      recording: true,
    });
    const restarted = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).signals).toEqual({ reports: [], droppedBefore: 0 });
  });
});

/**
 * Threadplane render reports in the worker (UI inspector U5): a separate bounded per-tab ring
 * (500), retained for a late panel, pushed to a watching one, paused with capture, cleared with the
 * buffer, and mirrored — its tail, within a byte budget — across a worker termination.
 */
describe('service worker — Threadplane render reports', () => {
  let stub: ChromeStub;

  const RENDER = {
    v: 1 as const,
    kind: 'render' as const,
    surface: 's1',
    seq: 1,
    registry: ['Column', 'Text'],
    elements: [
      { key: 'root', type: 'Column', state: 'mounted' as const },
      { key: 'mystery', type: 'Mystery', state: 'unresolved' as const },
    ],
    tMs: 10,
  };
  const SIGNAL = {
    v: 1 as const,
    agent: 'agent-1',
    adapter: 'langgraph' as const,
    seq: 1,
    eventType: 'values',
    wrote: ['values'],
    tMs: 10,
  };

  function renderMessage(overrides: Partial<typeof RENDER> = {}): RelayMessage {
    return { v: 1, kind: 'render', report: { ...RENDER, ...overrides } };
  }

  function seqs(reports: readonly { seq: number }[]): number[] {
    return reports.map((report) => report.seq);
  }

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('holds none until a report arrives', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).renders).toEqual({ reports: [], droppedBefore: 0 });
    expect(testHook().renders()).toEqual([]);
    expect(testHook().rendersDropped()).toBe(0);
  });

  it('keeps render reports in their own ring, apart from the signals ring', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, renderMessage({ seq: 1 }));
    send(relay, { v: 1, kind: 'signals', report: SIGNAL });
    send(relay, renderMessage({ seq: 2, surface: 'spec:card' }));

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(seqs(snapshotOf(panel).renders.reports)).toEqual([1, 2]);
    expect(snapshotOf(panel).renders.reports[0]).toEqual(RENDER);
    expect(snapshotOf(panel).signals.reports).toEqual([SIGNAL]);
    expect(testHook().records()).toEqual([]);
  });

  it('pushes each report to the panel watching that tab on a record-less append', () => {
    const watcher = panelPort();
    stub.connect(watcher);
    send(watcher, { kind: 'subscribe', tabId: 7 });
    const other = panelPort();
    stub.connect(other);
    send(other, { kind: 'subscribe', tabId: 9 });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, renderMessage());
    expect(messagesOfKind(watcher, 'append')).toEqual([
      { kind: 'append', records: [], droppedBefore: 0, renders: { reports: [RENDER], droppedBefore: 0 } },
    ]);
    expect(messagesOfKind(other, 'append')).toEqual([]);
  });

  it('also bounds the ring by size, so 500 maximum-size reports cannot pile up', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    for (let seq = 1; seq <= 40; seq += 1) send(relay, { v: 1, kind: 'render', report: maxSizeRenderReport(seq) });
    const held = testHook().renders();
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(40);
    expect(held.at(-1)?.seq).toBe(40);
    expect(held.reduce((total, report) => total + renderReportChars(report), 0)).toBeLessThanOrEqual(MAX_RENDER_RING_CHARS);
    expect(testHook().rendersDropped()).toBe(40 - held.length);
  });

  it('keeps at most 500 per tab and counts what it evicted', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const relay = relayPort(7);
    stub.connect(relay);
    for (let seq = 1; seq <= 503; seq += 1) send(relay, renderMessage({ seq }));

    const held = testHook().renders();
    expect(held).toHaveLength(500);
    expect(held[0]?.seq).toBe(4);
    expect(testHook().rendersDropped()).toBe(3);
    expect(messagesOfKind(panel, 'append').at(-1)?.renders?.droppedBefore).toBe(3);
  });

  it('rebuilds each report and drops a malformed one', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    const elements = Object.assign([{ key: 'root', type: 'Text', state: 'mounted' as const }], { smuggled: 'x' });
    send(relay, { v: 1, kind: 'render', report: { ...RENDER, elements } });
    send(relay, renderMessage({ elements: [{ key: 'a', type: 'A', state: 'visible' as never }] }));
    send(relay, { v: 1, kind: 'render', report: { ...RENDER, props: {} } } as unknown as RelayMessage);
    send(relay, { v: 1, kind: 'render', report: SIGNAL } as unknown as RelayMessage);
    send(relay, { v: 1, kind: 'render' } as unknown as RelayMessage);
    expect(testHook().renders()).toHaveLength(1);
    expect(JSON.stringify(testHook().renders())).not.toContain('muggled');
    expect(testHook().renders()[0]?.elements).not.toBe(elements);
  });

  it('does not record while recording is paused', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'set-recording', recording: false });
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, renderMessage());
    expect(testHook().renders()).toEqual([]);
    expect(messagesOfKind(panel, 'append')).toEqual([]);
  });

  it('forgets them, and the eviction count, on a clear', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    for (let seq = 1; seq <= 501; seq += 1) send(relay, renderMessage({ seq }));
    expect(testHook().rendersDropped()).toBe(1);
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'clear' });
    expect(testHook().renders()).toEqual([]);
    expect(testHook().rendersDropped()).toBe(0);
  });

  it('survives a worker termination through the mirror: the tail, counted', async () => {
    const session = new Map<string, unknown>();
    let restarted = installChrome(session);
    await loadWorker();
    await settle();

    const relay = relayPort(7);
    restarted.connect(relay);
    for (let seq = 1; seq <= 150; seq += 1) send(relay, renderMessage({ seq }));
    await settle(300);

    restarted = installChrome(session);
    await loadWorker();
    await settle();
    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    const { renders } = snapshotOf(panel);
    expect(renders.reports).toHaveLength(100);
    expect(renders.reports[0]?.seq).toBe(51);
    expect(renders.droppedBefore).toBe(50);
  });

  it('mirrors within a byte budget, so large reports cannot spend the session quota', async () => {
    const session = new Map<string, unknown>();
    let restarted = installChrome(session);
    await loadWorker();
    await settle();

    // ~2,000 elements of ~60 bytes each: a report near the contract's ceiling.
    const elements = Array.from({ length: 2000 }, (_, i) => ({
      key: `element-${String(i).padStart(6, '0')}-${'k'.repeat(20)}`,
      type: 'Text',
      state: 'mounted' as const,
    }));
    const relay = relayPort(7);
    restarted.connect(relay);
    for (let seq = 1; seq <= 40; seq += 1) send(relay, renderMessage({ seq, elements }));
    await settle(300);

    const mirrored = session.get('agui-dt:tab:7') as { renders: unknown[]; rendersDropped: number };
    expect(JSON.stringify(mirrored.renders).length).toBeLessThanOrEqual(1_000_000);
    expect(mirrored.renders.length).toBeGreaterThan(0);
    expect(mirrored.renders.length + mirrored.rendersDropped).toBe(40);

    restarted = installChrome(session);
    await loadWorker();
    await settle();
    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).renders.reports.at(-1)?.seq).toBe(40);
  });

  it('declines mirrored reports it cannot read, and restores an older mirror as holding none', async () => {
    const session = new Map<string, unknown>();
    const base = { v: 1, records: [], requests: [], droppedBefore: 0, nextSeq: 1, recording: true };
    session.set('agui-dt:tab:7', {
      ...base,
      renders: [RENDER, { ...RENDER, seq: 2, props: {} }, 'nonsense', { ...RENDER, seq: 3 }],
      rendersDropped: -1,
    });
    session.set('agui-dt:tab:8', base);
    const restarted = installChrome(session);
    await loadWorker();
    await settle();

    const panel = panelPort();
    restarted.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(seqs(snapshotOf(panel).renders.reports)).toEqual([1, 3]);
    expect(snapshotOf(panel).renders.droppedBefore).toBe(0);
    const older = panelPort();
    restarted.connect(older);
    send(older, { kind: 'subscribe', tabId: 8 });
    expect(snapshotOf(older).renders).toEqual({ reports: [], droppedBefore: 0 });
  });
});

describe('service worker — the run simulator (§14.4)', () => {
  let stub: ChromeStub;

  const COMMAND = {
    v: 1 as const,
    armId: 'arm-1',
    adapter: 'ag-ui' as const,
    runs: [{ events: [{ type: 'RUN_STARTED', threadId: 't', runId: 'r' }] }],
  };

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  function subscribed(tabId = 7): FakePort {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId });
    return panel;
  }

  describe('arming', () => {
    it('sends a validated copy to the tab’s top frame only, and answers the asking panel', async () => {
      stub.tabAnswer = () => Promise.resolve({ outcome: 'dispatched' });
      const panel = subscribed();
      const other = subscribed();
      send(panel, { kind: 'simulate.arm', command: COMMAND });
      await settle(5);
      expect(stub.tabMessages).toEqual([{ tabId: 7, message: { kind: 'simulate.arm', command: COMMAND }, options: { frameId: 0 } }]);
      expect(messagesOfKind(panel, 'sim-dispatch')).toEqual([
        { kind: 'sim-dispatch', armId: 'arm-1', action: 'arm', outcome: 'dispatched' },
      ]);
      expect(messagesOfKind(other, 'sim-dispatch')).toEqual([]);
    });

    it('sends nothing for a command that does not validate', async () => {
      const panel = subscribed();
      send(panel, { kind: 'simulate.arm', command: { ...COMMAND, runs: [] } } as unknown as PanelCommand);
      send(panel, { kind: 'simulate.arm', command: { ...COMMAND, adapter: 'crewai' } } as unknown as PanelCommand);
      await settle(5);
      expect(stub.tabMessages).toEqual([]);
      expect(messagesOfKind(panel, 'sim-dispatch')).toEqual([]);
    });

    it('sends nothing for a panel that has not subscribed to a tab', async () => {
      const panel = panelPort();
      stub.connect(panel);
      send(panel, { kind: 'simulate.arm', command: COMMAND });
      await settle(5);
      expect(stub.tabMessages).toEqual([]);
    });

    it('reports not-delivered when no relay answers, and reads only a known outcome', async () => {
      const panel = subscribed();
      send(panel, { kind: 'simulate.arm', command: COMMAND });
      await settle(5);
      stub.tabAnswer = () => Promise.resolve({ outcome: 'pwned' });
      send(panel, { kind: 'simulate.arm', command: { ...COMMAND, armId: 'arm-2' } });
      await settle(5);
      stub.tabAnswer = () => Promise.resolve({ outcome: 'developer-mode-off' });
      send(panel, { kind: 'simulate.arm', command: { ...COMMAND, armId: 'arm-3' } });
      await settle(5);
      expect(messagesOfKind(panel, 'sim-dispatch').map((message) => message.outcome)).toEqual([
        'not-delivered',
        'not-delivered',
        'developer-mode-off',
      ]);
    });

    it('sends a disarm the same way', async () => {
      stub.tabAnswer = () => Promise.resolve({ outcome: 'dispatched' });
      const panel = subscribed();
      send(panel, { kind: 'simulate.disarm', armId: 'arm-1' });
      send(panel, { kind: 'simulate.disarm', armId: 'bad id' } as PanelCommand);
      await settle(5);
      expect(stub.tabMessages).toEqual([{ tabId: 7, message: { kind: 'simulate.disarm', armId: 'arm-1' }, options: { frameId: 0 } }]);
      expect(messagesOfKind(panel, 'sim-dispatch')).toEqual([
        { kind: 'sim-dispatch', armId: 'arm-1', action: 'disarm', outcome: 'dispatched' },
      ]);
    });
  });

  describe('acks', () => {
    const ACK = { v: 1 as const, armId: 'arm-1', state: 'consumed' as const, run: 0 };

    it('keeps them per tab, pushes each, puts them on a late snapshot, and clears them with the buffer', async () => {
      const panel = subscribed();
      const relay = relayPort(7);
      stub.connect(relay);
      send(relay, { v: 1, kind: 'sim-ack', ack: ACK });
      await settle();
      expect(messagesOfKind(panel, 'sim-ack')).toEqual([{ kind: 'sim-ack', ack: ACK }]);
      expect(testHook().simAcks()).toEqual([ACK]);
      expect(snapshotOf(subscribed()).simAcks).toEqual([ACK]);

      send(panel, { kind: 'clear' });
      await settle();
      expect(testHook().simAcks()).toEqual([]);
    });

    it('keeps them while recording is paused — an ack answers the user’s own Arm', async () => {
      const panel = subscribed();
      send(panel, { kind: 'set-recording', recording: false });
      const relay = relayPort(7);
      stub.connect(relay);
      send(relay, { v: 1, kind: 'sim-ack', ack: ACK });
      await settle();
      expect(testHook().simAcks()).toEqual([ACK]);
    });

    it('drops an ack of the wrong shape, and strips nothing into one that is right', async () => {
      const relay = relayPort(7);
      stub.connect(relay);
      for (const ack of [{ ...ACK, state: 'pwned' }, { ...ACK, extra: 1 }, null]) {
        send(relay, { v: 1, kind: 'sim-ack', ack } as unknown as RelayMessage);
      }
      await settle();
      expect(testHook().simAcks()).toEqual([]);
    });

    it('survives a worker restart through the mirror, re-validated', async () => {
      const relay = relayPort(7);
      stub.connect(relay);
      send(relay, { v: 1, kind: 'sim-ack', ack: ACK });
      await settle(300);
      const session = new Map(stub.session);
      const mirrored = session.get('agui-dt:tab:7') as Record<string, unknown>;
      session.set('agui-dt:tab:7', { ...mirrored, simAcks: [ACK, { ...ACK, state: 'pwned' }] });
      installChrome(session);
      await loadWorker();
      await settle();
      expect(testHook().simAcks()).toEqual([ACK]);
    });
  });

  describe('Developer mode', () => {
    it('stores ON for an auto-enabled or granted origin and tells every panel', async () => {
      const panel = subscribed();
      const other = panelPort();
      stub.connect(other);
      send(panel, { kind: 'developer-mode.set', origin: 'http://localhost:5173', enabled: true });
      await settle(5);
      expect(stub.local.get('agui-dt:devmode:http://localhost:5173')).toBe(true);
      for (const port of [panel, other]) {
        expect(messagesOfKind(port, 'developer-mode')).toEqual([
          { kind: 'developer-mode', origin: 'http://localhost:5173', enabled: true },
        ]);
      }
      stub.grantedOrigins.push('https://app.test/*');
      await expect(testHook().setDeveloperMode('https://app.test', true)).resolves.toBe(true);
      expect(stub.local.get('agui-dt:devmode:https://app.test')).toBe(true);
    });

    it('refuses ON for an origin that is not granted, and answers with what is stored', async () => {
      const panel = subscribed();
      send(panel, { kind: 'developer-mode.set', origin: 'https://app.test', enabled: true });
      await settle(5);
      expect(stub.local.size).toBe(0);
      expect(messagesOfKind(panel, 'developer-mode')).toEqual([
        { kind: 'developer-mode', origin: 'https://app.test', enabled: false },
      ]);
    });

    it('stores OFF as the key’s absence', async () => {
      stub.local.set('agui-dt:devmode:http://localhost:5173', true);
      await expect(testHook().setDeveloperMode('http://localhost:5173', false)).resolves.toBe(false);
      expect(stub.local.size).toBe(0);
    });

    it('answers a get with what is stored, strictly', async () => {
      const panel = subscribed();
      stub.local.set('agui-dt:devmode:http://localhost:5173', 'true');
      send(panel, { kind: 'developer-mode.get', origin: 'http://localhost:5173' });
      await settle(5);
      expect(messagesOfKind(panel, 'developer-mode')).toEqual([
        { kind: 'developer-mode', origin: 'http://localhost:5173', enabled: false },
      ]);
    });

    it('ignores an origin that is not a canonical web origin', async () => {
      const panel = subscribed();
      for (const origin of ['https://app.test/', 'null', 'chrome://settings', 'HTTPS://APP.TEST']) {
        send(panel, { kind: 'developer-mode.set', origin, enabled: true });
        send(panel, { kind: 'developer-mode.get', origin });
      }
      await settle(5);
      expect(messagesOfKind(panel, 'developer-mode')).toEqual([]);
      expect(stub.local.size).toBe(0);
    });

    it('clears a revoked origin’s flag, so a later re-grant starts off', async () => {
      stub.grantedOrigins.push('https://app.test/*');
      await testHook().setDeveloperMode('https://app.test', true);
      stub.removeOrigins(['https://app.test/*']);
      await settle(5);
      expect(stub.local.has('agui-dt:devmode:https://app.test')).toBe(false);
    });

    it('clears every flag a wildcard revoke leaves ungranted, and tells the panels', async () => {
      // Chrome's "On all sites" grants `https://*/*`; turning it off revokes that pattern, which
      // names no single origin.
      stub.grantedOrigins.push('https://*/*');
      const panel = subscribed();
      await expect(testHook().setDeveloperMode('https://app.test', true)).resolves.toBe(true);
      await testHook().setDeveloperMode('http://localhost:5173', true);
      stub.removeOrigins(['https://*/*']);
      await settle(5);
      expect(stub.local.has('agui-dt:devmode:https://app.test')).toBe(false);
      // The localhost family needs no grant, so its flag is not the revoke's to clear.
      expect(stub.local.get('agui-dt:devmode:http://localhost:5173')).toBe(true);
      expect(messagesOfKind(panel, 'developer-mode').at(-1)).toEqual({
        kind: 'developer-mode',
        origin: 'https://app.test',
        enabled: false,
      });
    });

    it('does not leave ON stored when the origin is revoked while it is being stored', async () => {
      stub.grantedOrigins.push('https://app.test/*');
      const permissions = chrome.permissions as unknown as { contains: (query: { origins?: string[] }) => Promise<boolean> };
      const contains = permissions.contains;
      let first = true;
      permissions.contains = async (query) => {
        const answer = await contains(query);
        if (first) {
          first = false;
          // The user revokes between the grant check and the write.
          stub.removeOrigins(['https://app.test/*']);
        }
        return answer;
      };
      await expect(testHook().setDeveloperMode('https://app.test', true)).resolves.toBe(false);
      await settle(5);
      expect(stub.local.has('agui-dt:devmode:https://app.test')).toBe(false);
    });
  });

  describe('the panel port', () => {
    it('hears only an extension page: a content script cannot arm, read a tab, or switch Developer mode', async () => {
      stub.tabAnswer = () => Promise.resolve({ outcome: 'dispatched' });
      for (const sender of [
        { tab: { id: 7 }, frameId: 0, id: EXTENSION_ID, url: 'http://localhost:5173/' },
        { id: EXTENSION_ID },
        { id: EXTENSION_ID, url: 'chrome-extension://someotherextensionidabcdefghijk/panel.html' },
      ]) {
        const port = new FakePort(PANEL_PORT_NAME, sender);
        stub.connect(port);
        send(port, { kind: 'subscribe', tabId: 7 });
        send(port, { kind: 'developer-mode.set', origin: 'http://localhost:5173', enabled: true });
        send(port, { kind: 'simulate.arm', command: COMMAND });
        await settle(5);
        expect(port.sent).toEqual([]);
      }
      expect(stub.local.size).toBe(0);
      expect(stub.tabMessages).toEqual([]);
    });
  });
});
