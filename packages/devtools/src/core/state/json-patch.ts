import type { PatchFailure, PatchOp, PatchResult } from '../model/types';

/**
 * Parse an RFC 6901 JSON Pointer into its unescaped reference tokens.
 *
 * Returns `[]` for the whole-document pointer `''`, and `null` for any string that is
 * neither `''` nor slash-prefixed. Escapes are undone in the order mandated by RFC 6901:
 * `~1` -> `/` first, then `~0` -> `~`, so that `~01` decodes to the literal `~1`.
 */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (pointer[0] !== '/') return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.split('~1').join('/').split('~0').join('~'));
}

/** Result of a single operation, before it is positioned within the patch. */
type OpOutcome = { ok: true; value: unknown } | { ok: false; reason: PatchFailure };

/** A terminal mutation applied to the container that owns the final reference token. */
type Terminal =
  | { kind: 'add'; value: unknown }
  | { kind: 'replace'; value: unknown }
  | { kind: 'remove' };

const KNOWN_OPS: ReadonlySet<string> = new Set([
  'add',
  'remove',
  'replace',
  'move',
  'copy',
  'test',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Narrow one untrusted wire operation to a `PatchOp`.
 *
 * A patch arrives as `unknown[]`, so an entry may be a bare string, an object with no `op`
 * key, or a `move` with no `from`. Each is rejected here and reported as `invalid-op` with
 * the raw value carried through untouched. `value` is deliberately not checked: it is
 * typed `unknown`, so an `add` that omits it simply adds `undefined`.
 */
function isPatchOp(op: unknown): op is PatchOp {
  if (!isRecord(op)) return false;
  const name = op.op;
  if (typeof name !== 'string' || !KNOWN_OPS.has(name)) return false;
  if (typeof op.path !== 'string') return false;
  if (name === 'move' || name === 'copy') return typeof op.from === 'string';
  return true;
}

/** Strict RFC 6901 array index: digits only, no sign, no leading zeros. */
function parseIndex(token: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return null;
  return Number(token);
}

function terminalArray(arr: readonly unknown[], token: string, action: Terminal): OpOutcome {
  if (action.kind === 'add') {
    const next = arr.slice();
    if (token === '-') {
      next.push(action.value);
      return { ok: true, value: next };
    }
    const idx = parseIndex(token);
    if (idx === null) return { ok: false, reason: 'invalid-path' };
    if (idx > arr.length) return { ok: false, reason: 'index-out-of-bounds' };
    next.splice(idx, 0, action.value);
    return { ok: true, value: next };
  }

  const idx = parseIndex(token);
  if (idx === null) return { ok: false, reason: 'invalid-path' };
  if (idx >= arr.length) return { ok: false, reason: 'index-out-of-bounds' };
  const next = arr.slice();
  if (action.kind === 'remove') next.splice(idx, 1);
  else next[idx] = action.value;
  return { ok: true, value: next };
}

function terminalObject(
  obj: Record<string, unknown>,
  token: string,
  action: Terminal,
): OpOutcome {
  if (action.kind === 'add') return { ok: true, value: { ...obj, [token]: action.value } };
  if (!hasOwn(obj, token)) return { ok: false, reason: 'path-not-found' };
  if (action.kind === 'replace') return { ok: true, value: { ...obj, [token]: action.value } };
  const next = { ...obj };
  delete next[token];
  return { ok: true, value: next };
}

/**
 * The reference token at `depth`, with the in-range invariant stated instead of assumed.
 *
 * `tokens[depth]` is `string | undefined` under `noUncheckedIndexedAccess`. Every entry into
 * `applyAt` is guarded by a `tokens.length === 0` check and every recursion happens only when
 * `depth !== tokens.length - 1`, so `depth` is always in range — the throw is unreachable. It
 * is written as a throw rather than a `?? ''` default because an empty token is a legal
 * pointer segment (`/a//b` addresses the key `''`): defaulting would turn a broken invariant
 * into a silent read of the wrong key, while this fails loudly at the exact call that broke it.
 */
function tokenAt(tokens: readonly string[], depth: number): string {
  const token = tokens[depth];
  if (token === undefined) {
    throw new Error(`json-patch: token ${depth} out of range (${tokens.length} tokens)`);
  }
  return token;
}

/**
 * Apply `action` at `tokens[depth..]` inside `container`, shallow-copying every container
 * along the mutated path and sharing every untouched subtree with the input.
 */
function applyAt(
  container: unknown,
  tokens: readonly string[],
  depth: number,
  action: Terminal,
): OpOutcome {
  const token = tokenAt(tokens, depth);
  const isLast = depth === tokens.length - 1;

  if (Array.isArray(container)) {
    if (isLast) return terminalArray(container, token, action);
    const idx = parseIndex(token);
    if (idx === null) return { ok: false, reason: 'invalid-path' };
    if (idx >= container.length) return { ok: false, reason: 'index-out-of-bounds' };
    const child = applyAt(container[idx], tokens, depth + 1, action);
    if (!child.ok) return child;
    const next = container.slice();
    next[idx] = child.value;
    return { ok: true, value: next };
  }

  if (isRecord(container)) {
    if (isLast) return terminalObject(container, token, action);
    if (!hasOwn(container, token)) return { ok: false, reason: 'parent-not-found' };
    const child = applyAt(container[token], tokens, depth + 1, action);
    if (!child.ok) return child;
    return { ok: true, value: { ...container, [token]: child.value } };
  }

  return { ok: false, reason: 'parent-not-found' };
}

function applyOne(doc: unknown, op: PatchOp): OpOutcome {
  const tokens = parsePointer(op.path);
  if (tokens === null) return { ok: false, reason: 'invalid-path' };

  switch (op.op) {
    case 'add':
      if (tokens.length === 0) return { ok: true, value: op.value };
      return applyAt(doc, tokens, 0, { kind: 'add', value: op.value });
    case 'replace':
      if (tokens.length === 0) return { ok: true, value: op.value };
      return applyAt(doc, tokens, 0, { kind: 'replace', value: op.value });
    case 'remove':
      if (tokens.length === 0) return { ok: false, reason: 'invalid-path' };
      return applyAt(doc, tokens, 0, { kind: 'remove' });
    default:
      return { ok: false, reason: 'invalid-op' };
  }
}

/**
 * Apply an RFC 6902 patch to `doc` without mutating it.
 *
 * `ops` is `readonly unknown[]` because a patch arrives off the wire: every entry is
 * narrowed by `isPatchOp` before it is dispatched, and an entry that is not a well-formed
 * operation fails as `invalid-op` with the raw value reported back in `op`.
 *
 * Operations are applied in order against the running document. The first failure aborts
 * the patch and reports its position via `opIndex`; no partial value is returned.
 */
export function applyPatch(doc: unknown, ops: readonly unknown[]): PatchResult {
  let current = doc;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!isPatchOp(op)) return { ok: false, opIndex: i, op, reason: 'invalid-op' };
    const outcome = applyOne(current, op);
    if (!outcome.ok) return { ok: false, opIndex: i, op, reason: outcome.reason };
    current = outcome.value;
  }
  return { ok: true, value: current };
}
