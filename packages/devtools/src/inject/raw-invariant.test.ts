/**
 * The cross-transport `WireFrame.raw` invariant.
 *
 * §5.1, §5.2 and §5.3 are three separate capture paths that produce one protocol. They were
 * written separately, and they disagreed: `fetch` reported an event's `raw` as the `data:`
 * payload while XHR and `EventSource` reported the full frame text, so `JSON.parse(raw)` would
 * have worked on one transport and thrown on the other two — with no test anywhere able to
 * notice, because each suite only ever compared a transport against itself.
 *
 * This file is the fix for that class of bug rather than for that one instance: it drives all
 * three patches with the SAME logical frames and asserts the `raw` strings come out byte
 * identical. Per-file expectations can be updated one at a time and stay internally consistent;
 * this one cannot be satisfied by a transport that has drifted.
 */
import { describe, expect, it } from 'vitest';

import { installEventSourcePatch, type EventSourceScope } from './eventsource-patch';
import { installFetchPatch, type FetchHost } from './fetch-patch';
import type { InjectMessage, WireFrame } from './protocol';
import { installXhrPatch } from './xhr-patch';

/** The same logical stream, expressed the way each transport would see it. */
const EVENT_PAYLOAD = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"hi"}';
const MULTILINE_PAYLOAD = '{"a":1,\n"b":2}';
const KEEPALIVE_COMMENT = 'ping';

/** The wire text carrying exactly those frames, for the two transports that parse wire text. */
const WIRE = `: ${KEEPALIVE_COMMENT}\n\ndata: ${EVENT_PAYLOAD}\n\n`;
const MULTILINE_WIRE = 'event: message\nid: 7\ndata: {"a":1,\ndata: "b":2}\n\n';

function framesOf(posted: InjectMessage[]): WireFrame[] {
  return posted.flatMap((message) => (message.kind === 'frames' ? message.frames : []));
}

function rawOf(posted: InjectMessage[], kind: WireFrame['kind']): string[] {
  return framesOf(posted)
    .filter((frame) => frame.kind === kind)
    .map((frame) => frame.raw);
}

function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/* -------------------------------------------------------------------------- */
/* One capture per transport, from identical input.                           */
/* -------------------------------------------------------------------------- */

async function captureViaFetch(wire: string): Promise<InjectMessage[]> {
  const posted: InjectMessage[] = [];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode(wire));
      controller.close();
    },
  });
  const host: FetchHost = {
    fetch: (() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      )) as unknown as typeof fetch,
  };
  const patch = installFetchPatch(host, {
    post: (message) => {
      posted.push(message);
    },
    now: () => 1,
    newConnId: () => 'c1',
  });
  const response = await host.fetch('https://example.test/run', { method: 'POST' });
  await response.text();
  await settle();
  patch.uninstall();
  return posted;
}

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
    // The patch attaches its listeners in `send`; nothing else to do.
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  drive(wire: string): void {
    this.headers.set('content-type', 'text/event-stream');
    this.status = 200;
    this.readyState = 2;
    this.dispatchEvent(new Event('readystatechange'));
    this.responseText += wire;
    this.response = this.responseText;
    this.readyState = 3;
    this.dispatchEvent(new Event('readystatechange'));
    this.readyState = 4;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new Event('load'));
  }
}

function captureViaXhr(wire: string): InjectMessage[] {
  const posted: InjectMessage[] = [];
  const uninstall = installXhrPatch({
    target: FakeXhr,
    post: (message) => {
      posted.push(message);
    },
    now: () => 1,
    nextConnId: () => 'c1',
  });
  const xhr = new FakeXhr();
  xhr.open();
  xhr.send();
  xhr.drive(wire);
  uninstall();
  return posted;
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

  /**
   * Deliver what the browser would deliver for `wire`. `EventSource` hands the page the parsed
   * payload, never the frame text — and never a comment frame at all, which is why keepalives
   * are absent from this transport rather than empty.
   */
  deliverPayload(payload: string): void {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent('message', { data: payload, lastEventId: '' }));
  }
}

function captureViaEventSource(payload: string): InjectMessage[] {
  const posted: InjectMessage[] = [];
  const scope: EventSourceScope = { EventSource: FakeEventSource };
  const uninstall = installEventSourcePatch({
    scope,
    post: (message) => {
      posted.push(message);
    },
    now: () => 1,
    nextConnId: () => 'c1',
  });
  const source = new scope.EventSource('https://example.test/sse');
  (source as FakeEventSource).deliverPayload(payload);
  uninstall();
  return posted;
}

/* -------------------------------------------------------------------------- */

/** A LangGraph-shaped stream: named events, one pretty-printed across several `data:` lines. */
const NAMED_WIRE =
  'event: metadata\ndata: {"run_id":"r1","attempt":1}\n\n' +
  'event: values\ndata: {\ndata:   "messages": []\ndata: }\n\n';

