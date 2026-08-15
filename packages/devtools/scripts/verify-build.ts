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
 * IT ALSO CHECKS SELF-CONTAINMENT, for a second defect of the same family. CRXJS's default for a
 * content script that has imports is an async LOADER which `await import(...)`s the real chunk,
 * with that chunk listed in `web_accessible_resources` scoped to the script's declared matches.
 * A MAIN-world content script runs in the PAGE's world, so on a runtime-granted non-localhost
 * origin (decision D3) the import resolved to a `chrome-extension:` URL the page had no access
 * to and Chrome denied it — the user granted the origin, the worker registered the scripts, and
 * capture silently never started. Nothing looking at sources, at the manifest, or at WHICH code
 * is in a chunk could see it, and the e2e could not either: it all runs on localhost, where the
 * WAR matches. So the shape of the emitted content scripts is asserted here, in the one place
 * that reads the built artefact. See `packages/harness/e2e/non-localhost.spec.ts` for the
 * runtime half of the same guard.
 *
 * Run against a real `dist/`: `pnpm build && pnpm verify:build`.
 */
import { createHash } from 'node:crypto';
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
 *
 * Two specifier shapes, because CRXJS emits two. A content-script loader that runs in the MAIN
 * world imports its chunk with a plain relative specifier (`"./inject.ts-hash.js"`), resolved
 * against the loader's own directory. One that runs in the ISOLATED world has `chrome.runtime`
 * available and uses `chrome.runtime.getURL("assets/relay.ts-hash.js")` instead — an
 * extension-root path with no `./`, which the relative pattern does not match. Missing the
 * second shape would silently reduce this guard to "the loader exists", which is exactly the
 * class of blind spot the whole script was written to close.
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
    // `chrome.runtime.getURL("assets/…")` — resolved from the extension root, i.e. `dist/`.
    const extensionUrls = text.matchAll(/getURL\(\s*["']([^"']+\.js)["']\s*\)/g);
    for (const match of extensionUrls) {
      const specifier = match[1];
      if (specifier !== undefined) {
        queue.push(posix.normalize(specifier));
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

/**
 * Assert that a content script is ONE self-contained file that runs synchronously.
 *
 * Two independent probes, because they fail on different halves of the loader shape and either
 * one alone would leave a gap:
 *
 *  - `bundle.files` longer than one means the script reaches code in another file. Under a
 *    loader that is the loader plus the chunk plus the chunk's shared imports; under plain code
 *    splitting it is the shared chunk on its own. Both are subject to
 *    `web_accessible_resources` from the MAIN world.
 *  - the two specifier forms CRXJS's loaders actually emit, matched in the text. A MAIN-world
 *    loader writes `await import("./<chunk>.js")`; an ISOLATED one has `chrome.runtime`
 *    available and writes `await import(chrome.runtime.getURL("assets/<chunk>.js"))`. The second
 *    form resolves to a file `readBundle` DOES follow, so it would be caught above too — but
 *    naming both here is what makes the failure message say "loader", which is the actual cause,
 *    rather than "extra file".
 *
 * Being one file is also what closes the document_start window: a loader installs the capture
 * patch a microtask late, and a stream opened by the page's first inline script is gone before
 * it exists.
 */
function checkSelfContained(role: string, emitted: string, files: string[]): void {
  if (files.length !== 1) {
    fail(
      `content script is not self-contained (${role})`,
      `dist/${emitted} reaches ${String(files.length)} files: ${files.join(', ')}. A content ` +
        `script must be ONE file with every import inlined. Anything it loads at runtime is ` +
        `fetched from the PAGE's world and is subject to web_accessible_resources, so on a ` +
        `runtime-granted non-localhost origin (decision D3) the load is denied and capture ` +
        `silently never starts. Keep the entry listed in \`contentScripts.standaloneFiles\` in ` +
        `vite.config.ts, and keep it free of exports — CRXJS emits a loader for any content ` +
        `script whose chunk has imports OR exports.`,
    );
  }

  const abs = join(distDir, emitted);
  if (!existsSync(abs)) {
    return;
  }
  const text = readFileSync(abs, 'utf8');
  const loaderForms: { pattern: RegExp; what: string }[] = [
    { pattern: /\bimport\s*\(/, what: 'a dynamic import()' },
    { pattern: /getURL\s*\(/, what: 'a chrome.runtime.getURL() lookup' },
  ];
  for (const { pattern, what } of loaderForms) {
    if (pattern.test(text)) {
      fail(
        `content script is loader-wrapped (${role})`,
        `dist/${emitted} contains ${what}. That is the CRXJS loader shape: the content script ` +
          `is a shim that fetches its real chunk at runtime. From the MAIN world that fetch is ` +
          `governed by web_accessible_resources and fails on any origin outside the declared ` +
          `matches, with no error the extension can see.`,
      );
    }
  }
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
  /**
   * Extra source modules the entry statically imports, which also count towards the
   * "is this token still in the source?" staleness check.
   *
   * A required token has to live in the source somewhere, or the assertion against the bundle
   * is a tautology. It does not have to live in the entry file itself: a string constant that
   * an entry imports is just as much a rename-detector, and pinning it to the file that owns it
   * is better than duplicating the literal to keep this script happy.
   */
  tokenSources?: string[];
  /** Emitted file named by `dist/manifest.json` for this entry. */
  emitted: string;
  /** Tokens that must appear in both the source and the emitted bundle. */
  required: string[];
  /** Tokens that must NOT appear in the emitted bundle. */
  forbidden: string[];
  /**
   * Assert the entry is one self-contained file. True for content scripts, which are injected
   * into a page and must not fetch anything; false for the service worker, which runs at the
   * extension's own origin where code splitting is free.
   */
  selfContained?: boolean;
}

function checkEntry(expectation: EntryExpectation): void {
  const {
    role,
    sourceFile,
    tokenSources = [],
    emitted,
    required,
    forbidden,
    selfContained = false,
  } = expectation;

  const sourceAbs = join(packageRoot, sourceFile);
  if (!existsSync(sourceAbs)) {
    fail(
      `entry source missing (${role})`,
      `manifest.config.ts declares ${sourceFile}, which does not exist.`,
    );
    return;
  }
  const searched = [sourceFile, ...tokenSources];
  const missingSource = searched.filter((file) => !existsSync(join(packageRoot, file)));
  if (missingSource.length > 0) {
    fail(
      `verify-build guard is stale (${role})`,
      `tokenSources names ${missingSource.join(', ')}, which does not exist. ` +
        `Point it at the module that now owns the marker.`,
    );
    return;
  }
  const sourceText = searched
    .map((file) => readFileSync(join(packageRoot, file), 'utf8'))
    .join('\n');
  for (const token of required) {
    if (!sourceText.includes(token)) {
      fail(
        `verify-build guard is stale (${role})`,
        `Expected marker ${JSON.stringify(token)} no longer appears in ${searched.join(' or ')}. ` +
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

  if (selfContained) {
    checkSelfContained(role, emitted, bundle.files);
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

// Independent from `SIZES` in `render-icons.mts` ON PURPOSE: this list is a statement of what
// the manifest owes, not a mirror of what the renderer happens to produce. Importing it would
// degrade the check into comparing the renderer to itself — a renderer that silently dropped a
// size, or a fifth size added to it and forgotten here, would both still pass.
const ICON_SIZES = ['16', '32', '48', '128'] as const;

/**
 * D8: icons are a Chrome Web Store submission requirement, not a load-unpacked one, so nothing
 * before this milestone caught their absence. The manifest can name them and the build can still
 * ship without them if `public/icons/` was not rendered — hence both halves are asserted.
 */
function checkIcons(manifest: Rec): void {
  const icons = asRecord(manifest.icons);
  if (icons === undefined) {
    fail(
      'manifest icons',
      'manifest has no "icons" block; the Chrome Web Store upload will be rejected. ' +
        'Add the `icons` block to manifest.config.ts.',
    );
    return;
  }
  for (const size of ICON_SIZES) {
    const path = asString(icons[size]);
    if (path === undefined) {
      fail(
        'manifest icons',
        `manifest declares no icon for size ${size}. Add ${size}: 'icons/icon-${size}.png' to ` +
          `the icons block in manifest.config.ts.`,
      );
      continue;
    }
    if (!existsSync(join(distDir, path))) {
      fail(
        'manifest icons',
        `manifest points icon ${size} at ${path}, which is not in dist/. Run ` +
          '`pnpm icons && pnpm build`.',
      );
    }
  }
}

/**
 * The icons are generated and committed, so they can go stale against `listing/icon.svg` with no
 * signal at all — `checkIcons` above only asserts the files exist in `dist/`, never that their
 * bytes still match the source that made them.
 *
 * This compares a SHA-256 of the source SVG, not rendered pixels. An earlier version of this
 * check re-rendered `icon.svg` to a scratch directory (`render-icons.mts` still supports that via
 * `ICON_OUT`, for manual use) and diffed the resulting PNGs against `public/icons/`. That is
 * WRONG for a check that has to pass identically everywhere: the PNGs are antialiased Chromium
 * output, and Chromium's rasterizer is not bit-identical across platforms or versions. The
 * committed icons were rendered on darwin/arm64; CI's `release` job runs on ubuntu x86_64 and, at
 * the time this was caught in review, had no Playwright install step at all — every tag push
 * would have failed `verify:build` on a missing browser, and even with one installed a rasterizer
 * difference could flip the check red on a PR that never touched `icon.svg`. A hash has neither
 * problem: it is deterministic on every machine and needs no browser, so `verify:build` stays
 * pure file inspection.
 *
 * The trade-off is real and deliberate: this no longer catches the PNGs drifting under a
 * Playwright/Chromium upgrade, only the source SVG changing without a re-render. That is the
 * right side to be wrong on — drifted antialiasing still produces a valid icon, whereas a stale
 * icon (edited SVG, un-regenerated PNGs) is a wrong one — but it is a real reduction in coverage,
 * so it is named here rather than left for the next reader to discover.
 *
 * `render-icons.mts` writes `public/icons/.source-sha256` alongside the PNGs on every run; this
 * is the one place that reads it back.
 */
function checkIconsAreFresh(): void {
  const iconsDir = join(packageRoot, 'public/icons');
  const hashPath = join(iconsDir, '.source-sha256');
  const currentHash = createHash('sha256')
    .update(readFileSync(join(packageRoot, 'listing/icon.svg'), 'utf8'), 'utf8')
    .digest('hex');

  if (!existsSync(hashPath)) {
    fail(
      'icon source hash missing',
      `public/icons/.source-sha256 does not exist. Run \`pnpm icons\` and commit the result.`,
    );
  } else {
    const committedHash = readFileSync(hashPath, 'utf8').trim();
    if (committedHash !== currentHash) {
      fail(
        'committed icons are stale',
        'public/icons/.source-sha256 does not match a fresh hash of listing/icon.svg — the SVG ' +
          'was edited without re-rendering. Run `pnpm icons` and commit the result.',
      );
    }
  }

  // Independent of the hash check above: a PNG deleted (rather than edited) from public/icons/
  // still has a matching, untouched .source-sha256 next to it, so the comparison above would
  // pass while the committed icon set is incomplete. checkIcons does not catch this either — it
  // reads dist/, which still holds whatever was built last, stale or not. This is the one check
  // that owns the committed source, so it has to be the one that notices it went missing.
  for (const size of ICON_SIZES) {
    const name = `icon-${size}.png`;
    if (!existsSync(join(iconsDir, name))) {
      fail(
        'committed icon missing',
        `public/icons/${name} does not exist. Run \`pnpm icons\` and commit the result.`,
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
  const viteConfigText = readFileSync(join(packageRoot, 'vite.config.ts'), 'utf8');

  const entryChunks: { role: string; file: string }[] = [];

  const worlds: {
    world: string;
    role: string;
    required: string[];
    tokenSources?: string[];
    forbidden: string[];
  }[] = [
    {
      world: 'MAIN',
      role: 'MAIN-world content script',
      // The presence marker. `checkEntry` requires every token to appear verbatim in the entry
      // SOURCE file as well as the bundle, so the capture layer cannot be asserted from here:
      // the inject entry reaches the message tag through the `AGUI_DT_SOURCE` identifier, and
      // identifiers do not survive minification. The literal is asserted on the relay entry,
      // whose own source contains it.
      required: ['__AGUI_DEVTOOLS__'],
      // `inject.ts` is a three-line call into `install.ts` and must stay export-free: rollup
      // gives an IIFE with exports a named global to hang them on, which would put a
      // `window.inject` on every page. The marker lives in the module it calls.
      tokenSources: ['src/inject/install.ts'],
      // MAIN world is the page's own world: chrome.* is undefined there.
      forbidden: ['chrome.runtime'],
    },
    {
      world: 'ISOLATED',
      role: 'ISOLATED-world relay content script',
      // The postMessage listener, the message tag it filters on, and the port name it
      // forwards over — enough that no other module's chunk could satisfy all three.
      required: ['addEventListener', 'message', 'agui-dt', 'agui-devtools-relay'],
      // Both literals moved into the protocol modules the relay imports when the relay stopped
      // being a stub; they are still exactly as rename-sensitive there.
      tokenSources: ['src/inject/protocol.ts', 'src/sw/protocol.ts'],
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
      tokenSources: spec.tokenSources,
      emitted,
      required: spec.required,
      forbidden: spec.forbidden,
      selfContained: true,
    });

    // Names the cause, one level up from the symptom. `checkSelfContained` reports that the
    // emitted script is loader-wrapped; this reports WHY, when the why is that vite.config.ts
    // and manifest.config.ts have drifted apart — renaming an entry in one and not the other
    // silently drops it back to CRXJS's loader default.
    if (!viteConfigText.includes(sourceFile)) {
      fail(
        `standalone content script not configured (${spec.world})`,
        `manifest.config.ts declares ${sourceFile} as a content script, but vite.config.ts does ` +
          `not mention it. It must be listed in \`crx({ contentScripts: { standaloneFiles } })\` ` +
          `or CRXJS emits it as an async loader plus a web-accessible chunk, which cannot load ` +
          `on a non-localhost origin.`,
      );
    }
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
      // The port hub (both port names, so a chunk carrying only the panel leg fails), the
      // session mirror's key prefix, and the harness's test hook. `__AGUI_DT_TEST__` is
      // asserted HERE because it is installed unconditionally and the e2e reads the ring
      // buffer through it: a build that dropped it would leave the whole capture suite
      // asserting empties against a working extension.
      required: ['onConnect', 'agui-devtools-panel', 'agui-devtools-relay', '__AGUI_DT_TEST__'],
      // The port names live in the protocol module the worker imports.
      tokenSources: ['src/sw/protocol.ts'],
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
  // gates the whole build.

  /**
   * NO `web_accessible_resources` AT ALL.
   *
   * This key used to be here, CRXJS-injected and scoped to the localhost matches, and was
   * accepted as expected. It was not: it was the shadow of the loader indirection, and the
   * reason capture could not start on a granted non-localhost origin. Self-contained content
   * scripts need nothing web-accessible, so the key's reappearance means either the loader is
   * back or something new is being exposed to pages — and every entry in it is a probe any page
   * can fetch to fingerprint the extension, which §11 does not accept.
   *
   * The rejected shortcut, recorded so it is not rediscovered: widening the matches to
   * `http://*` / `https://*` makes capture work and makes the extension detectable by every page
   * on the web. `use_dynamic_url: true` fixes the fingerprinting and keeps the loader's async
   * gap, in which a stream opened by a page's first inline script is invisible. Neither is
   * acceptable; not needing the key is.
   */
  if ('web_accessible_resources' in distManifest) {
    fail(
      'manifest privacy invariant',
      `web_accessible_resources is present: ${JSON.stringify(distManifest.web_accessible_resources)}. ` +
        'Content scripts are built as self-contained IIFEs and need no web-accessible chunk; ' +
        'anything listed here is fetchable by a page and fingerprints the extension (§11).',
    );
  }

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

  /* --- 3. Declared assets actually reached dist/ (panel HTML, icons) ------- */
  // panel.html is opened at runtime by chrome.devtools.panels.create, so no manifest key
  // points at it and nothing else would notice it going missing until the panel 404s. Icons are
  // the same shape of gap: not a privacy invariant, just a declared asset nothing but this
  // script and a human Chrome Web Store reviewer would ever notice missing.

  checkIcons(distManifest);
  checkIconsAreFresh();

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
