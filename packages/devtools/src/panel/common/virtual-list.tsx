/**
 * A minimal fixed-height windowing list.
 *
 * Design §6 rules out a grid dependency, so this is the whole implementation: a scroll
 * viewport, a sizer that holds the full scroll height, and an absolutely positioned window
 * of rows offset by transform. The arithmetic lives in `./window-range` so it can be tested
 * without a DOM.
 *
 * Rows are rendered by the caller and are NOT wrapped in a keyed element here — P7 requires
 * event rows to be keyed by `CaptureRecord.seq`, and a wrapper keyed by array index would
 * quietly defeat that. `renderRow` must therefore return a single element; its height comes
 * from the `--agui-vlist-row-height` custom property set on the window.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { windowRange } from './window-range';

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Fixed row height in px. Phase 1 assumes uniform rows. */
  rowHeight: number;
  /** Viewport height in px. */
  height: number;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  renderRow: (item: T, index: number) => ComponentChildren;
  /** Scroll so this index is visible. Ignored when undefined. */
  scrollToIndex?: number;
  /**
   * Bump to re-issue `scrollToIndex` even though the index has not changed.
   *
   * `scrollToIndex` on its own is a *value*, not a command: the list deliberately refuses to
   * re-scroll for an index it has already served, so appending a row cannot yank the viewport
   * back to a request the user has since scrolled away from. That is right for every writer
   * that moves the index, and wrong for a cross-pane locate (P7) — clicking the same waterfall
   * bar twice is a real, repeated request that leaves the index untouched. The nonce is how a
   * caller says "again"; leaving it undefined keeps the value-only behaviour.
   */
  scrollNonce?: number;
  /** True while the list should tail new items (P6). */
  follow?: boolean;
}

const DEFAULT_OVERSCAN = 4;

/**
 * Slack when deciding "is the user still at the bottom". Fractional device pixel ratios put
 * scrollTop a hair below the maximum at rest, and an exact comparison would read that as the
 * user having scrolled up — turning follow off on the first appended row.
 */
const PIN_SLACK_PX = 2;

export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  const { items, rowHeight, height, renderRow, scrollToIndex, scrollNonce, follow = false } = props;
  const overscan = props.overscan ?? DEFAULT_OVERSCAN;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  /** P6: starts pinned, and only a user scroll away from the bottom clears it. */
  const pinnedRef = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);

  const count = items.length;
  const totalHeight = count * rowHeight;
  const maxScrollTop = Math.max(0, totalHeight - height);

  // Read by the effects below without listing them as dependencies, so appending an item
  // cannot re-trigger a `scrollToIndex` that the user has already scrolled away from.
  const metricsRef = useRef({ count, rowHeight, height, maxScrollTop });
  metricsRef.current = { count, rowHeight, height, maxScrollTop };

  /**
   * State is the source of truth for what is rendered, and the element is written for real
   * scrolling. Both are set here: jsdom stores `scrollTop` but never emits a `scroll` event
   * for a programmatic write, so relying on the round-trip would make follow untestable.
   */
  const scrollTo = (top: number): void => {
    const el = viewportRef.current;
    if (el !== null) el.scrollTop = top;
    scrollTopRef.current = top;
    setScrollTop(top);
  };

  const handleScroll = (): void => {
    const el = viewportRef.current;
    if (el === null) return;
    const next = el.scrollTop;
    pinnedRef.current = next >= metricsRef.current.maxScrollTop - PIN_SLACK_PX;
    scrollTopRef.current = next;
    setScrollTop(next);
  };

  // P6: tail while pinned. `maxScrollTop` moves whenever an item is appended, which is
  // exactly when the tail needs re-pinning.
  useLayoutEffect(() => {
    if (!follow || !pinnedRef.current) return;
    if (scrollTopRef.current !== maxScrollTop) scrollTo(maxScrollTop);
  }, [follow, maxScrollTop]);

  // Declared after follow so an explicit request wins if both fire in the same commit.
  useLayoutEffect(() => {
    if (scrollToIndex === undefined) return;
    const metrics = metricsRef.current;
    if (metrics.count === 0) return;

    const index = clamp(Math.floor(scrollToIndex), 0, metrics.count - 1);
    const rowTop = index * metrics.rowHeight;
    const rowBottom = rowTop + metrics.rowHeight;
    const current = scrollTopRef.current;

    let next = current;
    if (rowTop < current) next = rowTop;
    else if (rowBottom > current + metrics.height) next = rowBottom - metrics.height;

    next = clamp(next, 0, metrics.maxScrollTop);
    if (next !== current) scrollTo(next);
    // `scrollNonce` sits beside the index precisely so a repeated request re-fires. Nothing
    // else may join this list: `count`, `height` and the rest are read off `metricsRef`
    // exactly so an append cannot re-trigger a request the user has scrolled away from.
  }, [scrollToIndex, scrollNonce]);

  /*
   * `scrollTop` is state but `count` is a prop, so a shrink — a filter change, a cleared
   * capture — renders once with a scroll position the shortened list no longer has. Feeding
   * that stale value straight to `windowRange` clamps `start` to `count` and yields an empty
   * range: a list that looks like it lost its data. The browser fixes the element's own
   * scrollTop a frame later at best (and jsdom never does), so clamp at the point of use.
   */
  const effectiveScrollTop = Math.min(scrollTop, maxScrollTop);
  const { start, end } = windowRange(effectiveScrollTop, height, rowHeight, count, overscan);
  const rows = items.slice(start, end).map((item, offset) => renderRow(item, start + offset));

  return (
    <div
      ref={viewportRef}
      class="agui-vlist"
      style={{ height: `${height}px` }}
      onScroll={handleScroll}
    >
      <div class="agui-vlist__sizer" style={{ height: `${totalHeight}px` }}>
        <div
          class="agui-vlist__window"
          style={`transform: translateY(${start * rowHeight}px); --agui-vlist-row-height: ${rowHeight}px;`}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
