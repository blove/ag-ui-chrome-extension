import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  cloneRenderReport,
  isRenderReport,
  MAX_RENDER_ELEMENTS,
  MAX_RENDER_NAME_LENGTH,
  MAX_RENDER_REGISTRY,
  MAX_RENDER_RING_CHARS,
  renderReportChars,
  renderRingStart,
  type RenderDevtoolsReport,
} from './render-report';
import { maxSizeRenderReport } from '../../test/render-reports';

const REPORT: RenderDevtoolsReport = {
  v: 1,
  kind: 'render',
  surface: 's1',
  seq: 4,
  registry: ['Column', 'Text'],
  elements: [
    { key: 'root', type: 'Column', state: 'mounted' },
    { key: 'mystery', type: 'Mystery', state: 'unresolved' },
    { key: 'inner', type: 'Text', state: 'hidden' },
    { key: 'name', type: 'Text', state: 'fallback' },
  ],
  tMs: 812.25,
};

const with_ = (overrides: Record<string, unknown>): unknown => ({ ...REPORT, ...overrides });

describe('isRenderReport', () => {
  it('accepts the U4 shape, incl. an empty registry and no elements', () => {
    expect(isRenderReport(REPORT)).toBe(true);
    expect(isRenderReport(with_({ registry: [], elements: [] }))).toBe(true);
    expect(isRenderReport(with_({ surface: 'spec:card' }))).toBe(true);
    expect(isRenderReport(with_({ tMs: 0 }))).toBe(true);
  });

  it('accepts the bounds exactly and refuses one past them', () => {
    const name = 'x'.repeat(MAX_RENDER_NAME_LENGTH);
    const long = 'x'.repeat(MAX_RENDER_NAME_LENGTH + 1);
    expect(isRenderReport(with_({ surface: name }))).toBe(true);
    expect(isRenderReport(with_({ surface: long }))).toBe(false);
    expect(isRenderReport(with_({ registry: [name] }))).toBe(true);
    expect(isRenderReport(with_({ registry: [long] }))).toBe(false);
    expect(isRenderReport(with_({ elements: [{ key: name, type: name, state: 'mounted' }] }))).toBe(true);
    expect(isRenderReport(with_({ elements: [{ key: long, type: 'A', state: 'mounted' }] }))).toBe(false);
    expect(isRenderReport(with_({ elements: [{ key: 'a', type: long, state: 'mounted' }] }))).toBe(false);

    const names = (n: number) => Array.from({ length: n }, (_, i) => `T${String(i)}`);
    expect(isRenderReport(with_({ registry: names(MAX_RENDER_REGISTRY) }))).toBe(true);
    expect(isRenderReport(with_({ registry: names(MAX_RENDER_REGISTRY + 1) }))).toBe(false);
    const elements = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `e${String(i)}`, type: 'T', state: 'mounted' }));
    expect(isRenderReport(with_({ elements: elements(MAX_RENDER_ELEMENTS) }))).toBe(true);
    expect(isRenderReport(with_({ elements: elements(MAX_RENDER_ELEMENTS + 1) }))).toBe(false);
  });

  it.each([
    ['a missing key', Object.fromEntries(Object.entries(REPORT).filter(([key]) => key !== 'tMs'))],
    ['an extra key', with_({ props: { text: 'a prop value must never cross' } })],
    ['a symbol key', Object.assign({ ...REPORT }, { [Symbol('x')]: 1 })],
    ['a non-enumerable extra', Object.defineProperty({ ...REPORT }, 'extra', { value: 1, enumerable: false })],
    ['another version', with_({ v: 2 })],
    ['another kind', with_({ kind: 'signals' })],
    ['an empty surface', with_({ surface: '' })],
    ['a non-string surface', with_({ surface: 7 })],
    ['seq 0', with_({ seq: 0 })],
    ['a fractional seq', with_({ seq: 1.5 })],
    ['an unsafe seq', with_({ seq: 2 ** 60 })],
    ['a NaN tMs', with_({ tMs: Number.NaN })],
    ['an infinite tMs', with_({ tMs: Number.POSITIVE_INFINITY })],
    ['a negative tMs', with_({ tMs: -1 })],
    ['a registry that is not an array', with_({ registry: 'Text' })],
    ['an empty registry name', with_({ registry: [''] })],
    ['a registry name that is not a string', with_({ registry: [1] })],
    ['a registry with a hole', with_({ registry: Object.assign(new Array<unknown>(2), { 1: 'Text' }) })],
    ['elements that are not an array', with_({ elements: {} })],
    ['an element that is not an object', with_({ elements: ['root'] })],
    ['an element that is an array', with_({ elements: [['root', 'Column', 'mounted']] })],
    ['an element with an unknown state', with_({ elements: [{ key: 'a', type: 'A', state: 'visible' }] })],
    ['an element with an extra key', with_({ elements: [{ key: 'a', type: 'A', state: 'mounted', props: {} }] })],
    ['an element with a missing key', with_({ elements: [{ key: 'a', state: 'mounted' }] })],
    ['an element with an empty key', with_({ elements: [{ key: '', type: 'A', state: 'mounted' }] })],
    ['elements with a hole', with_({ elements: Object.assign(new Array<unknown>(2), { 1: { key: 'a', type: 'A', state: 'mounted' } }) })],
    ['an array', [REPORT]],
    ['null', null],
    ['a string', 'render'],
  ])('refuses %s', (_label, value) => {
    expect(isRenderReport(value)).toBe(false);
  });

  it('refuses a key inherited through the prototype, not owned', () => {
    const { tMs, ...rest } = REPORT;
    const inherited = Object.assign(Object.create({ tMs }) as object, rest);
    expect(isRenderReport(inherited)).toBe(false);
  });

  it('refuses an element index supplied by a polluted Array.prototype', () => {
    const elements: unknown[] = [];
    elements.length = 1;
    const proto = Array.prototype as unknown as Record<number, unknown>;
    proto[0] = { key: 'a', type: 'A', state: 'mounted' };
    try {
      expect(isRenderReport(with_({ elements }))).toBe(false);
    } finally {
      delete proto[0];
    }
  });

  it('never throws on a throwing getter or a hostile Proxy', () => {
    const getter = Object.defineProperty({ ...REPORT }, 'elements', {
      enumerable: true,
      get() {
        throw new Error('hostile');
      },
    });
    const proxy = new Proxy({ ...REPORT }, {
      ownKeys() {
        throw new Error('hostile');
      },
    });
    const element = new Proxy({ key: 'a', type: 'A', state: 'mounted' }, {
      get() {
        throw new Error('hostile');
      },
    });
    expect(isRenderReport(getter)).toBe(false);
    expect(isRenderReport(proxy)).toBe(false);
    expect(isRenderReport(with_({ elements: [element] }))).toBe(false);
  });

  it('rejects an array claiming a huge length without walking it', () => {
    const huge = new Proxy([] as unknown[], {
      get(target, key) {
        if (key === 'length') return 1e9;
        return Reflect.get(target, key) as unknown;
      },
    });
    expect(isRenderReport(with_({ elements: huge }))).toBe(false);
    expect(isRenderReport(with_({ registry: huge }))).toBe(false);
  });

  it('accepts a report built in another realm (a structured clone, a subframe)', () => {
    const foreign = runInNewContext(`(${JSON.stringify(REPORT)})`) as unknown;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(isRenderReport(foreign)).toBe(true);
  });
});

