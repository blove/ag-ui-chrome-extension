import { cloneRuntimeInfo, isRuntimeInfo } from '../../core/detect/info';
import type {
  JsonlEvent,
  JsonlHeader,
  JsonlKeepalive,
  JsonlLine,
  JsonlRequest,
} from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';

/**
 * Field-shape validation for an imported `.agui.jsonl` — the check `decodeJsonl` deliberately
 * does not make.
 *
 * The codec guarantees an object with a known `kind` and nothing else, and an imported file is
 * untrusted input: hand-edited, written by a later version, truncated mid-value or hostile. Every
 * consumer downstream of `loadJsonl` — the run builder, export, the fixture and Threadplane
 * generators, the tabs — reads these fields as their declared types, so a `url` of `5` or a
 * `redacted` of `"text"` throws somewhere far from the file that caused it. This is the one place
 * those shapes are checked, and it follows `decodeJsonl`'s philosophy:
 *
 * - **Never throw.** Every input, however shaped, yields a verdict.
 * - **Load what can be loaded.** A field that has a safe reading is repaired; only a line that
 *   cannot be attributed or ordered — no `connId`, no `seq` — is dropped.
 * - **Say so.** Every repaired or dropped value is one clause of the line's problem, which
 *   `loadJsonl` reports through `decodeErrors` and so through the panel's partial-decode notice.
 *   A repaired capture that rendered like a clean one would be the trust failure P9 rules out.
 *
 * Fields are read as OWN properties, and every accepted line is a fresh object that names only
 * its declared keys. A `__proto__` key parsed from JSON is an ordinary own key; copying the parsed
 * object would run it through the prototype setter, and reading a missing field through the
 * prototype chain would let anything inherited stand in for it. Unknown keys are dropped without
 * a warning: that is what an older reader does with a newer file's additions (see `runtime` in
 * `JsonlHeader`), and it is not damage.
 */

export interface LineVerdict<T extends JsonlLine> {
  /** The line as the rest of the panel may read it, or `null` when it was dropped. */
  line: T | null;
  /** One clause per repaired or dropped value; empty for a well-formed line. */
  problems: string[];
}

