import { describe, expect, it } from 'vitest';
import { cloneRuntimeInfo, isRuntimeInfo, parseInfoBody, type RuntimeInfo } from './info';

/**
 * The response measured live against the AG-UI Dojo at
 * `GET /api/copilotkitnext/builtin/info`, verbatim. Every parser assertion below is anchored to
 * it rather than to a shape invented here, because the point of this module is to read what a
 * real runtime actually sends.
 */
const DOJO_INFO = {
  version: '1.52.1-next.1',
  agents: {
    a2ui_chat: { name: 'a2ui_chat', description: '', className: 'BuiltInAgent' },
    default: { name: 'default', description: '', className: 'BuiltInAgent' },
  },
  audioFileTranscriptionEnabled: false,
};

describe('parseInfoBody', () => {
  it('reads the measured Dojo response, keys and all', () => {
    expect(parseInfoBody(DOJO_INFO, 'multi-route')).toEqual({
      version: '1.52.1-next.1',
      mode: 'multi-route',
      agents: [
        { id: 'a2ui_chat', name: 'a2ui_chat', description: '' },
        { id: 'default', name: 'default', description: '' },
      ],
    });
  });

  it('records the mode it was told, because the body does not carry one', () => {
    // The SAME body arrives over both transports. Requirements §4 asks for the runtime mode, and
    // the only place it exists is the request that fetched this.
    expect(parseInfoBody(DOJO_INFO, 'single-route')?.mode).toBe('single-route');
  });

  it('keeps unknown fields out of the typed claim', () => {
    const info = parseInfoBody(DOJO_INFO, 'multi-route');
    // `className` and `audioFileTranscriptionEnabled` are real fields of a real response and this
    // panel makes no claim about either. They are read and discarded, not smuggled through.
    expect(JSON.stringify(info)).not.toContain('className');
    expect(JSON.stringify(info)).not.toContain('audioFileTranscription');
  });

  it('reports an absent version as unreported rather than guessing one', () => {
    const info = parseInfoBody({ agents: { a: { name: 'a' } } }, 'multi-route');
    expect(info?.version).toBeNull();
  });

  it('refuses to coerce a non-string version', () => {
    // A number is not a version string. Reporting `52` as a version would be repair.
    expect(parseInfoBody({ version: 52, agents: {} }, 'multi-route')?.version).toBeNull();
  });

  it('distinguishes an absent description from an empty one', () => {
    const info = parseInfoBody(
      { version: '1', agents: { blank: { description: '' }, silent: { name: 'silent' } } },
      'multi-route',
    );
    expect(info?.agents).toEqual([
      { id: 'blank', name: null, description: '' },
      { id: 'silent', name: 'silent', description: null },
    ]);
  });

  it('keeps an agent whose entry is not an object, because the key is the id', () => {
    // The key is what the client addresses. Dropping the agent would under-report the list;
    // inventing a name for it would be repair. Both fields are reported as unknown.
    expect(parseInfoBody({ version: '1', agents: { odd: 'nonsense' } }, 'multi-route')?.agents)
      .toEqual([{ id: 'odd', name: null, description: null }]);
  });

  it('separates "no agents registered" from "no readable agent list"', () => {
    expect(parseInfoBody({ version: '1', agents: {} }, 'multi-route')?.agents).toEqual([]);
    // An array is not the map the runtime sends. Reporting it as `[]` would say the runtime has
    // no agents, which this response never claimed.
    expect(parseInfoBody({ version: '1', agents: [] }, 'multi-route')?.agents).toBeNull();
    expect(parseInfoBody({ version: '1' }, 'multi-route')?.agents).toBeNull();
  });

  it('is not an info response when it carries neither a version nor an agent map', () => {
    // Some other JSON came back from a URL matching the route grammar. Claiming it would put an
    // empty Runtime row on screen for a request that told us nothing.
    expect(parseInfoBody({ ok: true }, 'multi-route')).toBeNull();
    expect(parseInfoBody({}, 'multi-route')).toBeNull();
  });

  it('rejects anything that is not a plain object', () => {
    for (const body of [null, undefined, 'info', 42, true, [DOJO_INFO]]) {
      expect(parseInfoBody(body, 'multi-route')).toBeNull();
    }
  });

  it('ignores an agents map inherited from a prototype', () => {
    // Own-property strict throughout: a value reaching this parser has crossed the page boundary.
    const hostile = Object.create({ agents: { ghost: { name: 'ghost' } } }) as object;
    Object.defineProperty(hostile, 'version', { value: '1', enumerable: true });
    expect(parseInfoBody(hostile, 'multi-route')?.agents).toBeNull();
  });
});

