import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { CaptureRecord, Issue, IssueSeverity } from '../../../core/model/types';
import { VirtualList } from '../../common/virtual-list';
import { useMeasuredHeight } from '../../common/layout';
import { summarizeEvent } from '../../common/format';
import { issuesBySeq, visibleRecords } from '../../model/selectors';
import { selectSeq, type PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface EventListProps {
  store: PanelStore;
  /**
   * Advanced by the host on every cross-pane locate (P7: waterfall → list).
   *
   * `selectedSeq` is the *what*; this is the *again*. Clicking the same waterfall bar a second
   * time, after scrolling the list away, writes the same `selectedSeq` and so moves nothing —
   * see the note on `scrollToIndex` below. Passing the nonce straight through to `VirtualList`
   * turns that repeated click into a fresh scroll request.
   */
  locateNonce?: number;
}

/** Uniform row height, in px. `VirtualList` assumes uniform rows in phase 1. */
const ROW_HEIGHT_PX = 22;

/** Worst severity wins the row's tint: an error must not be hidden by a co-located info. */
const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 3, warning: 2, info: 1 };

function worstSeverity(issues: Issue[]): IssueSeverity | undefined {
  let worst: IssueSeverity | undefined;
  for (const issue of issues) {
    if (worst === undefined || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[worst]) {
      worst = issue.severity;
    }
  }
  return worst;
}

/** `CaptureRecord` is a union on `kind`; only the `event` arm has an `event` to read a type off. */
function typeLabel(record: CaptureRecord): string {
  if (record.kind === 'keepalive') return 'keepalive';
  return record.event === null ? 'unparsed' : record.event.type;
}

interface EventRowProps {
  record: CaptureRecord;
  issues: Issue[];
  selected: boolean;
  /** True for the one row in the tab order (the roving tabindex). */
  tabbable: boolean;
  /** Shared standing request: the seq that should take DOM focus as soon as its row exists. */
  focusSeqRef: { current: number | null };
  onSelect: (seq: number) => void;
}

/**
 * One row, and the owner of its own focus.
 *
 * Focus is claimed by the row rather than handed to it by the list, because a row navigated to
 * may not exist yet. `VirtualList` scrolls in its own layout effect, and the setState it makes
 * there re-renders `VirtualList` alone — `EventList` does not re-render, so an effect there
 * cannot see the window that finally contains the target row and cannot retry. Every row instead
 * checks the standing request whenever it renders, including the render in which it first
 * appears, so the row that eventually mounts is the one that takes focus. That covers both the
 * near case (the row was already in the window and re-rendered in place) and the far case (End
 * from row 1 of 5002) with the same three lines.
 */
function EventRow({
  record,
  issues,
  selected,
  tabbable,
  focusSeqRef,
  onSelect,
}: EventRowProps): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (focusSeqRef.current !== record.seq) return;
    focusSeqRef.current = null;
    ref.current?.focus();
  });

  const severity = worstSeverity(issues);
  const summary = summarizeEvent(record);
  // The tint carries no accessible information on its own, so the severity and the codes go into
  // the row's name. An explicit label rather than the concatenated spans: adjacent inline spans
  // produce a name with no separators.
  const label =
    severity === undefined
      ? `seq ${record.seq} ${typeLabel(record)} ${summary}`
      : `seq ${record.seq} ${typeLabel(record)} ${summary} — ${severity}: ${issues
          .map((issue) => issue.code)
          .join(', ')}`;

  return (
    <button
      ref={ref}
      type="button"
      role="option"
      class="agui-event-row"
      style={{ height: `${ROW_HEIGHT_PX}px` }}
      data-seq={record.seq}
      data-severity={severity}
      aria-label={label}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(record.seq)}
    >
      <span class="agui-event-row__seq">{record.seq}</span>
      <span class="agui-event-row__type">{typeLabel(record)}</span>
      <span class="agui-event-row__summary">{summary}</span>
    </button>
  );
}

