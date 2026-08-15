/**
 * The State tab's view of a run's `stateTimeline` (design decisions S1–S3).
 *
 * Pure and DOM-free, so the two things that carry the tab's whole claim — WHERE on the scrubber
 * state broke, and WHICH op inside a delta failed — are testable without rendering anything.
 *
 * Nothing here recomputes state. `core/state/timeline` already applied every patch and recorded
 * the outcome on the frame; this module only positions what it recorded.
 */
import type { PatchFailure, StateFrame } from '../../../core/model/types';

/**
 * One position on the scrubber.
 *
 * `failed` is the S3 field. It is read off `frame.failure`, which the timeline sets on the frame
 * the failing delta produced — so the mark lands where the failure happened rather than being
 * summarized at the end, which is the difference between seeing when state broke and scrubbing
 * to find out.
 */
export interface FrameMark {
  index: number;
  seq: number;
  tMs: number;
  kind: StateFrame['kind'];
  failed: boolean;
  /** Set exactly when `failed` is true. */
  reason?: PatchFailure;
}

export function frameMarks(frames: readonly StateFrame[]): FrameMark[] {
  return frames.map((frame, index) => {
    const failure = frame.kind === 'delta' ? frame.failure : undefined;
    const mark: FrameMark = {
      index,
      seq: frame.seq,
      tMs: frame.tMs,
      kind: frame.kind,
      failed: failure !== undefined,
    };
    if (failure !== undefined) mark.reason = failure.reason;
    return mark;
  });
}

/**
 * Where the scrubber sits, given what the reader asked for.
 *
 * `null` requested means the reader has not scrubbed: the position is the LAST frame, because
 * §9.3 asks for the current reconstructed state first and the history is what the scrubber is
 * for. It also means a live run follows itself as frames arrive, rather than pinning the reader
 * to a state the run left several patches ago.
 *
 * A requested position is clamped rather than rejected. It can outlive the frames it indexed —
 * a navigation clears the capture, an import replaces it — and a scrubber that rendered nothing
 * rather than the nearest real frame would look like the tab had broken.
 */
export function resolveIndex(frames: readonly StateFrame[], requested: number | null): number | null {
  const last = frames.length - 1;
  if (last < 0) return null;
  if (requested === null) return last;
  return Math.min(Math.max(requested, 0), last);
}

/**
 * One operation of a delta's patch, positioned (S2).
 *
 * Every field is optional-by-shape rather than assumed, because `StateFrame.patch` is typed
 * `PatchOp[]` by an ASSERTION at the wire boundary (`run-builder.asPatchOps`) and not by any
 * check: the entries are whatever the stream sent. An entry that is not an operation at all is
 * exactly the one an `invalid-op` failure is about, so it is rendered rather than dropped.
 */
export interface OpView {
  index: number;
  /** The `op` name as it arrived. Absent when the entry carried none. */
  name?: string;
  /** The JSON Pointer as it arrived. Absent when the entry carried none. */
  path?: string;
  /** The source pointer of a `move` or `copy`. */
  from?: string;
  /**
   * Whether the entry carried a `value` MEMBER — not whether that member is defined. RFC 6902
   * makes `{"value": null}` a legal patch and `applyPatch` applies it, so folding the two
   * together would draw a legal op as a broken one.
   */
  hasValue: boolean;
  value: unknown;
  /** The entry exactly as it arrived, which is the evidence when it is not an operation. */
  raw: unknown;
  /** True when the entry has no string `op` and `path` — it cannot be drawn as an operation. */
  malformed: boolean;
  failed: boolean;
  /** Set exactly when `failed` is true. */
  reason?: PatchFailure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The ops a frame carried, with the failing one marked at `failure.opIndex`.
 *
 * A snapshot carries no patch — that is structural in the `StateFrame` union — so it yields
 * nothing rather than an empty-looking patch section.
 */
export function opViews(frame: StateFrame): OpView[] {
  if (frame.kind !== 'delta') return [];
  const failure = frame.failure;

  return frame.patch.map((op, index): OpView => {
    const raw: unknown = op;
    const record = isRecord(raw) ? raw : undefined;
    const name = record === undefined ? undefined : str(record.op);
    const path = record === undefined ? undefined : str(record.path);
    const from = record === undefined ? undefined : str(record.from);

    const view: OpView = {
      index,
      hasValue: record !== undefined && Object.prototype.hasOwnProperty.call(record, 'value'),
      value: record?.value,
      raw,
      malformed: name === undefined || path === undefined,
      failed: failure !== undefined && failure.opIndex === index,
    };
    if (name !== undefined) view.name = name;
    if (path !== undefined) view.path = path;
    if (from !== undefined) view.from = from;
    if (view.failed && failure !== undefined) view.reason = failure.reason;
    return view;
  });
}

/**
 * What each `PatchFailure` means, in words.
 *
 * S3 marks a failure with colour, and a colour is not a claim: every mark this tab draws is
 * accompanied by one of these, in its accessible name as well as on screen.
 */
export const FAILURE_TEXT: Record<PatchFailure, string> = {
  'path-not-found': 'no value at that path to change',
  'parent-not-found': 'the parent of that path does not exist',
  'invalid-path': 'the path is not a valid JSON Pointer for this operation',
  'invalid-op': 'this is not a well-formed JSON Patch operation',
  'test-failed': 'the value at that path did not match what the test expected',
  'index-out-of-bounds': 'the array index is past the end of the array',
};
