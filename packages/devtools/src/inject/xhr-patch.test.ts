import { afterEach, describe, expect, it } from 'vitest';

import { isInjectMessage, type InjectMessage } from './protocol';
import { installXhrPatch } from './xhr-patch';

/**
 * A fake `XMLHttpRequest`. jsdom's real one cannot be driven through `readyState === 3` without a
 * server, and the whole point of §5.2 is what happens on that transition.
 */
class FakeXhr extends EventTarget {
  readyState = 0;
  responseText = '';
  response: unknown = '';
  status = 0;
  responseType: XMLHttpRequestResponseType = '';

  readonly openCalls: unknown[][] = [];
  readonly sendCalls: unknown[] = [];
  readonly headers = new Map<string, string>();

  open(...args: unknown[]): void {
    this.openCalls.push(args);
    this.readyState = 1;
  }

  send(body?: unknown): void {
    this.sendCalls.push(body);
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  // --- test drivers, not part of the XHR API ---

  headersReceived(contentType: string | null): void {
    if (contentType !== null) this.headers.set('content-type', contentType);
    this.status = 200;
    this.readyState = 2;
    this.dispatchEvent(new Event('readystatechange'));
  }

  chunk(text: string): void {
    this.responseText += text;
    this.response = this.responseText;
    this.readyState = 3;
    this.dispatchEvent(new Event('readystatechange'));
  }

  finish(terminal: 'load' | 'error' | 'abort' | 'timeout' = 'load'): void {
    this.readyState = 4;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new Event(terminal));
    this.dispatchEvent(new Event('loadend'));
  }
}

interface Harness {
  readonly posted: InjectMessage[];
  uninstall: () => void;
  create: () => FakeXhr;
}

let active: Harness | null = null;

function setup(): Harness {
  const posted: InjectMessage[] = [];
  let tick = 0;
  let conn = 0;
  const uninstall = installXhrPatch({
    target: FakeXhr,
    post: (message) => {
      posted.push(message);
    },
    now: () => {
      tick += 10;
      return tick;
    },
    nextConnId: () => `c${(conn += 1)}`,
  });
  const harness: Harness = { posted, uninstall, create: () => new FakeXhr() };
  active = harness;
  return harness;
}

function kinds(posted: InjectMessage[]): string[] {
  return posted.map((message) => message.kind);
}

function framesOf(posted: InjectMessage[]): string[] {
  const out: string[] = [];
  for (const message of posted) {
    if (message.kind === 'frames') for (const frame of message.frames) out.push(frame.raw);
  }
  return out;
}

const SSE = 'text/event-stream';

afterEach(() => {
  active?.uninstall();
  active = null;
});

describe('installXhrPatch — behaviour preservation', () => {
  it('forwards open and send arguments to the originals', () => {
    const { create } = setup();
    const xhr = create();
    xhr.open('POST', '/api/agent/run', true, null, null);
    xhr.send('{"threadId":"t1"}');

    expect(xhr.openCalls).toEqual([['POST', '/api/agent/run', true, null, null]]);
    expect(xhr.sendCalls).toEqual(['{"threadId":"t1"}']);
  });

  it('restores the original open and send on uninstall', () => {
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    const { uninstall } = setup();
    expect(FakeXhr.prototype.open).not.toBe(originalOpen);
    uninstall();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
  });

  it('survives a post that throws', () => {
    const posted: InjectMessage[] = [];
    const uninstall = installXhrPatch({
      target: FakeXhr,
      post: (message) => {
        posted.push(message);
        throw new Error('relay exploded');
      },
      now: () => 1,
      nextConnId: () => 'c1',
    });
    active = { posted, uninstall, create: () => new FakeXhr() };

    const xhr = new FakeXhr();
    expect(() => {
      xhr.open('POST', '/run');
      xhr.send(null);
      xhr.headersReceived(SSE);
      xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
      xhr.finish();
    }).not.toThrow();
    expect(posted.length).toBeGreaterThan(0);
  });

  it('ignores an XHR that was never opened through the patch', () => {
    const { posted } = setup();
    const xhr = new FakeXhr();
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.finish();
    expect(posted).toEqual([]);
  });
});

