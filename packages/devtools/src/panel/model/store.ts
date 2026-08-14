/**
 * The panel's store and its actions.
 *
 * A ~40-line observable rather than a state library: the panel has one state object, one writer per
 * event, and a zero-runtime-dependency posture (design §6). Actions are plain pure functions kept
 * outside the store so they can be tested without constructing one, and so a component can compose
 * two of them into a single `update` without an intermediate render.
 */
import type { CaptureStatus, PanelState, RunScope, TabId } from './panel-types';
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

export function loadFailed(s: PanelState, message: string): PanelState {
  return { ...s, loadError: message };
}
