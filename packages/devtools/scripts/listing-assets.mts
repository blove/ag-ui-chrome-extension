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
import type { Browser, FrameLocator } from 'playwright';
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

/**
 * Wait until the detail pane is showing a *selected* event, not merely mounted.
 *
 * `.agui-detail` is always in the tree — with nothing selected it renders `.agui-detail__empty`
 * ("Select an event to see its detail."), so waiting on the section itself resolves instantly and
 * would photograph the empty pane if the row click ever missed. `.agui-detail__title` is rendered
 * only on the branch that has a record, which makes it the assertion these two shots need: the
 * detail pane is the entire point of clicking a row.
 */
async function waitForSelectedDetail(panel: FrameLocator): Promise<void> {
  await panel.locator('.agui-detail__title').waitFor({ timeout: 5000 });
}

/**
 * The phrases the Session tab uses to say a capability is not built yet. They are the panel's own
 * honest self-report; matching on them is how this script learns that a shot's subject does not
 * exist without hard-coding a list of finished features here.
 */
const UNBUILT_MARKERS = ['unavailable in this build', 'not available in phase 1'];

/**
 * Refuse to photograph a Session tab that is still advertising unbuilt functionality.
 *
 * Decision L1 again, applied where it bites hardest. A caption sits above the panel in the same
 * image, so a shot of a tab reading "Export: not available in phase 1" under the words "Export a
 * capture as .agui.jsonl" is an asset that contradicts itself — that is the misleading-claim
 * category that gets store submissions rejected, and the false claim would be ours. The check is
 * on the rendered text rather than on a feature flag because the rendered text is what a reviewer
 * reads.
 *
 * `blockedBy` says what must exist before the shot can be taken, so the failure is a work item and
 * not a mystery.
 */
async function refuseUnbuiltPanel(panel: FrameLocator, blockedBy: string): Promise<void> {
  const text = (await panel.locator('.agui-session').innerText()).toLowerCase();
  const found = UNBUILT_MARKERS.filter((marker) => text.includes(marker));
  if (found.length > 0) {
    throw new Error(
      `the Session tab still reads ${found.map((marker) => `"${marker}"`).join(' and ')}, so this ` +
        `shot would caption a claim the panel in the same image contradicts. ${blockedBy}`,
    );
  }
}

const STORYBOARD: Shot[] = [
  {
    file: '1-timeline.png',
    headline: 'Every AG-UI event, decoded and in order',
    sub: 'Runs, steps, tool calls and state — grouped, timed, and inspectable.',
    scheme: 'light',
    async drive(panel) {
      await panel.locator('.agui-event-row[data-seq="10"]').click();
      await waitForSelectedDetail(panel);
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
      /*
       * Deliberately NOT `badge.click()`. The badge filters the list down to the offending row,
       * and a list of one cannot demonstrate "located" — it shows a violation with its context
       * deleted, and leaves two thirds of the frame empty white. Clicking the flagged row where
       * it actually sits keeps the neighbours that make the tint mean something.
       *
       * The list is virtualized, and the fixture's one violation is five rows from the end of
       * thirty-five, so the row is not in the DOM at rest. Rather than reach into the scroller,
       * drive the panel's own keyboard navigation: click any mounted row to focus the listbox,
       * then End, which selects the last record and scrolls the window to it. That leaves the
       * flagged row on screen with events above and below it.
       */
      const rows = panel.locator('.agui-event-row');
      await rows.first().click();
      await rows.first().press('End');

      // By severity, not by seq: this shot is about the row the validator flagged, and hard-coding
      // a number would keep passing while silently photographing the wrong row if the fixture is
      // ever re-cut. The badge check above already pins the count at one, so this cannot be
      // ambiguous.
      const flagged = panel.locator('.agui-event-row[data-severity]');
      await flagged.waitFor({ timeout: 5000 });
      await flagged.click();
      await waitForSelectedDetail(panel);
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
      await refuseUnbuiltPanel(
        panel,
        'This shot cannot be taken until export ships and the Session tab reports a real ' +
          'recorded capture — the caption promises a round trip (record, export, reopen) that ' +
          'the tab in the frame currently reports it cannot do.',
      );
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
      await refuseUnbuiltPanel(
        panel,
        'The subject of this shot is the per-origin capture grant (design §5) — the prompt that ' +
          'shows privacy is a choice the user makes, not a promise in prose. That UI is not ' +
          'reachable here: the harness boots the panel under the `no-devtools` shim, which has ' +
          'no `chrome.permissions`, so the Session tab falls back to a column of "not detected" ' +
          'that reads as "nothing works" rather than "nothing is sent". Taking this shot needs ' +
          'either live capture running against a granted origin or a shim rich enough to render ' +
          'a granted one. Which of those is deferred, not forgotten.',
      );
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
