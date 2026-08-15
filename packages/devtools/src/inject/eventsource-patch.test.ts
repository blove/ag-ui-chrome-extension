import { describe, expect, it } from 'vitest';

import {
  installEventSourcePatch,
  type EventSourceConstructorLike,
  type EventSourceScope,
} from './eventsource-patch';
import { isInjectMessage, type ConnectionMessage } from './protocol';

/**
 * A fake `EventSource`. jsdom ships one, but it opens a real connection and gives a test no way
 * to deliver a frame; §5.3 is entirely about what happens when a frame arrives.
 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  closeCalls = 0;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 2;
  }

  // --- test drivers, not part of the EventSource API ---

  deliver(data: string, lastEventId = ''): void {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent('message', { data, lastEventId }));
  }

  deliverNamed(type: string, data: string): void {
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent(type, { data }));
  }

  fail(readyState: 0 | 2): void {
    this.readyState = readyState;
    this.dispatchEvent(new Event('error'));
  }
}

interface Harness {
  readonly posted: ConnectionMessage[];
  readonly scope: EventSourceScope;
  uninstall: () => void;
}

function setup(): Harness {
  const posted: ConnectionMessage[] = [];
  let tick = 0;
  let conn = 0;
  const scope: EventSourceScope = { EventSource: FakeEventSource };
  const uninstall = installEventSourcePatch({
    scope,
    post: (message) => {
      posted.push(message);
    },
    now: () => {
      tick += 10;
      return tick;
    },
    nextConnId: () => `c${(conn += 1)}`,
  });
  return { posted, scope, uninstall };
}

function kinds(posted: ConnectionMessage[]): string[] {
  return posted.map((message) => message.kind);
}

describe('installEventSourcePatch — behaviour preservation', () => {
  it('constructs the original with the caller arguments and keeps instanceof working', () => {
    const { scope, uninstall } = setup();
    const source = new scope.EventSource('https://example.test/sse', { withCredentials: true });

    expect(source).toBeInstanceOf(FakeEventSource);
    expect(source.url).toBe('https://example.test/sse');
    expect((source as FakeEventSource).withCredentials).toBe(true);
    uninstall();
  });

  it('delegates close to the original', () => {
    const { scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    source.close();
    expect((source as FakeEventSource).closeCalls).toBe(1);
    uninstall();
  });

  it('restores the original binding on uninstall', () => {
    const { scope, uninstall } = setup();
    expect(scope.EventSource).not.toBe(FakeEventSource);
    uninstall();
    expect(scope.EventSource).toBe(FakeEventSource);
  });

  it('adds no own property a page could enumerate', () => {
    const { scope, uninstall } = setup();
    const plain = new FakeEventSource('/sse');
    const patched = new scope.EventSource('/sse');
    expect(Object.keys(patched as object)).toEqual(Object.keys(plain));
    expect(Reflect.ownKeys(patched as object)).toEqual(Reflect.ownKeys(plain));
    uninstall();
  });

  it('still delivers frames to the page listeners', () => {
    const { scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    const seen: string[] = [];
    source.addEventListener('message', (event) => {
      seen.push(String((event as MessageEvent<unknown>).data));
    });
    (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}');
    expect(seen).toEqual(['{"type":"RUN_STARTED"}']);
    uninstall();
  });

  it('survives a post that throws', () => {
    const posted: ConnectionMessage[] = [];
    const scope: EventSourceScope = { EventSource: FakeEventSource };
    const uninstall = installEventSourcePatch({
      scope,
      post: (message) => {
        posted.push(message);
        throw new Error('relay exploded');
      },
      now: () => 1,
      nextConnId: () => 'c1',
    });

    expect(() => {
      const source = new scope.EventSource('/sse');
      (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}');
      source.close();
    }).not.toThrow();
    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    uninstall();
  });
});

describe('installEventSourcePatch — capture (§5.3)', () => {
  it('opens a connection at construction with a null input', () => {
    const { posted, scope, uninstall } = setup();
    new scope.EventSource('https://example.test/sse');

    const open = posted[0];
    expect(open?.kind).toBe('conn-open');
    if (open?.kind !== 'conn-open') throw new Error('expected conn-open');
    expect(open.connId).toBe('c1');
    expect(open.method).toBe('GET');
    expect(open.url).toBe('https://example.test/sse');
    expect(open.contentType).toBe('text/event-stream');
    expect(open.input).toBeNull();
    uninstall();
  });

  it('reports the delivered payload as raw, with no frame syntax added', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"RUN_STARTED","threadId":"t1"}');

    const message = posted[1];
    expect(message?.kind).toBe('frames');
    if (message?.kind !== 'frames') throw new Error('expected frames');
    expect(message.connId).toBe('c1');
    expect(message.frames).toEqual([
      {
        kind: 'event',
        tMs: expect.any(Number),
        raw: '{"type":"RUN_STARTED","threadId":"t1"}',
      },
    ]);
    uninstall();
  });

  it('reports the same raw whether or not the browser supplies an event id', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"A"}', '42');
    (source as FakeEventSource).deliver('{"type":"A"}');

    const raws = posted.flatMap((message) =>
      message.kind === 'frames' ? message.frames.map((frame) => frame.raw) : [],
    );
    // `raw` is the payload, so an `id:` on the wire cannot change it. The id is not captured at
    // all today; if it is ever needed it gets its own field rather than being spliced in here.
    expect(raws).toEqual(['{"type":"A"}', '{"type":"A"}']);
    uninstall();
  });

  it('keeps multi-line data as the payload the browser assembled', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"a":1,\n"b":2}');

    const message = posted[1];
    expect(message?.kind === 'frames' && message.frames[0]?.raw).toBe('{"a":1,\n"b":2}');
    uninstall();
  });

  it('does not capture named event frames — the documented §5.3 limit', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliverNamed('run', '{"type":"RUN_STARTED"}');

    expect(kinds(posted)).toEqual(['conn-open']);
    uninstall();
  });

  it('closes complete when the page closes the stream', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"RUN_FINISHED"}');
    source.close();
    source.close();

    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    const close = posted[2];
    expect(close?.kind === 'conn-close' && close.reason).toBe('complete');
    uninstall();
  });

  it('ignores a retryable error and closes error once the browser gives up', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).fail(0);
    expect(kinds(posted)).toEqual(['conn-open']);

    (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}');
    (source as FakeEventSource).fail(2);

    expect(kinds(posted)).toEqual(['conn-open', 'frames', 'conn-close']);
    const close = posted[2];
    expect(close?.kind === 'conn-close' && close.reason).toBe('error');
    uninstall();
  });

  it('gives each EventSource its own connection id', () => {
    const { posted, scope, uninstall } = setup();
    const a = new scope.EventSource('/sse');
    const b = new scope.EventSource('/sse');
    (a as FakeEventSource).deliver('{"type":"A"}');
    (b as FakeEventSource).deliver('{"type":"B"}');

    expect(posted.map((message) => message.connId)).toEqual(['c1', 'c2', 'c1', 'c2']);
    uninstall();
  });

  it('emits only messages the relay guard accepts', () => {
    const { posted, scope, uninstall } = setup();
    const source = new scope.EventSource('/sse');
    (source as FakeEventSource).deliver('{"type":"RUN_STARTED"}', '1');
    source.close();

    expect(posted).toHaveLength(3);
    for (const message of posted) expect(isInjectMessage(message)).toBe(true);
    uninstall();
  });

  it('types the real EventSource as a valid patch target', () => {
    // jsdom does not implement `EventSource` at all, which is why every test above drives a fake.
    // The assignment still has to typecheck: production passes `window` as the scope, so
    // `EventSourceConstructorLike` must accept the real constructor.
    const target: EventSourceConstructorLike | null =
      typeof EventSource === 'undefined' ? null : EventSource;
    expect(target === null || typeof target === 'function').toBe(true);
  });
});
