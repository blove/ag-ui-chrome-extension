# Chrome Web Store Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate every Chrome Web Store listing asset — icons, five 1280×800 screenshots, promo tiles — from the real build, and hold the listing copy in a validated source-of-truth file.

**Architecture:** The existing visual gate `scripts/screenshot-panel.mts` already boots the built panel in real Chromium. Its static server, `chrome` shim, and panel helpers are extracted to `scripts/panel-harness.ts` so a new asset generator can reuse them without giving one script two opposite contracts (the gate fails the build; the generator writes files). All TypeScript lives in `scripts/` because that is what `tsconfig.json` includes; `listing/` holds only data and assets.

**Tech Stack:** TypeScript, Playwright (already a devDependency), Vitest, tsx, CRXJS/Vite.

**Design:** [`docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md`](../specs/2026-08-15-chrome-web-store-listing-design.md)

---

## Deviations from the design, and why

Three refinements found while mapping the code. Each is a smaller change than it sounds.

1. **`listing/` holds no TypeScript.** The design's tree put `build-demo.ts` under `listing/fixtures/`. But `packages/devtools/tsconfig.json` includes only `src`, `scripts`, `manifest.config.ts`, `vite.config.ts`, `vitest.config.ts`, and `vitest.config.ts`'s three projects include only `src/**`. A generator under `listing/` would be neither typechecked nor testable. All generators move to `scripts/`; `listing/` keeps `icon.svg`, `copy.md`, `frames/*.html`, `fixtures/demo.agui.jsonl`, and `out/`.
2. **Two generator scripts, not one.** Icons are *source* — they are written to `public/icons/` and Vite copies them into `dist/`, so they must be rendered **before** `pnpm build`. Screenshots read `dist/`, so they must run **after** it. One script cannot sit on both sides of the build. Hence `scripts/render-icons.mts` and `scripts/listing-assets.mts`.
3. **The icon's error tick is `#f28b82`, not `#b3261e`.** `--agui-severity-error`'s light-scheme value is a dark red, and dark red on `--agui-accent` blue is close to unreadable at 16px. `#f28b82` is the panel's own dark-scheme error token — same role, same palette, and it actually reads as red against the blue tile.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/devtools/scripts/panel-harness.ts` | Static server over a dist dir, the `chrome` shim, `openPanel`, `importFixture`. Shared by the gate and the generator. No assertions of its own. |
| `packages/devtools/scripts/render-icons.mts` | `listing/icon.svg` → `public/icons/icon-{16,32,48,128}.png`. Runs before the build. |
| `packages/devtools/scripts/build-demo-fixture.ts` | Exports `buildDemoFixture(): string`; CLI writes `listing/fixtures/demo.agui.jsonl`. |
| `packages/devtools/scripts/build-demo-fixture.test.ts` | Asserts the fixture decodes clean, has 2 runs and exactly 1 issue, and is byte-deterministic. |
| `packages/devtools/scripts/listing-assets.mts` | Drives the panel through the storyboard, composes captioned frames, writes `listing/out/*.png`. Runs after the build. |
| `packages/devtools/scripts/verify-listing-copy.ts` | Parses `listing/copy.md`, asserts every CWS limit and that each manifest permission has a justification. |
| `packages/devtools/scripts/verify-listing-copy.test.ts` | Unit tests for the parser and each failure mode. |
| `packages/devtools/listing/icon.svg` | The mark. Single source for every raster size. |
| `packages/devtools/listing/copy.md` | Store copy: YAML front matter + markdown detailed description. |
| `packages/devtools/listing/frames/screenshot.html` | 1280×800 caption frame wrapping a panel iframe. |
| `packages/devtools/listing/frames/tile.html` | 440×280 small promo tile. |
| `packages/devtools/listing/frames/marquee.html` | 1400×560 marquee. |
| `packages/devtools/listing/frames/frame.css` | Shared frame styling, deriving from the panel's palette tokens. |
| `packages/devtools/listing/fixtures/demo.agui.jsonl` | Generated, committed. |
| `packages/devtools/public/icons/icon-{16,32,48,128}.png` | Generated, committed. Ship in the bundle. |
| `packages/devtools/listing/out/*.png` | Generated, committed. The exact upload set. |

**Modified:**

| Path | Change |
|---|---|
| `packages/devtools/scripts/screenshot-panel.mts` | Delete the extracted helpers, import them from `panel-harness.ts`. No behaviour change. |
| `packages/devtools/manifest.config.ts` | Add the `icons` block. |
| `packages/devtools/scripts/verify-build.ts` | Assert the four icon PNGs exist in `dist/icons/` and the manifest points at them. |
| `packages/devtools/vitest.config.ts` | Add a fourth project, `scripts`, covering `scripts/**/*.test.ts`. |
| `packages/devtools/package.json` | Add `icons`, `listing:assets`, `listing:fixture`, `verify:listing` scripts. |
| `packages/devtools/public/icons/README.md` | Rewrite: the icons are now wired, and here is what regenerates them. |

---

## Task 1: Extract the shared panel harness

Pure refactor. No behaviour change, and the proof is that the gate still passes — including against a deliberately unstyled build via `PANEL_DIST`.

**Files:**
- Create: `packages/devtools/scripts/panel-harness.ts`
- Modify: `packages/devtools/scripts/screenshot-panel.mts`
- Modify: `packages/devtools/vitest.config.ts`

- [ ] **Step 1: Establish the baseline — the gate passes today**

```bash
cd packages/devtools && pnpm build && pnpm screenshot:panel
```

Expected: exits 0, prints `panel renders in both schemes:` and `panel issued no off-origin requests (requirements §11).`

If this fails before you change anything, stop and report — the refactor has no baseline.

- [ ] **Step 2: Create the harness**

Create `packages/devtools/scripts/panel-harness.ts`:

