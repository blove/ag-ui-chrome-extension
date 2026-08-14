import { describe, it, expect } from 'vitest';
import { parsePointer } from './json-patch';

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
