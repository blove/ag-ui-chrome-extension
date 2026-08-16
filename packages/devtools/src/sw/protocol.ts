/**
 * The service worker's two wire protocols (design §3, requirements §11).
 *
 * Pure types and constants — no DOM, no `chrome` — so every end can import it anywhere.
 *
 * The relay leg is the ISOLATED-world → worker direction (`RELAY_PORT_NAME`, `RelayMessage`).
 * The panel leg is the worker ⇄ DevTools panel direction (`PANEL_PORT_NAME`, `SwMessage`,
 * `PanelCommand`), and `RequestLine` crosses both.
 */
import type { RuntimeInfo } from '../core/detect/info';
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
 * What the relay sends over the port.
 *
 * Two origins, and the split is the whole privacy design. The forwarded arms are an
 * `InjectMessage` minus the `agui-dt` tag — the tag exists to pick our messages out of everything
 * else on `window`, and past the relay's origin, source and shape checks it carries no
 * information, so it is dropped rather than forwarded. `v` stays: the worker still has to reject
 * a version it cannot read.
 *
 * `capture-loaded` has no `InjectMessage` counterpart, deliberately. It is the RELAY's own
 * statement, made in the ISOLATED world where the page cannot see it, and there is no shape in
 * which page-side code could make it — which is the structural version of the guarantee the old
 * `ConnectionMessage` exclusion type used to assert weakly in `inject/protocol.ts`.
 */
export type RelayMessage =
  | DistributiveOmit<InjectMessage, 'source'>
  /**
   * The capture layer is loaded in the frame this port belongs to. Sent once per document, at
   * `document_start`, and never re-sent on a reconnect — see the long note in `relay/relay.ts`
   * for why "once per document" rather than "once per port" is the fact the worker needs.
   *
   * Carries no frame identity of its own: the worker reads `port.sender`, so which document this
   * is comes from Chrome rather than from the payload.
   */
  | { v: 1; kind: 'capture-loaded' };

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

/**
 * One connection that has ended, and WHEN it ended.
 *
 * The timestamp is the load-bearing half. Closing a connection is what runs `finalizeRules`, and
 * every run-end issue it emits — `run-never-terminated`, `unclosed-message`, `unclosed-tool-call`,
 * a leftover-open `unbalanced-steps` — carries the close time in `Issue.tMs`. An id on its own is
 * enough to say "this stream is over" and not enough to finalise it: the reader would have to
 * invent a time, which misplaces every one of those issues.
 *
 * `tMs` is the page-side close time copied from the `conn-close` frame, the same number the
 * `closed` push message carries — never a clock read at the worker or the panel.
 */
export interface ClosedConn {
  connId: string;
  tMs: number;
}

/**
 * Which origins the capture content scripts are actually REGISTERED for, and whether the last
 * attempt to register them failed.
 *
 * A DIFFERENT FACT FROM THE PERMISSION, and the difference is a shipped defect. A runtime grant
 * survives an extension reload or update; the dynamic registration made from it does not, and
 * `chrome.permissions.onAdded` never fires again because the origin is still granted. The panel
 * used to have no way to tell "granted and registered, but this document loaded before the
 * registration" from "granted and not registered at all" — and it offered the same remedy for
 * both, a page reload, which cannot possibly help in the second case.
 *
 * `matches` lists the patterns registered DYNAMICALLY, through `chrome.scripting`. The manifest's
 * static localhost family is deliberately absent: those are registered by Chrome from the manifest
 * itself and cannot go missing, and the panel already knows them by pattern
 * (`panel/capture/grant.ts`'s `isAutoEnabledOrigin`) because a match pattern ignores the port and
 * a string comparison against `http://localhost:5173` would fail.
 *
 * `error` is the other half of the same lesson. The registration `catch` used to discard
 * everything, which is how a registration that never happened stayed invisible for a whole
 * release. A duplicate-id rejection is genuinely fine and is not reported here; anything else is.
 */