function own(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** A bad value, quoted for a message. Bounded, because a hostile file controls its length. */
function show(value: unknown): string {
  if (value === undefined) return 'missing';
  // `1e400` parses to Infinity, which JSON.stringify would print as `null`.
  if (typeof value === 'number') return String(value);
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** One clause of a line's problem: which field, what it held, and what was done about it. */
function bad(key: string, value: unknown, expected: string, outcome: string): string {
  return value === undefined
    ? `${key} missing; ${outcome}`
    : `${key} ${show(value)} is not ${expected}; ${outcome}`;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A record's position in its capture: the live capture assigns these from a counter. */
function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const KNOWN_GROUPS: ReadonlySet<string> = new Set<string>(ALL_REDACTION_GROUPS);

/**
 * `redacted` is a CLAIM — that these payloads were replaced before the file was shared — and
 * claims are cumulative (export design E3): re-export unions them into the new header, and the
 * run builder declines findings the named groups destroyed the evidence for. So the failure to
 * avoid is under-reporting. A malformed value is read as the widest claim it could be, never as
 * "nothing was redacted":
 *
 * - a list keeps every string in it. A group this build does not know is kept for re-export
 *   (`unionRedacted` appends it) — a later version may have named it; a non-string names no group
 *   and is dropped with a warning;
 * - a bare string is a one-group claim written without its list;
 * - any other truthy value says something was redacted without saying what, so it is read as
 *   every group this build knows. Over-claiming makes the header say "redacted" about text that
 *   is verbatim; under-claiming makes it say "verbatim" about placeholders, which is the lie E3
 *   exists to prevent;
 * - absent, `null` or another falsy value claims nothing, and is reported as missing.
 */
function readRedacted(value: unknown, problems: string[]): RedactionGroup[] {
  if (Array.isArray(value)) {
    const claimed = new Set<string>();
    for (const item of value as unknown[]) {
      if (isString(item)) claimed.add(item);
      else problems.push(`redacted entry ${show(item)} is not a group name; dropped`);
    }
    return [...claimed] as RedactionGroup[];
  }
  if (isString(value) && value !== '') {
    problems.push(bad('redacted', value, 'a list', `read as [${show(value)}]`));
    return [value as RedactionGroup];
  }
  if (value) {
    problems.push(
      bad('redacted', value, 'a list of groups', `read as every group (${ALL_REDACTION_GROUPS.join(', ')})`),
    );
    return [...ALL_REDACTION_GROUPS];
  }
  problems.push(bad('redacted', value, 'a list of groups', 'read as nothing redacted'));
  return [];
}

/**
 * The groups the run builder can act on. `header.redacted` keeps unknown names for re-export;
 * the fold only understands the five §11 groups, and handing it one it cannot interpret gains
 * nothing.
 */
export function knownGroups(redacted: readonly RedactionGroup[]): RedactionGroup[] {
  return redacted.filter((group) => KNOWN_GROUPS.has(group));
}

/**
 * The header's scalar metadata. Each describes the capture rather than the stream, so a bad one
 * costs a label and never the load: it is replaced by the reading the export writer already uses
 * for "not known" (`url: 'unknown'`), or by the transport every JSONL event line implies.
 */
export function validateHeader(value: JsonlHeader): LineVerdict<JsonlHeader> {
  const problems: string[] = [];
  const text = (key: 'tool' | 'capturedAt' | 'url'): string => {
    const field = own(value, key);
    if (isString(field)) return field;
    problems.push(bad(key, field, 'a string', 'read as "unknown"'));
    return 'unknown';
  };

  const schemaVersion = own(value, 'schemaVersion');
  if (schemaVersion !== 1) {
    problems.push(bad('schemaVersion', schemaVersion, '1', 'read as version 1'));
  }
  const tool = text('tool');
  const capturedAt = text('capturedAt');
  const url = text('url');
  const transportValue = own(value, 'transport');
  let transport: JsonlHeader['transport'] = 'sse';
  if (transportValue === 'sse' || transportValue === 'binary') transport = transportValue;
  else problems.push(bad('transport', transportValue, '"sse" or "binary"', 'read as "sse"'));
  const redacted = readRedacted(own(value, 'redacted'), problems);

  const header: JsonlHeader = {
    kind: 'header',
    schemaVersion: 1,
    tool,
    capturedAt,
    url,
    transport,
    redacted,
  };

  const framework = own(value, 'framework');
  if (isString(framework)) header.framework = framework;
  else if (framework !== undefined) {
    problems.push(bad('framework', framework, 'a string', 'dropped'));
  }

  // Through the same `isRuntimeInfo` grammar the relay and the service worker use, and copied so
  // nothing it permitted but did not name reaches the Session tab or a re-export. Dropped rather
  // than repaired: there is no partial reading of an agent list that is not a guess.
  const runtime = own(value, 'runtime');
  if (isRuntimeInfo(runtime)) header.runtime = cloneRuntimeInfo(runtime);
  else if (runtime !== undefined) {
    problems.push(bad('runtime', runtime, 'agent metadata this build can read', 'dropped'));
  }

  return { line: header, problems };
}

/**
 * Stream lines, which carry the capture's identity and order.
 *
 * Stateful, because one repair needs history: a frame whose `tMs` is unreadable is placed at the
 * last time its connection was seen (0 before any), so connection lifetimes, gaps and close times
 * stay monotonic rather than jumping to a made-up instant.
 */
export function createLineValidator(): {
  request(value: JsonlRequest): LineVerdict<JsonlRequest>;
  event(value: JsonlEvent): LineVerdict<JsonlEvent>;
  keepalive(value: JsonlKeepalive): LineVerdict<JsonlKeepalive>;
} {
  const lastTMsByConn = new Map<string, number>();

  /**
   * `connId` and `seq` are what a line IS in the model — which stream it belongs to and where in
   * it — and neither has a reading that is not an invention. A line without them is dropped.
   * `tMs` is when, and has the carried-forward reading above.
   */
  function frame(
    value: JsonlRequest | JsonlEvent | JsonlKeepalive,
    problems: string[],
    withSeq: boolean,
  ): { connId: string; seq: number; tMs: number } | null {
    const connId = own(value, 'connId');
    if (!isString(connId)) {
      problems.push(bad('connId', connId, 'a string', 'line dropped'));
      return null;
    }
    const seq = own(value, 'seq');
    if (withSeq && !isSeq(seq)) {
      problems.push(bad('seq', seq, 'a non-negative integer', 'line dropped'));
      return null;
    }
    const lastTMs = lastTMsByConn.get(connId) ?? 0;
    const tMsValue = own(value, 'tMs');
    let tMs = lastTMs;
    if (isFiniteNumber(tMsValue)) tMs = tMsValue;
    else problems.push(bad('tMs', tMsValue, 'a number', `read as ${String(lastTMs)}`));
    lastTMsByConn.set(connId, tMs);
    return { connId, seq: withSeq ? (seq as number) : 0, tMs };
  }

  return {
    request(value) {
      const problems: string[] = [];
      const at = frame(value, problems, false);
      if (at === null) return { line: null, problems };
      const text = (key: 'method' | 'url'): string => {
        const field = own(value, key);
        if (isString(field)) return field;
        problems.push(bad(key, field, 'a string', 'read as "unknown"'));
        return 'unknown';
      };
      const method = text('method');
      const url = text('url');
      /*
       * `input` is `unknown` by design and any JSON value is legitimate: the live capture writes
       * the parsed body, the raw string when the body was not JSON, and `null` for a GET or an
       * EventSource. Only its ABSENCE is a defect — `conn-open` always carries the key.
       */
      let input = own(value, 'input');
      if (!Object.hasOwn(value, 'input')) {
        problems.push('input missing; read as null');
        input = null;
      }
      return {
        line: { kind: 'request', connId: at.connId, tMs: at.tMs, method, url, input },
        problems,
      };
    },

    event(value) {
      const problems: string[] = [];
      const at = frame(value, problems, true);
      if (at === null) return { line: null, problems };
      const line: JsonlEvent = {
        kind: 'event',
        connId: at.connId,
        seq: at.seq,
        tMs: at.tMs,
        event: own(value, 'event'),
      };
      // `event` may be any JSON value: a non-object is the builder's own "could not be parsed"
      // frame, recorded and surfaced there. Only a missing key is this file's damage.
      if (!Object.hasOwn(value, 'event')) {
        problems.push('event missing; read as null');
        line.event = null;
      }
      const sseEvent = own(value, 'sseEvent');
      if (isString(sseEvent)) line.sseEvent = sseEvent;
      else if (sseEvent !== undefined) {
        problems.push(bad('sseEvent', sseEvent, 'a string', 'dropped'));
      }
      return { line, problems };
    },

    keepalive(value) {
      const problems: string[] = [];
      const at = frame(value, problems, true);
      if (at === null) return { line: null, problems };
      let comment = own(value, 'comment');
      if (!isString(comment)) {
        problems.push(bad('comment', comment, 'a string', 'read as ""'));
        comment = '';
      }
      return {
        line: { kind: 'keepalive', connId: at.connId, seq: at.seq, tMs: at.tMs, comment: comment as string },
        problems,
      };
    },
  };
}
