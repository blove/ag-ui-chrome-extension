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

/**
 * How confident we are that this origin speaks AG-UI. Never gates the offer — only the wording.
 *
 * Design decision P11 replaces P5's detect-then-offer with always-offer: measured against a real
 * deployment, a production AG-UI app emits no AG-UI traffic at all until the user sends a message,
 * so at the moment the panel first opens there is nothing on the wire to see. A detector that
 * gated the Enable button would therefore hide it exactly when it is most needed. These levels
 * only ever change what the banner SAYS.
 *
 * There are two of them, and there cannot be a third from the page: AG-UI is a WIRE protocol and
 * specifies nothing in the DOM, so no markup — no custom element, no framework attribute — can
 * support a claim about whether an origin speaks it. That is precisely why requirements §4.1
 * chose content-based detection, so the tool works on a custom endpoint in a framework nobody has
 * heard of. Traffic is the only evidence there is.
 */
export type DetectionSignal = { level: 'none' } | { level: 'stream' };

/**
 * Capture availability for the inspected origin. Phase 1 never reaches 'on'.
 *
 * `unsupported` means there is no `chrome.devtools` to ask — the panel HTML opened outside
 * DevTools, which is what unit tests and the screenshot harness do.
 */
export type CaptureStatus =
  | { kind: 'unsupported' }
  | { kind: 'off'; origin: string; signal: DetectionSignal }
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
  /**
   * The inspected page's framework, e.g. `Angular 21.1.6`. `null` when none was identified.
   *
   * Session metadata and nothing more. Requirements §4.3: a framework fingerprint labels the
   * session, never gates capture — which is why it sits BESIDE `capture` rather than inside it.
   * Knowing the page is Angular says nothing about whether it speaks AG-UI, so no capture
   * decision, banner, or signal may read this field.
   */
  framework: string | null;
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
    framework: null,
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
