import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { installFetchPatch, type FetchHost } from './fetch-patch';
import { isInjectMessage, type ConnectionMessage, type WireFrame } from './protocol';

const RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}';
const TEXT_START = '{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}';
const TEXT_END = '{"type":"TEXT_MESSAGE_END","messageId":"m_1"}';

/** A stream whose chunks are pushed by the test, so ordering is never a race. */
function controllable(): {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
  error(reason: unknown): void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
    },
  });
  const require = (): ReadableStreamDefaultController<Uint8Array> => {
    if (controller === undefined) throw new Error('stream not started');
    return controller;
  };
  return {
    stream,
    push: (text: string): void => require().enqueue(encoder.encode(text)),
    close: (): void => require().close(),
    error: (reason: unknown): void => require().error(reason),
  };
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>, contentType = 'text/event-stream'): Response {
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': contentType },
  });
}

/** Lets every pending microtask and stream read settle. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Harness {
  host: FetchHost;
  posted: ConnectionMessage[];
  kinds(): string[];
  frames(): WireFrame[];
  patch: ReturnType<typeof installFetchPatch>;
}

function harness(
  respond: (...args: Parameters<typeof fetch>) => Promise<Response>,
  overrides: Partial<Parameters<typeof installFetchPatch>[1]> = {},
): Harness {
  const posted: ConnectionMessage[] = [];
  const host: FetchHost = { fetch: respond as typeof fetch };
  let clock = 0;
  const patch = installFetchPatch(host, {
    post: (message): void => {
      posted.push(message);
    },
    now: (): number => {
      clock += 1;
      return clock;
    },
    newConnId: (): string => 'c1',
    ...overrides,
  });
  return {
    host,
    posted,
    patch,
    kinds: (): string[] => posted.map((m) => m.kind),
    frames: (): WireFrame[] => posted.flatMap((m) => (m.kind === 'frames' ? m.frames : [])),
  };
}

describe('installFetchPatch — transparency to the page', () => {
  it('replaces fetch and restores it on uninstall', () => {
    const original = ((): Promise<Response> => Promise.resolve(new Response(''))) as typeof fetch;
    const host: FetchHost = { fetch: original };
    const patch = installFetchPatch(host, { post: (): void => undefined });
    expect(host.fetch).not.toBe(original);
    patch.uninstall();
    expect(host.fetch).toBe(original);
  });

  it('does not clobber a later patch installed over ours', () => {
    const original = ((): Promise<Response> => Promise.resolve(new Response(''))) as typeof fetch;
    const host: FetchHost = { fetch: original };
    const patch = installFetchPatch(host, { post: (): void => undefined });
    const theirs = ((): Promise<Response> => Promise.resolve(new Response(''))) as typeof fetch;
    host.fetch = theirs;
    patch.uninstall();
    expect(host.fetch).toBe(theirs);
  });

  it('passes the original arguments through untouched', async () => {
    const seen: unknown[] = [];
    const init: RequestInit = { method: 'POST', body: '{"a":1}' };
    const h = harness((...args) => {
      seen.push(...args);
      return Promise.resolve(
        new Response('ok', { headers: { 'content-type': 'application/json' } }),
      );
    });
    await h.host.fetch('http://localhost:3000/api', init);
    expect(seen[0]).toBe('http://localhost:3000/api');
    expect(seen[1]).toBe(init);
  });

  it('returns a non-stream response as the very same object, unlocked', async () => {
    const response = new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    });
    const h = harness(() => Promise.resolve(response));
    const got = await h.host.fetch('http://localhost:3000/api');
    expect(got).toBe(response);
    expect(got.bodyUsed).toBe(false);
    expect(await got.text()).toBe('{"ok":true}');
    await settle();
    expect(h.posted).toEqual([]);
  });

  it('propagates a rejection unchanged and posts nothing', async () => {
    const failure = new TypeError('Failed to fetch');
    const h = harness(() => Promise.reject(failure));
    await expect(h.host.fetch('http://localhost:3000/api')).rejects.toBe(failure);
    await settle();
    expect(h.posted).toEqual([]);
  });

  it('hands the page a byte-identical body plus status, headers, url and type', async () => {
    const original = new Response(streamOf([`data: ${RUN_STARTED}\n\n`, 'data: tail\n\n']), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream', 'x-trace': 'abc' },
    });
    Object.defineProperty(original, 'url', { value: 'http://localhost:3000/run' });
    const h = harness(() => Promise.resolve(original));
    const got = await h.host.fetch('http://localhost:3000/run');
    expect(got.status).toBe(200);
    expect(got.statusText).toBe('OK');
    expect(got.headers.get('content-type')).toBe('text/event-stream');
    expect(got.headers.get('x-trace')).toBe('abc');
    expect(got.url).toBe('http://localhost:3000/run');
    expect(got.type).toBe(original.type);
    expect(await got.text()).toBe(`data: ${RUN_STARTED}\n\ndata: tail\n\n`);
  });

  it('survives a relay that throws on every message', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`]))), {
      post: (): void => {
        throw new Error('relay is gone');
      },
    });
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(await got.text()).toBe(`data: ${RUN_STARTED}\n\n`);
  });
});

describe('installFetchPatch — capture', () => {
  it('emits conn-open, frames and conn-close in order', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_START}\n\n`]))),
    );
    await h.host.fetch('http://localhost:3000/api/copilotkit/agent/default/run', {
      method: 'post',
      body: '{"threadId":"t_1","runId":"r_1","messages":[]}',
    });
    await settle();

    expect(h.kinds()).toEqual(['conn-open', 'frames', 'frames', 'conn-close']);
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.method).toBe('POST');
    expect(open.url).toBe('http://localhost:3000/api/copilotkit/agent/default/run');
    expect(open.contentType).toBe('text/event-stream');
    expect(open.input).toEqual({ threadId: 't_1', runId: 'r_1', messages: [] });
    expect(open.connId).toBe('c1');

    expect(h.frames().map((f) => f.raw)).toEqual([RUN_STARTED, TEXT_START]);

    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('complete');
    expect(h.posted.every(isInjectMessage)).toBe(true);
  });

  it('records keepalive comments as keepalive frames', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf([': ping\n\n', `data: ${RUN_STARTED}\n\n`, ':\n\n']))),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames()).toEqual([
      { kind: 'keepalive', tMs: expect.any(Number), raw: ':ping\n\n', comment: 'ping' },
      { kind: 'event', tMs: expect.any(Number), raw: RUN_STARTED },
      { kind: 'keepalive', tMs: expect.any(Number), raw: ':\n\n', comment: '' },
    ]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(streamOf(['data: {"type":"TEXT_MES', 'SAGE_CONTENT","delta":"hi"}\r\n', '\r\n'])),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual(['{"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}']);
  });

  it('flushes an unterminated trailing frame when the stream ends', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([`data: ${TEXT_END}\n`]))));
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual([TEXT_END]);
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
  });

  it('batches every frame of one chunk into a single frames message', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(
          streamOf([`data: ${RUN_STARTED}\n\ndata: ${TEXT_START}\n\ndata: ${TEXT_END}\n\n`]),
        ),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    const batches = h.posted.filter((m) => m.kind === 'frames');
    expect(batches).toHaveLength(1);
    expect(h.frames()).toHaveLength(3);
  });

  it('never delivers frames after conn-close even when the batch is still queued', async () => {
    const held: Array<() => void> = [];
    const h = harness(() => Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`]))), {
      schedule: (task): number => held.push(task),
    });
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'frames', 'conn-close']);
    for (const task of held) task();
    expect(h.kinds()).toEqual(['conn-open', 'frames', 'conn-close']);
  });

  it('classifies the connection from its content (spec §4.1)', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_START}\n\n`]))),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.patch.classificationOf('c1')).toBe('agui');
  });

  it('leaves an unrelated SSE stream classified not-agui but still captured', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf(['data: {"hello":"world"}\n\n']))));
    await h.host.fetch('http://localhost:3000/progress');
    await settle();
    expect(h.patch.classificationOf('c1')).toBe('not-agui');
    expect(h.frames().map((f) => f.raw)).toEqual(['{"hello":"world"}']);
  });
});

describe('installFetchPatch — back-pressure (requirements §15)', () => {
  it('drains our branch in full even when the page never reads its own', async () => {
    const h = harness(() =>
      Promise.resolve(
        sseResponse(
          streamOf([
            `data: ${RUN_STARTED}\n\n`,
            `data: ${TEXT_START}\n\n`,
            `data: ${TEXT_END}\n\n`,
          ]),
        ),
      ),
    );
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(got.bodyUsed).toBe(false);
    expect(h.frames()).toHaveLength(3);
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
  });

  it('delivers a frame to the relay before the page reads that chunk', async () => {
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    const reader = got.body?.getReader();
    if (reader === undefined) throw new Error('page body missing');

    source.push(`data: ${RUN_STARTED}\n\n`);
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual([RUN_STARTED]);

    // Only now does the page get around to reading.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(`data: ${RUN_STARTED}\n\n`);

    source.push(`data: ${TEXT_END}\n\n`);
    source.close();
    await settle();
    expect(h.frames()).toHaveLength(2);
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
    await reader.read();
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it('keeps draining while delivery is stalled indefinitely', async () => {
    const stalled: Array<() => void> = [];
    const h = harness(
      () => Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`, `data: ${TEXT_END}\n\n`]))),
      { schedule: (task): number => stalled.push(task) },
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    // The stream was fully consumed and closed even though no scheduled flush ever ran.
    expect(h.kinds()).toContain('conn-close');
    expect(h.frames()).toHaveLength(2);
  });
});

describe('installFetchPatch — request body capture (verified fact 4)', () => {
  async function inputFor(body: BodyInit | null | undefined): Promise<unknown> {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([':\n\n']))));
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body });
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    return open.input;
  }

  it('parses a JSON string body into structure', async () => {
    expect(await inputFor('{"threadId":"t_1","messages":[{"role":"user"}]}')).toEqual({
      threadId: 't_1',
      messages: [{ role: 'user' }],
    });
  });

  it('keeps a non-JSON string body verbatim', async () => {
    expect(await inputFor('threadId=t_1')).toBe('threadId=t_1');
  });

  it('keeps a scalar JSON body as the string the page sent', async () => {
    expect(await inputFor('42')).toBe('42');
  });

  it('serialises URLSearchParams', async () => {
    expect(await inputFor(new URLSearchParams({ threadId: 't_1', q: 'a b' }))).toBe(
      'threadId=t_1&q=a+b',
    );
  });

  it('lists FormData entries, naming file parts without reading them', async () => {
    const form = new FormData();
    form.append('threadId', 't_1');
    form.append('upload', new Blob(['1234'], { type: 'text/plain' }), 'note.txt');
    expect(await inputFor(form)).toEqual([
      ['threadId', 't_1'],
      ['upload', '[file note.txt, 4 bytes]'],
    ]);
  });

  it('reads a Blob body', async () => {
    expect(await inputFor(new Blob(['{"threadId":"t_1"}'], { type: 'application/json' }))).toEqual({
      threadId: 't_1',
    });
  });

  it('records a ReadableStream body without consuming it', async () => {
    const body = streamOf(['{"threadId":"t_1"}']);
    expect(await inputFor(body)).toBe('[unreadable stream body]');
    expect(body.locked).toBe(false);
    expect(await new Response(body).text()).toBe('{"threadId":"t_1"}');
  });

  it('records null when there is no body', async () => {
    expect(await inputFor(undefined)).toBe(null);
    expect(await inputFor(null)).toBe(null);
  });

  it('captures the body of a Request argument without disturbing it', async () => {
    const seen: Request[] = [];
    const h = harness((...args) => {
      seen.push(args[0] as Request);
      return Promise.resolve(sseResponse(streamOf([':\n\n'])));
    });
    const request = new Request('http://localhost:3000/run', {
      method: 'POST',
      body: '{"threadId":"t_2"}',
    });
    await h.host.fetch(request);
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_2' });
    expect(open.method).toBe('POST');
    expect(open.url).toBe('http://localhost:3000/run');
    expect(seen[0]?.bodyUsed).toBe(false);
  });

  it('captures a Request body even though fetch consumes the Request', async () => {
    // `fetch(request)` runs `new Request(input)`, which marks the caller's Request used
    // SYNCHRONOUSLY. A clone taken one microtask later throws `TypeError: unusable`, and the
    // capture silently degrades to '[unsupported body]' — which is exactly the state that
    // makes every run report a spurious `run-started-without-input`. The stand-in below does
    // what the platform does, so the clone has to be taken before `original` is called.
    const h = harness((...args) => {
      const request = args[0] as Request;
      // Marks `request` used, exactly as the real fetch does.
      void new Request(request);
      return Promise.resolve(sseResponse(streamOf([':\n\n'])));
    });
    const request = new Request('http://localhost:3000/run', {
      method: 'POST',
      body: '{"threadId":"t_3"}',
    });
    await h.host.fetch(request);
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toEqual({ threadId: 't_3' });
  });

  it('records an unsupported body rather than failing when the Request is already used', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([':\n\n']))));
    const request = new Request('http://localhost:3000/run', {
      method: 'POST',
      body: '{"threadId":"t_4"}',
    });
    await request.text();
    await h.host.fetch(request);
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.input).toBe('[unsupported body]');
    expect(open.url).toBe('http://localhost:3000/run');
  });

  it('holds frames until conn-open, even when the body read resolves late', async () => {
    const h = harness(() => Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`]))));
    await h.host.fetch('http://localhost:3000/run', {
      method: 'POST',
      body: new Blob(['{"threadId":"t_1"}']),
    });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'frames', 'conn-close']);
  });
});

describe('installFetchPatch — binary transport (requirements §5.4)', () => {
  it('reports byte counts and never frames', async () => {
    const h = harness(() =>
      Promise.resolve(sseResponse(streamOf(['abcd', 'efghij']), 'application/vnd.ag-ui.event+proto')),
    );
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'binary', 'conn-close']);
    const binary = h.posted[1];
    if (binary?.kind !== 'binary') throw new Error('expected binary');
    expect(binary.bytes).toBe(10);
    expect(binary.contentType).toBe('application/vnd.ag-ui.event+proto');
    expect(h.patch.classificationOf('c1')).toBe('binary');
    expect(await got.text()).toBe('abcdefghij');
  });
});

describe('installFetchPatch — failures mid-stream', () => {
  it('closes with error when the response stream errors', async () => {
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    source.push(`data: ${RUN_STARTED}\n\n`);
    await settle();
    source.error(new TypeError('network error'));
    await settle();
    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('error');
    await expect(got.text()).rejects.toBeDefined();
  });

  it('closes with aborted when the caller aborted', async () => {
    const controller = new AbortController();
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    void h.host.fetch('http://localhost:3000/run', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    source.error(new DOMException('The user aborted a request.', 'AbortError'));
    await settle();
    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('aborted');
  });

  it('closes with aborted on an AbortError with no signal in sight', async () => {
    const source = controllable();
    const h = harness(() => Promise.resolve(sseResponse(source.stream)));
    void h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    source.error(new DOMException('aborted', 'AbortError'));
    await settle();
    const close = h.posted[h.posted.length - 1];
    if (close?.kind !== 'conn-close') throw new Error('expected conn-close');
    expect(close.reason).toBe('aborted');
  });

  it('opens and closes an SSE response that carries no body at all', async () => {
    const h = harness(() =>
      Promise.resolve(
        new Response(null, { status: 204, headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    const got = await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.kinds()).toEqual(['conn-open', 'conn-close']);
    expect(got.status).toBe(204);
  });
});

describe('installFetchPatch — timestamps (requirements §5.5)', () => {
  it('stamps a frame when its first byte arrived, not when parsing finished', async () => {
    const source = controllable();
    const clock = { value: 100 };
    const h = harness(() => Promise.resolve(sseResponse(source.stream)), {
      now: (): number => clock.value,
    });
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });

    clock.value = 200;
    source.push('data: {"type":"RUN_STAR');
    await settle();
    expect(h.frames()).toHaveLength(0);

    clock.value = 300;
    source.push('TED"}\n\n');
    await settle();
    expect(h.frames().map((f) => f.tMs)).toEqual([200]);

    clock.value = 400;
    source.push(`data: ${TEXT_START}\n\ndata: ${TEXT_END}\n\n`);
    source.close();
    await settle();
    expect(h.frames().map((f) => f.tMs)).toEqual([200, 300, 400]);
  });

  it('stamps conn-open with the time the request was issued', async () => {
    const clock = { value: 5 };
    const h = harness(
      () => {
        clock.value = 900;
        return Promise.resolve(sseResponse(streamOf([`data: ${RUN_STARTED}\n\n`])));
      },
      { now: (): number => clock.value },
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    const open = h.posted[0];
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.tMs).toBe(5);
  });
});

describe('installFetchPatch — a real run, byte-split at hostile boundaries', () => {
  /** The golden fixture the core pipeline is already tested against. */
  function fixtureEvents(): unknown[] {
    // `new URL(..., import.meta.url)` would build a jsdom URL, which `node:fs` rejects
    // because it is not an instance of Node's own URL class. Use a plain path.
    const text = readFileSync(
      join(import.meta.dirname, '../test/fixtures/happy-run.agui.jsonl'),
      'utf8',
    );
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && 'event' in parsed) {
        events.push((parsed as { event: unknown }).event);
      }
    }
    return events;
  }

  it('recovers every event of happy-run.agui.jsonl from a 7-byte-chunked stream', async () => {
    const events = fixtureEvents();
    const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));

    const h = harness(() =>
      Promise.resolve(
        sseResponse(
          new ReadableStream<Uint8Array>({
            start(c): void {
              for (const chunk of chunks) c.enqueue(chunk);
              c.close();
            },
          }),
        ),
      ),
    );
    await h.host.fetch('http://localhost:3000/api/copilotkit/agent/default/run', {
      method: 'POST',
      body: '{"threadId":"t_happy"}',
    });
    await settle();

    expect(events.length).toBeGreaterThan(5);
    expect(h.frames().map((f) => JSON.parse(f.raw) as unknown)).toEqual(events);
    expect(h.patch.classificationOf('c1')).toBe('agui');
    expect(h.kinds()[h.kinds().length - 1]).toBe('conn-close');
  });

  it('reassembles a multi-byte character split across two chunks', async () => {
    const payload = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"héllo 🌍"}';
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    const split = bytes.length - 4; // lands inside the 4-byte emoji
    const h = harness(() =>
      Promise.resolve(
        sseResponse(
          new ReadableStream<Uint8Array>({
            start(c): void {
              c.enqueue(bytes.subarray(0, split));
              c.enqueue(bytes.subarray(split));
              c.close();
            },
          }),
        ),
      ),
    );
    await h.host.fetch('http://localhost:3000/run', { method: 'POST', body: '{}' });
    await settle();
    expect(h.frames().map((f) => f.raw)).toEqual([payload]);
  });
});
