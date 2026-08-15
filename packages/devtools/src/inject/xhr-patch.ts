/**
 * `XMLHttpRequest` capture — requirements §5.2.
 *
 * TIMING FIDELITY, stated rather than absorbed: `fetch` (§5.1) tees the response body and sees
 * every chunk as the network delivers it, so a frame's `tMs` is the arrival time of its first
 * byte (§5.5). XHR has no such hook. The only incremental view is `readyState === 3`
 * (`LOADING`), which the browser fires when it has appended *some* text to `responseText` —
 * coalescing several network chunks into one event, on its own schedule. So every frame decoded
 * out of one `readyState === 3` slice carries the same timestamp: the moment that slice was
 * handed to us, not the moment each frame landed. Inter-frame gaps within a slice read as zero.
 * The §8 metrics built on XHR captures are therefore coarser than the `fetch` ones. §5.2 accepts
 * this ("Lower fidelity on timing than fetch; acceptable") — this comment is here so nobody later
 * reads a flat-looking XHR waterfall as a finding about the server.
 */
import { createSseParser, type SseParser } from '../core/sse/parser';

import {
  AGUI_DT_SOURCE,
  PROTOCOL_VERSION,
  type ConnectionMessage,
  type WireFrame,
} from './protocol';
import { sseFrameToWireFrame } from './wire-frame';

/** The slice of `XMLHttpRequest` this patch touches. Keeps the tests free of a real XHR. */
export interface XhrLike extends EventTarget {
  readonly readyState: number;
  readonly responseText: string;
  readonly response: unknown;
  readonly status: number;
  responseType: XMLHttpRequestResponseType;
  getResponseHeader(name: string): string | null;
}

export interface XhrPrototypeLike extends XhrLike {
  open(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void;
  send(body?: unknown): void;
}

export interface XhrConstructorLike {
  prototype: XhrPrototypeLike;
}

export interface XhrPatchOptions {
  /** The constructor whose prototype gets patched. Production passes `window.XMLHttpRequest`. */
  target: XhrConstructorLike;
  /** Delivery to the relay. Must never throw; this patch guards it anyway. */
  post: (message: ConnectionMessage) => void;
  /** §5.5 monotonic clock. Production passes `() => performance.now()`. */
  now: () => number;
  nextConnId: () => string;
}

/** Content type that means "protobuf transport, decoding deferred to Phase 3" (§5.4). */
const PROTO_CONTENT_TYPE = 'application/vnd.ag-ui.event+proto';
const SSE_CONTENT_TYPE = 'text/event-stream';

type Mode = 'ignore' | 'sse' | 'binary';

type OpenArgs = Parameters<XhrPrototypeLike['open']>;
type SendArgs = Parameters<XhrPrototypeLike['send']>;

interface ConnState {
  method: string;
  url: string;
  input: unknown;
  connId: string;
  mode: Mode;
  contentType: string | null;
  parser: SseParser | null;
  /** Characters of `responseText` already fed to the parser. */
  offset: number;
  opened: boolean;
  closed: boolean;
  /** True once `open` was called again on the same XHR object; see `patchedOpen`. */
  superseded: boolean;
}

function mediaType(header: string | null): string {
  if (header === null) return '';
  const semi = header.indexOf(';');
  return (semi === -1 ? header : header.slice(0, semi)).trim().toLowerCase();
}

/**
 * `responseText` throws `InvalidStateError` unless `responseType` is `''` or `'text'`, so the
 * incremental path is only available for those two.
 */
function isTextResponseType(responseType: string): boolean {
  return responseType === '' || responseType === 'text';
}

/**
 * §5.1's request-body rules, applied to `send`'s argument. Never reads a `Blob` or a `Document`:
 * both need async or serialization work that would change page timing, and the `RunAgentInput`
 * we actually care about is always a JSON string.
 */
export function snapshotXhrBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of body.entries()) out[key] = typeof value === 'string' ? value : null;
    return out;
  }
  return '[unreadable body]';
}

function byteLength(response: unknown, responseText: string): number {
  if (response instanceof ArrayBuffer) return response.byteLength;
  if (ArrayBuffer.isView(response)) return response.byteLength;
  if (typeof Blob !== 'undefined' && response instanceof Blob) return response.size;
  if (typeof response === 'string') return response.length;
  return responseText.length;
}

/**
 * Patch `open`/`send` on `target.prototype`. Returns an uninstall that restores both originals.
 *
 * Behaviour preservation (§11): originals are captured before anything is replaced, every
 * patched path ends in `Reflect.apply` on the original with the caller's own `this` and
 * arguments, and all capture work runs inside `try`/`catch` so a defect here can never surface
 * as a page-visible XHR failure.
 */
