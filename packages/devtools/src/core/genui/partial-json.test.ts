import { describe, expect, it } from 'vitest';
import { parsePartialJson } from './partial-json';

describe('parsePartialJson', () => {
  it('parses complete JSON as complete', () => {
    expect(parsePartialJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] }, complete: true, cutDepth: 0 });
  });

  it('closes a truncated prefix at its last complete value', () => {
    expect(parsePartialJson('{"a":1,"b":')).toEqual({ ok: true, value: { a: 1 }, complete: false, cutDepth: 1 });
    expect(parsePartialJson('{"a":[{"x":"y"},{"x":"z')).toEqual({
      ok: true,
      value: { a: [{ x: 'y' }, {}] },
      complete: false,
      cutDepth: 3,
    });
  });

  it('reports how deep the cut was, so a caller can tell a closed element from a cut-open one', () => {
    // The first element closed on the wire: the cut sits inside the array, at depth 2.
    expect(parsePartialJson('{"a":[{"x":1}')).toMatchObject({ value: { a: [{ x: 1 }] }, cutDepth: 2 });
    expect(parsePartialJson('{"a":[{"x":1},')).toMatchObject({ value: { a: [{ x: 1 }] }, cutDepth: 2 });
  });

  it('never counts a number or literal at the very end as finished', () => {
    expect(parsePartialJson('{"a":1,"b":12')).toMatchObject({ value: { a: 1 } });
    expect(parsePartialJson('{"a":1,"b":tru')).toMatchObject({ value: { a: 1 } });
  });

  it('holds nothing yet for an empty or just-opened string', () => {
    expect(parsePartialJson('')).toEqual({ ok: true, value: undefined, complete: false, cutDepth: 0 });
    expect(parsePartialJson('"abc')).toEqual({ ok: true, value: undefined, complete: false, cutDepth: 0 });
  });

  it('rejects text that is no JSON prefix', () => {
    expect(parsePartialJson('{"a":1}}')).toEqual({ ok: false });
    expect(parsePartialJson('{a:1')).toEqual({ ok: false });
    expect(parsePartialJson('hello')).toEqual({ ok: false });
  });

  it('stays linear on a deeply nested prefix (a hostile a2ui-partial)', () => {
    // Each opener used to snapshot the whole open stack: quadratic in the nesting depth.
    const depth = 200_000;
    const started = performance.now();
    const parsed = parsePartialJson('['.repeat(depth));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(parsed).toMatchObject({ ok: true, complete: false, cutDepth: depth });
  });
});
