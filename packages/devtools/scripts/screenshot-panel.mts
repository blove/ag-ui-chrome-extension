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
 *
 * Phase 2 is skipped when phase 1 fails: there is no point asserting on rows in a panel that is
 * not painting at all, and the phase-1 output is the diagnosis.
 *
 * Run: `pnpm build && pnpm screenshot:panel` (first run also needs
 * `pnpm exec playwright install chromium`). `PANEL_DIST` points it at a different build, which
 * is how the gate itself is tested against a deliberately unstyled variant.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
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
 * makes the capture banner read "Live capture is not available in this build."
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
    if (failures.length === 0) await checkFixtures(browser, server.origin);
  } finally {
    await browser.close();
    await server.close();
  }

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
  console.log('panel issued no off-origin requests (requirements §11).');
}

await main();
