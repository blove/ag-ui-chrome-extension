/**
 * The Simulate tab's derivations (§14.4, design R9) — pure functions over `PanelState`, so every
 * string the tab shows is testable without rendering it.
 *
 *  - which adapter to script (`inferAdapter`): the latest Signals report's, else the connections'
 *    dialect, else AG-UI — always overridable in the tab;
 *  - why Arm is disabled (`armDisabledReason`), in the words the user acts on;
 *  - whether the editor's JSON is an arm the hook will take (`checkScript`), through the same
 *    validator the worker and the relay apply;
 *  - each arm's state (`armRows`), from this panel's dispatches and the hook's acks.
 */
import {
  armBytes,
  MAX_ARM_BYTES,
  parseArmCommand,
  type Ack,
  type AgUiRunScript,
  type LangGraphRunScript,
  type SimAdapter,
} from '../../core/simulate/commands';
import type { SimDispatchOutcome } from '../../sw/protocol';
import type { PanelState } from '../model/panel-types';
import { connectionDialects } from '../model/selectors';

export const ADAPTER_LABELS: Readonly<Record<SimAdapter, string>> = { 'ag-ui': 'AG-UI', langgraph: 'LangGraph' };

/**
 * Shown when a dispatched arm has had no answer for `NO_HOOK_AFTER_MS`. Not a fault: a page that
 * is not a Threadplane development build simply has no listener, which is the ordinary case.
 */
export const NO_HOOK_MESSAGE =
  'no Threadplane hook answered — the app must be a Threadplane development build (0.3.0 or later) with an agent created on the page';
export const NO_HOOK_AFTER_MS = 2000;

/** R7: the arm reaches the top frame's agent only. */
export const TOP_FRAME_NOTE =
  'Arms reach the agent in the page’s top frame only — an agent inside an iframe is not scripted.';

export type AdapterSource = 'signals' | 'connections' | 'default';

/** The adapter to script, and what said so. */
export function inferAdapter(state: PanelState): { adapter: SimAdapter; from: AdapterSource } {
  const reports = state.signals.reports;
  const latest = reports[reports.length - 1];
  if (latest !== undefined) return { adapter: latest.adapter, from: 'signals' };
  const dialects = [...connectionDialects(state).values()];
  if (dialects.includes('langgraph')) return { adapter: 'langgraph', from: 'connections' };
  if (dialects.length > 0) return { adapter: 'ag-ui', from: 'connections' };
  return { adapter: 'ag-ui', from: 'default' };
}

/**
 * Why Arm is disabled, or `null` when it is not. Checked in the order the user has to fix them:
 * a page, capture on it, a live panel, then Developer mode (R6).
 */
export function armDisabledReason(state: PanelState, live: boolean): string | null {
  const capture = state.capture;
  if (capture.kind === 'unsupported') return 'Arming needs an inspected page — open this panel in DevTools on the app.';
  if (capture.kind === 'off') {
    return `Capture is not enabled for ${capture.origin}. Enable capture, then turn on Developer mode, to arm.`;
  }
  if (!live) return 'Arming needs the panel’s live connection to the extension.';
  if (state.developerModes[capture.origin] !== true) {
    return `Developer mode is off for ${capture.origin}. Turn it on above to arm.`;
  }
  return null;
}

export type ScriptCheck =
  | { ok: true; runs: LangGraphRunScript[] | AgUiRunScript[]; bytes: number }
  | { ok: false; reason: string; bytes?: number };

/** A stand-in id of the longest length the panel mints, so the measured size is the real one. */
const SIZING_ARM_ID = 'x'.repeat(36);

/**
 * Is the editor's text — a JSON array of runs for `adapter` — an arm the hook will take? The
 * reasons are `parseArmCommand`'s, the same words the worker and relay would refuse it with.
 */
