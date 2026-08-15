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
   * INSTALLING SAYS NOTHING TO THE PAGE. This is the privacy property of the whole file.
   *
   * `installInject` used to post a `capture-installed` message here, twice, at `document_start`.
   * `window.postMessage` targets the page's own window, so every `message` listener on the page
   * received it — and many pages have one, for iframe communication. That meant every page load
   * on a granted origin announced the extension, including the vast majority that never make an
   * AG-UI request. §11 wants the extension unobtrusive, and an application that can tell it is
   * being inspected can behave differently while it is.
   *
   * The panel still needs the signal, and still gets it — from `relay/relay.ts`, over
   * `chrome.runtime`, in the ISOLATED world where the page cannot see it. Nothing about the
   * signal was dropped; it changed worlds.
   */
  it('says nothing to the page at install time', () => {
    const host = fakeHost();
    expect(installInject(host)).toBe(true);
    expect(host.sent).toEqual([]);
  });

  it('still says nothing after the task queue drains', async () => {
    // The old announcement was posted a second time off the task queue, to survive the
    // MAIN/ISOLATED injection race. Both copies are gone; a timer that resurrects either would
    // land here.
    const host = fakeHost();
    installInject(host);
    await settle();
    await settle();
    expect(host.sent).toEqual([]);
  });

  it('says nothing on a page whose only traffic is not a stream', async () => {
    const plain = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const host = fakeHost({
      fetch: ((): Promise<Response> => Promise.resolve(plain)) as typeof fetch,
    });
    installInject(host);
    await host.fetch('http://localhost:3000/api');
    await settle();

    // A page can still learn nothing from us by making requests we do not capture. Everything
    // the page can observe is downstream of an AG-UI stream it opened itself.
    expect(host.sent).toEqual([]);
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
    const kinds = host.sent.map((entry) => (entry.message as InjectMessage).kind);
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
    // The response object is handed back untouched, and nothing at all crosses the boundary.
    expect(host.sent).toEqual([]);
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

  /*
   * A REAL page listener, which is what the page has and what this change is about.
   *
   * The listener is attached BEFORE `installInject` runs — the position a page's own inline
   * `<head>` script is in relative to a `document_start` content script — and it hears nothing
   * until the page itself opens a stream. Before this change it would have heard the
   * announcement, twice, on every page load of a granted origin.
   */
  it('is silent to a same-origin listener until the page opens a stream', async () => {
    const received: unknown[] = [];
    const listener = (event: MessageEvent): void => {
      received.push(event.data);
    };
    window.addEventListener('message', listener);
    window.fetch = sseFetch();
    delete window.__AGUI_DEVTOOLS__;
    expect(installInject(window)).toBe(true);

    // Two turns of the task queue: the announcement's re-statement used to land on the first.
    await settle();
    await settle();
    expect(received).toEqual([]);

    await window.fetch('http://localhost:3000/run', { method: 'POST', body: '{"threadId":"t_1"}' });
    await settleUntil(() => received.length === 4);
    window.removeEventListener('message', listener);

    // Four: conn-open, the re-stated conn-open that rides ahead of the first frames batch
    // (`withOpenRestated`), frames, conn-close. A real listener validates all four — and every
    // one of them is downstream of the fetch the page made a line above.
    expect(received.length).toBe(4);
    expect(received.every(isInjectMessage)).toBe(true);
    expect(received[1]).toEqual(received[0]);
    const open = received[0];
    if (!isInjectMessage(open) || open.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_1' });
    expect(open.contentType).toBe(SSE);
  });
});
