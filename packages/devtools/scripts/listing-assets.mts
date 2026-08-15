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
 * A storyboard entry the product cannot yet back FAILS THE RUN, and leaves no file behind. A
 * caption sits directly above the panel in the same image, so shooting one anyway produces an
 * asset that contradicts itself, which is the misleading-claim category that gets store
 * submissions rejected.
 *
 * Emitting the ones that work and leaving a human to notice the gallery is short is precisely the
 * failure this script exists to prevent, so a refusal exits 1 naming what must exist first. Four
 * good screenshots and a loud list of blockers beats five and a rejected submission.
 *
 * ALL FIVE RENDER TODAY, and a zero exit is now the expected result rather than a milestone. Do
 * not read that as the gates having been satisfied by loosening them: shot 5 was refused because
 * its subject — the per-origin capture grant offer — was unreachable under the `no-devtools` shim
 * and suppressed for an imported source. It is now shot with the `devtools-ungranted` shim and no
 * fixture at all, which is the extension's honest first-run state, and its gate tests that the
 * grant control is on screen and reads as an offer. If this run starts failing again, the refusal
 * text names the subject that went missing; making it pass by weakening the gate is the failure
 * mode this whole file is written against.
 *
 * The two promo tiles below (`TILES`) are NOT gated the same way, and that is deliberate rather
 * than an oversight: a screenshot photographs the built panel, so an entry the product cannot yet
 * back is a caption arguing with the pixels beneath it, which is exactly what the storyboard
 * refuses above. A tile is prose over a static mark — the same category of asset as
 * `listing/copy.md`'s store description, which already describes the finished tool rather than
 * today's build. That is why the marquee's copy can still claim the whole product in the same run
 * that refuses shot 5: one is a claim about an image, the other is a claim about the product's
 * destination. The gap between the tiles' prose and today's build is the same one the design doc
 * already records as a deferred requirement; closing it is a product task, not a bug in this
 * script.
 *
 * Run: `pnpm build && pnpm listing:assets`
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, FrameLocator } from 'playwright';
import { chromium } from 'playwright';
// The one source of truth for how many redaction groups shot 4 photographs. `redact.ts` is plain
// TypeScript with a single type-only import, so unlike a Preact component — importing one would
// drag JSX and the panel's whole module graph into a Node script — it costs nothing to import here,
// and a sixth group added to §11 makes shot 4's gate expect six without anyone remembering to.
import { ALL_REDACTION_GROUPS } from '../src/core/jsonl/redact';
import type { Session, ShimKind } from './panel-harness';
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
  /**
   * The `chrome` surface the panel boots against. Defaults to `no-devtools`, which is what four
   * of the five shots want: they photograph an imported capture, where the panel's Chrome-facing
   * state is irrelevant and the least shim is the most honest one.
   */
  shim?: ShimKind;
  /**
   * Import `listing/fixtures/demo.agui.jsonl` before driving. Defaults to true.
   *
   * Only shot 5 sets it false, and it MUST: `CaptureBanner` returns `null` outright for an
   * imported source (`capture-status.tsx:54`), so a shot whose subject is the capture banner
   * cannot also be a shot of a loaded file. A capture already on disk cannot depict the moment
   * someone opts an origin in.
   */
  importsFixture?: boolean;
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

/*
 * A whole-tab scan for unbuilt-capability wording used to live here, and it is GONE rather than
 * merely unused. It existed for shot 5 while that shot photographed the Session tab; shot 5 now
 * frames the capture banner over an empty Timeline, and `.agui-session` is not in the image at
 * all. A gate whose subject is off screen is the exact defect this file has already been bitten by
 * twice — shot 4 was once refused by two hardcoded Session rows that said nothing about export —
 * so keeping the scan "just in case" would leave a check that reads as covering this shot while
 * looking at a tab it never opens. `refuseWithoutGrantPrompt` below is shot 5's only gate, and it
 * looks at shot 5's only subject.
 */

/**
 * Refuse the export shot unless the export panel is actually OFFERING an export.
 *
 * Same principle as `refuseWithoutGrantPrompt` below, applied to shot 4's own subject. The panel
 * decides one thing — `exportBlockedReason` (`export/build.ts:183`) — and renders it three ways:
 * `.agui-export__blocked` carries the sentence, the group `<fieldset>` goes `disabled`, and every
 * action button goes `disabled`. All three are checked rather than one, because they are three
 * separate JSX expressions that can drift, and this shot photographs all three at once: a frame
 * full of greyed-out checkboxes under "Record a run. Replay it anywhere." is the self-contradicting
 * asset this script exists to refuse.
 *
 * The download button is matched by the extension in its label, not by position, because
 * `.agui.jsonl` is the exact string the caption promises. A rename that breaks this match is a
 * rename that invalidates the caption too, and a loud failure is the correct response to it — the
 * alternative, `.first()`, would keep passing while the button beneath it said something else.
 *
 * Nothing here scans for the tab's unbuilt-capability wording. Shot 4's frame is scrolled to the
 * export controls (see `drive`), and the rows that confess unbuilt discovery are not in it; gating
 * this shot on them was a gate that never looked at its own subject.
 */
