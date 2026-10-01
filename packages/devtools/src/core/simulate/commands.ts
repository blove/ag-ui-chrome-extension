/**
 * The run simulator's contract (§14.4, design R1–R4): the arm and disarm commands the extension
 * hands a Threadplane app in development, and the acknowledgements the app hands back.
 *
 * Pure, Chrome-free, DOM-free, so every boundary validates with the same grammar — the worker
 * before sending a panel's command on, the relay before dispatching it into the page, and the
 * relay again (and the worker after it) for every acknowledgement the page dispatches.
 *
 * ONE PASS, READING EACH FIELD ONCE. `report.ts` validates, copies, and re-validates the copy,
 * because a getter can answer the validator one thing and the copy another. A script is deeper
 * than a report — `data` is arbitrary JSON — so here the copy IS the validation: every property is
 * read through its DESCRIPTOR (never `obj[key]`, so no getter ever runs), only own, enumerable data
 * properties of plain objects and arrays are taken, and what is returned is the copy built from
 * those single reads. The copy is then checked once more, structurally, which is cheap because it
 * is plain data. A `Proxy` with hostile traps either throws (caught: rejected) or answers once.
 *
 * LIMITS (R3): at most `MAX_RUNS` runs, `MAX_ITEMS_PER_RUN` frames or events per run, and
 * `MAX_ARM_BYTES` UTF-8 bytes of JSON text for the whole command — the unit Threadplane's hook
 * measures in. The walk stops as soon as its running size passes `MAX_ARM_CHARS` characters (a
 * lower bound on the bytes), so a cyclic or enormous value costs no more than the limit to reject;
 * the exact byte count is taken once, on the finished copy.
 */
import type { ThreadplaneAdapter } from '../signals/report';

/** The event the extension dispatches on the page's `window` to script the next run(s) (R1). */
export const ARM_EVENT = 'threadplane:devtools:arm';
/** The event that withdraws an unconsumed arm (R3). */
export const DISARM_EVENT = 'threadplane:devtools:disarm';
/** The event the hook dispatches to say what became of an arm (R4). */
export const ACK_EVENT = 'threadplane:devtools:ack';

export const MAX_RUNS = 8;
export const MAX_ITEMS_PER_RUN = 5000;
/**
 * R3's "2 MB serialized": UTF-8 bytes of the command's JSON text, exactly as Threadplane's hook
 * counts them (`TextEncoder` over `JSON.stringify`), so a script the panel accepts is one the hook
 * accepts.
 */
export const MAX_ARM_BYTES = 2 * 1024 * 1024;
/**
 * The validating walk's early-exit budget, in characters of JSON text. Every character is at least
 * one UTF-8 byte, so passing this already means passing `MAX_ARM_BYTES`.
 */
export const MAX_ARM_CHARS = MAX_ARM_BYTES;
export const MAX_EVENT_NAME_LENGTH = 256;
export const MAX_REASON_LENGTH = 200;
/** Deep enough for any real LangGraph state; shallow enough that no walk can blow the stack. */
export const MAX_JSON_DEPTH = 64;

/** Printable, short, and safe to show as text: what the panel mints with `crypto.randomUUID()`. */
const ARM_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export type SimAdapter = ThreadplaneAdapter;

/** One LangGraph SSE frame as the SDK yields it: the event name and its parsed payload. */
export interface LangGraphFrameScript {
  event: string;
  data: unknown;
}

export interface LangGraphRunScript {
  frames: LangGraphFrameScript[];
}

/** One AG-UI event, as `onEvent` receives it. */
export interface AgUiEventScript {
  type: string;
  [key: string]: unknown;
}

export interface AgUiRunScript {
  events: AgUiEventScript[];
}

export type ArmCommand =
  | { v: 1; armId: string; adapter: 'langgraph'; runs: LangGraphRunScript[] }
  | { v: 1; armId: string; adapter: 'ag-ui'; runs: AgUiRunScript[] };

export interface DisarmCommand {
  v: 1;
  armId: string;
}

export const ACK_STATES = ['armed', 'consumed', 'expired', 'disarmed', 'rejected'] as const;
export type AckState = (typeof ACK_STATES)[number];

