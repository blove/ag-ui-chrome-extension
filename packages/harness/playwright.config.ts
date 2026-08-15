import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // Every test in this package binds a real TCP port and drives a real stream. Serialising them
  // keeps port pressure and timing measurements honest — `keepalive-gap` asserts on wall-clock
  // arrival times, which parallel workers on a loaded machine would distort.
  fullyParallel: false,
  workers: 1,
  // `keepalive-gap` sleeps 15.5 s on the wire on purpose. The 30 s default would leave almost no
  // headroom on a slow machine.
  timeout: 60_000,
  reporter: 'list',
});
