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
 * Capture availability for the inspected origin.
 *
 * `unsupported` means there is no `chrome.devtools` to ask — the panel HTML opened outside
 * DevTools, which is what unit tests and the screenshot harness do.
 *
 * `on` says the origin is capture-enabled, NOT that records are arriving: pausing is
 * `recording`, a separate field, because a paused panel is still attached to an enabled origin
 * and folding the two would make Resume indistinguishable from a fresh grant.
 */
export type CaptureStatus =
  | { kind: 'unsupported' }
  | { kind: 'off'; origin: string; signal: DetectionSignal }
  | { kind: 'on'; origin: string };

/**
 * A non-SSE transport seen on the inspected origin (requirements §5.4, resolution C3).
 *
 * Detected and LABELLED, never decoded — protobuf decoding is deferred to phase 3. The label is
 * not decoration: a binary connection produces no records at all, so without it a protobuf
 * stream reaches the panel as an empty capture, which is indistinguishable from capture being
 * broken. §15 names exactly that as the failure to avoid.
 */
export interface BinaryTransport {
  connId: string;
  /** Arrival time of the first binary body on this connection. */
  tMs: number;
  contentType: string;
  /** Bytes seen on this connection. Zero is meaningful — an empty binary body was still binary. */
  bytes: number;
}

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
  /** Records evicted before the earliest retained one, counted by the live session (P9). */
  droppedBefore: number;
  /**
   * Record/pause. True means new records are wanted; false means the service worker has been
   * told to stop buffering for this tab.
   *
   * Separate from `capture` on purpose — see the note there. It is `true` from the start so
   * that enabling capture starts recording, which is what a user who just pressed Enable
   * expects; the button reads Pause from the moment capture is on.
   */
  recording: boolean;
  /**
   * Keep the captured records across a navigation of the inspected page.
   *
   * Off by default, matching Chrome's own Network panel. When off, a navigation clears both
   * ends: the panel's fold and the worker's buffer.
   */
  preserveLog: boolean;
  /**
   * The binary transport seen on this capture, if any. `null` until one is.
   *
   * Held beside the records rather than inside them because it is not a record: nothing was
   * decoded, and inventing a `CaptureRecord` for it would be a claim about content this phase
   * cannot make.
   */
  binaryTransport: BinaryTransport | null;
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
 * `capture` starts `unsupported` because there is nothing to ask until `chrome.devtools` has
 * answered — the panel is driven entirely by import until `setCapture` or `captureOn` is called
 * with something better.
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
    recording: true,
    preserveLog: false,
    binaryTransport: null,
    expandChunks: false,
    selectedSeq: null,
    loadError: null,
  };
}
