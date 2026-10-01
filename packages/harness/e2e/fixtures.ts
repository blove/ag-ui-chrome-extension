/**
 * Playwright helpers for the capture e2e (design H4/H5).
 *
 * Two mechanics here are verified, not guessed, and must not be "simplified":
 *
 *  1. The extension is loaded via `launchPersistentContext` with `--disable-extensions-except`
 *     + `--load-extension`, in PLAYWRIGHT'S BUNDLED CHROMIUM. Chrome 151 has removed
 *     `--load-extension`; pointing this at a `channel: 'chrome'` browser silently launches
 *     with no extension at all. `channel: 'chromium'` pins the bundled build — measured: drop
 *     it and `headless: true` resolves to `chromium-headless-shell`, which launches happily,
 *     registers no service worker, and reports no error.
 *  2. `ctx.serviceWorkers()` is frequently EMPTY immediately after launch — observed. The
 *     `waitForEvent('serviceworker')` fallback is the difference between a reliable suite and
 *     a flaky one.
 *
 * The DevTools panel UI is NOT reachable and must not be driven from here. All assertions go
 * through `readCapture`, which reads the ring buffer out of the service worker.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import type { RuntimeInfo } from '@devtools/core/detect/info';
import type { ThreadplaneDevtoolsReport } from '@devtools/core/signals/report';
import type { CaptureRecord, Issue, Run } from '@devtools/core/model/types';
import { createRunBuilder } from '@devtools/core/normalizer/run-builder';
import { createLiveSession } from '@devtools/panel/capture/live-session';
import { initialPanelState, type PanelState } from '@devtools/panel/model/panel-types';
import {
  asSwMessage,
  PANEL_PORT_NAME,
  type ClosedConn,
  type RegistrationState,
  type RequestLine,
  type SignalReports,
} from '@devtools/sw/protocol';

export type { ClosedConn, RegistrationState, RequestLine, SignalReports };

export interface CaptureSnapshot {
  records: CaptureRecord[];
  requests: RequestLine[];
  droppedBefore: number;
  /**
   * Whether a document in the browser has reported that the capture layer is LOADED in it — the
   * same fact the worker puts on the panel's `snapshot`, read from the same function.
   *
   * This is the panel-facing state that used to be inferred from the permission instead, and the
   * inference is what let the panel report capture from documents it had never touched. The
   * report now travels the ISOLATED-world relay's `chrome.runtime` port; it used to be a
   * `window.postMessage` the inspected page could see.
   */
  loaded: boolean;
  /**
   * Connections the worker has seen close, each with the time it closed at.
   *
   * `readSettledCapture` waits on this; see the note there for why nothing else will do. The
   * `tMs` is the same one the worker puts on a late panel's `snapshot`, and `reconstruct` closes
   * at it — so the run-end issues this harness computes are anchored where the panel's are.
   */
  closes: ClosedConn[];
  /**
   * What a `/info` agent-discovery response told the worker, or `null` when none was seen.
   *
   * The same value the worker puts on a panel's `snapshot`, read from `snapshotFor` through the
   * hook — NOT assembled from the worker's state beside it. That distinction is load-bearing and
   * was learned the hard way here: a hook that built its own view of the same state kept this
   * suite green while `closed` was deleted from the message the panel actually receives.
   *
   * `null` is the ordinary answer for most pages and is not a failure — see `foldAsLatePanel`.
   */
  info: RuntimeInfo | null;
  /**
   * Which origins the capture content scripts are registered for, and the last real registration
   * failure — read through the worker's hook from the same `registrationState()` `snapshotFor`
   * embeds.
   *
   * The fact the "capture dies after an extension update" defect turns on. Chrome discards
   * dynamically registered content scripts on an update and keeps the permission, so the origin
   * being granted says nothing about whether anything is registered for it — and the panel, which
   * could only see the grant, advised a page reload that in that state does nothing at all.
   */
  registration: RegistrationState | null;
  /**
   * The Threadplane devtools reports the worker holds (design G5), oldest first, and how many its
   * ring evicted — the same `SignalReports` a panel's `snapshot` carries, read through the hook's
   * `snapshotFor`-backed accessors.
   */
  signals: SignalReports;
}

