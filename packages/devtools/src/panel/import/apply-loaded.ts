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
    issues: loaded.issues,
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