```ts
/**
 * The browser plumbing shared by every script that needs the built panel running.
 *
 * Extracted from `screenshot-panel.mts`, which is a GATE: its job is to fail the build. The
 * listing generator has the opposite contract — it always succeeds and writes files. Sharing the
 * plumbing keeps store screenshots showing the same real build the gate asserts on; keeping the
 * scripts separate keeps one file from having two contradictory jobs.
 *
 * Nothing here asserts anything. Assertions belong to the caller.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Browser, FrameLocator, Page } from 'playwright';

/** Where the panel document lives inside a built `dist/`. */
export const PANEL_PATH = 'src/panel/panel.html';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Enough of `chrome` for the panel bundle to boot outside DevTools. Deliberately minimal: the
 * point is to render the panel's own markup, not to simulate Chrome.
 *
 * `no-devtools` leaves `chrome.devtools` absent, so the detection and origin paths take their
 * documented no-DevTools branch and the capture banner reads "Live capture only runs inside the
 * DevTools panel." That is the shape the gate has always asserted against.
 */
export type ShimKind = 'no-devtools';

export const SHIMS: Record<ShimKind, string> = {
  'no-devtools': `
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: '0.0.0-harness' }) },
    };
  `,
};

export interface StaticServer {
  origin: string;
  close: () => Promise<void>;
}

/** Serve a directory over HTTP. ES modules will not load over `file://`. */
export function startServer(root: string): Promise<StaticServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      ready({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

export interface Session {
  page: Page;
  /** Errors the page logged or threw, in order. */
  errors: string[];
  /** Every URL the page requested, so requirements §11 (no egress) can be asserted. */
  requests: string[];
  close: () => Promise<void>;
}

export interface OpenPanelOptions {
  scheme?: 'light' | 'dark';
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  shim?: ShimKind;
  /** Load this URL instead of the panel itself — used to load a composing frame that iframes it. */
  url?: string;
}

/**
 * Defaults are the gate's historical values. Changing them changes what the gate photographs, so
 * they are stated here once rather than duplicated at each call site.
 */
export async function openPanel(
  browser: Browser,
  origin: string,
  options: OpenPanelOptions = {},
): Promise<Session> {
  const {
    scheme = 'light',
    viewport = { width: 1100, height: 760 },
    deviceScaleFactor = 2,
    shim = 'no-devtools',
    url = `${origin}/${PANEL_PATH}`,
  } = options;

  const context = await browser.newContext({ colorScheme: scheme, viewport, deviceScaleFactor });
  // Applies to every frame in the context, which is what makes an iframed panel boot too.
  await context.addInitScript(SHIMS[shim]);
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(url, { waitUntil: 'networkidle' });
  return { page, errors, requests, close: () => context.close() };
}

/**
 * Anything the panel can be driven through: the page itself, or a frame containing it.
 * Both expose `locator`, which is why the import path below is written against locators rather
 * than `page.setInputFiles`.
 */
export type PanelScope = Page | FrameLocator;

/** Import a capture through the panel's own file input, exactly as a user would. */
export async function importFixture(scope: PanelScope, file: string): Promise<void> {
  await scope.locator('input.agui-drop__input').setInputFiles(file);
  await scope
    .locator('.agui-timeline, .agui-app__load-error')
    .first()
    .waitFor({ state: 'attached', timeout: 5000 });
}
```

- [ ] **Step 3: Point the gate at the harness**

In `packages/devtools/scripts/screenshot-panel.mts`:

Delete the local `MIME` constant, `CHROME_SHIM`, `startServer`, `interface Session`, `openPanel`, and `importFixture`. Delete the now-unused imports of `createServer`, `createReadStream`, `extname`, `normalize`, and `type Page` if nothing else uses them (`Page` is still used by `seqsOf`; `Browser` is still used by the check functions).

Add, below the existing imports:

```ts
import { importFixture, openPanel, PANEL_PATH, startServer } from './panel-harness';
```

Replace the local `const panelPath = 'src/panel/panel.html';` with uses of the imported `PANEL_PATH`. Update the three `openPanel(browser, origin, scheme)` call sites to the options form:

```ts
const session = await openPanel(browser, origin, { scheme });
```

and in `checkUnreachableControls`:

```ts
const session = await openPanel(browser, origin, { scheme: 'light' });
```

Update the two `importFixture(session.page, …)` call sites — the signature is unchanged, a `Page` is a valid `PanelScope`.

- [ ] **Step 4: Verify the gate still passes, unchanged**

```bash
cd packages/devtools && pnpm typecheck && pnpm lint && pnpm build && pnpm screenshot:panel
```

Expected: exits 0 with the same output as Step 1. Any difference in what it prints is a refactor bug.

- [ ] **Step 5: Verify the gate still FAILS on an unstyled build**

The gate's own negative test. Build a copy of `dist/` with the panel stylesheet emptied, and point the gate at it.

```bash
cd packages/devtools
rm -rf /tmp/unstyled && cp -R dist /tmp/unstyled
find /tmp/unstyled -name '*.css' -exec sh -c ': > "$1"' _ {} \;
PANEL_DIST=/tmp/unstyled pnpm screenshot:panel; echo "exit=$?"
```

Expected: `exit=1`, with a failure mentioning `body has no background colour`. If it exits 0, the extraction broke the shim or the server and the gate is now blind.

- [ ] **Step 6: Add the `scripts` vitest project**

In `packages/devtools/vitest.config.ts`, add a fourth entry to `test.projects`, after the `capture` entry:

```ts
      {
        test: {
          // The listing generators live in `scripts/` because that is what tsconfig.json
          // includes; `listing/` holds only data and assets. They are plain Node — no DOM, no
          // `chrome` — so they belong beside `core` rather than in either jsdom project.
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
```

- [ ] **Step 7: Run the suite to confirm nothing regressed and the new project is empty-but-valid**

```bash
cd packages/devtools && pnpm test
```

Expected: all existing tests pass. The `scripts` project reports no test files, which is fine at this point.

- [ ] **Step 8: Commit**

```bash
git add packages/devtools/scripts/panel-harness.ts packages/devtools/scripts/screenshot-panel.mts packages/devtools/vitest.config.ts
git commit -m "refactor: extract the panel harness from the visual gate

The static server, chrome shim, and panel open/import helpers move to
scripts/panel-harness.ts so the listing asset generator can drive the same
real build the gate asserts on. The gate keeps its contract and its
assertions; verified by it still passing, and still failing against an
unstyled dist via PANEL_DIST.

importFixture is now written against locators rather than
page.setInputFiles, so it works on a panel inside an iframe.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The mark, and the icon raster pipeline

**Files:**
- Create: `packages/devtools/listing/icon.svg`
- Create: `packages/devtools/scripts/render-icons.mts`
- Create (generated): `packages/devtools/public/icons/icon-{16,32,48,128}.png`
- Modify: `packages/devtools/package.json`

- [ ] **Step 1: Author the mark**

Create `packages/devtools/listing/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="AG-UI DevTools">
  <!--
    An event stream on a wire, with one event flagged.

    Four ticks, not six: at 16px a tick is width/128*16 px wide, so six ticks render as ~1.2px
    bars separated by sub-pixel gaps and turn to mush. Four at width 15 render ~1.9px with ~1.1px
    gaps, which survives.

    The tile is filled rather than transparent because Chrome renders toolbar icons over both
    light and dark chrome, and a bare glyph disappears in one of them.

    Colours are the panel's own tokens: agui-accent, and agui-severity-error's DARK-scheme
    value for the flagged tick. The light-scheme error red (#b3261e) is near-unreadable on this
    blue at 16px. (Those token names are written without their leading double hyphen on purpose:
    XML forbids `--` anywhere inside a comment body, and Chrome responds by silently refusing to
    parse the whole SVG — which still rasterises to a PNG of exactly the right dimensions, so
    `file` reports success on a broken-image placeholder.)

    Every tick shares the baseline y=100 (y + height === 100).
  -->
  <rect width="128" height="128" rx="28" fill="#1a73e8"/>
  <g fill="#ffffff">
    <rect x="20" y="60" width="15" height="40" rx="7.5"/>
    <rect x="44" y="36" width="15" height="64" rx="7.5"/>
    <rect x="92" y="52" width="15" height="48" rx="7.5"/>
  </g>
  <rect x="68" y="16" width="15" height="84" rx="7.5" fill="#f28b82"/>
</svg>
```

- [ ] **Step 2: Write the renderer**

Create `packages/devtools/scripts/render-icons.mts`:

```ts
/**
 * `listing/icon.svg` → `public/icons/icon-{16,32,48,128}.png`.
 *
 * These are SOURCE, not build output: Vite copies `public/` into `dist/` verbatim, so the icons
 * must exist before `pnpm build` runs. That is why this is a separate script from
 * `listing-assets.mts`, which reads `dist/` and therefore must run after it.
 *
 * `icon-128.png` doubles as the Chrome Web Store store icon; nothing separate is emitted for it.
 *
 * Run: `pnpm icons`
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(packageRoot, 'listing/icon.svg');
const outDir = join(packageRoot, 'public/icons');

/** Manifest icon sizes. 128 is also the CWS store icon. */
const SIZES = [16, 32, 48, 128] as const;

async function main(): Promise<void> {
  const svg = readFileSync(svgPath, 'utf8');
  // Data URL rather than a file:// navigation: the SVG carries fixed width/height attributes, so
  // it must be scaled by the <img> box rather than by the viewport.
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<body style="margin:0">` +
          `<img src="${dataUrl}" style="display:block;width:100vw;height:100vh">` +
          `</body>`,
      );
      await page.locator('img').waitFor({ state: 'visible' });
      // omitBackground preserves the tile's rounded corners as transparency.
      const png = await page.screenshot({ omitBackground: true });
      writeFileSync(join(outDir, `icon-${String(size)}.png`), png);
      await page.close();
      console.log(`  icon-${String(size)}.png`);
    }
  } finally {
    await browser.close();
  }
  console.log(`icons written to ${outDir}`);
}

await main();
```

- [ ] **Step 3: Add the script entry**

In `packages/devtools/package.json`, add to `scripts`, after `"gen:events"`:

```json
    "icons": "tsx scripts/render-icons.mts",
