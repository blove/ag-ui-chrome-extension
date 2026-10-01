import { describe, expect, it } from 'vitest';
import { MAX_ARM_CHARS, MAX_RUNS } from '../../core/simulate/commands';
import type { ThreadplaneDevtoolsReport } from '../../core/signals/report';
import { initialPanelState, type PanelState } from '../model/panel-types';
import {
  armDisabledReason,
  armRows,
  checkScript,
  describeOutcome,
  formatSize,
  inferAdapter,
  replayableRuns,
} from './simulate-model';

function report(adapter: 'ag-ui' | 'langgraph', seq: number): ThreadplaneDevtoolsReport {
  return { v: 1, agent: `agent-${adapter}`, adapter, seq, eventType: 'values', wrote: ['messages'], tMs: seq } as ThreadplaneDevtoolsReport;
}

function on(origin = 'http://localhost:5173', enabled = true): PanelState {
  return {
    ...initialPanelState(),
    capture: { kind: 'on', origin },
    source: { kind: 'live', origin },
    developerModes: { [origin]: enabled },
  };
}

describe('inferAdapter', () => {
  it('takes the adapter of the latest Signals report', () => {
    const s = { ...on(), signals: { reports: [report('ag-ui', 1), report('langgraph', 2)], droppedBefore: 0 } };
    expect(inferAdapter(s)).toEqual({ adapter: 'langgraph', from: 'signals' });
  });

  it('falls back to the connections: a LangGraph Platform connection means langgraph', () => {
    const s: PanelState = {
      ...on(),
      requests: [{ connId: 'c1', tMs: 0, method: 'POST', url: 'http://localhost:2024/threads/t/runs/stream', input: {} }],
    };
    expect(inferAdapter(s)).toEqual({ adapter: 'langgraph', from: 'connections' });
  });

  it('an AG-UI connection means ag-ui', () => {
    const s: PanelState = {
      ...on(),
      records: [
        { kind: 'event', seq: 0, tMs: 0, connId: 'c1', raw: { type: 'RUN_STARTED' }, event: { type: 'RUN_STARTED', threadId: 't', runId: 'r' }, issues: [] },
      ] as PanelState['records'],
    };
    expect(inferAdapter(s)).toEqual({ adapter: 'ag-ui', from: 'connections' });
  });

  it('with nothing seen, says so and defaults to ag-ui', () => {
    expect(inferAdapter(on())).toEqual({ adapter: 'ag-ui', from: 'default' });
  });
});

describe('armDisabledReason', () => {
  it('names the off origin when Developer mode is off', () => {
    expect(armDisabledReason(on('http://localhost:5173', false), true)).toBe(
      'Developer mode is off for http://localhost:5173. Turn it on above to arm.',
    );
  });

  it('names the origin capture is not enabled for', () => {
    const s: PanelState = { ...initialPanelState(), capture: { kind: 'off', origin: 'https://app.test', signal: { level: 'none' } } };
    expect(armDisabledReason(s, true)).toBe(
      'Capture is not enabled for https://app.test. Enable capture, then turn on Developer mode, to arm.',
    );
  });

  it('needs an inspected page and a live panel', () => {
    expect(armDisabledReason(initialPanelState(), true)).toMatch(/inspected page/);
    expect(armDisabledReason(on(), false)).toMatch(/live connection/);
  });

  it('is null — Arm enabled — only with capture on, Developer mode on and a live panel', () => {
    expect(armDisabledReason(on(), true)).toBeNull();
  });
});

