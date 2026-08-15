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

function validInstalled(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: AGUI_DT_SOURCE,
    v: PROTOCOL_VERSION,
    kind: 'capture-installed',
    tMs: 1.25,
    ...extra,
  };
}

function delivered(harness: ChromeHarness): unknown[] {
  return harness.ports.flatMap((port) => port.posted);
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

describe('relay — forwarding', () => {
  it('connects with the contract port name on the first valid message', () => {
    post(validOpen());
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
  });

  it('opens no port at all for a page that never posts a valid message', () => {
    post('hello');
    post({ source: 'other-extension', v: 1, kind: 'conn-close' });
    post(validOpen(), { origin: 'https://evil.example' });
    expect(chromeHarness.connectNames).toEqual([]);
    expect(chromeHarness.ports).toEqual([]);
  });

  it('reuses one port across many messages', () => {
    post(validOpen());
    post(validOpen({ connId: 'c2' }));
    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME]);
    expect(chromeHarness.ports).toHaveLength(1);
    expect(chromeHarness.ports[0]?.posted).toHaveLength(2);
  });

  it('forwards conn-open without the source tag', () => {
    post(validOpen());
    expect(delivered(chromeHarness)).toEqual([
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
    expect(delivered(chromeHarness)).toEqual([
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
    expect(delivered(chromeHarness)).toEqual([
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
   * The announcement crosses the boundary on exactly the same terms as everything else.
   *
   * It is the message the panel reads as "this document has capture hooks in it", so a forged
   * one makes the panel claim capture is live where it is not — the very failure the message
   * exists to abolish. It therefore gets no shortcut: same origin check, same source check, same
   * plain-prototype screen, same version check, same field-by-field rebuild.
   */
  it('forwards capture-installed without the source tag', () => {
    post(validInstalled());
    expect(delivered(chromeHarness)).toEqual([{ v: 1, kind: 'capture-installed', tMs: 1.25 }]);
  });

  it('rebuilds capture-installed from known fields only', () => {
    post(validInstalled({ connId: 'c1', cookie: 'session=abc', instrumented: 'yes' }));
    const [forwarded] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(forwarded ?? {}).sort()).toEqual(['kind', 'tMs', 'v']);
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

    const [open, frames] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(open ?? {}).sort()).toEqual(
      ['connId', 'contentType', 'input', 'kind', 'method', 'tMs', 'url', 'v'].sort(),
    );
    const frameList = (frames ?? {}).frames as Record<string, unknown>[];
    expect(Object.keys(frameList[0] ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });

  it('passes the request body through verbatim', () => {
    const input = { threadId: 't1', messages: [{ role: 'user', content: 'hi' }], tools: [] };
    post(validOpen({ input }));
    const [open] = delivered(chromeHarness) as Record<string, unknown>[];
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
      expect(delivered(chromeHarness)).toEqual([]);
      expect(chromeHarness.connectNames).toEqual([]);
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
    expect(delivered(chromeHarness)).toEqual([]);
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
    const [forwarded] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.getPrototypeOf(forwarded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(forwarded, '__proto__')).toBe(false);
    expect(Object.keys(forwarded ?? {})).not.toContain('polluted');
    expectSilent();
  });

  it('strips a constructor key riding along on a valid message', () => {
    const hostile = validOpen({ constructor: { name: 'evil' }, toString: 'nope' });
    post(hostile);
    const [forwarded] = delivered(chromeHarness) as Record<string, unknown>[];
    expect(Object.keys(forwarded ?? {})).not.toContain('constructor');
    expect(Object.keys(forwarded ?? {})).not.toContain('toString');
    expect(forwarded?.kind).toBe('conn-open');
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
    expect(first?.posted).toHaveLength(1);

    first?.killFromServiceWorker();
    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.connectNames).toEqual([RELAY_PORT_NAME, RELAY_PORT_NAME]);
    expect(chromeHarness.ports[1]?.posted).toHaveLength(1);
    expectSilent();
  });

  it('reconnects when postMessage throws on a stale port and still delivers the message', () => {
    post(validOpen());
    const first = chromeHarness.ports[0];
    if (first === undefined) throw new Error('no port');
    first.failPosts = 1;

    post(validOpen({ connId: 'c2' }));

    expect(chromeHarness.ports).toHaveLength(2);
    expect(first.posted).toHaveLength(1);
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
    chromeHarness.connectThrows = 1;
    expect(() => {
      post(validOpen());
    }).not.toThrow();
    expect(delivered(chromeHarness)).toEqual([]);

    post(validOpen({ connId: 'c2' }));
    expect(delivered(chromeHarness)).toHaveLength(1);
    expectSilent();
  });
});
