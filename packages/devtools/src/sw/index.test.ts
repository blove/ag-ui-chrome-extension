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
}

function installChrome(
  session: Map<string, unknown> = new Map(),
  options: { deferGet?: boolean } = {},
): ChromeStub {
  const onConnect = new FakeEvent<[FakePort]>();
  const onRemoved = new FakeEvent<[number]>();
  const onAdded = new FakeEvent<[{ origins?: string[] }]>();
  const onPermissionsRemoved = new FakeEvent<[{ origins?: string[] }]>();
  const held: (() => void)[] = [];
  const registered: RegisteredScript[] = [];

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
      for (const script of scripts) {
        if (registered.some((existing) => existing.id === script.id)) {
          return Promise.reject(new Error(`Duplicate script ID '${script.id}'`));
        }
        registered.push(script);
      }
      return Promise.resolve();
    },
    unregisterContentScripts(filter: { ids?: string[] }): Promise<void> {
      for (const id of filter.ids ?? []) {
        const index = registered.findIndex((script) => script.id === id);
        if (index >= 0) registered.splice(index, 1);
      }
      return Promise.resolve();
    },
  };

  globalThis.chrome = {
    runtime: {
      onConnect,
      getManifest: () => ({ content_scripts: MANIFEST_CONTENT_SCRIPTS }),
    },
    storage: { session: storageSession },
    tabs: { onRemoved },
    permissions: { onAdded, onRemoved: onPermissionsRemoved },
    scripting,
  } as unknown as typeof chrome;

  return {
    session,
    registered,
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
      onAdded.emit({ origins });
    },
    removeOrigins: (origins) => {
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

const installed: RelayMessage = { v: 1, kind: 'capture-installed', tMs: 0.5 };

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
 * Instrumentation — the fact the DOCUMENT reports, as opposed to the permission the panel used to
 * infer.
 *
 * `chrome.scripting.registerContentScripts` affects only FUTURE navigations, so "this origin is
 * granted" and "this document has capture hooks in it" are different facts that routinely
 * disagree: after a grant in a previous session, after an extension reload with the page open,
 * and after a grant the user never acts on. The worker is where the two are told apart, because
 * it is the only place that hears from the document itself.
 */
describe('service worker — instrumentation reported by the document', () => {
  let stub: ChromeStub;

  beforeEach(async () => {
    stub = installChrome();
    await loadWorker();
    await settle();
  });

  it('reports a tab whose document announced its hooks, and one that never did', () => {
    const quiet = panelPort();
    stub.connect(quiet);
    send(quiet, { kind: 'subscribe', tabId: 9 });
    expect(snapshotOf(quiet).instrumented).toBe(false);

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).instrumented).toBe(true);
  });

  /*
   * The announcement is extension-internal state about our own capture layer. The Timeline
   * claims to show AG-UI protocol events reconstructed from the wire, so a record here would
   * make the panel assert something false about the user's application — and it would consume a
   * `seq`, shifting every anchor the validator's issues are reported against.
   */
  it('never turns an announcement into a record, and never spends a seq on one', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);
    send(relay, connOpen('c1'));
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(12, { type: 'RUN_STARTED' })],
    });
    send(relay, installed);

    expect(testHook().records().map((record) => record.seq)).toEqual([1]);
    expect(testHook().requests().map((request) => request.connId)).toEqual(['c1']);
  });

  // §12 declares `all_frames: true` because agent chat is frequently in an iframe — the real
  // deployment this was found on is an `/embed` route. An iframe-only instrumented document is
  // instrumented.
  it('counts an announcement from any frame, not only the top one', () => {
    const iframe = relayPort(7, 5);
    stub.connect(iframe);
    send(iframe, installed);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(snapshotOf(panel).instrumented).toBe(true);
  });

  it('tells a panel that is already subscribed, rather than only a late one', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    expect(messagesOfKind(panel, 'capture-installed')).toEqual([]);

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);

    // Without this the reload affordance would be a dead end: the user reloads, the new document
    // announces, and a panel that only ever learns from its own subscribe keeps warning.
    expect(messagesOfKind(panel, 'capture-installed')).toEqual([{ kind: 'capture-installed' }]);
    expect(messagesOfKind(panel, 'append')).toEqual([]);
  });

  it('re-states to the panel on every announcement, not only on a change', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });

    const first = relayPort(7);
    stub.connect(first);
    send(first, installed);
    // A reload: same tab, same frame, a new document and therefore a new port. Nothing about the
    // worker's own view changed, and the panel — which resets to "checking" on navigation — still
    // has to hear it, or it warns about a page that just announced itself.
    const second = relayPort(7);
    stub.connect(second);
    send(second, installed);

    expect(messagesOfKind(panel, 'capture-installed')).toHaveLength(2);
  });

  // Pausing is about DATA. A paused panel is still attached to an instrumented document, and
  // reporting otherwise would make Pause look like it uninstalled the hooks.
  it('records instrumentation even while recording is paused', () => {
    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'set-recording', recording: false });

    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);
    send(relay, {
      v: 1,
      kind: 'frames',
      connId: 'c1',
      frames: [eventFrame(1, { type: 'RUN_STARTED' })],
    });

    expect(testHook().records()).toEqual([]);
    expect(testHook().instrumented()).toBe(true);
  });

  /*
   * A document that has gone away stops counting. This is the "replace on each new document"
   * half: a fresh page load must not inherit the previous document's flag, and the honest signal
   * that a document is gone is its relay port disconnecting.
   */
  it('stops reporting instrumentation once the document that announced it is gone', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);
    expect(testHook().instrumented()).toBe(true);

    relay.disconnect();

    expect(testHook().instrumented()).toBe(false);
  });

  it('keeps the new document instrumented when the old one disconnects after it', () => {
    // The ordering a real reload produces: the new document announces, and only then does the
    // previous document's port go away. Keying by port rather than by frame is what stops the
    // late disconnect from wiping the live document's flag.
    const before = relayPort(7);
    stub.connect(before);
    send(before, installed);

    const after = relayPort(7);
    stub.connect(after);
    send(after, installed);

    before.disconnect();

    expect(testHook().instrumented()).toBe(true);
  });

  it('drops the previous document’s subframes when a new top-level document announces', () => {
    const iframe = relayPort(7, 5);
    stub.connect(iframe);
    send(iframe, installed);
    const top = relayPort(7, 0);
    stub.connect(top);
    send(top, installed);

    // A new top-level document destroys every frame under it, so a subframe of the OLD document
    // must not keep the tab looking instrumented after the new one is gone.
    const reloaded = relayPort(7, 0);
    stub.connect(reloaded);
    send(reloaded, installed);
    reloaded.disconnect();

    expect(testHook().instrumented()).toBe(false);
  });

  it('keeps instrumentation per tab', () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);

    const other = panelPort();
    stub.connect(other);
    send(other, { kind: 'subscribe', tabId: 9 });
    expect(snapshotOf(other).instrumented).toBe(false);
  });

  it('keeps instrumentation across a clear, which empties data and installs nothing', async () => {
    const relay = relayPort(7);
    stub.connect(relay);
    send(relay, installed);

    const panel = panelPort();
    stub.connect(panel);
    send(panel, { kind: 'subscribe', tabId: 7 });
    send(panel, { kind: 'clear' });
    await settle();

    // Clearing drops records. It does not uninstall the page's hooks, and a panel that started
    // warning about instrumentation because the user pressed Clear would be lying.
    expect(testHook().instrumented()).toBe(true);
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
    send(relay, installed);
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
    expect(snapshotOf(panel).instrumented).toBe(true);
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
    expect(snapshotOf(panel).instrumented).toBe(false);
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
