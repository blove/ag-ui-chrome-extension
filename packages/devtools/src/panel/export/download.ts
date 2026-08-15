/**
 * The only file in `panel/export/` that touches a `Blob`, an object URL, an anchor or the
 * clipboard — deliberately small, because it is the part unit tests can barely reach.
 *
 * E1 — NO `downloads` PERMISSION. The manifest is `permissions: ['storage', 'scripting']` and
 * requirements §11 forbids widening it for convenience. A `Blob`, `URL.createObjectURL` and a
 * programmatic `<a download>` need no permission whatsoever, which is the whole reason this
 * mechanism was chosen over `chrome.downloads`.
 *
 * That mechanism is UNVERIFIED in a DevTools panel document by construction — no unit test runs
 * inside one. The visual gate (`scripts/screenshot-panel.mts`) is what asserts a real click
 * produces a real file with real content; this module's job is to make sure that when it does not
 * work, it SAYS SO. Every path returns a result rather than throwing or silently doing nothing: a
 * button that appears to have worked and did not is the failure class this project keeps meeting,
 * and it is worst of all on "copy", where success and a no-op look identical.
 */

export type IoResult = { ok: true } | { ok: false; reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * JSONL. Not `application/json` — the file is a stream of objects, not one — and not `text/plain`,
 * which some browsers will offer to render in a tab instead of saving.
 */
const JSONL_MIME = 'application/x-ndjson';

/**
 * Save `text` as `filename`.
 *
 * The anchor is put IN the document before it is clicked and taken out afterwards: Chrome ignores
 * a click on a detached anchor, which would be a silent no-op.
 */
export function downloadText(filename: string, text: string, mime = JSONL_MIME): IoResult {
  /*
   * Object-URL support is CHECKED, not assumed.
   *
   * E1 chose this mechanism because it needs no permission, and flagged that it is unverified in
   * a DevTools panel document. If it turns out not to work there, this is the branch that says so
   * — with a way forward — instead of leaving the user in front of a button that appears to have
   * saved a file.
   */
  const createObjectURL = URL.createObjectURL as ((blob: Blob) => string) | undefined;
  let url: string | null = null;
  try {
    if (typeof createObjectURL !== 'function') throw new Error('URL.createObjectURL is not available');
    url = createObjectURL(new Blob([text], { type: mime }));
  } catch (error) {
    return {
      ok: false,
      reason:
        `This document could not create an object URL, so nothing was saved: ${messageOf(error)}. ` +
        'Copy the capture to the clipboard instead.',
    };
  }

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `The browser refused the download: ${messageOf(error)}` };
  } finally {
    /*
     * Revoked on a later turn, never synchronously.
     *
     * Chrome starts reading the blob after the click returns; revoking in the same task cancels
     * the download — and cancels it silently, which would look exactly like the download working.
     * Revoking at all matters because the panel is long-lived: a session that exported repeatedly
     * would otherwise pin every capture it had ever written in memory.
     */
    const held = url;
    if (held !== null) {
      setTimeout(() => {
        URL.revokeObjectURL(held);
      }, 0);
    }
  }
}

/**
 * Copy `text` to the clipboard.
 *
 * Never throws and never resolves as though it copied when it did not. A refused clipboard write
 * that reported nothing would be indistinguishable from success, and the user would hand a
 * colleague an empty paste.
 */
export async function copyText(text: string): Promise<IoResult> {
  const clipboard = navigator.clipboard as { writeText?: (value: string) => Promise<void> } | undefined;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return {
      ok: false,
      reason: 'This document has no clipboard API, so nothing was copied. Use the download instead.',
    };
  }
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `The browser refused the clipboard write: ${messageOf(error)}` };
  }
}
