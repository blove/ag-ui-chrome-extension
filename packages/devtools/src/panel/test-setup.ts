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

interface ChromeStub {
  runtime: { getManifest: () => { version: string } };
  devtools: {
    network: {
      onRequestFinished: {
        addListener: (listener: (request: unknown) => void) => void;
        removeListener: (listener: (request: unknown) => void) => void;
      };
    };
    inspectedWindow: { tabId: number; eval: (expression: string) => void };
  };
}

const chromeStub: ChromeStub = {
  runtime: { getManifest: () => ({ version: '0.1.0' }) },
  devtools: {
    network: {
      onRequestFinished: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
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