describe('cloneRenderReport', () => {
  it('copies the contract fields into plain data, nothing riding along', () => {
    const elements = REPORT.elements.map((element) => ({ ...element }));
    const registry = Object.assign([...REPORT.registry], { smuggled: 'value' });
    const source = { ...REPORT, registry, elements };
    const copy = cloneRenderReport(source);
    expect(copy).toEqual(REPORT);
    expect(copy.registry).not.toBe(registry);
    expect(copy.elements).not.toBe(elements);
    expect(copy.elements[0]).not.toBe(elements[0]);
    expect(JSON.stringify(copy)).not.toContain('smuggled');
  });

  it('bounds the copy by the contract, not a re-read length, so the re-check refuses it', () => {
    let reads = 0;
    const growing = new Proxy([...REPORT.elements] as unknown[], {
      get(target, key) {
        if (key === 'length') {
          reads += 1;
          return reads === 1 ? target.length : 1e9;
        }
        return Reflect.get(target, key) as unknown;
      },
    });
    const detail = { ...REPORT, elements: growing as RenderDevtoolsReport['elements'] };
    // The check reads the honest length; the copy then reads the hostile one.
    expect(isRenderReport(detail)).toBe(true);
    const copy = cloneRenderReport(detail);
    expect(copy.elements.length).toBeLessThanOrEqual(MAX_RENDER_ELEMENTS + 1);
    expect(isRenderReport(copy)).toBe(false);
  });

  it('reads each element field once: a getter that changes its answer cannot pass the re-check', () => {
    let reads = 0;
    const element = Object.defineProperty({ key: 'a', type: 'A' }, 'state', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'mounted' : 'value-of-a-secret-prop';
      },
    });
    const detail = with_({ elements: [element] });
    expect(isRenderReport(detail)).toBe(true);
    const copy = cloneRenderReport(detail as RenderDevtoolsReport);
    expect(isRenderReport(copy)).toBe(false);
  });
});

describe('the render ring’s size bound', () => {
  it('measures a report at no less than its serialized length', () => {
    for (const report of [REPORT, maxSizeRenderReport(1)]) {
      expect(renderReportChars(report)).toBeGreaterThanOrEqual(JSON.stringify(report).length);
      expect(renderReportChars(report)).toBeLessThan(JSON.stringify(report).length * 1.5);
    }
  });

  it('keeps the newest reports that fit both the count and the size, and always the newest one', () => {
    const big = Array.from({ length: 50 }, (_, i) => maxSizeRenderReport(i + 1));
    const start = renderRingStart(big, 500, MAX_RENDER_RING_CHARS);
    const kept = big.slice(start);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    expect(kept.at(-1)?.seq).toBe(50);
    expect(kept.reduce((total, report) => total + renderReportChars(report), 0)).toBeLessThanOrEqual(MAX_RENDER_RING_CHARS);
    // The count bound still applies to small reports, and one report over the budget is still kept.
    expect(renderRingStart(Array.from({ length: 503 }, () => REPORT), 500, MAX_RENDER_RING_CHARS)).toBe(3);
    expect(renderRingStart([maxSizeRenderReport(1)], 500, 10)).toBe(0);
    expect(renderRingStart([], 500, 10)).toBe(0);
  });
});
