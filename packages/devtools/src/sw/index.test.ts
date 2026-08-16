import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureRecord } from '../core/model/types';
import type { WireFrame } from '../inject/protocol';
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
    readonly sender?: { tab?: { id: number }; frameId?: number },
  ) {}
  postMessage(message: unknown): void {
    this.sent.push(message as SwMessage);
  }
  disconnect(): void {
    this.onDisconnect.emit(this);
  }
}

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

interface ChromeStub {
  session: Map<string, unknown>;
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
}

interface StubOptions {
  deferGet?: boolean;
  /** Registrations Chrome already holds — a worker respawning onto live registrations. */
  registered?: RegisteredScript[];
  /** Origins granted before this worker ever ran. Registers nothing. */
  granted?: string[];
  /** Make `registerContentScripts` reject with this message, for the error-reporting path. */
  failRegistration?: string;
}

function installChrome(session: Map<string, unknown> = new Map(), options: StubOptions = {}): ChromeStub {
  const onConnect = new FakeEvent<[FakePort]>();
  const onRemoved = new FakeEvent<[number]>();
  const onAdded = new FakeEvent<[{ origins?: string[] }]>();
  const onPermissionsRemoved = new FakeEvent<[{ origins?: string[] }]>();
  const held: (() => void)[] = [];
  const registered: RegisteredScript[] = [...(options.registered ?? [])];
  const grantedOrigins: string[] = [...(options.granted ?? [])];

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
      return Promise.resolve(registered.map((script) => ({ ...script })));
    },
  };

  globalThis.chrome = {
    runtime: {
      onConnect,
      getManifest: () => ({ content_scripts: MANIFEST_CONTENT_SCRIPTS }),
    },
    storage: { session: storageSession },
    tabs: { onRemoved },
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
      getAll: (): Promise<{ origins: string[] }> =>
        Promise.resolve({
          origins: [
            ...MANIFEST_CONTENT_SCRIPTS.flatMap((entry) => entry.matches),
            ...grantedOrigins,
          ],
        }),
    },
    scripting,
  } as unknown as typeof chrome;

  return {
    session,
    registered,
    grantedOrigins,
    connect: (port) => {
      onConnect.emit(port);
    },
    removeTab: (tabId) => {
      onRemoved.emit(tabId);
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
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

async function loadWorker(): Promise<void> {
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

function panelPort(): FakePort {
  return new FakePort(PANEL_PORT_NAME);
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
    vi.resetModules();
    await import('./index');

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
    expect(testHook().registration().matches).not.toContain('http://localhost/*');
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
    expect(testHook().registration().matches).toEqual([GRANTED]);
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
    expect(testHook().registration().error).toBeNull();
    expect(stub.registered).toEqual([]);
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
    expect(pushed).toEqual({ kind: 'registration', matches: [GRANTED], error: null });
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
    expect(testHook().registration().error).toBe('Invalid value for parameter matches');

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
