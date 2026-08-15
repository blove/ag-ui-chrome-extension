/**
 * Build the Chrome Web Store upload archive from `dist/`.
 *
 * Dependency choice: this shells out to the platform `zip` CLI instead of adding `archiver`
 * as a devDependency, because the whole script is forty lines, `zip` is preinstalled on
 * macOS, on Debian/Ubuntu, and on GitHub's `ubuntu-latest` runner image, and this repo's
 * posture (design doc §1 D9) is to add zero packages for a chore this small — the one cost,
 * a missing `zip` on bare Windows, is handled with an explicit error below.
 *
 * The version is read from package.json at run time, so the archive name tracks the manifest
 * version automatically and never has to be edited here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name: string;
  version: string;
}

const packageRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir: string = join(packageRoot, 'dist');

function readManifest(): PackageManifest {
  const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as Partial<PackageManifest>;
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('packages/devtools/package.json needs a string "name" and "version".');
  }
  return { name: parsed.name, version: parsed.version };
}

function assertZipAvailable(): void {
  const probe = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(
      'The `zip` CLI is required to build the extension archive and was not found on PATH.\n' +
        '  macOS: preinstalled — check your PATH.\n' +
        '  Debian/Ubuntu: sudo apt-get install -y zip\n' +
        '  Windows: run this from WSL or Git Bash.\n' +
        'Then re-run `pnpm package`.',
    );
  }
}

function main(): void {
  if (!existsSync(distDir)) {
    throw new Error(`No build output at ${distDir}. Run \`pnpm build\` first.`);
  }
  assertZipAvailable();

  const { name, version } = readManifest();
  const zipPath = join(packageRoot, `${name}-${version}.zip`);
  // `zip` updates an existing archive in place rather than replacing it, which would leave
  // files from a previous build inside. Start clean.
  rmSync(zipPath, { force: true });

  // -r recurse, -q quiet, -X drop platform extra-attribute blocks so the archive is stable
  // across machines. cwd is dist/ and the target is '.', so manifest.json lands at the zip
  // root — Chrome rejects an archive with the manifest nested in a directory.
  //
  // `-x '*.map'` is belt and braces: `vite build` defaults to production mode and
  // vite.config.ts only emits sourcemaps when mode !== 'production', so dist/ should not
  // contain any. `pnpm verify:build` asserts that independently; this exclusion means a
  // stray map from a hand-run dev build can never reach the store archive either.
  //
  // The other two are build metadata Vite copies out of `public/` alongside the icons
  // themselves: `icons/README.md` tells contributors how to regenerate them, and
  // `icons/.source-sha256` is the freshness hash `verify-build.ts` compares against. Both were
  // reaching the uploaded archive. Neither is code, and an extension review is not the place to
  // explain why a store package contains a note to contributors.
  const excludes = ['*.map', 'icons/README.md', 'icons/.source-sha256'];
  const result = spawnSync('zip', ['-r', '-q', '-X', zipPath, '.', '-x', ...excludes], {
    cwd: distDir,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`zip exited with status ${String(result.status)}`);
  }

  console.log(`Packaged ${zipPath}`);
}

main();
