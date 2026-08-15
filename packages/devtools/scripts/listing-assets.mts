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
 * A storyboard entry the product cannot yet back FAILS THE RUN, and leaves no file behind. Today
 * that is three of the five shots, refused for two different reasons:
 *
 *   - the State tab (shot 3) is still a `.agui-coming` placeholder, so there is nothing to
 *     photograph;
 *   - the Session tab (shots 4 and 5) still reports its own unbuilt capabilities in the panel
 *     pixels, and shot 5's subject — the per-origin capture grant — cannot even be reached from
 *     this harness. A caption sits directly above the panel in the same image, so shooting those
 *     produces an asset that contradicts itself, which is the misleading-claim category that gets
 *     store submissions rejected.
 *
 * Emitting the two that work and leaving a human to notice the gallery is short is precisely the
 * failure this script exists to prevent, so it exits 1 with each refusal naming what must exist
 * first. Two good screenshots and a loud list of blockers beats five and a rejected submission.
 *
 * Run: `pnpm build && pnpm listing:assets`
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * Every phrase the Session tab uses to report one of its own capabilities as not built yet.
 *
 * The list must be COMPLETE, because a missing marker is a false pass — a shot taken of a tab
 * still confessing something this list forgot. An earlier revision carried only the first two and
 * would have started passing shot 5 the moment export shipped, while the Detected column still
 * rendered a wall of "not detected" under "No network egress. Ever.".
 *
 * Substrings, not whole values, so the surrounding sentence can be reworded without silently
 * emptying this list. Every one of them is pinned by a unit test — `session.test.tsx:26` ("
 * unavailable in this build"), `:72` (the capture-layer rows), `:74` (the framework row) and
 * `:100` ("not available in phase 1") — so a genuine reword breaks a test that names the string
 * rather than quietly turning this gate off. They are duplicated here rather than imported
 * because `session.tsx` is a Preact component: importing it would drag JSX and the panel's whole
 * module graph into a Node script for the sake of four string literals.
 */
const UNBUILT_MARKERS = [
  'unavailable in this build',
  'not available in phase 1',
  'ships with the capture layer',
  'no framework fingerprint in the page',
];

/**
 * Refuse to photograph a Session tab that is still advertising unbuilt functionality.
 *
 * Decision L1, applied where it bites hardest. A caption sits above the panel in the same image,
 * so a shot of a tab reading "Export: not available in phase 1" under the words "Export a capture
 * as .agui.jsonl" is an asset that contradicts itself. The check is on the rendered text rather
 * than on a feature flag because the rendered text is what a store reviewer reads.
 *
 * `blockedBy` says what must exist before the shot can be taken, so the failure is a work item and
 * not a mystery. It must describe EVERY condition — see shot 4, which is blocked on the harness as
 * well as on the product.
 */
async function refuseUnbuiltPanel(panel: FrameLocator, blockedBy: string): Promise<void> {
  const text = (await panel.locator('.agui-session').innerText()).toLowerCase();
  const found = UNBUILT_MARKERS.filter((marker) => text.includes(marker));
  if (found.length > 0) {
    throw new Error(
      `the Session tab still reads ${found.map((marker) => `"${marker}"`).join(', ')} — so this ` +
        `shot would caption a claim the panel in the same image contradicts. ${blockedBy}`,
    );
  }
}

/**
 * Refuse the privacy shot unless the per-origin capture grant is actually on screen.
 *
 * This gate tests shot 5's real subject, and it exists because the Session-tab marker check does
 * not. "No network egress. Ever." is a claim about a CHOICE the user makes — design §5's prompt,
 * `Enable capture for <origin>` — and a screenshot that does not contain that prompt is arguing
 * the point in prose instead of showing it. Gating that shot on export wording would have let it
 * pass on a build where the grant UI was still unreachable, which is a gate that reads as covering
 * something it never looked at: worse than no gate.
 *
 * `.agui-banner__action` is the grant control itself (`capture-status.tsx:114`). Two independent
 * things keep it off screen here, and both have to change:
 *
 *   1. the harness boots the panel under the `no-devtools` shim, so `chrome.devtools` is absent,
 *      `resolveOrigin` returns early (`app.tsx:53-59`) and capture stays `unsupported` — the
 *      banner renders the "only runs inside the DevTools panel" branch, which offers no control;
 *   2. `CaptureBanner` returns `null` outright for an imported source (`capture-status.tsx:54`),
 *      and every shot here imports the demo fixture. A file that is already on disk cannot depict
 *      the moment someone opts an origin in.
 */
async function refuseWithoutGrantPrompt(panel: FrameLocator): Promise<void> {
  if ((await panel.locator('.agui-banner__action').count()) > 0) return;
  throw new Error(
    'the per-origin capture grant prompt (`.agui-banner__action`, design §5) is not on screen, ' +
      'and it is the whole subject of this shot: privacy here is a choice the user is offered, ' +
      'not a sentence in a caption. It is blocked twice over — the `no-devtools` shim leaves ' +
      'capture `unsupported` so the banner offers no control, and the banner is suppressed ' +
      'entirely for an imported source, which is what every shot in this storyboard loads. ' +
      'Taking it needs live capture running against a granted origin, or a shim rich enough to ' +
      'render a granted one plus a live source. Which of those is deferred, not forgotten.',
  );
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
       * deleted, and leaves two thirds of the frame empty white. Clicking the flagged row where it
       * actually sits keeps the surrounding events, and in this fixture that includes the run
       * boundary the violation straddles, which is what makes the finding legible.
       *
       * Note what selecting the row COSTS: `panel.css:625` is "Selection outranks the issue tint",
       * so the red row background is replaced by the selection blue. What still marks the row in
       * the list is the 3px `border-left` severity gutter — a hairline once this is downsampled to
       * 1×. The evidence this shot actually rests on is the red ERROR card in the detail pane,
       * which names the rule and quotes the offending field; the list contributes the location.
       * Selecting a NEIGHBOUR would keep the full red tint at the cost of that detail card, and
       * the card is the stronger half.
       *
       * The list is virtualized, so the flagged row is not in the DOM at rest. Rather than reach
       * into the scroller, drive the panel's own keyboard navigation: click any mounted row to
       * focus the listbox, then End, which selects the last record and scrolls the window to it.
       */
      const rows = panel.locator('.agui-event-row');
      await rows.first().click();
      await rows.first().press('End');

      // By severity, not by seq: this shot is about the row the validator flagged, and hard-coding
      // a number would keep passing while silently photographing the wrong row if the fixture is
      // ever re-cut. The badge check above already pins the count at one, so this cannot be
      // ambiguous.
      const flagged = panel.locator('.agui-event-row[data-severity]');
      try {
        await flagged.waitFor({ timeout: 5000 });
      } catch {
        // `End` only reveals the flagged row because it happens to sit within one viewport of the
        // last record. Re-cut the fixture with a dozen more trailing events and this stops being
        // true — and a bare `locator.waitFor: Timeout 5000ms` would send the next reader hunting
        // through Playwright rather than through the fixture, which is the failure the badge-count
        // check above exists to avoid.
        throw new Error(
          'the flagged row never reached the DOM after End. This shot scrolls to the LAST record ' +
            'and relies on the violation sitting within one viewport of it (~13 rows) — if the ' +
            'demo fixture now carries more trailing events than that, this navigation cannot ' +
            'reach the row and the shot needs a different one: scroll the list directly, or ' +
            're-cut the fixture so the violation stays near the end.',
        );
      }
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
      /*
       * A bare `count()` is a point sample, and "zero placeholders" is not the same claim as "the
       * tab rendered". `App` renders only the active tab (`app.tsx:186-214`), synchronously, so
       * today the count above is decisive — but a State tab that loads its patch view lazily would
       * report zero placeholders while still mounting, and this shot would photograph the gap.
       * Waiting for the built root turns the absence of a placeholder into the presence of a tab.
       */
      await panel.locator('.agui-state').waitFor({ timeout: 5000 });
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
        'The caption promises a round trip — record, export, reopen — that the tab in the same ' +
          'image reports it cannot do. TWO separate things block it, and shipping export alone ' +
          'will not clear this: (1) export must exist, replacing "Export: not available in ' +
          'phase 1"; and (2) the harness must stop booting the panel under the `no-devtools` ' +
          'shim, because `resolveOrigin` returns early with no `chrome.devtools` ' +
          '(`app.tsx:53-59`) and capture therefore reports "unavailable in this build" no matter ' +
          'what the product ships. Expect this shot to keep failing on (2) after (1) lands.',
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
      /*
       * The grant prompt is checked FIRST, because it is what this shot is actually about. The
       * Session-tab check that follows is a second, independent condition: even with the prompt on
       * screen, a Detected column reading "not detected" four times over reads as "nothing works"
       * rather than "nothing is sent", which is the opposite of the caption.
       */
      await refuseWithoutGrantPrompt(panel);
      await refuseUnbuiltPanel(
        panel,
        'Beyond the grant prompt this shot needs, the tab it photographs must also stop ' +
          'reporting its own capabilities as absent: a column of "not detected" under "No ' +
          'network egress. Ever." reads as a broken product rather than a deliberate one.',
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
        /*
         * The 2× contract, stated where it can be violated. Nothing else checks it: `.frame` is
         * sized in `frame.css`, and editing that to anything but 1280×800 would leave this
         * silently squashing or stretching a differently shaped source into the store's exact
         * dimensions — producing a PNG that passes every size check while looking wrong. The raw
         * shot must be exactly twice the output.
         */
        if (image.naturalWidth !== (w as number) * 2 || image.naturalHeight !== (h as number) * 2) {
          throw new Error(
            `the raw screenshot is ${String(image.naturalWidth)}×${String(image.naturalHeight)}, ` +
              `expected exactly ${String((w as number) * 2)}×${String((h as number) * 2)} (the ` +
              'output size at deviceScaleFactor 2). Either `.frame` is no longer 1280×800 in ' +
              'frame.css, or the shot was taken at a different scale factor.',
          );
        }
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

    // Every reason to reject this shot is settled BEFORE anything reaches disk. The write used to
    // come first, and a panel that logged an error then left its PNG in `listing/out/` while the
    // run exited 1 — a rejected shot masquerading as a delivered asset, which is the exact
    // failure this script is supposed to make impossible. `main` deletes on the other paths.
    if (session.errors.length > 0) {
      throw new Error(`${shot.file}: the panel logged errors: ${session.errors.join(' | ')}`);
    }
    writeFileSync(join(outDir, shot.file), png);
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
        /*
         * A refused shot must leave NO file. Without this, a previously-good PNG survives in
         * `listing/out/` indefinitely once its shot starts failing — the run says "blocked", the
         * directory says "delivered", and the stale asset is the one that gets uploaded. That is
         * not hypothetical: shots 4 and 5 had to be deleted by hand when they were first refused,
         * which is the same bug arriving through a human instead of a crash.
         */
        rmSync(join(outDir, shot.file), { force: true });
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