async function refuseBlockedExport(panel: FrameLocator): Promise<void> {
  const blocked = panel.locator('.agui-export__blocked');
  if ((await blocked.count()) > 0) {
    throw new Error(
      `the export panel is refusing to export: "${(await blocked.innerText()).trim()}" — so this ` +
        'shot would caption a round trip over a control that is offering none. The demo fixture ' +
        'must import into records this panel can re-encode; re-run `pnpm listing:fixture`.',
    );
  }

  const download = panel.locator('.agui-export__actions button', { hasText: '.agui.jsonl' });
  if ((await download.count()) !== 1 || (await download.isDisabled())) {
    throw new Error(
      'the export panel offers no enabled `.agui.jsonl` download button, which is the literal ' +
        'promise of this caption. Either `export-panel.tsx` no longer labels the download with ' +
        'the extension, or it rendered the button disabled without also rendering ' +
        '`.agui-export__blocked` — in which case fix that divergence before re-running this.',
    );
  }

  const groups = panel.locator('.agui-export__group input[type="checkbox"]:enabled');
  const count = await groups.count();
  if (count !== ALL_REDACTION_GROUPS.length) {
    throw new Error(
      `the export panel shows ${String(count)} enabled redaction group checkboxes, expected ` +
        `${String(ALL_REDACTION_GROUPS.length)} (requirements §11's groups: ` +
        `${ALL_REDACTION_GROUPS.join(', ')}). They are what fills this frame and what the ` +
        'sub-caption describes, so a shot missing them shows the panel with its subject cropped ' +
        'out. A disabled `<fieldset>` disables every checkbox inside it, so this also catches an ' +
        'export blocked without the blocked sentence being rendered.',
    );
  }
}

/**
 * The one label that makes shot 5 the shot it claims to be: an OFFER, naming an ORIGIN.
 *
 * Anchored at both ends, because a partial match is how this check would go quietly wrong.
 * `capture-status.tsx:165` renders the same `.agui-banner__action` element on both capture-off
 * branches, and both label it `Enable capture for {origin}` — so a control that is present but
 * reads as anything else means the banner took a branch this shot's caption does not describe, and
 * that is a refusal rather than a detail. The origin half is not decoration either: "No network
 * egress. Ever." is a claim about a per-ORIGIN choice, and a button offering to enable capture
 * over nothing in particular would not show it.
 */
const GRANT_OFFER = /^Enable capture for https?:\/\/\S+$/;

/**
 * Refuse the privacy shot unless the per-origin capture grant offer is on screen and reads as one.
 *
 * This gate tests shot 5's only subject, and there is deliberately no second gate beside it.
 * "No network egress. Ever." is a claim about a CHOICE the user makes — design §5's prompt,
 * `Enable capture for <origin>` — and a screenshot that does not contain that prompt is arguing
 * the point in prose instead of showing it.
 *
 * `.agui-banner__action` is the grant control itself. `waitFor` rather than a bare `count()`: the
 * origin arrives through an `inspectedWindow.eval` CALLBACK (`app.tsx:35`), so the banner is on
 * its `unsupported` branch — no control at all — for the first frames after the panel mounts. A
 * point sample here would be a race that fails on a slow machine and, worse, could pass on a fast
 * one for the wrong reason.
 *
 * The count is asserted at exactly one so the label read below is unambiguous. Two banners on
 * screen would be a panel state nobody designed, and `innerText` on a multi-match locator throws
 * Playwright's strict-mode error — a message about selectors, in the one script whose whole job is
 * saying precisely why an asset was refused.
 */
