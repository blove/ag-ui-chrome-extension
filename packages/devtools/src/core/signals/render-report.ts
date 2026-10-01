/**
 * The Threadplane render report — the second shape a Threadplane app in development mode hands the
 * extension (UI inspector design U4), beside the signals report in `./report`.
 *
 * Same `CustomEvent('threadplane:devtools', { detail })` on `window`, told apart by `kind`: a
 * signals report has no `kind` at all, a render report has `kind: 'render'`. Pure, Chrome-free,
 * DOM-free, so the MAIN world, the relay and the service worker validate with one grammar.
 *
 * WHAT IT CARRIES. Names and states only: for one rendered surface, which component names the
 * app's registry holds and how each spec element resolved — `mounted`, `fallback`, `unresolved`
 * (no registry entry) or `hidden` (not rendered). Never a prop value. Every string is a bounded
 * name the panel shows as text, every list is capped, and the element objects have an exact key
 * set, so nothing beyond those names can ride along.
 *
 * Threadplane's emitter (cacheplane/threadplane#1215, `devtools-render-report.ts`) drops a name
 * that does not fit rather than truncating it, and caps the lists in order — so a report from it
 * always fits these bounds; one that does not is not from it.
 */

/** How one spec element resolved in the app's renderer. */
export type RenderElementState = 'mounted' | 'fallback' | 'unresolved' | 'hidden';

export interface RenderElementReport {
  /** The A2UI component id or json-render element key, 1–128 chars. */
  key: string;
  /** The component type the spec asked for, 1–128 chars. */
  type: string;
  state: RenderElementState;
}

export interface RenderDevtoolsReport {
  v: 1;
  kind: 'render';
  /** The A2UI `surfaceId`, or `'spec:' + root key` for a json-render spec; 1–128 chars. */
  surface: string;
  /** Per page, from 1, across every surface. */
  seq: number;
  /** The registry's component names, at most 500, each 1–128 chars. */
  registry: string[];
  /** At most 2,000 elements, root first. */
  elements: RenderElementReport[];
  /** `performance.now()` in the dispatching document. */
  tMs: number;
}

export const MAX_RENDER_NAME_LENGTH = 128;
export const MAX_RENDER_REGISTRY = 500;
export const MAX_RENDER_ELEMENTS = 2000;

export const RENDER_ELEMENT_STATES: readonly RenderElementState[] = ['mounted', 'fallback', 'unresolved', 'hidden'];

const REPORT_KEYS: ReadonlySet<PropertyKey> = new Set(['v', 'kind', 'surface', 'seq', 'registry', 'elements', 'tMs']);
const ELEMENT_KEYS: ReadonlySet<PropertyKey> = new Set(['key', 'type', 'state']);
/** A `Set`, so `constructor` or `__proto__` can never match by way of a prototype. */
const STATES: ReadonlySet<unknown> = new Set<unknown>(RENDER_ELEMENT_STATES);

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RENDER_NAME_LENGTH;
}

/** A plain-object-shaped value with EXACTLY these own keys, symbols and non-enumerables included. */
function hasExactKeys(value: unknown, expected: ReadonlySet<PropertyKey>): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size) return false;
  for (const key of keys) if (!expected.has(key)) return false;
  return true;
}

/** An array of at most `max` own entries, each passing `item`. Length first, so a huge claim costs nothing. */
function isBoundedList(value: unknown, max: number, item: (entry: unknown) => boolean): boolean {
  if (!Array.isArray(value)) return false;
  const length = value.length;
  if (length > max) return false;
  for (let index = 0; index < length; index += 1) {
    // Own index only: a hole, or an index a polluted `Array.prototype` supplies, is not reported.
    if (!hasOwn(value, index)) return false;
    if (!item(value[index])) return false;
  }
  return true;
}

function isElement(value: unknown): boolean {
  if (!hasExactKeys(value, ELEMENT_KEYS)) return false;
  return isName(value['key']) && isName(value['type']) && STATES.has(value['state']);
}

