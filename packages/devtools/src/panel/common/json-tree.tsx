/**
 * A collapsible JSON tree (design decision S4).
 *
 * Two properties matter, and they pull against each other:
 *
 *  - **Faithful.** Values are rendered as they are, with their type visible: `24` and `"24"` are
 *    drawn differently, an empty string shows as `""`, and nothing is truncated. The panel exists
 *    to answer "is the bug in my UI or in the stream?", and a tree that tidies a value is a tree
 *    that hides the answer.
 *  - **Bounded.** State snapshots and tool arguments are arbitrary JSON off the wire; there is no
 *    size limit on either. Below `lazyDepth` a node renders COLLAPSED and does not mount its
 *    children at all, so the initial render cost is a function of the threshold rather than of
 *    the document. Collapsing unmounts again, so a subtree that has been opened and closed stops
 *    costing anything.
 *
 * Lazy means unmounted, not `display: none` — hiding a 200-level document with CSS still builds
 * every node, which is the freeze S4 is about.
 *
 * Built in `common/` because Messages (tool args and results) and State (S1's frame value) both
 * render it. Timeline's existing detail pane is deliberately NOT refactored onto it — design §7
 * puts that out of scope.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

export interface JsonTreeProps {
  value: unknown;
  /** Name for the root node — `args`, `result`, a frame label. Omitted for a bare value. */
  label?: string;
  /**
   * The first depth (root is 0) at which a container renders collapsed and unmounted.
   *
   * Everything shallower is expanded on first render, so the shape a reader came for is on
   * screen without a click.
   */
  lazyDepth?: number;
}

/** Deep enough to show the shape of a typical state document; shallow enough to stay cheap. */
const DEFAULT_LAZY_DEPTH = 3;

type Container = { kind: 'object' | 'array'; entries: Array<[string, unknown]> };

/**
 * Containers are objects and arrays only. `null` is `typeof 'object'` and is a leaf, which is the
 * single most common way a JSON walker crashes.
 */
function asContainer(value: unknown): Container | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    return { kind: 'array', entries: value.map((item, index) => [String(index), item]) };
  }
  return { kind: 'object', entries: Object.entries(value as Record<string, unknown>) };
}

/** `2 items` / `1 key`. Read aloud as part of the toggle's name, so it is a phrase, not a glyph. */
function summarize(container: Container): string {
  const count = container.entries.length;
  if (container.kind === 'array') return `${String(count)} item${count === 1 ? '' : 's'}`;
  return `${String(count)} key${count === 1 ? '' : 's'}`;
}

interface Rendered {
  text: string;
  type: string;
}

/** How a leaf is written and what it is. The quotes on a string are the type, visibly. */
function renderLeaf(value: unknown): Rendered {
  if (value === null) return { text: 'null', type: 'null' };
  if (value === undefined) return { text: 'undefined', type: 'undefined' };
  if (typeof value === 'string') return { text: `"${value}"`, type: 'string' };
  if (typeof value === 'number') return { text: String(value), type: 'number' };
  if (typeof value === 'boolean') return { text: String(value), type: 'boolean' };
  // Nothing else survives `JSON.parse`, but `unknown` admits it and a thrown renderer would take
  // the whole tab with it.
  return { text: String(value), type: 'other' };
}

interface NodeProps {
  label: string | undefined;
  value: unknown;
  depth: number;
  lazyDepth: number;
}

function JsonNode({ label, value, depth, lazyDepth }: NodeProps): JSX.Element {
  const container = asContainer(value);
  const [expanded, setExpanded] = useState(depth < lazyDepth);

  if (container === null || container.entries.length === 0) {
    const leaf =
      container === null
        ? renderLeaf(value)
        : { text: container.kind === 'array' ? '[]' : '{}', type: 'empty' };
    return (
      <div class="agui-json-node agui-json-node--leaf" data-depth={depth}>
        {label === undefined ? null : <span class="agui-json-node__key">{label}</span>}
        <span class="agui-json-node__value" data-type={leaf.type}>
          {leaf.text}
        </span>
      </div>
    );
  }

  const summary = summarize(container);
  return (
    <div class="agui-json-node" data-depth={depth} data-kind={container.kind}>
      <button
        type="button"
        class="agui-json-node__toggle"
        aria-expanded={expanded}
        /* An explicit name: adjacent inline spans concatenate with no separator, so the computed
           name would otherwise read `notes2 items`. */
        aria-label={label === undefined ? summary : `${label} ${summary}`}
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
      >
        <span class="agui-json-node__caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        {label === undefined ? null : <span class="agui-json-node__key">{label}</span>}
        <span class="agui-json-node__summary">{summary}</span>
      </button>
      {expanded ? (
        <div class="agui-json-node__children">
          {container.entries.map(([key, child]) => (
            <JsonNode key={key} label={key} value={child} depth={depth + 1} lazyDepth={lazyDepth} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function JsonTree({ value, label, lazyDepth }: JsonTreeProps): JSX.Element {
  return (
    <div class="agui-json-tree">
      <JsonNode label={label} value={value} depth={0} lazyDepth={lazyDepth ?? DEFAULT_LAZY_DEPTH} />
    </div>
  );
}
