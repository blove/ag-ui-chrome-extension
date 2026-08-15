import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeNetwork, probeFramework } from './detect';

type Listener = (request: chrome.devtools.network.Request) => void;

interface FakeEvent {
  addListener: (fn: Listener) => void;
  removeListener: (fn: Listener) => void;
  emit: (request: chrome.devtools.network.Request) => void;
  count: () => number;
}

function installNetwork(): FakeEvent {
  const listeners = new Set<Listener>();
  const event: FakeEvent = {
    addListener: (fn) => void listeners.add(fn),
    removeListener: (fn) => void listeners.delete(fn),
    emit: (request) => {
      for (const fn of [...listeners]) fn(request);
    },
    count: () => listeners.size,
  };
  Object.defineProperty(globalThis, 'chrome', {
    value: { devtools: { network: { onRequestFinished: event } } },
    writable: true,
    configurable: true,
  });
  return event;
}

function requestWith(mimeType: string, headerValue?: string): chrome.devtools.network.Request {
  return {
    response: {
      content: { mimeType, size: 0 },
      headers: headerValue === undefined ? [] : [{ name: 'Content-Type', value: headerValue }],
    },
  } as unknown as chrome.devtools.network.Request;
}

describe('observeNetwork', () => {
  it('reports a text/event-stream response by mime type', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('text/event-stream'));
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('reports one found only in the content-type header', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('', 'text/event-stream; charset=utf-8'));
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('ignores every other content type', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('application/json'));
    event.emit(requestWith('text/html', 'text/html'));
    expect(onDetected).not.toHaveBeenCalled();
  });

  it('fires at most once and detaches itself', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    observeNetwork(onDetected);
    event.emit(requestWith('text/event-stream'));
    event.emit(requestWith('text/event-stream'));
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(event.count()).toBe(0);
  });

  it('unsubscribes, and unsubscribing twice is harmless', () => {
    const event = installNetwork();
    const onDetected = vi.fn();
    const stop = observeNetwork(onDetected);
    expect(event.count()).toBe(1);
    stop();
    stop();
    expect(event.count()).toBe(0);
    event.emit(requestWith('text/event-stream'));
    expect(onDetected).not.toHaveBeenCalled();
  });

  it('returns a no-op unsubscribe when the DevTools network API is absent', () => {
    Object.defineProperty(globalThis, 'chrome', {
      value: {},
      writable: true,
      configurable: true,
    });
    const onDetected = vi.fn();
    expect(() => observeNetwork(onDetected)()).not.toThrow();
    expect(onDetected).not.toHaveBeenCalled();
  });
});

type EvalCallback = (result: unknown, exceptionInfo?: unknown) => void;

function installEval(fn: (expression: string, callback?: EvalCallback) => void): void {
  Object.defineProperty(globalThis, 'chrome', {
    value: { devtools: { inspectedWindow: { eval: fn } } },
    writable: true,
    configurable: true,
  });
}

/**
 * Install an `inspectedWindow.eval` that REALLY evaluates the expression, against this file's
 * jsdom document.
 *
 * The expression is the half of `probeFramework` that runs inside the inspected page, so a stub
 * handing back canned strings would exercise the parsing and leave the DOM read — the part that
 * has to find `ng-version` on a real page — completely untested. The JSON round trip stands in
 * for the real API's serialization boundary: whatever the page computes reaches the panel as
 * plain data.
 */
function installLiveEval(): void {
  installEval((expression, callback) => {
    const value: unknown = new Function(`return (${expression});`)();
    callback?.(JSON.parse(JSON.stringify(value ?? null)) as unknown);
  });
}

/** Install one that resolves with a fixed value, for the paths a real page cannot produce. */
function installCannedEval(result: unknown, exceptionInfo?: unknown): void {
  installEval((_expression, callback) => callback?.(result, exceptionInfo));
}

interface WeakMarkers {
  ng?: unknown;
  getAllAngularRootElements?: unknown;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
}

/**
 * `probeFramework` labels the session and nothing else.
 *
 * It is deliberately NOT an AG-UI signal. AG-UI is a wire protocol: it specifies nothing in the
 * DOM, so there is no pre-traffic markup that means "this app speaks AG-UI" — which is exactly
 * why requirements §4.1 chose content-based detection, so the tool works on a custom endpoint in
 * a framework nobody has heard of. Requirements §4.3 puts the framework fingerprint in its place:
 * it labels the session, never gates capture.
 */
describe('probeFramework', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    const weak = globalThis as WeakMarkers;
    delete weak.ng;
    delete weak.getAllAngularRootElements;
    delete weak.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('reads the Angular version off the ng-version attribute', async () => {
    installLiveEval();
    document.body.innerHTML = '<app-root ng-version="21.1.6"><div>hi</div></app-root>';

    await expect(probeFramework()).resolves.toBe('Angular 21.1.6');
  });

  /*
   * Design §4a, measured on a production Angular app: `window.ng` and
   * `getAllAngularRootElements` are stripped from production builds, and the React DevTools hook
   * was PRESENT — reporting from it would have labelled that app React. `ng-version` is the only
   * fingerprint that survived the measurement, so it is the only one read.
   */
  it('ignores the framework globals and the React hook, which measured unreliable', async () => {
    installLiveEval();
    const weak = globalThis as WeakMarkers;
    weak.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map() };
    weak.ng = { probe: () => undefined };
    weak.getAllAngularRootElements = () => [];
    document.body.innerHTML = '<div id="root"></div>';

    await expect(probeFramework()).resolves.toBeNull();
  });

  it('resolves null on a page carrying no fingerprint', async () => {
    installLiveEval();
    document.body.innerHTML = '<main><p>hello</p></main>';

    await expect(probeFramework()).resolves.toBeNull();
  });

  it('resolves null when the DevTools APIs are absent', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      value: {},
      writable: true,
      configurable: true,
    });

    await expect(probeFramework()).resolves.toBeNull();
  });

  it('resolves null when the page threw', async () => {
    installCannedEval(undefined, { isError: true, code: 'E_PROTOCOLERROR' });

    await expect(probeFramework()).resolves.toBeNull();
  });

  it('resolves null when the expression itself raised inside the page', async () => {
    installCannedEval(undefined, { isException: true, value: 'ReferenceError: document' });

    await expect(probeFramework()).resolves.toBeNull();
  });

  /*
   * The second callback argument is documented as "details IF an exception occurred", and DevTools
   * passes `undefined` when none did. Reading its mere PRESENCE as failure would therefore make
   * the whole probe silently dead if a Chrome release ever passed a cleared object instead — a
   * regression no test here could catch, because the stub would be the thing defining the
   * contract. The flags are what is checked.
   */
  it('accepts a result carrying a cleared exception object', async () => {
    installCannedEval('21.1.6', { isError: false });

    await expect(probeFramework()).resolves.toBe('Angular 21.1.6');
  });

  // The inspected page controls this string and is not trusted: the label goes on screen.
  it('ignores a forged attribute value that no real version could be', async () => {
    installCannedEval('x'.repeat(400));

    await expect(probeFramework()).resolves.toBeNull();
  });

  it('resolves null when the page answers with something that is not a string', async () => {
    installCannedEval({ ngVersion: '21.1.6' });

    await expect(probeFramework()).resolves.toBeNull();
  });
});