/** The shape `src/sw/index.ts` attaches to the SW global, unconditionally. */
interface TestHook {
  records(): CaptureRecord[];
  requests(): RequestLine[];
  droppedBefore(): number;
  bytes(): number;
  loaded(): boolean;
  closes(): ClosedConn[];
  info(): RuntimeInfo | null;
  registration(): RegistrationState | null;
  reconcileRegistrations(): Promise<void>;
  signals(): ThreadplaneDevtoolsReport[];
  signalsDropped(): number;
  clear(): void;
}

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION_DIST =
  process.env.AGUI_EXTENSION_DIST ?? resolve(harnessRoot, '../devtools/dist');

export interface LaunchOptions {
  /**
   * Extra Chromium arguments. The non-localhost suite passes
   * `--host-resolver-rules=MAP app.test 127.0.0.1` so a real hostname that is NOT in the
   * localhost family resolves to the harness server, which is the only way to exercise the
   * origin axis decision D3 is justified by.
   */
  args?: readonly string[];
  /**
   * The unpacked extension to load. Defaults to the real `dist/`; `distWithGrantedOrigin`
   * returns the copy the non-localhost suite loads instead.
   */
  dist?: string;
}

export async function launchWithExtension(options: LaunchOptions = {}): Promise<{
  ctx: BrowserContext;
  extensionId: string;
}> {
  const dist = options.dist ?? EXTENSION_DIST;
  // A missing dist launches a browser with no extension and fails later on a confusing
  // assertion about a marker that was never going to be there. Fail here instead.
  if (!existsSync(join(dist, 'manifest.json'))) {
    throw new Error(
      `${join(dist, 'manifest.json')} does not exist. ` +
        'Run `pnpm --filter ag-ui-devtools build` before the e2e suite.',
    );
  }
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'agui-harness-')), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      ...(options.args ?? []),
    ],
  });
  const sw = await serviceWorker(ctx);
  return { ctx, extensionId: new URL(sw.url()).host };
}

/**
 * A byte-identical copy of `dist/` whose manifest additionally declares `origin` as a static
 * host permission, and the path to it.
 *
 * WHY A COPY, AND WHAT IT DOES NOT SIMULATE. The product grants a non-localhost origin at
 * runtime: the panel calls `chrome.permissions.request`, and `src/sw/index.ts` turns the
 * resulting `permissions.onAdded` into `chrome.scripting.registerContentScripts`. Neither half
 * is drivable from Playwright — `chrome.permissions.request` throws without a real user gesture
 * and then raises a NATIVE confirmation dialog that no page-level automation can accept.
 *
 * So the grant, and only the grant, is faked: an unpacked extension receives the host
 * permissions its manifest declares at load time, with no prompt. Everything downstream of the
 * grant is real — the registration goes through `chrome.scripting.registerContentScripts` with
 * the manifest's own declarations, exactly as `registerForMatches` does, and the injected files
 * are the ones this build emitted, unmodified. The `onAdded` -> `registerForMatches` wiring
 * itself is unit-covered in `packages/devtools/src/sw/index.test.ts`.
 *
 * Nothing else in the manifest is touched, so the two things this suite is actually about —
 * whether the emitted content scripts are self-contained, and whether they still need a
 * `web_accessible_resources` grant the page's origin does not have — are read from the real
 * build.
 */
export function distWithGrantedOrigin(origin: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'agui-dist-granted-'));
  cpSync(EXTENSION_DIST, copy, { recursive: true });
  const manifestPath = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = [origin];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return copy;
}

async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers()[0];
  if (existing) return existing;
  return ctx.waitForEvent('serviceworker', { timeout: 30_000 });
}

