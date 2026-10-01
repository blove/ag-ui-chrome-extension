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
 * ALL FIVE RENDER TODAY, and a zero exit is the expected result. Do not read that as the gates
 * having been satisfied by loosening them. The 0.2.0 storyboard replaced three of the 0.1 shots —
 * State and the privacy grant offer made way for LangGraph Platform and the UI inspector, and the
 * export shot moved onto a LangGraph capture — and the reason the export shot moved is itself a
 * gate doing its job: once the Threadplane test button shipped (§14.2), an AG-UI-only capture
 * renders that button disabled with its reason, and the old shot was refused rather than
 * photographed with a greyed-out control under its caption. If this run starts failing again, the
 * refusal text names the subject that went missing; making it pass by weakening the gate is the
 * failure mode this whole file is written against.
 *
 * Every shot photographs an IMPORTED capture under the `no-devtools` shim. None needs a
 * Threadplane development build or its page hook — Signals and Simulate are not in the gallery,
 * because no released Threadplane yet has the hook they read, and a screenshot of a view that is
 * empty for every user would argue with its own caption.
 *
 * The two promo tiles below (`TILES`) are NOT gated the same way, and that is deliberate rather
 * than an oversight: a screenshot photographs the built panel, so an entry the product cannot yet
 * back is a caption arguing with the pixels beneath it, which is exactly what the storyboard
 * refuses above. A tile is prose over a static mark — the same category of asset as
 * `listing/copy.md`'s store description, which already describes the finished tool rather than
 * today's build. That is why the marquee's copy can still claim the whole product in the same run
 * that refuses a shot: one is a claim about an image, the other is a claim about the product's
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
// The one source of truth for how many redaction groups shot 5 photographs. `redact.ts` is plain
// TypeScript with a single type-only import, so unlike a Preact component — importing one would
// drag JSX and the panel's whole module graph into a Node script — it costs nothing to import here,
// and a sixth group added to §11 makes shot 5's gate expect six without anyone remembering to.
import { ALL_REDACTION_GROUPS } from '../src/core/jsonl/redact';
import type { Session } from './panel-harness';
import { importFixture, openPanel, PANEL_PATH, startServer } from './panel-harness';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.PANEL_DIST ?? join(packageRoot, 'dist');
const listingDir = join(packageRoot, 'listing');
const outDir = process.env.LISTING_OUT ?? join(listingDir, 'out');
const fixturesDir = join(listingDir, 'fixtures');

const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 800;

