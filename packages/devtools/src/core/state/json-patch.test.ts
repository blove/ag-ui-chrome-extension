import { describe, it, expect } from 'vitest';
import { applyPatch, parsePointer } from './json-patch';
import type { PatchOp } from '../model/types';

describe('parsePointer', () => {
  it('returns an empty token list for the whole-document pointer', () => {
    expect(parsePointer('')).toEqual([]);
  });

  it('splits a pointer on slashes, dropping the leading slash', () => {
    expect(parsePointer('/a/b')).toEqual(['a', 'b']);
  });

  it('parses a single-token pointer', () => {
    expect(parsePointer('/a')).toEqual(['a']);
  });

  it('preserves numeric tokens as strings', () => {
    expect(parsePointer('/items/0/id')).toEqual(['items', '0', 'id']);
  });

  it('preserves empty tokens', () => {
    expect(parsePointer('/')).toEqual(['']);
    expect(parsePointer('/a//b')).toEqual(['a', '', 'b']);
  });

  it('unescapes ~1 to a slash', () => {
    expect(parsePointer('/a~1b')).toEqual(['a/b']);
  });

  it('unescapes ~0 to a tilde', () => {
    expect(parsePointer('/a~0b')).toEqual(['a~b']);
  });

  it('unescapes ~1 before ~0 so that ~01 becomes ~1 and not a slash', () => {
    expect(parsePointer('/~01')).toEqual(['~1']);
  });

  it('unescapes both escapes in the same token', () => {
    expect(parsePointer('/m~0n~1o')).toEqual(['m~n/o']);
  });

  it('returns null for a pointer that is neither empty nor slash-prefixed', () => {
    expect(parsePointer('a/b')).toBeNull();
    expect(parsePointer('#/a')).toBeNull();
    expect(parsePointer(' /a')).toBeNull();
  });
});

describe('applyPatch — add', () => {
  it('adds a new key to an object', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { a: 1, b: 2 } });
  });

  it('overwrites an existing key', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/a', value: 9 }]);
    expect(result).toEqual({ ok: true, value: { a: 9 } });
  });

  it('inserts into an array at an index', () => {
    const doc = { list: ['a', 'c'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/1', value: 'b' }]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'b', 'c'] } });
  });

  it('appends to an array with the - token', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/-', value: 'b' }]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'b'] } });
  });

  it('allows an index equal to the array length as an append', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/1', value: 'b' }]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'b'] } });
  });

  it('fails with index-out-of-bounds past the end of an array', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/3', value: 'b' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/list/3', value: 'b' },
      reason: 'index-out-of-bounds',
    });
  });

  it('fails with invalid-path for a non-numeric array token', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/x', value: 'b' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/list/x', value: 'b' },
      reason: 'invalid-path',
    });
  });

  it('fails with parent-not-found when an intermediate container is missing', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/nope/b', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/nope/b', value: 2 },
      reason: 'parent-not-found',
    });
  });

  it('fails with parent-not-found when an intermediate value is a scalar', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/a/b', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/a/b', value: 2 },
      reason: 'parent-not-found',
    });
  });

  it('replaces the whole document when the path is empty', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'add', path: '', value: { b: 2 } }]);
    expect(result).toEqual({ ok: true, value: { b: 2 } });
  });

  it('fails with invalid-path for a malformed pointer', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'add', path: 'a', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: 'a', value: 2 },
      reason: 'invalid-path',
    });
  });
});

describe('applyPatch — remove', () => {
  it('removes an object key', () => {
    const result = applyPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }]);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('removes an array element and closes the gap', () => {
    const result = applyPatch({ list: ['a', 'b', 'c'] }, [
      { op: 'remove', path: '/list/1' },
    ]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'c'] } });
  });

  it('fails with path-not-found for a missing object key', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'remove', path: '/b' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '/b' },
      reason: 'path-not-found',
    });
  });

  it('fails with index-out-of-bounds for a missing array index', () => {
    const result = applyPatch({ list: ['a'] }, [{ op: 'remove', path: '/list/1' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '/list/1' },
      reason: 'index-out-of-bounds',
    });
  });

  it('fails with invalid-path when removing the whole document', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'remove', path: '' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '' },
      reason: 'invalid-path',
    });
  });

  it('fails with invalid-path when removing the array append token', () => {
    const result = applyPatch({ list: ['a'] }, [{ op: 'remove', path: '/list/-' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '/list/-' },
      reason: 'invalid-path',
    });
  });
});

describe('applyPatch — replace', () => {
  it('replaces an existing object key', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { a: 2 } });
  });

  it('replaces an existing array element in place', () => {
    const result = applyPatch({ list: ['a', 'b'] }, [
      { op: 'replace', path: '/list/0', value: 'z' },
    ]);
    expect(result).toEqual({ ok: true, value: { list: ['z', 'b'] } });
  });

  it('fails with path-not-found for a key that does not exist', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'replace', path: '/b', value: 2 },
      reason: 'path-not-found',
    });
  });

  it('fails with index-out-of-bounds for an index that does not exist', () => {
    const result = applyPatch({ list: ['a'] }, [
      { op: 'replace', path: '/list/2', value: 'z' },
    ]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'replace', path: '/list/2', value: 'z' },
      reason: 'index-out-of-bounds',
    });
  });

  it('replaces the whole document when the path is empty', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: [1, 2] }]);
    expect(result).toEqual({ ok: true, value: [1, 2] });
  });
});

describe('applyPatch — deep nesting and escaped pointers', () => {
  it('replaces a deeply nested leaf', () => {
    const doc = { a: { b: { c: { d: [10, 20, 30] } } } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/a/b/c/d/2', value: 99 }]);
    expect(result).toEqual({ ok: true, value: { a: { b: { c: { d: [10, 20, 99] } } } } });
  });

  it('resolves escaped keys through the pointer', () => {
    const doc = { 'a/b': { 'c~d': 1 } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/a~1b/c~0d', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { 'a/b': { 'c~d': 2 } } });
  });

  it('resolves an empty-string key', () => {
    const doc: Record<string, unknown> = { '': 1 };
    const result = applyPatch(doc, [{ op: 'replace', path: '/', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { '': 2 } });
  });
});

describe('applyPatch — immutability', () => {
  it('never mutates the input document', () => {
    const doc = { a: { b: [1, 2] }, keep: { x: 1 } };
    const snapshot = JSON.parse(JSON.stringify(doc)) as unknown;

    const result = applyPatch(doc, [
      { op: 'add', path: '/a/b/-', value: 3 },
      { op: 'add', path: '/c', value: true },
      { op: 'remove', path: '/a/b/0' },
    ]);

    expect(result).toEqual({ ok: true, value: { a: { b: [2, 3] }, keep: { x: 1 }, c: true } });
    expect(doc).toEqual(snapshot);
  });

  it('shares untouched subtrees with the input document', () => {
    const doc = { touched: { n: 1 }, keep: { x: 1 } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/touched/n', value: 2 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const next = result.value as { touched: unknown; keep: unknown };
    expect(next.keep).toBe(doc.keep);
    expect(next.touched).not.toBe(doc.touched);
  });

  it('returns the original document unchanged for an empty operation list', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, []);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toBe(doc);
  });

  it('does not mutate the document when a later operation fails', () => {
    const doc = { a: 1 };
    const ops: PatchOp[] = [
      { op: 'add', path: '/b', value: 2 },
      { op: 'remove', path: '/nope' },
    ];
    const result = applyPatch(doc, ops);
    expect(result.ok).toBe(false);
    expect(doc).toEqual({ a: 1 });
  });
});
