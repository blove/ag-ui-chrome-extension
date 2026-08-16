import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGUI_DT_SOURCE, PROTOCOL_VERSION } from '../inject/protocol';
import { RELAY_PORT_NAME } from '../sw/protocol';

/** A `chrome.runtime.Port` double: records what the relay sent and can fail on demand. */
interface FakePort {
  readonly name: string;
  readonly posted: unknown[];
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onDisconnect: { addListener: (listener: () => void) => void };
  /** Fail the next N `postMessage` calls, as a dead port does. */
  failPosts: number;
  /** Fire the disconnect listeners, as MV3 does when the worker is terminated (§15). */
  killFromServiceWorker: () => void;
}

interface ChromeHarness {
  readonly ports: FakePort[];
  readonly connectNames: string[];
  /** Make the next `connect` throw, as an invalidated extension context does. */
  connectThrows: number;
}

function installChrome(): ChromeHarness {
  const harness: ChromeHarness = { ports: [], connectNames: [], connectThrows: 0 };

  const connect = (info: { name: string }): FakePort => {
    harness.connectNames.push(info.name);
    if (harness.connectThrows > 0) {
      harness.connectThrows -= 1;
      throw new Error('Extension context invalidated.');
    }
    const listeners = new Set<() => void>();
    const port: FakePort = {
      name: info.name,
      posted: [],
      failPosts: 0,
      postMessage: (message: unknown): void => {
        if (port.failPosts > 0) {
          port.failPosts -= 1;
          throw new Error('Attempting to use a disconnected port object');
        }
        port.posted.push(message);
      },
      disconnect: (): void => {
        for (const listener of [...listeners]) listener();
      },
      onDisconnect: {
        addListener: (listener: () => void): void => {
          listeners.add(listener);
        },
      },
      killFromServiceWorker: (): void => {
        for (const listener of [...listeners]) listener();
      },
    };
    harness.ports.push(port);
    return port;
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { connect, lastError: undefined },
  };
  return harness;
}

let messageListener: EventListener | null = null;

/** Load a fresh copy of the relay and remember the listener it registered. */
async function loadRelay(): Promise<void> {
  const spy = vi.spyOn(window, 'addEventListener');
  vi.resetModules();
  await import('./relay');
  const call = spy.mock.calls.find(([type]) => type === 'message');
  const listener = call?.[1];
  if (typeof listener !== 'function') throw new Error('relay registered no message listener');
  messageListener = listener as EventListener;
  spy.mockRestore();
}

/** Dispatch a real `message` event, with any part of it under the test's control. */
function post(data: unknown, overrides: { origin?: string; source?: unknown } = {}): void {
  const event = new MessageEvent('message', {
    data,
    origin: overrides.origin ?? window.location.origin,
  });
  Object.defineProperty(event, 'source', {
    value: 'source' in overrides ? overrides.source : window,
    configurable: true,
  });
  window.dispatchEvent(event);
}

function validOpen(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: AGUI_DT_SOURCE,
    v: PROTOCOL_VERSION,
    kind: 'conn-open',
    connId: 'c1',
    tMs: 12.5,
    method: 'POST',
    url: 'https://example.test/agent/run',
    contentType: 'text/event-stream',
    input: { threadId: 't1' },
    ...extra,
  };
}

/**
 * The message a page would have to forge to make the panel claim capture where there is none.
 *
 * It used to be a real `InjectMessage` arm posted by the MAIN world at `document_start`. It is
 * not one any more — the presence signal moved to `chrome.runtime`, where the page cannot reach
 * it — so every case built from this is now expected to be dropped as an unknown kind. The cases
 * are kept rather than deleted: this is the shape an attacker who has read the old source would
 * try, and "the arm was removed" and "the arm is rejected" must not be allowed to drift apart.
 */
function validInstalled(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: AGUI_DT_SOURCE,
    v: PROTOCOL_VERSION,
    kind: 'capture-installed',
    tMs: 1.25,
    ...extra,
  };
}

/** What the relay says of its own accord, once, when it loads. */
const LOAD_REPORT = { v: PROTOCOL_VERSION, kind: 'capture-loaded' };

function delivered(harness: ChromeHarness): unknown[] {
  return harness.ports.flatMap((port) => port.posted);
}

