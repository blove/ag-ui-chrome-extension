import { EVENT_TYPES } from '../events/event-table.generated';
import type { RuntimeMode } from './info';

export type Classification = 'agui' | 'provisional' | 'not-agui' | 'binary';

export interface ConnClassifier {
  observe(data: string): Classification;
  current(): Classification;
}

export type RouteHint =
  /**
   * Agent discovery — spec §4.2's "best pre-run detection signal", and the request `/info`
   * capture rides on.
   *
   * `mode` is here because the SAME body arrives over two different transports and the
   * difference is a fact about the deployment that requirements §4 asks to be reported. See
   * `routeHint` for the two shapes.
   */
  | { kind: 'copilotkit-info'; basePath: string; mode: RuntimeMode }
  | { kind: 'copilotkit-run'; basePath: string; agentId: string }
  | { kind: 'copilotkit-connect'; basePath: string; agentId: string }
  | { kind: 'copilotkit-stop'; basePath: string; agentId: string; threadId: string }
  | { kind: 'copilotkit-inspector-metadata'; basePath: string };

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

const SSE_MIME = 'text/event-stream';
const PROTO_MIME = 'application/vnd.ag-ui.event+proto';

export function classifyContentType(
  contentType: string | null | undefined,
): 'sse' | 'binary' | 'other' {
  if (!contentType) return 'other';
  // `String.prototype.split` always yields at least one element, but it indexes as
  // `string | undefined` under `noUncheckedIndexedAccess`; the `''` default is unreachable
  // and, were it ever reached, means exactly what an empty essence means — `'other'`.
  const [beforeParams = ''] = contentType.split(';');
  const essence = beforeParams.trim().toLowerCase();
  if (essence === SSE_MIME) return 'sse';
  if (essence === PROTO_MIME) return 'binary';
  return 'other';
}

export function isAguiPayload(data: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const type = (parsed as Record<string, unknown>).type;
  return typeof type === 'string' && KNOWN_EVENT_TYPES.has(type);
}

export function createConnClassifier(
  contentType: string | null | undefined,
): ConnClassifier {
  const transport = classifyContentType(contentType);
  let state: Classification = transport === 'binary' ? 'binary' : 'not-agui';
  let matches = 0;

  return {
    observe(data: string): Classification {
      if (transport !== 'sse') return state;
      if (state === 'agui') return state;
      if (isAguiPayload(data)) {
        matches += 1;
        state = matches >= 2 ? 'agui' : 'provisional';
      }
      return state;
    },
    current(): Classification {
      return state;
    },
  };
}

const INFO_RE = /^(.*)\/info$/;
const INSPECTOR_METADATA_RE = /^(.*)\/inspector-metadata$/;
const RUN_RE = /^(.*)\/agent\/([^/]+)\/run$/;
const CONNECT_RE = /^(.*)\/agent\/([^/]+)\/connect$/;
const STOP_RE = /^(.*)\/agent\/([^/]+)\/stop\/([^/]+)$/;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Not an absolute URL: treat the string as a path and drop the hash, then the query.
    const [beforeHash = ''] = url.split('#');
    const [beforePath = ''] = beforeHash.split('?');
    return beforePath;
  }
}

/**
 * The single-route envelope, recognised by its `method` discriminant alone.
 *
 * Spec §4.2 describes single-route mode as `POST {base}` with a `{method, params, body}` envelope,
 * and the v2 client's dist confirms the shape it sends for discovery:
 *
 * ```js
 * if (this._runtimeTransport === "single") {
 *   fetch(this.runtimeUrl, { method: 'POST', body: JSON.stringify({ method: 'info' }), ... })
 * }
 * // otherwise: GET `${this.runtimeUrl}/info`
 * ```
 *
 * So the URL carries NO evidence at all in this mode — it is the runtime's own base path, which
 * is also where every other single-route call goes. The body is the entire signal, which is why
 * `routeHint` takes one, and why the previous URL-only rule recognised nothing here.
 *
 * Deliberately tolerant of extra keys (`params`, `body` ride along on a real envelope) and
 * deliberately intolerant of everything else: the discriminant must be an OWN property, must be
 * exactly the string `info`, and a nested `{ params: { method: 'info' } }` is a different call.
 */
function isSingleRouteInfoEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  if (!Object.prototype.hasOwnProperty.call(body, 'method')) return false;
  return (body as Record<string, unknown>)['method'] === 'info';
}

/**
 * Every capture group below is destructured with an `''` default. `RegExpExecArray` indexes
 * as `string | undefined` under `noUncheckedIndexedAccess`, but each group is unconditional
 * in its pattern — a successful `exec` always filled it — so the default is unreachable. It
 * is also the only safe default to write: `''` is precisely what `(.*)` captures for a
 * root-mounted route, and the `([^/]+)` groups cannot match fewer than one character. That
 * keeps `RouteHint`'s `basePath` / `agentId` / `threadId` as plain `string`, so consumers
 * never have to narrow a value the route grammar already guarantees.
 *
 * `body` is the DECODED request body when one is available and `undefined` otherwise, so every
 * existing two-argument call keeps its meaning exactly. It matters for one arm only — the
 * single-route info envelope above — because that is the one route whose URL says nothing.
 */
export function routeHint(url: string, method: string, body?: unknown): RouteHint | undefined {
  const path = pathOf(url);
  const verb = method.toUpperCase();

  if (verb === 'GET') {
    const info = INFO_RE.exec(path);
    if (info) {
      const [, basePath = ''] = info;
      return { kind: 'copilotkit-info', basePath, mode: 'multi-route' };
    }
    const meta = INSPECTOR_METADATA_RE.exec(path);
    if (meta) {
      const [, basePath = ''] = meta;
      return { kind: 'copilotkit-inspector-metadata', basePath };
    }
    return undefined;
  }

  if (verb === 'POST') {
    // The multi-route grammar is checked FIRST. A POST to `.../agent/:id/run` is a run whatever
    // its body says; letting an envelope key reclassify it would turn a stream into a metadata
    // request on the strength of one field the run body is free to contain.
    const run = RUN_RE.exec(path);
    if (run) {
      const [, basePath = '', agentId = ''] = run;
      return { kind: 'copilotkit-run', basePath, agentId };
    }
    const connect = CONNECT_RE.exec(path);
    if (connect) {
      const [, basePath = '', agentId = ''] = connect;
      return { kind: 'copilotkit-connect', basePath, agentId };
    }
    const stop = STOP_RE.exec(path);
    if (stop) {
      const [, basePath = '', agentId = '', threadId = ''] = stop;
      return { kind: 'copilotkit-stop', basePath, agentId, threadId };
    }
    // `basePath` is the whole path: in single-route mode the runtime URL IS the endpoint, so
    // there is no suffix to strip and no sub-path to report.
    if (isSingleRouteInfoEnvelope(body)) {
      return { kind: 'copilotkit-info', basePath: path, mode: 'single-route' };
    }
    return undefined;
  }

  return undefined;
}