export async function readCapture(ctx: BrowserContext): Promise<CaptureSnapshot> {
  const sw = await serviceWorker(ctx);
  return sw.evaluate((): CaptureSnapshot => {
    // The hook is installed unconditionally by `src/sw/index.ts`, so its absence is a broken
    // build, not a phase we are still in. Throwing names the cause; reporting empties would
    // make every capture assertion below silently vacuous.
    const hook = (globalThis as { __AGUI_DT_TEST__?: TestHook }).__AGUI_DT_TEST__;
    if (!hook) {
      throw new Error(
        '__AGUI_DT_TEST__ is not installed on the service worker. The loaded extension is not ' +
          'this working tree, or src/sw/index.ts stopped installing the hook.',
      );
    }
    return {
      records: hook.records(),
      requests: hook.requests(),
      droppedBefore: hook.droppedBefore(),
      loaded: hook.loaded(),
      closes: hook.closes(),
      info: hook.info(),
      registration: hook.registration(),
      signals: { reports: hook.signals(), droppedBefore: hook.signalsDropped() },
    };
  });
}

export interface SettleOptions {
  /** How many connections the run just driven is expected to have opened. Default 1. */
  connections?: number;
  /**
   * Upper bound on the wait.
   *
   * Fifteen seconds, which is arithmetic rather than taste: a `beforeAll` gets 60 s, spends up to
   * 30 s waiting for the page's own `#status`, and a few more starting servers and a browser, so
   * this is what is left over. It is also more than twenty times the worst delay measured on an
   * unloaded machine (627 ms), and the value only matters at all when something is genuinely
   * broken — the wait ends on a message, not on the clock.
   */
  timeoutMs?: number;
}

/**
 * Read the buffer once the capture of the run just driven is COMPLETE, rather than once the PAGE
 * says it is finished.
 *
 * WHY THIS EXISTS — the cause of a measured flake, not a precaution. Every spec here drives a run
 * and waits for `#status` to read `done`, which is the page's own promise resolving. That says
 * nothing about capture: `fetch-patch.ts` tees the response body and drains ITS branch
 * independently, then the frames cross `postMessage` -> ISOLATED relay -> runtime port -> the MV3
 * service worker. Nothing synchronises the two, so `readCapture` immediately after `done` reads a
 * pipeline that is still in flight.
 *
 * Measured on `a54a54c`, unmodified: `e2e/capture.spec.ts`'s happy run failed 2 of 25 full
 * `pnpm test` runs with an EMPTY buffer, and instrumenting the page showed why — at `done` the
 * MAIN world had already posted `conn-open`, `frames` and `conn-close`, and the run arrived
 * afterwards, whole and in order. Nothing was ever lost; the assertion simply ran first. On an
 * idle machine that delay is 18-70 ms and was seen as high as 627 ms; on a machine with no spare
 * cores it was seen at 3 s, 14 s, 19 s and 29 s, which is the other half of this fix — the root
 * `test` script no longer runs the devtools unit suite alongside this one.
 *
 * WHAT IS WAITED ON. `conn-close` is posted by the MAIN world when its own drain of the stream
 * ends, so a connection the worker has seen close is a connection whose capture is over — and
 * because port messages are ordered, every frame ahead of that close has been handled too. It is
 * a real message with a real cause, not a duration guessed at; the timeout is only there so a
 * capture layer that genuinely delivers nothing fails loudly instead of hanging.
 *
 * It is deliberately NOT a wait on the records themselves. Waiting for the run to look right and
 * then asserting that it looks right proves nothing, and would turn a lost frame into a timeout
 * with no diff. Every assertion downstream of this keeps its full force.
 */
