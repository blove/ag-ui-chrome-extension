/**
 * Layout constants shared across the panel.
 *
 * Design decision P4 puts the Timeline's list/detail split — and the waterfall's collapse —
 * at the same ~600px width. That number is declared exactly once, here. A second copy in a
 * media query or a component would drift the moment one of them is tuned, and the symptom
 * (a detail pane that stacks at a width where the waterfall has not yet collapsed) is
 * invisible in unit tests.
 */
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