async function refuseWithoutGrantPrompt(panel: FrameLocator): Promise<void> {
  const action = panel.locator('.agui-banner__action');
  try {
    await action.first().waitFor({ timeout: 5000 });
  } catch {
    // Swallowed on purpose: the count and label below produce the diagnosis, and Playwright's own
    // `locator.waitFor: Timeout 5000ms` names the selector without naming what it was for.
  }

  const count = await action.count();
  const label = count === 1 ? (await action.innerText()).trim() : '';
  if (count === 1 && GRANT_OFFER.test(label)) return;

  throw new Error(
    'the per-origin capture grant offer is not on screen, and it is the whole subject of this ' +
      'shot: privacy here is a choice the user is offered, not a sentence in a caption. Expected ' +
      'exactly one `.agui-banner__action` reading `Enable capture for <origin>` (design §5, ' +
      `\`capture-status.tsx:165\`); found ${String(count)}` +
      (count === 1 ? ` reading ${JSON.stringify(label)}` : '') +
      '. The banner only offers on its capture-`off` branch, which needs all three of: the ' +
      '`devtools-ungranted` shim (so `resolveOrigin` names an origin and capture leaves ' +
      '`unsupported`), a non-localhost origin (`grant.ts` auto-enables the localhost family ' +
      'straight to `on`), and no imported fixture (`capture-status.tsx:54` returns null for an ' +
      'imported source). Check which of those moved before changing this gate.',
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
    /*
     * The sub describes the redaction choice rather than repeating "reopen it on any machine",
     * because the frame is scrolled to the redaction controls and a caption should name what is
     * under it — the headline already carries the round trip. Every word of it is checked against
     * the build: the download button is literally "Download capture (.agui.jsonl)"; the five
     * groups are `ALL_REDACTION_GROUPS`, each its own checkbox; and "unless you say so" is the
     * fieldset's own legend, backed by `groups` starting empty in `export-panel.tsx:59`.
     */
    sub: 'Export it as .agui.jsonl — whole for yourself, or redacted group by group for a bug report.',
    scheme: 'light',
    async drive(panel) {
      await panel.locator('button[role="tab"][id="agui-tab-session"]').click();
      await panel.locator('.agui-export').waitFor({ timeout: 5000 });
      await refuseBlockedExport(panel);
      /*
       * Frame on the export section by driving the panel's own scroll container (`.agui-session`
       * is `overflow-y: auto`) — never by writing a `scrollTop`, which is a number that silently
       * means something else the next time a row is added above it.
       *
       * `block: 'start'` rather than `scrollIntoViewIfNeeded`, and the difference is the whole
       * shot. `scrollIntoViewIfNeeded` scrolls the MINIMUM, so on a section shorter than the
       * scroller — the export panel measures 362px in a 510px viewport — it stops as soon as the
       * section fits and leaves ~150px of whatever precedes it in frame. Photographed exactly once
       * that way, and what sat at the top of the card, directly beneath the words "Record a run",
       * was `Status: unavailable in this build`: the self-contradicting asset this script exists to
       * refuse, produced by a shot that had just passed its own gate. `block: 'start'` pins the
       * EXPORT heading to the top of the scroller instead, which is a stated alignment rather than
       * an emergent one. The unbuilt Detected and Capture rows go off the top edge; the Issues
       * grid, which is honest counts, takes the ~130px of slack at the bottom.
       *
       * The heading, not `.agui-export` itself, so the word EXPORT is in the frame — aligning the
       * root leaves the section's own label one pixel above the fold.
       *
       * This is also what makes the shot REPRODUCIBLE, which it was not before. `describeSource`
       * (`session.tsx:29`) renders `demo.agui.jsonl (imported 11:36:29 AM)` — a wall clock read at
       * import time, so this PNG's bytes changed on every run and every regeneration arrived in
       * review as a diff nobody could account for. That row is in the Source grid, which is now
       * scrolled off the top of the card. Nothing left in frame reads a clock: the summary line is
       * counts plus group names, and `exportedAtIso` is passed to `buildExport` but only ever lands
       * in the header of a file this shot never downloads.
       */
      await panel.locator('.agui-session__heading', { hasText: 'Export' }).evaluate((heading) => {
        heading.scrollIntoView({ block: 'start' });
      });
    },
  },
  {
    file: '5-privacy.png',
    headline: 'No network egress. Ever.',
    /*
     * The sub names what the frame actually foregrounds — the offer — rather than restating the
     * headline's absolutes. "Per-origin opt-in, offered up front" is the button in the image and
     * `grant.ts`'s decision D3. It stops deliberately short of "capture is off until you grant":
     * that is FALSE for the localhost family, which the manifest registers statically, and a
     * caption is not the place to carry an exception.
     *
     * The second half replaces "Nothing is uploaded, synced, or persisted to disk", which was
     * written when this shot was going to photograph the Session tab. In THIS frame the toolbar is
     * on screen with an `Export (unredacted)` button in it, and a flat "nothing is persisted to
     * disk" over a visible export control is a caption arguing with the pixels beneath it — the
     * one failure this whole script exists to refuse. `copy.md` is careful about exactly this and
     * says "Nothing on disk *by default*"; rather than compress that qualifier into a sub, the
     * clauses here are copy.md's own list under this same headline, each asserted by
     * `pnpm verify:build` against the built manifest: no static `host_permissions`, and no fetch
     * or telemetry anywhere in the panel or the service worker.
     */
    sub: 'Per-origin opt-in, offered up front. No remote host permissions, no fetch, no telemetry.',
    scheme: 'dark',
    /*
     * The two settings that make this shot possible, and neither is a convenience.
     *
     * `devtools-ungranted` is the minimum `chrome` surface that lets the panel NAME the inspected
     * origin; without it `resolveOrigin` returns early (`app.tsx:34`), capture stays `unsupported`,
     * and the banner renders the "only runs inside the DevTools panel" branch, which offers no
     * control at all. Importing nothing is the other half: `CaptureBanner` returns null for an
     * imported source, so this is the one storyboard entry that cannot load the demo fixture.
     *
     * What is left is the extension's honest first-run state — an empty panel offering to enable
     * capture on a site — and the empty timeline is the SUBJECT here, not a shortcoming. The tool
     * ships inert and asks before it does anything; a frame full of somebody's captured prompts
     * under "No network egress. Ever." would be arguing the opposite.
     *
     * It is also what makes this shot byte-reproducible. Nothing in frame reads a clock: the
     * origin is a constant in the shim, and `describeSource`'s `(imported 11:36:29 AM)` — the wall
     * clock that made shot 4 differ on every run — belongs to the Session tab, which is not opened
     * here and would in any case have no import to describe.
     */
    shim: 'devtools-ungranted',
    importsFixture: false,
    async drive(panel) {
      // No tab switch: the banner is shell chrome (`app.tsx:225`), rendered above the tab panel on
      // whichever tab is active, and Timeline's empty state is the rest of the story this frame
      // tells. Opening Session instead would push the offer up against a status table that says
      // nothing about consent.
      await refuseWithoutGrantPrompt(panel);
    },
  },
];

