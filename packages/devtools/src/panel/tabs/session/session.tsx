import type { JSX } from 'preact';
import type { PanelState, PanelSource, CaptureStatus } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import { issueCounts } from '../../model/selectors';
import { DropZone } from '../../import/drop-zone';
import type { LoadedCapture } from '../../import/load-jsonl';
import { applyLoaded } from '../../import/apply-loaded';

export interface SessionProps {
  store: PanelStore;
  /**
   * Commit a decoded capture. `App` passes its own so that an import started here is retained
   * for re-decode exactly like one started from the Timeline empty state — otherwise Expand
   * chunks would work after one import path and silently do nothing after the other.
   *
   * Optional so `Session` stays renderable from a test with nothing but a store.
   */
  onLoaded?: (loaded: LoadedCapture, filename: string, text: string) => void;
}

function describeSource(source: PanelSource): string {
  switch (source.kind) {
    case 'imported':
      return `${source.filename} (imported ${new Date(source.importedAtMs).toLocaleTimeString()})`;
    case 'live':
      return `live capture from ${source.origin}`;
    case 'empty':
      return 'nothing loaded yet';
  }
}

/**
 * The capture row, in the same three honest levels the banner uses (design decision P11).
 *
 * The `none` wording is the one that matters: it reports what the PANEL has seen, not a verdict
 * on the page. A production AG-UI app sends nothing until the user types, so "nothing detected"
 * would read as a finding when it is only an absence of evidence.
 */
function describeCapture(capture: CaptureStatus): string {
  switch (capture.kind) {
    case 'unsupported':
      return 'unavailable in this build';
    case 'on':
      return `on for ${capture.origin}`;
    case 'off':
      switch (capture.signal.level) {
        case 'stream':
          return `off for ${capture.origin} — an event stream was seen here`;
        case 'markers':
          return `off for ${capture.origin} — ${capture.signal.detail}`;
        case 'none':
          return `off for ${capture.origin} — nothing on the wire yet, which is normal before the first message`;
      }
  }
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div class="agui-session__row">
      <dt class="agui-session__label">{label}</dt>
      <dd class="agui-session__value">{value}</dd>
    </div>
  );
}

/**
 * The Session tab: where the data came from, what is known about the page, and the import
 * control.
 *
 * Design §4 lists detected framework, versions, endpoints, transport, runtime mode and `/info`
 * agents here. All of those come from the capture layer, which does not exist yet, so each is
 * reported as "not detected" with the reason rather than omitted — an absent row reads as "there
 * is nothing to know", which is a different and false claim.
 *
 * Design §4 also lists export controls. Phase 1 has no export, so this states that plainly
 * instead of shipping a disabled button that looks like a bug.
 */
export function Session({ store, onLoaded }: SessionProps): JSX.Element {
  const state: PanelState = usePanelState(store);
  const counts = issueCounts(state);
  const scopeLabel = state.scope === null ? 'all runs' : `run ${state.scope}`;

  return (
    <section class="agui-session" aria-label="Session">
      <h2 class="agui-session__title">Session</h2>

      <h3 class="agui-session__heading">Source</h3>
      <dl class="agui-session__grid">
        <Row label="Data" value={describeSource(state.source)} />
        <Row label="Runs" value={String(state.runs.length)} />
        <Row label="Records" value={String(state.records.length)} />
        <Row
          label="Dropped before"
          value={
            state.droppedBefore === 0
              ? 'none — nothing has been evicted'
              : `${String(state.droppedBefore)} records evicted`
          }
        />
      </dl>

      <h3 class="agui-session__heading">Detected</h3>
      <dl class="agui-session__grid">
        <Row label="Framework" value="not detected — detection ships with the capture layer" />
        <Row label="Endpoints" value="not detected — detection ships with the capture layer" />
        <Row
          label="Transport"
          value={
            state.source.kind === 'imported'
              ? 'as recorded in the imported capture'
              : 'not detected — detection ships with the capture layer'
          }
        />
        <Row label="Agents" value="not detected — /info discovery ships with the capture layer" />
      </dl>

      <h3 class="agui-session__heading">Capture</h3>
      <dl class="agui-session__grid">
        <Row label="Status" value={describeCapture(state.capture)} />
        <Row label="Expand chunks" value={state.expandChunks ? 'on' : 'off'} />
        <Row label="Export" value="not available in phase 1" />
      </dl>

      <h3 class="agui-session__heading">Issues ({scopeLabel})</h3>
      <dl class="agui-session__grid">
        <Row label="Errors" value={String(counts.error)} />
        <Row label="Warnings" value={String(counts.warning)} />
        <Row label="Info" value={String(counts.info)} />
        <Row label="Total" value={String(counts.total)} />
      </dl>

      <h3 class="agui-session__heading">Import</h3>
      <p class="agui-session__note">
        A <code>.agui.jsonl</code> capture loads read-only with every tab working — the shareable
        bug report of requirements §10. Nothing is uploaded; the file is read in this panel.
      </p>
      <DropZone
        store={store}
        onLoaded={(loaded, filename, text) => {
          if (onLoaded !== undefined) {
            onLoaded(loaded, filename, text);
            return;
          }
          store.update((s) => applyLoaded(s, loaded, filename, Date.now()));
        }}
      />
    </section>
  );
}
