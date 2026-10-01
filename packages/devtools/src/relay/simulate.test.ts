import { describe, expect, it, vi } from 'vitest';

import type { ArmCommand } from '../core/simulate/commands';
import type { RelayMessage } from '../sw/protocol';
import { installSimulateRelay, MAX_REMEMBERED_ARMS, type SimulateHost } from './simulate';

const COMMAND: ArmCommand = {
  v: 1,
  armId: 'arm-1',
  adapter: 'ag-ui',
  runs: [{ events: [{ type: 'RUN_STARTED', threadId: 't', runId: 'r' }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r' }] }],
};

interface Rig {
  host: SimulateHost;
  target: EventTarget;
  /** Every arm/disarm event the page would have heard, with its detail. */
  heard: Array<{ type: string; detail: unknown }>;
  sent: RelayMessage[];
  readDeveloperMode: ReturnType<typeof vi.fn<(origin: string) => Promise<boolean>>>;
  top: { value: boolean };
}

function rig(options: { developerMode?: unknown; top?: boolean } = {}): Rig {
  const target = new EventTarget();
  const heard: Rig['heard'] = [];
  for (const type of ['threadplane:devtools:arm', 'threadplane:devtools:disarm']) {
    target.addEventListener(type, (event) => heard.push({ type, detail: (event as CustomEvent).detail }));
  }
  const sent: RelayMessage[] = [];
  const top = { value: options.top ?? true };
  const readDeveloperMode = vi.fn(async (): Promise<boolean> => options.developerMode as boolean);
  const host: SimulateHost = {
    target,
    makeEvent: (type, detail) => new CustomEvent(type, { detail }),
    origin: 'https://app.test',
    isTopFrame: () => top.value,
    readDeveloperMode,
    send: (message) => sent.push(message),
  };
  return { host, target, heard, sent, readDeveloperMode, top };
}

function ack(detail: unknown): CustomEvent {
  return new CustomEvent('threadplane:devtools:ack', { detail });
}

describe('arm — the two locks the extension holds', () => {
  it('dispatches the command on the page when Developer mode is on for this origin', async () => {
    const r = rig({ developerMode: true });
    const relay = installSimulateRelay(r.host);
    await expect(relay.handle({ kind: 'simulate.arm', command: COMMAND })).resolves.toEqual({ outcome: 'dispatched' });
    expect(r.heard).toEqual([{ type: 'threadplane:devtools:arm', detail: COMMAND }]);
    // The flag is read for this document's own origin, not one the message names.
    expect(r.readDeveloperMode).toHaveBeenCalledWith('https://app.test');
  });

  it('dispatches nothing when Developer mode is off', async () => {
    const r = rig({ developerMode: false });
    const relay = installSimulateRelay(r.host);
    await expect(relay.handle({ kind: 'simulate.arm', command: COMMAND })).resolves.toEqual({ outcome: 'developer-mode-off' });
    expect(r.heard).toEqual([]);
  });

  it('treats a flag that is not exactly true, or cannot be read, as off', async () => {
    for (const developerMode of ['true', 1, undefined, null]) {
      const r = rig({ developerMode });
      await installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command: COMMAND });
      expect(r.heard).toEqual([]);
    }
    const r = rig();
    r.readDeveloperMode.mockRejectedValueOnce(new Error('Extension context invalidated.'));
    await expect(installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command: COMMAND })).resolves.toEqual({
      outcome: 'developer-mode-off',
    });
    expect(r.heard).toEqual([]);
  });

  it('dispatches nothing in a subframe, without even reading the flag (R7)', async () => {
    const r = rig({ developerMode: true, top: false });
    await expect(installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command: COMMAND })).resolves.toEqual({
      outcome: 'not-top-frame',
    });
    expect(r.heard).toEqual([]);
    expect(r.readDeveloperMode).not.toHaveBeenCalled();
  });

  it('dispatches nothing for a command that does not validate', async () => {
    const r = rig({ developerMode: true });
    const relay = installSimulateRelay(r.host);
    for (const command of [{ ...COMMAND, runs: [] }, { ...COMMAND, extra: 1 }, null, 'arm']) {
      await expect(relay.handle({ kind: 'simulate.arm', command })).resolves.toEqual({ outcome: 'invalid' });
    }
    expect(r.heard).toEqual([]);
  });

  it('dispatches a copy carrying only the contract, never the object it was handed', async () => {
    const r = rig({ developerMode: true });
    const command = structuredClone(COMMAND);
    await installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command });
    expect(r.heard[0]?.detail).toEqual(COMMAND);
    expect(r.heard[0]?.detail).not.toBe(command);
  });

  it('ignores a message that is not a simulator command', () => {
    const relay = installSimulateRelay(rig({ developerMode: true }).host);
    expect(relay.handle({ kind: 'capture-loaded' })).toBeNull();
    expect(relay.handle(null)).toBeNull();
    expect(relay.handle('simulate.arm')).toBeNull();
    // An inherited kind is not the message's own.
    expect(relay.handle(Object.create({ kind: 'simulate.arm', command: COMMAND }))).toBeNull();
  });
});