```

- [ ] **Step 4: Render, and confirm the sizes are exact**

```bash
cd packages/devtools && pnpm icons && file public/icons/icon-*.png
```

Expected: four lines reading `PNG image data, 16 x 16`, `32 x 32`, `48 x 48`, `128 x 128`.

- [ ] **Step 5: Look at the 16px render**

Open `public/icons/icon-16.png`. Expected: a blue rounded square with four distinguishable vertical bars, one of them salmon-red and tallest. If the bars have merged into a solid block, widen the gaps in `icon.svg` and re-run Step 4 before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/devtools/listing/icon.svg packages/devtools/scripts/render-icons.mts packages/devtools/public/icons/icon-16.png packages/devtools/public/icons/icon-32.png packages/devtools/public/icons/icon-48.png packages/devtools/public/icons/icon-128.png packages/devtools/package.json
git commit -m "feat(listing): the mark, and the icon raster pipeline

One SVG source renders to every manifest size plus the CWS store icon.
Four ticks rather than six because six turn to mush at 16px, and a filled
tile rather than a transparent glyph because toolbar chrome is both light
and dark.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Wire the icons into the manifest

Closes the blocker `public/icons/README.md` has been carrying.

**Files:**
- Modify: `packages/devtools/manifest.config.ts`
- Modify: `packages/devtools/scripts/verify-build.ts`
- Modify: `packages/devtools/public/icons/README.md`

- [ ] **Step 1: Write the failing assertion in verify-build**

Read `packages/devtools/scripts/verify-build.ts` first to match its existing failure-reporting style (it collects failures and reports them together, like the visual gate).

Add a check that runs alongside the existing manifest assertions:

```ts
/**
 * D8: icons are a Chrome Web Store submission requirement, not a load-unpacked one, so nothing
 * before this milestone caught their absence. The manifest can name them and the build can still
 * ship without them if `public/icons/` was not rendered — hence both halves are asserted.
 */
const ICON_SIZES = ['16', '32', '48', '128'] as const;

function checkIcons(manifest: Record<string, unknown>, distDir: string): void {
  const icons = manifest.icons;
  if (typeof icons !== 'object' || icons === null) {
    fail('manifest has no "icons" block; the Chrome Web Store upload will be rejected.');
    return;
  }
  const declared = icons as Record<string, unknown>;
  for (const size of ICON_SIZES) {
    const path = declared[size];
    if (typeof path !== 'string') {
      fail(`manifest declares no icon for size ${size}.`);
      continue;
    }
    if (!existsSync(join(distDir, path))) {
      fail(`manifest points icon ${size} at ${path}, which is not in dist/. Run \`pnpm icons\`.`);
    }
  }
}
```

Call `checkIcons(manifest, distDir)` from the same place the other manifest checks are invoked, using whatever names that file already binds for the parsed manifest and the dist directory.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/devtools && pnpm build && pnpm verify:build; echo "exit=$?"
```

Expected: `exit=1`, with `manifest has no "icons" block`.

- [ ] **Step 3: Add the icons block**

In `packages/devtools/manifest.config.ts`, add to the `defineManifest` object, after `minimum_chrome_version`:

```ts
  // Paths are relative to dist/, and `public/` is copied there verbatim by Vite — so
  // `public/icons/icon-16.png` is addressed as `icons/icon-16.png`. Rendered by `pnpm icons`
  // from listing/icon.svg; `verify-build.ts` fails if any of the four is missing from dist/.
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd packages/devtools && pnpm build && pnpm verify:build; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 5: Confirm the icons actually landed in dist**

```bash
cd packages/devtools && ls dist/icons && node -e "console.log(JSON.stringify(require('./dist/manifest.json').icons))"
```

Expected: four PNGs listed, and `{"16":"icons/icon-16.png","32":"icons/icon-32.png","48":"icons/icon-48.png","128":"icons/icon-128.png"}`.

- [ ] **Step 6: Rewrite the icons README**

Replace `packages/devtools/public/icons/README.md` with:

```markdown
# Extension icons

**Generated. Do not edit these PNGs by hand.**

    pnpm icons        # listing/icon.svg -> icon-{16,32,48,128}.png

Vite copies everything under `public/` into `dist/` verbatim, so these land at `dist/icons/*` and
are referenced from `manifest.config.ts` as `icons/<file>`. They are committed because they ship
in the bundle, and `scripts/verify-build.ts` fails the build if any of the four is missing from
`dist/` or unreferenced by the manifest.

`icon-128.png` doubles as the Chrome Web Store store icon.

The mark itself is designed in
[`docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md`](../../../../docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md) §3.
```

- [ ] **Step 7: Commit**

```bash
git add packages/devtools/manifest.config.ts packages/devtools/scripts/verify-build.ts packages/devtools/public/icons/README.md
git commit -m "feat(listing): wire the icons into the manifest

verify-build now fails when the icons block is missing or points at a file
that is not in dist/, so a bundle can no longer be built into a state the
Chrome Web Store would reject.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The demo fixture

**Files:**
- Create: `packages/devtools/scripts/build-demo-fixture.ts`
- Create: `packages/devtools/scripts/build-demo-fixture.test.ts`
- Create (generated): `packages/devtools/listing/fixtures/demo.agui.jsonl`
- Modify: `packages/devtools/package.json`

Background: the `.agui.jsonl` format is one JSON object per line — a `header` line, one `request` line per connection, then `event` lines. See `packages/devtools/src/test/fixtures/happy-run.agui.jsonl` for a worked example and `src/core/jsonl/codec.ts` for the types.

- [ ] **Step 1: Write the failing test**

Create `packages/devtools/scripts/build-demo-fixture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadJsonl } from '../src/panel/import/load-jsonl';
import { buildDemoFixture } from './build-demo-fixture';

describe('buildDemoFixture', () => {
  it('decodes without a single malformed line', () => {
    const { decodeErrors } = loadJsonl(buildDemoFixture());
    expect(decodeErrors).toEqual([]);
  });

  it('contains two runs, so the run scope bar has something to show', () => {
    const { runs } = loadJsonl(buildDemoFixture());
    expect(runs).toHaveLength(2);
  });

  it('carries exactly one protocol violation, and it is the one we meant', () => {
    const { issues } = loadJsonl(buildDemoFixture());
    expect(issues.map((i) => i.code)).toEqual(['unopened-message-id']);
  });

  it('anchors that violation to the delta that arrives before its message opens', () => {
    const { issues, records } = loadJsonl(buildDemoFixture());
    const issue = issues[0];
    expect(issue).toBeDefined();
    const record = records.find((r) => r.kind === 'event' && r.seq === issue?.seq);
    expect(record).toBeDefined();
    expect((record as { event?: { type?: string } }).event?.type).toBe('TEXT_MESSAGE_CONTENT');
  });

  it('is byte-deterministic, so the committed fixture is diffable', () => {
    expect(buildDemoFixture()).toBe(buildDemoFixture());
  });

  it('carries nothing that looks like a redaction placeholder or a secret', () => {
    const text = buildDemoFixture();
    expect(text).not.toMatch(/«redacted/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text.toLowerCase()).not.toMatch(/authorization|api[_-]?key|bearer /);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/devtools && pnpm vitest run --project scripts scripts/build-demo-fixture.test.ts
```

Expected: FAIL — `Failed to resolve import "./build-demo-fixture"`.

- [ ] **Step 3: Write the generator**

Create `packages/devtools/scripts/build-demo-fixture.ts`:

```ts
/**
 * The capture the Chrome Web Store screenshots are shot against.
 *
 * Why not an existing fixture: `happy-run.agui.jsonl` is 15 events and `malformed.agui.jsonl` is
 * a validator unit test. Neither reads as a product. Why not a Tier B recording: `record.ts`
 * redacts every payload string, so a recorded capture photographs as «redacted: N chars».
 *
 * The content is fictional and deliberately dull — an order lookup. No real product names, no
 * credentials, nothing that would need redacting.
 *
 * Exactly ONE validator issue, by construction: run 2 emits a TEXT_MESSAGE_CONTENT for a message
 * that has not been opened yet, which is `unopened-message-id`. Every other rule is deliberately
 * satisfied — steps balance, state deltas follow a snapshot and target paths that exist, tool
 * args concatenate to valid JSON, TOOL_CALL_END precedes TOOL_CALL_RESULT, no two text messages
 * are open at once, and every run has a request line carrying its input.
 *
 * Run: `pnpm listing:fixture`
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJsonl, type JsonlLine } from '../src/core/jsonl/codec';

const THREAD = 't_demo';

function header(): JsonlLine {
  return {
    kind: 'header',
    schemaVersion: 1,
    tool: 'ag-ui-devtools@0.1.0',
    // Fixed, never `new Date()`: the fixture must be byte-identical on every regeneration.
    capturedAt: '2026-08-15T09:00:00.000Z',
    url: 'http://localhost:3000/',
    framework: 'react/copilotkit',
    transport: 'sse',
    redacted: [],
  };
}

function request(connId: string, runId: string, prompt: string): JsonlLine {
  return {
    kind: 'request',
    connId,
    tMs: 0,
    method: 'POST',
    url: '/api/copilotkit/agent/support/run',
    input: {
      threadId: THREAD,
      runId,
      state: { order: null, steps: 0 },
      messages: [{ id: `m_user_${runId}`, role: 'user', content: prompt }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
  };
}

/** `seq` is global across the capture; `tMs` is per connection. */
function events(connId: string, from: number, list: Array<[number, unknown]>): JsonlLine[] {
  return list.map(([tMs, event], i) => ({
    kind: 'event',
    connId,
    seq: from + i,
    tMs,
    event: event as Record<string, unknown>,
  })) as JsonlLine[];
}

function runOne(): JsonlLine[] {
  const runId = 'r_demo_1';
  return events('c1', 1, [
    [12, { type: 'RUN_STARTED', threadId: THREAD, runId }],
    [28, { type: 'STEP_STARTED', stepName: 'plan' }],
    [44, { type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' }],
    [96, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Let me look up' }],
    [128, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: ' order 4417' }],
    [161, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: ' for you.' }],
    [180, { type: 'TEXT_MESSAGE_END', messageId: 'm_1' }],
    [188, { type: 'STEP_FINISHED', stepName: 'plan' }],
    [201, { type: 'STEP_STARTED', stepName: 'lookup' }],
    [
      214,
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'tc_1',
        toolCallName: 'lookup_order',
        parentMessageId: 'm_1',
      },
    ],
    [232, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"orderId":' }],
    [251, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: ' "4417",' }],
    [270, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: ' "include": ["shipping"]}' }],
    [284, { type: 'TOOL_CALL_END', toolCallId: 'tc_1' }],
    [
      812,
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'tc_1',
        messageId: 'm_tool_1',
        content:
          '{"orderId":"4417","status":"in_transit","carrier":"Northwind","eta":"2026-08-18"}',
      },
    ],
    [
      840,
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { order: { id: '4417', status: 'unknown', carrier: null }, steps: 0 },
      },
    ],
    [
      858,
      {
        type: 'STATE_DELTA',
        delta: [
          { op: 'replace', path: '/order/status', value: 'in_transit' },
          { op: 'replace', path: '/order/carrier', value: 'Northwind' },
        ],
      },
    ],
    [872, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/steps', value: 1 }] }],
    [886, { type: 'STEP_FINISHED', stepName: 'lookup' }],
    [900, { type: 'STEP_STARTED', stepName: 'respond' }],
    [918, { type: 'TEXT_MESSAGE_START', messageId: 'm_2', role: 'assistant' }],
    [962, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: 'Order 4417 is in transit' }],
    [1004, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: ' with Northwind and should' }],
    [1041, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: ' arrive on 18 August.' }],
    [1058, { type: 'TEXT_MESSAGE_END', messageId: 'm_2' }],
    [1070, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/steps', value: 2 }] }],
    [1082, { type: 'STEP_FINISHED', stepName: 'respond' }],
    [1094, { type: 'RUN_FINISHED', threadId: THREAD, runId }],
  ]);
}

function runTwo(): JsonlLine[] {
  const runId = 'r_demo_2';
  return events('c2', 29, [
    [11, { type: 'RUN_STARTED', threadId: THREAD, runId }],
    [24, { type: 'STEP_STARTED', stepName: 'respond' }],
    // THE VIOLATION. A delta for a message the stream never opened — `unopened-message-id`.
    // This is the single issue the whole fixture exists to make visible in shot 2.
    [
      63,
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_3', delta: 'Your replacement label' },
    ],
    [77, { type: 'TEXT_MESSAGE_START', messageId: 'm_3', role: 'assistant' }],
    [119, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_3', delta: ' is ready to print.' }],
    [136, { type: 'TEXT_MESSAGE_END', messageId: 'm_3' }],
    [148, { type: 'STEP_FINISHED', stepName: 'respond' }],
    [160, { type: 'RUN_FINISHED', threadId: THREAD, runId }],
  ]);
}

export function buildDemoFixture(): string {
  return encodeJsonl([
    header(),
    request('c1', 'r_demo_1', 'Where is my order 4417?'),
    ...runOne(),
    request('c2', 'r_demo_2', 'Can you resend the return label?'),
    ...runTwo(),
  ]);
}

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../listing/fixtures/demo.agui.jsonl',
);

/** Only write when invoked as a CLI; importing this module must have no side effect. */
if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('build-demo-fixture.ts')) {
  writeFileSync(outPath, buildDemoFixture(), 'utf8');
  console.log(`wrote ${outPath}`);
}
```

- [ ] **Step 4: Run the test**

```bash
cd packages/devtools && pnpm vitest run --project scripts scripts/build-demo-fixture.test.ts
```

Expected: all six tests PASS.

**If the issue-count test fails with more than one issue**, print them and fix the fixture rather than the assertion — an unintended second violation means the demo capture is lying about something:

```bash
cd packages/devtools && pnpm tsx -e "import {loadJsonl} from './src/panel/import/load-jsonl'; import {buildDemoFixture} from './scripts/build-demo-fixture'; console.log(loadJsonl(buildDemoFixture()).issues)"
```

The likely culprits, in order: `run-started-without-input` (a run whose `connId` has no `request` line), `state-patch-failed` (a delta path absent from the snapshot), `unbalanced-steps`, and `tool-args-not-json` (the three `TOOL_CALL_ARGS` deltas must concatenate to parseable JSON).

- [ ] **Step 5: Add the script entry and generate the fixture**

In `packages/devtools/package.json`, add after `"icons"`:

```json
    "listing:fixture": "tsx scripts/build-demo-fixture.ts",
```

Then:

```bash
cd packages/devtools && mkdir -p listing/fixtures && pnpm listing:fixture && wc -l listing/fixtures/demo.agui.jsonl
```

Expected: `wrote …/demo.agui.jsonl`, and 40 lines (1 header + 2 request + 37 events).

- [ ] **Step 6: Read the fixture before committing it**

```bash
cd packages/devtools && cat listing/fixtures/demo.agui.jsonl
```

This is going into store screenshots that thousands of people may see. Confirm: no real names, no plausible-looking credentials, nothing embarrassing.

- [ ] **Step 7: Commit**

```bash
git add packages/devtools/scripts/build-demo-fixture.ts packages/devtools/scripts/build-demo-fixture.test.ts packages/devtools/listing/fixtures/demo.agui.jsonl packages/devtools/package.json
git commit -m "feat(listing): a demo capture built to photograph well

Two runs, one tool call, real state patches, and exactly one protocol
violation - constructed so every other validator rule is satisfied, and
asserted to stay that way. Deterministic bytes, so the committed fixture
is diffable in review.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The caption frame and the screenshot generator

**Files:**
- Create: `packages/devtools/listing/frames/frame.css`
- Create: `packages/devtools/listing/frames/screenshot.html`
- Create: `packages/devtools/scripts/listing-assets.mts`
- Modify: `packages/devtools/package.json`

- [ ] **Step 1: Write the shared frame styling**

Create `packages/devtools/listing/frames/frame.css`:

```css
/*
 * Styling for the marketing surround only. The panel inside the iframe brings its own CSS and
 * must not be touched from here — the whole point is that the panel pixels are the real build.
 *
 * Colours are the panel's palette tokens, restated because this document is not the panel and
 * inherits nothing from it.
 */
:root {
  --accent: #1a73e8;
  --accent-deep: #0b3d91;
  --ink: #ffffff;
  --ink-muted: rgba(255, 255, 255, 0.72);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(160deg, var(--accent) 0%, var(--accent-deep) 100%);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}

.frame {
  width: 1280px;
  height: 800px;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
}

.frame__caption {
  height: 148px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 0 80px;
}