function eventNamesOf(posted: InjectMessage[]): (string | undefined)[] {
  return framesOf(posted)
    .filter((frame) => frame.kind === 'event')
    .map((frame) => (frame.kind === 'event' ? frame.eventName : undefined));
}

describe('WireFrame.eventName is identical across transports (L1)', () => {
  it('fetch and XHR both carry a real event name, frame for frame', async () => {
    const viaFetch = eventNamesOf(await captureViaFetch(NAMED_WIRE));
    const viaXhr = eventNamesOf(captureViaXhr(NAMED_WIRE));

    expect(viaFetch).toEqual(['metadata', 'values']);
    expect(viaXhr).toEqual(viaFetch);
  });

  it('fetch and XHR agree on raw for a named, multi-line payload', async () => {
    const viaFetch = rawOf(await captureViaFetch(NAMED_WIRE), 'event');
    expect(viaFetch).toEqual(['{"run_id":"r1","attempt":1}', '{\n  "messages": []\n}']);
    expect(rawOf(captureViaXhr(NAMED_WIRE), 'event')).toEqual(viaFetch);
  });

  it('no transport reports a name for "event: message", because EventSource cannot', async () => {
    // MULTILINE_WIRE opens with `event: message`.
    const viaFetch = framesOf(await captureViaFetch(MULTILINE_WIRE));
    const viaXhr = framesOf(captureViaXhr(MULTILINE_WIRE));
    const viaEventSource = framesOf(captureViaEventSource(MULTILINE_PAYLOAD));

    for (const frame of [...viaFetch, ...viaXhr, ...viaEventSource]) {
      expect(Object.keys(frame)).not.toContain('eventName');
    }
  });

  it('an unnamed frame has no eventName key at all, not an undefined one', async () => {
    const [frame] = framesOf(await captureViaFetch(`data: ${EVENT_PAYLOAD}\n\n`));
    expect(Object.keys(frame ?? {}).sort()).toEqual(['kind', 'raw', 'tMs']);
  });
});

describe('WireFrame.raw is identical across fetch, XHR and EventSource', () => {
  it('agrees byte for byte on an event frame', async () => {
    const viaFetch = rawOf(await captureViaFetch(WIRE), 'event');
    const viaXhr = rawOf(captureViaXhr(WIRE), 'event');
    const viaEventSource = rawOf(captureViaEventSource(EVENT_PAYLOAD), 'event');

    expect(viaFetch).toEqual([EVENT_PAYLOAD]);
    expect(viaXhr).toEqual(viaFetch);
    expect(viaEventSource).toEqual(viaFetch);
  });

  it('agrees byte for byte on a multi-line event frame', async () => {
    const viaFetch = rawOf(await captureViaFetch(MULTILINE_WIRE), 'event');
    const viaXhr = rawOf(captureViaXhr(MULTILINE_WIRE), 'event');
    const viaEventSource = rawOf(captureViaEventSource(MULTILINE_PAYLOAD), 'event');

    expect(viaFetch).toEqual([MULTILINE_PAYLOAD]);
    expect(viaXhr).toEqual(viaFetch);
    expect(viaEventSource).toEqual(viaFetch);
  });

  it('agrees byte for byte on a keepalive frame, on the two transports that can see one', async () => {
    const viaFetch = framesOf(await captureViaFetch(WIRE)).filter(
      (frame) => frame.kind === 'keepalive',
    );
    const viaXhr = framesOf(captureViaXhr(WIRE)).filter((frame) => frame.kind === 'keepalive');

    expect(viaFetch.map((frame) => frame.raw)).toEqual([`:${KEEPALIVE_COMMENT}\n\n`]);
    expect(viaXhr.map((frame) => frame.raw)).toEqual(viaFetch.map((frame) => frame.raw));
    expect(viaXhr.map((frame) => frame.kind === 'keepalive' && frame.comment)).toEqual([
      KEEPALIVE_COMMENT,
    ]);
  });

  it('reports no keepalive at all over EventSource, rather than a differently-shaped one', () => {
    const frames = framesOf(captureViaEventSource(EVENT_PAYLOAD));
    expect(frames.filter((frame) => frame.kind === 'keepalive')).toEqual([]);
  });

  it('produces an event raw that JSON.parse consumes directly, on every transport', async () => {
    const raws = [
      ...rawOf(await captureViaFetch(WIRE), 'event'),
      ...rawOf(captureViaXhr(WIRE), 'event'),
      ...rawOf(captureViaEventSource(EVENT_PAYLOAD), 'event'),
    ];
    expect(raws).toHaveLength(3);
    // The consumer-facing half of the invariant: whatever `raw` is, `JSON.parse` has to take it.
    // This is what the service worker will do with an event frame, on all three transports.
    for (const raw of raws) {
      expect(JSON.parse(raw)).toEqual({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm_1',
        delta: 'hi',
      });
    }
  });
});
