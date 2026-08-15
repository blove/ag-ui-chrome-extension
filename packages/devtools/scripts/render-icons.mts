/**
 * `listing/icon.svg` → `public/icons/icon-{16,32,48,128}.png`.
 *
 * These are SOURCE, not build output: Vite copies `public/` into `dist/` verbatim, so the icons
 * must exist before `pnpm build` runs. That is why this is a separate script from
 * `listing-assets.mts`, which reads `dist/` and therefore must run after it.
 *
 * `icon-128.png` doubles as the Chrome Web Store store icon; nothing separate is emitted for it.
 *
 * Run: `pnpm icons` (first run also needs `pnpm exec playwright install chromium-headless-shell`
 * — the shell is what a default headless `chromium.launch()` resolves to, and it is what CI
 * installs; see `screenshot-panel.mts` for the same prerequisite).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(packageRoot, 'listing/icon.svg');
// ICON_OUT lets a caller render to a scratch directory instead of overwriting the committed
// PNGs — useful for manual inspection of what a re-render would produce without touching the
// working tree. scripts/verify-build.ts does NOT use it: freshness there is checked by comparing
// a source hash, not by re-rendering, so it never launches a browser. See that file's
// checkIconsAreFresh for why.
const outDir = process.env.ICON_OUT ?? join(packageRoot, 'public/icons');

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
      // `visible` only means the <img> has a non-empty bounding box, which it has (100vw/100vh)
      // even when the SVG failed to decode: a broken image still writes a PNG of exactly the
      // right dimensions, so neither `file` nor the screenshot call reports anything wrong.
      // naturalWidth is the only signal that the SVG actually parsed. See listing/icon.svg for
      // the XML comment bug (a literal "--" inside a comment body) that made this concrete.
      const decoded = await page
        .locator('img')
        .evaluate((img: HTMLImageElement) =>
          img.decode().then(
            () => img.naturalWidth > 0,
            () => false,
          ),
        );
      if (!decoded) {
        throw new Error(`${svgPath} did not decode — the SVG is almost certainly not well-formed XML.`);
      }
      // omitBackground preserves the tile's rounded corners as transparency.
      const png = await page.screenshot({ omitBackground: true });
      writeFileSync(join(outDir, `icon-${String(size)}.png`), png);
      await page.close();
      console.log(`  icon-${String(size)}.png`);
    }
    // Sidecar recording exactly what these PNGs were rendered from. verify-build.ts's
    // checkIconsAreFresh compares a fresh hash of listing/icon.svg against this file rather than
    // re-rendering and diffing pixels — deterministic on every machine, where a rendered-byte
    // comparison is not (Chromium's rasterizer differs by platform and version).
    const sourceHash = createHash('sha256').update(svg, 'utf8').digest('hex');
    writeFileSync(join(outDir, '.source-sha256'), `${sourceHash}\n`);
  } finally {
    await browser.close();
  }
  console.log(`icons written to ${outDir}`);
}

await main();
