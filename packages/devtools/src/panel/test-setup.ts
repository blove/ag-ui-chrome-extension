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
 * the detect-then-offer path (P5) from a component test at all, and the one branch that flips
 * the capture banner from "nothing detected" to an offer would go untested.
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

interface ChromeStub {
  runtime: { getManifest: () => { version: string } };
  devtools: {
    network: { onRequestFinished: FakeRequestEvent };
    inspectedWindow: {
      tabId: number;
      /**
       * Accepts the callback `App` passes but never invokes it, so the inspected origin stays
       * unresolved and `capture` stays `unsupported` — which is the honest default for a test
       * that has no inspected page. A test that wants an origin sets `capture` on the store.
       */
      eval: (expression: string, callback?: (result: unknown) => void) => void;
    };
  };
}

const chromeStub: ChromeStub = {
  runtime: { getManifest: () => ({ version: '0.1.0' }) },
  devtools: {
    network: { onRequestFinished: createRequestEvent() },
    inspectedWindow: { tabId: 1, eval: () => {} },
  },
};

// `@types/chrome` types the global as the full API surface. The stub is deliberately a subset —
// widening it to the real type would mean stubbing hundreds of members no test touches — so the
// assignment goes through `unknown` rather than `any` (`no-explicit-any` is on).
(globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

afterEach(() => {
  cleanup();
});
