/**
 * Display formatting for panel rows.
 *
 * Everything here is pure and DOM-free. `summarizeEvent` in particular is the one-line
 * summary column of design §3's event list, and it is capped hard: a row that grows to fit
 * a 40kB tool-call argument blob would break the fixed row height virtualization depends on.
 */
import type { AguiEvent, CaptureRecord } from '../../core/model/types';

/** Contract cap: a summary must fit one list row. Never exceeded, including the ellipsis. */
const MAX_SUMMARY_CHARS = 80;

/** `1.84s`, `240ms`, `—` for undefined. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';

  // Round before branching: 999.6ms is `1.00s`, not `1000ms`.
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;

  // 59.995 rather than 60: 59999ms renders as `60.00s` at two decimals, which should have
  // promoted to `1m 0s`.
  const seconds = ms / 1000;
  if (seconds < 59.995) return `${seconds.toFixed(2)}s`;

  const totalSeconds = Math.round(seconds);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * Decimal units, matching how Chrome's own Network panel reports transfer sizes — the panel
 * sits next to it and disagreeing by 2.4% on the same bytes would read as a bug.
 */
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** `12.4 kB`, `840 B`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1000) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  // 999.95 rather than 1000: 999999 B rounds to `1000.0 kB` at one decimal, which should
  // have promoted to `1 MB`.
  while (value >= 999.95 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return `${value.toFixed(1).replace(/\.0$/, '')} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** Identity of the thing the event is about. First match wins. */
const ID_KEYS = ['messageId', 'toolCallId', 'runId', 'threadId'] as const;
/** A bare name or label that reads better unquoted. */
const NAME_KEYS = ['toolCallName', 'stepName', 'activityType', 'role'] as const;
/** The payload itself. Quoted when it is text, compact JSON otherwise. */
const VALUE_KEYS = [
  'delta',
  'content',
  'message',
  'reason',
  'result',
  'value',
  'snapshot',
  'args',
] as const;

/**
 * One-line summary of an event for a list row, e.g. `m_1 · "Hello"` — never longer than 80
 * chars. The event *type* is a separate column (design §3), so it is deliberately not
 * repeated here.
 */
export function summarizeEvent(record: CaptureRecord): string {
  if (record.kind === 'keepalive') {
    const comment = collapse(record.comment);
    return truncate(comment === '' ? 'keepalive' : `keepalive · ${comment}`, MAX_SUMMARY_CHARS);
  }

  const event = record.event;
  // A frame whose payload would not parse is still shown, per the model's own comment.
  if (event === null) return 'unparsed payload';

  const parts: string[] = [];
  const id = pickString(event, ID_KEYS);
  if (id !== undefined) parts.push(sliceUnits(collapse(id), MAX_SUMMARY_CHARS));
  const name = pickString(event, NAME_KEYS);
  if (name !== undefined) parts.push(sliceUnits(collapse(name), MAX_SUMMARY_CHARS));
  const value = pickValue(event, VALUE_KEYS);
  if (value !== undefined) {
    const rendered = renderValue(value);
    // A value that renders to nothing must not leave a dangling separator.
    if (rendered !== '') parts.push(rendered);
  }

  return truncate(parts.join(' · '), MAX_SUMMARY_CHARS);
}

function pickString(event: AguiEvent, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickValue(event: AguiEvent, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (event[key] !== undefined) return event[key];
  }
  return undefined;
}

function renderValue(value: unknown): string {
  // The quotes push a full-length string part to 82 units, past the cap and into `truncate`'s
  // own repair, so this is the one pre-slice that cannot strand a surrogate. Verified by the
  // offset sweep in the tests, which covers this branch too.
  if (typeof value === 'string') return `"${collapse(value).slice(0, MAX_SUMMARY_CHARS)}"`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    // `STATE_DELTA.delta` is an array of patch ops, not text, so the value branch has to
    // cope with structure as well as strings.
    const json = JSON.stringify(value);
    if (json === undefined) return '';
    return sliceUnits(collapse(json), MAX_SUMMARY_CHARS);
  } catch {
    // Circular structures reach here; a summary is never worth throwing over.
    return '[unserializable]';
  }
}

/** Newlines and runs of whitespace would break the single-line row. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `slice(0, max)` that refuses to cut a surrogate pair in half.
 *
 * Every branch that caps its own part before the parts are joined needs this: a part that
 * lands on exactly `max` units makes the joined text exactly `max` long, `truncate` returns
 * early on `text.length <= max`, and its repair never runs — so a half emoji reaches the row
 * and renders as a replacement box.
 */
function sliceUnits(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  // Never leave a lone high surrogate: an emoji cut in half renders as a replacement box.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
