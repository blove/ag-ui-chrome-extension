import { describe, it, expect } from 'vitest';
import type { PatchOp, StateFrame } from '../../../core/model/types';
import { FAILURE_TEXT, frameMarks, opViews, resolveIndex } from './frames';

function snapshot(seq: number, value: unknown): StateFrame {
  return { kind: 'snapshot', seq, tMs: seq * 10, value };
}

function delta(seq: number, patch: PatchOp[], value: unknown): StateFrame {
  return { kind: 'delta', seq, tMs: seq * 10, value, patch };
}

function failed(seq: number, patch: PatchOp[], value: unknown, opIndex: number): StateFrame {
  return {
    kind: 'delta',
    seq,
    tMs: seq * 10,
    value,
    patch,
    failure: { opIndex, reason: 'parent-not-found' },
  };
}

describe('frameMarks — S3: where on the scrubber state broke', () => {
  it('marks one position per frame, in timeline order', () => {
    const marks = frameMarks([
      snapshot(1, { a: 1 }),
      delta(2, [{ op: 'replace', path: '/a', value: 2 }], { a: 2 }),
    ]);

    expect(marks.map((mark) => mark.index)).toEqual([0, 1]);
    expect(marks.map((mark) => mark.seq)).toEqual([1, 2]);
    expect(marks.map((mark) => mark.kind)).toEqual(['snapshot', 'delta']);
  });

  it('marks the failed frame at its own position, not at the end', () => {
    const marks = frameMarks([
      snapshot(1, { a: 1 }),
      failed(2, [{ op: 'add', path: '/missing/child', value: 42 }], { a: 1 }, 0),
      delta(3, [{ op: 'replace', path: '/a', value: 2 }], { a: 2 }),
    ]);

    // The whole point of S3: the position is the answer. A failure reported anywhere but
    // where it happened is a failure the reader still has to scrub for.
    expect(marks.map((mark) => mark.failed)).toEqual([false, true, false]);
    expect(marks[1]?.reason).toBe('parent-not-found');
  });

  it('carries no reason for a frame that applied', () => {
    const [mark] = frameMarks([snapshot(1, { a: 1 })]);

    expect(mark?.failed).toBe(false);
    expect(mark?.reason).toBeUndefined();
  });

  it('is empty for a run that recorded no state at all', () => {
    expect(frameMarks([])).toEqual([]);
  });
});

describe('resolveIndex — where the scrubber sits', () => {
  const frames = [snapshot(1, { a: 1 }), delta(2, [], { a: 1 }), delta(3, [], { a: 1 })];

  it('sits on the latest frame until the reader scrubs', () => {
    // §9.3 asks for "current reconstructed state" first; the history is what the scrubber is
    // for. A tab that opened on the first frame would show a state the run left long ago.
    expect(resolveIndex(frames, null)).toBe(2);
  });

  it('honours a requested position', () => {
    expect(resolveIndex(frames, 1)).toBe(1);
  });

  it('clamps a position past the end rather than rendering nothing', () => {
    // Reachable live: the reader scrubs to frame 9, the page navigates, the timeline shortens.
    expect(resolveIndex(frames, 9)).toBe(2);
  });

  it('clamps a negative position', () => {
    expect(resolveIndex(frames, -3)).toBe(0);
  });

  it('has no position at all when there are no frames', () => {
    expect(resolveIndex([], null)).toBeNull();
    expect(resolveIndex([], 0)).toBeNull();
  });
});

describe('opViews — S2: the ops a delta carried, and which one failed', () => {
  it('has nothing to show for a snapshot, which carries no patch', () => {
    expect(opViews(snapshot(1, { a: 1 }))).toEqual([]);
  });

  it('reports each op with its position, name and path', () => {
    const views = opViews(
      delta(
        2,
        [
          { op: 'replace', path: '/counter', value: 2 },
          { op: 'add', path: '/notes/-', value: 'second note' },
        ],
        { counter: 2 },
      ),
    );

    expect(views.map((view) => view.index)).toEqual([0, 1]);
    expect(views.map((view) => view.name)).toEqual(['replace', 'add']);
    expect(views.map((view) => view.path)).toEqual(['/counter', '/notes/-']);
    expect(views[0]?.hasValue).toBe(true);
    expect(views[0]?.value).toBe(2);
  });

  it('marks the op at failure.opIndex and no other', () => {
    const views = opViews(
      failed(
        2,
        [
          { op: 'replace', path: '/counter', value: 2 },
          { op: 'add', path: '/missing/child', value: 42 },
          { op: 'remove', path: '/counter' },
        ],
        { counter: 1 },
        1,
      ),
    );

    expect(views.map((view) => view.failed)).toEqual([false, true, false]);
    expect(views[1]?.reason).toBe('parent-not-found');
    expect(views[0]?.reason).toBeUndefined();
  });

  it('reports a move by the path it came from as well as the one it went to', () => {
    const views = opViews(delta(2, [{ op: 'move', path: '/b', from: '/a' }], { b: 1 }));

    expect(views[0]?.from).toBe('/a');
    expect(views[0]?.hasValue).toBe(false);
  });

  it('distinguishes an op whose value is null from one that carries no value', () => {
    // RFC 6902 makes `{"value": null}` a legal patch, and `applyPatch` applies it. An op view
    // that reported both as "no value" would draw a legal patch as a broken one.
    const views = opViews(
      delta(
        2,
        [
          { op: 'add', path: '/a', value: null },
          { op: 'remove', path: '/b' },
        ],
        {},
      ),
    );

    expect(views.map((view) => view.hasValue)).toEqual([true, false]);
    expect(views[0]?.value).toBeNull();
  });

  it('renders an entry that is not an operation at all rather than dropping it', () => {
    /*
     * `StateFrame.patch` is typed `PatchOp[]`, but the run builder ASSERTS that at the wire
     * boundary (`asPatchOps`) — the entries are whatever arrived. A bare string, or an object
     * with no `op`, reaches here typed as a `PatchOp` and is what `applyPatch` reports as
     * `invalid-op`. Dropping it would hide the very op the failure is about.
     */
    const wire = ['not an op', { path: '/a' }] as unknown as PatchOp[];
    const views = opViews(failed(2, wire, {}, 0));

    expect(views).toHaveLength(2);
    expect(views[0]?.malformed).toBe(true);
    expect(views[0]?.raw).toBe('not an op');
    expect(views[0]?.failed).toBe(true);
    expect(views[1]?.malformed).toBe(true);
    expect(views[1]?.name).toBeUndefined();
    expect(views[1]?.path).toBe('/a');
  });
});

describe('FAILURE_TEXT', () => {
  it('says what went wrong in words, for every reason the patcher can report', () => {
    // A colour is not a claim, and `parent-not-found` is a symbol, not a sentence.
    for (const reason of [
      'path-not-found',
      'parent-not-found',
      'invalid-path',
      'invalid-op',
      'test-failed',
      'index-out-of-bounds',
    ] as const) {
      expect(FAILURE_TEXT[reason].length).toBeGreaterThan(0);
      expect(FAILURE_TEXT[reason]).not.toBe(reason);
    }
  });
});
