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
import { createReadStream, existsSync } from 'node:fs';
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

/** Serve a directory over HTTP. ES modules will not load over `file://`. */
export function startServer(root: string): Promise<StaticServer> {
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
  /** Load this URL instead of the panel itself — used to load a composing frame that iframes it. */
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
 * Both expose `locator`, which is why the import path below is written against locators rather
 * than `page.setInputFiles`.
 */
export type PanelScope = Page | FrameLocator;

/** Import a capture through the panel's own file input, exactly as a user would. */
export async function importFixture(scope: PanelScope, file: string): Promise<void> {
  await scope.locator('input.agui-drop__input').setInputFiles(file);
  await scope
    .locator('.agui-timeline, .agui-app__load-error')
    .first()
    .waitFor({ state: 'attached', timeout: 5000 });
}
