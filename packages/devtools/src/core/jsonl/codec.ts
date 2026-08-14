import type { RedactionGroup } from './redact';

export interface JsonlHeader {
  kind: 'header';
  schemaVersion: 1;
  tool: string;
  capturedAt: string;
  url: string;
  framework?: string;
  transport: 'sse' | 'binary';
  redacted: RedactionGroup[];
}

export interface JsonlRequest {
  kind: 'request';
  connId: string;
  tMs: number;
  method: string;
  url: string;
  input: unknown;
}

/**
 * Mirrors the `event` arm of `CaptureRecord`. `event` stays `unknown` rather than
 * `AguiEvent | null`: `CaptureRecord.event` is assignable to it on the encode side, and on
 * decode the payload is whatever the file happened to contain — this codec deliberately
 * does not validate event shape (that is `checkShape`'s job), so a narrower type here would
 * be a claim it cannot make good on.
 */
export interface JsonlEvent {
  kind: 'event';
  connId: string;
  seq: number;
  tMs: number;
  event: unknown;
}

/**
 * Mirrors the `keepalive` arm of `CaptureRecord` (A18/A19). Keepalives are recorded, not
 * dropped: requirements §5.4 requires them kept — and excluded from the event count — and
 * the whole point of retaining them is diagnosing proxy buffering after the fact.
 *
 * `seq` is part of the record, not an accident of ordering: `keepalive-gap` anchors to the
 * seq of the keepalive that closed the gap, so it must survive export and re-import.
 */
export interface JsonlKeepalive {
  kind: 'keepalive';
  connId: string;
  seq: number;
  tMs: number;
  /** The SSE comment body. Empty string for a bare `:` heartbeat. */
  comment: string;
}

export type JsonlLine = JsonlHeader | JsonlRequest | JsonlEvent | JsonlKeepalive;

const KNOWN_KINDS: ReadonlySet<string> = new Set(['header', 'request', 'event', 'keepalive']);

/**
 * One JSON object per line, trailing newline included. `JSON.stringify` escapes every
 * newline inside a string payload, so a record can never span two physical lines — that
 * is the property that makes JSONL safe for streams carrying multi-line model output.
 */
export function encodeJsonl(lines: JsonlLine[]): string {
  if (lines.length === 0) return '';
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/**
 * Blank lines are skipped. Every unparseable or unrecognized line contributes one message
 * to `errors` and decoding continues, so a truncated or corrupted capture still loads.
 */
export function decodeJsonl(text: string): { lines: JsonlLine[]; errors: string[] } {
  const lines: JsonlLine[] = [];
  const errors: string[] = [];

  // `entries()` walks the same indices in the same order as an index loop, but yields
  // `[number, string]` tuples — so `raw` is a `string` without a `!` or a `?? ''` default
  // that would quietly reclassify an out-of-range read as a blank line.
  const physical = text.split(/\r?\n/);
  for (const [i, raw] of physical.entries()) {
    const lineNo = i + 1;
    if (raw.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errors.push(`line ${lineNo}: invalid JSON: ${detail}`);
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`line ${lineNo}: not a JSONL record object`);
      continue;
    }

    const kind = (parsed as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
      errors.push(`line ${lineNo}: unrecognized kind ${JSON.stringify(kind)}`);
      continue;
    }

    lines.push(parsed as JsonlLine);
  }

  return { lines, errors };
}
