/**
 * Builds every artefact the suite drives, before any spec runs.
 *
 * The alternative — documenting `pnpm --filter ag-ui-harness build:page` as a precondition and
 * failing loudly when it was skipped — makes `pnpm test` from a clean checkout red for a reason
 * that has nothing to do with the code under test. Building here is ~0.9 s and removes the
 * whole class of "stale build" confusion: a spec that says capture saw nothing then means
 * capture saw nothing, not that it read last week's `dist`.
 *
 * `page/serve.ts` and `e2e/fixtures.ts` still check for their outputs and fail with the command
 * to run. That is the second line of defence, for anyone driving those modules directly.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPage } from '../page/build.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default async function globalSetup(): Promise<void> {
  await buildPage();
  // The extension the e2e loads, rebuilt from source every run. Measured at ~0.9 s, which is
  // cheap next to a Chromium launch and buys the guarantee that `dist/` is the code in this
  // working tree — the one thing an e2e asserting "capture saw nothing" cannot afford to be
  // wrong about.
  execFileSync('pnpm', ['--filter', 'ag-ui-devtools', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
