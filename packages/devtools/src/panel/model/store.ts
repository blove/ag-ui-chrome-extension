/**
 * The panel's store and its actions.
 *
 * A ~40-line observable rather than a state library: the panel has one state object, one writer per
 * event, and a zero-runtime-dependency posture (design §6). Actions are plain pure functions kept
 * outside the store so they can be tested without constructing one, and so a component can compose
 * two of them into a single `update` without an intermediate render.
 */
import type { CaptureStatus, DetectionSignal, PanelState, RunScope, TabId } from './panel-types';
import { initialPanelState } from './panel-types';

export interface PanelStore {
  get(): PanelState;
  set(next: PanelState): void;
  update(fn: (prev: PanelState) => PanelState): void;
  subscribe(listener: () => void): () => void;
}

export function createPanelStore(initial: PanelState = initialPanelState()): PanelStore {
  let state = initial;
  const listeners = new Set<() => void>();

  function get(): PanelState {
    return state;
  }

  function set(next: PanelState): void {
    state = next;
    // Iterate a copy: a listener is allowed to unsubscribe itself (a component unmounting in
    // response to the very state change being announced), and mutating the Set mid-iteration
    // would otherwise skip whichever listener happened to come next.
    for (const listener of [...listeners]) listener();
  }

  function update(fn: (prev: PanelState) => PanelState): void {
    set(fn(state));
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { get, set, update, subscribe };
}

export function selectTab(s: PanelState, tab: TabId): PanelState {
  return { ...s, tab };
}

/**
 * Change the run scope, dropping the selection if it falls outside the new scope.
 *
 * Without this, switching from "all runs" to a specific run would leave the detail pane showing an
 * event the list no longer contains — the selection would be invisible but still live, and the next
 * keyboard navigation would jump somewhere unrelated.
 */
export function selectScope(s: PanelState, scope: RunScope): PanelState {
  return { ...s, scope, selectedSeq: scopeContainsSelection(s, scope) ? s.selectedSeq : null };
}

function scopeContainsSelection(s: PanelState, scope: RunScope): boolean {
  const seq = s.selectedSeq;
  if (seq === null) return true;
  // `null` scope is every record, so membership is a records lookup rather than a run lookup.
  if (scope === null) return s.records.some((record) => record.seq === seq);
  const run = s.runs.find((candidate) => candidate.runId === scope);
  // An unknown run id scopes to nothing, so nothing survives it.
  return run !== undefined && run.recordSeqs.includes(seq);
}

export function selectSeq(s: PanelState, seq: number | null): PanelState {
  return { ...s, selectedSeq: seq };
}

export function setTextFilter(s: PanelState, text: string): PanelState {
  return { ...s, filter: { ...s.filter, text } };
}

export function toggleIssuesOnly(s: PanelState): PanelState {
  return { ...s, filter: { ...s.filter, issuesOnly: !s.filter.issuesOnly } };
}

/**
 * Flip the chunk-expansion flag only.
 *
 * Rebuilding the records under the new setting needs the raw JSONL lines, which state does not
 * hold, so that is the caller's job — see the contract note on `toggleExpandChunks`.
 */
export function toggleExpandChunks(s: PanelState): PanelState {
  return { ...s, expandChunks: !s.expandChunks };
}

export function setCapture(s: PanelState, capture: CaptureStatus): PanelState {
  return { ...s, capture };
}

/** How much a level is worth. Only the ORDER matters; the numbers are never stored or shown. */
const SIGNAL_RANK: Record<DetectionSignal['level'], number> = { none: 0, markers: 1, stream: 2 };

/**
 * Strengthen the detection signal on a capture-off origin. The level only ever moves UP.
 *
 * Two independent detectors write this field and neither knows what the other found: a page-load
 * marker probe (one `inspectedWindow.eval` round trip) and a network watcher (whenever a response
 * happens to finish). They race, so without a monotonic rule a probe that resolved late would
 * overwrite "an event stream was seen" with the weaker "this looks like an AG-UI app" — the panel
 * would visibly walk back a claim it had already earned, for no reason the user could see.
 *
 * Returns the input unchanged — the same object, so a memoized subscriber sees no change — when
 * the new signal is not stronger, or when there is no offer to strengthen because capture is not
 * `off`. An equal level is not stronger: a second markers probe does not replace the first
 * probe's `detail`, since neither reading is better evidence than the other.
 */
export function raiseSignal(s: PanelState, signal: DetectionSignal): PanelState {
  if (s.capture.kind !== 'off') return s;
  if (SIGNAL_RANK[signal.level] <= SIGNAL_RANK[s.capture.signal.level]) return s;
  return { ...s, capture: { ...s.capture, signal } };
}

export function loadFailed(s: PanelState, message: string): PanelState {
  return { ...s, loadError: message };
}
