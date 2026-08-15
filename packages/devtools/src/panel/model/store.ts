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

/**
 * Capture is on for `origin`: set the status AND the source in one write.
 *
 * The two must move together. `source` is what the capture banner and the empty state read to
 * decide whether the panel is showing data or offering to get some, so leaving it `empty` while
 * `capture` said `on` would keep the import drop zone on screen over a live stream. It also
 * drops any imported capture: a panel cannot be showing a file and a live tab at once, and
 * silently appending live records to an imported file would produce a stream that never existed.
 */
export function captureOn(s: PanelState, origin: string): PanelState {
  const wasImported = s.source.kind === 'imported';
  return {
    ...s,
    capture: { kind: 'on', origin },
    source: { kind: 'live', origin },
    runs: wasImported ? [] : s.runs,
    records: wasImported ? [] : s.records,
    issues: wasImported ? [] : s.issues,
    droppedBefore: wasImported ? 0 : s.droppedBefore,
    binaryTransport: wasImported ? null : s.binaryTransport,
    scope: wasImported ? null : s.scope,
    selectedSeq: wasImported ? null : s.selectedSeq,
    loadError: wasImported ? null : s.loadError,
  };
}

/**
 * Report what the inspected document said about its capture hooks — or that the question is open
 * again, with `null`.
 *
 * `null` is written on every fresh document, because a new page inherits nothing: the previous
 * document's hooks say nothing about this one, which may well be on an origin that was never
 * granted.
 */
export function setInstrumented(s: PanelState, instrumented: boolean | null): PanelState {
  return s.instrumented === instrumented ? s : { ...s, instrumented };
}

export function setRecording(s: PanelState, recording: boolean): PanelState {
  return { ...s, recording };
}

export function togglePreserveLog(s: PanelState): PanelState {
  return { ...s, preserveLog: !s.preserveLog };
}

/** How much a level is worth. Only the ORDER matters; the numbers are never stored or shown. */
const SIGNAL_RANK: Record<DetectionSignal['level'], number> = { none: 0, stream: 1 };

/**
 * Strengthen the detection signal on a capture-off origin. The level only ever moves UP.
 *
 * Detection only ever strengthens the offer (P11), so walking one back would be a visible loss of
 * a claim the panel had already earned, for no reason the user could see. `observeNetwork` fires
 * once per subscription and a navigation re-subscribes, so without the rule a re-arm could reset
 * a stream that genuinely happened.
 *
 * Returns the input unchanged — the same object, so a memoized subscriber sees no change — when
 * the new signal is not stronger, or when there is no offer to strengthen because capture is not
 * `off`.
 */
export function raiseSignal(s: PanelState, signal: DetectionSignal): PanelState {
  if (s.capture.kind !== 'off') return s;
  if (SIGNAL_RANK[signal.level] <= SIGNAL_RANK[s.capture.signal.level]) return s;
  return { ...s, capture: { ...s.capture, signal } };
}

/**
 * Label the session with the inspected page's framework.
 *
 * Deliberately a separate action from `setCapture` and `raiseSignal`, writing a separate field:
 * requirements §4.3 says a framework fingerprint labels the session and never gates capture, and
 * keeping it out of `CaptureStatus` is what makes that structural rather than a promise. Knowing
 * the page is Angular says nothing about whether it speaks AG-UI — AG-UI is a wire protocol with
 * no DOM footprint at all.
 */
export function setFramework(s: PanelState, framework: string | null): PanelState {
  return { ...s, framework };
}

export function loadFailed(s: PanelState, message: string): PanelState {
  return { ...s, loadError: message };
}
