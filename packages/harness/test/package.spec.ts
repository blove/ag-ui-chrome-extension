import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

interface PackageManifest {
  name?: unknown;
  private?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
}

function readManifest(relativePath: string): PackageManifest {
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`not an object: ${relativePath}`);
  }
  return parsed as PackageManifest;
}

test('the harness is private and can never be published', () => {
  const manifest = readManifest('../package.json');
  expect(manifest.name).toBe('ag-ui-harness');
  expect(manifest.private).toBe(true);
});

test('every harness dependency is a devDependency', () => {
  const manifest = readManifest('../package.json');
  // H6: the shipped extension stays Preact-only. Nothing here may become a runtime dependency,
  // because a runtime dependency is the one kind that can reach a published bundle.
  expect(manifest.dependencies).toBeUndefined();

  const devDependencies = manifest.devDependencies;
  expect(typeof devDependencies).toBe('object');
  const names = Object.keys(devDependencies as Record<string, unknown>);
  expect(names).toContain('@copilotkit/aimock');
  expect(names).toContain('@playwright/test');
  expect(names).toContain('@ag-ui/client');
});

test('the root delegates to test:ci, which this package defines', () => {
  const manifest = readManifest('../package.json');
  const scripts = manifest.scripts;
  expect(typeof scripts).toBe('object');
  // `pnpm` special-cases `test` as a lifecycle script: `pnpm -r test` exits 0 for a package that
  // defines none, so a harness wired only to `test` would be silently skipped by CI. The root
  // runs `test:ci` for exactly that reason.
  expect((scripts as Record<string, unknown>)['test:ci']).toBe('playwright test');
});

test('the harness stays out of the extension package', () => {
  const devtools = readManifest('../../devtools/package.json');
  const runtime = Object.keys((devtools.dependencies ?? {}) as Record<string, unknown>);
  const dev = Object.keys((devtools.devDependencies ?? {}) as Record<string, unknown>);
  for (const forbidden of ['@copilotkit/aimock', '@playwright/test', '@ag-ui/client']) {
    expect(runtime).not.toContain(forbidden);
    expect(dev).not.toContain(forbidden);
  }
});
