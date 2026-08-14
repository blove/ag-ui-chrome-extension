import { fireEvent, render } from '@testing-library/preact';
import type { JSX } from 'preact';
import { describe, expect, it } from 'vitest';

import { VirtualList } from './virtual-list';

const ROW_HEIGHT = 20;

function rows(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function renderRow(item: number): JSX.Element {
  return <div key={item}>row {item}</div>;
}

interface Parts {
  viewport: HTMLElement;
  sizer: HTMLElement;
  window: HTMLElement;
}

function parts(container: Element): Parts {
  const viewport = container.querySelector<HTMLElement>('.agui-vlist');
  const sizer = container.querySelector<HTMLElement>('.agui-vlist__sizer');
  const window_ = container.querySelector<HTMLElement>('.agui-vlist__window');
  if (viewport === null || sizer === null || window_ === null) throw new Error('list did not render');
  return { viewport, sizer, window: window_ };
}

function renderedIndices(container: Element): number[] {
  return [...parts(container).window.children].map((child) =>
    Number((child.textContent ?? '').replace('row ', '')),
  );
}

describe('VirtualList', () => {
  it('renders only a window of rows for a large list', () => {
    const { container } = render(
      <VirtualList
        items={rows(10_000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
      />,
    );

    // 200px / 20px = 10 visible rows, plus 2 rows of overscan below.
    expect(renderedIndices(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(container.textContent).toContain('row 0');
    expect(container.textContent).not.toContain('row 500');
  });

  it('sizes the spacer to the full scroll height, not the window', () => {
    const { container } = render(
      <VirtualList items={rows(10_000)} rowHeight={ROW_HEIGHT} height={200} renderRow={renderRow} />,
    );

    expect(parts(container).sizer.style.height).toBe('200000px');
    expect(parts(container).viewport.style.height).toBe('200px');
  });

  it('offsets the window so rendered rows sit at their real scroll position', () => {
    const { container } = render(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
      />,
    );

    const { viewport, window: listWindow } = parts(container);
    viewport.scrollTop = 4000;
    fireEvent.scroll(viewport);

    // start = floor(4000 / 20) - 2 = 198
    expect(renderedIndices(container)[0]).toBe(198);
    expect(listWindow.style.transform).toBe('translateY(3960px)');
  });

  it('scrolls a row into range for scrollToIndex', () => {
    const { container, rerender } = render(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
      />,
    );
    expect(renderedIndices(container)).not.toContain(500);

    rerender(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={2}
        renderRow={renderRow}
        scrollToIndex={500}
      />,
    );

    // Scrolls the minimum distance: row 500's bottom edge lands on the viewport's.
    expect(parts(container).viewport.scrollTop).toBe(501 * ROW_HEIGHT - 200);
    expect(renderedIndices(container)).toContain(500);
  });

  it('scrolls backwards for an index above the window', () => {
    const props = {
      items: rows(1000),
      rowHeight: ROW_HEIGHT,
      height: 200,
      overscan: 2,
      renderRow,
    };
    const { container, rerender } = render(<VirtualList {...props} scrollToIndex={500} />);
    rerender(<VirtualList {...props} scrollToIndex={10} />);

    expect(parts(container).viewport.scrollTop).toBe(10 * ROW_HEIGHT);
    expect(renderedIndices(container)).toContain(10);
  });

  it('leaves the scroll position alone when the index is already visible', () => {
    const props = {
      items: rows(1000),
      rowHeight: ROW_HEIGHT,
      height: 200,
      overscan: 2,
      renderRow,
    };
    const { container, rerender } = render(<VirtualList {...props} scrollToIndex={500} />);
    const before = parts(container).viewport.scrollTop;

    rerender(<VirtualList {...props} scrollToIndex={495} />);
    expect(parts(container).viewport.scrollTop).toBe(before);
  });

  it('tails appended items while pinned to the bottom (P6)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow, follow: true };
    const { container, rerender } = render(<VirtualList {...props} items={rows(30)} />);

    expect(renderedIndices(container)).toContain(29);
    expect(parts(container).viewport.scrollTop).toBe(30 * ROW_HEIGHT - 100);

    rerender(<VirtualList {...props} items={rows(40)} />);
    expect(renderedIndices(container)).toContain(39);
    expect(parts(container).viewport.scrollTop).toBe(40 * ROW_HEIGHT - 100);
  });

  it('stops following the moment the user scrolls up (P6)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow, follow: true };
    const { container, rerender } = render(<VirtualList {...props} items={rows(40)} />);
    expect(renderedIndices(container)).toContain(39);

    const { viewport } = parts(container);
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(renderedIndices(container)).toContain(0);
    expect(renderedIndices(container)).not.toContain(39);

    rerender(<VirtualList {...props} items={rows(50)} />);
    expect(parts(container).viewport.scrollTop).toBe(0);
    expect(renderedIndices(container)).not.toContain(49);
    expect(renderedIndices(container)).toContain(0);
  });

  it('resumes following once the user scrolls back to the bottom', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow, follow: true };
    const { container, rerender } = render(<VirtualList {...props} items={rows(40)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 40 * ROW_HEIGHT - 100;
    fireEvent.scroll(viewport);

    rerender(<VirtualList {...props} items={rows(50)} />);
    expect(renderedIndices(container)).toContain(49);
  });

  it('does not tail when follow is off', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 100, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(30)} />);
    expect(renderedIndices(container)).toContain(0);

    rerender(<VirtualList {...props} items={rows(40)} />);
    expect(parts(container).viewport.scrollTop).toBe(0);
    expect(renderedIndices(container)).not.toContain(39);
  });

  /*
   * `scrollTop` is state but `count` is a prop, so a shrink re-renders with a scroll position
   * that no longer exists. Every other shrink test here has `follow` on, and the follow effect
   * re-pins before the render is seen — these three deliberately leave it off, which is the
   * filter case P7 hits on every keystroke.
   */
  it('renders the whole list when it shrinks under a scrolled viewport (follow off)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 200, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(1000)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 1000 * ROW_HEIGHT - 200;
    fireEvent.scroll(viewport);
    expect(renderedIndices(container)).toContain(999);

    rerender(<VirtualList {...props} items={rows(10)} />);

    // All ten rows fit the 200px viewport, so all ten must render.
    expect(renderedIndices(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('renders the tail when the list shrinks past the scroll position (follow off)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 200, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(1000)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 900 * ROW_HEIGHT;
    fireEvent.scroll(viewport);

    rerender(<VirtualList {...props} items={rows(300)} />);

    // Clamped to maxScrollTop = 300 * 20 - 200 = 5800, so start = 5800/20 - 2 = 288.
    expect(renderedIndices(container)).toEqual([288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299]);
  });

  it('recovers when the list empties and refills while scrolled (follow off)', () => {
    const props = { rowHeight: ROW_HEIGHT, height: 200, overscan: 2, renderRow };
    const { container, rerender } = render(<VirtualList {...props} items={rows(1000)} />);

    const { viewport } = parts(container);
    viewport.scrollTop = 1000 * ROW_HEIGHT - 200;
    fireEvent.scroll(viewport);

    rerender(<VirtualList {...props} items={rows(0)} />);
    expect(parts(container).window.children.length).toBe(0);

    rerender(<VirtualList {...props} items={rows(20)} />);
    expect(renderedIndices(container).length).toBeGreaterThan(0);
    expect(renderedIndices(container)).toContain(19);
  });

  it('renders nothing but a zero-height spacer for an empty list', () => {
    const { container } = render(
      <VirtualList items={[]} rowHeight={ROW_HEIGHT} height={200} renderRow={renderRow} />,
    );

    expect(parts(container).window.children.length).toBe(0);
    expect(parts(container).sizer.style.height).toBe('0px');
  });

  it('publishes the row height as a custom property so rows can size themselves', () => {
    const { container } = render(
      <VirtualList items={rows(5)} rowHeight={ROW_HEIGHT} height={200} renderRow={renderRow} />,
    );

    expect(parts(container).window.style.getPropertyValue('--agui-vlist-row-height')).toBe('20px');
  });

  it('passes the absolute index to renderRow, not the window offset', () => {
    const seen: number[] = [];
    const { container } = render(
      <VirtualList
        items={rows(1000)}
        rowHeight={ROW_HEIGHT}
        height={200}
        overscan={0}
        renderRow={(item: number, index: number) => {
          seen.push(index);
          return <div key={item}>row {item}</div>;
        }}
      />,
    );

    const { viewport } = parts(container);
    seen.length = 0;
    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);

    expect(seen[0]).toBe(50);
    expect(renderedIndices(container)[0]).toBe(50);
  });
});
