import type { PatchOp, StateFrame } from '../model/types';
import { applyPatch } from './json-patch';

export interface StateTimeline {
  applySnapshot(seq: number, tMs: number, value: unknown): StateFrame;
  applyDelta(seq: number, tMs: number, ops: PatchOp[]): StateFrame;
  frames(): StateFrame[];
  current(): unknown;
  sawSnapshot(): boolean;
}

/**
 * Accumulates the STATE_SNAPSHOT / STATE_DELTA history for one run.
 *
 * Every call appends exactly one frame, including a delta whose patch failed: the panel's
 * scrubber needs the failed step to exist so it can be marked in place. Frames are built as
 * members of the `StateFrame` union, so a snapshot frame structurally cannot carry a patch
 * and every delta frame carries the patch that produced it. `value` is the document as it
 * stands AFTER the frame; a failed delta does not advance the state, so its frame repeats
 * the previous frame's value alongside the positioned `failure`. A delta arriving before
 * any snapshot is applied against `undefined` and is not an error here;
 * `delta-before-snapshot` is raised by the validator, not the timeline.
 */
export function createStateTimeline(): StateTimeline {
  const log: StateFrame[] = [];
  let value: unknown = undefined;
  let snapshotSeen = false;

  return {
    // The snapshot is stored by reference, not cloned: this is the hot path and the
    // caller is the run builder, which hands over a freshly decoded payload. A caller
    // that retains and mutates its own snapshot object would retroactively rewrite
    // recorded history, so callers must treat what they pass here as owned by the
    // timeline from that point on.
    applySnapshot(seq, tMs, snapshot) {
      value = snapshot;
      snapshotSeen = true;
      const frame: StateFrame = { seq, tMs, kind: 'snapshot', value: snapshot };
      log.push(frame);
      return frame;
    },

    applyDelta(seq, tMs, ops) {
      const result = applyPatch(value, ops);
      const frame: StateFrame = result.ok
        ? { seq, tMs, kind: 'delta', value: result.value, patch: ops }
        : {
            seq,
            tMs,
            kind: 'delta',
            value,
            patch: ops,
            failure: { opIndex: result.opIndex, reason: result.reason },
          };
      if (result.ok) value = result.value;
      log.push(frame);
      return frame;
    },

    frames() {
      return log.slice();
    },

    current() {
      return value;
    },

    sawSnapshot() {
      return snapshotSeen;
    },
  };
}
