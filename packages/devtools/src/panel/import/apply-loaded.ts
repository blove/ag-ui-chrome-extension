import type { PanelState } from '../model/panel-types';
import type { LoadedCapture } from './load-jsonl';

/**
 * Commit a decoded capture into panel state.
 *
 * Both import entry points (the Session tab's drop zone and the empty-state drop zone in the
 * shell) route through this so they cannot drift apart.
 *
 * `decodeErrors` has no home of its own in `PanelState`, so a partial decode is recorded in
 * `loadError` as a one-line summary. That is deliberate: the alternative is a partially decoded
 * capture that renders exactly like a clean one, which is the trust failure design decision P9
 * rules out for eviction and which applies verbatim here. The drop zone renders the individual
 * lines; this is the part that survives leaving the tab.
 */
export function applyLoaded(
  s: PanelState,
  loaded: LoadedCapture,
  filename: string,
  importedAtMs: number,
): PanelState {
  const bad = loaded.decodeErrors.length;
  return {
    ...s,
    source: { kind: 'imported', filename, importedAtMs },
    runs: loaded.runs,
    records: loaded.records,
    requests: loaded.requests,
    issues: loaded.issues,
    // E3: what this file already had redacted, kept so a re-export cannot under-report it.
    importedHeader: loaded.header,
    // §10: an imported capture gives you all tabs working, and Session is a tab. The agent
    // metadata the capture saw is part of what that tab shows, so it comes back with the file.
    runtime: loaded.runtime,
    scope: null,
    selectedSeq: null,
    droppedBefore: 0,
    loadError:
      bad === 0
        ? null
        : `${filename}: ${String(bad)} ${bad === 1 ? 'line' : 'lines'} could not be decoded — ` +
          'this capture is incomplete.',
  };
}
