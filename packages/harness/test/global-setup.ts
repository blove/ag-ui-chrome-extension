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
import { buildPage } from '../page/build.js';

export default async function globalSetup(): Promise<void> {
  await buildPage();
}
