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
