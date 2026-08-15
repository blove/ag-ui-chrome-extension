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
 * phases:
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
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.PANEL_DIST ?? join(packageRoot, 'dist');
const outDir = process.env.PANEL_SHOTS ?? join(packageRoot, '.screenshots');
const fixtureDir = join(packageRoot, 'src/test/fixtures');
const panelPath = 'src/panel/panel.html';

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
 * point is to render the panel's own markup, not to simulate Chrome. `devtools` is left absent
 * so the detection and origin paths take their documented no-DevTools branch, which is what
 * makes the capture banner read "Live capture only runs inside the DevTools panel."
 */
const CHROME_SHIM = `
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.0.0-screenshot' }) },
  };
`;

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function startServer(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
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

interface Session {
  page: Page;
  /** Errors the page logged or threw, in order. */
  errors: string[];
  /** Every URL the page requested, so requirements §11 (no egress) can be asserted. */
  requests: string[];
  close: () => Promise<void>;
}

async function openPanel(
  browser: Browser,
  origin: string,
  scheme: 'light' | 'dark',
): Promise<Session> {
  const context = await browser.newContext({
    colorScheme: scheme,
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(CHROME_SHIM);
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(`${origin}/${panelPath}`, { waitUntil: 'networkidle' });
  return { page, errors, requests, close: () => context.close() };
}

/** Import a capture through the panel's own file input, exactly as a user would. */
async function importFixture(page: Page, file: string): Promise<void> {
  await page.setInputFiles('input.agui-drop__input', file);
  await page.waitForSelector('.agui-timeline, .agui-app__load-error', { timeout: 5000 });
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
    const session = await openPanel(browser, origin, scheme);
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
            ? `dist/${panelPath} does reference a stylesheet, so it failed to load.`
            : `dist/${panelPath} references no stylesheet at all.`),
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
  const session = await openPanel(browser, origin, 'light');
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
    const session = await openPanel(browser, origin, 'light');
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
    const session = await openPanel(browser, origin, 'dark');
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

    const session = await openPanel(browser, origin, 'dark');
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
    await session.page.waitForSelector('.agui-coming');
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
  const session = await openPanel(browser, origin, 'dark');
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
  if (!existsSync(join(distDir, panelPath))) {
    console.error(`FAIL: ${join(distDir, panelPath)} does not exist. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  // Diagnostic only. Whether a stylesheet reaches the document is decided by the computed
  // styles below, not by grepping the HTML — the CSS may arrive by link, by inline <style>, or
  // through the module graph, and only the browser knows which of those actually worked.
  const html = readFileSync(join(distDir, panelPath), 'utf8');
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