/**
 * Everything the relay sent EXCEPT its own load report, which comes first on every load.
 *
 * The report is ASSERTED here rather than filtered out. A filter would keep passing if the relay
 * stopped sending it, or sent it twice, or sent something else first — and the whole point of the
 * report is that its absence is a finding. Asserting it means a relay that goes quiet fails every
 * test in this file instead of shifting them all by one and staying green.
 */
function forwarded(harness: ChromeHarness): unknown[] {
  const all = delivered(harness);
  expect(all[0]).toEqual(LOAD_REPORT);
  return all.slice(1);
}

let chromeHarness: ChromeHarness;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(async () => {
  chromeHarness = installChrome();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  await loadRelay();
});

afterEach(() => {
  if (messageListener !== null) window.removeEventListener('message', messageListener);
  messageListener = null;
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies = [];
  Reflect.deleteProperty(globalThis, 'chrome');
});

function expectSilent(): void {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
}

/**
 * The relay's own report — the presence signal, in the world the page cannot see.
 *
 * This replaced a `window.postMessage` the MAIN world used to make at `document_start`, which
 * every `message` listener on the page received. These tests are about the two halves of that
 * move: the signal still reaches the worker, and the page hears nothing.
 */
describe('relay — reporting itself to the service worker', () => {
  it('reports the capture layer loaded as soon as it is loaded, over the runtime port', () => {
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
    expect(delivered(chromeHarness)).toEqual([LOAD_REPORT]);
  });

  it('says nothing to the page when it loads', async () => {
    // The headline property, at unit scale: a page on a granted origin that never makes a
    // request must not learn the extension exists. `e2e/quiet-page.spec.ts` asserts the same
    // thing in a real browser, where the page's own listener is what does the observing.
    if (messageListener !== null) window.removeEventListener('message', messageListener);
    const reply = vi.spyOn(window, 'postMessage');
    const dispatched = vi.spyOn(window, 'dispatchEvent');
    // A second, clean load with the page's ears on from before the first line of it runs.
    await loadRelay();
    expect(reply).not.toHaveBeenCalled();
    expect(dispatched).not.toHaveBeenCalled();
    reply.mockRestore();
    dispatched.mockRestore();
  });

  it('reports once per document, not once per message', () => {
    post(validOpen());
    post(validOpen({ connId: 'c2' }));
    const reports = delivered(chromeHarness).filter(
      (message) => (message as { kind?: unknown }).kind === 'capture-loaded',
    );
    // Once per document is what the worker's replace-on-navigation behaviour is keyed on: a
    // second report from the top-level frame would clear the still-live subframes beneath it.
    expect(reports).toEqual([LOAD_REPORT]);
  });
});