export async function readSettledCapture(
  ctx: BrowserContext,
  options: SettleOptions = {},
): Promise<CaptureSnapshot> {
  const wanted = options.connections ?? 1;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let latest = await readCapture(ctx);
  for (;;) {
    const closed = new Set(latest.closes.map((close) => close.connId));
    const open = latest.requests.filter((request) => !closed.has(request.connId));
    if (latest.requests.length >= wanted && open.length === 0) return latest;
    if (Date.now() >= deadline) {
      throw new Error(
        `capture did not settle within ${String(timeoutMs)}ms: expected ${String(wanted)} ` +
          `connection(s) to open and close, saw ${String(latest.requests.length)} request line(s), ` +
          `${String(latest.closes.length)} close(s), ${String(latest.records.length)} record(s). ` +
          'A capture layer that never delivered is what this looks like; so is one that opened a ' +
          'connection it never closed.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await readCapture(ctx);
  }
}

/**
 * Empty every tab's buffer, so the next scenario is measured on its own.
 *
 * `seq` is deliberately NOT reset by a clear — the worker keeps it monotonic per tab so a frame
 * still in flight cannot collide with a fresh one — so a test that asserts on absolute seq
 * numbers must run its scenario in a NEW tab rather than reusing a cleared one.
 */
export interface Reconstruction {
  runs: Run[];
  issues: Issue[];
}

/**
 * What a panel opened after the run holds, beyond its runs and issues.
 *
 * Separate from `Reconstruction` because `reconstruct` — the IMPORT-path model — cannot produce
 * it: an import reads the metadata out of a file header, and there is no file here. This is the
 * live half of that same fact.
 */
export interface LatePanelFold extends Reconstruction {
  /** `PanelState.runtime` as the panel's own fold produces it. */
  runtime: RuntimeInfo | null;
}

/**
 * Fold a captured snapshot with the real `core/` pipeline — the equivalence proof this whole
 * milestone exists for.
 *
 * This is deliberately the SAME sequence `panel/import/load-jsonl.ts` performs over an imported
 * `.agui.jsonl`: request lines first, then records in `seq` order, then every connection closed
 * at its last observed frame. So "what the panel would show for a live capture" and "what it
 * shows for the golden fixture" are computed by one code path, and a difference between them is
 * a difference in the CAPTURED BYTES, not in the reader.
 *
 * Closing is what runs the finalize rules, so an unterminated run reports
 * `run-never-terminated` here exactly as it does on import.
 */
export function reconstruct(capture: CaptureSnapshot): Reconstruction {
  const builder = createRunBuilder();
  const lastTMsByConn = new Map<string, number>();

  for (const request of capture.requests) {
    builder.addRequest(request.connId, request.method, request.url, request.input);
    lastTMsByConn.set(request.connId, request.tMs);
  }
  for (const record of capture.records) {
    builder.addRecord(record);
    lastTMsByConn.set(record.connId, record.tMs);
  }
  for (const [connId, tMs] of lastTMsByConn) builder.closeConnection(connId, tMs);

  return { runs: builder.runs(), issues: builder.allIssues() };
}

/**
 * Fold a captured snapshot the way a panel opened AFTER the run does — through the real
 * `createLiveSession`, from the real `snapshot` message the worker builds.
 *
 * `reconstruct` above models the IMPORT path. This models the other one, and the two must agree:
 * that they did not is the defect this exists to hold. The panel UI is unreachable from
 * Playwright (H4/H5), but the fold beneath it is a pure function of the worker's state, so this
 * drives exactly the code the panel runs on `case 'snapshot'` with exactly the bytes the worker
 * would have sent.
 *
 * The closes come with their own `tMs` and are replayed as such — closing is the sole trigger for
 * `finalizeRules`, so a snapshot without them leaves every finished run in `outcome: 'running'`.
 */
export function foldAsLatePanel(capture: CaptureSnapshot): LatePanelFold {
  const session = createLiveSession();
  const state = session.apply(initialPanelState(), {
    kind: 'snapshot',
    records: capture.records,
    requests: capture.requests,
    closed: capture.closes,
    droppedBefore: capture.droppedBefore,
    loaded: capture.loaded,
    // The agent metadata reaches a late panel on the snapshot and nowhere else — the `info` push
    // arm was broadcast long before this panel existed. Spec §13 done-when #2 is exactly this
    // ordering: the panel is opened after the client connected, and the list is still there.
    info: capture.info,
    // Not read by the runs or the issues — it drives the capture BANNER, which is unreachable
    // from Playwright. Stated so the message this builds is the message `snapshotFor` produces:
    // a late-panel fold assembled from a different shape than the worker actually sends is the
    // exact drift this helper exists to rule out.
    registration: capture.registration,
    // Not read by the runs or the issues either; stated for the same reason as `registration`.
    signals: capture.signals,
  });
  return { runs: state.runs, issues: state.issues, runtime: state.runtime };
}

export async function clearCapture(ctx: BrowserContext): Promise<void> {
  const sw = await serviceWorker(ctx);
  await sw.evaluate((): void => {
    const hook = (globalThis as { __AGUI_DT_TEST__?: TestHook }).__AGUI_DT_TEST__;
    if (!hook) throw new Error('__AGUI_DT_TEST__ is not installed on the service worker.');
    hook.clear();
  });
}

/** What the toolbar shows for one tab: the badge text and the action's title (spec §14.6). */
export interface BadgeReading {
  text: string;
  title: string;
}

/**
 * The toolbar badge and title Chrome holds for `page`'s tab, read in the extension's service
 * worker with `chrome.action.getBadgeText` / `getTitle` — the values Chrome draws, not the
 * worker's own idea of them.
 *
 * FINDING THE TAB. The worker cannot look the page up by URL: `chrome.tabs.query` withholds
 * `url` without the `tabs` permission or an explicit host permission, and the localhost
 * content-script matches are neither (measured — every tab reads `url: undefined`, so a URL filter
 * finds nothing). Adding either would test a build that is not the one shipped. So the page is
 * brought to the front, which makes its tab the ACTIVE tab of its window, and the window is named
 * by CDP's `Browser.getWindowForTarget` — the same id `chrome.windows` uses. Specs here are
 * serial (`workers: 1`), so nothing else can take the front between the two steps.
 */
interface ActionReader {
  tabs: { query(filter: { active: true; windowId: number }): Promise<{ id?: number }[]> };
  action: {
    getBadgeText(details: { tabId: number }): Promise<string>;
    getTitle(details: { tabId: number }): Promise<string>;
  };
}

/** The `chrome.tabs` id of `page`'s tab, found as described above. */
export async function tabIdOf(ctx: BrowserContext, page: Page): Promise<number> {
  await page.bringToFront();
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  await cdp.detach();
  const sw = await serviceWorker(ctx);
  return sw.evaluate(async (windowId: number): Promise<number> => {
    const chrome = (globalThis as unknown as { chrome: ActionReader }).chrome;
    const active = await chrome.tabs.query({ active: true, windowId });
    const tabId = active[0]?.id;
    if (active.length !== 1 || tabId === undefined) {
      throw new Error(`expected one active tab in window ${String(windowId)}, found ${String(active.length)}`);
    }
    return tabId;
  }, windowId);
}

export async function readBadge(ctx: BrowserContext, page: Page): Promise<BadgeReading> {
  const tabId = await tabIdOf(ctx, page);
  const sw = await serviceWorker(ctx);
  return sw.evaluate(async (tabId: number): Promise<BadgeReading> => {
    const chrome = (globalThis as unknown as { chrome: ActionReader }).chrome;
    const [text, title] = await Promise.all([
      chrome.action.getBadgeText({ tabId }),
      chrome.action.getTitle({ tabId }),
    ]);
    return { text, title };
  }, tabId);
}

/**
 * `readBadge`, once the worker has stopped changing it.
 *
 * Call it AFTER `readSettledCapture`: by then every frame of the run has been handled, and the
 * worker has issued every `chrome.action` call it is going to. Those calls are asynchronous, so
 * this reads until three consecutive readings 50 ms apart agree. It waits for the badge to be
 * STILL, never for it to be RIGHT — the same rule `readSettledCapture` keeps, so a badge that
 * never lights is a diff, not a timeout, and a `''` that stays `''` means something.
 */
export async function readSettledBadge(
  ctx: BrowserContext,
  page: Page,
  timeoutMs = 5_000,
): Promise<BadgeReading> {
  const deadline = Date.now() + timeoutMs;
  let latest = await readBadge(ctx, page);
  let agreeing = 1;
  while (agreeing < 3) {
    if (Date.now() >= deadline) {
      throw new Error(`the badge did not settle within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = await readBadge(ctx, page);
    agreeing = next.text === latest.text && next.title === latest.title ? agreeing + 1 : 1;
    latest = next;
  }
  return latest;
}

interface PortOpener {
  runtime: {
    connect(info: { name: string }): {
      onMessage: { addListener(listener: (message: unknown) => void): void };
      postMessage(message: unknown): void;
    };
  };
}

/**
 * A real panel port to the worker, opened from an extension page and subscribed to `tabId`.
 *
 * The DevTools panel itself is unreachable from Playwright (H4/H5), but its PORT is not: it is a
 * plain `chrome.runtime.connect` with the panel's port name, which any page of this extension can
 * open. So this is the worker's real broadcast path — the one a panel that is open WHILE the page
 * runs is fed by — rather than `snapshotFor`, which only describes a panel that arrives late.
 *
 * Opened from `devtools.html` because it is the smallest page the build ships. Its own script
 * calls `chrome.devtools.panels.create`, which does not exist outside DevTools and throws; that
 * is irrelevant here, since nothing on the page is used but `chrome.runtime`.
 */
export interface PanelPortTap {
  /** Every message the worker has posted to this port, raw and in order. */
  received(): Promise<unknown[]>;
  /** Resolve once the worker has posted a message of `kind`. */
  waitForKind(kind: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function openPanelPort(
  ctx: BrowserContext,
  extensionId: string,
  tabId: number,
): Promise<PanelPortTap> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/panel/devtools.html`);
  await page.evaluate(
    ({ name, tabId }: { name: string; tabId: number }): void => {
      const w = window as unknown as { __received: unknown[] };
      w.__received = [];
      const chrome = (globalThis as unknown as { chrome: PortOpener }).chrome;
      const port = chrome.runtime.connect({ name });
      port.onMessage.addListener((message: unknown) => {
        w.__received.push(message);
      });
      port.postMessage({ kind: 'subscribe', tabId });
    },
    { name: PANEL_PORT_NAME, tabId },
  );
  const tap: PanelPortTap = {
    received: () => page.evaluate(() => (window as unknown as { __received: unknown[] }).__received),
    waitForKind: async (kind, timeoutMs = 15_000) => {
      await page.waitForFunction(
        (kind: string) =>
          (window as unknown as { __received: { kind?: unknown }[] }).__received.some(
            (message) => message.kind === kind,
          ),
        kind,
        { timeout: timeoutMs },
      );
    },
    close: () => page.close(),
  };
  // Nothing is replayed to a port until it has subscribed, so the snapshot is the proof it has.
  await tap.waitForKind('snapshot');
  return tap;
}

/**
 * What a panel that was OPEN while the messages arrived holds: each raw port message narrowed by
 * the panel's own `asSwMessage` — the filter `connectToServiceWorker` applies — and folded by its
 * own `createLiveSession`, in arrival order. A kind the port filter drops never reaches the fold
 * here, exactly as it would not in the shipped panel.
 */
export function foldAsLivePanel(received: readonly unknown[]): PanelState {
  const session = createLiveSession();
  let state = initialPanelState();
  for (const raw of received) {
    const message = asSwMessage(raw);
    if (message !== null) state = session.apply(state, message);
  }
  return state;
}
