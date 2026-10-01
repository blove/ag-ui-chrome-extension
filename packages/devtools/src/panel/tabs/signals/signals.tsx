/**
 * The Signals tab — design G6–G8.
 *
 * A matrix per agent instance: which of the adapter's signals each Threadplane event WROTE. The
 * data is the hook's own report (names and timing, never values — G2), folded by the live session;
 * the layout is `./matrix`, which is pure. This file draws it and handles the one interaction: a
 * column header finds the wire frame the event most likely came from (`core/signals/match.ts`) and
 * selects it in Timeline, the way Runs, State and Messages hand off.
 *
 * The empty state is the common one — most pages are not Threadplane apps in development mode —
 * so it is worded as an ordinary absence (G7), never as a fault.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { matchReport } from '../../../core/signals/match';
import type { ThreadplaneDevtoolsReport } from '../../../core/signals/report';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { selectScope, selectSeq, selectTab } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import { columnLabel, MAX_COLUMNS, signalBlocks, type SignalBlock } from './matrix';

/** G7, verbatim. Exported so the tests and the visual gate hold the exact wording. */
export const SIGNALS_EMPTY_TEXT =
  'No Threadplane devtools events on this page — the Signals view needs a Threadplane app in development mode, version 0.3.0 or later.';

export interface SignalsProps {
  store: PanelStore;
}

/** Whether the shell's run scope shows `seq` — `selectScope` would otherwise hide the selection. */
function scopeShows(s: PanelState, seq: number): boolean {
  if (s.scope === null) return true;
  const run = s.runs.find((candidate) => candidate.runId === s.scope);
  return run !== undefined && run.recordSeqs.includes(seq);
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function columnKey(report: ThreadplaneDevtoolsReport): string {
  return `${report.agent}:${String(report.seq)}`;
}

function Block({
  block,
  selectedKey,
  onOpen,
}: {
  block: SignalBlock;
  selectedKey: string | null;
  onOpen: (report: ThreadplaneDevtoolsReport) => void;
}): JSX.Element {
  const heading = `${block.adapterLabel} · agent ${block.shortAgent} · ${plural(block.total, 'event', 'events')}`;
  return (
    <section class="agui-signals__block" data-agent={block.agent} aria-label={heading}>
      <h3 class="agui-signals__heading" title={`Agent instance ${block.agent}`}>
        {heading}
      </h3>
      {block.capped ? (
        <p class="agui-signals__note">
          Showing the last {String(MAX_COLUMNS)} of {String(block.total)} events.
        </p>
      ) : null}
      <div class="agui-signals__scroll">
        <table class="agui-signals__matrix" aria-label={`Signals written by ${heading}`}>
          <thead>
            <tr>
              <th class="agui-signals__corner" scope="col">
                Signal
              </th>
              {block.columns.map(({ report }) => {
                const key = columnKey(report);
                return (
                  <th key={key} class="agui-signals__colhead" scope="col">
                    <button
                      type="button"
                      class="agui-signals__col"
                      data-seq={report.seq}
                      data-selected={selectedKey === key ? 'true' : undefined}
                      title={`${report.eventType} — event ${String(report.seq)}. Find its frame in Timeline.`}
                      // The painted label may be abbreviated (`columnLabel`); the name is not.
                      aria-label={report.eventType}
                      onClick={() => {
                        onOpen(report);
                      }}
                    >
                      {columnLabel(report.eventType)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((name) => (
              <tr key={name}>
                <th class="agui-signals__rowhead" scope="row">
                  {name}
                </th>
                {block.columns.map(({ report, lit }) => {
                  const on = lit.has(name);
                  const key = columnKey(report);
                  return (
                    <td
                      key={key}
                      class="agui-signals__cell"
                      data-lit={on ? 'true' : 'false'}
                      data-selected={selectedKey === key ? 'true' : undefined}
                      title={on ? `${report.eventType} wrote ${name}` : undefined}
                    >
                      {on ? <span class="agui-signals__sr">wrote</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Signals({ store }: SignalsProps): JSX.Element {
  const state = usePanelState(store);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<ThreadplaneDevtoolsReport | null>(null);
  const { reports, droppedBefore } = state.signals;

  if (reports.length === 0) {
    return (
      <section class="agui-signals" aria-label="Signals">
        <p class="agui-signals__empty">{SIGNALS_EMPTY_TEXT}</p>
        {state.source.kind === 'imported' ? (
          <p class="agui-signals__empty">
            The Signals view is live only: an imported <code>.agui.jsonl</code> capture does not
            carry these events.
          </p>
        ) : null}
      </section>
    );
  }

  const blocks = signalBlocks(reports);

  const open = (report: ThreadplaneDevtoolsReport): void => {
    setSelectedKey(columnKey(report));
    const current = store.get();
    const match = matchReport(report, current.signals.reports, current.records);
    if (match.kind === 'none') {
      setUnmatched(report);
      return;
    }
    setUnmatched(null);
    const seq = match.seq;
    // Same hand-off as Runs/State/Messages, in one write. The scope is dropped only when it would
    // hide the frame: a selection outside the scope is a selection nobody can see.
    store.update((s) =>
      selectTab(selectSeq(scopeShows(s, seq) ? s : selectScope(s, null), seq), 'timeline'),
    );
  };

  return (
    <section class="agui-signals" aria-label="Signals">
      <p class="agui-signals__lede">
        Which signals each Threadplane event wrote. Select an event to find its frame in Timeline.
      </p>
      {droppedBefore > 0 ? (
        <p class="agui-signals__note">
          {plural(droppedBefore, 'earlier Threadplane event is', 'earlier Threadplane events are')}{' '}
          no longer held — the buffer keeps the most recent.
        </p>
      ) : null}
      <p class="agui-signals__status" role="status">
        {unmatched === null
          ? ''
          : `No matching frame for ${unmatched.eventType} (event ${String(unmatched.seq)}) in this capture.`}
      </p>
      {blocks.map((block) => (
        <Block key={block.agent} block={block} selectedKey={selectedKey} onOpen={open} />
      ))}
    </section>
  );
}