describe('relay — forwarding', () => {
  it('connects with the contract port name, once, and reuses that port', () => {
    post(validOpen());
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
    expect(chromeHarness.ports).toHaveLength(1);
  });

  it('adds nothing to the port for a page that never posts a valid message', () => {
    post('hello');
    post({ source: 'other-extension', v: 1, kind: 'conn-close' });
    post(validOpen(), { origin: 'https://evil.example' });
    // One port, holding the load report and nothing else. The port itself is not evidence about
    // the page: it is opened for our own report, before the page has run a line of script.
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
    expect(forwarded(chromeHarness)).toEqual([]);
  });

  it('reuses one port across many messages', () => {
    post(validOpen());
    post(validOpen({ connId: 'c2' }));
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
    expect(chromeHarness.ports).toHaveLength(1);
    expect(forwarded(chromeHarness)).toHaveLength(2);
  });

  it('forwards conn-open without the source tag', () => {
    post(validOpen());
    expect(forwarded(chromeHarness)).toEqual([
      {
        v: 1,
        kind: 'conn-open',
        connId: 'c1',
        tMs: 12.5,
        method: 'POST',
        url: 'https://example.test/agent/run',
        contentType: 'text/event-stream',
        input: { threadId: 't1' },
      },
    ]);
  });

  it('forwards both frame kinds', () => {
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: 'c1',
      frames: [
        { kind: 'event', tMs: 1, raw: '{"type":"RUN_STARTED"}' },
        { kind: 'keepalive', tMs: 2, raw: ':ping\n\n', comment: 'ping' },
      ],
    });
    expect(forwarded(chromeHarness)).toEqual([
      {
        v: 1,
        kind: 'frames',
        connId: 'c1',
        frames: [
          { kind: 'event', tMs: 1, raw: '{"type":"RUN_STARTED"}' },
          { kind: 'keepalive', tMs: 2, raw: ':ping\n\n', comment: 'ping' },
        ],
      },
    ]);
  });

  it('forwards conn-close and binary', () => {
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-close',
      connId: 'c1',
      tMs: 3,
      reason: 'aborted',
    });
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'binary',
      connId: 'c2',
      tMs: 4,
      contentType: 'application/vnd.ag-ui.event+proto',
      bytes: 64,
    });
    expect(forwarded(chromeHarness)).toEqual([
      { v: 1, kind: 'conn-close', connId: 'c1', tMs: 3, reason: 'aborted' },
      {
        v: 1,
        kind: 'binary',
        connId: 'c2',
        tMs: 4,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 64,
      },
    ]);
  });

  /*
   * The presence claim is no longer something the page side can express.
   *
   * The MAIN world used to post `capture-installed` and this relay used to forward it, which
   * meant a page that forged one could make the panel claim capture was live on a document with
   * no hooks in it. The claim now originates HERE, in the ISOLATED world, and has no
   * `InjectMessage` arm at all — so a forgery is not "rejected by a stricter check", it is an
   * unknown kind, which is the strongest form of no.
   */
  it('drops a page-posted capture-installed, which is no longer a message at all', () => {
    post(validInstalled());
    expect(forwarded(chromeHarness)).toEqual([]);
  });

  it('cannot be made to report a load by anything the page posts', () => {
    post(validInstalled());
    post({ source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION, kind: 'capture-loaded' });
    post(validInstalled({ kind: 'capture-loaded' }));
    post(validOpen({ kind: 'capture-loaded' }));
    // Exactly one report, and it is the one this relay made about itself before the page ran.
    expect(
      delivered(chromeHarness).filter(
        (message) => (message as { kind?: unknown }).kind === 'capture-loaded',
      ),
    ).toEqual([LOAD_REPORT]);
  });

  it('drops properties the contract does not name, at the top level and inside frames', () => {
    post(validOpen({ cookie: 'session=abc', headers: { authorization: 'Bearer x' } }));
    post({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: 'c1',
      frames: [{ kind: 'event', tMs: 1, raw: '{}', stolen: 'secret' }],
    });

    const [open, frames] = forwarded(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(open ?? {}).sort()).toEqual(
      ['connId', 'contentType', 'input', 'kind', 'method', 'tMs', 'url', 'v'].sort(),
    );
    const frameList = (frames ?? {}).frames as Record<string, unknown>[];
    expect(Object.keys(frameList[0] ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });

  it('passes the request body through verbatim', () => {
    const input = { threadId: 't1', messages: [{ role: 'user', content: 'hi' }], tools: [] };
    post(validOpen({ input }));
    const [open] = forwarded(chromeHarness) as Record<string, unknown>[];
    expect(open?.input).toEqual(input);
  });
});

