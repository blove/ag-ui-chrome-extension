/**
 * Developer mode — the run simulator's second lock (design R6) — as plain data.
 *
 * One flag per ORIGIN, held in `chrome.storage.local` under `developerModeKey(origin)` and present
 * only while on (`true`); off is the key's absence, so there is no stored state to get wrong. The
 * worker writes it (for a granted origin only), clears it when the grant goes, and the ISOLATED-world relay reads it for its own
 * `location.origin` before dispatching an arm into the page. This module only names the key and
 * says what an origin is; the Chrome calls stay in `sw/` and `relay/`.
 */

export const DEVELOPER_MODE_KEY_PREFIX = 'agui-dt:devmode:';

/**
 * Is this a web origin as `location.origin` spells one — `http:` or `https:`, scheme, host and
 * port only, already in canonical form?
 *
 * Canonical because the key is a string: `https://Example.com/` and `https://example.com` would be
 * two keys for one origin, and a flag set under the first would never be read under the second.
 * `"null"` (an opaque origin) and every other scheme are refused: there is no granted origin they
 * could be.
 */
export function isWebOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch {
    return false;
  }
}

export function developerModeKey(origin: string): string {
  return `${DEVELOPER_MODE_KEY_PREFIX}${origin}`;
}