export function installXhrPatch(options: XhrPatchOptions): () => void {
  const { target, post, now, nextConnId } = options;
  const proto = target.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const states = new WeakMap<object, ConnState>();

  function emit(message: ConnectionMessage): void {
    try {
      post(message);
    } catch {
      // The relay leg is never allowed to break the page.
    }
  }

  function openConn(state: ConnState, contentType: string | null): void {
    if (state.opened) return;
    state.opened = true;
    state.contentType = contentType;
    emit({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-open',
      connId: state.connId,
      tMs: now(),
      method: state.method,
      url: state.url,
      contentType,
      input: state.input,
    });
  }

  function closeConn(state: ConnState, reason: 'complete' | 'error' | 'aborted'): void {
    if (state.superseded || !state.opened || state.closed) return;
    state.closed = true;
    emit({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'conn-close',
      connId: state.connId,
      tMs: now(),
      reason,
    });
  }

  function drain(xhr: XhrLike, state: ConnState, final: boolean): void {
    const parser = state.parser;
    if (parser === null) return;
    const text = xhr.responseText;
    const chunk = text.length > state.offset ? text.slice(state.offset) : '';
    state.offset = text.length;
    const tMs = now();
    const frames: WireFrame[] = [];
    if (chunk !== '') {
      for (const frame of parser.push(chunk)) frames.push(sseFrameToWireFrame(frame, tMs));
    }
    if (final) {
      for (const frame of parser.flush()) frames.push(sseFrameToWireFrame(frame, tMs));
    }
    if (frames.length === 0) return;
    emit({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'frames',
      connId: state.connId,
      frames,
    });
  }

  function onHeaders(xhr: XhrLike, state: ConnState): void {
    const header = xhr.getResponseHeader('content-type');
    const type = mediaType(header);
    if (type === PROTO_CONTENT_TYPE) {
      state.mode = 'binary';
      openConn(state, header);
      return;
    }
    if (type !== SSE_CONTENT_TYPE) {
      // Not a stream candidate: this XHR is never reported, not even as a connection.
      state.mode = 'ignore';
      return;
    }
    if (!isTextResponseType(xhr.responseType)) {
      // An event stream the page asked for as a Blob/ArrayBuffer. `responseText` would throw, so
      // report it the way §5.4 reports any undecodable transport — bytes and timing, no frames —
      // rather than opening a connection that silently produces nothing.
      state.mode = 'binary';
      openConn(state, header);
      return;
    }
    state.mode = 'sse';
    state.parser = createSseParser();
    openConn(state, header);
  }

  function onDone(xhr: XhrLike, state: ConnState): void {
    if (state.mode === 'sse') {
      drain(xhr, state, true);
      return;
    }
    if (state.mode === 'binary') {
      const text = isTextResponseType(xhr.responseType) ? xhr.responseText : '';
      emit({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'binary',
        connId: state.connId,
        tMs: now(),
        contentType: state.contentType ?? '',
        bytes: byteLength(xhr.response, text),
      });
    }
  }

  proto.open = function patchedOpen(this: XhrLike, ...args: OpenArgs): void {
    try {
      // An XHR object can be reopened; every `open` starts a fresh connection record. The
      // listeners `send` attached for the previous one are still on the instance and cannot be
      // removed from here, so the retired record is flagged and every handler ignores it —
      // otherwise the second response would be sliced twice, once under each connection id.
      const previous = states.get(this);
      if (previous !== undefined) previous.superseded = true;
      states.set(this, {
        method: String(args[0]),
        url: String(args[1]),
        input: null,
        connId: nextConnId(),
        mode: 'ignore',
        contentType: null,
        parser: null,
        offset: 0,
        opened: false,
        closed: false,
        superseded: false,
      });
    } catch {
      states.delete(this);
    }
    return Reflect.apply(originalOpen, this, args);
  };

  proto.send = function patchedSend(this: XhrLike, ...args: SendArgs): void {
    try {
      const state = states.get(this);
      if (state !== undefined) {
        state.input = snapshotXhrBody(args[0]);
        // Arrow callbacks: `this` stays the XHR instance without aliasing it to a local.
        this.addEventListener('readystatechange', () => {
          try {
            if (state.superseded) return;
            if (this.readyState === 2) onHeaders(this, state);
            else if (this.readyState === 3 && state.mode === 'sse') drain(this, state, false);
            else if (this.readyState === 4) onDone(this, state);
          } catch {
            // Never let capture surface inside the page's own handler chain.
          }
        });
        // Close on the terminal events, not on `readyState === 4`: `abort` and `error` fire
        // *after* that transition, so closing there would label every abort 'complete'.
        this.addEventListener('load', () => {
          closeConn(state, 'complete');
        });
        this.addEventListener('error', () => {
          closeConn(state, 'error');
        });
        this.addEventListener('timeout', () => {
          closeConn(state, 'error');
        });
        this.addEventListener('abort', () => {
          closeConn(state, 'aborted');
        });
      }
    } catch {
      // Fall through to the original send regardless.
    }
    return Reflect.apply(originalSend, this, args);
  };

  return function uninstall(): void {
    proto.open = originalOpen;
    proto.send = originalSend;
  };
}
