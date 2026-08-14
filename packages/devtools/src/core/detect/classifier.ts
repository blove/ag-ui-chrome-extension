import { EVENT_TYPES } from '../events/event-table.generated';

export type Classification = 'agui' | 'provisional' | 'not-agui' | 'binary';

export interface ConnClassifier {
  observe(data: string): Classification;
  current(): Classification;
}

export type RouteHint =
  | { kind: 'copilotkit-info'; basePath: string }
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
 * Every capture group below is destructured with an `''` default. `RegExpExecArray` indexes
 * as `string | undefined` under `noUncheckedIndexedAccess`, but each group is unconditional
 * in its pattern — a successful `exec` always filled it — so the default is unreachable. It
 * is also the only safe default to write: `''` is precisely what `(.*)` captures for a
 * root-mounted route, and the `([^/]+)` groups cannot match fewer than one character. That
 * keeps `RouteHint`'s `basePath` / `agentId` / `threadId` as plain `string`, so consumers
 * never have to narrow a value the route grammar already guarantees.
 */
export function routeHint(url: string, method: string): RouteHint | undefined {
  const path = pathOf(url);
  const verb = method.toUpperCase();

  if (verb === 'GET') {
    const info = INFO_RE.exec(path);
    if (info) {
      const [, basePath = ''] = info;
      return { kind: 'copilotkit-info', basePath };
    }
    const meta = INSPECTOR_METADATA_RE.exec(path);
    if (meta) {
      const [, basePath = ''] = meta;
      return { kind: 'copilotkit-inspector-metadata', basePath };
    }
    return undefined;
  }

  if (verb === 'POST') {
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
    return undefined;
  }

  return undefined;
}
