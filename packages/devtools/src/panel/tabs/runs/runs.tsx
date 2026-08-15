/**
 * The Runs tab — requirements §9.2, design decisions R1–R3.
 *
 * "Table of runs (thread, agent, outcome, duration, TTFT, event count, issue count). Click
 * through to Timeline filtered to that run." That is the whole of it: this tab measures nothing
 * and reconstructs nothing, it is a picker over runs `core/` already built.
 *
 * What each column SAYS — and what it says when there is nothing to say — lives in `./rows`,
 * which is pure. This file decides only how to draw it, and the one thing it must not do is fill
 * a gap: `agentId`, `durationMs` and `ttftMs` are undefined on real runs, and a table that
 * printed `0` there would be reporting a measurement nobody took.
 *
 * Virtualized per R3. The rows are uniform, which is what `common/virtual-list` requires, and
 * `preserve on navigate` lets runs accumulate across a long session — Messages deliberately did
 * NOT virtualize because its rows are variable-height, and that reasoning does not reach here.
 */
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { useMeasuredHeight } from '../../common/layout';
import { VirtualList } from '../../common/virtual-list';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { selectScope, selectSeq, selectTab } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import { RUN_COLUMNS, runRows, type RunRow } from './rows';

export interface RunsProps {
  store: PanelStore;
}

/** Uniform row height, in px. `VirtualList` assumes uniform rows in phase 1. */
const ROW_HEIGHT_PX = 24;

/**
 * One run, as one control.
 *
 * A `button` carrying `role="row"`, the same shape the Timeline's event rows use: virtualization
 * means only a window of rows is ever mounted, and the whole row is the click target R2 asks for.
 * The cells are `role="cell"` spans laid out on a grid shared with the header, so the columns line
 * up without a `<table>` — which `VirtualList`'s sizer/window structure cannot contain.
 */
function RunTableRow({
  row,
  current,
  onOpen,
}: {
  row: RunRow;
  current: boolean;
  onOpen: (row: RunRow) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="row"
      class="agui-runs__row"
      style={{ height: `${ROW_HEIGHT_PX}px` }}
      data-run-id={row.runId}
      data-outcome={row.outcome}
      data-redacted={row.redacted ? 'true' : 'false'}
      data-testid={`run-row-${row.runId}`}
      // `aria-current` rather than `aria-selected`: the row is in a `table`, where selection is
      // not a defined state. What is true is that this is the run the shell is scoped to.
      aria-current={current ? 'true' : undefined}
      aria-label={row.label}
      title={`Scope the panel to ${row.runId} and open it in Timeline.`}
      onClick={() => {
        onOpen(row);
      }}
    >
      <span class="agui-runs__cell agui-runs__cell--run" role="cell" data-column="run">
        <span class="agui-runs__run-id">{row.runId}</span>
        {/* A redacted run is marked where the reader is looking, not only in a banner they may
            have scrolled past. Its counts are honest — the validator withdraws the claim
            redaction destroyed the evidence for — but its VALUES are placeholders. */}
        {row.redacted ? <span class="agui-runs__redacted-flag">redacted</span> : null}
      </span>

      {RUN_COLUMNS.map((column) => {
        const cell = row.cells[column.key];
        return (
          <span
            key={column.key}
            class="agui-runs__cell"
            role="cell"
            data-column={column.key}
            // The one attribute the whole tab turns on: false means the panel is reporting an
            // absence, and the cell is drawn as prose rather than as a measurement.
            data-known={cell.known ? 'true' : 'false'}
            data-outcome={column.key === 'outcome' ? row.outcome : undefined}
            data-tone={column.key === 'issues' ? (row.worstSeverity ?? 'none') : undefined}
            title={cell.note}
          >
            {cell.text}
          </span>
        );
      })}
    </button>
  );
}

/**
 * Whether this capture's payloads were replaced before it was shared (E3's cumulative header).
 *
 * Read off the runs rather than the header: `Run.redacted` is what `core/` carries, and it is
 * what the validator itself consulted when deciding which claims it could still make.
 */
function anyRedacted(state: PanelState): boolean {
  return state.runs.some((run) => run.redacted.length > 0);
}

export function Runs({ store }: RunsProps): JSX.Element {
  const state = usePanelState(store);
  const bodyRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(bodyRef);

  /*
   * Every run, under every scope — deliberately unlike State and Messages.
   *
   * P3 puts the run scope in the shell and those two tabs filter themselves to it, because each
   * of them renders the CONTENTS of a run. This tab renders the LIST of runs, and R2 makes it the
   * way a scope is chosen: a table that showed only the run already picked would answer "which
   * runs are there?" with "the one you are looking at". The scope is marked instead.
   */
  const rows = runRows(state.runs);

  const open = (row: RunRow): void => {
    /*
     * Scope, then select, then switch — in that order and in one write, which is the precedent
     * Messages set (M5) and State followed. Messages is the better of the two to copy here
     * because it guards the case where there is no frame to select rather than assuming one:
     * State always has a frame's seq to hand, a run row does not.
     *
     * Scoping first matters twice over. `selectScope` drops a selection that falls outside the
     * new scope, so selecting first would throw the selection away again; and the scope is what
     * R2 actually asks for — the frame is only where to land.
     */
    store.update((s) =>
      selectTab(selectSeq(selectScope(s, row.runId), row.firstSeq ?? null), 'timeline'),
    );
  };

  return (
    <section class="agui-runs" aria-label="Runs">
      {anyRedacted(state) ? (
        <p class="agui-runs__redacted" data-testid="runs-redacted" role="note">
          This capture was redacted before it was shared. Every measurement below is real —
          requirements §11 keeps ids, structure, ordering and timing — and so are the issue
          counts: the validator withdraws the one claim redaction destroys the evidence for. What
          redaction removed is the content, which this table never showed.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p class="agui-runs__empty">
          There are no runs to show. Import a <code>.agui.jsonl</code> capture from the Session
          tab, or enable capture and reload the inspected page.
        </p>
      ) : (
        <div class="agui-runs__table" role="table" aria-label="Runs" aria-rowcount={rows.length}>
          <div class="agui-runs__head" role="row">
            {/* The run id is the row's identity, not one of §9.2's seven columns — but a table of
                runs that does not name them is a table you cannot act on. */}
            <span class="agui-runs__th" role="columnheader" data-column="run">
              Run
            </span>
            {RUN_COLUMNS.map((column) => (
              <span
                key={column.key}
                class="agui-runs__th"
                role="columnheader"
                data-column={column.key}
              >
                {column.label}
              </span>
            ))}
          </div>

          <div ref={bodyRef} class="agui-runs__body">
            <VirtualList<RunRow>
              items={rows}
              rowHeight={ROW_HEIGHT_PX}
              height={height}
              /*
               * P6's tail belongs to a live capture: runs are appended as they start, and a
               * developer watching a session wants the newest one on screen. An imported file is
               * complete the moment it loads, so following it would only fight a user scrolling.
               */
              follow={state.source.kind === 'live' && state.recording}
              renderRow={(row) => (
                // Keyed by run id, never by the array index: a live capture appends runs, and a
                // key that moved would re-use the wrong row's DOM.
                <RunTableRow
                  key={row.runId}
                  row={row}
                  current={state.scope === row.runId}
                  onOpen={open}
                />
              )}
            />
          </div>
        </div>
      )}
    </section>
  );
}