export interface RegistrationState {
  /** Match patterns this worker currently has capture content scripts registered for. */
  matches: string[];
  /** The last registration failure that was not a benign duplicate, or `null`. */
  error: string | null;
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
      /**
       * Connections that had already ended when this snapshot was taken, with the time each
       * ended at.
       *
       * NOT optional, and not derivable from the records. Closing is the sole trigger for
       * `finalizeRules`, so a snapshot without this leaves every finished run sitting in
       * `outcome: 'running'` with none of its run-end issues — the panel would then disagree
       * with the file exported from the very same bytes, and the disagreement is silent: a
       * missing issue looks exactly like a clean run. The streaming path has always replayed
       * these (`live-session.ts`'s `closed`); this is the same fact for a panel that arrived
       * after the run, which is the ordinary case for a tool you open when something went wrong.
       *
       * Required rather than optional on purpose: a producer that forgets it is the defect, and
       * a compile error is how that gets caught.
       */
      closed: ClosedConn[];
      droppedBefore: number;
      /**
       * Whether any document in this tab has reported that the capture layer is LOADED in it.
       *
       * NOT the same fact as "the origin is granted", which is what the panel used to infer
       * capture from: `chrome.scripting.registerContentScripts` affects only FUTURE navigations,
       * so a document already open when the grant landed has no content scripts in it at all and
       * reports nothing. This is how a panel opened AFTER the report still learns about it — the
       * report itself is a one-shot message the panel may well have missed.
       *
       * Named for what it proves. The relay reporting means the content scripts were registered
       * for this document; it does not prove the MAIN-world patches installed without throwing.
       * See `relay/relay.ts` for the residual and why it is accepted.
       */
      loaded: boolean;
      /**
       * The runtime metadata this tab has seen, or `null` when no `/info` response has arrived.
       *
       * NOT OPTIONAL, for the same reason `closed` above is not. The whole point of done-when #2
       * is that the agent list is on screen BEFORE any run, and the panel is normally opened after
       * the page has already connected — so the snapshot is the ordinary delivery route for this
       * fact and the push arm below is the exception. A producer that forgets it leaves the Session
       * tab reporting an honest-looking "no /info response seen" for a page that answered one, and
       * a compile error is how that gets caught.
       *
       * `null` is a real and COMMON value: measured across three page loads of a production AG-UI
       * deployment, no `/info` request was made at all. It is not an error state.
       */
      info: RuntimeInfo | null;
      /**
       * Which origins capture content scripts are registered for right now (see
       * `RegistrationState`).
       *
       * NOT OPTIONAL, for the same reason `closed` and `info` above are not. This is what lets the
       * panel tell "the scripts are registered and this document simply predates them" — where a
       * page reload is the remedy — from "the scripts are not registered at all", where a reload
       * does nothing at all and the user reloads, reads the identical message, and concludes the
       * tool is broken. A producer that forgets it is the defect, and a compile error is how that
       * gets caught.
       */
      registration: RegistrationState;
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
  /**
   * A connection just ended. Spelled as `ClosedConn` so the streamed fact and the one retained
   * on `snapshot` cannot drift apart — they are the same fact, delivered to whoever is listening
   * at the time and to whoever arrives later.
   */
  | ({ kind: 'closed' } & ClosedConn)
  /**
   * Requirements §5.4: a binary transport is DETECTED and LABELLED, never decoded in this
   * phase. It carries no records, so without this arm a protobuf stream would reach the panel
   * as an empty capture — indistinguishable from capture being broken, which §15 names as the
   * failure mode to avoid.
   */
  | { kind: 'binary'; connId: string; tMs: number; contentType: string; bytes: number }
  /**
   * A runtime answered an agent-discovery request the page made (spec §13 done-when #2).
   *
   * Its own arm rather than a record: nothing was decoded from a stream, it has no `seq`, and
   * putting it in the Timeline would be the panel asserting a protocol event that never happened.
   * It is session metadata, and it lands in the Session tab and nowhere else.
   */
  | { kind: 'info'; connId: string; tMs: number; url: string; info: RuntimeInfo }
  /**
   * A document in this tab has just reported that the capture layer is loaded in it.
   *
   * Re-stated on EVERY report rather than only on a change, because the interesting report is
   * usually the one that changes nothing here: the user reloads on the panel's advice, the new
   * document reports exactly as the old one did, and a panel that had reset itself to "checking"
   * for the new document has to hear it or it warns about a page that is working. There is
   * deliberately no negative counterpart — absence is the signal, at this boundary exactly as at
   * the relay's.
   */
  | { kind: 'capture-loaded' }
  /**
   * The registration picture changed — the worker reconciled at startup, an origin was granted or
   * revoked, or a panel asked for a re-registration.
   *
   * Spelled as `RegistrationState` so the pushed fact and the one retained on `snapshot` cannot
   * drift apart: they are the same fact, delivered to whoever is listening at the time and to
   * whoever arrives later. Not scoped to a tab — registration is per ORIGIN and global to the
   * extension — so every subscribed panel is told.
   */
  | ({ kind: 'registration' } & RegistrationState)
  | { kind: 'cleared' };

/** Panel → worker. */
export type PanelCommand =
  /** Which tab this panel is inspecting. Sent once, on connect. */
  | { kind: 'subscribe'; tabId: number }
  | { kind: 'clear' }
  | { kind: 'set-recording'; recording: boolean }
  /**
   * Re-run the reconciliation: read the granted origins, read what is registered, register the
   * difference. Answered with a `registration` message either way.
   *
   * Carries NO arguments on purpose. The origin to register is not the panel's to name — the
   * worker takes it from `chrome.permissions.getAll()`, which is the only authority on what the
   * user has actually granted — so this command cannot be used to register an origin the user
   * never opted in to, whatever reaches this port.
   */
  | { kind: 'reconcile-registrations' };
