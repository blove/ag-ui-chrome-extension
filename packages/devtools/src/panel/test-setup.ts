/**
 * Vitest setup for the `panel` project.
 *
 * Two jobs. First, install a `chrome` stub: `src/panel/**` is outside the core lint fence and
 * legitimately reads `chrome.runtime` / `chrome.devtools`, which jsdom does not provide. Second,
 * unmount anything a test rendered — Testing Library appends each render to `document.body`, so
 * without `cleanup` the second test in a file queries a DOM still holding the first one's output.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

type RequestListener = (request: unknown) => void;

/**
 * The fake `chrome.devtools.network.onRequestFinished`.
 *
 * `emit` is not part of Chrome's API — it is the test's way in. `App` subscribes to this event
 * through `observeNetwork`, so without a way to fire the listeners there is no way to exercise
 * detection from a component test at all, and the branch that raises the capture banner's signal
 * to "an event stream was seen" (P11) would go untested.
 */
interface FakeRequestEvent {
  addListener: (listener: RequestListener) => void;
  removeListener: (listener: RequestListener) => void;
  emit: (request: unknown) => void;
}

function createRequestEvent(): FakeRequestEvent {
  const listeners = new Set<RequestListener>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    // Iterate a copy: `observeNetwork` removes its own listener from inside the callback.
    emit: (request) => {
      for (const listener of [...listeners]) listener(request);
    },
  };
}

/** The `onNavigated` half of the fake network API — preserve-log-on-navigate hangs off it. */
interface FakeNavigatedEvent {
  addListener: (listener: (url: string) => void) => void;
  removeListener: (listener: (url: string) => void) => void;
  emit: (url: string) => void;
}

function createNavigatedEvent(): FakeNavigatedEvent {
  const listeners = new Set<(url: string) => void>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    emit: (url) => {
      for (const listener of [...listeners]) listener(url);
    },
  };
}

interface ChromeStub {
  runtime: { getManifest: () => { version: string } };
  devtools: {
    network: { onRequestFinished: FakeRequestEvent; onNavigated: FakeNavigatedEvent };
    inspectedWindow: {
      tabId: number;
      /** Reloads the inspected page. A no-op here; tests that care spy on it. */
      reload: () => void;
      /**
       * Answers every expression with `undefined`.
       *
       * The callback must actually be invoked — `probePageMarkers` returns a promise that only
       * settles when it is, and a test that left it pending would leak an unresolved promise into
       * the next one. `undefined` is the honest answer for a test with no inspected page: the
       * origin stays unresolved, `capture` stays `unsupported`, and the marker probe resolves
       * null. A test that wants either sets `capture` on the store or replaces this function.
       */
      eval: (expression: string, callback?: (result: unknown) => void) => void;
    };
  };
}

const chromeStub: ChromeStub = {
  runtime: { getManifest: () => ({ version: '0.1.0' }) },
  devtools: {
    network: { onRequestFinished: createRequestEvent(), onNavigated: createNavigatedEvent() },
    inspectedWindow: {
      tabId: 1,
      reload: () => {},
      eval: (_expression, callback) => {
        callback?.(undefined);
      },
    },
  },
};

/*
 * `chrome.runtime.connect` and `chrome.permissions` are DELIBERATELY absent from the default
 * stub.
 *
 * Both are guarded on the panel side — `connectToServiceWorker` returns null without a
 * `connect`, and `requestOriginGrant` returns `unavailable` without `permissions` — and those
 * are the branches every test that is not about live capture must take. A default stub would
 * silently open a port in all 347 existing panel tests. A test that wants either installs its
 * own; `src/panel/capture/live-capture.test.tsx` does exactly that.
 */

// `@types/chrome` types the global as the full API surface. The stub is deliberately a subset —
// widening it to the real type would mean stubbing hundreds of members no test touches — so the
// assignment goes through `unknown` rather than `any` (`no-explicit-any` is on).
(globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

afterEach(() => {
  cleanup();
});
