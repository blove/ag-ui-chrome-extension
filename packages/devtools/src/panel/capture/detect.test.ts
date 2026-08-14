import { describe, expect, it, vi } from 'vitest';
import { observeNetwork } from './detect';

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
