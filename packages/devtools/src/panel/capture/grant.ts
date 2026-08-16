/**
 * The per-origin opt-in of decision D3.
 *
 * The extension ships inert: `manifest.config.ts` declares `optional_host_permissions` and no
 * static remote host, so capture on a non-localhost origin exists only once the user has granted
 * that origin. This is the request, and it is the ONLY thing the panel does about it —
 * registering content scripts for a granted origin is the service worker's job, driven by
 * `chrome.permissions.onAdded`, so no message and no `PanelCommand` is needed for it.
 *
 * `chrome.permissions.request` must be called from a user gesture, which is why this is reached
 * from the Enable button's click handler and never from an effect.
 */

/**
 * The hosts `manifest.config.ts` statically registers content scripts for.
 *
 * D3 auto-enables the localhost family, which is why the harness (design §3, served over
 * localhost) needs no grant at all. Kept in sync with `LOCALHOST_MATCHES` by hand — there is
 * no import path from a manifest config into the panel bundle.
 */
const AUTO_ENABLED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/** True when capture is already available on this origin without asking for anything. */
export function isAutoEnabledOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    // `http:` only, matching the manifest. A match pattern ignores the port, so
    // `http://localhost:5173` is covered by `http://localhost/*` and needs no special case.
    return url.protocol === 'http:' && AUTO_ENABLED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export type GrantOutcome =
  | { kind: 'granted' }
  | { kind: 'denied' }
  /** No `chrome.permissions` to ask — outside DevTools, or a test. */
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * The match pattern for one origin.
 *
 * `chrome.permissions.request` takes match patterns, not origins: a bare `https://example.com`
 * is rejected, and the path component has to be there. Exported because the shape of this
 * string is the difference between a working grant and a silent `false`.
 */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

export async function requestOriginGrant(origin: string): Promise<GrantOutcome> {
  const request = chrome.permissions?.request;
  if (typeof request !== 'function') return { kind: 'unavailable' };

  try {
    const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
    return granted ? { kind: 'granted' } : { kind: 'denied' };
  } catch (error) {
    // A rejected request is a real, reportable outcome — Chrome rejects when the call did not
    // come from a user gesture, and a swallowed rejection would look exactly like a denial.
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Are the capture content scripts REGISTERED for this origin? `null` means not known yet.
 *
 * A different question from `hasOriginGrant`, and the two disagree in the case this function
 * exists for: Chrome drops dynamically registered content scripts when the extension is reloaded
 * or updated, while the permission survives. The origin is then granted with nothing registered
 * for it, `chrome.permissions.onAdded` never fires again because nothing was added, and the panel
 * — which could only see the grant — advised a page reload that could not possibly help.
 *
 * TRUE FOR THE AUTO-ENABLED FAMILY WITHOUT CONSULTING THE LIST, and that is not a shortcut. Those
 * origins are covered by the manifest's own `content_scripts`, which Chrome registers and which
 * cannot be dropped or unregistered, so they are never in the worker's dynamic list. They also
 * could not be matched against it: a match pattern ignores the port, so `http://localhost/*` and
 * the inspected origin `http://localhost:5173` are not the same string.
 *
 * `null` rather than `false` while `registration` is unknown, for the reason the `loaded`
 * tri-state exists: the panel opens before any worker has answered, and a banner that warned on
 * "not known yet" would flash a false alarm on every open.
 */
export function isRegisteredForOrigin(
  origin: string,
  registration: { matches: string[] } | null,
): boolean | null {
  if (isAutoEnabledOrigin(origin)) return true;
  if (registration === null) return null;
  return registration.matches.includes(originPattern(origin));
}

/** Has this origin already been granted? Used on open, so a re-opened panel is not asked twice. */
export async function hasOriginGrant(origin: string): Promise<boolean> {
  const contains = chrome.permissions?.contains;
  if (typeof contains !== 'function') return false;
  try {
    return await chrome.permissions.contains({ origins: [originPattern(origin)] });
  } catch {
    return false;
  }
}