.frame__headline {
  margin: 0;
  font-size: 38px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.frame__sub {
  margin: 10px 0 0;
  font-size: 17px;
  font-weight: 450;
  color: var(--ink-muted);
}

/* The card is the only place the panel is allowed to be framed. */
.frame__card {
  width: 1160px;
  height: 604px;
  border-radius: 14px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 26px 60px rgba(0, 0, 0, 0.34), 0 2px 0 rgba(255, 255, 255, 0.14) inset;
}

.frame__panel {
  width: 1160px;
  height: 604px;
  border: 0;
  display: block;
}
```

- [ ] **Step 2: Write the frame document**

Create `packages/devtools/listing/frames/screenshot.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>listing frame</title>
    <link rel="stylesheet" href="./frame.css" />
  </head>
  <body>
    <!--
      The generator sets the two text nodes and the iframe src from the storyboard, then
      screenshots `.frame`. Nothing here is interactive; it exists to be photographed.
    -->
    <div class="frame">
      <div class="frame__caption">
        <h1 class="frame__headline" id="headline"></h1>
        <p class="frame__sub" id="sub"></p>
      </div>
      <div class="frame__card">
        <iframe class="frame__panel" id="panel" title="AG-UI DevTools panel"></iframe>
      </div>
    </div>
  </body>
</html>
```

- [ ] **Step 3: Teach the harness to mount a second directory**

The composing frame must be served from the **same origin** as the panel, or `frameLocator` cannot
drive the iframe. So one server, with `listing/` mounted alongside `dist/`.

In `packages/devtools/scripts/panel-harness.ts`, change the `startServer` signature and path
resolution:

```ts
/**
 * Serve a directory over HTTP. ES modules will not load over `file://`.
 *
 * `mounts` maps a URL path prefix to another directory. The listing generator needs the composing
 * frame served from the SAME origin as the panel — a cross-origin iframe cannot be driven by
 * `frameLocator` — so it mounts `listing/` at `/listing/` beside `dist/`.
 */
export function startServer(
  root: string,
  mounts: Record<string, string> = {},
): Promise<StaticServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let base = root;
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (rel.startsWith(`/${prefix}/`)) {
        base = dir;
        rel = rel.slice(prefix.length + 1);
        break;
      }
    }
    const file = join(base, rel);
    if (!file.startsWith(base) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      ready({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
```

`mounts` defaults to `{}`, so the gate's existing `startServer(distDir)` call is unaffected.

- [ ] **Step 4: Write the generator**

Create `packages/devtools/scripts/listing-assets.mts`:

```ts
/**
 * Chrome Web Store screenshots, composed from the real built panel.
 *
 * Reads `dist/`, so `pnpm build` must have run — the opposite side of the build from
 * `render-icons.mts`, whose output is source.
 *
 * Each shot is a caption frame (`listing/frames/screenshot.html`) with the panel in an iframe.
 * Only the surround is marketing; the panel pixels are the build. Shot at deviceScaleFactor 2 and
 * downsampled through a canvas to exactly 1280×800, so panel text is retina-quality rather than
 * rendered at 1×.
 *
 * A storyboard entry whose UI does not exist yet FAILS THE RUN. It does not silently emit four
 * screenshots and leave a human to notice the gallery is short — three of the five panel tabs are
 * still placeholders, and shipping a gallery that quietly drops the State shot is precisely the
 * failure this script exists to prevent.
 *
 * Run: `pnpm build && pnpm listing:assets`
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, FrameLocator, Page } from 'playwright';
import { chromium } from 'playwright';
import { importFixture, openPanel, PANEL_PATH, startServer } from './panel-harness';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.PANEL_DIST ?? join(packageRoot, 'dist');
const listingDir = join(packageRoot, 'listing');
const outDir = process.env.LISTING_OUT ?? join(listingDir, 'out');
const fixture = join(listingDir, 'fixtures/demo.agui.jsonl');

const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 800;

interface Shot {
  file: string;
  headline: string;
  sub: string;
  scheme: 'light' | 'dark';
  /** Drive the panel into the state this shot depicts. Throw to fail the run. */
  drive: (panel: FrameLocator) => Promise<void>;
}

const STORYBOARD: Shot[] = [
  {
    file: '1-timeline.png',
    headline: 'Every AG-UI event, decoded and in order',
    sub: 'Runs, steps, tool calls and state — grouped, timed, and inspectable.',
    scheme: 'light',
    async drive(panel) {
      await panel.locator('.agui-event-row[data-seq="10"]').click();
      await panel.locator('.agui-event-detail').waitFor({ timeout: 5000 });
    },
  },
  {
    file: '2-issues.png',
    headline: 'Protocol violations, named and located',
    sub: 'The validator finds what the Network panel cannot even see.',
    scheme: 'light',
    async drive(panel) {
      const badge = panel.locator('.agui-issue-badge');
      await badge.waitFor({ timeout: 5000 });
      const count = (await panel.locator('.agui-issue-badge__count').textContent())?.trim();
      if (count !== '1 issue' && count !== '1 issues') {
        throw new Error(
          `the issue badge reads ${JSON.stringify(count)}; the demo fixture is specified to ` +
            'carry exactly one violation. Re-run `pnpm listing:fixture`.',
        );
      }
      await badge.click();
      await panel.locator('.agui-event-row').first().click();
      await panel.locator('.agui-event-detail').waitFor({ timeout: 5000 });
    },
  },
  {
    file: '3-state.png',
    headline: 'Watch state rebuild, patch by patch',
    sub: 'Every RFC 6902 patch, and the object it produced.',
    scheme: 'light',
    async drive(panel) {
      await panel.locator('button[role="tab"][id="agui-tab-state"]').click();
      if ((await panel.locator('.agui-coming').count()) > 0) {
        throw new Error(
          'the State tab is still a placeholder. This shot cannot be taken until the tab is ' +
            'built — see the design, decision L1: submit when the product is whole.',
        );
      }
    },
  },
  {
    file: '4-replay.png',
    headline: 'Record a run. Replay it anywhere.',
    sub: 'Export a capture as .agui.jsonl, reopen it on any machine.',
    scheme: 'light',
    async drive(panel) {
      await panel.locator('button[role="tab"][id="agui-tab-session"]').click();
      await panel.locator('.agui-session').waitFor({ timeout: 5000 });
    },
  },
  {
    file: '5-privacy.png',
    headline: 'No network egress. Ever.',
    sub: 'Opt in per origin. Nothing is uploaded, synced, or persisted to disk.',
    scheme: 'dark',
    async drive(panel) {
      await panel.locator('button[role="tab"][id="agui-tab-session"]').click();
      await panel.locator('.agui-session').waitFor({ timeout: 5000 });
    },
  },
];

/**
 * Screenshot at 2× and resample to the exact pixel dimensions the store requires. Playwright
 * cannot downscale, and CWS accepts only 1280×800 or 640×400 — so a raw 2× shot is rejected and a
 * 1× shot renders panel text at half the quality this is capable of.
 */
async function downsample(
  browser: Browser,
  png: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 8, height: 8 } });
  try {
    const dataUrl = await page.evaluate(
      async ([src, w, h]) => {
        const image = new Image();
        image.src = src as string;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = w as number;
        canvas.height = h as number;
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, w as number, h as number);
        return canvas.toDataURL('image/png');
      },
      [`data:image/png;base64,${png.toString('base64')}`, width, height] as const,
    );
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } finally {
    await page.close();
  }
}

