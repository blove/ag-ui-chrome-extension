/**
 * The State tab — requirements §9.3, design decisions S1–S4.
 *
 * "Current reconstructed state as a JSON tree, with a scrubber over the patch history … failed
 * patches are marked red at their position on the scrubber." The last clause is the tab's reason
 * to exist: a developer whose agent's state went wrong wants to know WHEN it went wrong, and a
 * failure they have to scrub to find is one they will not find.
 *
 * So the scrubber is the primary control and every position on it is drawn from the frame it
 * stands for — including, in red and in words, the ones whose patch did not apply. The selected
 * frame's document is rendered by `common/json-tree` (S4), which is already built and tested; this
 * file writes no JSON renderer of its own.
 *
 * Positioning — which frames failed, which op inside a delta failed — lives in `./frames`, which
 * is pure. This file decides only how to draw it.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PatchFailure, Run, StateFrame } from '../../../core/model/types';
import { formatDuration } from '../../common/format';
import { JsonTree } from '../../common/json-tree';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { selectScope, selectSeq, selectTab } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import type { FrameMark, OpView } from './frames';
import { FAILURE_TEXT, frameMarks, opViews, resolveIndex } from './frames';

export interface StateProps {
  store: PanelStore;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** `Frame 4 of 7`. 1-based, because that is how a reader counts positions on a scrubber. */
function frameOrdinal(index: number, total: number): string {
  return `Frame ${String(index + 1)} of ${String(total)}`;
}

/**
 * The accessible name of a scrubber position.
 *
 * A failed position says so here as well as in red. Colour is not a claim — a reader with a
 * screen reader, or with a colour vision deficiency, gets exactly the same fact.
 */
function tickLabel(mark: FrameMark, total: number): string {
  const base = `${frameOrdinal(mark.index, total)}: ${mark.kind} at seq ${String(mark.seq)}`;
  if (mark.reason === undefined) return base;
  return `${base}, patch failed — ${FAILURE_TEXT[mark.reason]}`;
}

/**
 * The scrubber (S1), with S3's failures marked in place.
 *
 * A radio group rather than a range input: a range's thumb cannot be styled per position, and the
 * whole requirement is that individual positions be marked. Roving tabindex and arrow keys are
 * what a radio group owes its reader, and they also give the scrubber the keyboard behaviour a
 * scrubber should have — one frame per press.
 */
