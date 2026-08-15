/**
 * The ISOLATED-world → service-worker wire protocol (design §3, requirements §11).
 *
 * Pure types and constants — no DOM, no `chrome` — so both ends can import it anywhere.
 *
 * This module currently declares only the relay leg. The panel leg (`PANEL_PORT_NAME`,
 * `SwMessage`, `RequestLine`, `PanelCommand`) lands with the service-worker task that needs it;
 * `src/sw/index.ts` still carries its own copy of the panel port name until then.
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
