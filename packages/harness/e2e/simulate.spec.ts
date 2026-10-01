/**
 * The run simulator's channel, end to end (§14.4, design R4/R6/R7): worker → top-frame relay →
 * `CustomEvent` on the page, and the hook's acks back the other way.
 *
 * Real extension, real browser. `page/simulate.html` stands in for Threadplane's hook: it records
 * every arm and disarm it is handed and answers each arm with acks, real and forged. The panel is
 * unreachable from Playwright (H4/H5), so the Arm button and the Developer-mode switch are the
 * worker hook's `arm` / `setDeveloperMode`, which call the functions the panel's commands call.
 *
 * WHAT IS HELD:
 *  - Developer mode off ⇒ the hook receives NOTHING (lock 2 is the extension's; R6).
 *  - Developer mode on ⇒ the hook receives exactly the command, as an object in its own world —
 *    the ISOLATED world's `CustomEvent` reaches the page's listener with a structured clone.
 *  - The hook's `consumed` ack reaches the worker; forged acks of the wrong shape, or for an arm
 *    that was never dispatched, do not.
 *  - A subframe's hook is never armed (top frame only; R7).
 *  - The page hears no `message` traffic from any of it.
 *
 * NOT VACUOUS. The off case is asserted against the relay's own answer (`developer-mode-off`) as
 * well as against the empty probe, and the on case against the exact command — a channel that
 * delivered nothing would fail the on case, and one that ignored the flag would fail the off case.
 */
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';

import { startPageServer, type PageServer } from '../page/serve.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';

import { clearCapture, launchWithExtension, simulator, tabIdOf, type Ack } from './fixtures.js';

interface SimulateProbe {
  arms: unknown[];
  disarms: unknown[];
  messages: unknown[];
  errors: string[];
}

declare global {
  interface Window {
    __SIMULATE_PROBE__?: SimulateProbe;
  }
}

function command(armId: string): unknown {
  return {
    v: 1,
    armId,
    adapter: 'langgraph',
    runs: [
      {
        frames: [
          { event: 'metadata', data: { run_id: 'sim-run-1' } },
          { event: 'values', data: { messages: [{ type: 'human', id: 'h1', content: 'hi' }], __interrupt__: [{ value: 'ok?', id: 'i1' }] } },
        ],
      },
      { frames: [{ event: 'values', data: { messages: [] } }] },
    ],
  };
}

async function probeOf(target: Page | Frame): Promise<SimulateProbe> {
  const probe = await target.evaluate(() => window.__SIMULATE_PROBE__);
  if (probe === undefined) throw new Error('the simulate page never ran its script');
  return probe;
}

/** Poll the worker until an ack in `state` for `armId` is held; the bound only matters when broken. */
async function waitForAck(ctx: BrowserContext, armId: string, state: Ack['state']): Promise<Ack[]> {
  const deadline = Date.now() + 15_000;
  let acks = await simulator.acks(ctx);
  while (!acks.some((ack) => ack.armId === armId && ack.state === state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    acks = await simulator.acks(ctx);
  }
  return acks;
}

let harness: HarnessServer;
let pageServer: PageServer;
let ctx: BrowserContext;
let page: Page;
let child: Frame;
let tabId: number;
let origin: string;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  harness = await startHarnessServer();
  pageServer = await startPageServer({ agentUrl: harness.url });
  ({ ctx } = await launchWithExtension());
  await clearCapture(ctx);

  page = await ctx.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${pageServer.url}simulate.html`);
  await page.waitForFunction(() => document.documentElement.dataset.simulate === 'ready');
  const frame = page.frames().find((candidate) => candidate.url().includes('?child'));
  if (frame === undefined) throw new Error('the subframe never loaded');
  child = frame;
  await child.waitForFunction(() => document.documentElement.dataset.simulate === 'ready');
  tabId = await tabIdOf(ctx, page);
  origin = new URL(pageServer.url).origin;
});

test.afterAll(async () => {
  await ctx.close();
  await pageServer.stop();
  await harness.stop();
});

test.describe.configure({ mode: 'serial' });

test('Developer mode off: the hook receives nothing', async () => {
  // Off by default — nothing has ever been stored for this origin.
  const dispatch = await simulator.arm(ctx, tabId, command('arm-off'));
  expect(dispatch).toEqual({ armId: 'arm-off', action: 'arm', outcome: 'developer-mode-off' });
  // The relay answers after it has decided, and the dispatch is synchronous, so an arm that had
  // been dispatched would already be in the probe.
  expect((await probeOf(page)).arms).toEqual([]);
});

test('Developer mode on: the hook receives exactly the command', async () => {
  expect(await simulator.setDeveloperMode(ctx, origin, true)).toBe(true);
  const dispatch = await simulator.arm(ctx, tabId, command('arm-on'));
  expect(dispatch).toEqual({ armId: 'arm-on', action: 'arm', outcome: 'dispatched' });
  expect((await probeOf(page)).arms).toEqual([command('arm-on')]);
});

test('the hook’s consumed ack reaches the worker; forged acks do not', async () => {
  const acks = await waitForAck(ctx, 'arm-on', 'consumed');
  // Exactly the two real acks, in order: the bad state, the extra key, the null detail and the
  // well-formed ack for an arm that was never dispatched are all dropped at the relay.
  expect(acks).toEqual([
    { v: 1, armId: 'arm-on', state: 'armed' },
    { v: 1, armId: 'arm-on', state: 'consumed', run: 0 },
  ]);
  expect(JSON.stringify(acks)).not.toContain('an ack must never carry this');
});

test('a subframe’s hook is never armed (top frame only)', async () => {
  expect((await probeOf(child)).arms).toEqual([]);
});

test('a disarm reaches the hook for an arm it was given', async () => {
  const dispatch = await simulator.disarm(ctx, tabId, 'arm-on');
  expect(dispatch).toEqual({ armId: 'arm-on', action: 'disarm', outcome: 'dispatched' });
  expect((await probeOf(page)).disarms).toEqual([{ v: 1, armId: 'arm-on' }]);
  expect(await waitForAck(ctx, 'arm-on', 'disarmed')).toContainEqual({ v: 1, armId: 'arm-on', state: 'disarmed' });
});

test('switching Developer mode off stops the next arm', async () => {
  expect(await simulator.setDeveloperMode(ctx, origin, false)).toBe(false);
  const dispatch = await simulator.arm(ctx, tabId, command('arm-after-off'));
  expect(dispatch?.outcome).toBe('developer-mode-off');
  expect((await probeOf(page)).arms).toEqual([command('arm-on')]);
});

test('the page hears no message traffic from the simulator, and nothing broke', async () => {
  expect((await probeOf(page)).messages).toEqual([]);
  expect((await probeOf(page)).errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('acks are cleared with the tab’s buffer', async () => {
  await clearCapture(ctx);
  expect(await simulator.acks(ctx)).toEqual([]);
});
