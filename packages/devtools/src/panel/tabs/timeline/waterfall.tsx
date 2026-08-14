import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { CaptureRecord, Run } from '../../../core/model/types';
import { formatDuration } from '../../common/format';
import { scopedRun } from '../../model/selectors';
import type { PanelState } from '../../model/panel-types';
import { selectSeq, type PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface WaterfallProps {
  store: PanelStore;
  collapsed: boolean;
  /**
   * Announced after every bar click, with the seq that was selected.
   *
   * `selectedSeq` alone cannot express "locate this again": clicking the same bar twice writes
   * the same value, so a listener diffing state sees nothing the second time even though the
   * user has scrolled the list away in between. The host turns this into a fresh scroll request.
   */
  onLocate?: (seq: number) => void;
}

type Lane = 'run' | 'message' | 'tool' | 'step';

interface Bar {
  id: string;
  lane: Lane;
  label: string;
  startMs: number;
  /** `undefined` while the span is still open; resolved to the chart's end before drawing. */
  endMs: number | undefined;
  /** The event this bar points at, or `null` when no record falls inside it. */
  seq: number | null;
  /** Stalls belonging to this bar, drawn inside its track. Message bars only. */
  stalls: Array<{ startMs: number; endMs: number }>;
}

const LANE_LABEL: Record<Lane, string> = {
  run: 'run',
  message: 'message',
  tool: 'tool',
  step: 'step',
};

/**
 * The first record at or after `tMs`, among the records the run actually owns.
 *
 * `ToolCallRecord` and `StepRecord` carry timestamps but no seqs, so this is the only honest
 * way to point a tool or step bar at an event. `recordSeqs` is in arrival order, so a linear
 * scan finds the first match.
 */
function seqAtTime(run: Run, bySeq: Map<number, CaptureRecord>, tMs: number): number | null {
  for (const seq of run.recordSeqs) {
    const record = bySeq.get(seq);
    if (record !== undefined && record.tMs >= tMs) return seq;
  }
  return null;
}

function barsForRun(run: Run, bySeq: Map<number, CaptureRecord>): Bar[] {
  const stallsByMessage = new Map<string, Array<{ startMs: number; endMs: number }>>();
  for (const stall of run.metrics.stalls) {
    const existing = stallsByMessage.get(stall.messageId);
    const entry = { startMs: stall.startMs, endMs: stall.endMs };
    if (existing) existing.push(entry);
    else stallsByMessage.set(stall.messageId, [entry]);
  }

  const bars: Bar[] = [
    {
      id: `run:${run.runId}`,
      lane: 'run',
      label: `${run.runId} · ${run.outcome}`,
      startMs: run.startedAtMs,
      endMs: run.endedAtMs,
      seq: run.recordSeqs[0] ?? null,
      stalls: [],
    },
  ];

  for (const message of run.messages.values()) {
    bars.push({
      id: `message:${run.runId}:${message.messageId}`,
      lane: 'message',
      label: `${message.messageId} · ${message.kind}`,
      startMs: message.startedAtMs,
      endMs: message.endedAtMs,
      // `contentSeqs` is exactly "the events this message is made of", so it beats a time scan.
      seq: message.contentSeqs[0] ?? seqAtTime(run, bySeq, message.startedAtMs),
      stalls: stallsByMessage.get(message.messageId) ?? [],
    });
  }

  for (const toolCall of run.toolCalls.values()) {
    bars.push({
      id: `tool:${run.runId}:${toolCall.toolCallId}`,
      lane: 'tool',
      label: toolCall.toolCallName ?? toolCall.toolCallId,
      startMs: toolCall.startedAtMs,
      // The result is what the caller waited for, so it wins over the args-complete time.
      endMs: toolCall.resultAtMs ?? toolCall.endedAtMs,
      seq: seqAtTime(run, bySeq, toolCall.startedAtMs),
      stalls: [],
    });
  }

  for (const [index, step] of run.steps.entries()) {
    bars.push({
      id: `step:${run.runId}:${index}`,
      lane: 'step',
      label: step.stepName,
      startMs: step.startedAtMs,
      endMs: step.endedAtMs,
      seq: seqAtTime(run, bySeq, step.startedAtMs),
      stalls: [],
    });
  }

  return bars;
}

interface Chart {
  runs: Run[];
  bars: Bar[];
  startMs: number;
  endMs: number;
  stallCount: number;
}

function buildChart(state: PanelState): Chart {
  // Scoped to one run when the scope bar names one; otherwise every run is charted, which is
  // what keeps the cross-run view P3 asks for from going blank.
  const scoped = scopedRun(state);
  const runs = scoped === undefined ? state.runs : [scoped];
  const bySeq = new Map<number, CaptureRecord>(state.records.map((record) => [record.seq, record]));
  const bars = runs.flatMap((run) => barsForRun(run, bySeq));

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    startMs = Math.min(startMs, bar.startMs);
    endMs = Math.max(endMs, bar.endMs ?? bar.startMs);
    for (const stall of bar.stalls) endMs = Math.max(endMs, stall.endMs);
  }
  if (bars.length === 0) {
    startMs = 0;
    endMs = 0;
  }

  return {
    runs,
    bars,
    startMs,
    endMs,
    stallCount: bars.reduce((total, bar) => total + bar.stalls.length, 0),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function summarize(chart: Chart): string {
  const count = (lane: Lane): number => chart.bars.filter((bar) => bar.lane === lane).length;
  return [
    plural(chart.runs.length, 'run'),
    plural(count('message'), 'message'),
    plural(count('tool'), 'tool'),
    plural(count('step'), 'step'),
    plural(chart.stallCount, 'stall'),
    formatDuration(chart.endMs - chart.startMs),
  ].join(' · ');
}

function pct(value: number, startMs: number, span: number): number {
  return ((value - startMs) / span) * 100;
}

export function Waterfall({ store, collapsed, onLocate }: WaterfallProps): JSX.Element {
  const state = usePanelState(store);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const chart = buildChart(state);
  const showChart = !collapsed || expanded;
  // A zero-length chart (a single instantaneous run) would divide by zero.
  const span = Math.max(1, chart.endMs - chart.startMs);

  const select = (seq: number | null): void => {
    if (seq === null) return;
    store.update((prev) => selectSeq(prev, seq));
    // Announced even when `selectedSeq` did not change: that is the whole point of the channel.
    onLocate?.(seq);
  };

  return (
    <section class="agui-waterfall" aria-label="Waterfall" data-collapsed={collapsed}>
      {collapsed ? (
        <button
          type="button"
          class="agui-waterfall__toggle"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
        >
          Waterfall · {summarize(chart)}
        </button>
      ) : null}
      {showChart ? (
        chart.bars.length === 0 ? (
          <p class="agui-waterfall__empty">No runs to chart.</p>
        ) : (
          <ol class="agui-waterfall__lanes">
            {chart.bars.map((bar) => {
              const endMs = bar.endMs ?? chart.endMs;
              const left = pct(bar.startMs, chart.startMs, span);
              const width = Math.max(0.5, pct(endMs, chart.startMs, span) - left);
              const duration = formatDuration(endMs - bar.startMs);
              return (
                <li class="agui-waterfall__lane" key={bar.id} data-lane={bar.lane}>
                  <span class="agui-waterfall__lane-label">{bar.label}</span>
                  <span class="agui-waterfall__track">
                    <button
                      type="button"
                      class="agui-waterfall__bar"
                      data-lane={bar.lane}
                      data-open={bar.endMs === undefined}
                      data-hovered={hovered === bar.id}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      // A bar has no text of its own — it is a coloured rectangle — so its name
                      // is stated outright rather than assembled from child spans.
                      aria-label={`${LANE_LABEL[bar.lane]} ${bar.label} ${duration}${
                        bar.endMs === undefined ? ' (open)' : ''
                      }`}
                      // Hover is a local emphasis only. Highlighting the matching rows in the
                      // event list would need a `hoveredSeqs` field the locked contract does not
                      // have; clicking selects instead, which the list already reacts to.
                      onMouseEnter={() => {
                        setHovered(bar.id);
                      }}
                      onMouseLeave={() => {
                        setHovered(null);
                      }}
                      onFocus={() => {
                        setHovered(bar.id);
                      }}
                      onBlur={() => {
                        setHovered(null);
                      }}
                      onClick={() => {
                        select(bar.seq);
                      }}
                    />
                    {bar.stalls.map((stall) => {
                      const stallLeft = pct(stall.startMs, chart.startMs, span);
                      const stallWidth = Math.max(
                        0.5,
                        pct(stall.endMs, chart.startMs, span) - stallLeft,
                      );
                      return (
                        <button
                          type="button"
                          class="agui-waterfall__stall"
                          key={`${bar.id}:stall:${stall.startMs}`}
                          style={{ left: `${stallLeft}%`, width: `${stallWidth}%` }}
                          aria-label={`stall ${formatDuration(stall.endMs - stall.startMs)} in ${
                            bar.label
                          }`}
                          onClick={() => {
                            select(bar.seq);
                          }}
                        />
                      );
                    })}
                  </span>
                  <span class="agui-waterfall__duration">{duration}</span>
                </li>
              );
            })}
          </ol>
        )
      ) : null}
    </section>
  );
}
