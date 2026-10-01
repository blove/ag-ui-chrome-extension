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
import { loadFixture } from '../src/test/load-capture';

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
 *
 * `devtools-granted-unregistered` is the third, and it is the ONE case that has to cross the line
 * the `runtime.connect` note above draws — deliberately, and in the opposite direction.
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
export type ShimKind =
  | 'no-devtools'
  | 'devtools-ungranted'
  | 'devtools-granted-unregistered'
  | 'devtools-live-signals'
  | 'devtools-live-simulate'
  | 'devtools-live-genui';

/** The localhost origin `devtools-live-signals` reports — auto-enabled (D3), so capture turns on. */
export const SIGNALS_INSPECTED_ORIGIN = 'http://localhost:5173';

/**
 * The live state `devtools-live-signals` stages: one AG-UI run on the wire, and the Threadplane
 * devtools reports (design G2) its app dispatched while reducing it — plus a LangGraph agent that
 * reported without any frame on the wire, so the gate can see a block with nothing to match.
 *
 * TEST-ONLY. It lives in `scripts/`, reaches the panel only through Playwright's
 * `addInitScript`, and nothing under `src/` imports it — the production bundle never contains it
 * (`verify:build` checks the built files).
 */
function seedRecord(seq: number, type: string, extra: Record<string, unknown> = {}) {
  const event = { type, ...extra };
  return { kind: 'event', seq, tMs: 100 + seq * 40, connId: 'c1', raw: event, event, issues: [] };
}

