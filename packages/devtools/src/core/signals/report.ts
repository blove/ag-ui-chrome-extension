/**
 * The Threadplane devtools report — the one shape a Threadplane app in development mode hands the
 * extension, and the one place an untrusted value becomes that typed claim (design G2–G5).
 *
 * Pure, Chrome-free, DOM-free, so every boundary validates with the same grammar: the MAIN world
 * before posting, the relay before forwarding, the service worker before retaining. A shape
 * rejected at one boundary therefore cannot be accepted at another.
 *
 * WHAT IT CARRIES. Names and timing only (G2): which of an adapter's signals one event WROTE, never
 * what was written. Every field is either a fixed-vocabulary name, a bounded number, or a bounded
 * string the panel shows as text — `eventType` and `agent` are the only free-form fields, and both
 * are length-limited here so a hostile page cannot push an unbounded string into the panel.
 *
 * The page dispatches it as `CustomEvent('threadplane:devtools', { detail })` on `window` (G3).
 */

/** The `CustomEvent` name the hook dispatches on `window`. */
export const THREADPLANE_DEVTOOLS_EVENT = 'threadplane:devtools';

/**
 * LangGraph's signal names: the `subjects` bag in Threadplane's `agent.fn.ts`, without the `$`
 * (G4). The ORDER is the panel's row order, so it is part of the contract, not an accident of
 * how this list was typed.
 */
export const LANGGRAPH_SIGNALS = [
  'status',
  'values',
  'messages',
  'error',
  'interrupt',
  'interrupts',
  'branch',
  'history',
  'isThreadLoading',
  'toolProgress',
  'toolCalls',
  'messageMetadata',
  'subagents',
  'queue',
  'custom',
] as const;

/** AG-UI's signal names: the fields of Threadplane's `ReducerStore` (G4), in row order. */
export const AG_UI_SIGNALS = [
  'messages',
  'status',
  'isLoading',
  'error',
  'toolCalls',
  'state',
  'interrupt',
  'customEvents',
  'activities',
  'interruptSession',
] as const;

export type LangGraphSignal = (typeof LANGGRAPH_SIGNALS)[number];
export type AgUiSignal = (typeof AG_UI_SIGNALS)[number];
export type ThreadplaneAdapter = 'langgraph' | 'ag-ui';

export interface ThreadplaneDevtoolsReport {
  v: 1;
  /** Random per agent instance, 1–64 chars. Shown only as a grouping key. */
  agent: string;
  adapter: ThreadplaneAdapter;
  /** Per agent, starting at 1. */
  seq: number;
  /** The protocol event name, or a pseudo-event label (`run:start`, `reset`, …), 1–128 chars. */
  eventType: string;
  /** Distinct names from `adapter`'s vocabulary, in write order, 1–32 of them. */
  wrote: string[];
  /** `performance.now()` in the dispatching document — the same clock the capture stamps frames with. */
  tMs: number;
}

export const MAX_AGENT_LENGTH = 64;
export const MAX_EVENT_TYPE_LENGTH = 128;
export const MAX_WROTE = 32;

/** Exactly these keys, no more: a report carrying anything else is not this contract. */
const REPORT_KEYS: ReadonlySet<PropertyKey> = new Set([
  'v',
  'agent',
  'adapter',
  'seq',
  'eventType',
  'wrote',
  'tMs',
]);

/**
 * `Set`s rather than an `in` check or an object lookup, so a name like `constructor` or
 * `__proto__` can never match by way of a prototype.
 */
const VOCABULARY: Readonly<Record<ThreadplaneAdapter, ReadonlySet<string>>> = {
  langgraph: new Set<string>(LANGGRAPH_SIGNALS),
  'ag-ui': new Set<string>(AG_UI_SIGNALS),
};

/** Own-property check that does not go through the value's own `hasOwnProperty`. */
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isWrote(value: unknown, vocabulary: ReadonlySet<string>): value is string[] {
  if (!Array.isArray(value)) return false;
  // Length first, so a hostile array claiming a huge length costs nothing to reject.
  const length = value.length;
  if (length < 1 || length > MAX_WROTE) return false;
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    // Own index only: a hole, or an index supplied by a polluted `Array.prototype`, is not a name
    // the reporter wrote.
    if (!hasOwn(value, index)) return false;
    const name: unknown = value[index];
    if (typeof name !== 'string' || !vocabulary.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

function check(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // The exact key set, symbols included. `Reflect.ownKeys` rather than `Object.keys` so a
  // non-enumerable or symbol-keyed extra cannot hide from the count.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== REPORT_KEYS.size) return false;
  for (const key of keys) if (!REPORT_KEYS.has(key)) return false;

  const report = value as Record<string, unknown>;
  if (report['v'] !== 1) return false;
  if (!isBoundedString(report['agent'], MAX_AGENT_LENGTH)) return false;
  const adapter = report['adapter'];
  if (adapter !== 'langgraph' && adapter !== 'ag-ui') return false;
  const seq = report['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return false;
  if (!isBoundedString(report['eventType'], MAX_EVENT_TYPE_LENGTH)) return false;
  const tMs = report['tMs'];
  if (typeof tMs !== 'number' || !Number.isFinite(tMs) || tMs < 0) return false;
  return isWrote(report['wrote'], VOCABULARY[adapter]);
}

/**
 * Shape guard for a report from anywhere untrusted — the page's `CustomEvent`, a relayed message,
 * a session-storage mirror.
 *
 * Own-property strict with the EXACT key set, each name in its own adapter's vocabulary, every
 * limit enforced. It cannot throw: a hostile value may carry a throwing getter or be a `Proxy`
 * with hostile traps, and every caller is a listener that must survive one.
 *
 * Proving the shape does not prove a second read returns the same thing — a getter can answer
 * differently each time. A caller holding the page's own object therefore copies it with `cloneReport`
 * and re-checks the copy, which is plain data and answers consistently.
 */
export function isThreadplaneReport(value: unknown): value is ThreadplaneDevtoolsReport {
  try {
    return check(value);
  } catch {
    return false;
  }
}

/**
 * Rebuild a report from the contract's fields only — the relay's field-by-field copy, for this
 * shape. Reads each field exactly once and produces a plain object with plain arrays, so nothing
 * riding on the original (an extra array property, a prototype, an accessor) survives.
 */
export function cloneReport(report: ThreadplaneDevtoolsReport): ThreadplaneDevtoolsReport {
  const wrote: string[] = [];
  const source = report.wrote;
  const length = source.length;
  for (let index = 0; index < length; index += 1) wrote.push(source[index] as string);
  return {
    v: 1,
    agent: report.agent,
    adapter: report.adapter,
    seq: report.seq,
    eventType: report.eventType,
    wrote,
    tMs: report.tMs,
  };
}
