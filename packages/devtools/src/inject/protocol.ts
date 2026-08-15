/**
 * The MAIN-world → ISOLATED-world wire protocol (design §3, requirements §11).
 *
 * Both halves of the boundary import this module: `inject/` builds messages, `relay/`
 * validates them. It is pure — no DOM, no `chrome` — so it is unit-testable anywhere.
 */

export const AGUI_DT_SOURCE = 'agui-dt';
export const PROTOCOL_VERSION = 1;

/**
 * One SSE frame, in the single form every transport must produce.
 *
 * `raw` has ONE meaning, and all three capture paths — `fetch` (§5.1), `XMLHttpRequest` (§5.2)
 * and `EventSource` (§5.3) — are required to agree on it byte for byte for the same logical
 * frame. `inject/raw-invariant.test.ts` asserts exactly that; it exists because the three were
 * written separately and did not agree the first time.
 *
 *  - `kind: 'event'` — `raw` is the frame's `data` payload and nothing else: data lines joined
 *    with `\n`, one leading space after each colon stripped, which is what the SSE grammar says
 *    the payload is. It is the string a consumer hands straight to `JSON.parse`. It is NOT the
 *    frame text: no `data:` prefixes, and no `event:` / `id:` / `retry:` lines. Those fields are
 *    parsed by `core/sse/parser` and dropped here; anything downstream that needs one needs a
 *    field of its own on this type, not a different encoding of `raw`.
 *  - `kind: 'keepalive'` — `raw` is the reconstructed comment frame, `:${comment}\n\n`, matching
 *    what `panel/import/load-jsonl.ts` already puts in `CaptureRecord.raw` for an imported
 *    keepalive. `comment` carries the same text without the syntax.
 *
 * `EventSource` never reports keepalives at all: the browser consumes comment frames and does
 * not surface them.
 */
export type WireFrame =
  | { kind: 'event'; tMs: number; raw: string }
  | { kind: 'keepalive'; tMs: number; raw: string; comment: string };

export type InjectMessage =
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'conn-open';
      connId: string;
      tMs: number;
      method: string;
      url: string;
      contentType: string | null;
      input: unknown;
    }
  | { source: 'agui-dt'; v: 1; kind: 'frames'; connId: string; frames: WireFrame[] }
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'conn-close';
      connId: string;
      tMs: number;
      reason: 'complete' | 'error' | 'aborted';
    }
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'binary';
      connId: string;
      tMs: number;
      contentType: string;
      bytes: number;
    };

const CLOSE_REASONS: ReadonlySet<string> = new Set(['complete', 'error', 'aborted']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Own-property check that does not go through the value's own `hasOwnProperty` — a page-built
 * lookalike can define one. Every field of every message must be an OWN property: a real
 * message crosses `postMessage`, which structured-clones it and so flattens the prototype
 * chain, and a value carrying the `agui-dt` tag on a prototype can only have been assembled
 * deliberately.
 */
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWireFrame(value: unknown): value is WireFrame {
  if (!isRecord(value)) return false;
  if (!hasOwn(value, 'tMs') || !isTime(value.tMs)) return false;
  if (!hasOwn(value, 'raw') || typeof value.raw !== 'string') return false;
  if (!hasOwn(value, 'kind')) return false;
  if (value.kind === 'event') return true;
  if (value.kind === 'keepalive') return hasOwn(value, 'comment') && typeof value.comment === 'string';
  return false;
}

function check(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOwn(value, 'source') || value.source !== AGUI_DT_SOURCE) return false;
  if (!hasOwn(value, 'v') || value.v !== PROTOCOL_VERSION) return false;
  if (!hasOwn(value, 'connId') || typeof value.connId !== 'string' || value.connId === '') {
    return false;
  }
  if (!hasOwn(value, 'kind')) return false;

  switch (value.kind) {
    case 'conn-open':
      return (
        hasOwn(value, 'tMs') &&
        isTime(value.tMs) &&
        hasOwn(value, 'method') &&
        typeof value.method === 'string' &&
        hasOwn(value, 'url') &&
        typeof value.url === 'string' &&
        hasOwn(value, 'contentType') &&
        (value.contentType === null || typeof value.contentType === 'string') &&
        // `input` is `unknown`, so the only thing to assert is that the sender meant to
        // send one. A conn-open with no `input` key is a capture bug (verified fact 4),
        // not a message to forward.
        hasOwn(value, 'input')
      );
    case 'frames':
      return hasOwn(value, 'frames') && Array.isArray(value.frames) && value.frames.every(isWireFrame);
    case 'conn-close':
      return (
        hasOwn(value, 'tMs') &&
        isTime(value.tMs) &&
        hasOwn(value, 'reason') &&
        typeof value.reason === 'string' &&
        CLOSE_REASONS.has(value.reason)
      );
    case 'binary':
      return (
        hasOwn(value, 'tMs') &&
        isTime(value.tMs) &&
        hasOwn(value, 'contentType') &&
        typeof value.contentType === 'string' &&
        hasOwn(value, 'bytes') &&
        isTime(value.bytes) &&
        value.bytes >= 0
      );
    default:
      return false;
  }
}

/**
 * Shape guard for everything crossing the postMessage boundary. This is a security
 * boundary: the MAIN world is the page's world, so any script on the page can post a
 * lookalike message. Anything that fails is dropped silently by `relay/`.
 *
 * Hostile input must not be able to throw out of here — a throwing getter or a `Proxy`
 * with a hostile `has` trap would otherwise take down the relay's message listener — so
 * the whole check runs inside `try`.
 */
export function isInjectMessage(value: unknown): value is InjectMessage {
  try {
    return check(value);
  } catch {
    return false;
  }
}