/**
 * Screenshot at 2× and resample to the exact pixel dimensions the store requires. Playwright
 * cannot downscale, and CWS accepts only exact pixel sizes per asset type — so a raw 2× shot is
 * rejected and a 1× shot renders text at half the quality this is capable of.
 *
 * `selector` and `doc` name nothing functional — they exist only so the size-mismatch error below
 * can point at the right file. Four call sites now share this function (`.frame` in
 * `screenshot.html`/`frame.css`, `.tile` in `tile.html`, `.marquee` in `marquee.html`), and a
 * message hard-coded to `.frame`/`frame.css` sent a reader chasing the wrong file for the other
 * three the day this stopped being screenshot-only.
 */
async function downsample(
  browser: Browser,
  png: Buffer,
  width: number,
  height: number,
  selector: string,
  doc: string,
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 8, height: 8 } });
  try {
    const dataUrl = await page.evaluate(
      async ([src, w, h, sel, source]) => {
        const image = new Image();
        image.src = src as string;
        await image.decode();
        /*
         * The 2× contract, stated where it can be violated. Nothing else checks it: the subject's
         * size is set in its own document, and editing that to anything but the expected size
         * would leave this silently squashing or stretching a differently shaped source into the
         * store's exact dimensions — producing a PNG that passes every size check while looking
         * wrong. The raw shot must be exactly twice the output.
         */
        if (image.naturalWidth !== (w as number) * 2 || image.naturalHeight !== (h as number) * 2) {
          throw new Error(
            `the raw screenshot is ${String(image.naturalWidth)}×${String(image.naturalHeight)}, ` +
              `expected exactly ${String((w as number) * 2)}×${String((h as number) * 2)} (the ` +
              `output size at deviceScaleFactor 2). Either \`${sel as string}\` is no longer ` +
              `${String(w as number)}×${String(h as number)} in ${source as string}, or the shot ` +
              'was taken at a different scale factor.',
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
      [`data:image/png;base64,${png.toString('base64')}`, width, height, selector, doc] as const,
    );
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } finally {
    await page.close();
  }
}

interface CaptureSpec {
  file: string;
  /** Element to screenshot. */
  selector: string;
  /** Where `selector`'s pixel size is set, so a mismatch error names the file to go fix. */
  doc: string;
  width: number;
  height: number;
}

/**
 * The shared tail of every asset this script produces: settle, screenshot, downsample, gate on
 * panel errors, write. `shoot` and `shootTile` differ only in how they get their subject on
 * screen — everything from here on is one function on purpose, so a third asset type added later
 * cannot quietly drop one of the three things a hand-rolled tail dropped here once already:
 *
 *   - the settle wait, which is not screenshot-specific — any DOM that just finished a driven
 *     interaction or a style-sheet load can still be mid-transition when the shutter fires;
 *   - the `session.errors` gate, whose absence let a `.tile` with a 404'd `img src` write a
 *     broken-image PNG and log it as a success, because nothing after the screenshot call ever
 *     looked at what the page itself had logged;
 *   - writing LAST. A throw from `downsample`'s own size check, or from the `screenshot()` call
 *     timing out because a selector stopped matching, must reach the caller before a single byte
 *     lands in `outDir` — see `main`'s catch blocks, which delete on the paths that throw before
 *     this function is even entered.
 *
 * Both incidents above were reproduced against `shootTile` before this function existed: a
 * renamed `.tile` selector left a stale, byte-identical PNG on disk under a FAILing run, and a
 * missing mark image wrote a corrupt tile that this script reported as delivered.
 */
async function capture(browser: Browser, session: Session, spec: CaptureSpec): Promise<void> {
  // Let streamed layout and any transition settle before the shutter.
  await session.page.waitForTimeout(250);

  const raw = await session.page.locator(spec.selector).screenshot();
  const png = await downsample(browser, raw, spec.width, spec.height, spec.selector, spec.doc);

  // Every reason to reject this asset is settled BEFORE anything reaches disk. The write used to
  // come first in `shoot`, and a panel that logged an error then left its PNG in `listing/out/`
  // while the run exited 1 — a rejected shot masquerading as a delivered asset, which is the
  // exact failure this script is supposed to make impossible.
  //
  // No `${spec.file}:` prefix here — `main`'s catch already prefixes every failure with the
  // asset's file name, and it is the only place that knows which asset was being attempted when
  // this throws. Prefixing here too used to print `promo-small-440x280.png: promo-small-440x280.
  // png: the panel logged errors: …`, a message that stutters in the one script whose entire job
  // is saying precisely why an asset was refused.
  if (session.errors.length > 0) {
    throw new Error(`the panel logged errors: ${session.errors.join(' | ')}`);
  }
  writeFileSync(join(outDir, spec.file), png);
}

async function shoot(browser: Browser, origin: string, shot: Shot): Promise<void> {
  const session = await openPanel(browser, origin, {
    scheme: shot.scheme,
    viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
    deviceScaleFactor: 2,
    url: `${origin}/listing/frames/screenshot.html`,
    // `addInitScript` applies to every frame in the context, which is what makes the iframed panel
    // boot under this shim rather than the outer document's.
    shim: shot.shim,
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
    if (shot.importsFixture !== false) await importFixture(panel, fixture);
    await shot.drive(panel);

    await capture(browser, session, {
      file: shot.file,
      selector: '.frame',
      doc: 'frame.css',
      width: SHOT_WIDTH,
      height: SHOT_HEIGHT,
    });
    console.log(`  ${shot.file}  ${shot.headline}`);
  } finally {
    await session.close();
  }
}

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
    await capture(browser, session, tile);
    console.log(`  ${tile.file}`);
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

    for (const tile of TILES) {
      try {
        await shootTile(browser, server.origin, tile);
      } catch (error) {
        // Same incident as the storyboard catch above, and this is the second time this file has
        // shipped this exact bug: a reviewer renamed `.tile` mid-development and got a `FAIL: 4 of
        // 5` run that nonetheless left a stale, byte-identical PNG sitting in `listing/out/` — the
        // run said "blocked", the directory said "delivered". `capture` writes last, but that only
        // protects failures that happen INSIDE it; `openPanel`'s `page.goto` can still throw on a
        // renamed or missing `doc` before `capture` is ever called, and that path needs the same
        // cleanup as the storyboard catch above.
        rmSync(join(outDir, tile.file), { force: true });
        failures.push(`${tile.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  // The real denominator: every asset this run attempted, not just the storyboard. Counting
  // against `STORYBOARD.length` alone used to print "FAIL: 4 of 5" the moment a tile failed too,
  // and would print "7 of 5" if every asset in both lists failed at once.
  const attempted = STORYBOARD.length + TILES.length;
  if (failures.length > 0) {
    console.error(`\nFAIL: ${String(failures.length)} of ${String(attempted)} assets:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }
  console.log(`\n${String(attempted)} assets written to ${outDir}`);
}

await main();