describe('isRuntimeInfo', () => {
  const valid: RuntimeInfo = {
    version: '1.52.1-next.1',
    mode: 'multi-route',
    agents: [{ id: 'default', name: 'default', description: '' }],
  };

  it('accepts what the parser produces, in both modes and with a null agent list', () => {
    expect(isRuntimeInfo(valid)).toBe(true);
    expect(isRuntimeInfo({ ...valid, mode: 'single-route' })).toBe(true);
    expect(isRuntimeInfo({ ...valid, version: null, agents: null })).toBe(true);
    expect(isRuntimeInfo({ ...valid, agents: [] })).toBe(true);
  });

  it('rejects a missing or unknown mode', () => {
    expect(isRuntimeInfo({ version: null, agents: null })).toBe(false);
    expect(isRuntimeInfo({ ...valid, mode: 'sideways' })).toBe(false);
  });

  it('rejects a missing field rather than defaulting it', () => {
    expect(isRuntimeInfo({ mode: 'multi-route', agents: null })).toBe(false);
    expect(isRuntimeInfo({ version: null, mode: 'multi-route' })).toBe(false);
  });

  it('rejects an agent that is missing a field or has the wrong type', () => {
    expect(isRuntimeInfo({ ...valid, agents: [{ id: 'a', name: null }] })).toBe(false);
    expect(isRuntimeInfo({ ...valid, agents: [{ id: 1, name: null, description: null }] })).toBe(
      false,
    );
    expect(isRuntimeInfo({ ...valid, agents: [{ id: 'a', name: 7, description: null }] })).toBe(
      false,
    );
    expect(isRuntimeInfo({ ...valid, agents: ['default'] })).toBe(false);
  });

  it('rejects fields carried on a prototype rather than owned', () => {
    const hostile = Object.create(valid) as unknown;
    expect(isRuntimeInfo(hostile)).toBe(false);
  });

  it('cannot be made to throw by a hostile getter', () => {
    // A throw here would take down the relay's message listener, which is the whole reason the
    // guard runs inside a `try`.
    const hostile = {
      get version(): string {
        throw new Error('boom');
      },
      mode: 'multi-route',
      agents: null,
    };
    expect(isRuntimeInfo(hostile)).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'info', 3, [], true]) {
      expect(isRuntimeInfo(value)).toBe(false);
    }
  });
});

describe('cloneRuntimeInfo', () => {
  it('copies known fields only, so nothing rides along', () => {
    const smuggled = {
      version: '1',
      mode: 'multi-route',
      agents: [{ id: 'a', name: null, description: null, payload: 'extra' }],
      extra: 'also extra',
    } as unknown as RuntimeInfo;

    const copy = cloneRuntimeInfo(smuggled);
    expect(copy).toEqual({
      version: '1',
      mode: 'multi-route',
      agents: [{ id: 'a', name: null, description: null }],
    });
    expect(JSON.stringify(copy)).not.toContain('extra');
  });

  it('does not alias the agent array or its entries', () => {
    const original: RuntimeInfo = {
      version: '1',
      mode: 'single-route',
      agents: [{ id: 'a', name: 'a', description: '' }],
    };
    const copy = cloneRuntimeInfo(original);
    expect(copy.agents).not.toBe(original.agents);
    expect(copy.agents?.[0]).not.toBe(original.agents?.[0]);
  });

  it('keeps a null agent list null rather than turning it into an empty one', () => {
    expect(cloneRuntimeInfo({ version: null, mode: 'multi-route', agents: null }).agents).toBeNull();
  });
});
