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
import { createReadStream, statSync } from 'node:fs';
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

/**
 * `existsSync` is true for directories too, so a request for a directory path — or for `${origin}/`
 * itself, which the composing frame in a later task can produce — used to reach
 * `createReadStream(dir)`. That emits an unhandled `'error'` (`EISDIR`) and kills the whole
 * script with a bare stack trace and no diagnostic pointing at the request that caused it. This
 * was survivable while the only consumer requested one known HTML file; it is not now that the
 * harness is shared plumbing whose second consumer navigates to arbitrary URLs.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Serve a directory over HTTP. ES modules will not load over `file://`. */
export function startServer(root: string): Promise<StaticServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    // `url.pathname` is always absolute (it starts with `/`), and `normalize` treats a leading
    // `/` as unclimbable — `normalize('/../x')` is `/x`, not `/x` escaped one level up — so `rel`
    // is already confined under `root` by the time it reaches here. That makes `startsWith(root)`
    // unreachable defence-in-depth as this code stands: no traversal payload can make it fail
    // while `normalize` runs first. It stays because `normalize` running first is an invariant of
    // this function, not of the type system — nothing stops a future edit from reordering these
    // two lines, and the day that happens this is the check that saves it.
    if (!file.startsWith(root) || !isFile(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    const stream = createReadStream(file);
    // `res.writeHead(200, ...)` above has already run by the time an fs error (e.g. the file is
    // removed between the `isFile` check and this read) can reach this handler, so the status is
    // already committed — there is no 500 left to send. The only job left for this handler is to
    // end the response instead of letting the stream's unhandled `'error'` crash the process,
    // which is the same failure mode `isFile` above exists to prevent.
    stream.on('error', () => res.end());
    stream.pipe(res);
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
  /**
   * Load this URL instead of the panel document itself. The returned session still exposes
   * `page`, but `page` is now a document that *contains* the panel — e.g. a composing frame that
   * iframes it — rather than the panel document. Callers that need the panel's own elements go
   * through one of its frames, which is what `PanelScope` below exists for.
   */
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
 * Both expose `locator`, which is why `importFixture` below is written against locators rather
 * than `page.setInputFiles`.
 */
export type PanelScope = Page | FrameLocator;

/** Import a capture through the panel's own file input, exactly as a user would. */
export async function importFixture(scope: PanelScope, file: string): Promise<void> {
  await scope.locator('input.agui-drop__input').setInputFiles(file);
  // No explicit `state` — `waitFor`'s default is `'visible'`, matching the `page.waitForSelector`
  // call this replaced (whose own default was also `'visible'`). Both call sites screenshot
  // immediately after this resolves, so settling for merely `'attached'` (present in the DOM,
  // possibly still invisible) would be a silent loosening of what "imported" means here.
  await scope.locator('.agui-timeline, .agui-app__load-error').first().waitFor({ timeout: 5000 });
}