export function EventList({ store, locateNonce }: EventListProps): JSX.Element {
  const state = usePanelState(store);
  const containerRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(containerRef);

  const records = visibleRecords(state);
  // Row annotation reads the seq index, NEVER `record.issues`: the run builder attaches issues
  // to the run and the import path hands back the records it was fed, so `record.issues` is
  // empty on every imported record. `issuesBySeq` is the authoritative source.
  const bySeq = issuesBySeq(state);
  /*
   * `scrollToIndex` is a value, not a command: `VirtualList` will not re-scroll for the same
   * index twice, deliberately, so an append cannot re-trigger a stale request. That remains
   * sufficient with keyboard navigation added, because every writer of `selectedSeq` here moves
   * it to a *different* index — a click lands on a row that is by definition already on screen,
   * and an arrow key by definition moves. The one writer that does not move it is the cross-pane
   * locate (waterfall → list, P7): the same bar clicked twice writes the same seq. That is what
   * `locateNonce` is for, and it is threaded through rather than derived here — only the host
   * can tell a repeated click apart from a re-render.
   */
  const selectedIndex = records.findIndex((record) => record.seq === state.selectedSeq);
  /*
   * Roving tabindex: exactly one row is in the tab order, and it is the selected one. Falling
   * back to row 0 matters — a `selectedSeq` filtered out of view would otherwise leave no
   * tabbable row at all and strand the whole list outside the tab order.
   */
  const rovingIndex = selectedIndex === -1 ? 0 : selectedIndex;

  /** A standing request for DOM focus, claimed by whichever row turns out to carry that seq. */
  const focusSeqRef = useRef<number | null>(null);

  /** P6 applies to a live, recording capture: a paused one has nothing arriving to tail. */
  const follow = state.source.kind === 'live' && state.recording;

  /**
   * Arrow / Home / End move the selection, and the selection is what the window follows.
   *
   * Selection *is* navigation in this listbox: `scrollToIndex` already tracks `selectedSeq`, so
   * writing the store is the whole of "scroll the new row into view". `preventDefault` stops the
   * arrows from scrolling the viewport out from under the row that is about to be focused.
   */
  function onKeyDown(event: KeyboardEvent): void {
    const last = records.length - 1;
    if (last < 0) return;

    let next: number;
    switch (event.key) {
      // With nothing selected, the first arrow press lands on the first row rather than the
      // second — otherwise row 0 is unreachable by keyboard from a cold start.
      case 'ArrowDown':
        next = selectedIndex === -1 ? 0 : Math.min(selectedIndex + 1, last);
        break;
      case 'ArrowUp':
        next = selectedIndex === -1 ? 0 : Math.max(selectedIndex - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }

    const seq = records[next]?.seq;
    if (seq === undefined) return;
    event.preventDefault();
    focusSeqRef.current = seq;
    store.update((prev) => selectSeq(prev, seq));
  }

  return (
    /*
     * A real listbox, not a `group` of buttons. Virtualization means Tab can only ever reach the
     * ~26 rows of 5002 that are mounted, so the tab-stop-per-row model cannot express this list
     * at all; a listbox has one tab stop and arrow keys for the rest, which is exactly the shape
     * a window can serve.
     */
    <div
      ref={containerRef}
      class="agui-event-list"
      aria-label="Event list"
      role="listbox"
      onKeyDown={onKeyDown}
    >
      {records.length === 0 ? (
        <p class="agui-event-list__empty">No events match the current filter.</p>
      ) : (
        <VirtualList<CaptureRecord>
          items={records}
          rowHeight={ROW_HEIGHT_PX}
          height={height}
          scrollToIndex={selectedIndex === -1 ? undefined : selectedIndex}
          scrollNonce={locateNonce}
          /*
           * P6: tail a live capture, and only a live one. An imported file is complete the
           * moment it loads, so following it would do nothing but fight a user who scrolled.
           * The list stops following as soon as the user scrolls up — `VirtualList` owns that
           * rule, so this prop is the whole of the wiring.
           */
          follow={follow}
          renderRow={(record, index) => (
            // P7: keyed by `seq`, never by the array index — filtering reorders visible rows
            // and `Issue.seq` refers to this number.
            <EventRow
              key={record.seq}
              record={record}
              issues={bySeq.get(record.seq) ?? []}
              selected={record.seq === state.selectedSeq}
              tabbable={index === rovingIndex}
              focusSeqRef={focusSeqRef}
              onSelect={(seq) => {
                store.update((prev) => selectSeq(prev, seq));
              }}
            />
          )}
        />
      )}
    </div>
  );
}
