/**
 * `window.fetch` capture (requirements §5.1).
 *
 * AG-UI's client POSTs with `Accept: text/event-stream` (verified on the wire), so this is the
 * path that matters — `chrome.debugger`'s `Network.eventSourceMessageReceived` never sees it,
 * which is the whole reason a MAIN-world patch exists (spec §3).
 *
 * Non-negotiables from requirements §11 and §15, each pinned by a test:
 *   - the original `fetch` reference is taken before patching and used on every path;
 *   - page behaviour is preserved on every path, including errors and non-stream responses;
 *   - the parse branch of `tee()` drains eagerly and never awaits delivery — a lagging
 *     branch makes `tee()` buffer without bound and stalls the page;
 *   - nothing here evaluates page data, and nothing thrown by the relay reaches page code.
 */

import {
  classifyContentType,
  createConnClassifier,
  routeHint,
  type Classification,
  type RouteHint,
} from '../core/detect/classifier';
import { parseInfoBody, type RuntimeMode } from '../core/detect/info';
import { createSseParser, type SseFrame } from '../core/sse/parser';
import {
  AGUI_DT_SOURCE,
  PROTOCOL_VERSION,
  type InjectMessage,
  type WireFrame,
} from './protocol';

/** The object whose `fetch` is replaced. `window` satisfies it; tests pass a stand-in. */
export interface FetchHost {
  fetch: typeof fetch;
}

export interface FetchPatchOptions {
  /** Delivery to the relay. Called synchronously; may throw — it is caught here. */
  post(message: InjectMessage): void;
  /** Monotonic clock. Defaults to `performance.now()` (requirements §5.5). */
  now?(): number;
  /** Batch scheduler. Defaults to `queueMicrotask` (requirements §5.1). */
  schedule?(task: () => void): void;
  /** Connection id factory. Defaults to a counter plus random suffix. */
  newConnId?(): string;
}

export interface FetchPatch {
  /** Restores the original `fetch`, unless the page patched over us in the meantime. */
  uninstall(): void;
  /**
   * Content classification for a connection (spec §4.1: two AG-UI events ⇒ `agui`, one ⇒
   * `provisional`). `InjectMessage` has nowhere to carry this yet, so it is exposed here.
   */
  classificationOf(connId: string): Classification | undefined;
}

type CloseReason = 'complete' | 'error' | 'aborted';

/** Requirements §5.1: a stream request body is recorded, never consumed. */
const UNREADABLE_STREAM_BODY = '[unreadable stream body]';
const UNSUPPORTED_BODY = '[unsupported body]';

/** Bounded so a long-lived page cannot grow this map without limit. */
const MAX_TRACKED_CLASSIFICATIONS = 64;

/**
 * Statuses whose responses are defined to have no body. `new Response(body, { status })`
 * throws a TypeError for these, and `tee()` has already locked the original body by then,
 * so the check has to happen before the tee, not in a catch around it.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/**
 * Bound on the bytes read from an agent-discovery response.
 *
 * The measured Dojo response is ~200 bytes. This is four orders of magnitude of headroom, and it
 * exists because the URL and body grammar that selects a response for reading is the page's to
 * satisfy: a page that wanted to make this extension buffer a gigabyte only has to answer its own
 * `/info` with one. Past the bound the read is ABANDONED and nothing is posted — no claim at all,
 * rather than a claim built from a truncated body.
 */
const MAX_INFO_BYTES = 2_000_000;

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? (): number => performance.now()
    : (): number => Date.now();

const defaultSchedule: (task: () => void) => void =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (task: () => void): void => {
        void Promise.resolve().then(task);
      };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * JSON bodies are decoded so the panel gets the `RunAgentInput` as structure rather than as
 * one long string. Only objects and arrays are unwrapped: a bare `"42"` body is more
 * faithfully reported as the string the page actually sent.
 */
function decodeBodyText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : text;
  } catch {
    return text;
  }
}

async function captureBody(body: unknown): Promise<unknown> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return decodeBodyText(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of body) {
      entries.push([
        key,
        typeof value === 'string' ? value : `[file ${value.name}, ${String(value.size)} bytes]`,
      ]);
    }
    return entries;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return decodeBodyText(await body.text());
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    // Reading it would consume the page's request body. Record its existence instead.
    return UNREADABLE_STREAM_BODY;
  }
  return UNSUPPORTED_BODY;
}

function isRequestObject(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (isRequestObject(input)) return input.url;
  return safeString(input);
}

function methodOf(input: unknown, init: RequestInit | undefined): string {
  const raw = init?.method ?? (isRequestObject(input) ? input.method : undefined);
  return typeof raw === 'string' && raw !== '' ? raw.toUpperCase() : 'GET';
}

