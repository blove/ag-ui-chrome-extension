/**
 * The panel's port to the service worker.
 *
 * Design §6: this port is also the MV3 keepalive — holding it open is what addresses the ~30s
 * idle termination in requirements §15. So it is opened once for the life of the panel and only
 * closed when the panel unmounts.
 *
 * It makes no request of its own. `chrome.runtime.connect` is intra-extension messaging, not
 * network: requirements §11's no-egress rule is kept structurally, because there is nothing here
 * that could fetch.
 */
import { PANEL_PORT_NAME, type PanelCommand, type SwMessage } from '../../sw/protocol';

export interface PanelPort {
  send(command: PanelCommand): void;
  disconnect(): void;
}

export interface ConnectOptions {
  /** `chrome.devtools.inspectedWindow.tabId` — the tab whose buffer this panel subscribes to. */
  tabId: number;
  onMessage: (message: SwMessage) => void;
  /** Called if the worker goes away. The port is dead at that point and must be reopened. */
  onDisconnect?: () => void;
}

/**
 * Every arm of `SwMessage`, and it must stay that way.
 *
 * A kind missing from this set is dropped silently by `asSwMessage` below — which is the right
 * behaviour for a message from a future version and exactly the wrong one for an arm we do
 * handle. `binary` is the cautionary case: leaving it out would drop the one message that
 * explains why a protobuf capture has no records (resolution C3).
 */
const SW_MESSAGE_KINDS: ReadonlySet<SwMessage['kind']> = new Set([
  'snapshot',
  'append',
  'request',
  'closed',
  'binary',
  // Leaving this out would silently drop the one message that distinguishes a granted origin
  // from a document with the capture layer loaded in it — the panel would warn about a page that
  // had just reported itself, and the reload it advises would appear to do nothing.
  'capture-loaded',
  // Leaving this out would silently drop the message that says whether the capture scripts are
  // registered at all — the panel would then fall back to its "reload the page" advice for a
  // failure a reload cannot touch, which is the exact defect this arm was added for.
  'registration',
  'cleared',
] satisfies SwMessage['kind'][]);

/**
 * Narrow a port payload to `SwMessage`.
 *
 * `Port.onMessage` hands over `unknown`, so *something* has to narrow it, and a cast would be
 * the one place a malformed message could reach the run builder as a `CaptureRecord[]`. This
 * checks the discriminant only: the sender is our own service worker, so the risk being
 * defended against is a version skew between a reloaded extension and a still-open panel, not
 * a hostile peer.
 */
export function asSwMessage(value: unknown): SwMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return null;
  if (!(SW_MESSAGE_KINDS as ReadonlySet<string>).has(kind)) return null;
  return value as SwMessage;
}

/**
 * Open the port and subscribe to a tab. Returns `null` when there is no `chrome.runtime` to
 * connect through — the panel HTML is also opened outside DevTools by the screenshot harness,
 * and by every jsdom test that does not stub it.
 */
export function connectToServiceWorker(options: ConnectOptions): PanelPort | null {
  const connect = chrome.runtime?.connect;
  if (typeof connect !== 'function') return null;

  const port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
  let open = true;

  port.onMessage.addListener((raw: unknown) => {
    const message = asSwMessage(raw);
    // Dropped silently and deliberately: a panel that rendered an error for an unrecognised
    // frame would turn a forward-compatible worker into a broken-looking panel.
    if (message !== null) options.onMessage(message);
  });

  port.onDisconnect.addListener(() => {
    open = false;
    options.onDisconnect?.();
  });

  // First thing on the wire. Until the worker knows the tab it has no buffer to replay.
  port.postMessage({ kind: 'subscribe', tabId: options.tabId } satisfies PanelCommand);

  return {
    send: (command) => {
      if (open) port.postMessage(command);
    },
    disconnect: () => {
      if (!open) return;
      open = false;
      port.disconnect();
    },
  };
}
