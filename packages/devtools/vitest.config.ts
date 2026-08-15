import { defineConfig } from 'vitest/config';

/**
 * Four projects, because the four parts of this package have incompatible environments.
 *
 * `core/` is deliberately Chrome-free and DOM-free (design §3 / D10, enforced by the
 * `no-restricted-globals` fence in eslint.config.js) and must keep running under plain `node` —
 * running it in jsdom would silently make `document` and `window` available and let the fence rot.
 * `panel/` renders Preact and needs a DOM, so it gets jsdom plus a setup file.
 * `capture/` is `inject/`, `relay/` and `sw/`: they patch DOM globals and talk to `chrome`, so
 * they need jsdom, but they must NOT get the panel's setup file — the relay is a security
 * boundary and each of its tests installs the exact `chrome` stub it wants to assert against.
 * `scripts/` is build- and listing-time tooling (see that project's own comment below) — plain
 * Node, no DOM, no `chrome`, so it belongs beside `core` rather than in either jsdom project.
 *
 * `test.projects` is the Vitest 4 API (`InlineConfig.projects?: TestProjectConfiguration[]`);
 * each entry is itself a config object with its own nested `test` block.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          // `src/test/` holds the cross-module integration + golden-fixture suite. It imports only
          // from core/ and is Node-only, so it belongs to this project despite living outside
          // `src/core/`; without the second glob its 5 tests would stop running entirely.
          include: ['src/core/**/*.test.ts', 'src/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'panel',
          environment: 'jsdom',
          include: ['src/panel/**/*.test.{ts,tsx}'],
          setupFiles: ['src/panel/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'capture',
          // jsdom implements none of `fetch`, `Response`, `ReadableStream` or `TextDecoder`, so
          // Vitest's jsdom environment leaves Node's versions in place on globalThis — which is
          // exactly what the fetch patch needs. Verified: all four are present, `Response.body`
          // is a real `ReadableStream`, and `tee()` behaves as it does in Chrome.
          environment: 'jsdom',
          include: ['src/{inject,relay,sw}/**/*.test.ts'],
        },
      },
      {
        test: {
          // Named for what it selects, like the other three — `include` covers every test under
          // `scripts/` (the listing generators plus `panel-harness.ts`, `verify-build.ts`, etc.),
          // not only the listing ones, so this project is not called `listing`.
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
