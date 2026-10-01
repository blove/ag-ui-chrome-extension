/**
 * The run simulator's page end (design R1, R4, R6, R7), in the ISOLATED world.
 *
 * TWO JOBS. Dispatch an arm (or disarm) the worker sent, as `CustomEvent` on the page's `window`,
 * if and only if Developer mode is on for this document's origin and this is a top-level
 * document. And hear the hook's `threadplane:devtools:ack` events, validate them, and send each one
 * that is about an arm dispatched here up the port.
 *
 * THE CHANNEL, AND WHY IT IS THIS ONE. The design (R7) sketched a new ISOLATED → MAIN message that
 * the MAIN-world script would validate and turn into the `CustomEvent`. That message would have to
 * be a `window.postMessage`, and the MAIN world is the page's world: any script on the page can
 * post the same message with the same source tag, and nothing in the MAIN world can tell the two
 * apart. A MAIN-world forwarder would authenticate nothing; it would only add a page-visible
 * `message` (every `message` listener on the page would see each arm) and a page-reachable code
 * path that dispatches events on the extension's behalf.
 *
 * So the MAIN world is not involved at all. A DOM event dispatched on `window` from the ISOLATED
 * world reaches listeners in every world — the hook's included — and Chrome hands each world a
 * structured clone of `detail` (measured, both directions, in the e2e). The one place that decides
 * to dispatch is therefore here, reachable only through `chrome.runtime.onMessage`, which only the
 * extension's own worker can reach (`chrome.tabs.sendMessage`); the page has no shape in which to
 * ask for an arm.
 *
 * WHAT THIS DOES NOT DO, stated exactly (R8). The hook cannot know who dispatched an event, so a
 * page script can always dispatch `threadplane:devtools:arm` itself — on a development build, to
 * its own app. That is no more than page code can already do. The extension's guarantee is the
 * other half: it never dispatches one unless the user turned Developer mode on for this origin,
 * and the check is HERE, where the origin is this document's own `location.origin`, not a claim
 * passed down from the panel.
 *
 * ACKS. Heard here for the same reason: no MAIN-world code and no `postMessage`. Only acks for an
 * arm this document dispatched are forwarded — a page cannot fill the panel's arm list with acks
 * for arms that never existed — and every one is `parseAck`'s copy. A page can still forge an ack
 * for a real arm id (it saw the arm event); the panel shows acks as the hook's claims, which is
 * what they are.
 *
 * NEVER THROWS INTO THE PAGE. The ack listener runs inside the page's own `dispatchEvent`.
 */
import {
  ACK_EVENT,
  ARM_EVENT,
  DISARM_EVENT,
  parseAck,
  parseArmCommand,
  parseDisarmCommand,
} from '../core/simulate/commands';
import type { RelayCommandResult, RelayMessage } from '../sw/protocol';

/** How many dispatched arm ids a document remembers, for matching acks and disarms. */
export const MAX_REMEMBERED_ARMS = 32;

export interface SimulateHost {
  /** The document's window: where the arm is dispatched and the ack is heard. */
  readonly target: {
    addEventListener(type: string, listener: (event: Event) => void): void;
    dispatchEvent(event: Event): boolean;
  };
  /** Builds the event — the ISOLATED world's own `CustomEvent`. */
  makeEvent(type: string, detail: unknown): Event;
  /** This document's own origin, read once at install. */
  readonly origin: string;
  /** Whether this is a top-level document (R7). */
  isTopFrame(): boolean;
  /** Developer mode for `origin`, read fresh on every arm. Rejects or answers false when unknown. */
  readDeveloperMode(origin: string): Promise<boolean>;
  /** Up the port to the worker. */
  send(message: RelayMessage): void;
}

export interface SimulateRelay {
  /**
   * Handle one message from the worker. `null` when it is not a simulator command at all (the
   * caller then leaves the message alone); otherwise the outcome, once known. Never rejects.
   */
  handle(message: unknown): Promise<RelayCommandResult> | null;
}

function own(value: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

export function installSimulateRelay(host: SimulateHost): SimulateRelay {
  /** Arm ids dispatched in this document, oldest first. */
  const dispatched: string[] = [];

  function remember(armId: string): void {
    const at = dispatched.indexOf(armId);
    if (at !== -1) dispatched.splice(at, 1);
    dispatched.push(armId);
    if (dispatched.length > MAX_REMEMBERED_ARMS) dispatched.shift();
  }

  host.target.addEventListener(ACK_EVENT, (event: Event): void => {
    try {
      // Read once. Chrome gives this world a structured clone of the page's detail.
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      const parsed = parseAck(detail);
      if (!parsed.ok || !dispatched.includes(parsed.value.armId)) return;
      host.send({ v: 1, kind: 'sim-ack', ack: parsed.value });
    } catch {
      // A detail Chrome could not clone, or a dead port. The ack is lost; the page carries on.
    }
  });

  function dispatch(type: string, detail: unknown): void {
    host.target.dispatchEvent(host.makeEvent(type, detail));
  }

  async function arm(command: unknown): Promise<RelayCommandResult> {
    const parsed = parseArmCommand(command);
    if (!parsed.ok) return { outcome: 'invalid' };
    if (!host.isTopFrame()) return { outcome: 'not-top-frame' };
    let enabled = false;
    try {
      enabled = (await host.readDeveloperMode(host.origin)) === true;
    } catch {
      enabled = false;
    }
    // Strictly `true`: a flag that could not be read is off.
    if (!enabled) return { outcome: 'developer-mode-off' };
    remember(parsed.value.armId);
    dispatch(ARM_EVENT, parsed.value);
    return { outcome: 'dispatched' };
  }

  function disarm(armId: unknown): RelayCommandResult {
    const parsed = parseDisarmCommand({ v: 1, armId });
    if (!parsed.ok) return { outcome: 'invalid' };
    if (!host.isTopFrame()) return { outcome: 'not-top-frame' };
    // No Developer-mode check, deliberately: this only ever withdraws an arm THIS document was
    // given, so it can run after the user has switched the mode off — which is exactly when they
    // would want the pending arm gone.
    if (!dispatched.includes(parsed.value.armId)) return { outcome: 'unknown-arm' };
    dispatch(DISARM_EVENT, parsed.value);
    return { outcome: 'dispatched' };
  }

  return {
    handle(message: unknown): Promise<RelayCommandResult> | null {
      try {
        if (typeof message !== 'object' || message === null) return null;
        const kind = own(message, 'kind');
        if (kind === 'simulate.arm') {
          return arm(own(message, 'command')).catch((): RelayCommandResult => ({ outcome: 'invalid' }));
        }
        if (kind === 'simulate.disarm') return Promise.resolve(disarm(own(message, 'armId')));
        return null;
      } catch {
        return Promise.resolve({ outcome: 'invalid' });
      }
    },
  };
}
