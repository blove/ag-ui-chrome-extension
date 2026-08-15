import { defineConfig } from '@playwright/test';

export default defineConfig({
  // `.` rather than `./test`: the page and e2e suites live next to the code they cover
  // (`page/*.test.ts`, `e2e/*.spec.ts`), which is where a reader looks for them. Playwright
  // skips `node_modules` itself; `page/dist` is excluded because it holds emitted bundles.
  testDir: '.',
  testIgnore: ['node_modules/**', 'page/dist/**'],
  // Builds the artefacts under test — `page/dist` and the extension's `dist` — before any
  // spec runs, so a stale or missing build can never be mistaken for a capture failure.
  globalSetup: './test/global-setup.ts',
  // Every test in this package binds a real TCP port and drives a real stream. Serialising them
  // keeps port pressure and timing measurements honest — `keepalive-gap` asserts on wall-clock
  // arrival times, which parallel workers on a loaded machine would distort. The e2e adds a
  // second reason: parallel files would race for the extension profile directory and multiply
  // Chromium launches for no benefit.
  //
  // The same argument crosses the package boundary, which is why the root `test` script pins
  // `--workspace-concurrency=1`. `pnpm -r run test:ci` used to start this suite and the devtools
  // Vitest suite AT THE SAME TIME — there is no dependency edge between the two packages — so the
  // one gate in this repo that measures a real browser did its measuring while 1346 unit tests
  // had every core. Measured under exactly that overlap: the extension's service worker took
  // 3 s, 14 s, 19 s, 29 s and once over 52 s to be handed messages the page had already posted,
  // and the `beforeAll` of `e2e/capture.spec.ts` blew its 60 s budget outright. A browser gate
  // starved by its own repo's unit tests is measuring the machine, not the code.
  fullyParallel: false,
  workers: 1,
  // `keepalive-gap` sleeps 15.5 s on the wire on purpose. The 30 s default would leave almost no
  // headroom on a slow machine.
  timeout: 60_000,
  reporter: 'list',
});
