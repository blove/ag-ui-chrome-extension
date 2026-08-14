/**
 * The panel's own state model.
 *
 * Everything the UI renders is either core model data (`Run`, `CaptureRecord`, `Issue`) or one of
 * the view-level fields below. Nothing here is persisted — requirements §11 — and nothing here is
 * derived: derivations live in `selectors.ts` so state stays a single, comparable snapshot.
 */
import type { Run, Issue, CaptureRecord } from '../../core/model/types';

/** Where the panel's data came from. Drives empty states and which controls are live. */
export type PanelSource =
  | { kind: 'empty' }
  | { kind: 'imported'; filename: string; importedAtMs: number }
  | { kind: 'live'; origin: string };

/** Capture availability for the inspected origin. Phase 1 never reaches 'on'. */
export type CaptureStatus =
  | { kind: 'unsupported' }
  | { kind: 'off'; origin: string; aguiDetected: boolean }
  | { kind: 'on'; origin: string };

export type TabId = 'timeline' | 'runs' | 'state' | 'messages' | 'session';

/** `null` means "all runs". */
export type RunScope = string | null;

export interface EventFilter {
  /** Case-insensitive substring over the serialized record. Empty string means no text filter. */
  text: string;
  /** When true, only records carrying at least one issue are shown. */
  issuesOnly: boolean;
}

export interface PanelState {
  source: PanelSource;
  capture: CaptureStatus;
  tab: TabId;
  scope: RunScope;
  filter: EventFilter;
  runs: Run[];
  records: CaptureRecord[];
  issues: Issue[];
  /** Records evicted before the earliest retained one. Always 0 in phase 1; the UI reads it now so
   *  P9 needs no retrofit when capture lands. */
  droppedBefore: number;
  expandChunks: boolean;
  selectedSeq: number | null;
  /** Set when a load fails; cleared on the next successful load. */
  loadError: string | null;
}

/**
 * The state a freshly opened panel holds.
 *
 * Built fresh on every call rather than exported as a frozen constant: the actions treat state as
 * immutable, but a shared `runs: []` array leaking into two stores is the kind of aliasing bug that
 * only shows up once a second panel exists.
 *
 * `capture` starts `unsupported` because phase 1 ships no capture layer (design §7) — the panel is
 * driven entirely by import until `setCapture` is called with something better.
 */
export function initialPanelState(): PanelState {
  return {
    source: { kind: 'empty' },
    capture: { kind: 'unsupported' },
    tab: 'timeline',
    scope: null,
    filter: { text: '', issuesOnly: false },
    runs: [],
    records: [],
    issues: [],
    droppedBefore: 0,
    expandChunks: false,
    selectedSeq: null,
    loadError: null,
  };
}
