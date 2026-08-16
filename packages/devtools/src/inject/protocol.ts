/**
 * The MAIN-world → ISOLATED-world wire protocol (design §3, requirements §11).
 *
 * Both halves of the boundary import this module: `inject/` builds messages, `relay/`
 * validates them. It is pure — no DOM, no `chrome` — so it is unit-testable anywhere.
 */

import { isRuntimeInfo, type RuntimeInfo } from '../core/detect/info';

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

/**
 * Everything the MAIN world posts across the boundary — and, since 2026-08-15, nothing else.
 *
 * EVERY arm here belongs to a connection. That is a privacy property, not a coincidence, and it
 * is the reason this union no longer has a `capture-installed` arm: a message posted through
 * `window.postMessage` reaches the page's own `message` listeners, so an arm that fired at
 * `document_start` announced the extension to every page on a granted origin, including the vast
 * majority that never speak AG-UI. The presence signal now travels the ISOLATED world's
 * `chrome.runtime` port instead (see `relay/relay.ts`), which the page cannot observe at all.
 *
 * The consequence for this file: the page can only ever see traffic it caused. A `postMessage`
 * here is downstream of a `fetch`, an `XMLHttpRequest` or an `EventSource` the page itself
 * opened, so the extension says nothing the page did not already provoke.
 *
 * The transport patches are typed on this union directly. They used to be typed on a
 * `ConnectionMessage = Exclude<InjectMessage, { kind: 'capture-installed' }>` so a transport
 * could not structurally claim the hooks were installed; with that arm gone the exclusion said
 * nothing, so it was deleted rather than kept as a type that only looked like a constraint. The
 * intent it encoded is now enforced by the world boundary, which is far stronger than a type:
 * the presence claim is not an `InjectMessage` at all, so no page-side code — ours or the
 * page's — has a shape in which to make it.
 */
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
    }
  /**
   * The runtime's answer to an agent-discovery request the page made (spec §13 done-when #2).
   *
   * It belongs to a connection like every other arm — the `connId` is the `fetch` the page itself
   * issued — so the privacy property stated above still holds unchanged: nothing crosses this
   * boundary that the page did not provoke, and the extension initiates nothing.
   *
   * `info` is the PARSED and VALIDATED structure, not the response text. The raw body never
   * crosses the boundary: `parseInfoBody` runs in the MAIN world and only its result is posted, so
   * a runtime that returns megabytes of unrelated JSON contributes nothing but the fields this
   * protocol names. The relay re-validates anyway — the MAIN world is the page's world, so this
   * message is exactly as forgeable as any other, and `check` below treats it that way.
   */
  | {
      source: 'agui-dt';
      v: 1;
      kind: 'info';
      connId: string;
      tMs: number;
      /** The URL the runtime answered on. Recorded so a reader knows WHICH runtime replied. */
      url: string;
      info: RuntimeInfo;
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
  if (!hasOwn(value, 'kind')) return false;

  // Unconditional now that every arm belongs to a connection. The `capture-installed` arm used to
  // be checked ahead of this line and exempted from it; it is gone, and with it the one path
  // across this boundary that did not have to name a connection.
  if (!hasOwn(value, 'connId') || typeof value.connId !== 'string' || value.connId === '') {
    return false;
  }

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
    case 'info':
      return (
        hasOwn(value, 'tMs') &&
        isTime(value.tMs) &&
        hasOwn(value, 'url') &&
        typeof value.url === 'string' &&
        hasOwn(value, 'info') &&
        // Structural, own-property strict, and non-throwing — see `isRuntimeInfo`. A page can
        // post anything at all in this field, and the panel eventually renders it and writes it
        // into a file someone shares, so "it looked about right" is not a standard this boundary
        // can work to.
        isRuntimeInfo(value.info)
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