const SEED_RECORDS = [
  seedRecord(0, 'RUN_STARTED', { threadId: 't1', runId: 'r1' }),
  seedRecord(1, 'TEXT_MESSAGE_START', { messageId: 'm1', role: 'assistant' }),
  seedRecord(2, 'TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'Hello' }),
  seedRecord(3, 'TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: ', ' }),
  seedRecord(4, 'TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'world' }),
  seedRecord(5, 'TEXT_MESSAGE_END', { messageId: 'm1' }),
  seedRecord(6, 'STATE_SNAPSHOT', { snapshot: { step: 1 } }),
  seedRecord(7, 'RUN_FINISHED', { threadId: 't1', runId: 'r1' }),
];

const AG_UI_AGENT = '7c1e9a42-5d3b-4f8e-a0b1-2c3d4e5f6a7b';
const LANGGRAPH_AGENT = 'e93f0d18-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

function seedReport(
  agent: string,
  adapter: 'ag-ui' | 'langgraph',
  seq: number,
  eventType: string,
  wrote: string[],
  tMs: number,
) {
  return { v: 1, agent, adapter, seq, eventType, wrote, tMs };
}

/**
 * The `wrote` lists are what Threadplane's instrumentation actually reports for these events (its
 * own tests on cacheplane/threadplane#1203): TEXT_MESSAGE_END writes nothing, so it has no report,
 * and a LangGraph run settles in two `run:end` steps.
 */
const SEED_REPORTS = [
  seedReport(AG_UI_AGENT, 'ag-ui', 1, 'submit', ['messages'], 90),
  seedReport(AG_UI_AGENT, 'ag-ui', 2, 'RUN_STARTED', ['status', 'isLoading', 'error', 'interrupt', 'customEvents', 'activities'], 101),
  seedReport(AG_UI_AGENT, 'ag-ui', 3, 'TEXT_MESSAGE_START', ['messages'], 141),
  seedReport(AG_UI_AGENT, 'ag-ui', 4, 'TEXT_MESSAGE_CONTENT', ['messages'], 181),
  seedReport(AG_UI_AGENT, 'ag-ui', 5, 'TEXT_MESSAGE_CONTENT', ['messages'], 221),
  seedReport(AG_UI_AGENT, 'ag-ui', 6, 'TEXT_MESSAGE_CONTENT', ['messages'], 261),
  seedReport(AG_UI_AGENT, 'ag-ui', 7, 'STATE_SNAPSHOT', ['state', 'messages'], 341),
  seedReport(AG_UI_AGENT, 'ag-ui', 8, 'RUN_FINISHED', ['messages', 'status', 'isLoading', 'interruptSession', 'interrupt'], 381),
  seedReport(LANGGRAPH_AGENT, 'langgraph', 1, 'run:start', ['status', 'error', 'custom', 'toolProgress', 'messages'], 50),
  seedReport(LANGGRAPH_AGENT, 'langgraph', 2, 'values', ['values', 'messages', 'subagents', 'toolCalls'], 60),
  seedReport(LANGGRAPH_AGENT, 'langgraph', 3, 'run:end', ['subagents'], 70),
  seedReport(LANGGRAPH_AGENT, 'langgraph', 4, 'run:end', ['status'], 71),
];

/**
 * What the gate asserts against: the third TEXT_MESSAGE_CONTENT report (agent seq 6) is the third
 * TEXT_MESSAGE_CONTENT frame on the wire, record seq 4 — matched by name and order.
 */
export const SIGNALS_SEED = {
  agUiAgent: AG_UI_AGENT,
  langGraphAgent: LANGGRAPH_AGENT,
  litCells: SEED_REPORTS.reduce((total, report) => total + report.wrote.length, 0),
  clickReportSeq: 6,
  expectedRecordSeq: 4,
} as const;

const SIGNALS_SNAPSHOT = {
  kind: 'snapshot',
  records: SEED_RECORDS,
  requests: [
    {
      connId: 'c1',
      tMs: 100,
      method: 'POST',
      url: `${SIGNALS_INSPECTED_ORIGIN}/agent`,
      input: { threadId: 't1', runId: 'r1', messages: [], tools: [], context: [], state: {} },
    },
  ],
  closed: [{ connId: 'c1', tMs: 420 }],
  droppedBefore: 0,
  loaded: true,
  info: null,
  registration: { matches: [], error: null },
  signals: { reports: SEED_REPORTS, droppedBefore: 0 },
  renders: { reports: [], droppedBefore: 0 },
  simAcks: [],
};

/**
 * The UI tab's live gate (§14.5, U6): `devtools-live-genui` is a live tab whose capture is the
 * `genui-threadplane-agui` fixture — the same records an import of that file gives — plus ONE
 * Threadplane render report (U4) for its cockpit dashboard, `spec:root`, as the hook would send it
 * after rendering run `r-tp2`'s spec: a registry without `line_chart` / `bar_chart`, so those two
 * elements are `unresolved`; `delay_card` still waiting on data (`fallback`); `table_section` not
 * visible (`hidden`). The gate imports the same fixture first, so it can assert the node states
 * switch from the wire checks' to the hook's.
 *
 * TEST-ONLY, like the seeds above.
 */
const GENUI_FIXTURE = loadFixture('genui-threadplane-agui.agui.jsonl');

export const GENUI_RENDER_REPORT = {
  v: 1,
  kind: 'render',
  surface: 'spec:root',
  seq: 3,
  registry: ['dashboard_grid', 'container', 'stat_card', 'data_grid', 'text'],
  elements: [
    { key: 'root', type: 'dashboard_grid', state: 'mounted' },
    { key: 'stats_row', type: 'container', state: 'mounted' },
    { key: 'on_time_card', type: 'stat_card', state: 'mounted' },
    { key: 'flights_card', type: 'stat_card', state: 'mounted' },
    { key: 'delay_card', type: 'stat_card', state: 'fallback' },
    { key: 'load_card', type: 'stat_card', state: 'mounted' },
    { key: 'charts_row', type: 'container', state: 'mounted' },
    { key: 'trend_chart', type: 'line_chart', state: 'unresolved' },
    { key: 'airline_chart', type: 'bar_chart', state: 'unresolved' },
    { key: 'table_section', type: 'data_grid', state: 'hidden' },
  ],
  tMs: 900,
} as const;

function lastCloses(records: readonly { connId: string; tMs: number }[]): { connId: string; tMs: number }[] {
  const last = new Map<string, number>();
  for (const record of records) last.set(record.connId, record.tMs);
  return [...last].map(([connId, tMs]) => ({ connId, tMs }));
}

const GENUI_SNAPSHOT = {
  kind: 'snapshot',
  records: GENUI_FIXTURE.records,
  requests: GENUI_FIXTURE.requests,
  closed: lastCloses(GENUI_FIXTURE.records),
  droppedBefore: 0,
  loaded: true,
  info: null,
  registration: { matches: [], error: null },
  signals: { reports: [], droppedBefore: 0 },
  renders: { reports: [GENUI_RENDER_REPORT], droppedBefore: 0 },
  simAcks: [],
};

/**
 * The run simulator's gate (§14.4). `devtools-live-simulate` is `devtools-live-signals`' live tab
 * — the same snapshot, so the Simulate tab infers LangGraph from the latest Signals report and has
 * a captured run to replay — plus a stand-in for the two legs past the panel:
 *
 *  - the WORKER: it stores Developer mode per origin (off until the panel's switch sets it) and
 *    answers `developer-mode.get` / `.set` with `developer-mode`, as `sw/index.ts` does; it answers
 *    `simulate.arm` / `.disarm` with `sim-dispatch` — `developer-mode-off` while off, as the relay
 *    does — and otherwise dispatches `threadplane:devtools:arm` / `:disarm` on `window` and relays
 *    each `threadplane:devtools:ack` for an arm it dispatched as `sim-ack`;
 *  - the HOOK: `harness/page/simulate.html`'s fake, reduced to its real acks — `armed` at once,
 *    then `consumed` for run 0 (the run the next stream call takes), 0-based as Threadplane acks.
 *
 * The real channel (worker → top-frame relay → page) is `harness/e2e/simulate.spec.ts`'s; this
 * shim exists so the gate can photograph the panel driving it. `__SIMULATE_HOOK__` records the
 * arms the hook received, so the gate can assert the panel sent exactly one, for LangGraph.
 */
const SIMULATE_SHIM = `
  (function () {
    var hook = { arms: [], disarms: [] };
    window.__SIMULATE_HOOK__ = hook;
    function ack(detail) {
      window.dispatchEvent(new CustomEvent('threadplane:devtools:ack', { detail: detail }));
    }
    window.addEventListener('threadplane:devtools:arm', function (event) {
      var command = event.detail;
      hook.arms.push(command);
      ack({ v: 1, armId: command.armId, state: 'armed' });
      setTimeout(function () { ack({ v: 1, armId: command.armId, state: 'consumed', run: 0 }); }, 300);
    });
    window.addEventListener('threadplane:devtools:disarm', function (event) {
      hook.disarms.push(event.detail);
      ack({ v: 1, armId: event.detail.armId, state: 'disarmed' });
    });

    var developerMode = {};
    var dispatched = new Set();
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.0.0-harness' }),
        connect: () => {
          const listeners = [];
          const send = (message) => setTimeout(() => { for (const fn of listeners.slice()) fn(message); }, 0);
          window.addEventListener('threadplane:devtools:ack', (event) => {
            const ack = event.detail;
            if (ack && dispatched.has(ack.armId)) send({ kind: 'sim-ack', ack: ack });
          });
          return {
            onMessage: { addListener: (fn) => { listeners.push(fn); }, removeListener: () => {} },
            onDisconnect: { addListener: () => {}, removeListener: () => {} },
            postMessage: (command) => {
              if (!command) return;
              switch (command.kind) {
                case 'subscribe':
                  send(${JSON.stringify(SIGNALS_SNAPSHOT)});
                  return;
                case 'developer-mode.get':
                  send({ kind: 'developer-mode', origin: command.origin, enabled: developerMode[command.origin] === true });
                  return;
                case 'developer-mode.set':
                  developerMode[command.origin] = command.enabled === true;
                  send({ kind: 'developer-mode', origin: command.origin, enabled: developerMode[command.origin] });
                  return;
                case 'simulate.arm': {
                  const armId = command.command.armId;
                  if (developerMode[${JSON.stringify(SIGNALS_INSPECTED_ORIGIN)}] !== true) {
                    send({ kind: 'sim-dispatch', armId: armId, action: 'arm', outcome: 'developer-mode-off' });
                    return;
                  }
                  dispatched.add(armId);
                  send({ kind: 'sim-dispatch', armId: armId, action: 'arm', outcome: 'dispatched' });
                  window.dispatchEvent(new CustomEvent('threadplane:devtools:arm', { detail: command.command }));
                  return;
                }
                case 'simulate.disarm':
                  send({ kind: 'sim-dispatch', armId: command.armId, action: 'disarm', outcome: 'dispatched' });
                  window.dispatchEvent(new CustomEvent('threadplane:devtools:disarm', { detail: { v: 1, armId: command.armId } }));
                  return;
              }
            },
            disconnect: () => {},
          };
        },
      },
      permissions: { contains: () => Promise.resolve(true) },
      devtools: {
        inspectedWindow: {
          tabId: 1,
          eval: (expression, callback) => {
            callback(expression === 'location.origin' ? ${JSON.stringify(SIGNALS_INSPECTED_ORIGIN)} : null);
          },
        },
      },
    };
  })();
`;

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
                    // A real answer, not \`null\`: the worker HAS read Chrome and nothing is
                    // registered. \`null\` would mean "not known yet", which warns about nothing.
                    registration: { matches: [], error: null },
                    signals: { reports: [], droppedBefore: 0 },
                    renders: { reports: [], droppedBefore: 0 },
                    simAcks: [],
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
  // A live, auto-enabled localhost tab whose worker answers `subscribe` with SIGNALS_SNAPSHOT —
  // the panel's own wire format, delivered through the panel's own port code.
  'devtools-live-signals': `
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
              setTimeout(() => {
                for (const fn of listeners.slice()) fn(${JSON.stringify(SIGNALS_SNAPSHOT)});
              }, 0);
            },
            disconnect: () => {},
          };
        },
      },
      permissions: { contains: () => Promise.resolve(true) },
      devtools: {
        inspectedWindow: {
          tabId: 1,
          eval: (expression, callback) => {
            callback(expression === 'location.origin' ? ${JSON.stringify(SIGNALS_INSPECTED_ORIGIN)} : null);
          },
        },
      },
    };
  `,
  'devtools-live-simulate': SIMULATE_SHIM,
  // A live localhost tab whose capture is the genui-threadplane-agui fixture plus one render report.
  'devtools-live-genui': `
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
              setTimeout(() => {
                for (const fn of listeners.slice()) fn(${JSON.stringify(GENUI_SNAPSHOT)});
              }, 0);
            },
            disconnect: () => {},
          };
        },
      },
      permissions: { contains: () => Promise.resolve(true) },
      devtools: {
        inspectedWindow: {
          tabId: 1,
          eval: (expression, callback) => {
            callback(expression === 'location.origin' ? ${JSON.stringify(SIGNALS_INSPECTED_ORIGIN)} : null);
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