describe('installXhrPatch — stream candidates', () => {
  it('reports nothing for a non-stream response', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('GET', '/api/info');
    xhr.send(null);
    xhr.headersReceived('application/json');
    xhr.chunk('{"agents":[]}');
    xhr.finish();
    expect(posted).toEqual([]);
  });

  it('reports nothing when the response carries no content-type', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('GET', '/api/info');
    xhr.send(null);
    xhr.headersReceived(null);
    xhr.finish();
    expect(posted).toEqual([]);
  });

  it('opens a connection with the parsed request body as input', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', 'https://example.test/agent/run');
    xhr.send('{"threadId":"t1","runId":"r1","messages":[]}');
    xhr.headersReceived('text/event-stream; charset=utf-8');

    const [open] = posted;
    expect(open?.kind).toBe('conn-open');
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.connId).toBe('c1');
    expect(open.method).toBe('POST');
    expect(open.url).toBe('https://example.test/agent/run');
    expect(open.contentType).toBe('text/event-stream; charset=utf-8');
    expect(open.input).toEqual({ threadId: 't1', runId: 'r1', messages: [] });
  });

  it('keeps a non-JSON body verbatim and a URLSearchParams body as fields', () => {
    const { posted, create } = setup();
    const a = create();
    a.open('POST', '/run');
    a.send('not json');
    a.headersReceived(SSE);

    const b = create();
    b.open('POST', '/run');
    b.send(new URLSearchParams({ threadId: 't2' }));
    b.headersReceived(SSE);

    const opens = posted.filter((message) => message.kind === 'conn-open');
    expect(opens[0]?.kind === 'conn-open' && opens[0].input).toBe('not json');
    expect(opens[1]?.kind === 'conn-open' && opens[1].input).toEqual({ threadId: 't2' });
  });
});

describe('installXhrPatch — readyState 3 slicing (§5.2)', () => {
  it('slices only the newly arrived text on each LOADING event', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);

    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.chunk('data: {"type":"TEXT_MESSAGE_START"}\n\n');

    const frameMessages = posted.filter((message) => message.kind === 'frames');
    expect(frameMessages).toHaveLength(2);
    expect(framesOf(posted)).toEqual([
      '{"type":"RUN_STARTED"}',
      '{"type":"TEXT_MESSAGE_START"}',
    ]);
  });

  it('carries a frame across a chunk boundary that splits it mid-line', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);

    xhr.chunk('data: {"type":"TEXT_MESS');
    expect(posted.filter((message) => message.kind === 'frames')).toHaveLength(0);
    xhr.chunk('AGE_CONTENT","delta":"hi"}\n\n');

    expect(framesOf(posted)).toEqual(['{"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}']);
  });

  it('records keepalive comments as keepalive frames', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk(': ping\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    xhr.finish();

    const frames = posted.flatMap((message) => (message.kind === 'frames' ? message.frames : []));
    expect(frames[0]).toEqual({
      kind: 'keepalive',
      tMs: expect.any(Number),
      raw: ':ping\n\n',
      comment: 'ping',
    });
    expect(frames[1]?.kind).toBe('event');
  });

  it('reports multi-line data as the payload, without the frame syntax around it', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('event: message\nid: 7\ndata: {"a":1,\ndata: "b":2}\n\n');

    // `raw` is what `JSON.parse` consumes: data lines joined by \n, no `data:` prefixes, and no
    // `event:`/`id:` lines. Dropping those is the contract, not an oversight — see `WireFrame`.
    expect(framesOf(posted)).toEqual(['{"a":1,\n"b":2}']);
    expect(JSON.parse(framesOf(posted)[0] ?? '')).toEqual({ a: 1, b: 2 });
  });

  it('gives every frame from one slice the same timestamp — the §5.2 fidelity limit', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"A"}\n\ndata: {"type":"B"}\n\n');

    const frames = posted.flatMap((message) => (message.kind === 'frames' ? message.frames : []));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.tMs).toBe(frames[1]?.tMs);
  });

  it('flushes a body whose last frame has no trailing blank line', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_FINISHED"}');
    expect(framesOf(posted)).toEqual([]);
    xhr.finish();

    expect(framesOf(posted)).toEqual(['{"type":"RUN_FINISHED"}']);
    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('emits no frames message for a slice that completes no frame', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"parti');
    expect(posted.filter((message) => message.kind === 'frames')).toEqual([]);
  });
});