export function checkScript(adapter: SimAdapter, text: string): ScriptCheck {
  let runs: unknown;
  try {
    runs = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `The script is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const candidate = { v: 1, armId: SIZING_ARM_ID, adapter, runs };
  // UTF-8 bytes, the unit the limit (and Threadplane's hook) counts in.
  const bytes = armBytes(candidate);
  const parsed = parseArmCommand(candidate);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, bytes };
  return { ok: true, runs: parsed.value.runs, bytes };
}

/** The command's size against R3's 2 MB. */
export function formatSize(bytes: number): string {
  const limit = '2 MB';
  if (bytes > MAX_ARM_BYTES) return `${(bytes / (1024 * 1024)).toFixed(2)} MB of ${limit} — over the limit`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB of ${limit}`;
  return `${(bytes / 1024).toFixed(1)} KB of ${limit}`;
}

/** What the extension did with an arm or a cancel — its own account, not the hook's. */
export function describeOutcome(outcome: SimDispatchOutcome, origin: string): string {
  switch (outcome) {
    case 'dispatched':
      return 'sent to the page';
    case 'developer-mode-off':
      return `not sent: Developer mode is off for ${origin}`;
    case 'not-top-frame':
      return 'not sent: it reached a frame that is not the page’s top frame';
    case 'unknown-arm':
      return 'not sent: this page never received that arm';
    case 'invalid':
      return 'not sent: the extension found the script invalid';
    case 'not-delivered':
      return 'not sent: the page has no capture layer loaded, or it is navigating';
  }
}

export interface ArmRow {
  armId: string;
  /** The template it was made from, when this panel armed it. */
  label?: string;
  /** The current state, in words. */
  status: string;
  /** Every state the hook reported, oldest first. */
  history: string[];
  /** Dispatched, and no hook answer yet — the no-hook note is shown if this lasts. */
  awaitingHook: boolean;
  cancellable: boolean;
  /** What became of a Cancel the extension could not deliver. */
  cancelNote?: string;
}

function describeAck(ack: Ack, runs: number | undefined, short = false): string {
  switch (ack.state) {
    case 'armed':
      return short ? 'armed' : 'armed — the next run will be scripted';
    case 'consumed':
      // 0-based on the wire (R4), 1-based on screen.
      if (ack.run === undefined) return 'consumed';
      return `consumed run ${String(ack.run + 1)}${runs !== undefined ? ` of ${String(runs)}` : ''}`;
    case 'expired':
      return 'expired';
    case 'disarmed':
      return 'disarmed';
    case 'rejected':
      return `rejected: ${ack.reason ?? 'no reason given'}`;
  }
}

/** The arm list, newest arm first. */
export function armRows(state: PanelState): ArmRow[] {
  const origin = state.capture.kind === 'unsupported' ? 'this origin' : state.capture.origin;
  const { dispatches, acks } = state.simulator;
  const order: string[] = [];
  const seen = new Set<string>();
  const note = (armId: string): void => {
    if (seen.has(armId)) return;
    seen.add(armId);
    order.push(armId);
  };
  for (const dispatch of dispatches) if (dispatch.action === 'arm') note(dispatch.armId);
  for (const ack of acks) note(ack.armId);

  return order.reverse().map((armId) => {
    const meta = state.simArmLabels[armId];
    const runs = meta?.runs;
    const arm = dispatches.filter((d) => d.armId === armId && d.action === 'arm').at(-1);
    const disarms = dispatches.filter((d) => d.armId === armId && d.action === 'disarm');
    const lastDisarm = disarms.at(-1);
    const own = acks.filter((ack) => ack.armId === armId);
    const history = own.map((ack) => describeAck(ack, runs, true));
    const latest = own.at(-1);

    let status: string;
    let awaitingHook = false;
    let open: boolean;
    if (arm !== undefined && arm.outcome !== 'dispatched' && latest === undefined) {
      status = describeOutcome(arm.outcome, origin);
      open = false;
    } else if (latest === undefined) {
      status = 'sent — waiting for the page’s hook';
      awaitingHook = true;
      open = true;
    } else {
      status = describeAck(latest, runs);
      open =
        latest.state === 'armed' ||
        (latest.state === 'consumed' && !(runs !== undefined && latest.run !== undefined && latest.run + 1 >= runs));
    }
    const cancelSent = lastDisarm?.outcome === 'dispatched';
    const row: ArmRow = {
      armId,
      status,
      history,
      awaitingHook,
      cancellable: open && !cancelSent,
    };
    if (meta !== undefined) row.label = meta.template;
    if (lastDisarm !== undefined && lastDisarm.outcome !== 'dispatched') {
      row.cancelNote = `cancel ${describeOutcome(lastDisarm.outcome, origin)}`;
    }
    return row;
  });
}

export interface ReplayableRun {
  runId: string;
  adapter: SimAdapter;
  label: string;
}

/** The capture's runs, by run id, as "Replay a captured run" offers them. */
export function replayableRuns(state: PanelState): ReplayableRun[] {
  return state.runs.map((run) => {
    const adapter: SimAdapter = run.dialect === 'langgraph' ? 'langgraph' : 'ag-ui';
    const n = run.recordSeqs.length;
    return { runId: run.runId, adapter, label: `${run.runId} — ${ADAPTER_LABELS[adapter]}, ${String(n)} frame${n === 1 ? '' : 's'}` };
  });
}
