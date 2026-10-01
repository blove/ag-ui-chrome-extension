import { describe, expect, it } from 'vitest';

import { THREADPLANE_DEVTOOLS_EVENT, type ThreadplaneDevtoolsReport } from '../core/signals/report';
import { AGUI_DT_SOURCE, isInjectMessage, PROTOCOL_VERSION, type InjectMessage } from './protocol';
import { installSignalsListener, type SignalsTarget } from './signals-listener';

const REPORT: ThreadplaneDevtoolsReport = {
  v: 1,
  agent: 'agent-1',
  adapter: 'ag-ui',
  seq: 3,
  eventType: 'TEXT_MESSAGE_CONTENT',
  wrote: ['messages'],
  tMs: 812.25,
};

/** A target that records what was registered on it, so the listener can be called directly. */
function fakeTarget(): SignalsTarget & { registered: Array<[string, (event: Event) => void]> } {
  const registered: Array<[string, (event: Event) => void]> = [];
  return {
    registered,
    addEventListener(type: string, listener: (event: Event) => void): void {
      registered.push([type, listener]);
    },
  };
}

function install(): {
  posted: InjectMessage[];
  dispatch: (event: Event) => void;
  target: ReturnType<typeof fakeTarget>;
} {
  const target = fakeTarget();
  const posted: InjectMessage[] = [];
  installSignalsListener(target, (message) => posted.push(message));
  const listener = target.registered[0]?.[1];
  if (listener === undefined) throw new Error('no listener was registered');
  return { posted, dispatch: listener, target };
}

function hook(detail: unknown): Event {
  return new CustomEvent(THREADPLANE_DEVTOOLS_EVENT, { detail });
}

describe('installSignalsListener', () => {
  it('listens for the hook event and nothing else', () => {
    const { target } = install();
    // One registration, for one name: the validator never runs on another event's detail.
    expect(target.registered.map(([type]) => type)).toEqual(['threadplane:devtools']);
  });

  it('posts nothing until the page dispatches a report', () => {
    const { posted } = install();
    expect(posted).toEqual([]);
  });

  it('posts a valid report as a signals message the relay guard accepts', () => {
    const { posted, dispatch } = install();
    dispatch(hook(REPORT));
    expect(posted).toEqual([
      { source: AGUI_DT_SOURCE, v: PROTOCOL_VERSION, kind: 'signals', report: REPORT },
    ]);
    expect(posted.every(isInjectMessage)).toBe(true);
  });

  it('posts a copy, never the page’s own object', () => {
    const { posted, dispatch } = install();
    const detail = { ...REPORT, wrote: [...REPORT.wrote] };
    dispatch(hook(detail));
    const message = posted[0];
    if (message?.kind !== 'signals') throw new Error('expected a signals message');
    expect(message.report).not.toBe(detail);
    expect(message.report.wrote).not.toBe(detail.wrote);
  });

  it('posts reports in the order the page dispatched them', () => {
    const { posted, dispatch } = install();
    for (const seq of [1, 2, 3]) dispatch(hook({ ...REPORT, seq }));
    expect(posted.map((message) => (message.kind === 'signals' ? message.report.seq : 0))).toEqual([
      1, 2, 3,
    ]);
  });

  it('drops anything that is not a valid report, silently', () => {
    const { posted, dispatch } = install();
    dispatch(new Event(THREADPLANE_DEVTOOLS_EVENT));
    dispatch(hook(null));
    dispatch(hook('messages'));
    dispatch(hook({ ...REPORT, extra: 'value' }));
    dispatch(hook({ ...REPORT, wrote: ['password'] }));
    dispatch(hook({ ...REPORT, adapter: 'langgraph', wrote: ['state'] }));
    dispatch(hook({ ...REPORT, eventType: 'x'.repeat(129) }));
    expect(posted).toEqual([]);
  });

  it('never throws into the page’s dispatch, whatever the detail does', () => {
    const { posted, dispatch } = install();
    const throwing = { ...REPORT };
    Object.defineProperty(throwing, 'wrote', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    const proxy = new Proxy(
      { ...REPORT },
      {
        ownKeys(): never {
          throw new Error('boom');
        },
        get(): never {
          throw new Error('boom');
        },
      },
    );
    const hostileEvent = new Event(THREADPLANE_DEVTOOLS_EVENT);
    Object.defineProperty(hostileEvent, 'detail', {
      get(): never {
        throw new Error('boom');
      },
    });
    expect(() => {
      dispatch(hook(throwing));
    }).not.toThrow();
    expect(() => {
      dispatch(hook(proxy));
    }).not.toThrow();
    expect(() => {
      dispatch(hostileEvent);
    }).not.toThrow();
    expect(posted).toEqual([]);
  });

  it('never throws into the page’s dispatch when posting fails', () => {
    const target = fakeTarget();
    installSignalsListener(target, () => {
      throw new Error('postMessage replaced by the page');
    });
    const listener = target.registered[0]?.[1];
    expect(() => listener?.(hook(REPORT))).not.toThrow();
  });

  it('cannot be made to post a value that changed between the check and the copy', () => {
    // A getter can answer one thing to the validator and another to the copy. The copy is what is
    // posted, so the copy is what is re-checked.
    const { posted, dispatch } = install();
    let reads = 0;
    const shifty = { ...REPORT };
    Object.defineProperty(shifty, 'agent', {
      enumerable: true,
      get(): string {
        reads += 1;
        return reads === 1 ? 'agent-1' : 'x'.repeat(1000);
      },
    });
    dispatch(hook(shifty));
    expect(posted).toEqual([]);
  });

  it('works on a real window: the page’s own listeners still run, and the report is posted', () => {
    const target = new EventTarget();
    const posted: InjectMessage[] = [];
    installSignalsListener(target, (message) => posted.push(message));
    const pageSaw: unknown[] = [];
    target.addEventListener(THREADPLANE_DEVTOOLS_EVENT, (event) => {
      pageSaw.push((event as CustomEvent<unknown>).detail);
    });
    target.dispatchEvent(hook(REPORT));
    expect(pageSaw).toEqual([REPORT]);
    expect(posted).toHaveLength(1);
  });
});
