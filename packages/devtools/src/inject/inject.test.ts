import { describe, it, expect, afterEach } from 'vitest';
// Side-effect import, and load-bearing: `inject.ts` is the manifest entry and its whole job is to
// call `installInject(window)` when it is loaded. Two tests below assert that it did — an entry
// that stopped installing itself would be a dead content script, and importing only `./install`
// would let that pass. Kept first so the install happens before any test reads `window`.
import './inject';
// `./install`, not `./inject`, for the exports: the entry is built as a standalone IIFE and must
// export nothing, because rollup gives an IIFE with exports a named global to hang them on and
// that would put a `window.inject` on every page. So the implementation lives one module in.
import { installInject, MARKER_VERSION, type InjectHost } from './install';
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, isInjectMessage, type InjectMessage } from './protocol';

const SSE = 'text/event-stream';
const RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}';

function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** jsdom delivers each postMessage on its own task, so one settle() is not enough. */
async function settleUntil(done: () => boolean, turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (done()) return;
    await settle();
  }
}

function sseFetch(): typeof fetch {
  return ((): Promise<Response> =>
    Promise.resolve(
      new Response(`data: ${RUN_STARTED}\n\n`, { status: 200, headers: { 'content-type': SSE } }),
    )) as typeof fetch;
}

interface FakeHost extends InjectHost {
  sent: Array<{ message: unknown; targetOrigin: string }>;
}

function fakeHost(overrides: Partial<InjectHost> = {}): FakeHost {
  const sent: Array<{ message: unknown; targetOrigin: string }> = [];
  return {
    sent,
    fetch: sseFetch(),
    location: { origin: 'http://localhost:3000' },
    postMessage(message: unknown, targetOrigin: string): void {
      sent.push({ message, targetOrigin });
    },
    ...overrides,
  };
}

/**
 * Minimal stand-ins for the two transports jsdom cannot drive: its `XMLHttpRequest` needs a
 * server to reach `readyState === 3`, and it has no `EventSource` at all.
 */
class FakeXhr extends EventTarget {
  readyState = 0;
  responseText = '';
  response: unknown = '';
  status = 0;
  responseType: XMLHttpRequestResponseType = '';
  private readonly headers = new Map<string, string>();

  open(): void {
    this.readyState = 1;
  }

  send(): void {
    // The patch attaches its listeners here; the fake needs no behaviour of its own.
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  /** Drive one whole SSE response, headers through terminal event. */
  drive(wire: string): void {
    this.headers.set('content-type', SSE);
    this.status = 200;
    this.readyState = 2;
    this.dispatchEvent(new Event('readystatechange'));
    this.responseText += wire;
    this.readyState = 3;
    this.dispatchEvent(new Event('readystatechange'));
    this.readyState = 4;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new Event('load'));
  }
}

class FakeEventSource extends EventTarget {
  readonly url: string;
  readyState = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  close(): void {
    this.readyState = 2;
  }

  deliver(payload: string): void {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent('message', { data: payload, lastEventId: '' }));
  }
}

function transportHost(): FakeHost {
  return fakeHost({ XMLHttpRequest: FakeXhr, EventSource: FakeEventSource });
}

