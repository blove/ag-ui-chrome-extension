import { describe, it, expect } from 'vitest';
import { createStateTimeline } from './timeline';
import type { PatchOp } from '../model/types';

describe('createStateTimeline — empty', () => {
  it('starts with no frames', () => {
    const timeline = createStateTimeline();
    expect(timeline.frames()).toEqual([]);
  });

  it('reports current() as undefined before any snapshot', () => {
    const timeline = createStateTimeline();
    expect(timeline.current()).toBeUndefined();
  });

  it('reports sawSnapshot() as false before any snapshot', () => {
    const timeline = createStateTimeline();
    expect(timeline.sawSnapshot()).toBe(false);
  });
});

describe('createStateTimeline — applySnapshot', () => {
  it('returns a snapshot frame carrying the value', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applySnapshot(1, 100, { count: 0 });
    expect(frame).toEqual({ seq: 1, tMs: 100, kind: 'snapshot', value: { count: 0 } });
  });

  it('appends the returned frame object itself to frames()', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applySnapshot(1, 100, { count: 0 });
    expect(timeline.frames()).toHaveLength(1);
    expect(timeline.frames()[0]).toBe(frame);
  });

  it('makes the snapshot the current value and flips sawSnapshot()', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    expect(timeline.current()).toEqual({ count: 0 });
    expect(timeline.sawSnapshot()).toBe(true);
  });

  it('replaces the whole document wholesale, discarding prior keys', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { a: 1, b: 2 });
    timeline.applyDelta(2, 110, [{ op: 'add', path: '/c', value: 3 }]);
    const frame = timeline.applySnapshot(3, 120, { z: 9 });
    expect(frame.value).toEqual({ z: 9 });
    expect(timeline.current()).toEqual({ z: 9 });
    expect(timeline.frames()).toHaveLength(3);
  });

  it('accepts a non-object snapshot value', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, null);
    expect(timeline.current()).toBeNull();
    expect(timeline.sawSnapshot()).toBe(true);
  });
});

describe('createStateTimeline — applyDelta success', () => {
  it('applies the patch to the previous frame value and retains the patch', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const ops: PatchOp[] = [{ op: 'replace', path: '/count', value: 1 }];

    const frame = timeline.applyDelta(2, 150, ops);

    expect(frame).toEqual({
      seq: 2,
      tMs: 150,
      kind: 'delta',
      value: { count: 1 },
      patch: ops,
    });
    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.failure).toBeUndefined();
    expect(timeline.current()).toEqual({ count: 1 });
  });

  it('appends the returned frame object itself to frames()', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const frame = timeline.applyDelta(2, 150, [{ op: 'replace', path: '/count', value: 1 }]);
    expect(timeline.frames()[1]).toBe(frame);
  });

  it('chains successive deltas onto the previous frame value', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { items: [] });
    timeline.applyDelta(2, 110, [{ op: 'add', path: '/items/-', value: 'a' }]);
    timeline.applyDelta(3, 120, [{ op: 'add', path: '/items/-', value: 'b' }]);

    expect(timeline.current()).toEqual({ items: ['a', 'b'] });
    expect(timeline.frames().map((f) => f.value)).toEqual([
      { items: [] },
      { items: ['a'] },
      { items: ['a', 'b'] },
    ]);
  });

  it('does not mutate the snapshot frame value when a later delta applies', () => {
    const timeline = createStateTimeline();
    const snapshot = timeline.applySnapshot(1, 100, { items: ['a'] });
    timeline.applyDelta(2, 110, [{ op: 'add', path: '/items/-', value: 'b' }]);
    expect(snapshot.value).toEqual({ items: ['a'] });
  });
});

