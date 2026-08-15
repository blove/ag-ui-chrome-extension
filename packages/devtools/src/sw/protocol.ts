/**
 * The ISOLATED-world → service-worker wire protocol (design §3, requirements §11).
 *
 * Pure types and constants — no DOM, no `chrome` — so both ends can import it anywhere.
 *
 * The relay leg is the MAIN/ISOLATED -> worker direction; the panel leg below is the worker <->
 * DevTools panel direction.
 */
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
