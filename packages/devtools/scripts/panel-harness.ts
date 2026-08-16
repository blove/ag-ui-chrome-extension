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
 * The origin `devtools-ungranted` reports as the inspected page.
 *
 * Three constraints, all load-bearing. It must be RESERVED — RFC 2606 sets `example.com` aside
 * precisely so documentation and screenshots do not name a real third party, and a store asset
 * showing a real site is an implied claim about that site. It must be NON-LOCALHOST: `grant.ts`
 * auto-enables `localhost`/`127.0.0.1`/`0.0.0.0` from the static manifest matches, so a localhost
 * origin here would flip capture straight to `on` and the offer would never render. And it must be
 * FIXED, because it is rendered into `5-privacy.png` twice (banner head and button label) and the
 * asset is committed — anything derived from the harness's own ephemeral port would change the
 * PNG's bytes on every run.
 */
export const HARNESS_INSPECTED_ORIGIN = 'https://app.example.com';

/**
 * Enough of `chrome` for the panel bundle to boot outside DevTools. Deliberately minimal: the
 * point is to render the panel's own markup, not to simulate Chrome.
 *
 * `no-devtools` leaves `chrome.devtools` absent, so the detection and origin paths take their
 * documented no-DevTools branch and the capture banner reads "Live capture only runs inside the
 * DevTools panel." That is the shape the gate has always asserted against.
 *
 * `devtools-ungranted` adds ONE more call — `inspectedWindow.eval` — and nothing else. That single
 * API is what `app.tsx:32` uses to name the inspected origin, and naming it is the whole of what
 * moves capture from `unsupported` (no page to attach to) to `off` (a page, and an offer to
 * capture it). Everything else the panel would consult on that path is deliberately still absent,
 * and each absence is the panel's own documented branch rather than a gap this shim gets away with:
 *
 *   - no `chrome.permissions`, so `hasOriginGrant` returns false (`grant.ts:69`) and the origin
 *     stays ungranted. That is the state being photographed; stubbing `contains` to return false
 *     would say the same thing at the cost of a second lie.
 *   - no `chrome.devtools.network`, so `observeNetwork` returns its no-op unsubscribe
 *     (`detect.ts:49`) and the banner's signal stays `none`. It also keeps the shot deterministic:
 *     a `stream` signal would re-word the banner, and whether it arrived would depend on what the
 *     page happened to request.
 *   - no `chrome.runtime.connect`, which is never reached — the port effect returns early while
 *     capture is `off` (`use-live-capture.ts:130`). Faking a service-worker port is the line this
 *     shim must not cross: past it the panel is being told capture works, which is the one thing
 *     the privacy shot must not stage.
 *
 * `eval` answers `location.origin` and NOTHING else. `probeFramework` reaches the same function
 * with its `ng-version` expression (`detect.ts:103`), and answering that with the origin string
 * would label the session with a framework fingerprint that was never read from any page — the
 * screenshot would then carry a fabricated fact. `null` is the honest answer and the one the panel
 * already handles.
 */
/**
 * `devtools-granted-unregistered` is the third, and it is the ONE case that has to cross the line
 * the note above draws — deliberately, and in the opposite direction.
 *
 * It stages a granted origin whose capture content scripts are NOT registered: the state Chrome
 * leaves behind after an extension update, which discards dynamic registrations and keeps the
 * permission. The panel used to have a single banner for it — "the capture layer is not loaded in
 * this page" — and offered a page reload, which in that state does nothing at all: there are no
 * scripts registered to load. The user reloads, reads the identical message, and concludes the
 * tool is broken. Photographing the corrected banner is the only way to hold its wording, because
 * the state cannot be produced with a real grant from a script.
 *
 * So this shim adds `permissions.contains` (true) and a `runtime.connect` port that answers
 * `subscribe` with the real `snapshot` message. What the privacy shim must not do is tell the
 * panel that capture WORKS; this tells it, in the panel's own wire format, that it does not. The
 * snapshot is empty in every other field, so nothing here stages captured data either.
 */
export type ShimKind = 'no-devtools' | 'devtools-ungranted' | 'devtools-granted-unregistered';

export const SHIMS: Record<ShimKind, string> = {
  'no-devtools': `
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: '0.0.0-harness' }) },
    };
  `,
  'devtools-ungranted': `
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: '0.0.0-harness' }) },
      devtools: {
        inspectedWindow: {
          eval: (expression, callback) => {
            callback(expression === 'location.origin' ? ${JSON.stringify(HARNESS_INSPECTED_ORIGIN)} : null);
          },
        },
      },
    };
  `,
  'devtools-granted-unregistered': `
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.0.0-harness' }),
        connect: () => {
          const listeners = [];
          return {
            onMessage: {
              addListener: (fn) => { listeners.push(fn); },
              removeListener: () => {},
            },
            onDisconnect: { addListener: () => {}, removeListener: () => {} },
            postMessage: (command) => {
              if (!command || command.kind !== 'subscribe') return;
              // The real 'snapshot' message, in full. Granted, nothing registered, no document
              // reporting: the post-update state, stated the way the worker states it.
              setTimeout(() => {
                for (const fn of listeners.slice()) {
                  fn({
                    kind: 'snapshot',
                    records: [],
                    requests: [],
                    closed: [],
                    droppedBefore: 0,
                    loaded: false,
                    info: null,
                    registration: { matches: [], error: null },
                  });
                }
              }, 0);
            },
            disconnect: () => {},
          };
        },
      },
      permissions: {
        contains: () => Promise.resolve(true),
      },
      devtools: {
        inspectedWindow: {
          // The port effect returns early without a numeric \`tabId\`, so the panel would never
          // subscribe and the snapshot above would never be delivered — the banner would sit in
          // its "checking…" state and this shim would stage nothing at all.
          tabId: 1,
          eval: (expression, callback) => {
            callback(expression === 'location.origin' ? ${JSON.stringify(HARNESS_INSPECTED_ORIGIN)} : null);
          },
        },
      },
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

/**
 * Serve a directory over HTTP. ES modules will not load over `file://`.
 *
 * `mounts` maps a URL path prefix to another directory. The listing generator needs the composing
 * frame served from the SAME origin as the panel — a cross-origin iframe cannot be driven by
 * `frameLocator` — so it mounts `listing/` at `/listing/` beside `dist/`. It defaults to `{}`, so
 * the gate's single-argument `startServer(distDir)` call serves exactly what it always did.
 */
export function startServer(
  root: string,
  mounts: Record<string, string> = {},
): Promise<StaticServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let base = root;
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    // Prefix match on the *normalized* path, not on `req.url`: matching before normalizing would
    // let `/listing/../../etc` select the mount and then resolve outside it. `rel` always starts
    // with `/`, so the slice leaves the remainder still rooted — `/listing/frames/x` becomes
    // `/frames/x` under the mounted directory.
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (rel.startsWith(`/${prefix}/`)) {
        base = dir;
        rel = rel.slice(prefix.length + 1);
        break;
      }
    }
    const file = join(base, rel);
    // `url.pathname` is always absolute (it starts with `/`), and `normalize` treats a leading
    // `/` as unclimbable — `normalize('/../x')` is `/x`, not `/x` escaped one level up — so `rel`
    // is already confined under `base` by the time it reaches here. That makes `startsWith(base)`
    // unreachable defence-in-depth as this code stands: no traversal payload can make it fail
    // while `normalize` runs first. It stays because `normalize` running first is an invariant of
    // this function, not of the type system — nothing stops a future edit from reordering these
    // two lines, and the day that happens this is the check that saves it.
    if (!file.startsWith(base) || !isFile(file)) {
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
