/**
 * Screenshot the built panel, and fail if it is unstyled or if real data does not render.
 *
 * WHY THIS EXISTS. The previous milestone shipped a `dist/` whose panel had NO STYLESHEET at
 * all. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm verify:build` all
 * passed on it, because none of them renders anything: the panel document is isolated and
 * inherits nothing, so with no CSS it rendered as UA defaults — black text on a transparent
 * background, invisible under the DevTools dark theme. A human loading the extension and
 * looking at it was the only gate that caught it. This script is that gate, automated.
 *
 * It serves `dist/` over a local static server (ES modules will not load over `file://`),
 * installs a small `chrome` shim so the panel bundle runs outside DevTools, and then runs two
 * phases. The server and shim themselves live in `panel-harness.ts` — start debugging a serving
 * problem there, not here.
 *
 *   1. PAINT — load the panel once per colour scheme, assert the document is actually painted
 *      and that the two schemes differ, and write a PNG each.
 *   2. DATA  — drive the real UI: import the `happy-run` and `malformed` fixtures through the
 *      panel's own file input, assert the malformed capture annotates exactly the rows the
 *      validator flags and that the issue badge filters to them, and assert a partially decoded
 *      capture keeps saying so after the user leaves the tab it was imported on.
 *   3. EXPORT — click the real export controls and assert a real file arrives with real content.
 *      Design decision E1 chose `Blob` + `URL.createObjectURL` + a programmatic anchor precisely
 *      so that no `downloads` permission is needed, and flagged the mechanism as UNVERIFIED in a
 *      panel document. Nothing else in this repository can see whether it works: every unit test
 *      stubs the writer, because a jsdom `Blob` is not a browser download. This phase runs twice —
 *      over `dist/` served on http, and again with the REAL UNPACKED EXTENSION loaded, driving
 *      `chrome-extension://<id>/src/panel/panel.html`, which is the origin and the CSP a DevTools
 *      panel document actually has.
 *
 * Each phase is skipped when an earlier one fails: there is no point asserting on rows in a panel
 * that is not painting at all, and the earlier output is the diagnosis.
 *
 * Run: `pnpm build && pnpm screenshot:panel` (first run also needs
 * `pnpm exec playwright install chromium-headless-shell` — the shell is what a default headless
 * `chromium.launch()` resolves to, and it is what CI installs). `PANEL_DIST` points it at a
 * different build, which is how the gate itself is tested against a deliberately unstyled variant.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { importFixture, openPanel, PANEL_PATH, startServer } from './panel-harness';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.PANEL_DIST ?? join(packageRoot, 'dist');
const outDir = process.env.PANEL_SHOTS ?? join(packageRoot, '.screenshots');
const fixtureDir = join(packageRoot, 'src/test/fixtures');

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function seqsOf(page: Page, selector: string): Promise<number[]> {
  return page.$$eval(selector, (els) =>
    els.map((el) => Number(el.getAttribute('data-seq') ?? '-1')),
  );
}

/* -------------------------------------------------------------------------- */
/* Phase 1 — is the panel painted at all, and does it follow the theme?        */
/* -------------------------------------------------------------------------- */

async function checkPaint(browser: Browser, origin: string, htmlMentionsCss: boolean) {
  const painted: Record<string, string> = {};

  for (const scheme of ['light', 'dark'] as const) {
    const session = await openPanel(browser, origin, { scheme });
    const probe = await session.page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return {
        background: body.backgroundColor,
        color: body.color,
        text: (document.body.innerText || '').trim().length,
        height: document.body.getBoundingClientRect().height,
      };
    });

    await session.page.screenshot({ path: join(outDir, `panel-${scheme}.png`), fullPage: true });

    if (session.errors.length > 0) {
      fail(`panel logged errors in ${scheme} scheme: ${session.errors.join(' | ')}`);
    }
    // Transparent body means no stylesheet reached the document.
    if (probe.background === 'rgba(0, 0, 0, 0)' || probe.background === 'transparent') {
      fail(
        `body has no background colour in ${scheme} scheme — the panel is unstyled, which is ` +
          'invisible under the DevTools dark theme. ' +
          (htmlMentionsCss
            ? `dist/${PANEL_PATH} does reference a stylesheet, so it failed to load.`
            : `dist/${PANEL_PATH} references no stylesheet at all.`),
      );
    }
    if (probe.text < 20) {
      fail(`panel rendered ${String(probe.text)} characters in ${scheme} scheme.`);
    }
    if (probe.height < 100) {
      fail(`panel body is ${String(probe.height)}px tall in ${scheme} scheme.`);
    }
    // Requirements §11: the panel makes no request of its own. Everything it fetches must be
    // the local server serving dist/ — no CDN font, no telemetry, no analytics beacon.
    const offSite = session.requests.filter((url) => !url.startsWith(origin));
    if (offSite.length > 0) {
      fail(`panel issued off-origin requests in ${scheme} scheme: ${offSite.join(', ')}`);
    }
    painted[scheme] = `${probe.background} / ${probe.color}`;
    await session.close();
  }

  // A theme-blind panel passes every check above while ignoring the DevTools theme entirely.
  if (painted.light === painted.dark) {
    fail(
      `light and dark render identically (${String(painted.light)}). The panel is not ` +
        'responding to prefers-color-scheme, which is how Chrome propagates the DevTools theme.',
    );
  }

  return painted;
}

/**
 * Controls the panel styles but cannot reach from here.
 *
 * `.agui-app__note-action` is the Reload button offered after a successful origin grant. That
 * state needs a real `chrome.permissions` grant, which this harness has no way to produce — so
 * without this check the one control the live-capture task added to the note band would ship
 * unverified, which is exactly the class of regression this gate exists for (a control present
 * in the markup and completely unstyled). The element is mounted directly and asked whether the
 * stylesheet reached it.
 */
