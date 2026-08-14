/**
 * DevTools page script. Registers the single panel surface (decision D5: DevTools panel only).
 * Loaded by `devtools.html`, which the manifest names as `devtools_page` (requirements §12).
 */

const PANEL_TITLE = 'AG-UI';
const PANEL_ICON = '';
const PANEL_PAGE = 'panel.html';

/**
 * `chrome.devtools.panels.create` resolves its page argument against the extension root, while
 * the bundler may emit these two HTML files under a subdirectory. Resolving `panel.html` as a
 * sibling of this page yields the correct extension-root-relative path either way.
 */
const panelPagePath = new URL(PANEL_PAGE, location.href).pathname.replace(/^\//, '');

chrome.devtools.panels.create(PANEL_TITLE, PANEL_ICON, panelPagePath);

export {};
