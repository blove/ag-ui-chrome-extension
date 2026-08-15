import { describe, it, expect, afterEach } from 'vitest';
import { installInject, MARKER_VERSION, type InjectHost } from './inject';
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
    expect(kinds).toEqual(['conn-open', 'frames', 'conn-close']);
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

  it('leaves a page that never opens a stream completely untouched', async () => {
    const plain = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const host = fakeHost({
      fetch: ((): Promise<Response> => Promise.resolve(plain)) as typeof fetch,
    });
    installInject(host);
    const got = await host.fetch('http://localhost:3000/api');
    await settle();
    expect(got).toBe(plain);
    expect(host.sent).toEqual([]);
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
    await settleUntil(() => received.length === 3);
    window.removeEventListener('message', listener);

    expect(received.length).toBe(3);
    expect(received.every(isInjectMessage)).toBe(true);
    const open = received[0];
    if (!isInjectMessage(open) || open.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_1' });
    expect(open.contentType).toBe(SSE);
  });
});
