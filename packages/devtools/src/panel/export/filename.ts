/**
 * What the exported file is called: `agui-<host>-<ISO>.agui.jsonl` (design §3).
 *
 * Both parts are load-bearing. The host is how a reader tells two captures apart at a glance,
 * and the timestamp is the capture's own `capturedAt` rather than the moment of download — so
 * re-exporting an imported file names the same capture it did before, and the filename never
 * disagrees with the header inside.
 */

/** Everything that is neither alphanumeric nor `.`/`-` becomes a `-`, then runs collapse. */
function slug(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * The host part of a header `url`.
 *
 * `url` is whatever the header carried, which for a capture whose origin was never resolved is
 * the literal `unknown` — not a URL at all. So parsing is attempted and its failure is a normal
 * path, not an error: the raw value is slugged instead, which keeps `unknown` readable and turns
 * anything hostile into an inert token.
 */
function hostOf(url: string): string {
  try {
    return slug(new URL(url).host);
  } catch {
    return slug(url);
  }
}

/**
 * The time part of a name, from a header `capturedAt`.
 *
 * Slugged like the host, and for the same reason: re-export preserves `capturedAt` from the
 * imported file, so it is whatever that file said — usually an ISO timestamp, which passes through
 * unchanged apart from its colons (`12:00:00` is not a legal filename on Windows and is awkward
 * everywhere else), but possibly `../../x` or nothing at all.
 */
function stamp(iso: string): string {
  return slug(iso.replace(/:/g, '-'));
}

export function exportFilename(url: string, iso: string): string {
  return `agui-${hostOf(url)}-${stamp(iso)}.agui.jsonl`;
}

/** E7's fixture export. A `.ts` module, so an editor treats it as one. */
export function fixtureFilename(url: string, iso: string): string {
  return `agui-${hostOf(url)}-${stamp(iso)}.fixture.ts`;
}

/** T6's Threadplane replay test. `.spec.ts`, so Threadplane's Vitest picks it up where it is dropped. */
export function threadplaneFilename(url: string, iso: string): string {
  return `threadplane-${hostOf(url)}-${stamp(iso)}.spec.ts`;
}
