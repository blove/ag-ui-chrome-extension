import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the two halves of this package have incompatible environments.
 *
 * `core/` is deliberately Chrome-free and DOM-free (design §3 / D10, enforced by the
 * `no-restricted-globals` fence in eslint.config.js) and must keep running under plain `node` —
 * running it in jsdom would silently make `document` and `window` available and let the fence rot.
 * `panel/` renders Preact and needs a DOM, so it gets jsdom plus a setup file.
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
    ],
  },
});
