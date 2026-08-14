/**
 * The windowing maths behind `VirtualList`, kept pure and DOM-free.
 *
 * Design §6 makes virtualization mandatory — a long run is comfortably 10k events — and the
 * failure mode of getting it slightly wrong is blank rows at a scroll position no component
 * test happens to visit. Isolating the arithmetic is what makes those positions cheap to
 * enumerate.
 */

/**
 * The half-open range of item indices to render for a given scroll position.
 *
 * `start` is clamped to `>= 0` and `end` to `<= count`; `end` is exclusive. `overscan` rows
 * are added at each end and clamped with everything else, so a caller never has to re-clamp.
 */
export function windowRange(
  scrollTop: number,
  height: number,
  rowHeight: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  // A zero or negative row height would divide by zero and produce Infinity indices.
  if (!Number.isFinite(rowHeight) || rowHeight <= 0 || count <= 0) return { start: 0, end: 0 };

  // Elastic overscroll reports a negative scrollTop; NaN reaches here from an unlaid-out node.
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const viewport = Number.isFinite(height) && height > 0 ? height : 0;
  const pad = Number.isFinite(overscan) && overscan > 0 ? Math.ceil(overscan) : 0;

  // Exact cover: the first row overlapping the top edge through the last overlapping the
  // bottom edge. `ceil` on the bottom is what keeps a partially visible final row rendered.
  const firstVisible = Math.floor(top / rowHeight);
  const endVisible = Math.ceil((top + viewport) / rowHeight);

  const start = clamp(firstVisible - pad, 0, count);
  const end = clamp(endVisible + pad, start, count);
  return { start, end };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