describe('installInject — the document_start entry', () => {
  it('installs itself on import into a real window', () => {
    expect(window.__AGUI_DEVTOOLS__).toEqual({
      version: MARKER_VERSION,
      protocol: PROTOCOL_VERSION,
      source: AGUI_DT_SOURCE,
    });
  });

  it('is guarded against double injection', () => {
    const host = fakeHost();
    const first = host.fetch;
    expect(installInject(host)).toBe(true);
    const patched = host.fetch;
    expect(patched).not.toBe(first);
    expect(installInject(host)).toBe(false);
    expect(host.fetch).toBe(patched);
    expect(installInject(window)).toBe(false);
  });

  /*
   * The announcement, and why it is sent with nothing to report.
   *
   * The panel used to infer "capturing" from the ORIGIN being granted. Those two facts diverge:
   * `chrome.scripting.registerContentScripts` affects only FUTURE navigations, so a document
   * that was already open when the grant landed (or when the extension reloaded) has no hooks in
   * it, and a panel reading the permission says it is capturing while nothing is. So
   * instrumentation is now a fact the DOCUMENT reports rather than one the panel infers, and the
   * entire value of this message is in NOT arriving: absence is what tells the panel the
   * document is not instrumented. It therefore cannot ride on the first real request — a page
   * that never makes one is exactly the case that has to be distinguished.
   */
  it('announces the hooks at install time, before any traffic', () => {
    const host = fakeHost();
    installInject(host);

    const messages = host.sent.map((entry) => entry.message as InjectMessage);
    expect(messages.map((message) => message.kind)).toEqual(['capture-installed']);
    expect(messages.every(isInjectMessage)).toBe(true);
    expect(host.sent[0]?.targetOrigin).toBe('http://localhost:3000');
  });

  it('announces on a page that never opens a stream at all', async () => {
    const plain = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const host = fakeHost({
      fetch: ((): Promise<Response> => Promise.resolve(plain)) as typeof fetch,
    });
    installInject(host);
    await host.fetch('http://localhost:3000/api');
    await settle();

    expect(
      host.sent
        .map((entry) => entry.message as InjectMessage)
        .every((message) => message.kind === 'capture-installed'),
    ).toBe(true);
    expect(host.sent.length).toBeGreaterThan(0);
  });

  /*
   * The MAIN patch and the ISOLATED relay are separate content scripts, and Chrome guarantees no
   * order between the two worlds — `registerContentScripts` on a runtime-granted origin registers
   * them as independent scripts. An announcement posted before the relay's listener exists is
   * lost, and a lost announcement renders the panel's "this page is not instrumented" warning on
   * a page that IS instrumented. That is a false warning on a working setup, which trains the
   * user to ignore the banner. So it is re-stated once off the task queue, exactly as
   * `withOpenRestated` re-states `conn-open` for the same reason.
   */
  it('re-states the announcement once, off the task queue', async () => {
    const host = fakeHost();
    installInject(host);
    await settleUntil(() => host.sent.length > 1);

    const kinds = host.sent.map((entry) => (entry.message as InjectMessage).kind);
    expect(kinds).toEqual(['capture-installed', 'capture-installed']);
  });

  it('never announces twice from one document when injection is repeated', async () => {
    const host = fakeHost();
    expect(installInject(host)).toBe(true);
    expect(installInject(host)).toBe(false);
    await settleUntil(() => host.sent.length > 1);

    expect(host.sent).toHaveLength(2);
  });

  it('posts tagged, same-origin messages the relay guard accepts', async () => {
    const host = fakeHost();
    installInject(host);
    await host.fetch('http://localhost:3000/api/copilotkit/agent/default/run', {
      method: 'POST',
      body: '{"threadId":"t_1"}',
    });
    await settle();

    expect(host.sent.length).toBeGreaterThan(0);
    for (const { message, targetOrigin } of host.sent) {
      expect(targetOrigin).toBe('http://localhost:3000');
      expect(isInjectMessage(message)).toBe(true);
    }
    const kinds = host.sent
      .map((entry) => (entry.message as InjectMessage).kind)
      // The announcement is asserted on its own above; this test is about the traffic messages.
      .filter((kind) => kind !== 'capture-installed');
    // Two conn-opens, on purpose: the open is re-stated immediately before the first batch of
    // frames, because the ISOLATED-world relay's listener registers a tick after
    // `document_start` and the original may have been posted into that window with nothing
    // listening. See `withOpenRestated`. Both copies are ordinary messages that pass the guard,
    // and the service worker keys on `connId` and ignores the second.
    expect(kinds).toEqual(['conn-open', 'conn-open', 'frames', 'conn-close']);
    const opens = host.sent
      .map((entry) => entry.message as InjectMessage)
      .filter((message) => message.kind === 'conn-open');
    expect(opens[0]).toEqual(opens[1]);
  });

  it('never throws into page code when postMessage throws', async () => {
    const host = fakeHost({
      postMessage(): void {
        throw new DOMException('Invalid target origin', 'SyntaxError');
      },
    });
    expect(installInject(host)).toBe(true);
    const response = await host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(await response.text()).toBe(`data: ${RUN_STARTED}\n\n`);
  });

  it('returns false instead of throwing when the host is hostile', () => {
    const hostile = {
      get fetch(): never {
        throw new Error('boom');
      },
      location: { origin: 'http://localhost:3000' },
      postMessage(): void {},
    } as unknown as InjectHost;
    expect(installInject(hostile)).toBe(false);
  });

  it('captures nothing from a page that never opens a stream', async () => {
    const plain = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const host = fakeHost({
      fetch: ((): Promise<Response> => Promise.resolve(plain)) as typeof fetch,
    });
    installInject(host);
    const got = await host.fetch('http://localhost:3000/api');
    await settle();
    expect(got).toBe(plain);
    // The response object is handed back untouched, and the only thing on the wire is the
    // announcement — which says the hooks are installed, not that anything was captured.
    const kinds = new Set(host.sent.map((entry) => (entry.message as InjectMessage).kind));
    expect([...kinds]).toEqual(['capture-installed']);
  });
});

