/**
 * Assert that `dist/` is a correct, shippable build — not merely a build that exited 0.
 *
 * WHY THIS EXISTS. Task 17 shipped a `dist/` in which the MAIN-world content script pointed at
 * the SERVICE WORKER's chunk. CRXJS 2.7.1 keys emitted scripts by `basename(file)`, and
 * `src/inject/index.ts` and `src/sw/index.ts` shared the basename `index.ts`, so the second
 * entry overwrote the first in CRXJS's map. The build exited 0 and every scripted gate we had —
 * typecheck, lint, unit tests, the `core/` boundary greps, the manifest privacy audit — passed
 * on the broken artifact, because all of them look at sources or at the manifest, never at
 * WHICH CODE landed in the chunk the manifest points to. The only symptom was a `TypeError` at
 * `document_start` on every page (`chrome.runtime` is undefined in MAIN world) and a marker that
 * never installed, visible only to a human loading the extension in Chrome.
 *
 * So this script checks the one thing nothing else checked: that each entry point's emitted
 * chunk contains the code that entry point is supposed to contain. It resolves chunks THROUGH
 * `dist/manifest.json` — never by hardcoded filename, since content hashes change every build —
 * and it takes the expected source files from `manifest.config.ts`, so renaming an entry file
 * cannot silently move the guard's goalposts.
 *
 * Run against a real `dist/`: `pnpm build && pnpm verify:build`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifestConfig from '../manifest.config';

const packageRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir: string = join(packageRoot, 'dist');

const failures: string[] = [];

/** Record a failed invariant. Every check runs; the process exits non-zero at the end. */
function fail(invariant: string, detail: string): void {
  failures.push(`${invariant}\n    ${detail.replace(/\n/g, '\n    ')}`);
}