export interface Ack {
  v: 1;
  armId: string;
  state: AckState;
  /**
   * Which of the arm's runs this is about: a 0-BASED index into `runs`, `0` to `MAX_RUNS - 1` —
   * Threadplane's hook (cacheplane/threadplane#1204) acks the first run as `run: 0`. The panel
   * shows it 1-based ("consumed run 1 of 2").
   */
  run?: number;
  /** A short reason, for `rejected` above all. Shown as text, never interpreted. */
  reason?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/* -------------------------------------------------------------------------- */
/* Reading untrusted values without running them                                */
/* -------------------------------------------------------------------------- */

class Invalid extends Error {}

function fail(reason: string): never {
  throw new Invalid(reason);
}

const ACK_STATE_SET: ReadonlySet<string> = new Set(ACK_STATES);

/**
 * A plain object's own enumerable data properties, read through descriptors — so no getter runs —
 * or a rejection. A plain object is one whose prototype is `Object.prototype` or `null`: anything
 * else did not come from JSON or a structured clone.
 */
function ownData(value: unknown, what: string): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} is not an object`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${what} is not a plain object`);
  const out = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${what} has a symbol key`);
    // `__proto__` is legal JSON and a trap everywhere a copy is built by assignment. No real
    // LangGraph or AG-UI payload carries one, so it is refused rather than handled.
    if (key === '__proto__') fail(`${what} has a __proto__ key`);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) fail(`${what}.${key} is not a data property`);
    if (descriptor.enumerable !== true) fail(`${what}.${key} is not enumerable`);
    out.set(key, descriptor.value);
  }
  return out;
}

/** An array's elements, read through descriptors, at most `max` of them. */
function ownItems(value: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} is not an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${what} is not a plain array`);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length)) fail(`${what} has no length`);
  if (length > max) fail(`${what} has ${String(length)} items; the limit is ${String(max)}`);
  const keys = Reflect.ownKeys(value);
  // Exactly the indices plus `length`: no extra property rides along.
  if (keys.length !== length + 1) fail(`${what} has holes or extra properties`);
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) fail(`${what}[${String(index)}] is not a data element`);
    items.push(descriptor.value);
  }
  return items;
}

function exactKeys(fields: Map<string, unknown>, required: readonly string[], optional: readonly string[], what: string): void {
  for (const key of required) if (!fields.has(key)) fail(`${what} is missing "${key}"`);
  const allowed = new Set([...required, ...optional]);
  for (const key of fields.keys()) if (!allowed.has(key)) fail(`${what} has an unexpected key "${key}"`);
}

/** A running total of JSON text, so the walk stops the moment it passes the limit. */
interface Budget {
  chars: number;
}

function spend(budget: Budget, chars: number): void {
  budget.chars += chars;
  if (budget.chars > MAX_ARM_CHARS) fail(`the command is larger than ${String(MAX_ARM_CHARS)} characters of JSON`);
}

/**
 * A JSON value, copied. Rejects anything JSON would not round-trip unchanged: `undefined`, a
 * function, a symbol, a bigint, a non-finite number, a class instance, an accessor.
 */
function cloneJson(value: unknown, budget: Budget, depth: number, what: string): unknown {
  if (depth > MAX_JSON_DEPTH) fail(`${what} is nested deeper than ${String(MAX_JSON_DEPTH)}`);
  if (value === null) {
    spend(budget, 4);
    return null;
  }
  switch (typeof value) {
    case 'boolean':
      spend(budget, 5);
      return value;
    case 'number':
      if (!Number.isFinite(value)) fail(`${what} is not a finite number`);
      spend(budget, String(value).length);
      return value;
    case 'string':
      // The cost of the quotes and the text; escapes are not counted, which only errs generous.
      spend(budget, value.length + 2);
      return value;
    case 'object':
      break;
    default:
      fail(`${what} is not JSON (${typeof value})`);
  }
  if (Array.isArray(value)) {
    const items = ownItems(value, MAX_ARM_CHARS, what);
    spend(budget, 2 + items.length);
    return items.map((item, index) => cloneJson(item, budget, depth + 1, `${what}[${String(index)}]`));
  }
  const fields = ownData(value, what);
  const out: Record<string, unknown> = {};
  for (const [key, field] of fields) {
    spend(budget, key.length + 4);
    out[key] = cloneJson(field, budget, depth + 1, `${what}.${key}`);
  }
  return out;
}

