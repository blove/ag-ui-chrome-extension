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
    entryPoints: [join(pageRoot, 'main.ts')],
    bundle: true,
    format: 'esm',
    target: 'chrome111', // the manifest's `minimum_chrome_version`
    outfile: join(outDir, 'main.js'),
    sourcemap: true,
    logLevel: 'warning',
  });
  copyFileSync(join(pageRoot, 'index.html'), join(outDir, 'index.html'));
  // No bundle of its own: the point of this page is an INLINE script in `<head>`, which is the
  // earliest page code that can run after the document_start content scripts.
  copyFileSync(join(pageRoot, 'document-start.html'), join(outDir, 'document-start.html'));
  // Same reason, one notch earlier: this one does not wait for the marker either.
  copyFileSync(
    join(pageRoot, 'document-start-sync.html'),
    join(outDir, 'document-start-sync.html'),
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPage();
}