function check(value: unknown): boolean {
  if (!hasExactKeys(value, REPORT_KEYS)) return false;
  if (value['v'] !== 1 || value['kind'] !== 'render') return false;
  if (!isName(value['surface'])) return false;
  const seq = value['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return false;
  const tMs = value['tMs'];
  if (typeof tMs !== 'number' || !Number.isFinite(tMs) || tMs < 0) return false;
  if (!isBoundedList(value['registry'], MAX_RENDER_REGISTRY, isName)) return false;
  return isBoundedList(value['elements'], MAX_RENDER_ELEMENTS, isElement);
}

/**
 * Shape guard for a render report from anywhere untrusted — the page's `CustomEvent`, a relayed
 * message, a session-storage mirror. Exact key sets (the report's and each element's), every bound
 * enforced, own properties only. It cannot throw: a hostile value may carry a throwing getter or
 * be a `Proxy` with hostile traps.
 *
 * As with `isThreadplaneReport`, a caller holding the page's own object copies it with
 * `cloneRenderReport` and re-checks the copy, which is plain data and answers consistently.
 */
export function isRenderReport(value: unknown): value is RenderDevtoolsReport {
  try {
    return check(value);
  } catch {
    return false;
  }
}

/**
 * Rebuild a render report from the contract's fields only, one level deeper for each element.
 * Reads every field once and produces plain objects and arrays. Bounded by the contract rather
 * than a re-read `length` (a `Proxy` array can answer 1e9 the second time); one past a limit is
 * enough for the caller's re-check to refuse the copy.
 *
 * May throw on a hostile value (a getter that throws on the second read) — every caller copies
 * inside its own `try`, as with `cloneReport`.
 */
export function cloneRenderReport(report: RenderDevtoolsReport): RenderDevtoolsReport {
  const registry: string[] = [];
  const names = report.registry;
  const nameCount = Math.min(names.length, MAX_RENDER_REGISTRY + 1);
  for (let index = 0; index < nameCount; index += 1) registry.push(names[index] as string);

  const elements: RenderElementReport[] = [];
  const source = report.elements;
  const elementCount = Math.min(source.length, MAX_RENDER_ELEMENTS + 1);
  for (let index = 0; index < elementCount; index += 1) {
    const element: unknown = source[index];
    if (typeof element === 'object' && element !== null) {
      const { key, type, state } = element as RenderElementReport;
      elements.push({ key, type, state });
    } else {
      // Not an element any more (a getter changed its answer): copied as is so the re-check refuses it.
      elements.push(element as RenderElementReport);
    }
  }
  return {
    v: 1,
    kind: 'render',
    surface: report.surface,
    seq: report.seq,
    registry,
    elements,
    tMs: report.tMs,
  };
}

/**
 * How many serialized characters the worker's per-tab render ring, and the panel's copy of it,
 * may hold — beside the 500-report count. A report may legally carry 2,000 elements and 500
 * names of 128 characters (~650 K characters), so the count alone would let one tab pin hundreds
 * of megabytes. Typical reports are a few K, so the count is what binds them; this binds the
 * worst case at about six maximum-size reports.
 */
export const MAX_RENDER_RING_CHARS = 4_000_000;

const reportChars = new WeakMap<RenderDevtoolsReport, number>();

/**
 * An upper estimate of `JSON.stringify(report).length`, without building the string: every
 * name, plus each element's keys and quoting, plus the fixed fields. Memoised per report object
 * (reports are rebuilt once on the way in and never mutated after).
 */
export function renderReportChars(report: RenderDevtoolsReport): number {
  const cached = reportChars.get(report);
  if (cached !== undefined) return cached;
  // `{"v":1,"kind":"render","surface":"","seq":,"registry":[],"elements":[],"tMs":}` and two numbers.
  let chars = 120 + report.surface.length;
  for (const name of report.registry) chars += name.length + 3;
  // `{"key":"","type":"","state":""},` — 32 characters of structure.
  for (const element of report.elements) chars += element.key.length + element.type.length + element.state.length + 32;
  reportChars.set(report, chars);
  return chars;
}

/**
 * Where a render ring, oldest first, should start: the newest reports that fit both `maxCount`
 * and `maxChars`, and always at least the newest one (a single report is bounded by the contract).
 */
export function renderRingStart(reports: readonly RenderDevtoolsReport[], maxCount: number, maxChars: number): number {
  let start = reports.length;
  let chars = 0;
  while (start > 0 && reports.length - start < maxCount) {
    const size = renderReportChars(reports[start - 1] as RenderDevtoolsReport);
    if (start < reports.length && chars + size > maxChars) break;
    chars += size;
    start -= 1;
  }
  return start;
}