function boundedString(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${what} must be a string of 1–${String(max)} characters`);
  }
  return value;
}

function armId(value: unknown): string {
  if (typeof value !== 'string' || !ARM_ID.test(value)) {
    fail('armId must be 1–64 characters of A–Z, a–z, 0–9, ".", "_", ":" or "-"');
  }
  return value;
}

function version(value: unknown): 1 {
  if (value !== 1) fail('v must be 1');
  return 1;
}

/* -------------------------------------------------------------------------- */
/* Arm                                                                          */
/* -------------------------------------------------------------------------- */

function readLangGraphRun(value: unknown, budget: Budget, what: string): LangGraphRunScript {
  const fields = ownData(value, what);
  exactKeys(fields, ['frames'], [], what);
  const frames = ownItems(fields.get('frames'), MAX_ITEMS_PER_RUN, `${what}.frames`).map((frame, index) => {
    const at = `${what}.frames[${String(index)}]`;
    const frameFields = ownData(frame, at);
    exactKeys(frameFields, ['event', 'data'], [], at);
    const event = boundedString(frameFields.get('event'), MAX_EVENT_NAME_LENGTH, `${at}.event`);
    spend(budget, event.length + 20);
    return { event, data: cloneJson(frameFields.get('data'), budget, 1, `${at}.data`) };
  });
  if (frames.length === 0) fail(`${what}.frames is empty`);
  return { frames };
}

function readAgUiRun(value: unknown, budget: Budget, what: string): AgUiRunScript {
  const fields = ownData(value, what);
  exactKeys(fields, ['events'], [], what);
  const events = ownItems(fields.get('events'), MAX_ITEMS_PER_RUN, `${what}.events`).map((event, index) => {
    const at = `${what}.events[${String(index)}]`;
    const copy = cloneJson(event, budget, 1, at);
    if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) fail(`${at} is not an object`);
    const record = copy as Record<string, unknown>;
    boundedString(record['type'], MAX_EVENT_NAME_LENGTH, `${at}.type`);
    return record as AgUiEventScript;
  });
  if (events.length === 0) fail(`${what}.events is empty`);
  return { events };
}

function readArm(value: unknown): ArmCommand {
  const budget: Budget = { chars: 0 };
  const fields = ownData(value, 'the command');
  exactKeys(fields, ['v', 'armId', 'adapter', 'runs'], [], 'the command');
  const v = version(fields.get('v'));
  const id = armId(fields.get('armId'));
  const adapter = fields.get('adapter');
  const runs = ownItems(fields.get('runs'), MAX_RUNS, 'runs');
  if (runs.length === 0) fail('runs is empty');
  if (adapter === 'langgraph') {
    return { v, armId: id, adapter, runs: runs.map((run, index) => readLangGraphRun(run, budget, `runs[${String(index)}]`)) };
  }
  if (adapter === 'ag-ui') {
    return { v, armId: id, adapter, runs: runs.map((run, index) => readAgUiRun(run, budget, `runs[${String(index)}]`)) };
  }
  fail('adapter must be "langgraph" or "ag-ui"');
}

/** The UTF-8 length of `value`'s JSON text — what the arm limit is measured in. */
export function armBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function attempt<T>(read: (value: unknown) => T, value: unknown): Parsed<T> {
  try {
    return { ok: true, value: read(value) };
  } catch (error) {
    // A hostile value's trap or getter may throw anything; only our own reasons are shown.
    return { ok: false, reason: error instanceof Invalid ? error.message : 'the value is not plain data' };
  }
}

/**
 * Validate an arm command and return a plain copy of it, or say why not.
 *
 * Never throws. The copy is re-read once more — it is plain data, so this costs a walk and proves
 * the copy satisfies the same grammar the original was held to — and its JSON text is measured
 * exactly, in UTF-8 bytes, against `MAX_ARM_BYTES`.
 */
export function parseArmCommand(value: unknown): Parsed<ArmCommand> {
  const first = attempt(readArm, value);
  if (!first.ok) return first;
  const second = attempt(readArm, first.value);
  if (!second.ok) return second;
  if (armBytes(second.value) > MAX_ARM_BYTES) {
    return { ok: false, reason: `the command is larger than ${String(MAX_ARM_BYTES)} bytes of JSON` };
  }
  return second;
}

export function isArmCommand(value: unknown): value is ArmCommand {
  return parseArmCommand(value).ok;
}

/* -------------------------------------------------------------------------- */
/* Disarm and ack                                                               */
/* -------------------------------------------------------------------------- */

function readDisarm(value: unknown): DisarmCommand {
  const fields = ownData(value, 'the disarm command');
  exactKeys(fields, ['v', 'armId'], [], 'the disarm command');
  return { v: version(fields.get('v')), armId: armId(fields.get('armId')) };
}

export function parseDisarmCommand(value: unknown): Parsed<DisarmCommand> {
  return attempt(readDisarm, value);
}

function readAck(value: unknown): Ack {
  const fields = ownData(value, 'the ack');
  exactKeys(fields, ['v', 'armId', 'state'], ['run', 'reason'], 'the ack');
  const state = fields.get('state');
  if (typeof state !== 'string' || !ACK_STATE_SET.has(state)) fail('state is not an ack state');
  const ack: Ack = { v: version(fields.get('v')), armId: armId(fields.get('armId')), state: state as AckState };
  if (fields.has('run')) {
    const run = fields.get('run');
    // A 0-based index into the arm's runs, so `0`–`MAX_RUNS - 1`. A small integer the panel shows,
    // never an index it follows.
    if (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 0 || run >= MAX_RUNS) {
      fail(`run must be an integer from 0 to ${String(MAX_RUNS - 1)}`);
    }
    ack.run = run;
  }
  if (fields.has('reason')) ack.reason = boundedString(fields.get('reason'), MAX_REASON_LENGTH, 'reason');
  return ack;
}

/** Validate an acknowledgement and return a plain copy, or say why not. Never throws. */
export function parseAck(value: unknown): Parsed<Ack> {
  return attempt(readAck, value);
}

export function isAck(value: unknown): value is Ack {
  return parseAck(value).ok;
}
