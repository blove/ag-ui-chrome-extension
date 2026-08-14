/**
 * @vitest-environment node
 *
 * Pure arithmetic: no DOM needed, and running it under `node` keeps the guarantee that the
 * windowing logic never quietly grows a document dependency.
 */
import { describe, expect, it } from 'vitest';

import { windowRange } from './window-range';

describe('windowRange', () => {
  it('returns an empty range for an empty list', () => {
    expect(windowRange(0, 200, 20, 0, 4)).toEqual({ start: 0, end: 0 });
  });

  it('renders every row when the list is shorter than the viewport', () => {
    // 3 rows of 20px inside a 200px viewport: nothing to window.
    expect(windowRange(0, 200, 20, 3, 4)).toEqual({ start: 0, end: 3 });
  });

  it('starts at 0 and covers exactly the viewport at scrollTop 0 with no overscan', () => {
    expect(windowRange(0, 200, 20, 1000, 0)).toEqual({ start: 0, end: 10 });
  });

  it('treats end as exclusive', () => {
    const { start, end } = windowRange(0, 200, 20, 1000, 0);
    // 10 rows rendered — indices 0..9 — so index 10 is the first one outside.
    expect(end - start).toBe(10);
    expect(end).toBe(10);
  });

  it('includes the row straddling the top edge for a fractional scrollTop', () => {
    // Rows cover 10..210, i.e. indices 0 through 10 inclusive.
    expect(windowRange(10.5, 200, 20, 1000, 0)).toEqual({ start: 0, end: 11 });
  });

  it('keeps a partially scrolled window aligned to the rows it overlaps', () => {
    // 205..405 overlaps rows 10..20 inclusive.
    expect(windowRange(205, 200, 20, 1000, 0)).toEqual({ start: 10, end: 21 });
  });

  it('clamps end to count when scrolled to the exact end', () => {
    // 100 rows of 20px = 2000px of content in a 200px viewport: maxScrollTop is 1800.
    expect(windowRange(1800, 200, 20, 100, 0)).toEqual({ start: 90, end: 100 });
  });

  it('clamps start at 0 when overscan would run off the top', () => {
    expect(windowRange(0, 200, 20, 1000, 5)).toEqual({ start: 0, end: 15 });
  });

  it('clamps end at count when overscan would run off the bottom', () => {
    expect(windowRange(1800, 200, 20, 100, 5)).toEqual({ start: 85, end: 100 });
  });

  it('applies overscan at both ends in the middle of a long list', () => {
    expect(windowRange(2000, 200, 20, 1000, 3)).toEqual({ start: 97, end: 113 });
  });

  it('covers the partial final row when rowHeight does not divide the height evenly', () => {
    // 200 / 30 = 6.67: seven rows overlap the viewport, the last one only partly.
    expect(windowRange(0, 200, 30, 1000, 0)).toEqual({ start: 0, end: 7 });
    // 45..245 overlaps rows 1..8 inclusive.
    expect(windowRange(45, 200, 30, 1000, 0)).toEqual({ start: 1, end: 9 });
  });

  it('never returns a range outside [0, count] for any scroll position', () => {
    const count = 137;
    const rowHeight = 18;
    const height = 211;
    for (let scrollTop = -50; scrollTop <= count * rowHeight + 50; scrollTop += 7) {
      const { start, end } = windowRange(scrollTop, height, rowHeight, count, 6);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(count);
      expect(end).toBeGreaterThanOrEqual(start);
    }
  });

  it('covers every visible row for any scroll position', () => {
    const count = 137;
    const rowHeight = 18;
    const height = 211;
    for (let scrollTop = 0; scrollTop <= count * rowHeight - height; scrollTop += 3) {
      const { start, end } = windowRange(scrollTop, height, rowHeight, count, 0);
      // Anything painted between the viewport edges must be inside [start, end).
      expect(start * rowHeight).toBeLessThanOrEqual(scrollTop);
      expect(end * rowHeight).toBeGreaterThanOrEqual(scrollTop + height);
    }
  });

  it('clamps a negative scrollTop from elastic overscroll to the top of the list', () => {
    expect(windowRange(-120, 200, 20, 1000, 2)).toEqual({ start: 0, end: 12 });
  });

  it('returns an empty range for a non-positive rowHeight instead of dividing by zero', () => {
    expect(windowRange(0, 200, 0, 1000, 4)).toEqual({ start: 0, end: 0 });
    expect(windowRange(0, 200, -20, 1000, 4)).toEqual({ start: 0, end: 0 });
  });

  it('returns an empty range when scrolled past the end of a shrunken list', () => {
    expect(windowRange(5000, 200, 20, 10, 2)).toEqual({ start: 10, end: 10 });
  });

  it('rounds a fractional overscan up so it never under-renders', () => {
    expect(windowRange(400, 200, 20, 1000, 1.2)).toEqual({ start: 18, end: 32 });
  });
});
