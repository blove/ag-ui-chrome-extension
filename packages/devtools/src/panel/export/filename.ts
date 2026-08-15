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

/** `12:00:00` is not a legal filename on Windows and is awkward everywhere else. */
function stamp(iso: string): string {
  return iso.replace(/:/g, '-');
}

export function exportFilename(url: string, iso: string): string {
  return `agui-${hostOf(url)}-${stamp(iso)}.agui.jsonl`;
}

/** E7's fixture export. A `.ts` module, so an editor treats it as one. */
export function fixtureFilename(url: string, iso: string): string {
  return `agui-${hostOf(url)}-${stamp(iso)}.fixture.ts`;
}