function signalOf(input: unknown, init: RequestInit | undefined): AbortSignal | undefined {
  const signal = init?.signal ?? (isRequestObject(input) ? input.signal : undefined);
  return signal ?? undefined;
}

interface RequestMeta {
  method: string;
  url: string;
  tMs: number;
  /** Resolves to the captured body. Never rejects. */
  input: Promise<unknown>;
  signal: AbortSignal | undefined;
  /**
   * What the route grammar makes of this request, decided BEFORE the response arrives.
   *
   * It has to be synchronous: `observeResponse` must return a `Response` in the same turn, and
   * deciding whether to tee a body cannot wait on a promise — by the time one resolved the page
   * would already have the body and teeing it would be too late.
   */
  hint: RouteHint | undefined;
}

/**
 * The request body, if it can be read without waiting.
 *
 * Only a plain string init body qualifies, which is exactly what the single-route client sends:
 * `body: JSON.stringify({ method: 'info' })`. A `Request` object's body is a stream and a `Blob`'s
 * read is async, so neither can be peeked at here — those requests simply get no `hint`, which
 * costs a single-route info response smuggled inside a `Request` object and costs nothing else.
 * The multi-route `GET .../info` has no body at all and is recognised from its URL.
 */
function syncBody(init: RequestInit | undefined): unknown {
  if (!init || !('body' in init)) return undefined;
  const raw = init.body;
  return typeof raw === 'string' ? decodeBodyText(raw) : undefined;
}

function captureRequestMeta(
  input: unknown,
  init: RequestInit | undefined,
  tMs: number,
): RequestMeta {
  let body: Promise<unknown>;
  if (init && 'body' in init) {
    body = captureBody(init.body);
  } else if (isRequestObject(input) && input.body !== null) {
    // `clone()` tees the request body, so the request the page made is untouched — but it
    // MUST be taken synchronously, before `original` is called. `fetch(request)` runs
    // `new Request(input)` internally, which marks the caller's Request used straight away,
    // and a clone taken even one microtask later throws `TypeError: unusable`. That failure
    // is silent: the body degrades to `[unsupported body]` and every captured run then
    // reports a spurious `run-started-without-input`. Pinned by a test whose stand-in
    // consumes the Request the way the platform does.
    let clone: Request | null = null;
    try {
      clone = input.clone();
    } catch {
      // Already used by the page before it ever reached us. Nothing to read.
      clone = null;
    }
    body =
      clone === null
        ? Promise.resolve<unknown>(UNSUPPORTED_BODY)
        : clone.text().then(decodeBodyText);
  } else {
    body = Promise.resolve(null);
  }
  const method = methodOf(input, init);
  const url = urlOf(input);
  let hint: RouteHint | undefined;
  try {
    hint = routeHint(url, method, syncBody(init));
  } catch {
    // A hostile `init` can throw from a `body` getter. No hint is the honest outcome.
    hint = undefined;
  }
  return {
    method,
    url,
    tMs,
    input: body.catch((): unknown => UNSUPPORTED_BODY),
    signal: signalOf(input, init),
    hint,
  };
}

function closeReasonFor(error: unknown, signal: AbortSignal | undefined): CloseReason {
  try {
    if (signal?.aborted === true) return 'aborted';
  } catch {
    /* a hostile signal object is not evidence of an abort */
  }
  try {
    if (isRecord(error) && error.name === 'AbortError') return 'aborted';
  } catch {
    /* likewise for a hostile error */
  }
  return 'error';
}

function defineOwn(target: Response, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, configurable: true, enumerable: false });
  } catch {
    /* a frozen Response is still a usable Response */
  }
}

/**
 * `new Response(body, init)` — the shape requirements §5.1 prescribes — drops `url`,
 * `redirected` and `type`, all of which the page can read. Shadow them with own data
 * properties so the substitution is not observable.
 */
function copyResponse(original: Response, body: ReadableStream<Uint8Array>): Response {
  const copy = new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
  defineOwn(copy, 'url', original.url);
  defineOwn(copy, 'redirected', original.redirected);
  defineOwn(copy, 'type', original.type);
  return copy;
}