describe('disarm', () => {
  it('withdraws an arm this document dispatched — even after Developer mode was switched off', async () => {
    const r = rig({ developerMode: true });
    const relay = installSimulateRelay(r.host);
    await relay.handle({ kind: 'simulate.arm', command: COMMAND });
    r.readDeveloperMode.mockResolvedValue(false);
    await expect(relay.handle({ kind: 'simulate.disarm', armId: 'arm-1' })).resolves.toEqual({ outcome: 'dispatched' });
    expect(r.heard.at(-1)).toEqual({ type: 'threadplane:devtools:disarm', detail: { v: 1, armId: 'arm-1' } });
  });

  it('dispatches nothing for an arm this document never received, or a bad id', async () => {
    const r = rig({ developerMode: true });
    const relay = installSimulateRelay(r.host);
    await expect(relay.handle({ kind: 'simulate.disarm', armId: 'arm-9' })).resolves.toEqual({ outcome: 'unknown-arm' });
    await expect(relay.handle({ kind: 'simulate.disarm', armId: '<x>' })).resolves.toEqual({ outcome: 'invalid' });
    expect(r.heard).toEqual([]);
  });

  it('dispatches nothing in a subframe', async () => {
    const r = rig({ developerMode: true, top: false });
    await expect(installSimulateRelay(r.host).handle({ kind: 'simulate.disarm', armId: 'arm-1' })).resolves.toEqual({
      outcome: 'not-top-frame',
    });
  });
});

describe('acks (R4)', () => {
  it('forwards a valid ack for an arm dispatched here, as a copy', async () => {
    const r = rig({ developerMode: true });
    await installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command: COMMAND });
    r.target.dispatchEvent(ack({ v: 1, armId: 'arm-1', state: 'consumed', run: 0 }));
    expect(r.sent).toEqual([{ v: 1, kind: 'sim-ack', ack: { v: 1, armId: 'arm-1', state: 'consumed', run: 0 } }]);
  });

  it('forwards an ack the hook dispatches synchronously, inside the arm’s own dispatch', async () => {
    const r = rig({ developerMode: true });
    r.target.addEventListener('threadplane:devtools:arm', () => {
      r.target.dispatchEvent(ack({ v: 1, armId: 'arm-1', state: 'armed' }));
    });
    await installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command: COMMAND });
    expect(r.sent).toEqual([{ v: 1, kind: 'sim-ack', ack: { v: 1, armId: 'arm-1', state: 'armed' } }]);
  });

  it('drops an ack for an arm this document never dispatched — a page cannot invent arms', () => {
    const r = rig({ developerMode: true });
    installSimulateRelay(r.host);
    r.target.dispatchEvent(ack({ v: 1, armId: 'arm-1', state: 'consumed' }));
    expect(r.sent).toEqual([]);
  });

  it('drops a page-forged ack of the wrong shape, without throwing into the page', async () => {
    const r = rig({ developerMode: true });
    await installSimulateRelay(r.host).handle({ kind: 'simulate.arm', command: COMMAND });
    const throwing = { v: 1, armId: 'arm-1' };
    Object.defineProperty(throwing, 'state', {
      enumerable: true,
      get: () => {
        throw new Error('hostile');
      },
    });
    for (const detail of [
      { v: 1, armId: 'arm-1', state: 'pwned' },
      { v: 1, armId: 'arm-1', state: 'consumed', secret: 'x' },
      { v: 1, armId: 'arm-1', state: 'consumed', run: 99 },
      throwing,
      null,
      'consumed',
    ]) {
      expect(() => r.target.dispatchEvent(ack(detail))).not.toThrow();
    }
    r.target.dispatchEvent(new Event('threadplane:devtools:ack'));
    expect(r.sent).toEqual([]);
  });

  it('remembers a bounded number of arms', async () => {
    const r = rig({ developerMode: true });
    const relay = installSimulateRelay(r.host);
    for (let i = 0; i <= MAX_REMEMBERED_ARMS; i += 1) {
      await relay.handle({ kind: 'simulate.arm', command: { ...COMMAND, armId: `arm-${String(i)}` } });
    }
    r.target.dispatchEvent(ack({ v: 1, armId: 'arm-0', state: 'expired' }));
    r.target.dispatchEvent(ack({ v: 1, armId: `arm-${String(MAX_REMEMBERED_ARMS)}`, state: 'expired' }));
    expect(r.sent.map((message) => (message.kind === 'sim-ack' ? message.ack.armId : null))).toEqual([
      `arm-${String(MAX_REMEMBERED_ARMS)}`,
    ]);
  });
});
