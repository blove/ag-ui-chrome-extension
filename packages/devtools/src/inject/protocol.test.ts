import { describe, it, expect } from 'vitest';
import {
  AGUI_DT_SOURCE,
  PROTOCOL_VERSION,
  isInjectMessage,
  type InjectMessage,
  type WireFrame,
} from './protocol';

const connOpen: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'conn-open',
  connId: 'c1',
  tMs: 12.5,
  method: 'POST',
  url: 'http://localhost:3000/api/copilotkit/agent/default/run',
  contentType: 'text/event-stream',
  input: { threadId: 't_1', runId: 'r_1', messages: [] },
};

const frames: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'frames',
  connId: 'c1',
  frames: [
    { kind: 'event', tMs: 13, raw: '{"type":"RUN_STARTED"}' },
    { kind: 'keepalive', tMs: 14, raw: ':ping\n\n', comment: 'ping' },
  ],
};

const goodFrame: WireFrame = { kind: 'event', tMs: 13, raw: '{"type":"RUN_STARTED"}' };

const connClose: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'conn-close',
  connId: 'c1',
  tMs: 99,
  reason: 'complete',
};

const binary: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'binary',
  connId: 'c2',
  tMs: 42,
  contentType: 'application/vnd.ag-ui.event+proto',
  bytes: 2048,
};

/**
 * The one message that is about the capture layer rather than about the page's traffic.
 *
 * It has no `connId` — there is no connection, and there may never be one; its whole value is
 * that a document which was never instrumented cannot send it.
 */
const captureInstalled: InjectMessage = {
  source: AGUI_DT_SOURCE,
  v: PROTOCOL_VERSION,
  kind: 'capture-installed',
  tMs: 0.5,
};

/** A copy of `message` with one key removed, so "missing field" cases stay readable. */
function without(message: InjectMessage, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...message };
  delete copy[key];
  return copy;
}

