import { decodeJsonl, type JsonlEvent, type JsonlKeepalive } from '../../core/jsonl/codec';
import { createRunBuilder } from '../../core/normalizer/run-builder';
import type { AguiEvent, CaptureRecord, Issue, Run } from '../../core/model/types';

export interface LoadedCapture {
  runs: Run[];
  records: CaptureRecord[];
  issues: Issue[];
  /** One entry per malformed line, from `decodeJsonl`. Surfaced, never swallowed. */
  decodeErrors: string[];
}

/**
 * A decoded payload is `unknown` — the codec deliberately does not validate event shape. A
 * non-object payload becomes `null`, which is the `event` arm's own "could not be parsed"
 * value: the run builder still records such a frame and still surfaces it, rather than
 * dropping it or letting a cast smuggle a string in as an `AguiEvent`.
 */
function asAguiEvent(value: unknown): AguiEvent | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AguiEvent)
    : null;
}

/** A19: `CaptureRecord` is a union on `kind`, so an event record must say so explicitly. */
function toEventRecord(line: JsonlEvent): CaptureRecord {
  return {
    kind: 'event',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: line.event,
    event: asAguiEvent(line.event),
    issues: [],
  };
}

/**
 * `raw` is reconstituted as the SSE comment bytes the frame occupied on the wire (Task 12's
 * convention), so `totalStreamBytes` counts an imported keepalive identically to a captured one.
 */
function toKeepaliveRecord(line: JsonlKeepalive): CaptureRecord {
  return {
    kind: 'keepalive',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: `:${line.comment}\n\n`,
    comment: line.comment,
    issues: [],
  };
}

/**
 * Decode `.agui.jsonl` text and replay it through the SAME run-builder path live capture uses.
 *
 * This is the whole of P8: no Chrome API, no service worker, no injection — the panel's model
 * comes out of the identical fold, so a capture-layer bug can never be confused with a
 * rendering bug.
 *
 * Never throws. A line that will not decode contributes one entry to `decodeErrors` and the
 * remaining lines still load, which is what makes a truncated capture openable.
 */
export function loadJsonl(text: string, options: { expandChunks?: boolean } = {}): LoadedCapture {
  const { lines, errors } = decodeJsonl(text);
  const builder = createRunBuilder({ expandChunks: options.expandChunks ?? true });
  const records: CaptureRecord[] = [];
  /** Every connection's last observed frame time — the moment it is closed at. */
  const lastTMsByConn = new Map<string, number>();

  for (const line of lines) {
    if (line.kind === 'request') {
      builder.addRequest(line.connId, line.method, line.url, line.input);
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'event') {
      const record = toEventRecord(line);
      records.push(record);
      builder.addRecord(record);
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'keepalive') {
      // A keepalive is a real frame: it extends the connection's lifetime and it is what a
      // `keepalive-gap` anchors to, even though it never enters `recordSeqs`.
      const record = toKeepaliveRecord(line);
      records.push(record);
      builder.addRecord(record);
      lastTMsByConn.set(line.connId, line.tMs);
    }
    // A `header` line carries no record; the Session tab reads it separately.
  }

  // Closing is what runs `finalizeRules`, so an unterminated run reports `run-never-terminated`
  // instead of sitting silently in 'running'.
  for (const [connId, tMs] of lastTMsByConn) builder.closeConnection(connId, tMs);

  return { runs: builder.runs(), records, issues: builder.allIssues(), decodeErrors: errors };
}
