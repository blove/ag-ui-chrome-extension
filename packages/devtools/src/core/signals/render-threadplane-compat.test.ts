import { describe, expect, it } from 'vitest';

import { isThreadplaneReport } from './report';
import {
  cloneRenderReport,
  isRenderReport,
  MAX_RENDER_ELEMENTS,
  MAX_RENDER_NAME_LENGTH,
  MAX_RENDER_REGISTRY,
  type RenderDevtoolsReport,
} from './render-report';

/**
 * Every render report Threadplane's hook is known to emit must validate here.
 *
 * The shapes below are copied from Threadplane's own tests on the hook's PR
 * (cacheplane/threadplane#1215): `libs/chat/src/lib/devtools/devtools-render-report.spec.ts` and
 * `libs/render/src/lib/devtools/render-devtools.spec.ts` — what the real renderer reports, not what
 * this repo assumes. A shape that changes there and fails here is the drift this file catches:
 * the extension would drop the report and the UI tab would fall back to the wire checks.
 *
 * The other fields follow the emitter (`devtools-render-report.ts`): `seq` counts per page from 1
 * across surfaces; `tMs` is `performance.now()`; names over 128 are dropped, never truncated; past
 * 2,000 elements and 500 registry names the extras are dropped in order.
 */

/** `REPORT_KEYS` in Threadplane's spec, verbatim: the report's exact key set. */
const THREADPLANE_REPORT_KEYS = ['elements', 'kind', 'registry', 'seq', 'surface', 'tMs', 'v'];

/** `Object.keys(a2uiBasicCatalog())` (`libs/chat/src/lib/a2ui/catalog/index.ts`) — an A2UI surface's registry. */
const A2UI_BASIC_REGISTRY = [
  'AudioPlayer', 'Button', 'Card', 'CheckBox', 'ChoicePicker', 'Column', 'DateTimeInput', 'Divider', 'Icon',
  'Image', 'List', 'Modal', 'Row', 'Slider', 'Tabs', 'Text', 'TextField', 'Video',
];

function report(
  surface: string,
  registry: string[],
  elements: RenderDevtoolsReport['elements'],
  seq = 1,
): RenderDevtoolsReport {
  return { v: 1, kind: 'render', surface, seq, registry, elements, tMs: 1234.5 };
}

const SHAPES: ReadonlyArray<[label: string, report: RenderDevtoolsReport]> = [
  [
    'an A2UI surface: an unknown component unresolved, its subtree hidden, keyed by surfaceId',
    report('s1', A2UI_BASIC_REGISTRY, [
      { key: 'root', type: 'Column', state: 'mounted' },
      { key: 'title', type: 'Text', state: 'mounted' },
      { key: 'mystery', type: 'Mystery', state: 'unresolved' },
      { key: 'inner', type: 'Column', state: 'hidden' },
      { key: 'leaf', type: 'Text', state: 'hidden' },
    ]),
  ],
  [
    'a data-bound component as fallback until its data arrives',
    report('s1', A2UI_BASIC_REGISTRY, [
      { key: 'root', type: 'Column', state: 'mounted' },
      { key: 'name', type: 'Text', state: 'fallback' },
    ]),
  ],
  [
    'the same, once mounted (a later seq)',
    report('s1', A2UI_BASIC_REGISTRY, [
      { key: 'root', type: 'Column', state: 'mounted' },
      { key: 'name', type: 'Text', state: 'mounted' },
    ], 2),
  ],
  [
    "a json-render spec, surface 'spec:' + root",
    report('spec:card', ['Text'], [{ key: 'card', type: 'Text', state: 'mounted' }]),
  ],
  [
    'a json-render root of an unknown type, children hidden',
    report('spec:mystery', ['Text'], [
      { key: 'mystery', type: 'Mystery', state: 'unresolved' },
      { key: 'a', type: 'Text', state: 'hidden' },
      { key: 'b', type: 'Text', state: 'hidden' },
    ]),
  ],
  [
    'visible:false and children of hidden or fallback parents',
    report('spec:root', ['Box', 'Text', 'Nested'], [
      { key: 'root', type: 'Box', state: 'mounted' },
      { key: 'gone', type: 'Box', state: 'hidden' },
      { key: 'g1', type: 'Text', state: 'hidden' },
      { key: 'waiting', type: 'Text', state: 'fallback' },
      { key: 'w1', type: 'Text', state: 'hidden' },
    ]),
  ],
  [
    'unreferenced elements after the tree, in spec order',
    report('spec:root', ['Box', 'Text', 'Nested'], [
      { key: 'root', type: 'Box', state: 'mounted' },
      { key: 'a', type: 'Mystery', state: 'unresolved' },
      { key: 'a1', type: 'Text', state: 'hidden' },
      { key: 'b', type: 'Text', state: 'mounted' },
      { key: 'orphan', type: 'Text', state: 'hidden' },
    ]),
  ],
  [
    'the bounds test: the first 2,000 elements and 500 registry names',
    report(
      'big',
      Array.from({ length: MAX_RENDER_REGISTRY }, (_, i) => `T${String(i)}`),
      Array.from({ length: MAX_RENDER_ELEMENTS }, (_, i) => ({ key: `e${String(i)}`, type: 'T0', state: 'mounted' as const })),
    ),
  ],
  [
    'names that did not fit dropped, the rest kept',
    report('s', ['A'], [{ key: 'a', type: 'A', state: 'mounted' }]),
  ],
  [
    'a surface id at the 128-character limit',
    report('s'.repeat(MAX_RENDER_NAME_LENGTH), ['T0'], [{ key: 'e0', type: 'T0', state: 'mounted' }]),
  ],
  ['a surface whose every element was dropped', report('s', [], [])],
];

describe('Threadplane render reports (cacheplane/threadplane#1215)', () => {
  it('have exactly the key set Threadplane’s spec pins', () => {
    for (const [, shape] of SHAPES) expect(Object.keys(shape).sort()).toEqual(THREADPLANE_REPORT_KEYS);
  });

  it.each(SHAPES)('validate: %s', (_label, shape) => {
    expect(isRenderReport(shape)).toBe(true);
    // The copy every boundary forwards is the same report, and still valid.
    const copy = cloneRenderReport(shape);
    expect(copy).toEqual(shape);
    expect(isRenderReport(copy)).toBe(true);
  });

  it.each(SHAPES)('are never mistaken for a signals report: %s', (_label, shape) => {
    expect(isThreadplaneReport(shape)).toBe(false);
  });

  it('what the emitter never sends — a name it would have dropped — is refused', () => {
    const long = 'x'.repeat(MAX_RENDER_NAME_LENGTH + 1);
    expect(isRenderReport(report(long, [], []))).toBe(false);
    expect(isRenderReport(report('s', ['A', long], []))).toBe(false);
    expect(isRenderReport(report('s', [], [{ key: long, type: 'A', state: 'hidden' }]))).toBe(false);
    expect(isRenderReport(report('', [], []))).toBe(false);
  });
});