describe('installInject — every specified transport is installed (§5.1, §5.2, §5.3)', () => {
  it('patches fetch, XMLHttpRequest and EventSource, not just fetch', () => {
    const host = transportHost();
    const originalFetch = host.fetch;
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;

    expect(installInject(host)).toBe(true);

    expect(host.fetch).not.toBe(originalFetch);
    expect(FakeXhr.prototype.open).not.toBe(originalOpen);
    expect(FakeXhr.prototype.send).not.toBe(originalSend);
    expect(host.EventSource).not.toBe(FakeEventSource);

    // Leave the shared prototype as it was found; nothing here uninstalls for us.
    FakeXhr.prototype.open = originalOpen;
    FakeXhr.prototype.send = originalSend;
  });

  it('captures a stream over each of the three transports', async () => {
    const host = transportHost();
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    installInject(host);

    await host.fetch('http://localhost:3000/run', { method: 'POST', body: '{"threadId":"t_1"}' });
    await settle();

    const xhr = new FakeXhr();
    xhr.open();
    xhr.send();
    xhr.drive(`data: ${RUN_STARTED}\n\n`);

    if (host.EventSource === undefined) throw new Error('EventSource was not installed');
    const source = new host.EventSource('http://localhost:3000/sse') as unknown as FakeEventSource;
    source.deliver(RUN_STARTED);

    FakeXhr.prototype.open = originalOpen;
    FakeXhr.prototype.send = originalSend;

    const messages = host.sent.map((entry) => entry.message as InjectMessage);
    expect(messages.every(isInjectMessage)).toBe(true);
    // Three separate streams, so three connections — and six conn-opens, because each one is
    // re-stated before its first batch of frames (see `withOpenRestated`).
    const opens = messages.filter((message) => message.kind === 'conn-open');
    expect(opens).toHaveLength(6);
    expect(new Set(opens.map((message) => message.connId)).size).toBe(3);
    expect(messages.filter((message) => message.kind === 'frames').length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('gives every transport a connection id no other transport can collide with', async () => {
    const host = transportHost();
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    installInject(host);

    await host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    const xhr = new FakeXhr();
    xhr.open();
    xhr.send();
    xhr.drive(`data: ${RUN_STARTED}\n\n`);
    if (host.EventSource === undefined) throw new Error('EventSource was not installed');
    new host.EventSource('http://localhost:3000/sse');

    FakeXhr.prototype.open = originalOpen;
    FakeXhr.prototype.send = originalSend;

    const opens = host.sent
      .map((entry) => entry.message as InjectMessage)
      .filter((message) => message.kind === 'conn-open');
    // Deduplicated, because a connection that produced frames also re-stated its open.
    const ids = [...new Set(opens.map((message) => message.connId))];
    // The service worker keys per-connection state by connId alone: three transports each
    // numbering from 1 would merge three unrelated streams into one record.
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      // Every open for a given connection carries the same payload, so which copy the worker
      // keeps cannot matter.
      const forId = opens.filter((message) => message.connId === id);
      for (const message of forId) expect(message).toEqual(forId[0]);
    }
  });

  it('installs the transports a host does have when it lacks the others', () => {
    const host = fakeHost();
    expect(host.XMLHttpRequest).toBeUndefined();
    expect(host.EventSource).toBeUndefined();
    // jsdom has no EventSource, and a stand-in host may have neither. Missing globals are
    // skipped rather than thrown on — a document_start script that throws is a broken page.
    expect(installInject(host)).toBe(true);
  });
});

describe('installInject — on the real window', () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('delivers messages a same-origin listener can validate', async () => {
    const received: unknown[] = [];
    const listener = (event: MessageEvent): void => {
      received.push(event.data);
    };
    window.addEventListener('message', listener);
    window.fetch = sseFetch();
    delete window.__AGUI_DEVTOOLS__;
    expect(installInject(window)).toBe(true);

    await window.fetch('http://localhost:3000/run', { method: 'POST', body: '{"threadId":"t_1"}' });
    await settleUntil(() => received.length === 6);
    window.removeEventListener('message', listener);

    // Six: the announcement and its re-statement, then conn-open, the re-stated conn-open that
    // rides ahead of the first frames batch (`withOpenRestated`), frames, conn-close. A real
    // listener validates all six.
    expect(received.length).toBe(6);
    expect(received.every(isInjectMessage)).toBe(true);
    const traffic = received.filter(
      (message) => isInjectMessage(message) && message.kind !== 'capture-installed',
    );
    expect(traffic[1]).toEqual(traffic[0]);
    const open = traffic[0];
    if (!isInjectMessage(open) || open.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_1' });
    expect(open.contentType).toBe(SSE);
  });
});
