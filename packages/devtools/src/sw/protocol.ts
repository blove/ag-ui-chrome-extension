/**
 * The service worker's two wire protocols (design §3, requirements §11).
 *
 * Pure types and constants — no DOM, no `chrome` — so every end can import it anywhere.
 *
 * The relay leg is the ISOLATED-world → worker direction (`RELAY_PORT_NAME`, `RelayMessage`).
 * The panel leg is the worker ⇄ DevTools panel direction (`PANEL_PORT_NAME`, `SwMessage`,
 * `PanelCommand`), and `RequestLine` crosses both.
 */
import type { CaptureRecord } from '../core/model/types';
import type { InjectMessage } from '../inject/protocol';

/** Port name the ISOLATED-world relay connects with. Must match the service-worker side. */
export const RELAY_PORT_NAME = 'agui-devtools-relay';

/**
 * `Omit` does **not** distribute over a union: `keyof (A | B)` is the *intersection* of their
 * keys, so `Omit<InjectMessage, 'source'>` would collapse all four arms into
 * `{ v; kind; connId }` — silently dropping `tMs`, `frames`, `method`, `url`, `input`, `reason`,
 * `contentType` and `bytes`, and flattening the discriminant into a union of literals that no
 * longer narrows. Distributing over the union first keeps each arm intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What the relay forwards over the port: an `InjectMessage` minus the `agui-dt` tag.
 *
 * The tag exists to pick our messages out of everything else on `window`; past the relay's
 * origin, source and shape checks it carries no information, so it is dropped rather than
 * forwarded. `v` stays — the service worker still has to reject a version it cannot read.
 */
export type RelayMessage = DistributiveOmit<InjectMessage, 'source'>;

/**
 * One captured connection's request line: what was asked for, and the `RunAgentInput` that went
 * with it.
 *
 * Held apart from `CaptureRecord` because it is not a frame — it has no `seq`, it is one per
 * connection rather than one per event, and it is what `run-started-without-input` reads. Mirrors
 * the `request` line of the `.agui.jsonl` codec so a captured session and an imported one present
 * the same thing to the run builder.
 */
export interface RequestLine {
  connId: string;
  tMs: number;
  method: string;
  url: string;
  input: unknown;
}

/* -------------------------------------------------------------------------- */
/* The panel leg                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Port name the DevTools panel connects with. Must match the panel side verbatim — and the
 * connection is also the MV3 keepalive of requirements §15 risk row 1: while a panel holds this
 * port open, Chrome does not terminate the worker and the buffer survives.
 */
export const PANEL_PORT_NAME = 'agui-devtools-panel';

/**
 * Worker → panel. One union, because the panel folds every arm through the same reducer.
 *
 * `droppedBefore` rides on `snapshot` AND on `append` on purpose (P9): eviction happens
 * *during* a long session, so a count delivered only with the initial snapshot would be
 * permanently stale by the time it mattered.
 */
export type SwMessage =
  /** Replay for a panel that subscribed late — §3's "survives panel-opened-late via replay". */
  | {
      kind: 'snapshot';
      records: CaptureRecord[];
      requests: RequestLine[];
      droppedBefore: number;
      /**
       * Whether any document in this tab has reported that its capture hooks are installed.
       *
       * NOT the same fact as "the origin is granted", which is what the panel used to infer
       * capture from: `chrome.scripting.registerContentScripts` affects only FUTURE navigations,
       * so a document already open when the grant landed has no hooks in it. This is how a panel
       * opened AFTER the announcement still learns about it — the announcement itself is a
       * one-shot message the panel may well have missed.
       */
      instrumented: boolean;
    }
  | {
      kind: 'append';
      records: CaptureRecord[];
      /**
       * Total records evicted before the earliest one the worker still holds, as of this
       * append. Optional only so a producer with nothing to report may omit it; the worker
       * always sends it.
       */
      droppedBefore?: number;
    }
  | { kind: 'request'; request: RequestLine }
  | { kind: 'closed'; connId: string; tMs: number }
  /**
   * Requirements §5.4: a binary transport is DETECTED and LABELLED, never decoded in this
   * phase. It carries no records, so without this arm a protobuf stream would reach the panel
   * as an empty capture — indistinguishable from capture being broken, which §15 names as the
   * failure mode to avoid.
   */
  | { kind: 'binary'; connId: string; tMs: number; contentType: string; bytes: number }
  /**
   * A document in this tab has just reported that its capture hooks are installed.
   *
   * Re-stated on EVERY announcement rather than only on a change, because the interesting
   * announcement is usually the one that changes nothing here: the user reloads on the panel's
   * advice, the new document announces exactly as the old one did, and a panel that had reset
   * itself to "checking" for the new document has to hear it or it warns about a page that is
   * working. There is deliberately no negative counterpart — absence is the signal, at this
   * boundary exactly as at the page's.
   */
  | { kind: 'capture-installed' }
  | { kind: 'cleared' };

/** Panel → worker. */
export type PanelCommand =
  /** Which tab this panel is inspecting. Sent once, on connect. */
  | { kind: 'subscribe'; tabId: number }
  | { kind: 'clear' }
  | { kind: 'set-recording'; recording: boolean };