describe('relay — hostile input is dropped silently', () => {
  const cases: Array<[string, () => void]> = [
    ['a message from an embedded iframe (wrong source)', () => post(validOpen(), { source: {} })],
    ['a message with a null source', () => post(validOpen(), { source: null })],
    ['a cross-origin poster', () => post(validOpen(), { origin: 'https://evil.example' })],
    ['an opaque "null" origin', () => post(validOpen(), { origin: 'null' })],
    [
      'a same-origin string that only looks like ours',
      () => post(validOpen(), { origin: `${window.location.origin}.evil.example` }),
    ],
    ['an untagged message', () => post({ v: 1, kind: 'conn-open', connId: 'c1', tMs: 1 })],
    ['a look-alike tag', () => post(validOpen({ source: 'agui-dt-evil' }))],
    ['a bumped protocol version', () => post(validOpen({ v: 2 }))],
    ['a version that is a string', () => post(validOpen({ v: '1' }))],
    ['an unknown kind', () => post(validOpen({ kind: 'exfiltrate' }))],
    ['a missing connId', () => post(validOpen({ connId: undefined }))],
    ['a non-string connId', () => post(validOpen({ connId: 42 }))],
    ['an empty connId', () => post(validOpen({ connId: '' }))],
    ['a NaN timestamp', () => post(validOpen({ tMs: Number.NaN }))],
    ['a non-string url', () => post(validOpen({ url: { toString: () => 'x' } }))],
    [
      'an invalid close reason',
      () =>
        post({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'conn-close',
          connId: 'c1',
          tMs: 1,
          reason: 'exfiltrate',
        }),
    ],
    [
      'frames that are not an array',
      () =>
        post({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'frames',
          connId: 'c1',
          frames: 'data: {}',
        }),
    ],
    [
      'a frame that is not an object',
      () =>
        post({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'frames',
          connId: 'c1',
          frames: ['data: {}'],
        }),
    ],
    [
      'a frame missing raw',
      () =>
        post({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'frames',
          connId: 'c1',
          frames: [{ kind: 'event', tMs: 1 }],
        }),
    ],
    [
      'a keepalive frame missing its comment',
      () =>
        post({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'frames',
          connId: 'c1',
          frames: [{ kind: 'keepalive', tMs: 1, raw: ':x\n\n' }],
        }),
    ],
    [
      'a mixed array where only the last frame is malformed',
      () =>
        post({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'frames',
          connId: 'c1',
          frames: [{ kind: 'event', tMs: 1, raw: '{}' }, null],
        }),
    ],
    ['a forged capture-installed from an iframe', () => post(validInstalled(), { source: {} })],
    [
      'a forged capture-installed from another origin',
      () => post(validInstalled(), { origin: 'https://evil.example' }),
    ],
    ['a capture-installed with a look-alike tag', () => post(validInstalled({ source: 'agui-dt2' }))],
    ['a capture-installed from a future protocol', () => post(validInstalled({ v: 2 }))],
    ['a capture-installed with no timestamp', () => post({ ...validInstalled(), tMs: undefined })],
    ['a capture-installed with a NaN timestamp', () => post(validInstalled({ tMs: Number.NaN }))],
    [
      'a capture-installed whose fields live on its prototype',
      () => {
        const hostile = Object.create({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          tMs: 1,
        }) as Record<string, unknown>;
        hostile.kind = 'capture-installed';
        post(hostile);
      },
    ],
    ['a bare string', () => post('data: {"type":"RUN_STARTED"}')],
    ['null', () => post(null)],
    ['a number', () => post(7)],
    ['an array', () => post([validOpen()])],
    ['a function', () => post(() => undefined)],
    [
      'a message whose tag lives on the prototype, not the object',
      () => {
        const hostile = Object.create({ source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION }) as Record<
          string,
          unknown
        >;
        hostile.kind = 'conn-open';
        hostile.connId = 'c1';
        hostile.tMs = 1;
        hostile.method = 'POST';
        hostile.url = '/run';
        hostile.contentType = null;
        post(hostile);
      },
    ],
  ];

  for (const [name, send] of cases) {
    it(`drops ${name}`, () => {
      expect(send).not.toThrow();
      // NOTHING the page posts reaches the port. The port itself already exists — the relay
      // opened it for its own load report, before the page ran — so the assertion is on what
      // crossed it, not on whether it was opened.
      expect(forwarded(chromeHarness)).toEqual([]);
      expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
      expectSilent();
    });
  }

  it('drops a payload whose getter throws, without throwing itself', () => {
    const hostile = validOpen();
    Object.defineProperty(hostile, 'kind', {
      get(): never {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(() => {
      post(hostile);
    }).not.toThrow();
    expect(forwarded(chromeHarness)).toEqual([]);
    expectSilent();
  });

  it('does not let a __proto__ key on an otherwise valid message pollute Object.prototype', () => {
    const hostile = JSON.parse(
      `{"__proto__":{"polluted":"yes"},"source":"${AGUI_DT_SOURCE}","v":1,"kind":"conn-open",` +
        `"connId":"c1","tMs":1,"method":"POST","url":"/run","contentType":null,"input":null}`,
    ) as unknown;
    post(hostile);

    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    const [open] = forwarded(chromeHarness) as Record<string, unknown>[];
    expect(Object.getPrototypeOf(open)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(open, '__proto__')).toBe(false);
    expect(Object.keys(open ?? {})).not.toContain('polluted');
    expectSilent();
  });

  it('strips a constructor key riding along on a valid message', () => {
    const hostile = validOpen({ constructor: { name: 'evil' }, toString: 'nope' });
    post(hostile);
    const [open] = forwarded(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(open ?? {})).not.toContain('constructor');
    expect(Object.keys(open ?? {})).not.toContain('toString');
    expect(open?.kind).toBe('conn-open');
  });

  it('never answers the page', () => {
    const reply = vi.spyOn(window, 'postMessage');
    post(validOpen());
    post(validOpen(), { origin: 'https://evil.example' });
    post('probe');
    expect(reply).not.toHaveBeenCalled();
    reply.mockRestore();
  });
});

describe('relay — surviving a sleeping service worker (§15)', () => {
  it('reconnects when the port died since the last message', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    // The load report, then the open.
    expect(first?.posted).toHaveLength(2);

    first?.killFromServiceWorker();
    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME, RELAY_PORT_NAME]);
    expect(chromeHarness.ports[1]?.posted).toHaveLength(1);
    expectSilent();
  });

  /*
   * A reconnect is NOT a new document, and the relay must not say it is.
   *
   * MV3 terminates an idle worker (§15), which disconnects the port; the next message reopens
   * one. If the relay re-reported on that new port, the worker would treat it as a fresh
   * top-level document and clear every subframe it had recorded — subframes that are still open,
   * still loaded, and have no reason to report again. This is the whole reason the signal is a
   * message sent once at load rather than the bare fact of a port connection.
   */
  it('does not re-report on the port it opens after a reconnect', () => {
    const first = chromeHarness.ports[0];
    first?.killFromServiceWorker();
    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.ports).toHaveLength(2);
    expect(chromeHarness.ports[1]?.posted).toEqual([
      {
        v: 1,
        kind: 'conn-open',
        connId: 'c2',
        tMs: 12.5,
        method: 'POST',
        url: 'https://example.test/agent/run',
        contentType: 'text/event-stream',
        input: { threadId: 't1' },
      },
    ]);
    expectSilent();
  });

  it('reconnects when postMessage throws on a stale port and still delivers the message', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    if (first === undefined) throw new Error('no port');
    first.failPosts = 1;

    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.ports).toHaveLength(2);
    expect(first.posted).toHaveLength(2);
    const second = chromeHarness.ports[1];
    expect(second?.posted).toEqual([
      {
        v: 1,
        kind: 'conn-open',
        connId: 'c2',
        tMs: 12.5,
        method: 'POST',
        url: 'https://example.test/agent/run',
        contentType: 'text/event-stream',
        input: { threadId: 't1' },
      },
    ]);
    expectSilent();
  });

  it('gives up after one retry instead of looping', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    if (first === undefined) throw new Error('no port');
    first.failPosts = 1;
    // The replacement port is dead on arrival too.
    const runtime = (
      globalThis as unknown as {
        chrome: { runtime: { connect: (info: { name: string }) => FakePort } };
      }
    ).chrome.runtime;
    const originalConnect = runtime.connect;
    runtime.connect = (info): FakePort => {
      const port = originalConnect(info);
      port.failPosts = 1;
      return port;
    };

    expect(() => {
      post(validOpen({ connId: 'c2' }));
    }).not.toThrow();
    expect(chromeHarness.connectNames).toHaveLength(2);
    expectSilent();
  });

  it('drops the message when the extension context is gone, then recovers', () => {
    // Kill the port the load report opened, so the next message has to reconnect — and make
    // that reconnect fail, as an invalidated extension context does.
    chromeHarness.ports[0]?.killFromServiceWorker();
    chromeHarness.connectThrows = 1;
    expect(() => {
      post(validOpen());
    }).not.toThrow();
    expect(forwarded(chromeHarness)).toEqual([]);

    post(validOpen({ connId: 'c2' }));
    expect(forwarded(chromeHarness)).toHaveLength(1);
    expectSilent();
  });

  /*
   * The load report is the first thing this file does, and it can fail like anything else.
   *
   * A relay loaded into a document whose extension context is already gone — an extension
   * reload, an uninstall — must not throw at `document_start`. A throw there is a broken page,
   * and it would be a broken page caused by us, in the page's own load. There is no retry: the
   * report is about a moment that has passed.
   */
  it('survives an extension context that is already gone when it loads', async () => {
    if (messageListener !== null) window.removeEventListener('message', messageListener);
    // Everything the relay loaded by `beforeEach` already said. The second load must add none.
    const before = delivered(chromeHarness).length;
    chromeHarness.connectThrows = 2;
    await expect(loadRelay()).resolves.toBeUndefined();
    expect(delivered(chromeHarness)).toHaveLength(before);
    expectSilent();
  });
});