async function checkUnreachableControls(browser: Browser, origin: string): Promise<void> {
  const session = await openPanel(browser, origin, { scheme: 'light' });
  try {
    /*
     * The banner's own action is the reference: it is already covered by this gate, and the note
     * action is deliberately the same control minus a top margin. Written as a `map` over an
     * inline arrow rather than a named helper — esbuild's `keepNames` rewrites a named function
     * to reference `__name`, which does not exist in the page.
     */
    const [note, banner] = await session.page.evaluate(() =>
      ['agui-app__note-action', 'agui-banner__action'].map((className) => {
        const button = document.createElement('button');
        button.className = className;
        button.textContent = 'Reload the inspected page';
        document.body.append(button);
        const style = getComputedStyle(button);
        const read: Record<string, string> = {
          color: style.color,
          borderColor: style.borderTopColor,
          cursor: style.cursor,
        };
        button.remove();
        return read;
      }),
    );

    if (note === undefined || banner === undefined) {
      fail('could not measure .agui-app__note-action against .agui-banner__action.');
      return;
    }
    for (const [property, value] of Object.entries(note)) {
      const reference = banner[property];
      if (value !== reference) {
        fail(
          `.agui-app__note-action ${property} is ${value}, but .agui-banner__action — the same ` +
            `control, one band up — is ${String(reference)}. The Reload button offered after an ` +
            'origin grant is not picking up its rule.',
        );
      }
    }
  } finally {
    await session.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — does real data actually render?                                   */
/* -------------------------------------------------------------------------- */

/** The malformed fixture's three validator errors, by the seq each is anchored to. */
const MALFORMED_ISSUE_SEQS = [5, 9, 10];

async function checkFixtures(browser: Browser, origin: string): Promise<void> {
  /* --- happy-run: fifteen rows, nothing annotated, badge silent ----------- */
  {
    const session = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(session.page, join(fixtureDir, 'happy-run.agui.jsonl'));
    await session.page.screenshot({ path: join(outDir, 'timeline-happy.png'), fullPage: true });

    const rows = await seqsOf(session.page, '.agui-event-row');
    if (rows.length !== 15) {
      fail(`happy-run rendered ${String(rows.length)} event rows, expected 15.`);
    }
    const annotated = await seqsOf(session.page, '.agui-event-row[data-severity]');
    if (annotated.length !== 0) {
      fail(`happy-run annotated rows ${annotated.join(', ')}; it is a clean capture.`);
    }
    const badge = (await session.page.textContent('.agui-issue-badge__count'))?.trim();
    if (badge !== '0 issues') {
      fail(`happy-run issue badge reads ${JSON.stringify(badge)}, expected "0 issues".`);
    }
    if (await session.page.isVisible('.agui-app__load-error')) {
      fail('happy-run raised a load error; every line of it decodes.');
    }

    // The Session tab keeps its drop zone mounted, so it is where the "every line decoded"
    // confirmation survives being looked at.
    await session.page.click('button[role="tab"][id="agui-tab-session"]');
    await session.page.waitForSelector('.agui-session');
    await session.page.screenshot({ path: join(outDir, 'session-happy.png'), fullPage: true });

    if (session.errors.length > 0) {
      fail(`importing happy-run logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- malformed: three annotated rows, and the badge filters to them ----- */
  {
    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, join(fixtureDir, 'malformed.agui.jsonl'));
    await session.page.screenshot({ path: join(outDir, 'timeline-malformed.png'), fullPage: true });

    const annotated = await seqsOf(session.page, '.agui-event-row[data-severity]');
    if (annotated.join(',') !== MALFORMED_ISSUE_SEQS.join(',')) {
      fail(
        `malformed annotated seqs [${annotated.join(', ')}], expected ` +
          `[${MALFORMED_ISSUE_SEQS.join(', ')}]. The row tint is how a protocol error is visible ` +
          'in the timeline at all.',
      );
    }
    const badge = (await session.page.textContent('.agui-issue-badge__count'))?.trim();
    if (badge !== '3 issues') {
      fail(`malformed issue badge reads ${JSON.stringify(badge)}, expected "3 issues".`);
    }

    await session.page.click('.agui-issue-badge');
    await session.page.waitForFunction(
      () => document.querySelectorAll('.agui-event-row').length === 3,
      undefined,
      { timeout: 5000 },
    );
    const filtered = await seqsOf(session.page, '.agui-event-row');
    if (filtered.join(',') !== MALFORMED_ISSUE_SEQS.join(',')) {
      fail(
        `the issues-only filter left seqs [${filtered.join(', ')}], expected ` +
          `[${MALFORMED_ISSUE_SEQS.join(', ')}].`,
      );
    }
    await session.page.screenshot({
      path: join(outDir, 'timeline-malformed-filtered.png'),
      fullPage: true,
    });

    if (session.errors.length > 0) {
      fail(`importing malformed logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- a partial decode must not look clean, from any tab ----------------- */
  {
    // One good line and one that is not JSON at all. The decoder is specified to keep going,
    // which is what makes a truncated capture openable — and what makes saying so mandatory.
    const partialPath = join(outDir, 'partial.agui.jsonl');
    writeFileSync(
      partialPath,
      `${readFileSync(join(fixtureDir, 'happy-run.agui.jsonl'), 'utf8')}{ not json\n`,
      'utf8',
    );

    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, partialPath);
    const onImport = (await session.page.textContent('.agui-app__load-error'))?.trim() ?? '';
    if (!/1 line could not be decoded/i.test(onImport)) {
      fail(
        'a partial decode did not say so on import; the shell alert read ' +
          `${JSON.stringify(onImport)}.`,
      );
    }

    // The drop zone that showed the per-line detail unmounts with the tab. The summary must not.
    await session.page.click('button[role="tab"][id="agui-tab-runs"]');
    await session.page.waitForSelector('.agui-runs');
    const afterSwitch = (await session.page.textContent('.agui-app__load-error'))?.trim() ?? '';
    if (!/1 line could not be decoded/i.test(afterSwitch)) {
      fail(
        'the partial-decode warning did not survive a tab switch — an incomplete capture would ' +
          'render exactly like a clean one from every tab but the one it was imported on.',
      );
    }
    await session.page.screenshot({ path: join(outDir, 'partial-import.png'), fullPage: true });

    if (session.errors.length > 0) {
      fail(`importing a partial capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 2b — Messages (§9.4, design decisions M1–M5)                          */
/* -------------------------------------------------------------------------- */

/** Open the Messages tab and wait for it. */
async function openMessages(page: Page): Promise<void> {
  await page.click('button[role="tab"][id="agui-tab-messages"]');
  await page.waitForSelector('.agui-messages');
}

/** `kind:id` for every conversation row, in DOM order — M1's ordering, as rendered. */
function messageRows(page: Page): Promise<string[]> {
  return page.$$eval('[data-item-id]', (els) =>
    els.map(
      (el) =>
        `${el.getAttribute('data-item-kind') ?? '?'}:${el.getAttribute('data-item-id') ?? '?'}`,
    ),
  );
}

/**
 * Messages renders, in every state the design's §8 names.
 *
 * The unit tests already assert the markup. What only a browser can say is whether any of it is
 * VISIBLE: this project shipped a panel with no stylesheet at all, and a tab that renders nothing
 * is indistinguishable from a tab that renders correctly to every gate but this one. So the
 * assertions below are deliberately about paint — that the M2 verdict has a background of its
 * own, that a failed row is tinted differently from the row above it — rather than about the DOM.
 *
 * Live capture is the one §8 state not reachable here: it needs `chrome.runtime.connect` and a
 * service worker feeding records, which this harness has no way to produce. It is covered in
 * `messages.test.tsx` instead, which drives the tab with `source.kind === 'live'`.
 */
async function checkMessages(browser: Browser, origin: string): Promise<void> {
  /* --- empty: it explains itself rather than showing a blank pane --------- */
  {
    const session = await openPanel(browser, origin, { scheme: 'light' });
    await openMessages(session.page);
    const text = (await session.page.textContent('.agui-messages'))?.trim() ?? '';
    if (!/no runs to show/i.test(text)) {
      fail(`the empty Messages tab reads ${JSON.stringify(text)}, expected it to say so.`);
    }
    await session.page.screenshot({ path: join(outDir, 'messages-empty.png'), fullPage: true });
    if (session.errors.length > 0) {
      fail(`the empty Messages tab logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- an imported capture: order, content, and the jump to Timeline ------ */
  {
    const session = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(session.page, join(fixtureDir, 'happy-run.agui.jsonl'));
    await openMessages(session.page);
    await session.page.screenshot({ path: join(outDir, 'messages-happy.png'), fullPage: true });

    const rows = await messageRows(session.page);
    if (rows.join(',') !== 'input:m_user_1,message:m_1,tool:tc_1') {
      fail(
        `Messages rendered rows [${rows.join(', ')}], expected the request turn, then m_1, then ` +
          'tc_1 at its position in time (M1).',
      );
    }

    // The reconstructed text, on screen. `innerText` rather than `textContent`: it is what a
    // reader can actually see, so a rule that hid the body would fail here.
    const shown = await session.page.$eval('.agui-messages', (el) => (el as HTMLElement).innerText);
    if (!shown.includes('The weather in Paris is sunny and 24 degrees.')) {
      fail('the assistant message is not visible in Messages — its text did not render.');
    }
    if (!shown.includes('arguments parsed')) {
      fail('the M2 arguments verdict is not visible on a clean tool call.');
    }

    // M5: the whole workflow, driven end to end.
    await session.page.click('button[aria-label="Show m_1 in Timeline"]');
    await session.page.waitForSelector('.agui-timeline');
    const selected = await seqsOf(session.page, '.agui-event-row[aria-selected="true"]');
    if (selected.join(',') !== '3') {
      fail(
        `clicking through from m_1 selected seqs [${selected.join(', ')}] in Timeline, expected ` +
          '[3] — the first of its contentSeqs (M5).',
      );
    }
    const scope = (await session.page.textContent('.agui-run-selector__trigger'))?.trim() ?? '';
    if (!scope.includes('r_happy')) {
      fail(
        `the jump from Messages left the run scope reading ${JSON.stringify(scope)}. Without the ` +
          'scope the frame can be filtered off screen the moment the user arrives.',
      );
    }
    await session.page.screenshot({
      path: join(outDir, 'messages-located.png'),
      fullPage: true,
    });

    if (session.errors.length > 0) {
      fail(`Messages on an imported capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- a run carrying issues: M2's failure, M3's reasoning, M4's streaming - */
  {
    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, join(fixtureDir, 'messages-edge.agui.jsonl'));
    await openMessages(session.page);
    await session.page.screenshot({ path: join(outDir, 'messages-edge.png'), fullPage: true });

    /*
     * Every helper here is an inline arrow passed straight to `map`. A named local — even
     * `const read = (el) => …` — is rewritten by esbuild's `keepNames` into a call to `__name`,
     * which does not exist in the page. `checkUnreachableControls` above hit the same wall.
     */
    const [failedRow, chipBackground, plainRow, flagBackground] = await session.page.evaluate(() =>
      [
        '[data-args="failed"]',
        '[data-args="failed"] .agui-tool__status',
        '.agui-msg',
        '.agui-msg__flag[data-flag="streaming"]',
      ].map((selector) => {
        const el = document.querySelector(selector);
        return el === null ? 'MISSING' : getComputedStyle(el).backgroundColor;
      }),
    );
    const [chipColour, bodyColour] = await session.page.evaluate(() =>
      ['[data-args="failed"] .agui-tool__status', 'body'].map((selector) => {
        const el = document.querySelector(selector);
        return el === null ? 'MISSING' : getComputedStyle(el).color;
      }),
    );
    const paint = {
      failedRow: failedRow ?? 'MISSING',
      chipBackground: chipBackground ?? 'MISSING',
      chipColour: chipColour ?? 'MISSING',
      plainRow: plainRow ?? 'MISSING',
      flagBackground: flagBackground ?? 'MISSING',
      bodyColour: bodyColour ?? 'MISSING',
    };

    if (paint.failedRow === 'MISSING') {
      fail('no tool call is marked [data-args="failed"] on the messages-edge capture (M2).');
    } else if (paint.failedRow === paint.plainRow) {
      fail(
        `a tool call whose arguments never parsed is drawn on ${paint.failedRow}, exactly like ` +
          'the message row above it. M2 calls this "the bug this tab exists to make obvious"; ' +
          'an untinted row is not obvious at all.',
      );
    }
    if (paint.chipBackground === 'rgba(0, 0, 0, 0)' || paint.chipColour === paint.bodyColour) {
      fail(
        `the "arguments never parsed" chip is unstyled (background ${paint.chipBackground}, ` +
          `colour ${paint.chipColour} against body ${paint.bodyColour}).`,
      );
    }
    if (paint.flagBackground === 'MISSING' || paint.flagBackground === 'rgba(0, 0, 0, 0)') {
      fail(
        `M4's streaming flag has background ${paint.flagBackground} — a message that never ` +
          'closed is rendered exactly like a complete one.',
      );
    }

    const collapsed = await session.page.$eval('.agui-messages', (el) => (el as HTMLElement).innerText);
    if (!collapsed.includes('arguments never parsed') || !collapsed.includes('streaming')) {
      fail('M2 and M4 do not state themselves in the collapsed rows.');
    }
    // M3: the reasoning body is not merely hidden, it is not built.
    if (collapsed.includes('The user asked for Paris')) {
      fail('the reasoning body is rendered before it is asked for (M3 collapses it by default).');
    }
    await session.page.click('button[aria-label="Reasoning m_think"]');
    await session.page.waitForSelector('[data-testid="content-m_think"]');
    const expanded = await session.page.$eval('.agui-messages', (el) => (el as HTMLElement).innerText);
    if (!expanded.includes('The user asked for Paris')) {
      fail('expanding the reasoning message did not reveal its content.');
    }
    await session.page.screenshot({
      path: join(outDir, 'messages-edge-expanded.png'),
      fullPage: true,
    });

    if (session.errors.length > 0) {
      fail(`Messages on a run carrying issues logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- a redacted capture, produced by the real export and re-imported ---- */
  {
    const producer = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(producer.page, join(fixtureDir, 'happy-run.agui.jsonl'));
    await producer.page.click('button[role="tab"][id="agui-tab-session"]');
    await producer.page.waitForSelector('.agui-export');
    await producer.page.click('.agui-export__groups button:has-text("Redact everything")');
    const saved = await clickAndSave(
      producer.page,
      'button:has-text("Download capture")',
      'Messages (redacted)',
    );
    await producer.close();
    if (saved === null) return;

    const redactedPath = join(outDir, 'messages-redacted.agui.jsonl');
    writeFileSync(redactedPath, saved.text, 'utf8');

    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, redactedPath);
    await openMessages(session.page);
    await session.page.screenshot({ path: join(outDir, 'messages-redacted.png'), fullPage: true });

    const shown = await session.page.$eval('.agui-messages', (el) => (el as HTMLElement).innerText);
    if (shown.includes('The weather in Paris')) {
      fail('a redacted capture renders the original message text in Messages.');
    }
    if (!shown.includes('«redacted:')) {
      fail(
        'a redacted capture shows no placeholder in Messages — a turn drawn blank is ' +
          'indistinguishable from a turn that was never sent.',
      );
    }
    if (!shown.includes('get_weather')) {
      fail('a redacted capture lost the tool name; §11 keeps structure, ids and ordering.');
    }
    /*
     * The single most important thing this tab must not do to a shared bug report.
     *
     * `«redacted: 16 chars»` is not JSON, so a redacted capture's tool arguments genuinely do
     * not parse. Reporting that as "arguments never parsed" would send the colleague the file
     * was shared with hunting a protocol bug the redactor caused.
     */
    if (!shown.includes('arguments redacted') || shown.includes('arguments never parsed')) {
      fail(
        'a redacted capture reports its tool arguments as a parse failure. That is a finding ' +
          'about the exporter, presented as a finding about the user’s agent.',
      );
    }

    /*
     * THE SAME CLAIM, ON THE SURFACES THE RECIPIENT ACTUALLY READS.
     *
     * `happy-run` is clean. Its redacted export is the file a colleague is handed, and they see
     * the badge and the run heading long before they open a tool call's arguments. Messages was
     * honest here while the badge, the heading and the Timeline tint all asserted
     * `tool-args-not-json` — an error the redactor caused. A tab that declines the claim while
     * the toolbar above it makes the claim is not a fix; this is the assertion that the two
     * halves say one thing.
     */
    const runIssues = await session.page.$('[data-testid="run-issues-r_happy"]');
    if (runIssues !== null) {
      const text = ((await runIssues.innerText()) || '').trim();
      fail(
        `the Messages run heading on a redacted CLEAN capture reads ${JSON.stringify(text)}. ` +
          'The run it was exported from had no issues at all.',
      );
    }

    await session.page.click('button[role="tab"][id="agui-tab-timeline"]');
    await session.page.waitForSelector('.agui-timeline');
    await session.page.screenshot({
      path: join(outDir, 'timeline-redacted.png'),
      fullPage: true,
    });

    const redactedBadge = (await session.page.textContent('.agui-issue-badge__count'))?.trim();
    if (redactedBadge !== '0 issues') {
      fail(
        `a redacted export of the CLEAN happy-run capture shows ${JSON.stringify(redactedBadge)} ` +
          'in the issue badge. Redaction removes evidence; it must not add findings. The reader ' +
          'of a shared bug report never sees the export-time warning — the file is all they get.',
      );
    }
    const redactedTone = await session.page.getAttribute('.agui-issue-badge', 'data-tone');
    if (redactedTone !== 'none') {
      fail(
        `the issue badge on a redacted clean capture has tone ${JSON.stringify(redactedTone)}, ` +
          'expected "none". The one red thing in the panel always means a protocol error.',
      );
    }
    const redactedRows = await seqsOf(session.page, '.agui-event-row[data-severity]');
    if (redactedRows.length !== 0) {
      fail(
        `a redacted export of the clean happy-run capture tints seqs [${redactedRows.join(', ')}] ` +
          'in the Timeline. The row tint is an accusation about the frame it sits on.',
      );
    }

    if (session.errors.length > 0) {
      fail(`Messages on a redacted capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 2c — State (§9.3, design decisions S1–S4)                             */
/* -------------------------------------------------------------------------- */

/** Open the State tab and wait for it. */
async function openState(page: Page): Promise<void> {
  await page.click('button[role="tab"][id="agui-tab-state"]');
  await page.waitForSelector('.agui-state');
}

interface Tick {
  index: number;
  failed: boolean;
  kind: string;
  /** Centre of the tick in page pixels, and the track it sits in. */
  centreX: number;
  trackLeft: number;
  trackWidth: number;
  background: string;
}

/**
 * Every scrubber position as it is actually laid out and painted.
 *
 * Geometry, not markup. §9.3's requirement is that a failed patch is marked "at its position on
 * the scrubber", and a `data-failed` attribute proves neither half of that: the unit tests already
 * assert the attribute, and a strip whose ticks all stacked at x=0, or whose failed rule never
 * reached the document, would satisfy every one of them while showing the reader nothing.
 */
function scrubberTicks(page: Page): Promise<Tick[]> {
  return page.$$eval('.agui-scrub__tick', (els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      const track = el.parentElement?.getBoundingClientRect();
      return {
        index: Number(el.getAttribute('data-index') ?? '-1'),
        failed: el.getAttribute('data-failed') === 'true',
        kind: el.getAttribute('data-kind') ?? '?',
        centreX: box.left + box.width / 2,
        trackLeft: track?.left ?? 0,
        trackWidth: track?.width ?? 0,
        background: getComputedStyle(el).backgroundColor,
      };
    }),
  );
}

/**
 * State renders, in every state design §8 names.
 *
 * The load-bearing assertion is S3: that a failed patch is VISIBLE, in red, at the position on the
 * scrubber where it happened. Everything about that claim is invisible to every other gate — the
 * unit tests see the attribute but not the paint, and `verify:build` sees neither.
 *
 * Live capture is the one §8 state not reachable here: it needs `chrome.runtime.connect` and a
 * service worker feeding records. It is covered in `state.test.tsx`, which drives the tab with
 * `source.kind === 'live'`.
 */
async function checkState(browser: Browser, origin: string): Promise<void> {
  /* --- empty: it explains itself rather than showing a blank pane --------- */
  {
    const session = await openPanel(browser, origin, { scheme: 'light' });
    await openState(session.page);
    const text = (await session.page.textContent('.agui-state'))?.trim() ?? '';
    if (!/no runs to show/i.test(text)) {
      fail(`the empty State tab reads ${JSON.stringify(text)}, expected it to say so.`);
    }
    await session.page.screenshot({ path: join(outDir, 'state-empty.png'), fullPage: true });
    if (session.errors.length > 0) {
      fail(`the empty State tab logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- a run whose state broke twice, mid-timeline (S1, S2, S3) ----------- */
  {
    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, join(fixtureDir, 'state-edge.agui.jsonl'));
    await openState(session.page);
    await session.page.screenshot({ path: join(outDir, 'state-edge.png'), fullPage: true });

    const ticks = await scrubberTicks(session.page);
    if (ticks.length !== 7) {
      fail(`the scrubber drew ${String(ticks.length)} positions for a 7-frame timeline (S1).`);
    }

    // Laid out along the track, left to right. Ticks that all shared an x would carry no
    // positional information at all, which is the whole of S3.
    const ordered = ticks.every((tick, i) => i === 0 || tick.centreX > (ticks[i - 1]?.centreX ?? 0));
    if (!ordered) {
      fail(
        `the scrubber's positions are not laid out left to right: centres ` +
          `[${ticks.map((tick) => Math.round(tick.centreX)).join(', ')}]. A strip whose ticks ` +
          'share an x marks nothing "at its position".',
      );
    }

    const failedIndices = ticks.filter((tick) => tick.failed).map((tick) => tick.index);
    if (failedIndices.join(',') !== '3,5') {
      fail(
        `the scrubber marked positions [${failedIndices.join(', ')}] failed, expected [3, 5] — ` +
          'the state-edge capture refuses a patch at frame 4 and again at frame 6 of 7.',
      );
    }

    const firstFailed = ticks.find((tick) => tick.failed);
    /*
     * The comparison has to be against a position of the SAME kind.
     *
     * Measured, by deleting the `[data-failed='true']` rule and re-running this gate: a failed
     * delta tick reverts to the plain tick background, which still differs from the SNAPSHOT
     * tick's — so comparing against "the first surviving position" passed a panel with no red in
     * it at all. Every surviving delta is the honest reference.
     */
    const survivingDeltas = ticks.filter((tick) => !tick.failed && tick.kind === 'delta');
    const firstOk = survivingDeltas[0];
    if (firstFailed === undefined || firstOk === undefined) {
      fail('the state-edge scrubber has no failed position, or no surviving delta, to compare.');
    } else {
      // The point of §9.3, measured: the mark is where the failure happened, not summarized at
      // the end. Frame 4 of 7 sits just past the middle of the track.
      const fraction =
        firstFailed.trackWidth === 0
          ? -1
          : (firstFailed.centreX - firstFailed.trackLeft) / firstFailed.trackWidth;
      if (fraction < 0.3 || fraction > 0.7) {
        fail(
          `the first failed position sits ${(fraction * 100).toFixed(0)}% along the scrubber, ` +
            'expected the middle third. Frame 4 of 7 is where state broke; a mark anywhere else ' +
            'is a mark the reader has to scrub to interpret.',
        );
      }
      const clash = survivingDeltas.find((tick) => tick.background === firstFailed.background);
      if (clash !== undefined) {
        fail(
          `a failed position is painted ${firstFailed.background}, exactly like position ` +
            `${String(clash.index)}, whose patch applied. §9.3 asks for failed patches marked RED ` +
            'at their position; an unmarked tick is indistinguishable from a clean timeline.',
        );
      }
      if (
        firstFailed.background === 'rgba(0, 0, 0, 0)' ||
        firstFailed.background === 'transparent'
      ) {
        fail('the failed scrubber position has no background at all — its rule did not reach it.');
      }
    }

    // The headline, before anything is clicked.
    const headline = await session.page.$eval('.agui-state', (el) => (el as HTMLElement).innerText);
    if (!headline.includes('2 failed patches')) {
      fail('the State tab does not say how many patches failed before the reader scrubs.');
    }
    // S1: the tab opens on the latest frame, which is the current reconstructed state (§9.3).
    if (!headline.includes('Frame 7 of 7')) {
      fail(`the State tab did not open on the current state; it reads ${JSON.stringify(headline)}.`);
    }

    /* --- S2: scrub to the failure and read what broke --------------------- */
    await session.page.click('.agui-scrub__tick[data-index="3"]');
    await session.page.waitForSelector('[data-testid="failure-r_state"]');
    await session.page.screenshot({ path: join(outDir, 'state-failed-frame.png'), fullPage: true });

    const atFailure = await session.page.$eval(
      '.agui-state',
      (el) => (el as HTMLElement).innerText,
    );
    if (!/operation 2 of 2 failed/i.test(atFailure)) {
      fail(
        'the failed frame does not name WHICH operation failed. The patch has two ops and only ' +
          'the second is the bug (S2).',
      );
    }
    if (!/did not advance/i.test(atFailure)) {
      fail(
        'the failed frame does not say state did not advance past it. The document shown is the ' +
          'PREVIOUS frame’s by design, and a reader who took it for this patch’s result ' +
          'would be reading a document the patch never produced.',
      );
    }
    if (!atFailure.includes('/missing/child')) {
      fail('the failing op’s path is not on screen at the failed frame.');
    }

    const [failedOp, okOp] = await session.page.evaluate(() =>
      ['.agui-op[data-failed="true"]', '.agui-op[data-failed="false"]'].map((selector) => {
        const el = document.querySelector(selector);
        return el === null ? 'MISSING' : getComputedStyle(el).backgroundColor;
      }),
    );
    if (failedOp === 'MISSING' || failedOp === okOp) {
      fail(
        `the op that failed is painted ${String(failedOp)} and the one that applied ` +
          `${String(okOp)}. S2 marks the failing op in place; an unmarked one leaves the reader ` +
          'to count.',
      );
    }

    /* --- S1: scrubbing back really changes the document ------------------- */
    await session.page.click('.agui-scrub__tick[data-index="0"]');
    await session.page.waitForSelector('[data-testid="frame-r_state"][data-kind="snapshot"]');
    const atSnapshot = await session.page.$eval(
      '.agui-state__doc',
      (el) => (el as HTMLElement).innerText,
    );
    if (!atSnapshot.includes('"Ada"') || atSnapshot.includes('"Grace"')) {
      fail(
        'scrubbing back to the snapshot did not change the document: it should show "Ada", the ' +
          'name before frame 7 replaced it with "Grace". A scrubber that does not scrub is the ' +
          'tab doing nothing.',
      );
    }
    await session.page.screenshot({ path: join(outDir, 'state-snapshot.png'), fullPage: true });

    if (session.errors.length > 0) {
      fail(`State on a run whose patches failed logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- the malformed golden fixture: two frames, the second refused ------- */
  {
    const session = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(session.page, join(fixtureDir, 'malformed.agui.jsonl'));
    await openState(session.page);
    await session.page.screenshot({ path: join(outDir, 'state-malformed.png'), fullPage: true });

    const ticks = await scrubberTicks(session.page);
    const shape = ticks.map((tick) => `${tick.kind}:${tick.failed ? 'failed' : 'ok'}`).join(',');
    if (shape !== 'snapshot:ok,delta:failed') {
      fail(
        `the malformed capture's scrubber reads [${shape}], expected the snapshot at seq 8 ` +
          'followed by the refused delta at seq 9 — the bad patch path done-when #5 counts.',
      );
    }
    if (session.errors.length > 0) {
      fail(`State on the malformed capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- a redacted capture, produced by the real export and re-imported ---- */
  {
    const producer = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(producer.page, join(fixtureDir, 'state-edge.agui.jsonl'));
    await producer.page.click('button[role="tab"][id="agui-tab-session"]');
    await producer.page.waitForSelector('.agui-export');
    await producer.page.click('.agui-export__groups button:has-text("Redact everything")');
    const saved = await clickAndSave(
      producer.page,
      'button:has-text("Download capture")',
      'State (redacted)',
    );
    await producer.close();
    if (saved === null) return;

    const redactedPath = join(outDir, 'state-redacted.agui.jsonl');
    writeFileSync(redactedPath, saved.text, 'utf8');

    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, redactedPath);
    await openState(session.page);
    await session.page.screenshot({ path: join(outDir, 'state-redacted.png'), fullPage: true });

    const shown = await session.page.$eval('.agui-state', (el) => (el as HTMLElement).innerText);
    if (shown.includes('Ada') || shown.includes('Grace')) {
      fail('a redacted capture renders the original state values in State.');
    }
    if (!shown.includes('«redacted:')) {
      fail('a redacted capture shows no placeholder in State — the tree renders as though empty.');
    }
    /*
     * The single most important thing this tab must not do to a shared bug report.
     *
     * A tree rebuilt from redacted patches is structurally real and semantically flat: measured
     * on this fixture, `counter` goes 0 -> 1 -> (2, refused) and every one of those renders as
     * `«redacted: 1 chars»`. A reader not told would scrub the timeline, see no change, and
     * conclude the patches had no effect.
     */
    if (!/placeholder/i.test(shown) || !/what it changed to/i.test(shown)) {
      fail(
        'a redacted capture does not say its values are placeholders. A state tree whose values ' +
          'are all «redacted: N chars» is presented as the state that was on the wire.',
      );
    }
    // §11 keeps structure, so the paths and the patch failures are still real evidence. Read at
    // the failed frame, since the tab opens on the latest one and only its own ops are mounted.
    await session.page.click('.agui-scrub__tick[data-index="3"]');
    await session.page.waitForSelector('[data-testid="failure-r_state"]');
    const atFailure = await session.page.$eval(
      '.agui-state',
      (el) => (el as HTMLElement).innerText,
    );
    if (!atFailure.includes('/missing/child')) {
      fail('a redacted capture lost its JSON Pointer paths; §11 keeps structure and ordering.');
    }
    if (!/operation 2 of 2 failed/i.test(atFailure)) {
      fail('a redacted capture no longer names which op failed — the bug report lost its subject.');
    }
    const failedIndices = (await scrubberTicks(session.page))
      .filter((tick) => tick.failed)
      .map((tick) => tick.index);
    if (failedIndices.join(',') !== '3,5') {
      fail(
        `a redacted capture marked positions [${failedIndices.join(', ')}] failed, expected ` +
          '[3, 5]. Paths survive redaction, so a path-based patch failure must survive with them ' +
          '— that is what makes the shared file a usable bug report.',
      );
    }

    if (session.errors.length > 0) {
      fail(`State on a redacted capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 2d — Runs (§9.2, design decisions R1–R3)                              */
/* -------------------------------------------------------------------------- */

/** Open the Runs tab and wait for it. */
async function openRuns(page: Page): Promise<void> {
  await page.click('button[role="tab"][id="agui-tab-runs"]');
  await page.waitForSelector('.agui-runs');
}

interface RunCell {
  column: string;
  text: string;
  known: boolean;
  tone: string;
  outcome: string;
  /** Laid-out position, so "there are columns" is measured rather than assumed. */
  left: number;
  colour: string;
  fontStyle: string;
}

interface RunRowShot {
  runId: string;
  outcome: string;
  redacted: boolean;
  current: boolean;
  top: number;
  cells: RunCell[];
}

/**
 * Every row of the table as it is actually laid out and painted.
 *
 * Geometry and computed colour, not markup. The unit tests already assert the attributes; what
 * only a browser can say is whether the eight cells land in eight columns, and whether a cell
 * reporting an ABSENCE is drawn differently from the measurements beside it. A panel whose Runs
 * stylesheet never loaded satisfies every other gate in this repository.
 */
function runTable(page: Page): Promise<RunRowShot[]> {
  return page.$$eval('.agui-runs__row', (rows) =>
    rows.map((row) => {
      const box = row.getBoundingClientRect();
      return {
        runId: row.getAttribute('data-run-id') ?? '?',
        outcome: row.getAttribute('data-outcome') ?? '?',
        redacted: row.getAttribute('data-redacted') === 'true',
        current: row.getAttribute('aria-current') === 'true',
        top: box.top,
        cells: [...row.querySelectorAll('.agui-runs__cell')].map((cell) => {
          const style = getComputedStyle(cell);
          return {
            column: cell.getAttribute('data-column') ?? '?',
            text: ((cell as HTMLElement).innerText || '').trim(),
            known: cell.getAttribute('data-known') !== 'false',
            tone: cell.getAttribute('data-tone') ?? '',
            outcome: cell.getAttribute('data-outcome') ?? '',
            left: cell.getBoundingClientRect().left,
            colour: style.color,
            fontStyle: style.fontStyle,
          };
        }),
      };
    }),
  );
}

function headerColumns(page: Page): Promise<{ column: string; left: number }[]> {
  return page.$$eval('.agui-runs__th', (els) =>
    els.map((el) => ({
      column: el.getAttribute('data-column') ?? '?',
      left: el.getBoundingClientRect().left,
    })),
  );
}

/** The one cell of a row, by column. */
function cellOf(row: RunRowShot | undefined, column: string): RunCell | undefined {
  return row?.cells.find((cell) => cell.column === column);
}

function rowOf(rows: RunRowShot[], runId: string): RunRowShot | undefined {
  return rows.find((row) => row.runId === runId);
}

/**
 * Runs renders, in every state design §8 names.
 *
 * The load-bearing assertion is R1's: a cell whose value is NOT KNOWN — a run still going has no
 * duration, an orphaned run has no start to measure from, a run that emitted no text has no first
 * token — must not be drawn like the measurements beside it. Everything about that claim is
 * invisible to every other gate.
 *
 * Live capture is the one §8 state not reachable here: it needs `chrome.runtime.connect` and a
 * service worker feeding records, and it is the ONLY way to reach `outcome: 'running'` at all —
 * the import path closes every connection, which turns an unterminated run into `aborted`. It is
 * covered in `runs.test.tsx`, which drives the tab with `source.kind === 'live'`.
 */
async function checkRuns(browser: Browser, origin: string): Promise<void> {
  /* --- empty: it explains itself rather than showing a bare header --------- */
  {
    const session = await openPanel(browser, origin, { scheme: 'light' });
    await openRuns(session.page);
    const text = (await session.page.textContent('.agui-runs'))?.trim() ?? '';
    if (!/no runs to show/i.test(text)) {
      fail(`the empty Runs tab reads ${JSON.stringify(text)}, expected it to say so.`);
    }
    if (await session.page.isVisible('.agui-runs__head')) {
      fail('the empty Runs tab draws a header row over nothing, which reads as a broken table.');
    }
    await session.page.screenshot({ path: join(outDir, 'runs-empty.png'), fullPage: true });
    if (session.errors.length > 0) {
      fail(`the empty Runs tab logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- four runs, four outcomes: the table, painted (R1, R3) -------------- */
  let originalIssueCounts: Record<string, string> = {};
  {
    const session = await openPanel(browser, origin, { scheme: 'dark' });
    await importFixture(session.page, join(fixtureDir, 'runs-edge.agui.jsonl'));
    await openRuns(session.page);
    await session.page.screenshot({ path: join(outDir, 'runs-edge.png'), fullPage: true });

    const rows = await runTable(session.page);
    const ids = rows.map((row) => row.runId);
    if (ids.join(',') !== 'r_alpha,r_beta,r_gamma,__orphaned__') {
      fail(
        `the Runs table drew rows [${ids.join(', ')}], expected the four runs of runs-edge in ` +
          'capture order.',
      );
    }
    originalIssueCounts = Object.fromEntries(
      rows.map((row) => [row.runId, cellOf(row, 'issues')?.text ?? 'MISSING']),
    );

    /* --- the columns are columns ---------------------------------------- */
    const headers = await headerColumns(session.page);
    if (headers.map((header) => header.column).join(',') !== 'run,thread,agent,outcome,duration,ttft,events,issues') {
      fail(
        `the Runs header reads [${headers.map((header) => header.column).join(', ')}], expected ` +
          '§9.2’s columns behind the run id.',
      );
    }
    const first = rows[0];
    if (first === undefined) {
      fail('the Runs table drew no rows at all on the runs-edge capture.');
    } else {
      const ordered = first.cells.every(
        (cell, i) => i === 0 || cell.left > (first.cells[i - 1]?.left ?? Infinity),
      );
      if (!ordered) {
        fail(
          `a Runs row's cells are not laid out left to right: lefts ` +
            `[${first.cells.map((cell) => Math.round(cell.left)).join(', ')}]. Cells that share an ` +
            'x are a table whose grid never reached it.',
        );
      }
      // The header and the rows share one column declaration. If they stop agreeing, every
      // heading sits over the wrong data — worse than no heading at all.
      for (const cell of first.cells) {
        const header = headers.find((candidate) => candidate.column === cell.column);
        if (header === undefined || Math.abs(header.left - cell.left) > 1) {
          fail(
            `the "${cell.column}" heading sits at x=${String(Math.round(header?.left ?? -1))} but ` +
              `its cells at x=${String(Math.round(cell.left))}.`,
          );
        }
      }
    }

    /* --- R3: it is the virtual list doing this --------------------------- */
    const sizer = await session.page.$eval('.agui-runs__body .agui-vlist__sizer', (el) =>
      Math.round(el.getBoundingClientRect().height),
    ).catch(() => -1);
    if (sizer !== 4 * 24) {
      fail(
        `the Runs body's virtual-list sizer is ${String(sizer)}px for 4 rows of 24px. R3 requires ` +
          'the table go through common/virtual-list, whose sizer carries the whole scroll height.',
      );
    }

    /* --- R1: the values are real ----------------------------------------- */
    const alpha = rowOf(rows, 'r_alpha');
    const expected: [string, string][] = [
      ['thread', 't_alpha'],
      ['agent', 'weather-agent'],
      ['outcome', 'finished'],
      ['duration', '200ms'],
      ['ttft', '140ms'],
      ['events', '5'],
      ['issues', '0'],
    ];
    for (const [column, want] of expected) {
      const got = cellOf(alpha, column)?.text ?? 'MISSING';
      if (got !== want) {
        fail(`r_alpha's ${column} cell reads ${JSON.stringify(got)}, expected ${JSON.stringify(want)}.`);
      }
    }

    /*
     * THE ASSERTION THIS TAB EXISTS FOR.
     *
     * The comparison has to be against a cell in the SAME COLUMN. Measured, by deleting the
     * `[data-known='false']` rule and re-running this gate: an unknown cell reverts to the row's
     * own colour, which still differs from the muted heading and from the toned issue count — so
     * comparing against anything else passes a panel in which an absence is drawn exactly like a
     * measurement. r_alpha's duration is a number; the orphan's is not.
     */
    const knownDuration = cellOf(alpha, 'duration');
    const absentDuration = cellOf(rowOf(rows, '__orphaned__'), 'duration');
    if (knownDuration === undefined || absentDuration === undefined) {
      fail('the Runs table has no duration cell to compare a known value against an absent one.');
    } else {
      if (absentDuration.text !== 'no run start') {
        fail(
          `the orphaned run's duration reads ${JSON.stringify(absentDuration.text)}. It has no ` +
            'RUN_STARTED, so there is no start to measure from — and no number to print.',
        );
      }
      if (
        absentDuration.colour === knownDuration.colour &&
        absentDuration.fontStyle === knownDuration.fontStyle
      ) {
        fail(
          `a cell reporting an ABSENCE is drawn ${absentDuration.colour} / ` +
            `${absentDuration.fontStyle}, exactly like the measured duration in the same column. ` +
            'R1 asks for the absence rendered honestly; a cell that looks like every other is ' +
            'read as a value the panel computed.',
        );
      }
      if (absentDuration.colour === 'rgba(0, 0, 0, 0)') {
        fail('the absent-value rule paints a transparent colour — it did not reach the document.');
      }
    }

    // The other two absences, in words, on screen.
    const shown = await session.page.$eval('.agui-runs', (el) => (el as HTMLElement).innerText);
    if (!shown.includes('no text')) {
      fail(
        'no run reports "no text" for TTFT. r_beta ran a tool and emitted no token at all, and ' +
          'the honest report of that is not 0ms.',
      );
    }
    if (!shown.includes('not reported')) {
      fail('no run reports its agent as "not reported"; three of the four carried no agentId.');
    }

    /* --- the outcomes are distinguishable -------------------------------- */
    const outcomes = rows.map((row) => cellOf(row, 'outcome')).filter((cell) => cell !== undefined);
    if (outcomes.map((cell) => cell.text).join(',') !== 'finished,error,aborted,orphaned') {
      fail(
        `the outcome column reads [${outcomes.map((cell) => cell.text).join(', ')}], expected ` +
          'finished, error, aborted, orphaned.',
      );
    }
    const finishedOutcome = outcomes[0];
    const errorOutcome = outcomes[1];
    if (
      finishedOutcome !== undefined &&
      errorOutcome !== undefined &&
      finishedOutcome.colour === errorOutcome.colour
    ) {
      fail(
        `a run that ERRORED is painted ${errorOutcome.colour}, exactly like one that finished. ` +
          'The outcome column is the first thing a reader scans.',
      );
    }

    /* --- the issue count is toned by the worst issue on the run ---------- */
    const cleanIssues = cellOf(alpha, 'issues');
    const brokenIssues = cellOf(rowOf(rows, 'r_gamma'), 'issues');
    if (cleanIssues === undefined || brokenIssues === undefined) {
      fail('the Runs table drew no issue cells to compare.');
    } else {
      if (brokenIssues.text !== '2' || cleanIssues.text !== '0') {
        fail(
          `the issue counts read r_alpha=${cleanIssues.text}, r_gamma=${brokenIssues.text}, ` +
            'expected 0 and 2.',
        );
      }
      if (brokenIssues.colour === cleanIssues.colour) {
        fail(
          `a run carrying two validator issues has its count painted ${brokenIssues.colour}, ` +
            'exactly like a clean run’s zero. The count is the reason to click the row.',
        );
      }
    }

    /* --- R2: clicking a row really lands on Timeline, scoped ------------- */
    await session.page.click('[data-testid="run-row-r_gamma"]');
    await session.page.waitForSelector('.agui-timeline');
    const selected = await seqsOf(session.page, '.agui-event-row[aria-selected="true"]');
    if (selected.join(',') !== '11') {
      fail(
        `clicking the r_gamma row selected seqs [${selected.join(', ')}] in Timeline, expected ` +
          '[11] — its first record (R2).',
      );
    }
    const scope = (await session.page.textContent('.agui-run-selector__trigger'))?.trim() ?? '';
    if (!scope.includes('r_gamma')) {
      fail(
        `clicking a Runs row left the scope reading ${JSON.stringify(scope)}. R2 is "scopes to ` +
          'that run AND switches to Timeline"; without the scope the other three runs are still ' +
          'on screen.',
      );
    }
    const listed = await seqsOf(session.page, '.agui-event-row');
    if (listed.join(',') !== '11,12,13') {
      fail(
        `the Timeline the click landed on lists seqs [${listed.join(', ')}], expected r_gamma's ` +
          'three records and nothing else.',
      );
    }
    await session.page.screenshot({ path: join(outDir, 'runs-located.png'), fullPage: true });

    // Back on Runs, the row that is now the scope says so.
    await openRuns(session.page);
    const scoped = (await runTable(session.page)).filter((row) => row.current);
    if (scoped.map((row) => row.runId).join(',') !== 'r_gamma') {
      fail(
        `after scoping to r_gamma the Runs table marks [${scoped.map((row) => row.runId).join(', ')}] ` +
          'as current. This table is the scope picker, so it has to show which run is in force.',
      );
    }
    if ((await runTable(session.page)).length !== 4) {
      fail(
        'the Runs table filtered itself to the scoped run. The tab whose job is choosing a run ' +
          'must keep showing the choices.',
      );
    }
    await session.page.screenshot({ path: join(outDir, 'runs-scoped.png'), fullPage: true });

    if (session.errors.length > 0) {
      fail(`Runs on an imported capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }

  /* --- a redacted capture, produced by the real export and re-imported ---- */
  {
    const producer = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(producer.page, join(fixtureDir, 'runs-edge.agui.jsonl'));
    await producer.page.click('button[role="tab"][id="agui-tab-session"]');
    await producer.page.waitForSelector('.agui-export');
    await producer.page.click('.agui-export__groups button:has-text("Redact everything")');
    const saved = await clickAndSave(
      producer.page,
      'button:has-text("Download capture")',
      'Runs (redacted)',
    );
    await producer.close();
    if (saved === null) return;

    const redactedPath = join(outDir, 'runs-redacted.agui.jsonl');
    writeFileSync(redactedPath, saved.text, 'utf8');

    const session = await openPanel(browser, origin, { scheme: 'light' });
    await importFixture(session.page, redactedPath);
    await openRuns(session.page);
    await session.page.screenshot({ path: join(outDir, 'runs-redacted.png'), fullPage: true });

    const rows = await runTable(session.page);
    /*
     * Count first, and count for real.
     *
     * Every assertion below this line is over `rows`, and `[].every(...)` is `true` — so a
     * selector that stopped matching would let the whole redaction phase pass having examined
     * nothing at all. That is the exact way a gate stops being a gate.
     */
    if (rows.length !== 4) {
      fail(
        `the redacted capture drew ${String(rows.length)} Runs rows, expected 4. Nothing below ` +
          'this line asserts anything about a table that is not there.',
      );
      await session.close();
      return;
    }
    if (!rows.every((row) => row.redacted)) {
      fail(
        `only [${rows.filter((row) => row.redacted).map((row) => row.runId).join(', ')}] of the ` +
          'redacted capture’s rows are marked redacted. Every value in this file is a placeholder.',
      );
    }
    const flag = await session.page
      .$eval('.agui-runs__redacted-flag', (el) => getComputedStyle(el).backgroundColor)
      .catch(() => 'MISSING');
    if (flag === 'MISSING' || flag === 'rgba(0, 0, 0, 0)') {
      fail(
        `the per-row redaction mark has background ${flag} — a redacted run is drawn exactly ` +
          'like a live one, on the surface a colleague opening a bug report reads first.',
      );
    }
    const note = (await session.page.textContent('[data-testid="runs-redacted"]'))?.trim() ?? '';
    if (!/redacted/i.test(note)) {
      fail('a redacted capture does not say so on the Runs tab.');
    }

    /*
     * REDACTION REMOVES EVIDENCE; IT MUST NOT ADD FINDINGS.
     *
     * Reported as the real counts on both sides rather than as a bare pass, because a selector
     * that stopped matching would otherwise let this assert nothing at all.
     */
    for (const row of rows) {
      const before = originalIssueCounts[row.runId];
      const after = cellOf(row, 'issues')?.text ?? 'MISSING';
      if (before === undefined || after === 'MISSING') {
        fail(`could not compare issue counts for ${row.runId} (before=${String(before)}, after=${after}).`);
      } else if (Number(after) > Number(before)) {
        fail(
          `${row.runId} reports ${after} issues after redaction and ${before} before it. ` +
            'Redaction destroys evidence; a finding it invented is a finding about the exporter ' +
            'presented as one about the user’s agent.',
        );
      }
    }
    // §11 keeps ids, structure, ordering and timing, so every measurement in this table survives.
    const alpha = rowOf(rows, 'r_alpha');
    for (const [column, want] of [
      ['duration', '200ms'],
      ['ttft', '140ms'],
      ['agent', 'weather-agent'],
      ['events', '5'],
    ] as [string, string][]) {
      const got = cellOf(alpha, column)?.text ?? 'MISSING';
      if (got !== want) {
        fail(
          `r_alpha's ${column} reads ${JSON.stringify(got)} after redaction, expected ` +
            `${JSON.stringify(want)}. §11 replaces values, not timing, ids or structure — and ` +
            'this table shows none of the things redaction removes.',
        );
      }
    }

    if (session.errors.length > 0) {
      fail(`Runs on a redacted capture logged errors: ${session.errors.join(' | ')}`);
    }
    await session.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — does a real click produce a real file? (design decision E1)       */
/* -------------------------------------------------------------------------- */

interface Saved {
  filename: string;
  text: string;
}

/**
 * Click something and wait for the file it saves.
 *
 * `waitForEvent('download')` is the only honest assertion available here: it fires when Chromium
 * actually begins writing a file, which is exactly the step no unit test can reach. A timeout is
 * therefore a real failure — E1's mechanism did not work in this document — and never a flake to
 * be retried away.
 */
async function clickAndSave(page: Page, selector: string, where: string): Promise<Saved | null> {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.click(selector),
    ]);
    const path = await download.path();
    return { filename: download.suggestedFilename(), text: readFileSync(path, 'utf8') };
  } catch (error) {
    fail(
      `${where}: clicking ${selector} produced no download within 10s ` +
        `(${error instanceof Error ? error.message : String(error)}). Design decision E1 relies on ` +
        'Blob + URL.createObjectURL + a programmatic anchor needing no `downloads` permission. If ' +
        'that is blocked in this document, E1 is wrong and the alternative is the `downloads` ' +
        'permission — which requirements §11 does not allow to be added for convenience, so it is ' +
        'a decision to be taken deliberately, not a quiet manifest edit.',
    );
    return null;
  }
}

function headerLine(saved: Saved): Record<string, unknown> {
  const first = saved.text.split('\n')[0] ?? '';
  return JSON.parse(first) as Record<string, unknown>;
}

/**
 * Drive both export surfaces against a loaded capture, and read what came out.
 *
 * `where` names the document being driven, because this runs twice: once over `dist/` on http,
 * and once at the extension's own origin, and a failure in only one of the two is the single most
 * useful thing this gate can say.
 */
async function checkExportSurfaces(page: Page, where: string, shots: string): Promise<void> {
  /* --- the toolbar: one click, current scope, unredacted --------------- */
  const toolbar = await clickAndSave(page, 'button[title*="Download this capture"]', where);
  if (toolbar === null) return;

  if (!/^agui-localhost-3000-.+\.agui\.jsonl$/.test(toolbar.filename)) {
    fail(`${where}: the toolbar saved ${JSON.stringify(toolbar.filename)}, expected agui-<host>-<ISO>.agui.jsonl.`);
  }
  const lines = toolbar.text.split('\n').filter((line) => line !== '');
  if (lines.length !== 17) {
    fail(
      `${where}: the exported capture holds ${String(lines.length)} lines, expected 17 ` +
        '(header + request + 15 records). A file that downloads but is empty is worse than no file.',
    );
  }
  const header = headerLine(toolbar);
  if (header.kind !== 'header') {
    fail(`${where}: line 1 of the exported file is not a header (requirements §10).`);
  }
  if (JSON.stringify(header.redacted) !== '[]') {
    fail(
      `${where}: the toolbar export declared redacted=${JSON.stringify(header.redacted)}. E5 makes ` +
        'this surface unredacted, and the button says so.',
    );
  }
  // The button is labelled "unredacted". If the text is not in the file, the label is a lie.
  if (!toolbar.text.includes('The weather in Paris')) {
    fail(`${where}: the toolbar export is labelled unredacted but the message text is not in it.`);
  }

  /* --- the Session tab: full control, and a redacted bug report -------- */
  await page.click('button[role="tab"][id="agui-tab-session"]');
  await page.waitForSelector('.agui-export');
  await page.screenshot({ path: join(outDir, `${shots}-export-controls.png`), fullPage: true });

  const summary = (await page.textContent('[data-testid="agui-export-summary"]'))?.trim() ?? '';
  if (!summary.includes('unredacted')) {
    fail(
      `${where}: the export summary reads ${JSON.stringify(summary)}. E5 requires the panel to ` +
        'state what will be included, and redaction is never a silent default.',
    );
  }

  await page.click('.agui-export__groups button:has-text("Redact everything")');
  const redacted = await clickAndSave(page, 'button:has-text("Download capture")', `${where} (redacted)`);
  if (redacted === null) return;

  await page.screenshot({ path: join(outDir, `${shots}-export-redacted.png`), fullPage: true });

  const redactedHeader = headerLine(redacted);
  if (
    JSON.stringify(redactedHeader.redacted) !==
    JSON.stringify(['text', 'reasoning', 'toolArgs', 'toolResults', 'state'])
  ) {
    fail(
      `${where}: a fully redacted export declared redacted=${JSON.stringify(redactedHeader.redacted)}. ` +
        'The header is the only record of what was replaced (§11).',
    );
  }
  /*
   * Done-when #7, asserted on the bytes a user would actually hand to a colleague.
   *
   * Every entry here is a VALUE. Keys — `lastCity`, `counter`, `notes` — survive redaction by
   * design: §11 keeps structure, types, ordering and sizes, which is what makes the file a
   * protocol bug report rather than a blank one. Listing a key here would be asserting the
   * opposite of the requirement.
   */
  for (const secret of ['The weather in Paris', 'is sunny and 24', 'first note', 'Sunny', 'tempC']) {
    if (redacted.text.includes(secret)) {
      fail(`${where}: a fully redacted export still contains ${JSON.stringify(secret)}.`);
    }
  }
  if (!redacted.text.includes('«redacted:')) {
    fail(`${where}: a fully redacted export carries no placeholder — nothing was redacted at all.`);
  }
  if (!redacted.text.includes('RUN_FINISHED') || !redacted.text.includes('get_weather')) {
    fail(
      `${where}: a fully redacted export lost its structure. §11 keeps types, ids, ordering and ` +
        'sizes — that is what makes it a protocol bug report rather than a blank file.',
    );
  }

  /* --- the fixture export --------------------------------------------- */
  await page.click('.agui-export__groups button:has-text("Redact nothing")');
  const fixture = await clickAndSave(page, 'button:has-text("Download TypeScript fixture")', where);
  if (fixture === null) return;

  if (!fixture.filename.endsWith('.fixture.ts')) {
    fail(`${where}: the fixture export saved ${JSON.stringify(fixture.filename)}, expected *.fixture.ts.`);
  }
  if (!fixture.text.includes('export const events: AguiEvent[] = [')) {
    fail(`${where}: the fixture export holds no event array (E7).`);
  }
}

/**
 * The served `dist/` on http — the same document the paint and data phases drove.
 *
 * Driven in the DARK scheme deliberately: the extension-origin pass below runs light, so between
 * the two every export control is drawn in both. A control styled in one scheme and bare in the
 * other is exactly what this gate exists to catch.
 */
async function checkExport(browser: Browser, origin: string): Promise<void> {
  const session = await openPanel(browser, origin, { scheme: 'dark' });
  try {
    await importFixture(session.page, join(fixtureDir, 'happy-run.agui.jsonl'));
    await checkExportSurfaces(session.page, 'served dist/', 'served');
    if (session.errors.length > 0) {
      fail(`exporting logged errors: ${session.errors.join(' | ')}`);
    }
  } finally {
    await session.close();
  }
}

/**
 * The same drive, at the extension's own origin, with the real unpacked extension loaded.
 *
 * This is as close to a DevTools panel document as anything automatable gets. A DevTools panel IS
 * `chrome-extension://<id>/…/panel.html`, loaded in an iframe inside the DevTools window — so the
 * origin, the extension CSP and the `chrome` API surface driven here are the real ones, and the
 * only thing not reproduced is the surrounding `devtools://` frame. That matters because the
 * plausible way E1 fails is a CSP or a policy attached to the extension origin, not to the frame.
 *
 * `channel: 'chromium'` is mandatory: a default headless launch resolves to
 * `chromium-headless-shell`, which is built WITHOUT the extensions stack — it accepts
 * `--load-extension`, registers no service worker, and reports no error, so this would pass
 * having loaded nothing at all.
 */
async function checkExportInExtension(): Promise<void> {
  if (!existsSync(join(distDir, 'manifest.json'))) {
    fail(`${join(distDir, 'manifest.json')} does not exist, so the extension could not be loaded.`);
    return;
  }

  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'agui-panel-')), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1100, height: 760 },
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
  } catch (error) {
    fail(
      'could not launch Chromium with the unpacked extension, so E1 could not be verified at the ' +
        `extension origin: ${error instanceof Error ? error.message : String(error)}. ` +
        'This needs the FULL `chromium` build (`playwright install chromium`), not the headless shell.',
    );
    return;
  }

  try {
    // `serviceWorkers()` is frequently empty immediately after launch — measured by the capture
    // e2e, and the reason it has the same fallback.
    const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }));
    const extensionId = new URL(worker.url()).host;

    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(`chrome-extension://${extensionId}/src/panel/panel.html`);
    await page.waitForSelector('.agui-app');
    await importFixture(page, join(fixtureDir, 'happy-run.agui.jsonl'));

    await checkExportSurfaces(page, 'the extension origin', 'extension');

    if (errors.length > 0) {
      fail(`the panel logged errors at the extension origin: ${errors.join(' | ')}`);
    }
  } catch (error) {
    fail(
      'driving the panel at the extension origin failed: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    await ctx.close();
  }
}

/* -------------------------------------------------------------------------- */

function report(): never {
  console.error(`FAIL: ${String(failures.length)} visual invariant(s) violated:\n`);
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!existsSync(join(distDir, PANEL_PATH))) {
    console.error(`FAIL: ${join(distDir, PANEL_PATH)} does not exist. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  // Diagnostic only. Whether a stylesheet reaches the document is decided by the computed
  // styles below, not by grepping the HTML — the CSS may arrive by link, by inline <style>, or
  // through the module graph, and only the browser knows which of those actually worked.
  const html = readFileSync(join(distDir, PANEL_PATH), 'utf8');
  const htmlMentionsCss = /<link[^>]+stylesheet/i.test(html) || /<style/i.test(html);

  mkdirSync(outDir, { recursive: true });
  const server = await startServer(distDir);
  const browser = await chromium.launch();

  let painted: Record<string, string> = {};
  try {
    painted = await checkPaint(browser, server.origin, htmlMentionsCss);
    // Asserting on rows in a panel that is not painting tells you nothing the paint phase has
    // not already said, and buries the diagnosis under consequential failures.
    if (failures.length === 0) await checkUnreachableControls(browser, server.origin);
    if (failures.length === 0) await checkFixtures(browser, server.origin);
    if (failures.length === 0) await checkMessages(browser, server.origin);
    if (failures.length === 0) await checkState(browser, server.origin);
    if (failures.length === 0) await checkRuns(browser, server.origin);
    if (failures.length === 0) await checkExport(browser, server.origin);
  } finally {
    await browser.close();
    await server.close();
  }

  // Outside the `finally` above because it runs its own browser: the extension only loads through
  // `launchPersistentContext`, which cannot share the headless-shell instance the phases above use.
  if (failures.length === 0) await checkExportInExtension();

  if (failures.length > 0) report();

  console.log('panel renders in both schemes:');
  for (const [scheme, colours] of Object.entries(painted)) {
    console.log(`  ${scheme}: body ${colours} — ${join(outDir, `panel-${scheme}.png`)}`);
  }
  console.log('panel renders real captures:');
  console.log(
    `  happy-run: 15 rows, 0 annotated, badge "0 issues" — ${outDir}/timeline-happy.png`,
  );
  console.log(
    `  malformed: rows ${MALFORMED_ISSUE_SEQS.join(', ')} annotated, badge "3 issues", ` +
      `filter leaves exactly those — ${outDir}/timeline-malformed.png`,
  );
  console.log(
    `  partial decode: warned on import and after a tab switch — ${outDir}/partial-import.png`,
  );
  console.log('Messages renders in every state design §8 names:');
  console.log(`  empty: says so rather than showing a blank pane — ${outDir}/messages-empty.png`);
  console.log(
    `  imported: request turn, m_1, tc_1 in order; the jump selects seq 3 scoped to r_happy — ` +
      `${outDir}/messages-happy.png`,
  );
  console.log(
    `  issues: the failed-args row is tinted apart from its neighbour, reasoning is collapsed, ` +
      `streaming is flagged — ${outDir}/messages-edge.png`,
  );
  console.log(
    `  redacted: placeholders, structure kept, arguments reported redacted rather than broken — ` +
      `${outDir}/messages-redacted.png`,
  );
  console.log(
    `  redacted: a clean capture stays clean — badge "0 issues", no tinted rows — ` +
      `${outDir}/timeline-redacted.png`,
  );
  console.log('State renders in every state design §8 names:');
  console.log(`  empty: says so rather than showing a blank pane — ${outDir}/state-empty.png`);
  console.log(
    `  issues: 7 scrubber positions laid out left to right, 4 and 6 marked red in place, the ` +
      `failing op named "operation 2 of 2" — ${outDir}/state-edge.png, ${outDir}/state-failed-frame.png`,
  );
  console.log(
    `  malformed: the snapshot at seq 8 then the refused delta at seq 9 — ${outDir}/state-malformed.png`,
  );
  console.log(
    `  redacted: placeholders, paths kept, the same two failures still marked in place — ` +
      `${outDir}/state-redacted.png`,
  );
  console.log('Runs renders in every state design §8 names:');
  console.log(`  empty: says so rather than drawing a bare header — ${outDir}/runs-empty.png`);
  console.log(
    `  imported: 4 runs in 8 aligned columns through the virtual list; absent duration and TTFT ` +
      `drawn apart from measured ones — ${outDir}/runs-edge.png`,
  );
  console.log(
    `  issues: the error outcome and the toned issue count are painted apart from a clean run — ` +
      `${outDir}/runs-edge.png`,
  );
  console.log(
    `  R2: clicking r_gamma scopes the panel and leaves Timeline on seqs 11-13, seq 11 selected — ` +
      `${outDir}/runs-located.png, ${outDir}/runs-scoped.png`,
  );
  console.log(
    `  redacted: every row marked, no run gains an issue, every measurement survives — ` +
      `${outDir}/runs-redacted.png`,
  );
  console.log('the post-grant Reload control is styled (.agui-app__note-action).');
  console.log('panel issued no off-origin requests (requirements §11).');
  console.log('export writes a real file from a real click (design decision E1, no `downloads` permission):');
  console.log(`  served dist/: toolbar 17 lines unredacted, redacted export leaks no text, fixture .ts`);
  console.log(
    `  the extension origin (chrome-extension://…/panel.html): the same, under the extension CSP`,
  );
  console.log(`  screenshots: ${outDir}/served-export-controls.png, ${outDir}/extension-export-redacted.png`);
}

await main();
