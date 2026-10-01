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
import {
  asSwMessage,
  PANEL_PORT_NAME,
  type PanelCommand,
  type SwMessage,
} from '../../sw/protocol';

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
