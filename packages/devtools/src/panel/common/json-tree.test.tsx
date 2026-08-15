import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { JsonTree } from './json-tree';

/** A chain `{ next: { next: … { leaf: 'DEEP_LEAF' } } }` `depth` links long. */
function nest(depth: number): unknown {
  let value: unknown = { leaf: 'DEEP_LEAF' };
  for (let i = 0; i < depth; i += 1) value = { next: value };
  return value;
}

function nodeCount(): number {
  return document.querySelectorAll('.agui-json-node').length;
}

describe('JsonTree', () => {
  it('renders a string with its quotes, so an empty string is visible as one', () => {
    render(<JsonTree value={{ city: 'Paris', blank: '' }} />);

    expect(screen.getByText('"Paris"')).toBeTruthy();
    expect(screen.getByText('""')).toBeTruthy();
  });

  it('distinguishes the scalar types it renders', () => {
    render(<JsonTree value={{ n: 24, t: true, z: null, s: '24' }} />);

    const typeOf = (text: string): string | null =>
      screen.getByText(text).getAttribute('data-type');
    expect(typeOf('24')).toBe('number');
    expect(typeOf('true')).toBe('boolean');
    expect(typeOf('null')).toBe('null');
    // The quoted one is the string. A panel that renders 24 and "24" identically cannot answer
    // "is the bug in my UI or in the stream?" for the commonest type confusion there is.
    expect(typeOf('"24"')).toBe('string');
  });

  it('summarizes a container by its size, both open and closed', () => {
    render(<JsonTree value={{ notes: ['a', 'b'], meta: { x: 1 } }} />);

    expect(screen.getByRole('button', { name: 'notes 2 items' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'meta 1 key' })).toBeTruthy();
  });

  it('renders an empty container inline, with no toggle to press', () => {
    render(<JsonTree value={{ notes: [], meta: {} }} />);

    expect(screen.getByText('[]')).toBeTruthy();
    expect(screen.getByText('{}')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /notes/ })).toBeNull();
  });

  it('collapses a container on click and drops its children from the DOM', () => {
    render(<JsonTree value={{ meta: { secret: 'visible-child' } }} />);

    expect(screen.getByText('"visible-child"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'meta 1 key' }));

    expect(screen.getByRole('button', { name: 'meta 1 key' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByText('"visible-child"')).toBeNull();
  });

  it('mounts nothing below the lazy depth until it is asked to (design S4)', () => {
    // 200 levels is not a pathological input: a reconstructed agent state is arbitrary JSON
    // from the wire. Rendering it eagerly is what S4 exists to prevent, so the assertion is
    // that the deep leaf is genuinely ABSENT — not merely hidden by CSS, which would freeze the
    // panel just the same.
    render(<JsonTree value={nest(200)} lazyDepth={3} />);

    expect(screen.queryByText('"DEEP_LEAF"')).toBeNull();
    expect(nodeCount()).toBeLessThanOrEqual(4);
  });

  it('mounts one further level each time a lazy node is expanded', () => {
    render(<JsonTree value={nest(3)} lazyDepth={2} />);

    const before = nodeCount();
    // Depth 2 is the first collapsed node: depths 0 and 1 are below the threshold.
    const lazy = document.querySelectorAll('.agui-json-node[data-depth="2"] button');
    expect(lazy.length).toBe(1);
    fireEvent.click(lazy[0] as HTMLElement);

    expect(nodeCount()).toBe(before + 1);
    expect(screen.queryByText('"DEEP_LEAF"')).toBeNull();
  });

  it('labels the root when given a label, and renders a bare scalar root', () => {
    render(<JsonTree value="just text" label="result" />);

    expect(screen.getByText('result')).toBeTruthy();
    expect(screen.getByText('"just text"')).toBeTruthy();
  });

  it('renders array indices as keys so a position is quotable', () => {
    render(<JsonTree value={['first note', 'second note']} />);

    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByText('"second note"')).toBeTruthy();
  });

  it('renders undefined, which JSON has no way to spell', () => {
    // `ToolCallRecord.result` is `unknown` and is absent until TOOL_CALL_RESULT arrives, so the
    // tree has to be able to say so rather than rendering an empty box.
    render(<JsonTree value={undefined} label="result" />);

    expect(screen.getByText('undefined').getAttribute('data-type')).toBe('undefined');
  });
});