describe('constants', () => {
  it('pins the literals the relay matches on', () => {
    expect(AGUI_DT_SOURCE).toBe('agui-dt');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('isInjectMessage — accepts every message the contract defines', () => {
  it('accepts conn-open', () => {
    expect(isInjectMessage(connOpen)).toBe(true);
  });

  it('accepts frames, including an empty batch', () => {
    expect(isInjectMessage(frames)).toBe(true);
    expect(isInjectMessage({ ...frames, frames: [] })).toBe(true);
  });

  it('accepts conn-close for every reason', () => {
    for (const reason of ['complete', 'error', 'aborted'] as const) {
      expect(isInjectMessage({ ...connClose, reason })).toBe(true);
    }
  });

  it('accepts binary, including a zero-byte body', () => {
    expect(isInjectMessage(binary)).toBe(true);
    expect(isInjectMessage({ ...binary, bytes: 0 })).toBe(true);
  });

  it('accepts conn-open with an explicitly undefined input', () => {
    expect(isInjectMessage({ ...connOpen, input: undefined })).toBe(true);
  });

  it('accepts a null contentType on conn-open', () => {
    expect(isInjectMessage({ ...connOpen, contentType: null })).toBe(true);
  });

  it('accepts capture-installed, which carries no connection', () => {
    expect(isInjectMessage(captureInstalled)).toBe(true);
    expect(isInjectMessage({ ...captureInstalled, tMs: 0 })).toBe(true);
  });

  it('accepts messages that survived a structured clone', () => {
    for (const message of [connOpen, frames, connClose, binary, captureInstalled]) {
      expect(isInjectMessage(structuredClone(message))).toBe(true);
    }
  });

  it('narrows the type so the relay can switch on kind', () => {
    const value: unknown = frames;
    if (!isInjectMessage(value)) throw new Error('expected a valid message');
    const kinds: string[] = [];
    if (value.kind === 'frames') {
      const list: WireFrame[] = value.frames;
      kinds.push(...list.map((f) => f.kind));
    }
    expect(kinds).toEqual(['event', 'keepalive']);
  });
});

describe('isInjectMessage — rejects anything else', () => {
  it('rejects non-objects', () => {
    for (const value of [null, undefined, 0, 1, '', 'agui-dt', true, Symbol('x'), () => 0]) {
      expect(isInjectMessage(value)).toBe(false);
    }
  });

  it('rejects arrays', () => {
    expect(isInjectMessage([])).toBe(false);
    expect(isInjectMessage([connOpen])).toBe(false);
  });

  it('rejects a foreign or missing source tag', () => {
    expect(isInjectMessage({ ...connOpen, source: 'other-tool' })).toBe(false);
    expect(isInjectMessage({ ...connOpen, source: undefined })).toBe(false);
    expect(isInjectMessage(without(connOpen, 'source'))).toBe(false);
  });

  it('rejects a foreign protocol version', () => {
    expect(isInjectMessage({ ...connOpen, v: 2 })).toBe(false);
    expect(isInjectMessage({ ...connOpen, v: '1' })).toBe(false);
  });

  it('rejects an unknown or missing kind', () => {
    expect(isInjectMessage({ ...connOpen, kind: 'conn-reopen' })).toBe(false);
    expect(isInjectMessage({ source: AGUI_DT_SOURCE, v: 1, connId: 'c1' })).toBe(false);
  });

  it('rejects a missing or empty connId', () => {
    expect(isInjectMessage({ ...connOpen, connId: '' })).toBe(false);
    expect(isInjectMessage({ ...connOpen, connId: 7 })).toBe(false);
    expect(isInjectMessage(without(connOpen, 'connId'))).toBe(false);
  });

  it('rejects non-finite timestamps', () => {
    expect(isInjectMessage({ ...connOpen, tMs: Number.NaN })).toBe(false);
    expect(isInjectMessage({ ...connOpen, tMs: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isInjectMessage({ ...connOpen, tMs: '12' })).toBe(false);
  });

  it('rejects conn-open without an input key', () => {
    expect(isInjectMessage(without(connOpen, 'input'))).toBe(false);
  });

  it('rejects conn-open with a non-string method or url', () => {
    expect(isInjectMessage({ ...connOpen, method: 7 })).toBe(false);
    expect(isInjectMessage({ ...connOpen, url: null })).toBe(false);
  });

  it('rejects frames that are not an array', () => {
    expect(isInjectMessage({ ...frames, frames: '[]' })).toBe(false);
    expect(isInjectMessage({ ...frames, frames: { 0: frames.kind } })).toBe(false);
  });

  it('rejects a batch containing one malformed frame', () => {
    const bad: unknown[] = [
      { kind: 'event', tMs: 1, raw: 1 },
      { kind: 'event', tMs: 'soon', raw: 'x' },
      { kind: 'keepalive', tMs: 1, raw: ':x\n\n' },
      { kind: 'chunk', tMs: 1, raw: 'x' },
      null,
      'data: x',
    ];
    for (const frame of bad) {
      expect(isInjectMessage({ ...frames, frames: [goodFrame, frame] })).toBe(false);
    }
  });

  it('rejects an unknown close reason', () => {
    expect(isInjectMessage({ ...connClose, reason: 'timeout' })).toBe(false);
    expect(isInjectMessage({ ...connClose, reason: undefined })).toBe(false);
  });

  /*
   * The new arm gets NO exemption. It is the one message a page has an incentive to forge —
   * forging it makes the panel claim capture is live on a document that has no hooks in it,
   * which is precisely the false-success state this whole message exists to abolish.
   */
  it('rejects a capture-installed that is not exactly the contract', () => {
    expect(isInjectMessage({ ...captureInstalled, source: 'agui-dt-evil' })).toBe(false);
    expect(isInjectMessage({ ...captureInstalled, v: 2 })).toBe(false);
    expect(isInjectMessage({ ...captureInstalled, v: '1' })).toBe(false);
    expect(isInjectMessage(without(captureInstalled, 'tMs'))).toBe(false);
    expect(isInjectMessage({ ...captureInstalled, tMs: Number.NaN })).toBe(false);
    expect(isInjectMessage({ ...captureInstalled, tMs: '0' })).toBe(false);
    expect(isInjectMessage({ ...captureInstalled, kind: 'capture-installed ' })).toBe(false);
  });

  it('rejects a capture-installed whose fields live on the prototype', () => {
    const hostile = Object.create({ tMs: 1 }) as Record<string, unknown>;
    hostile.source = AGUI_DT_SOURCE;
    hostile.v = PROTOCOL_VERSION;
    hostile.kind = 'capture-installed';
    expect(isInjectMessage(hostile)).toBe(false);
  });

  it('rejects binary without a byte count or content type', () => {
    expect(isInjectMessage({ ...binary, bytes: -1 })).toBe(false);
    expect(isInjectMessage({ ...binary, bytes: Number.NaN })).toBe(false);
    expect(isInjectMessage({ ...binary, contentType: null })).toBe(false);
  });
});

describe('isInjectMessage — hostile input from the page', () => {
  it('returns false instead of throwing when a getter throws', () => {
    const hostile = {
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-open',
      connId: 'c1',
      get tMs(): number {
        throw new Error('boom');
      },
    };
    expect(() => isInjectMessage(hostile)).not.toThrow();
    expect(isInjectMessage(hostile)).toBe(false);
  });

  it('returns false instead of throwing for a Proxy with hostile traps', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('boom');
        },
        has(): never {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor(): never {
          throw new Error('boom');
        },
      },
    );
    expect(isInjectMessage(hostile)).toBe(false);
  });

  it('returns false instead of throwing when frames.every is poisoned', () => {
    const hostileFrames = Object.assign([], {
      every(): never {
        throw new Error('boom');
      },
    });
    expect(isInjectMessage({ ...frames, frames: hostileFrames })).toBe(false);
  });

  it('handles a null-prototype message body', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, connOpen);
    expect(isInjectMessage(bare)).toBe(true);
  });

  it('rejects a message whose fields are carried on the prototype', () => {
    const proto = {
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-close',
      reason: 'complete',
      tMs: 1,
    };
    const inherited = Object.create(proto) as Record<string, unknown>;
    inherited.connId = 'c1';
    // Own-property-strict by design: `structuredClone` flattens the prototype chain, so a real
    // postMessage never delivers this shape, and a page that manufactures one is doing so
    // deliberately. The guard is a security boundary, so it takes the strict reading.
    expect(isInjectMessage(inherited)).toBe(false);
  });

  it('rejects a lookalike that inherits only the source tag', () => {
    const tagged = Object.create({ source: AGUI_DT_SOURCE }) as Record<string, unknown>;
    Object.assign(tagged, without(connOpen, 'source'));
    expect(isInjectMessage(tagged)).toBe(false);
  });

  it('is not fooled by Object.prototype pollution', () => {
    const polluted: Record<string, unknown> = { ...connOpen };
    delete polluted.method;
    const objectProto = Object.prototype as unknown as Record<string, unknown>;
    objectProto.method = 'POST';
    try {
      expect(isInjectMessage(polluted)).toBe(false);
    } finally {
      delete objectProto.method;
    }
  });
});
