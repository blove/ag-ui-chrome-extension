/**
 * MV3 service worker — the port hub of requirements §3 (Architecture).
 *
 * STUB. The per-tab ring buffer (default 5k events / 8 MB, oldest dropped), the replay for a
 * panel opened late, and the `chrome.storage.session` mirror are NOT implemented here yet.
 *
 * That mirror is the mitigation for requirements §15 risk row 1 — "MV3 service worker
 * terminates at ~30 s idle, losing the buffer" — whose other half is exactly what this stub
 * does do: accept the panel's port and hold it open, because an open port keeps the worker
 * alive and is what a restored buffer would be replayed over.
 */

/** Port name the DevTools panel connects with. Must match the panel side verbatim. */
const PANEL_PORT_NAME = 'agui-devtools-panel';

/** Open panel ports, held so the worker stays alive while a panel is watching. */
const panelPorts = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port): void => {
  if (port.name !== PANEL_PORT_NAME) {
    return;
  }
  panelPorts.add(port);
  port.onDisconnect.addListener((): void => {
    panelPorts.delete(port);
  });
  // No buffered records to replay in this milestone.
});

export {};