async function shoot(browser: Browser, origin: string, shot: Shot): Promise<void> {
  const session = await openPanel(browser, origin, {
    scheme: shot.scheme,
    viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
    deviceScaleFactor: 2,
    url: `${origin}/listing/frames/screenshot.html`,
  });
  try {
    const { page } = session;
    await page.evaluate(
      ([headline, sub, src]) => {
        document.querySelector('#headline')!.textContent = headline;
        document.querySelector('#sub')!.textContent = sub;
        document.querySelector('iframe')!.setAttribute('src', src);
      },
      [shot.headline, shot.sub, `${origin}/${PANEL_PATH}`] as const,
    );

    const panel = page.frameLocator('iframe.frame__panel');
    await panel.locator('.agui-app, .agui-drop').first().waitFor({ timeout: 10_000 });
    await importFixture(panel, fixture);
    await shot.drive(panel);

    // Let streamed layout and any transition settle before the shutter.
    await page.waitForTimeout(250);

    const raw = await page.locator('.frame').screenshot();
    const png = await downsample(browser, raw, SHOT_WIDTH, SHOT_HEIGHT);
    writeFileSync(join(outDir, shot.file), png);

    if (session.errors.length > 0) {
      throw new Error(`${shot.file}: the panel logged errors: ${session.errors.join(' | ')}`);
    }
    console.log(`  ${shot.file}  ${shot.headline}`);
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(distDir, PANEL_PATH))) {
    console.error(`FAIL: ${join(distDir, PANEL_PATH)} does not exist. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  if (!existsSync(fixture)) {
    console.error(`FAIL: ${fixture} does not exist. Run \`pnpm listing:fixture\` first.`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  // ONE server: dist/ at the root, listing/ mounted at /listing/. Same origin is not a tidiness
  // preference — a cross-origin iframe cannot be driven by `frameLocator`.
  const server = await startServer(distDir, { listing: listingDir });
  const browser = await chromium.launch();

  const failures: string[] = [];
  try {
    for (const shot of STORYBOARD) {
      try {
        await shoot(browser, server.origin, shot);
      } catch (error) {
        failures.push(`${shot.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length > 0) {
    console.error(`\nFAIL: ${String(failures.length)} of ${String(STORYBOARD.length)} shots:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }
  console.log(`\n${String(STORYBOARD.length)} screenshots written to ${outDir}`);
}

await main();
```

- [ ] **Step 5: Add the script entry**

In `packages/devtools/package.json`, after `"listing:fixture"`:

```json
    "listing:assets": "tsx scripts/listing-assets.mts",
```

- [ ] **Step 6: Run it, and expect exactly one failure**

```bash
cd packages/devtools && pnpm build && pnpm listing:assets; echo "exit=$?"
```

Expected: `exit=1`, four screenshots written, and one failure reading `3-state.png: the State tab is still a placeholder.`

**This is the correct outcome.** It is decision L1 working: the gallery cannot be completed until the product is. If any shot other than `3-state.png` fails, fix that shot.

- [ ] **Step 7: Look at the four screenshots**

```bash
cd packages/devtools && file listing/out/*.png
```

Expected: `PNG image data, 1280 x 800` for each of the four.

Then open them. Check: the panel is not cut off inside the card, the caption does not overflow, the dark shot is genuinely dark, and shot 2 shows the filtered issue row with its detail.

- [ ] **Step 8: Verify the gate is unaffected**

```bash
cd packages/devtools && pnpm screenshot:panel && pnpm typecheck && pnpm lint
```

Expected: exits 0. The `startServer` signature changed; this confirms the gate's call still works.

- [ ] **Step 9: Commit**

```bash
git add packages/devtools/listing/frames packages/devtools/scripts/listing-assets.mts packages/devtools/scripts/panel-harness.ts packages/devtools/listing/out packages/devtools/package.json
git commit -m "feat(listing): captioned store screenshots from the real build

Each shot is the built panel in an iframe inside a caption frame, driven
through the storyboard state it depicts, shot at 2x and resampled to the
exact 1280x800 the store requires.

The State shot fails the run today, on purpose: that tab is still a
placeholder, and a gallery that silently drops a shot is the failure this
script exists to prevent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Promo tiles

**Files:**
- Create: `packages/devtools/listing/frames/tile.html`
- Create: `packages/devtools/listing/frames/marquee.html`
- Modify: `packages/devtools/scripts/listing-assets.mts`

- [ ] **Step 1: Write the small tile**

Create `packages/devtools/listing/frames/tile.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>small promo tile</title>
    <link rel="stylesheet" href="./frame.css" />
    <style>
      .tile {
        width: 440px;
        height: 280px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 18px;
        padding: 0 34px;
      }
      .tile__mark { width: 64px; height: 64px; }
      .tile__name { margin: 0; font-size: 30px; font-weight: 680; letter-spacing: -0.02em; }
      .tile__sub { margin: 0; font-size: 15px; line-height: 1.4; color: var(--ink-muted); }
    </style>
  </head>
  <body>
    <div class="tile">
      <img class="tile__mark" src="../icon.svg" alt="" />
      <h1 class="tile__name">AG-UI DevTools</h1>
      <p class="tile__sub">Capture, decode and validate AG-UI agent streams — on any page.</p>
    </div>
  </body>
</html>
```

- [ ] **Step 2: Write the marquee**

Create `packages/devtools/listing/frames/marquee.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>marquee</title>
    <link rel="stylesheet" href="./frame.css" />
    <style>
      .marquee {
        width: 1400px;
        height: 560px;
        display: flex;
        align-items: center;
        gap: 56px;
        padding: 0 96px;
      }
      .marquee__mark { width: 168px; height: 168px; flex: none; }
      .marquee__name { margin: 0; font-size: 66px; font-weight: 700; letter-spacing: -0.03em; }
      .marquee__sub { margin: 18px 0 0; font-size: 25px; line-height: 1.4; color: var(--ink-muted); max-width: 780px; }
    </style>
  </head>
  <body>
    <div class="marquee">
      <img class="marquee__mark" src="../icon.svg" alt="" />
      <div>
        <h1 class="marquee__name">AG-UI DevTools</h1>
        <p class="marquee__sub">
          Capture, decode, validate and replay AG-UI agent event streams from any page.
          No SDK, no code change, no data leaves your browser.
        </p>
      </div>
    </div>
  </body>
</html>
```

The `../icon.svg` reference resolves because Task 5 mounts all of `listing/` at `/listing/`, so the frame document sits at `/listing/frames/tile.html` and the mark one level up at `/listing/icon.svg`. No mount change is needed here.

- [ ] **Step 3: Emit the tiles**

In `packages/devtools/scripts/listing-assets.mts`, add above `main()`:

```ts
interface Tile {
  file: string;
  doc: string;
  selector: string;
  width: number;
  height: number;
}

/** Marquee is only used if the store features the item, but it costs nothing to emit. */
const TILES: Tile[] = [
  { file: 'promo-small-440x280.png', doc: 'tile.html', selector: '.tile', width: 440, height: 280 },
  { file: 'marquee-1400x560.png', doc: 'marquee.html', selector: '.marquee', width: 1400, height: 560 },
];

async function shootTile(browser: Browser, origin: string, tile: Tile): Promise<void> {
  const session = await openPanel(browser, origin, {
    viewport: { width: tile.width, height: tile.height },
    deviceScaleFactor: 2,
    url: `${origin}/listing/frames/${tile.doc}`,
  });
  try {
    const raw = await session.page.locator(tile.selector).screenshot();
    const png = await downsample(browser, raw, tile.width, tile.height);
    writeFileSync(join(outDir, tile.file), png);
    console.log(`  ${tile.file}`);
  } finally {
    await session.close();
  }
}
```

And in `main()`, after the storyboard loop and inside the same `try`:

```ts
    for (const tile of TILES) {
      try {
        await shootTile(browser, server.origin, tile);
      } catch (error) {
        failures.push(`${tile.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
```

- [ ] **Step 4: Run and check dimensions**

```bash
cd packages/devtools && pnpm build && pnpm listing:assets; file listing/out/promo-small-440x280.png listing/out/marquee-1400x560.png
```

Expected: still `exit=1` from the State shot, but both tiles written, at `440 x 280` and `1400 x 560` exactly.

- [ ] **Step 5: Look at them**

Open both. Check the mark renders (not a broken-image icon — that means the `../icon.svg` mount is wrong) and no text is clipped.

- [ ] **Step 6: Commit**

```bash
git add packages/devtools/listing/frames packages/devtools/scripts/listing-assets.mts packages/devtools/listing/out
git commit -m "feat(listing): small promo tile and marquee

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Listing copy and its validator

**Files:**
- Create: `packages/devtools/listing/copy.md`
- Create: `packages/devtools/scripts/verify-listing-copy.ts`
- Create: `packages/devtools/scripts/verify-listing-copy.test.ts`
- Modify: `packages/devtools/package.json`

- [ ] **Step 1: Write the failing test**

Create `packages/devtools/scripts/verify-listing-copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkCopy, parseCopy } from './verify-listing-copy';

const VALID = `---
title: AG-UI DevTools
summary: Inspect, validate, and replay AG-UI agent event streams from any page.
category: Developer Tools
language: en
single_purpose: Capture and inspect AG-UI protocol event streams for debugging.
uses_remote_code: false
privacy_policy_url: https://github.com/blove/ag-ui-chrome-extension/blob/main/PRIVACY.md
permissions:
  storage: Per-origin opt-in and panel preferences only.
  scripting: Registers capture content scripts on origins the user grants.
  optional_host_permissions: Requested one origin at a time, on an explicit click.
---

# AG-UI DevTools

A real detailed description.
`;

describe('parseCopy', () => {
  it('reads the front matter and the body', () => {
    const copy = parseCopy(VALID);
    expect(copy.fields.title).toBe('AG-UI DevTools');
    expect(copy.fields.permissions?.storage).toContain('opt-in');
    expect(copy.body).toContain('A real detailed description.');
  });

  it('rejects a document with no front matter', () => {
    expect(() => parseCopy('# no front matter')).toThrow(/front matter/i);
  });
});

describe('checkCopy', () => {
  const MANIFEST_PERMISSIONS = ['storage', 'scripting', 'optional_host_permissions'];

  it('passes a valid document', () => {
    expect(checkCopy(parseCopy(VALID), MANIFEST_PERMISSIONS)).toEqual([]);
  });

  it('fails a summary over 132 characters', () => {
    const long = VALID.replace(
      /^summary: .*$/m,
      `summary: ${'x'.repeat(133)}`,
    );
    expect(checkCopy(parseCopy(long), MANIFEST_PERMISSIONS).join(' ')).toMatch(/summary.*132/i);
  });

  it('fails a title over 75 characters', () => {
    const long = VALID.replace(/^title: .*$/m, `title: ${'x'.repeat(76)}`);
    expect(checkCopy(parseCopy(long), MANIFEST_PERMISSIONS).join(' ')).toMatch(/title.*75/i);
  });

  it('fails an empty required field', () => {
    const blank = VALID.replace(/^single_purpose: .*$/m, 'single_purpose: ');
    expect(checkCopy(parseCopy(blank), MANIFEST_PERMISSIONS).join(' ')).toMatch(/single_purpose/);
  });

  it('fails a manifest permission with no justification', () => {
    const failures = checkCopy(parseCopy(VALID), [...MANIFEST_PERMISSIONS, 'tabs']);
    expect(failures.join(' ')).toMatch(/tabs/);
  });

  it('fails a justification for a permission the manifest does not request', () => {
    const extra = VALID.replace(
      /^  storage: .*$/m,
      '  storage: Per-origin opt-in only.\n  bookmarks: Nothing requests this.',
    );
    expect(checkCopy(parseCopy(extra), MANIFEST_PERMISSIONS).join(' ')).toMatch(/bookmarks/);
  });

  it('fails an empty detailed description', () => {
    const empty = VALID.slice(0, VALID.lastIndexOf('---') + 3);
    expect(checkCopy(parseCopy(empty), MANIFEST_PERMISSIONS).join(' ')).toMatch(/description/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/devtools && pnpm vitest run --project scripts scripts/verify-listing-copy.test.ts
```

Expected: FAIL — `Failed to resolve import "./verify-listing-copy"`.

- [ ] **Step 3: Write the validator**

Create `packages/devtools/scripts/verify-listing-copy.ts`:

```ts
/**
 * `listing/copy.md` is the source of truth for the Chrome Web Store listing text. Every
 * constrained field has a limit that is otherwise discovered at the upload form, halfway through
 * a submission.
 *
 * The front-matter parser is hand-written and deliberately small: it handles exactly the shape
 * this one document uses (flat `key: value`, plus a single nested `permissions:` block). Adding a
 * YAML dependency to ship a listing would be absurd. If the document ever needs richer YAML, that
 * is the signal to reach for a parser, not to grow this.
 *
 * Run: `pnpm verify:listing`
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Chrome Web Store field limits. */
const LIMITS = { title: 75, summary: 132, description: 16_000 } as const;

const REQUIRED_FIELDS = [
  'title',
  'summary',
  'category',
  'language',
  'single_purpose',
  'privacy_policy_url',
] as const;

export interface CopyFields {
  title?: string;
  summary?: string;
  category?: string;
  language?: string;
  single_purpose?: string;
  privacy_policy_url?: string;
  uses_remote_code?: string;
  permissions?: Record<string, string>;
}

export interface Copy {
  fields: CopyFields;
  body: string;
}

export function parseCopy(text: string): Copy {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new Error('listing copy has no `---` front matter block at the top of the file.');
  }
  const [, front = '', body = ''] = match;

  const fields: CopyFields = {};
  const permissions: Record<string, string> = {};
  let inPermissions = false;

  for (const line of front.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const nested = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (inPermissions && nested !== null) {
      permissions[nested[1] as string] = (nested[2] ?? '').trim();
      continue;
    }
    const top = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (top === null) {
      throw new Error(`front matter line is not \`key: value\`: ${JSON.stringify(line)}`);
    }
    const key = top[1] as string;
    const value = (top[2] ?? '').trim();
    inPermissions = key === 'permissions';
    if (inPermissions) continue;
    (fields as Record<string, string>)[key] = value;
  }

  if (Object.keys(permissions).length > 0) fields.permissions = permissions;
  return { fields, body: body.trim() };
}

/** Returns one string per problem. Empty means the copy is submittable. */
export function checkCopy(copy: Copy, manifestPermissions: readonly string[]): string[] {
  const failures: string[] = [];
  const { fields, body } = copy;

  for (const key of REQUIRED_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === '') failures.push(`${key} is required and is empty.`);
  }

  if (fields.title !== undefined && fields.title.length > LIMITS.title) {
    failures.push(
      `title is ${String(fields.title.length)} characters; the store limit is ${String(LIMITS.title)}.`,
    );
  }
  if (fields.summary !== undefined) {
    if (fields.summary.length > LIMITS.summary) {
      failures.push(
        `summary is ${String(fields.summary.length)} characters; the store limit is ${String(LIMITS.summary)}.`,
      );
    }
    if (/<[a-z]/i.test(fields.summary)) {
      failures.push('summary contains markup; the store field is plain text.');
    }
  }
  if (body === '') {
    failures.push('the detailed description (the body below the front matter) is empty.');
  } else if (body.length > LIMITS.description) {
    failures.push(
      `the detailed description is ${String(body.length)} characters; the store limit is ${String(LIMITS.description)}.`,
    );
  }
  if (fields.privacy_policy_url !== undefined && fields.privacy_policy_url !== '') {
    if (!/^https:\/\//.test(fields.privacy_policy_url)) {
      failures.push('privacy_policy_url must be an https URL.');
    }
  }

  const justified = fields.permissions ?? {};
  for (const permission of manifestPermissions) {
    const text = justified[permission];
    if (text === undefined || text === '') {
      failures.push(
        `the manifest requests "${permission}" but the listing justifies no such permission. ` +
          'A reviewer will ask, and an unanswered permission is the most common rejection.',
      );
    }
  }
  for (const permission of Object.keys(justified)) {
    if (!manifestPermissions.includes(permission)) {
      failures.push(
        `the listing justifies "${permission}", which the manifest does not request. Either the ` +
          'justification is stale or the manifest lost a permission.',
      );
    }
  }

  return failures;
}

/* -------------------------------------------------------------------------- */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read straight from `manifest.config.ts` rather than `dist/manifest.json`, so this runs without
 * a build. `optional_host_permissions` is listed as a permission because the store asks for it to
 * be justified like one.
 */
function manifestPermissions(): string[] {
  const source = readFileSync(join(packageRoot, 'manifest.config.ts'), 'utf8');
  const found: string[] = [];
  const permissions = /permissions:\s*\[([^\]]*)\]/.exec(source);
  if (permissions !== null) {
    for (const m of (permissions[1] ?? '').matchAll(/'([^']+)'/g)) found.push(m[1] as string);
  }
  if (/optional_host_permissions:\s*\[/.test(source)) found.push('optional_host_permissions');
  return found;
}

function main(): void {
  const copyPath = join(packageRoot, 'listing/copy.md');
  if (!existsSync(copyPath)) {
    console.error(`FAIL: ${copyPath} does not exist.`);
    process.exit(1);
  }
  const failures = checkCopy(parseCopy(readFileSync(copyPath, 'utf8')), manifestPermissions());
  if (failures.length > 0) {
    console.error(`FAIL: ${String(failures.length)} problem(s) with the listing copy:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }
  console.log('listing copy is within every Chrome Web Store limit.');
  console.log(`  permissions justified: ${manifestPermissions().join(', ')}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('verify-listing-copy.ts')) {
  main();
}
```

- [ ] **Step 4: Run the test**

```bash
cd packages/devtools && pnpm vitest run --project scripts scripts/verify-listing-copy.test.ts
```

Expected: all nine tests PASS.

- [ ] **Step 5: Write the copy**

Create `packages/devtools/listing/copy.md`:

```markdown
---
title: AG-UI DevTools
summary: Inspect, validate, and replay AG-UI agent event streams from any page. No SDK, no code change, no data leaves your browser.
category: Developer Tools
language: en
single_purpose: Capture and inspect AG-UI protocol event streams on pages the user explicitly enables, for debugging.
uses_remote_code: false
privacy_policy_url: https://github.com/blove/ag-ui-chrome-extension/blob/main/PRIVACY.md
permissions:
  storage: Stores the user's per-origin capture opt-in and panel preferences. Captured events live in chrome.storage.session, which Chrome clears when the browser closes. Nothing is synced and nothing is written to disk unless the user exports a capture themselves.
  scripting: Registers the capture content scripts at runtime on origins the user has explicitly granted, via chrome.scripting.registerContentScripts. This is required precisely because the extension ships with no static remote host permissions - without it, capture could only ever work on localhost.
  optional_host_permissions: Requested one origin at a time, only when the user clicks to enable capture on that page. It is needed to read the server-sent-event response bodies the page is already receiving. No origin is granted at install time.
---

# Debug AG-UI agent streams on the wire, not in your app

AG-UI is an event protocol over server-sent events. When an agent run misbehaves, the Network
panel shows you an opaque `text/event-stream` and `console.log` shows you what your app *thinks*
happened. AG-UI DevTools shows you the wire: every event in order, grouped into runs, with the
protocol violations named and located.

## Why the existing options do not work

- **Chrome's Network panel** gives you raw `data:` lines. No decoding, no run grouping, no state
  reconstruction, no validation.
- **In-app inspectors** ship inside your bundle, are tied to one framework, and cannot help an
  Angular, Vue, or vanilla AG-UI app at all.
- **Editor extensions** need a runtime in dev mode, so they go dark exactly where bugs are hardest
  to reproduce.

This is a wire-level tool. It attaches to the protocol instead of the framework.

## What it does

- **Captures** AG-UI events from `fetch`, `XMLHttpRequest`, and `EventSource`
- **Decodes** SSE framing and groups events into runs and threads
- **Validates** protocol invariants and names each violation at the event that caused it
- **Reconstructs** messages, tool-call trees, and state with full RFC 6902 patch history
- **Measures** time to first token, inter-token gaps, tool latency, and stalls
- **Records and replays** — export a capture as `.agui.jsonl` and reopen it anywhere

## Privacy, stated as fact

This tool sits where prompts and completions flow, so its posture is not a matter of trust:

- **No network egress. Ever.** No remote host permissions, no fetch from the service worker or the
  panel, no telemetry, no update pings, no crash reporting.
- **Opt in per origin.** The extension ships inert. Only `localhost`, `127.0.0.1`, and `0.0.0.0`
  are registered up front; every other origin takes an explicit click.
- **Nothing on disk by default.** Capture lives in memory with a `chrome.storage.session` mirror
  that Chrome clears when the browser closes.
- **Headers are never captured** except `content-type`. Authorization headers and cookies are
  never read, never stored, never exported.
- **Redaction on export** for bug-report bundles: text, reasoning, tool arguments, tool results and
  state values are replaced, while structure, types, ordering, sizes and timings survive — which is
  what a protocol bug report actually needs.

Every claim above is checkable by reading the built `manifest.json`, and the repository's build
verification asserts them on every commit.

## Open source

MIT licensed. Source, issues, and the full specification:
https://github.com/blove/ag-ui-chrome-extension
```

- [ ] **Step 6: Add the script entry and run the validator**

In `packages/devtools/package.json`, after `"listing:assets"`:

```json
    "verify:listing": "tsx scripts/verify-listing-copy.ts",
```

Then:

```bash
cd packages/devtools && pnpm verify:listing; echo "exit=$?"
```

Expected: `exit=0`, printing `listing copy is within every Chrome Web Store limit.` and
`permissions justified: storage, scripting, optional_host_permissions`.

If the summary fails on length, shorten it — do not raise the limit.

- [ ] **Step 7: Commit**

```bash
git add packages/devtools/listing/copy.md packages/devtools/scripts/verify-listing-copy.ts packages/devtools/scripts/verify-listing-copy.test.ts packages/devtools/package.json
git commit -m "feat(listing): store copy as source of truth, with a limit validator

Every constrained CWS field is asserted against its limit, and each
manifest permission must have a justification - in both directions, so a
stale justification for a permission we no longer request fails too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Document the pipeline and confirm the whole workspace is green

**Files:**
- Modify: `README.md`
- Modify: `packages/devtools/package.json` (root convenience scripts)
- Modify: root `package.json`

- [ ] **Step 1: Add the root convenience scripts**

In the repository root `package.json`, add to `scripts`, after `"screenshot:panel"`:

```json
    "icons": "pnpm --filter ag-ui-devtools icons",
    "listing:fixture": "pnpm --filter ag-ui-devtools listing:fixture",
    "listing:assets": "pnpm --filter ag-ui-devtools listing:assets",
    "verify:listing": "pnpm --filter ag-ui-devtools verify:listing",
```

- [ ] **Step 2: Document the release sequence in the README**

In `README.md`, in the `## Development` section, add after the existing `pnpm package` line in the command block:

```bash
pnpm icons            # listing/icon.svg → public/icons/*.png (run BEFORE build)
pnpm listing:fixture  # regenerate the demo capture the screenshots use
pnpm listing:assets   # → packages/devtools/listing/out/*.png (run AFTER build)
pnpm verify:listing   # assert the store copy fits every CWS field limit
```

And add a short subsection after the `### Load unpacked` block:

```markdown
### Store listing assets

Everything the Chrome Web Store form needs is generated from the build, in this order — icons are
*source* (Vite copies `public/` into `dist/`), screenshots read `dist/`, so they sit on opposite
sides of `pnpm build`:

    pnpm icons && pnpm build && pnpm listing:assets && pnpm verify:listing

Copy lives in `packages/devtools/listing/copy.md`; the generated upload set lands in
`packages/devtools/listing/out/`. `pnpm listing:assets` fails while any storyboard shot's UI is
still a placeholder — see
[the listing design](docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md).
```

- [ ] **Step 3: Run the entire workspace suite**

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm verify:build && pnpm screenshot:panel && pnpm verify:listing
```

Expected: every command exits 0.

Note `pnpm listing:assets` is deliberately **not** in this chain — it exits 1 until the State tab exists, which is decision L1 and must not be turned into a passing no-op.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: the listing asset pipeline and its release sequence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Out of scope, recorded so the omissions read as decisions

Per the design, §8:

- **CWS API upload.** Revisit once an item ID exists — it does not until a human submits once.
- **Listing claims verified against `dist/manifest.json`.**
- **CI drift gate** regenerating assets and failing when the committed PNGs disagree with the build.

Two prerequisites this plan does not deliver, from design §7:

- **`PRIVACY.md` at a stable URL.** `copy.md` already points `privacy_policy_url` at
  `https://github.com/blove/ag-ui-chrome-extension/blob/main/PRIVACY.md`. That file does not exist
  and the repository may not be public. Both are needed before submission.
- **`README.md` still says the extension "does not capture anything yet."** Task 8 touches the
  Development section only; the stale Status section is a separate correction.