function Scrubber({
  marks,
  selected,
  runId,
  onSelect,
}: {
  marks: FrameMark[];
  selected: number;
  runId: string;
  onSelect: (index: number, fromKeyboard: boolean) => void;
}): JSX.Element {
  const total = marks.length;
  const track = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef(false);

  /*
   * Move focus with the selection.
   *
   * Roving tabindex leaves every unselected position at `tabindex="-1"`, so a keyboard reader who
   * pressed ArrowLeft and did not move would be focused on a control that is no longer the one
   * selected — and their next Tab would leave the group from the wrong place. Only keyboard moves
   * take focus; a click already put it where the user wanted it.
   */
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const tick = track.current?.querySelector(`[data-index="${String(selected)}"]`);
    if (tick instanceof HTMLElement) tick.focus();
  }, [selected]);

  const move = (event: KeyboardEvent, next: number): void => {
    event.preventDefault();
    restoreFocus.current = true;
    onSelect(Math.min(Math.max(next, 0), total - 1), true);
  };

  return (
    <div
      class="agui-scrub"
      role="radiogroup"
      aria-label={`State timeline for run ${runId}`}
      ref={track}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(event, selected - 1);
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(event, selected + 1);
        else if (event.key === 'Home') move(event, 0);
        else if (event.key === 'End') move(event, total - 1);
      }}
    >
      {marks.map((mark) => (
        <button
          key={mark.index}
          type="button"
          role="radio"
          class="agui-scrub__tick"
          data-testid={`tick-${runId}-${String(mark.index)}`}
          data-index={mark.index}
          data-kind={mark.kind}
          data-failed={mark.failed ? 'true' : 'false'}
          aria-checked={mark.index === selected}
          aria-label={tickLabel(mark, total)}
          tabIndex={mark.index === selected ? 0 : -1}
          onClick={() => {
            onSelect(mark.index, false);
          }}
        >
          {/* Never colour alone: the failed positions carry a glyph too, so they survive a
              greyscale screenshot and a reader who cannot distinguish the hue. */}
          <span class="agui-scrub__glyph" aria-hidden="true">
            {mark.failed ? '!' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One patch operation of the selected delta (S2). */
function PatchOpRow({
  view,
  runId,
  stateRedacted,
}: {
  view: OpView;
  runId: string;
  stateRedacted: boolean;
}): JSX.Element {
  const id = `${runId}-${String(view.index)}`;
  return (
    <li
      class="agui-op"
      data-testid={`op-${id}`}
      data-op-index={view.index}
      data-failed={view.failed ? 'true' : 'false'}
    >
      <div class="agui-op__head">
        <span class="agui-op__index" aria-hidden="true">
          {view.index + 1}
        </span>
        {view.name === undefined ? (
          <span class="agui-op__absent">no op field</span>
        ) : (
          <span class="agui-op__name">{view.name}</span>
        )}
        {view.path === undefined ? (
          <span class="agui-op__absent">no path field</span>
        ) : (
          <code class="agui-op__path">{view.path}</code>
        )}
        {view.from === undefined ? null : <code class="agui-op__from">from {view.from}</code>}
      </div>

      {/* The bytes that arrived, for an entry that cannot be drawn as an operation. It is what
          `invalid-op` is about, so printing it is the difference between reporting a failure and
          reporting which failure. */}
      {view.malformed ? (
        <pre class="agui-op__raw" data-testid={`op-raw-${id}`}>
          {JSON.stringify(view.raw)}
        </pre>
      ) : null}

      {view.hasValue ? <JsonTree value={view.value} label="value" lazyDepth={1} /> : null}

      {view.failed && view.reason !== undefined ? (
        <p class="agui-op__reason">{FAILURE_TEXT[view.reason]}</p>
      ) : null}

      {/*
       * A `test` compares the op's value against the document's, and redaction replaced both with
       * placeholders sized by the originals. Two different values of the same length collide into
       * one placeholder and two of different lengths stop matching, so the verdict on a `test` in
       * a redacted capture is about the redactor, not the agent.
       */}
      {view.failed && view.reason === 'test-failed' && stateRedacted ? (
        <p class="agui-op__note">
          Both sides of this comparison were replaced by the redactor, so whether the values really
          differed cannot be known from this file.
        </p>
      ) : null}
    </li>
  );
}

/** The frame the scrubber is on: what it was, what it carried, and what it left behind. */
function FrameDetail({
  frame,
  index,
  total,
  runId,
  store,
  stateRedacted,
}: {
  frame: StateFrame;
  index: number;
  total: number;
  runId: string;
  store: PanelStore;
  stateRedacted: boolean;
}): JSX.Element {
  const ordinal = frameOrdinal(index, total);
  const failure: { opIndex: number; reason: PatchFailure } | undefined =
    frame.kind === 'delta' ? frame.failure : undefined;
  const ops = opViews(frame);

  return (
    <div
      class="agui-state__frame"
      data-testid={`frame-${runId}`}
      data-index={index}
      data-kind={frame.kind}
      data-failed={failure === undefined ? 'false' : 'true'}
    >
      <div class="agui-state__frame-head" data-testid={`frame-head-${runId}`}>
        <span class="agui-state__frame-ordinal">{ordinal}</span>
        <span class="agui-state__frame-kind" data-kind={frame.kind}>
          {frame.kind}
        </span>
        <span class="agui-state__frame-seq">seq {frame.seq}</span>
        <span class="agui-state__frame-time">{formatDuration(frame.tMs)}</span>
        {/* The same workflow M5 gave Messages: see it wrong here, jump to the frame that
            produced it. Scope first — `selectScope` drops a selection outside the new scope. */}
        <button
          type="button"
          class="agui-state__locate"
          aria-label={`Show frame ${String(index + 1)} of ${String(total)} in Timeline`}
          title={`Select seq ${String(frame.seq)} in Timeline, scoped to ${runId}.`}
          onClick={() => {
            store.update((s) => selectTab(selectSeq(selectScope(s, runId), frame.seq), 'timeline'));
          }}
        >
          Timeline
        </button>
      </div>

      {failure === undefined ? null : (
        <p class="agui-state__failure" data-testid={`failure-${runId}`} role="status">
          Operation {failure.opIndex + 1} of {ops.length} failed: {FAILURE_TEXT[failure.reason]}.
          The patch was abandoned there, so state did not advance past this frame — the document
          below is the one the previous frame left.
        </p>
      )}

      {frame.kind === 'delta' ? (
        <section class="agui-state__patch" aria-label={`Patch at ${ordinal.toLowerCase()}`}>
          {ops.length === 0 ? (
            <p class="agui-state__absent">this delta carried no operations</p>
          ) : (
            <ol class="agui-state__ops">
              {ops.map((view) => (
                <PatchOpRow
                  key={view.index}
                  view={view}
                  runId={runId}
                  stateRedacted={stateRedacted}
                />
              ))}
            </ol>
          )}
        </section>
      ) : null}

      <section class="agui-state__doc" aria-label={`State after ${ordinal.toLowerCase()}`}>
        {frame.value === undefined ? (
          // Reachable: a STATE_DELTA before any STATE_SNAPSHOT is applied against nothing. The
          // JSON tree would print the word `undefined`, which reads like a value the agent sent.
          <p class="agui-state__absent">
            No state document at this frame — nothing has been snapshotted yet.
          </p>
        ) : (
          <JsonTree value={frame.value} label="state" />
        )}
      </section>
    </div>
  );
}

function RunState({
  run,
  store,
  stateRedacted,
}: {
  run: Run;
  store: PanelStore;
  stateRedacted: boolean;
}): JSX.Element {
  /*
   * `null` until the reader scrubs, which is what keeps a live run following its own latest
   * frame — see `resolveIndex`. Held per run rather than in the store: the position is a view of
   * one run's history and nothing outside this tab reads it.
   */
  const [requested, setRequested] = useState<number | null>(null);
  const frames = run.stateTimeline;
  const marks = frameMarks(frames);
  const index = resolveIndex(frames, requested);
  const failures = marks.filter((mark) => mark.failed).length;
  const frame = index === null ? undefined : frames[index];

  return (
    <section class="agui-state__run" aria-label={`Run ${run.runId}`}>
      <h2 class="agui-state__run-head">
        <span class="agui-state__run-id">{run.runId}</span>
        <span class="agui-state__run-thread">thread {run.threadId}</span>
        <span
          class="agui-state__run-outcome"
          data-outcome={run.outcome}
          data-testid={`state-outcome-${run.runId}`}
        >
          {run.outcome}
        </span>
        <span class="agui-state__run-frames" data-testid={`state-frames-${run.runId}`}>
          {plural(frames.length, 'frame')}
        </span>
        {failures === 0 ? null : (
          <span
            class="agui-state__run-failures"
            data-testid={`state-failures-${run.runId}`}
          >
            {String(failures)} failed {failures === 1 ? 'patch' : 'patches'}
          </span>
        )}
      </h2>

      {/* A timeline that is still growing is a real state. Drawing the last frame as "the" state
          would present a run mid-flight as one that ended there. */}
      {run.outcome === 'running' ? (
        <p class="agui-state__streaming" data-testid={`state-streaming-${run.runId}`}>
          This run is still going, so more state frames may still arrive. What is below is the
          history so far.
        </p>
      ) : null}

      {index === null || frame === undefined ? (
        <p class="agui-state__absent">
          This run recorded no state — neither a <code>STATE_SNAPSHOT</code> nor a{' '}
          <code>STATE_DELTA</code> arrived on it.
        </p>
      ) : (
        <>
          <Scrubber
            marks={marks}
            selected={index}
            runId={run.runId}
            onSelect={(next) => {
              setRequested(next);
            }}
          />
          <FrameDetail
            frame={frame}
            index={index}
            total={frames.length}
            runId={run.runId}
            store={store}
            stateRedacted={stateRedacted}
          />
        </>
      )}
    </section>
  );
}

/** P3 puts the run scope in the shell, so this tab reads it rather than owning a selector. */
function scopedRuns(state: PanelState): Run[] {
  if (state.scope === null) return state.runs;
  return state.runs.filter((run) => run.runId === state.scope);
}

export function State({ store }: StateProps): JSX.Element {
  const state = usePanelState(store);
  const runs = scopedRuns(state);
  /*
   * Whether this file's state payloads were replaced before it was shared (E3's cumulative
   * header). Measured on the `state-edge` fixture: `counter` goes 0 → 1 → (2, refused) across the
   * timeline, and after redaction every one of those renders as `«redacted: 1 chars»`. The tree
   * is structurally real and semantically flat, and a reader who was not told would conclude the
   * patch had no effect.
   */
  const stateRedacted = state.importedHeader?.redacted.includes('state') ?? false;

  return (
    <section class="agui-state" aria-label="State">
      {stateRedacted ? (
        <p class="agui-state__redacted" data-testid="state-redacted" role="note">
          This capture&rsquo;s header declares <code>state</code> redacted. Keys, ordering, patch
          operations, JSON Pointer paths and sizes are real; every value below is a placeholder.
          Two frames whose documents differed can therefore render identically — a redacted
          capture shows <em>when</em> and <em>where</em> state changed, never what it changed to.
        </p>
      ) : null}

      {runs.length === 0 ? (
        <p class="agui-state__empty">
          There are no runs to show. Import a <code>.agui.jsonl</code> capture from the Session
          tab, or enable capture and reload the inspected page.
        </p>
      ) : (
        runs.map((run) => (
          <RunState key={run.runId} run={run} store={store} stateRedacted={stateRedacted} />
        ))
      )}
    </section>
  );
}
