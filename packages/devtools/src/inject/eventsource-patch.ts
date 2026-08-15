/**
 * `EventSource` capture — requirements §5.3.
 *
 * DIFFERENT CODE PATH, on purpose: `EventSource` frames arrive *already parsed* by the browser.
 * There is no response body to tee and no text to slice, so `core/sse/parser` is not used here at
 * all — the `MessageEvent` hands us `data`, `lastEventId` and the event type, and this module
 * re-serializes them into the canonical frame text `WireFrame.raw` carries. That re-serialization
 * is the only place in the capture layer where `raw` is a reconstruction rather than a copy of
 * what crossed the wire: the browser consumed the wire text before we could see it.
 *
 * Two consequences worth stating rather than absorbing:
 *  - A frame's `tMs` is when the browser *dispatched* the event, not when its first byte landed
 *    (§5.5). Comparable to XHR's fidelity, better than nothing, worse than `fetch`.
 *  - Only the default `message` type is mirrored. A named `event:` frame reaches the page through
 *    `addEventListener('<name>', ...)`, and there is no way to enumerate those names without
 *    wrapping `addEventListener` per instance — extra surface, extra detectability, on a
 *    transport §5.3 already calls rare because `EventSource` cannot send a POST body and AG-UI's
 *    `RunAgentInput` has to go somewhere. Named frames are simply not captured; they are not
 *    silently mislabelled.
 */
import { AGUI_DT_SOURCE, PROTOCOL_VERSION, type InjectMessage, type WireFrame } from './protocol';

/** The slice of `EventSource` this patch touches. Keeps the tests free of a real one. */
export interface EventSourceLike extends EventTarget {
  readonly url: string;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSED. */
  readonly readyState: number;
  close(): void;
}

export interface EventSourceConstructorLike {
  new (url: string | URL, init?: EventSourceInit): EventSourceLike;
  readonly prototype: EventSourceLike;
}

/** The object that owns the `EventSource` binding. Production passes `window`. */
export interface EventSourceScope {
  EventSource: EventSourceConstructorLike;
}

export interface EventSourcePatchOptions {
  scope: EventSourceScope;
  post: (message: InjectMessage) => void;
  now: () => number;
  nextConnId: () => string;
}

function isMessageEvent(event: Event): event is MessageEvent<unknown> {
  return 'data' in event;
}

/** Canonical SSE text for a frame the browser already parsed. */
function toRaw(data: string, lastEventId: string): string {
  const lines: string[] = [];
  if (lastEventId !== '') lines.push(`id: ${lastEventId}`);
  for (const dataLine of data.split('\n')) lines.push(`data: ${dataLine}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Replace `scope.EventSource` with a subclass that tees `message` frames. Returns an uninstall
 * that restores the original binding.
 *
 * Behaviour preservation (§11): the original constructor is captured before the binding is
 * replaced, the subclass only ever calls `super(...)` with the caller's own arguments, every
 * listener body is wrapped in `try`/`catch`, and no page-visible property is added to the
 * instance. `instanceof` keeps working because the replacement extends the original.
 */
export function installEventSourcePatch(options: EventSourcePatchOptions): () => void {
  const { scope, post, now, nextConnId } = options;
  const OriginalEventSource = scope.EventSource;
  /**
   * Per-instance close hook. A `WeakMap` rather than a property on the instance: an own property
   * — however obscurely named — is exactly the kind of thing a page can enumerate to detect the
   * extension (§11), and the map keeps the instance shape identical to an unpatched one.
   */
  const closers = new WeakMap<object, (reason: 'complete' | 'error' | 'aborted') => void>();

  function emit(message: InjectMessage): void {
    try {
      post(message);
    } catch {
      // The relay leg is never allowed to break the page.
    }
  }

  class PatchedEventSource extends OriginalEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      const connId = nextConnId();
      let closed = false;

      const close = (reason: 'complete' | 'error' | 'aborted'): void => {
        if (closed) return;
        closed = true;
        emit({
          source: AGUI_DT_SOURCE,
          v: PROTOCOL_VERSION,
          kind: 'conn-close',
          connId,
          tMs: now(),
          reason,
        });
      };

      // `EventSource` is `text/event-stream` by definition and cannot carry a request body,
      // which is exactly why §5.3 calls it rare for AG-UI: `input` is honestly null here, and a
      // capture taken over this transport will report `run-started-without-input`.
      emit({
        source: AGUI_DT_SOURCE,
        v: PROTOCOL_VERSION,
        kind: 'conn-open',
        connId,
        tMs: now(),
        method: 'GET',
        url: String(url),
        contentType: 'text/event-stream',
        input: null,
      });

      super.addEventListener('message', (event: Event): void => {
        try {
          if (!isMessageEvent(event)) return;
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          const lastEventId = typeof event.lastEventId === 'string' ? event.lastEventId : '';
          const frame: WireFrame = { kind: 'event', tMs: now(), raw: toRaw(data, lastEventId) };
          emit({
            source: AGUI_DT_SOURCE,
            v: PROTOCOL_VERSION,
            kind: 'frames',
            connId,
            frames: [frame],
          });
        } catch {
          // Never surface inside the page's own listener chain.
        }
      });

      super.addEventListener('error', (): void => {
        try {
          // `EventSource` retries on its own; the page keeps the same object. Reporting the
          // connection closed here would strand every frame that arrives after a reconnect, so
          // an error only closes the record once the browser has given up (`CLOSED`).
          if (this.readyState === 2) close('error');
        } catch {
          // Ignored.
        }
      });

      closers.set(this, close);
    }

    override close(): void {
      try {
        closers.get(this)?.('complete');
      } catch {
        // Ignored.
      }
      super.close();
    }
  }

  scope.EventSource = PatchedEventSource;

  return function uninstall(): void {
    scope.EventSource = OriginalEventSource;
  };
}
