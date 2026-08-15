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
  fullyParallel: false,
  workers: 1,
  // `keepalive-gap` sleeps 15.5 s on the wire on purpose. The 30 s default would leave almost no
  // headroom on a slow machine.
  timeout: 60_000,
  reporter: 'list',
});
