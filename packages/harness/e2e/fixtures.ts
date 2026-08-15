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

import { chromium, type BrowserContext, type Worker } from '@playwright/test';

import type { CaptureRecord, Issue, Run } from '@devtools/core/model/types';
import { createRunBuilder } from '@devtools/core/normalizer/run-builder';
import type { RequestLine } from '@devtools/sw/protocol';

export type { RequestLine };

export interface CaptureSnapshot {
  records: CaptureRecord[];
  requests: RequestLine[];
  droppedBefore: number;
  /**
   * Whether a document in the browser has reported that its capture hooks are installed — the
   * same fact the worker puts on the panel's `snapshot`, read from the same function.
   *
   * This is the panel-facing state that used to be inferred from the permission instead, and the
   * inference is what let the panel report capture from documents it had never touched.
   */
  instrumented: boolean;
}

/** The shape `src/sw/index.ts` attaches to the SW global, unconditionally. */
interface TestHook {
  records(): CaptureRecord[];
  requests(): RequestLine[];
  droppedBefore(): number;
  bytes(): number;
  instrumented(): boolean;
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
      instrumented: hook.instrumented(),
    };
  });
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

export async function clearCapture(ctx: BrowserContext): Promise<void> {
  const sw = await serviceWorker(ctx);
  await sw.evaluate((): void => {
    const hook = (globalThis as { __AGUI_DT_TEST__?: TestHook }).__AGUI_DT_TEST__;
    if (!hook) throw new Error('__AGUI_DT_TEST__ is not installed on the service worker.');
    hook.clear();
  });
}