interface Shot {
  file: string;
  headline: string;
  sub: string;
  scheme: 'light' | 'dark';
  /**
   * The capture to import, by file name under `listing/fixtures/` — each one written by
   * `pnpm listing:fixture` (`scripts/build-demo-fixture.ts`), which documents what every shot
   * relies on it to carry.
   */
  fixture: 'demo.agui.jsonl' | 'demo-langgraph.agui.jsonl' | 'demo-genui.agui.jsonl';
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
 * Refuse the export shot unless the export panel is actually OFFERING an export.
 *
 * Every gate here tests its own shot's subject; this one is shot 5's, the export panel. The panel
 * decides one thing — `exportBlockedReason` (`export/build.ts:183`) — and renders it three ways:
 * `.agui-export__blocked` carries the sentence, the group `<fieldset>` goes `disabled`, and every
 * action button goes `disabled`. All three are checked rather than one, because they are three
 * separate JSX expressions that can drift, and this shot photographs all three at once: a frame
 * full of greyed-out checkboxes under "Record a run. Replay it" is the self-contradicting
 * asset this script exists to refuse.
 *
 * The download button is matched by the extension in its label, not by position, because
 * `.agui.jsonl` is the exact string the caption promises. A rename that breaks this match is a
 * rename that invalidates the caption too, and a loud failure is the correct response to it — the
 * alternative, `.first()`, would keep passing while the button beneath it said something else.
 *
 * Nothing here scans for the tab's unbuilt-capability wording. Shot 5's frame is scrolled to the
 * export controls (see `drive`), and the rows that confess unbuilt discovery are not in it; gating
 * this shot on them was a gate that never looked at its own subject.
 */
async function refuseBlockedExport(panel: FrameLocator): Promise<void> {
  // By test id, not by `.agui-export__blocked`: the Threadplane button's own disabled reason
  // (`agui-export-threadplane-reason`) wears the same class, and matching the class refused this
  // shot on every AG-UI-only capture after §14.2 shipped — for a reason that is not the export's.
  // That reason is checked separately below, as the button this shot's caption names.
  const blocked = panel.locator('[data-testid="agui-export-blocked"]');
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

  const threadplane = panel.locator('.agui-export__actions button', {
    hasText: 'Download Threadplane test (.spec.ts)',
  });
  if ((await threadplane.count()) !== 1 || (await threadplane.isDisabled())) {
    const reason = panel.locator('[data-testid="agui-export-threadplane-reason"]');
    throw new Error(
      'the export panel offers no enabled `Download Threadplane test (.spec.ts)` button, and the ' +
        'sub-caption promises one. ' +
        ((await reason.count()) > 0
          ? `It says: "${(await reason.innerText()).trim()}" — this shot must import a capture with ` +
            'a LangGraph Platform connection (`demo-langgraph.agui.jsonl`).'
          : 'Either the label changed in `export-panel.tsx`, or the button is disabled with no reason shown.'),
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
 * Refuse the LangGraph shot unless the selected frame is shown the way its caption says: named by
 * its LangGraph SSE event, with the AG-UI events the panel derived from it listed beside it.
 *
 * `seq` 9 is the run's first message closing — a `messages` frame with an EMPTY chunk that the
 * panel reads as two AG-UI events, TOOL_CALL_END and TEXT_MESSAGE_END. That is the whole point of
 * the shot (nothing on the wire says either), so the gate names both, and a re-cut fixture that
 * moves them fails here rather than photographing a frame that derives nothing.
 */
const LANGGRAPH_SEQ = 9;
const LANGGRAPH_DERIVED = ['TOOL_CALL_END', 'TEXT_MESSAGE_END'];

async function refuseUnderivedFrame(panel: FrameLocator): Promise<void> {
  const badge = (await panel.locator('.agui-issue-badge__count').textContent())?.trim();
  if (badge !== '0 issues') {
    throw new Error(
      `the issue badge reads ${JSON.stringify(badge)}; the LangGraph demo capture is specified to be ` +
        'clean, and a red badge would put a finding in a shot about something else. Re-run ' +
        '`pnpm listing:fixture`.',
    );
  }
  const row = panel.locator(`.agui-event-row[data-seq="${String(LANGGRAPH_SEQ)}"]`);
  const label = (await row.innerText()).trim();
  if (!/^\d+\s+messages\b/.test(label)) {
    throw new Error(
      `row ${String(LANGGRAPH_SEQ)} reads ${JSON.stringify(label)}; it should be a \`messages\` frame, ` +
        'named by its LangGraph SSE event as the caption says.',
    );
  }
  const derived = panel.locator('section[aria-label="Derived"] li code');
  await derived.first().waitFor({ timeout: 5000 });
  const listed = await derived.allInnerTexts();
  if (LANGGRAPH_DERIVED.some((type) => !listed.includes(type))) {
    throw new Error(
      `the Derived section of seq ${String(LANGGRAPH_SEQ)} lists ${JSON.stringify(listed)}; this shot ` +
        `exists to show ${LANGGRAPH_DERIVED.join(' and ')} read off a frame that carries neither.`,
    );
  }
}

/**
 * Refuse the UI shot unless the inspector found what the caption says it finds: a component type
 * the app's own advertised catalog lacks, flagged EXACT (against that catalog, not the inferred
 * basic one), with the node it names badged `unknown type` in the tree.
 */
async function refuseWithoutCatalogFinding(panel: FrameLocator): Promise<void> {
  await panel.locator('.agui-ui__surface').first().waitFor({ timeout: 5000 });
  const finding = panel.locator('.agui-ui__finding[data-code="unknown_component"][data-basis="exact"]');
  const node = panel.locator('.agui-ui__node[data-state="unknown-type"]');
  if ((await finding.count()) === 0 || (await node.count()) === 0) {
    throw new Error(
      `the UI tab shows ${String(await finding.count())} exact unknown-component finding(s) and ` +
        `${String(await node.count())} node(s) badged unknown type; this shot needs at least one of ` +
        'each. `demo-genui.agui.jsonl` renders a DeliveryMap its advertised catalog does not define — ' +
        're-run `pnpm listing:fixture`, or check the catalog parse in `core/genui/catalog.ts`.',
    );
  }
}

const STORYBOARD: Shot[] = [
  {
    file: '1-timeline.png',
    headline: 'Every AG-UI event, decoded and in order',
    sub: 'Runs, steps, tool calls and state — grouped, timed, and inspectable.',
    scheme: 'light',
    fixture: 'demo.agui.jsonl',
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
    fixture: 'demo.agui.jsonl',
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
    file: '3-langgraph.png',
    headline: 'LangGraph Platform streams, read as AG-UI',
    /*
     * Both halves are on screen: the list names every row by its LangGraph SSE event (`metadata`,
     * `messages`, `updates`, `values`), and the detail pane's Derived section — in the panel's own
     * words, "derived by the panel, not sent on the wire" — lists the AG-UI events the selected
     * frame implies. `refuseUnderivedFrame` checks both.
     */
    sub: 'Every frame keeps its LangGraph name; the panel lists the AG-UI events each one implies.',
    scheme: 'light',
    fixture: 'demo-langgraph.agui.jsonl',
    async drive(panel) {
      await panel.locator(`.agui-event-row[data-seq="${String(LANGGRAPH_SEQ)}"]`).click();
      await waitForSelectedDetail(panel);
      await refuseUnderivedFrame(panel);
      // The Derived section sits under the payload, below the fold of a 604px card. Scroll the
      // detail pane's own scroller to it — `block: 'end'`, so the payload's tail stays above it
      // and the frame reads as one record rather than a list floating free of its source.
      await panel.locator('section[aria-label="Derived"]').evaluate((section) => {
        section.scrollIntoView({ block: 'end' });
      });
    },
  },
  {
    file: '4-ui.png',
    headline: 'Generative UI, component by component',
    /*
     * "A2UI surfaces" is the surface chip on screen; "the app's catalog" is the finding text
     * (`DeliveryMap is not in the app's catalog`), EXACT because the capture's request advertised
     * the catalog. Nothing here needs Threadplane's render report: the tab says on screen that an
     * imported capture's node states come from the wire checks.
     */
    sub: "A2UI surfaces as component trees, with the types the app's catalog lacks flagged.",
    scheme: 'light',
    fixture: 'demo-genui.agui.jsonl',
    async drive(panel) {
      await panel.locator('button[role="tab"][id="agui-tab-ui"]').click();
      await refuseWithoutCatalogFinding(panel);
    },
  },
  {
    file: '5-export.png',
    headline: 'Record a run. Replay it — or ship it as a test.',
    /*
     * Every clause is a control in frame: "redacted group by group" is the five checkboxes
     * (`ALL_REDACTION_GROUPS`); `.agui.jsonl` is the download button's own label; and "a
     * ready-to-run Threadplane test" is `Download Threadplane test (.spec.ts)`, enabled because
     * this capture has a LangGraph connection. "Ready-to-run" is held to account outside this
     * script: `pnpm verify:threadplane` generates this very capture's spec, plain and redacted,
     * and runs it inside a Threadplane checkout.
     */
    sub: 'Export .agui.jsonl, redacted group by group — or a LangGraph run as a ready-to-run Threadplane test.',
    scheme: 'light',
    fixture: 'demo-langgraph.agui.jsonl',
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
       * (`session.tsx:29`) renders `demo-langgraph.agui.jsonl (imported 11:36:29 AM)` — a wall clock read at
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
    await importFixture(panel, join(fixturesDir, shot.fixture));
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
  for (const shot of STORYBOARD) {
    const path = join(fixturesDir, shot.fixture);
    if (!existsSync(path)) {
      console.error(`FAIL: ${path} does not exist. Run \`pnpm listing:fixture\` first.`);
      process.exit(1);
    }
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
