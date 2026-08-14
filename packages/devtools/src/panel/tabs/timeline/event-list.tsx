import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CaptureRecord, Issue, IssueSeverity } from '../../../core/model/types';
import { VirtualList } from '../../common/virtual-list';
import { summarizeEvent } from '../../common/format';
import { issuesBySeq, visibleRecords } from '../../model/selectors';
import { selectSeq, type PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface EventListProps {
  store: PanelStore;
}

/** Uniform row height, in px. `VirtualList` assumes uniform rows in phase 1. */
const ROW_HEIGHT_PX = 22;

/**
 * Viewport height used until the container has been measured. jsdom reports `clientHeight`
 * as 0 and has no `ResizeObserver`, so without a fallback the list would window down to zero
 * rows and render nothing at all under test.
 */
const FALLBACK_HEIGHT_PX = 480;

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

function useMeasuredHeight(ref: RefObject<HTMLDivElement>): number {
  const [height, setHeight] = useState(FALLBACK_HEIGHT_PX);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      if (el.clientHeight > 0) setHeight(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return height;
}

export function EventList({ store }: EventListProps): JSX.Element {
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
   * index twice, deliberately, so an append cannot re-trigger a stale request. That is
   * sufficient here because the only writer of `selectedSeq` in this component is a click on a
   * row, and a row has to be on screen to be clicked — the "same index again" case can never
   * need a scroll. A cross-pane locate (waterfall → list, P7) would need a nonce; it does not
   * exist yet, so none is invented here.
   */
  const selectedIndex = records.findIndex((record) => record.seq === state.selectedSeq);

  return (
    <div ref={containerRef} class="agui-event-list" aria-label="Event list" role="group">
      {records.length === 0 ? (
        <p class="agui-event-list__empty">No events match the current filter.</p>
      ) : (
        <VirtualList<CaptureRecord>
          items={records}
          rowHeight={ROW_HEIGHT_PX}
          height={height}
          scrollToIndex={selectedIndex === -1 ? undefined : selectedIndex}
          renderRow={(record) => {
            const issues = bySeq.get(record.seq) ?? [];
            const severity = worstSeverity(issues);
            const summary = summarizeEvent(record);
            // The tint carries no accessible information on its own, so the severity and the
            // codes go into the row's name. An explicit label rather than the concatenated
            // spans: adjacent inline spans produce a name with no separators.
            const label =
              severity === undefined
                ? `seq ${record.seq} ${typeLabel(record)} ${summary}`
                : `seq ${record.seq} ${typeLabel(record)} ${summary} — ${severity}: ${issues
                    .map((issue) => issue.code)
                    .join(', ')}`;
            return (
              // P7: keyed and gutter-labelled by `seq`, never by the array index — filtering
              // reorders visible rows and `Issue.seq` refers to this number.
              <button
                key={record.seq}
                type="button"
                class="agui-event-row"
                style={{ height: `${ROW_HEIGHT_PX}px` }}
                data-severity={severity}
                aria-label={label}
                aria-pressed={record.seq === state.selectedSeq}
                onClick={() => {
                  store.update((prev) => selectSeq(prev, record.seq));
                }}
              >
                <span class="agui-event-row__seq">{record.seq}</span>
                <span class="agui-event-row__type">{typeLabel(record)}</span>
                <span class="agui-event-row__summary">{summary}</span>
              </button>
            );
          }}
        />
      )}
    </div>
  );
}