describe('installXhrPatch — close reasons', () => {
  it('closes complete on load', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.finish('load');

    const close = posted.at(-1);
    expect(close?.kind === 'conn-close' && close.reason).toBe('complete');
  });

  it('closes aborted on abort, not complete', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.finish('abort');

    const closes = posted.filter((message) => message.kind === 'conn-close');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.kind === 'conn-close' && closes[0].reason).toBe('aborted');
  });

  it('closes error on error and on timeout', () => {
    const { posted, create } = setup();
    const a = create();
    a.open('POST', '/run');
    a.send(null);
    a.headersReceived(SSE);
    a.finish('error');

    const b = create();
    b.open('POST', '/run');
    b.send(null);
    b.headersReceived(SSE);
    b.finish('timeout');

    const closes = posted.filter((message) => message.kind === 'conn-close');
    expect(closes.map((message) => (message.kind === 'conn-close' ? message.reason : ''))).toEqual([
      'error',
      'error',
    ]);
  });

  it('never closes a connection it never opened', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('GET', '/api/info');
    xhr.send(null);
    xhr.headersReceived('application/json');
    xhr.finish('error');
    expect(posted).toEqual([]);
  });
});

describe('installXhrPatch — binary transport (§5.4)', () => {
  it('reports protobuf responses as bytes, never as frames', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.responseType = 'arraybuffer';
    xhr.headersReceived('application/vnd.ag-ui.event+proto');
    xhr.response = new ArrayBuffer(128);
    xhr.finish();

    expect(kinds(posted)).toEqual(['conn-open', 'binary', 'conn-close']);
    const binary = posted[1];
    expect(binary?.kind === 'binary' && binary.bytes).toBe(128);
    expect(binary?.kind === 'binary' && binary.contentType).toBe(
      'application/vnd.ag-ui.event+proto',
    );
  });

  it('reports an event stream the page requested as a Blob as bytes rather than silence', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.responseType = 'blob';
    xhr.headersReceived(SSE);
    xhr.response = new Blob(['data: {"type":"RUN_STARTED"}\n\n']);
    xhr.finish();

    expect(kinds(posted)).toEqual(['conn-open', 'binary', 'conn-close']);
  });
});

describe('installXhrPatch — reuse and protocol shape', () => {
  it('gives a reopened XHR a fresh connection id', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.finish();

    xhr.responseText = '';
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"RUN_STARTED"}\n\n');
    xhr.finish();

    const ids = new Set(posted.map((message) => message.connId));
    expect(ids).toEqual(new Set(['c1', 'c2']));
  });

  it('does not let the retired listeners of a reopened XHR capture the second response', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"A"}\n\n');
    xhr.finish();

    // A real XHR clears responseText on the next request; the second body is longer than the
    // first, which is what would tempt the retired record's offset into slicing it again.
    xhr.responseText = '';
    xhr.open('POST', '/run');
    xhr.send(null);
    xhr.headersReceived(SSE);
    xhr.chunk('data: {"type":"B"}\n\ndata: {"type":"C"}\n\ndata: {"type":"D"}\n\n');
    xhr.finish();

    const perConn = posted.reduce<Record<string, string[]>>((acc, message) => {
      (acc[message.connId] ??= []).push(message.kind);
      return acc;
    }, {});
    expect(perConn.c1).toEqual(['conn-open', 'frames', 'conn-close']);
    expect(perConn.c2).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('emits only messages the relay guard accepts', () => {
    const { posted, create } = setup();
    const xhr = create();
    xhr.open('POST', '/run');
    xhr.send('{"threadId":"t1"}');
    xhr.headersReceived(SSE);
    xhr.chunk(': ping\n\ndata: {"type":"RUN_STARTED"}\n\n');
    xhr.finish();

    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    for (const message of posted) expect(isInjectMessage(message)).toBe(true);
  });
});
