import { makeIssue } from '../../model/types';
import { applyPatch } from '../../state/json-patch';
import type { ValidatorRule } from '../types';

/**
 * Render the operation that failed. `PatchResult.op` is `unknown` on the failure branch —
 * a patch arrives off the wire, so the failing entry may be a bare string, an object with
 * no `op` key, or an `add` missing its `value`. Only a well-formed `{op, path}` pair is
 * rendered as `add /b`; anything else is printed verbatim as JSON, and `path` is left off
 * the issue. Without the narrowing this printed `"undefined undefined"`.
 */
function describeOp(op: unknown): { text: string; path?: string } {
  if (typeof op === 'object' && op !== null) {
    const fields = op as Record<string, unknown>;
    const name = fields.op;
    const path = fields.path;
    if (typeof name === 'string' && typeof path === 'string') {
      return { text: `${name} ${path}`, path };
    }
  }
  return { text: `unrecognized op ${JSON.stringify(op)}` };
}

export const statePatchFailedRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'STATE_DELTA') return [];
  if (!Array.isArray(event.delta)) return [];

  // `.at(-1)` rather than `frames[frames.length - 1]`: the latter is
  // `StateFrame | undefined` under `noUncheckedIndexedAccess` and does not compile.
  // `value` is on both arms of the union, so no `kind` narrowing is needed here.
  const current = state.run.stateTimeline.at(-1)?.value;
  // `applyPatch` takes `readonly unknown[]` (Task 8), so the ops go in uncast.
  const result = applyPatch(current, event.delta);
  if (result.ok) return [];

  const failing = describeOp(result.op);
  return [
    makeIssue(
      'state-patch-failed',
      `STATE_DELTA op ${result.opIndex} (${failing.text}) failed: ${result.reason}`,
      record.seq,
      { runId: state.run.runId, path: failing.path, opIndex: result.opIndex },
    ),
  ];
};

export const deltaBeforeSnapshotRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'STATE_DELTA') return [];
  if (state.sawSnapshot) return [];
  if (state.run.stateTimeline.length > 0) return [];
  return [
    makeIssue(
      'delta-before-snapshot',
      'STATE_DELTA arrived before any STATE_SNAPSHOT',
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};
