import type { RuntimeInfo } from '../detect/info';
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
  /**
   * What a `/info` agent-discovery response said, when the capture saw one.
   *
   * IN THE HEADER, AND NOT A NEW LINE KIND. The header already carries exactly this class of
   * fact — `framework`, `transport`, `url`, `capturedAt` are all session-scoped metadata rather
   * than stream content — and this is one more of them: one per capture, not one per frame, with
   * no `seq` and no place in the Timeline.
   *
   * The alternative was a fifth `kind`, and the deciding argument is what an OLDER decoder does
   * with each. `decodeJsonl` below rejects any line whose `kind` is not in `KNOWN_KINDS` and
   * records an error for it, so a new line kind would make every capture written by this build
   * open in an older build with a spurious "unrecognized kind" — a file that is perfectly intact
   * reporting itself as damaged, which is precisely the untruth `applyLoaded`'s partial-decode
   * warning exists to tell. An unknown OBJECT KEY, by contrast, is ignored by every JSON decoder
   * ever written: an older build reads the header, ignores this, and shows the capture exactly as
   * it did before. That is why `schemaVersion` stays 1 — nothing about the format changed for a
   * reader, only something was added for one that knows to look.
   *
   * Optional and absent-rather-than-null: most captures have nothing to put here, and a `null`
   * would decode as a claim that discovery ran and reported nothing.
   *
   * NEVER REDACTED. §11's five groups are text, reasoning, toolArgs, toolResults and state, and
   * none of them covers developer-authored metadata — the same reasoning that keeps `tools` in
   * `redactInput`. See `core/detect/info.ts` for the full argument.
   */
  runtime?: RuntimeInfo;
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
