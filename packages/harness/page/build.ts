/**
 * Bundles the page. `@ag-ui/client` is an npm package with real dependencies (rxjs, zod,
 * fast-json-patch), so "no build step" is not available if the page is to use the real
 * client — and using the real client is the entire justification for the page (H3).
 * esbuild, one call, no config file: the minimum that makes H3 possible.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const outDir = join(pageRoot, 'dist');

/**
 * Exported rather than run at import time so the Playwright `globalSetup` can call it
 * directly. `build:page` runs this module as a script, which the guard below handles.
 */
export async function buildPage(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await build({
    // Two entries, two pages. `copilotkit.ts` is a page of its own rather than a flag on
    // `main.ts` because `e2e/capture.spec.ts` asserts `main.ts` makes exactly one POST, and a
    // discovery request folded in there would silently rewrite that assertion.
    // `langgraph.ts` is separate for the same reason.
    entryPoints: [
      join(pageRoot, 'main.ts'),
      join(pageRoot, 'copilotkit.ts'),
      join(pageRoot, 'langgraph.ts'),
    ],
    bundle: true,
    format: 'esm',
    target: 'chrome111', // the manifest's `minimum_chrome_version`
    outdir: outDir,
    sourcemap: true,
    logLevel: 'warning',
  });
  copyFileSync(join(pageRoot, 'index.html'), join(outDir, 'index.html'));
  // The CopilotKit-shaped page: discovery before any run (spec §13 done-when #2).
  copyFileSync(join(pageRoot, 'copilotkit.html'), join(outDir, 'copilotkit.html'));
  // The LangGraph Platform page: a run on `/threads/:id/runs/stream` (spec §7, PR 4c).
  copyFileSync(join(pageRoot, 'langgraph.html'), join(outDir, 'langgraph.html'));
  // No bundle of its own: the point of this page is an INLINE script in `<head>`, which is the
  // earliest page code that can run after the document_start content scripts.
  copyFileSync(join(pageRoot, 'document-start.html'), join(outDir, 'document-start.html'));
  // Same reason, one notch earlier: this one does not wait for the marker either.
  copyFileSync(
    join(pageRoot, 'document-start-sync.html'),
    join(outDir, 'document-start-sync.html'),
  );
  // The opposite page: no bundle, no request, nothing to capture. What the extension must be
  // silent on — see `e2e/quiet-page.spec.ts`.
  copyFileSync(join(pageRoot, 'quiet.html'), join(outDir, 'quiet.html'));
  // An SSE stream that is not AG-UI, read to the end. Capture records it; the toolbar badge must
  // not light for it — see `e2e/badge.spec.ts`. Inline script, no bundle: a raw `fetch` is all
  // it needs.
  copyFileSync(join(pageRoot, 'plain-sse.html'), join(outDir, 'plain-sse.html'));
  // A stand-in Threadplane app in development: valid and hostile `threadplane:devtools` reports,
  // and a subframe that reports too — see `e2e/signals.spec.ts`. Inline script, no bundle.
  copyFileSync(join(pageRoot, 'signals.html'), join(outDir, 'signals.html'));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPage();
}