/* -------------------------------------------------------------------------- */
/* Small unknown-narrowing helpers — both manifests are untyped JSON at rest.  */
/* -------------------------------------------------------------------------- */

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Every file under `dist/`, as paths relative to `dist/` with forward slashes. */
function listDistFiles(dir: string = distDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDistFiles(join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Read an emitted entry chunk plus everything it statically imports, concatenated.
 *
 * Vite splits shared code into separate chunks, so a token that lives in the entry source can
 * legitimately end up one hop away. Following relative `.js` specifiers keeps the assertions
 * honest under code splitting instead of brittle. The service worker in particular is reached
 * through `service-worker-loader.js`, which is nothing but an import of the real chunk.
 */
function readBundle(entryRelative: string): { text: string; files: string[] } | undefined {
  const seen = new Set<string>();
  const queue: string[] = [entryRelative];
  const parts: string[] = [];
  const files: string[] = [];

  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    const abs = join(distDir, rel);
    if (!existsSync(abs)) {
      return undefined;
    }
    const text = readFileSync(abs, 'utf8');
    parts.push(text);
    files.push(rel);
    // Relative `.js` specifiers only: bare specifiers cannot appear in a browser bundle.
    const specifiers = text.matchAll(/["'](\.{1,2}\/[^"']*\.js)["']/g);
    for (const match of specifiers) {
      const specifier = match[1];
      if (specifier !== undefined) {
        queue.push(posix.normalize(posix.join(posix.dirname(rel), specifier)));
      }
    }
  }

  return { text: parts.join('\n'), files };
}

/**
 * The real chunk behind an entry, seeing through a loader shim.
 *
 * CRXJS registers the service worker as `service-worker-loader.js`, a file whose entire body is
 * `import './assets/<chunk>.js';`. Comparing the manifest strings alone would therefore never
 * notice the worker's chunk being shared with a content script. Resolving through the shim makes
 * the "entry chunks must be distinct" check see the same files the browser will.
 */
function resolveEntryChunk(rel: string): string {
  const abs = join(distDir, rel);
  if (!existsSync(abs)) {
    return rel;
  }
  const text = readFileSync(abs, 'utf8');
  const withoutImports = text.replace(/import\s*["'][^"']*["'];?/g, '').replace(/\s+/g, '');
  if (withoutImports !== '') {
    return rel;
  }
  const first = /["'](\.{1,2}\/[^"']*\.js)["']/.exec(text)?.[1];
  return first === undefined ? rel : posix.normalize(posix.join(posix.dirname(rel), first));
}

/* -------------------------------------------------------------------------- */
/* 1. Entry-point identity: does each chunk contain the code it should?        */
/* -------------------------------------------------------------------------- */

/**
 * Distinctive strings taken from the entry sources, not from a build. Each token is asserted to
 * exist in the source file first, so a rename in the source fails LOUDLY here ("guard is
 * stale") instead of quietly weakening the build assertion into a tautology.
 */
interface EntryExpectation {
  /** Human name used in failure messages. */
  role: string;
  /** Source module this entry is declared with in `manifest.config.ts`. */
  sourceFile: string;
  /** Emitted file named by `dist/manifest.json` for this entry. */
  emitted: string;
  /** Tokens that must appear in both the source and the emitted bundle. */
  required: string[];
  /** Tokens that must NOT appear in the emitted bundle. */
  forbidden: string[];
}

function checkEntry(expectation: EntryExpectation): void {
  const { role, sourceFile, emitted, required, forbidden } = expectation;

  const sourceAbs = join(packageRoot, sourceFile);
  if (!existsSync(sourceAbs)) {
    fail(
      `entry source missing (${role})`,
      `manifest.config.ts declares ${sourceFile}, which does not exist.`,
    );
    return;
  }
  const sourceText = readFileSync(sourceAbs, 'utf8');
  for (const token of required) {
    if (!sourceText.includes(token)) {
      fail(
        `verify-build guard is stale (${role})`,
        `Expected marker ${JSON.stringify(token)} no longer appears in ${sourceFile}. ` +
          `The build assertion for this entry is now meaningless — update the expectation ` +
          `table in scripts/verify-build.ts to a string the current source actually contains.`,
      );
    }
  }

  const bundle = readBundle(emitted);
  if (bundle === undefined) {
    fail(
      `emitted chunk missing (${role})`,
      `dist/manifest.json points at ${emitted}, which is not in dist/ (or imports a chunk that is not).`,
    );
    return;
  }

  for (const token of required) {
    if (!bundle.text.includes(token)) {
      fail(
        `wrong code emitted for the ${role}`,
        `dist/${emitted} (with its imports: ${bundle.files.join(', ')}) does not contain ` +
          `${JSON.stringify(token)}, which ${sourceFile} does. The manifest entry is pointing ` +
          `at some OTHER module's chunk. The known cause is a basename collision between entry ` +
          `points — CRXJS keys emitted scripts by basename(file), so two entries named e.g. ` +
          `index.ts silently overwrite each other. Give every entry point a distinct basename.`,
      );
    }
  }

  for (const token of forbidden) {
    if (bundle.text.includes(token)) {
      fail(
        `forbidden reference in the ${role}`,
        `dist/${emitted} (with its imports: ${bundle.files.join(', ')}) references ` +
          `${JSON.stringify(token)}, which is not available where this chunk runs. ` +
          `A MAIN-world content script has no extension APIs: this throws at document_start ` +
          `on every matched page. The usual cause is a basename collision that put another ` +
          `entry point's code in this chunk.`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */

function main(): void {
  if (!existsSync(distDir)) {
    console.error(`FAIL: no build output at ${distDir}. Run \`pnpm build\` first.`);
    process.exit(1);
  }

  const distManifestPath = join(distDir, 'manifest.json');
  if (!existsSync(distManifestPath)) {
    console.error(`FAIL: ${distManifestPath} does not exist. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  const distManifest = asRecord(JSON.parse(readFileSync(distManifestPath, 'utf8')));
  const sourceManifest = asRecord(manifestConfig as unknown);
  if (distManifest === undefined || sourceManifest === undefined) {
    console.error('FAIL: dist/manifest.json or manifest.config.ts did not parse as an object.');
    process.exit(1);
  }

  /* --- Content scripts, paired by execution world ------------------------- */

  /** `world` defaults to ISOLATED when the key is absent (MV3 default). */
  function worldOf(entry: unknown): string {
    return asString(asRecord(entry)?.world) ?? 'ISOLATED';
  }

  function firstJs(entry: unknown): string | undefined {
    return asString(asArray(asRecord(entry)?.js)?.[0]);
  }

  const distScripts = asArray(distManifest.content_scripts) ?? [];
  const sourceScripts = asArray(sourceManifest.content_scripts) ?? [];

  const entryChunks: { role: string; file: string }[] = [];

  const worlds: { world: string; role: string; required: string[]; forbidden: string[] }[] = [
    {
      world: 'MAIN',
      role: 'MAIN-world content script',
      // The presence marker. `checkEntry` requires every token to appear verbatim in the entry
      // SOURCE file as well as the bundle, so the capture layer cannot be asserted from here:
      // inject.ts reaches the message tag through the `AGUI_DT_SOURCE` identifier, and
      // identifiers do not survive minification. The literal is asserted on the relay entry,
      // whose own source contains it.
      required: ['__AGUI_DEVTOOLS__'],
      // MAIN world is the page's own world: chrome.* is undefined there.
      forbidden: ['chrome.runtime'],
    },
    {
      world: 'ISOLATED',
      role: 'ISOLATED-world relay content script',
      // The postMessage listener and the message tag it filters on.
      required: ['addEventListener', 'message', 'agui-dt'],
      forbidden: [],
    },
  ];

  for (const spec of worlds) {
    const distMatches = distScripts.filter((entry) => worldOf(entry) === spec.world);
    const sourceMatches = sourceScripts.filter((entry) => worldOf(entry) === spec.world);
    if (distMatches.length !== 1 || sourceMatches.length !== 1) {
      fail(
        `content-script world registration (${spec.world})`,
        `expected exactly one ${spec.world}-world content script in each manifest; ` +
          `manifest.config.ts has ${String(sourceMatches.length)}, dist/manifest.json has ${String(distMatches.length)}.`,
      );
      continue;
    }
    const emitted = firstJs(distMatches[0]);
    const sourceFile = firstJs(sourceMatches[0]);
    if (emitted === undefined || sourceFile === undefined) {
      fail(
        `content-script js entry (${spec.world})`,
        'a content script has no js[0] string in one of the two manifests.',
      );
      continue;
    }
    entryChunks.push({ role: spec.role, file: resolveEntryChunk(emitted) });
    checkEntry({
      role: spec.role,
      sourceFile,
      emitted,
      required: spec.required,
      forbidden: spec.forbidden,
    });
  }

  /* --- Service worker ----------------------------------------------------- */

  const distWorker = asString(asRecord(distManifest.background)?.service_worker);
  const sourceWorker = asString(asRecord(sourceManifest.background)?.service_worker);
  if (distWorker === undefined || sourceWorker === undefined) {
    fail(
      'service worker registration',
      'background.service_worker is missing from dist/manifest.json or manifest.config.ts.',
    );
  } else {
    entryChunks.push({ role: 'service worker', file: resolveEntryChunk(distWorker) });
    checkEntry({
      role: 'service worker',
      sourceFile: sourceWorker,
      emitted: distWorker,
      // The port hub: the panel connects, the worker accepts. Nothing else in this build.
      required: ['onConnect', 'agui-devtools-panel'],
      forbidden: [],
    });
  }

  /* --- Entry chunks must be three distinct files -------------------------- */
  // The direct form of the Task 17 regression: a basename collision makes two manifest
  // entries resolve to the SAME emitted chunk.
  for (const [i, first] of entryChunks.entries()) {
    for (const second of entryChunks.slice(i + 1)) {
      if (first.file === second.file) {
        fail(
          'entry chunks collided',
          `the ${first.role} and the ${second.role} both resolve to ` +
            `dist/${first.file}. Entry points must not share a basename: CRXJS keys ` +
            `emitted scripts by basename(file), so one entry overwrites the other.`,
        );
      }
    }
  }

  /* --- 2. Manifest privacy invariants (requirements §11 / §12) ------------- */
  // Re-run here, against the same artifact these entry checks ran against, so one command
  // gates the whole build. `web_accessible_resources` is CRXJS-injected and correctly scoped
  // to the localhost matches — it is expected, and deliberately not flagged.

  const permissions = (asArray(distManifest.permissions) ?? []).map((p) => asString(p) ?? '');
  for (const banned of ['debugger', 'webRequest', 'webRequestBlocking']) {
    if (permissions.includes(banned)) {
      fail(
        'manifest privacy invariant',
        `"${banned}" permission present in dist/manifest.json (requirements §12 forbids it).`,
      );
    }
  }
  if ('host_permissions' in distManifest) {
    fail(
      'manifest privacy invariant',
      `static host_permissions present: ${JSON.stringify(distManifest.host_permissions)}. ` +
        'Remote origins are granted at runtime only (decision D3).',
    );
  }
  if (asArray(distManifest.optional_host_permissions) === undefined) {
    fail('manifest privacy invariant', 'optional_host_permissions is missing.');
  }

  const allowedMatches = ['http://localhost/*', 'http://127.0.0.1/*', 'http://0.0.0.0/*'];
  const matches = distScripts.flatMap(
    (entry) => (asArray(asRecord(entry)?.matches) ?? []).map((m) => asString(m) ?? ''),
  );
  if (matches.length === 0) {
    fail('manifest privacy invariant', 'no content_scripts matches declared.');
  }
  const stray = matches.filter((pattern) => !allowedMatches.includes(pattern));
  if (stray.length > 0) {
    fail(
      'manifest privacy invariant',
      `content-script matches beyond the localhost family: ${stray.join(', ')}. ` +
        'Non-localhost origins are registered at runtime after the user opts in (decision D3).',
    );
  }

  /* --- 3. Panel HTML actually reached dist/ -------------------------------- */
  // panel.html is opened at runtime by chrome.devtools.panels.create, so no manifest key
  // points at it and nothing else would notice it going missing until the panel 404s.

  for (const html of ['src/panel/panel.html', 'src/panel/devtools.html']) {
    if (!existsSync(join(distDir, html))) {
      fail('panel HTML missing', `dist/${html} was not emitted.`);
    }
  }
  const devtoolsPage = asString(distManifest.devtools_page);
  if (devtoolsPage === undefined || !existsSync(join(distDir, devtoolsPage))) {
    fail(
      'devtools_page missing',
      `dist/manifest.json devtools_page is ${JSON.stringify(devtoolsPage)}, which is not in dist/.`,
    );
  }

  /* --- 4. No sourcemaps in the shipped artifact ---------------------------- */

  const maps = listDistFiles().filter((file) => file.endsWith('.map'));
  if (maps.length > 0) {
    fail(
      'sourcemaps in dist/',
      `${maps.join(', ')} — build in production mode (vite.config.ts only emits sourcemaps ` +
        'when mode !== "production") so nothing ships the sources.',
    );
  }

  /* --- Report -------------------------------------------------------------- */

  if (failures.length > 0) {
    console.error(`FAIL: ${String(failures.length)} build invariant(s) violated in dist/:\n`);
    for (const failure of failures) {
      console.error(`  - ${failure}\n`);
    }
    process.exit(1);
  }

  console.log('build output invariants OK');
}

main();
