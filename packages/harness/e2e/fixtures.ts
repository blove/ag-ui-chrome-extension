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
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Worker } from '@playwright/test';

import type { CaptureRecord } from '@devtools/core/model/types';

/**
 * Mirrors `RequestLine` in the locked contract verbatim. It is declared here rather than
 * imported because `packages/devtools/src/sw/protocol.ts` does not exist while the harness is
 * being built — the harness ships first, by design. Re-point this import at
 * `@devtools/sw/protocol` in the commit that creates that module.
 */
export interface RequestLine {
  connId: string;
  tMs: number;
  method: string;
  url: string;
  input: unknown;
}

export interface CaptureSnapshot {
  records: CaptureRecord[];
  requests: RequestLine[];
  droppedBefore: number;
}

/** The shape `src/sw/index.ts` attaches to the SW global. Undefined until that task lands. */
interface TestHook {
  records(): CaptureRecord[];
  requests(): RequestLine[];
  droppedBefore(): number;
  bytes(): number;
  clear(): void;
}

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION_DIST =
  process.env.AGUI_EXTENSION_DIST ?? resolve(harnessRoot, '../devtools/dist');

export async function launchWithExtension(): Promise<{
  ctx: BrowserContext;
  extensionId: string;
}> {
  // A missing dist launches a browser with no extension and fails later on a confusing
  // assertion about a marker that was never going to be there. Fail here instead.
  if (!existsSync(join(EXTENSION_DIST, 'manifest.json'))) {
    throw new Error(
      `${join(EXTENSION_DIST, 'manifest.json')} does not exist. ` +
        'Run `pnpm --filter ag-ui-devtools build` before the e2e suite.',
    );
  }
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'agui-harness-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
  });
  const sw = await serviceWorker(ctx);
  return { ctx, extensionId: new URL(sw.url()).host };
}

async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers()[0];
  if (existing) return existing;
  return ctx.waitForEvent('serviceworker', { timeout: 30_000 });
}

export async function readCapture(ctx: BrowserContext): Promise<CaptureSnapshot> {
  const sw = await serviceWorker(ctx);
  return sw.evaluate((): CaptureSnapshot => {
    // `__AGUI_DT_TEST__` is undefined on today's build — `src/sw/index.ts` is the phase-1
    // stub. Reporting empties rather than throwing is what lets the first e2e be green while
    // still asserting something true.
    const hook = (globalThis as { __AGUI_DT_TEST__?: TestHook }).__AGUI_DT_TEST__;
    if (!hook) {
      return { records: [], requests: [], droppedBefore: 0 };
    }
    return {
      records: hook.records(),
      requests: hook.requests(),
      droppedBefore: hook.droppedBefore(),
    };
  });
}