describe('createStateTimeline — applyDelta failure', () => {
  it('records the failing opIndex and reason on the frame', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const ops: PatchOp[] = [
      { op: 'replace', path: '/count', value: 1 },
      { op: 'remove', path: '/missing' },
    ];

    const frame = timeline.applyDelta(2, 150, ops);

    expect(frame.kind).toBe('delta');
    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.failure).toEqual({ opIndex: 1, reason: 'path-not-found' });
    expect(frame.patch).toBe(ops);
  });

  it('holds the frame value at the previous frame value so state does not advance', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });

    const frame = timeline.applyDelta(2, 150, [
      { op: 'replace', path: '/count', value: 1 },
      { op: 'remove', path: '/missing' },
    ]);

    expect(frame.value).toEqual({ count: 0 });
    expect(timeline.current()).toEqual({ count: 0 });
  });

  it('still appends the failed frame so the scrubber can mark it', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const frame = timeline.applyDelta(2, 150, [{ op: 'remove', path: '/missing' }]);

    expect(timeline.frames()).toHaveLength(2);
    const stored = timeline.frames()[1];
    expect(stored).toBe(frame);
    if (stored?.kind !== 'delta') throw new Error('expected a delta frame');
    expect(stored.failure).toEqual({ opIndex: 0, reason: 'path-not-found' });
  });

  it('lets a subsequent delta apply against the held value', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    timeline.applyDelta(2, 150, [{ op: 'remove', path: '/missing' }]);
    const frame = timeline.applyDelta(3, 160, [{ op: 'replace', path: '/count', value: 7 }]);

    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.failure).toBeUndefined();
    expect(frame.value).toEqual({ count: 7 });
    expect(timeline.current()).toEqual({ count: 7 });
  });

  it('records test-failed with its opIndex', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const frame = timeline.applyDelta(2, 150, [
      { op: 'add', path: '/a', value: 1 },
      { op: 'add', path: '/b', value: 2 },
      { op: 'test', path: '/count', value: 99 },
    ]);
    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.failure).toEqual({ opIndex: 2, reason: 'test-failed' });
    expect(frame.value).toEqual({ count: 0 });
  });
});

describe('createStateTimeline — delta before any snapshot', () => {
  it('does not throw and still produces a frame', () => {
    const timeline = createStateTimeline();
    const ops: PatchOp[] = [{ op: 'add', path: '/a', value: 1 }];

    const frame = timeline.applyDelta(1, 100, ops);

    expect(frame.kind).toBe('delta');
    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.seq).toBe(1);
    expect(frame.patch).toBe(ops);
    expect(timeline.frames()).toHaveLength(1);
    expect(timeline.frames()[0]).toBe(frame);
  });

  it('records the patch failure against the undefined document', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applyDelta(1, 100, [{ op: 'add', path: '/a', value: 1 }]);
    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.failure).toEqual({ opIndex: 0, reason: 'parent-not-found' });
    expect(frame.value).toBeUndefined();
  });

  it('leaves sawSnapshot() false because the warning belongs to the validator', () => {
    const timeline = createStateTimeline();
    timeline.applyDelta(1, 100, [{ op: 'add', path: '/a', value: 1 }]);
    expect(timeline.sawSnapshot()).toBe(false);
  });

  it('applies a whole-document delta even with no prior snapshot', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applyDelta(1, 100, [{ op: 'add', path: '', value: { a: 1 } }]);
    if (frame.kind !== 'delta') throw new Error('expected a delta frame');
    expect(frame.failure).toBeUndefined();
    expect(frame.value).toEqual({ a: 1 });
    expect(timeline.current()).toEqual({ a: 1 });
    expect(timeline.sawSnapshot()).toBe(false);
  });
});

describe('createStateTimeline — frame ordering', () => {
  it('accumulates frames in call order with their seq, tMs and kind', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { n: 0 });
    timeline.applyDelta(2, 110, [{ op: 'replace', path: '/n', value: 1 }]);
    timeline.applyDelta(3, 130, [{ op: 'remove', path: '/gone' }]);
    timeline.applySnapshot(4, 160, { n: 5 });

    expect(timeline.frames().map((f) => [f.seq, f.tMs, f.kind])).toEqual([
      [1, 100, 'snapshot'],
      [2, 110, 'delta'],
      [3, 130, 'delta'],
      [4, 160, 'snapshot'],
    ]);
  });

  // A snapshot frame cannot carry `patch` or `failure`: `StateFrame`'s snapshot arm has
  // neither property, so the invariant is enforced by the compiler rather than by a
  // runtime assertion. Asserting `frame.patch === undefined` here would be a TS2339.

  it('keeps separate timelines independent', () => {
    const a = createStateTimeline();
    const b = createStateTimeline();
    a.applySnapshot(1, 100, { n: 1 });
    expect(b.frames()).toEqual([]);
    expect(b.current()).toBeUndefined();
  });
});