export function installFetchPatch(host: FetchHost, options: FetchPatchOptions): FetchPatch {
  // Held before patching (requirements §11) and used on every path below.
  const original = host.fetch;
  const now = options.now ?? defaultNow;
  const schedule = options.schedule ?? defaultSchedule;
  const classifications = new Map<string, Classification>();

  let connCounter = 0;
  const newConnId =
    options.newConnId ??
    ((): string => {
      connCounter += 1;
      return `c${String(connCounter)}-${Math.random().toString(36).slice(2, 10)}`;
    });

  function safePost(message: InjectMessage): void {
    try {
      options.post(message);
    } catch {
      // A failing relay must never surface in page code, and must never stop the drain.
    }
  }

  function remember(connId: string, classification: Classification): void {
    classifications.set(connId, classification);
    if (classifications.size > MAX_TRACKED_CLASSIFICATIONS) {
      const oldest = classifications.keys().next();
      if (oldest.done !== true) classifications.delete(oldest.value);
    }
  }

  interface Conn {
    frame(frame: WireFrame): void;
    observe(data: string): void;
    binary(bytes: number, tMs: number): void;
    close(reason: CloseReason): void;
  }

  function createConn(connId: string, meta: RequestMeta, contentType: string | null): Conn {
    const classifier = createConnClassifier(contentType);
    remember(connId, classifier.current());

    let opened = false;
    let closed = false;
    let flushScheduled = false;
    let queue: WireFrame[] = [];
    let deferredBinary: { bytes: number; tMs: number } | null = null;
    let deferredClose: { reason: CloseReason; tMs: number } | null = null;

    function flushNow(): void {
      if (!opened || queue.length === 0) return;
      const batch = queue;
      queue = [];
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'frames',
        connId,
        frames: batch,
      });
    }

    function postBinary(bytes: number, tMs: number): void {
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'binary',
        connId,
        tMs,
        contentType: contentType ?? '',
        bytes,
      });
    }

    function postClose(reason: CloseReason, tMs: number): void {
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-close',
        connId,
        tMs,
        reason,
      });
    }

    function open(input: unknown): void {
      if (opened) return;
      opened = true;
      safePost({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-open',
        connId,
        tMs: meta.tMs,
        method: meta.method,
        url: meta.url,
        contentType,
        input,
      });
      flushNow();
      if (deferredBinary !== null) {
        postBinary(deferredBinary.bytes, deferredBinary.tMs);
        deferredBinary = null;
      }
      if (deferredClose !== null) {
        postClose(deferredClose.reason, deferredClose.tMs);
        deferredClose = null;
      }
    }

    // The response may already be streaming while a Blob body is still being read, so
    // frames queue behind conn-open rather than racing it.
    void meta.input.then(open, () => {
      open(null);
    });

    return {
      frame(frame: WireFrame): void {
        queue.push(frame);
        if (flushScheduled) return;
        flushScheduled = true;
        schedule(() => {
          flushScheduled = false;
          flushNow();
        });
      },
      observe(data: string): void {
        remember(connId, classifier.observe(data));
      },
      binary(bytes: number, tMs: number): void {
        if (!opened) {
          deferredBinary = { bytes, tMs };
          return;
        }
        postBinary(bytes, tMs);
      },
      close(reason: CloseReason): void {
        if (closed) return;
        closed = true;
        const tMs = now();
        if (!opened) {
          deferredClose = { reason, tMs };
          return;
        }
        // Frames queued for the next microtask must not arrive after the close.
        flushNow();
        postClose(reason, tMs);
      },
    };
  }

  function emit(frames: SseFrame[], startMs: number, chunkMs: number, conn: Conn): void {
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      if (frame === undefined) continue;
      // §5.5: the frame is stamped when its first byte arrived, not when parsing finished.
      // Only the first frame of a chunk can have started earlier than this chunk.
      const tMs = i === 0 ? startMs : chunkMs;
      if (frame.kind === 'event') {
        conn.observe(frame.data);
        conn.frame({ kind: 'event', tMs, raw: frame.data });
      } else {
        conn.frame({
          kind: 'keepalive',
          tMs,
          raw: `:${frame.comment}\n\n`,
          comment: frame.comment,
        });
      }
    }
  }

  async function drainSse(
    stream: ReadableStream<Uint8Array>,
    conn: Conn,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    // Arrival time of the oldest byte the parser is still holding.
    let pendingSinceMs: number | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        const tMs = now();
        pendingSinceMs ??= tMs;
        const text = decoder.decode(value, { stream: true });
        if (text === '') continue;
        const frames = parser.push(text);
        emit(frames, pendingSinceMs, tMs, conn);
        // Anything the parser still holds began inside this chunk at the earliest.
        if (frames.length > 0) pendingSinceMs = tMs;
      }
      const tMs = now();
      const startMs = pendingSinceMs ?? tMs;
      const tail = decoder.decode();
      const frames = tail === '' ? parser.flush() : [...parser.push(tail), ...parser.flush()];
      emit(frames, startMs, tMs, conn);
      conn.close('complete');
    } catch (error) {
      conn.close(closeReasonFor(error, signal));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  async function drainBinary(
    stream: ReadableStream<Uint8Array>,
    conn: Conn,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const reader = stream.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        bytes += value.byteLength;
      }
      // §5.4: protobuf decoding is Phase 3. Report the transport, size and timing so the
      // panel can say "binary transport" instead of showing an empty stream.
      conn.binary(bytes, now());
      conn.close('complete');
    } catch (error) {
      conn.binary(bytes, now());
      conn.close(closeReasonFor(error, signal));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  /**
   * Read an agent-discovery response and post what it said.
   *
   * Ordinary JSON, not a stream — so none of the SSE machinery above applies and none of it is
   * reused. It is still read through a `tee()` for the same reason the SSE path is: the page's
   * own branch must be untouched, and `response.json()` here would consume the body the page is
   * about to read.
   *
   * Nothing is posted unless the body parses AND `parseInfoBody` recognises it. A 200 that
   * answers `/info` with an unrelated document is not agent metadata, and the honest report of
   * that is silence — the Session tab's empty state already says the right thing.
   */
  async function drainInfo(
    stream: ReadableStream<Uint8Array>,
    meta: RequestMeta,
    connId: string,
    mode: RuntimeMode,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        bytes += value.byteLength;
        // Abandoned, not truncated: half a JSON document parses to nothing, and a claim built
        // from a prefix would be worse than no claim.
        if (bytes > MAX_INFO_BYTES) return;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      // A torn stream loses the metadata. The page still has its own branch.
      return;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const info = parseInfoBody(parsed, mode);
    if (info === null) return;
    safePost({
      source: AGUI_DT_SOURCE,
      v: PROTOCOL_VERSION,
      kind: 'info',
      connId,
      tMs: now(),
      url: meta.url,
      info,
    });
  }

  /**
   * The one non-stream response this patch reads, and only when the page asked for it.
   *
   * Gated on the ROUTE HINT rather than on the content type: `application/json` is most of the
   * web, and teeing all of it would be both a privacy claim this extension does not make and a
   * cost the page would feel. `hint.kind === 'copilotkit-info'` is true for exactly two request
   * shapes — `GET {base}/info` and `POST {base}` carrying `{"method":"info"}` — both of which the
   * page issued itself (§11).
   */
  function observeInfo(response: Response, meta: RequestMeta): Response {
    const hint = meta.hint;
    if (hint === undefined || hint.kind !== 'copilotkit-info') return response;
    // A failed request carries no agent metadata, and an error page can be arbitrarily large.
    if (!response.ok) return response;
    const body = response.body;
    if (body === null || NULL_BODY_STATUSES.has(response.status)) return response;

    const [toPage, toUs] = body.tee();
    // Discarded deliberately, exactly as on the SSE path: awaiting would stall the page, and an
    // unhandled rejection would surface inside the PAGE's own `onunhandledrejection`.
    void drainInfo(toUs, meta, newConnId(), hint.mode).catch((): void => {});
    return copyResponse(response, toPage);
  }

  function observeResponse(response: Response, meta: RequestMeta): Response {
    // Requirements §11: `content-type` is the only header this extension ever reads.
    const contentType = response.headers.get('content-type');
    const transport = classifyContentType(contentType);
    // A discovery response is ordinary JSON, so it lands here — on the branch the SSE and binary
    // paths both decline. The SSE path below is untouched by it.
    if (transport === 'other') return observeInfo(response, meta);

    const connId = newConnId();
    const conn = createConn(connId, meta, contentType);

    const body = response.body;
    if (body === null || NULL_BODY_STATUSES.has(response.status)) {
      conn.close('complete');
      return response;
    }

    const [toPage, toUs] = body.tee();
    // Swallow, deliberately. These promises are discarded on purpose — awaiting them
    // would stall the page (§15) — but a discarded rejecting promise surfaces as an
    // unhandled rejection in the PAGE, observable via its own onunhandledrejection.
    // §11 says this script must never throw into page code, and an unhandled rejection
    // is throwing into page code by a slower route. Losing capture on a torn stream is
    // the correct trade against perturbing the host page.
    const swallow = (): void => {};
    if (transport === 'binary') void drainBinary(toUs, conn, meta.signal).catch(swallow);
    else void drainSse(toUs, conn, meta.signal).catch(swallow);
    return copyResponse(response, toPage);
  }

  function patched(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args;
    let meta: RequestMeta | null = null;
    try {
      meta = captureRequestMeta(input, init, now());
    } catch {
      meta = null;
    }
    const pending = original.apply(this, args);
    if (meta === null) return pending;
    const captured = meta;
    return pending.then((response) => {
      try {
        return observeResponse(response, captured);
      } catch {
        // Capture must never cost the page its response.
        return response;
      }
    });
  }

  host.fetch = patched;

  return {
    uninstall(): void {
      if (host.fetch === patched) host.fetch = original;
    },
    classificationOf(connId: string): Classification | undefined {
      return classifications.get(connId);
    },
  };
}