describe('checkScript', () => {
  it('accepts a template’s runs and measures the command', () => {
    const result = checkScript('ag-ui', JSON.stringify([{ events: [{ type: 'RUN_STARTED' }] }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toHaveLength(1);
      expect(result.chars).toBeGreaterThan(30);
    }
  });

  it('says where the JSON is broken', () => {
    const result = checkScript('ag-ui', '[{ "events": ');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/^The script is not valid JSON/);
  });

  it('gives the validator’s reason for a script of the wrong shape, against the chosen adapter', () => {
    const result = checkScript('langgraph', JSON.stringify([{ events: [{ type: 'RUN_STARTED' }] }]));
    expect(result).toEqual({ ok: false, reason: 'runs[0] is missing "frames"', chars: expect.any(Number) });
  });

  it('enforces the run limit (R3)', () => {
    const runs = Array.from({ length: MAX_RUNS + 1 }, () => ({ events: [{ type: 'RUN_STARTED' }] }));
    const result = checkScript('ag-ui', JSON.stringify(runs));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('runs has 9 items; the limit is 8');
  });

  it('wants the runs array, not a whole command', () => {
    const result = checkScript('ag-ui', JSON.stringify({ runs: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/runs is not an array/);
  });
});

describe('formatSize', () => {
  it('shows the size against the 2 MB limit', () => {
    expect(formatSize(1536)).toBe('1.5 KB of 2 MB');
    expect(formatSize(MAX_ARM_CHARS + 1)).toBe('2.00 MB of 2 MB — over the limit');
  });
});

describe('describeOutcome', () => {
  it('words each refusal as "not sent", naming the origin when Developer mode is off', () => {
    expect(describeOutcome('developer-mode-off', 'https://app.test')).toBe('not sent: Developer mode is off for https://app.test');
    expect(describeOutcome('not-delivered', 'https://app.test')).toMatch(/^not sent: /);
    expect(describeOutcome('dispatched', 'x')).toBe('sent to the page');
  });
});

describe('armRows', () => {
  it('follows an arm from dispatch to its acks, newest arm first, runs shown 1-based', () => {
    const s: PanelState = {
      ...on(),
      simArmLabels: { a1: { template: 'Interrupt (approval)', runs: 2 }, a2: { template: 'Malformed event', runs: 1 } },
      simulator: {
        dispatches: [
          { armId: 'a1', action: 'arm', outcome: 'dispatched' },
          { armId: 'a2', action: 'arm', outcome: 'developer-mode-off' },
        ],
        acks: [
          { v: 1, armId: 'a1', state: 'armed' },
          { v: 1, armId: 'a1', state: 'consumed', run: 0 },
        ],
      },
    };
    const rows = armRows(s);
    expect(rows.map((row) => row.armId)).toEqual(['a2', 'a1']);
    expect(rows[0]).toMatchObject({ status: 'not sent: Developer mode is off for http://localhost:5173', cancellable: false, awaitingHook: false });
    expect(rows[1]).toMatchObject({
      label: 'Interrupt (approval)',
      status: 'consumed run 1 of 2',
      history: ['armed', 'consumed run 1 of 2'],
      cancellable: true,
      awaitingHook: false,
    });
  });

  it('is waiting on the hook between a successful dispatch and the first ack', () => {
    const s: PanelState = { ...on(), simulator: { dispatches: [{ armId: 'a1', action: 'arm', outcome: 'dispatched' }], acks: [] } };
    expect(armRows(s)[0]).toMatchObject({ status: 'sent — waiting for the page’s hook', awaitingHook: true, cancellable: true });
  });

  it('shows a rejection’s reason, and terminal states end Cancel', () => {
    const s: PanelState = {
      ...on(),
      simulator: {
        dispatches: [
          { armId: 'a1', action: 'arm', outcome: 'dispatched' },
          { armId: 'a2', action: 'arm', outcome: 'dispatched' },
          { armId: 'a3', action: 'arm', outcome: 'dispatched' },
        ],
        acks: [
          { v: 1, armId: 'a1', state: 'rejected', reason: 'too many runs' },
          { v: 1, armId: 'a2', state: 'expired' },
          { v: 1, armId: 'a3', state: 'armed' },
          { v: 1, armId: 'a3', state: 'disarmed' },
        ],
      },
    };
    const rows = armRows(s);
    expect(rows.map((row) => [row.armId, row.status, row.cancellable])).toEqual([
      ['a3', 'disarmed', false],
      ['a2', 'expired', false],
      ['a1', 'rejected: too many runs', false],
    ]);
  });

  it('a consumed last run ends Cancel; a refused Cancel says why', () => {
    const s: PanelState = {
      ...on(),
      simArmLabels: { a1: { template: 'Malformed event', runs: 1 } },
      simulator: {
        dispatches: [
          { armId: 'a1', action: 'arm', outcome: 'dispatched' },
          { armId: 'a2', action: 'arm', outcome: 'dispatched' },
          { armId: 'a2', action: 'disarm', outcome: 'unknown-arm' },
        ],
        acks: [{ v: 1, armId: 'a1', state: 'consumed', run: 0 }],
      },
    };
    const [a2, a1] = armRows(s);
    expect(a1).toMatchObject({ status: 'consumed run 1 of 1', cancellable: false });
    expect(a2?.cancelNote).toBe('cancel not sent: this page never received that arm');
  });

  it('lists an ack for an arm this panel did not send (a panel reopened after arming)', () => {
    const s: PanelState = { ...on(), simulator: { dispatches: [], acks: [{ v: 1, armId: 'old', state: 'armed' }] } };
    expect(armRows(s)).toEqual([
      expect.objectContaining({ armId: 'old', status: 'armed — the next run will be scripted', cancellable: true }),
    ]);
  });
});

describe('replayableRuns', () => {
  it('lists the capture’s runs by run id with their adapter', () => {
    const s: PanelState = {
      ...on(),
      runs: [
        { runId: 'r1', recordSeqs: [0, 1, 2] },
        { runId: 'lg-1', recordSeqs: [3], dialect: 'langgraph' },
      ] as unknown as PanelState['runs'],
    };
    expect(replayableRuns(s)).toEqual([
      { runId: 'r1', adapter: 'ag-ui', label: 'r1 — AG-UI, 3 frames' },
      { runId: 'lg-1', adapter: 'langgraph', label: 'lg-1 — LangGraph, 1 frame' },
    ]);
  });
});
