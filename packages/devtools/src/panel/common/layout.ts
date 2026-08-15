/**
 * Layout constants shared across the panel.
 *
 * Design decision P4 puts the Timeline's list/detail split — and the waterfall's collapse —
 * at the same ~600px width. That number is declared exactly once, here. A second copy in a
 * media query or a component would drift the moment one of them is tuned, and the symptom
 * (a detail pane that stacks at a width where the waterfall has not yet collapsed) is
 * invisible in unit tests.
 */
import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** P4: below this width the Timeline stacks and the waterfall collapses to one line. */
export const NARROW_BREAKPOINT_PX = 600;

/**
 * The media query `useIsNarrow` watches, derived from the constant rather than restated.
 * Exported so a stylesheet generator or a test can assert on it without re-deriving `599`.
 */
export const NARROW_MEDIA_QUERY = `(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`;

/**
 * `matchMedia` is missing in bare jsdom and in any non-browser host, so every access goes
 * through here. Returning `null` rather than throwing keeps the hook usable in a plain
 * `node` test, where "not narrow" is the right default.
 */
function narrowMediaQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(NARROW_MEDIA_QUERY);
}

/** True while the panel viewport is narrower than {@link NARROW_BREAKPOINT_PX}. */
export function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState<boolean>(() => narrowMediaQueryList()?.matches ?? false);

  useEffect(() => {
    const mql = narrowMediaQueryList();
    if (mql === null) return;

    const onChange = (event: MediaQueryListEvent): void => {
      setIsNarrow(event.matches);
    };

    // Re-read on subscribe: the width can change between the initial render and the effect.
    setIsNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, []);

  return isNarrow;
}

/**
 * Viewport height used until a virtualized list's container has been measured.
 *
 * jsdom reports `clientHeight` as 0 and implements no `ResizeObserver`, so without a fallback
 * every virtualized list would window down to zero rows and render nothing at all under test —
 * a list that shows no data and a list that works are then indistinguishable to every gate but
 * the screenshot one.
 */
export const FALLBACK_VIEWPORT_HEIGHT_PX = 480;

/**
 * The measured height of `ref`'s element, for a virtualized list to window against.
 *
 * Shared by every list that virtualizes: the Timeline's event list and the Runs table both need
 * the same measurement and the same jsdom fallback, and two copies of that rule would drift the
 * first time one of them is tuned.
 */
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(FALLBACK_VIEWPORT_HEIGHT_PX);
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
