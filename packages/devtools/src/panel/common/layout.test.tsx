import { render, screen } from '@testing-library/preact';
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FALLBACK_VIEWPORT_HEIGHT_PX,
  NARROW_BREAKPOINT_PX,
  NARROW_MEDIA_QUERY,
  useIsNarrow,
  useMeasuredHeight,
} from './layout';

interface FakeMatchMedia {
  /** Every query string the hook asked for. */
  readonly queries: string[];
  /** Fire a `change` event, as a resize past the breakpoint would. */
  emit: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMatchMedia {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const queries: string[] = [];
  let matches = initialMatches;

  const mql = {
    get matches() {
      return matches;
    },
    media: '',
    addEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
      if (type === 'change') listeners.delete(listener);
    },
  };

  window.matchMedia = (query: string): MediaQueryList => {
    queries.push(query);
    mql.media = query;
    return mql as unknown as MediaQueryList;
  };

  return {
    queries,
    emit(next: boolean): void {
      matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
      });
    },
    listenerCount: () => listeners.size,
  };
}

function Probe(): JSX.Element {
  return <span data-testid="probe">{String(useIsNarrow())}</span>;
}

function probeText(): string {
  return screen.getByTestId('probe').textContent ?? '';
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('NARROW_BREAKPOINT_PX', () => {
  it('is the single 600px declaration from P4', () => {
    expect(NARROW_BREAKPOINT_PX).toBe(600);
  });

  it('derives the media query rather than restating the number', () => {
    expect(NARROW_MEDIA_QUERY).toBe(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);
  });
});

describe('useIsNarrow', () => {
  it('reports narrow when the breakpoint query matches on mount', () => {
    const media = installMatchMedia(true);
    render(<Probe />);
    expect(probeText()).toBe('true');
    expect(media.queries).toContain(NARROW_MEDIA_QUERY);
  });

  it('reports wide when the query does not match', () => {
    installMatchMedia(false);
    render(<Probe />);
    expect(probeText()).toBe('false');
  });

  it('follows a change event in both directions', () => {
    const media = installMatchMedia(false);
    render(<Probe />);

    media.emit(true);
    expect(probeText()).toBe('true');

    media.emit(false);
    expect(probeText()).toBe('false');
  });

  it('unsubscribes on unmount', () => {
    const media = installMatchMedia(true);
    const view = render(<Probe />);
    expect(media.listenerCount()).toBe(1);

    view.unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it('falls back to wide when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    render(<Probe />);
    expect(probeText()).toBe('false');
  });
});

/**
 * The viewport height a virtualized list windows against.
 *
 * Shared because both lists that virtualize need it and it has one non-obvious rule: jsdom
 * reports `clientHeight` as 0, so a hook that trusted the measurement would window every list
 * down to zero rows and render NOTHING under test — which is indistinguishable, to every gate
 * except the screenshot one, from a list that renders correctly.
 */
describe('useMeasuredHeight', () => {
  function HeightProbe({ clientHeight }: { clientHeight?: number }): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const height = useMeasuredHeight(ref);
    return (
      <div
        ref={(el: HTMLDivElement | null) => {
          ref.current = el;
          if (el !== null && clientHeight !== undefined) {
            Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
          }
        }}
      >
        <span data-testid="probe">{String(height)}</span>
      </div>
    );
  }

  it('falls back rather than windowing to zero rows when nothing has been measured', () => {
    render(<HeightProbe />);
    expect(probeText()).toBe(String(FALLBACK_VIEWPORT_HEIGHT_PX));
    expect(FALLBACK_VIEWPORT_HEIGHT_PX).toBeGreaterThan(0);
  });

  it('uses the container’s own height once it has one', () => {
    render(<HeightProbe clientHeight={321} />);
    expect(probeText()).toBe('321');
  });
});
