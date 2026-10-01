/**
 * Fold a committed `.agui.jsonl` fixture into what the panel holds — records, request lines and
 * runs — with core/ alone, the way `panel/import/load-jsonl.ts` does (minus its line validation,
 * which a committed fixture does not need). core/ tests cannot import the panel.
 */
import { readFileSync } from 'node:fs';
import { decodeJsonl } from '../core/jsonl/codec';
import type { AguiEvent, CaptureRecord, Run } from '../core/model/types';
import { createRunBuilder } from '../core/normalizer/run-builder';
import { normalizeEventName } from '../core/sse/event-name';

export interface LoadedFixture {
  records: CaptureRecord[];
  requests: Array<{ connId: string; tMs: number; method: string; url: string; input: unknown }>;
  runs: Run[];
  bytes: number;
}

export function loadFixture(name: string): LoadedFixture {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const { lines, errors } = decodeJsonl(text);
  if (errors.length > 0) throw new Error(`${name}: ${errors.join('; ')}`);
  const builder = createRunBuilder();
  const records: CaptureRecord[] = [];
  const requests: LoadedFixture['requests'] = [];
  const lastTMs = new Map<string, number>();
  for (const line of lines) {
    if (line.kind === 'request') {
      requests.push({ connId: line.connId, tMs: line.tMs, method: line.method, url: line.url, input: line.input });
      builder.addRequest(line.connId, line.method, line.url, line.input);
      lastTMs.set(line.connId, line.tMs);
    } else if (line.kind === 'event') {
      const sseEvent = normalizeEventName(line.sseEvent);
      const event = line.event;
      const record: CaptureRecord = {
        kind: 'event',
        seq: line.seq,
        tMs: line.tMs,
        connId: line.connId,
        raw: event,
        // As the panel's `asAguiEvent`: any object is an event; an array (a LangGraph tuple) is not.
        event: typeof event === 'object' && event !== null && !Array.isArray(event) ? (event as AguiEvent) : null,
        ...(sseEvent !== undefined ? { sseEvent } : {}),
        issues: [],
      };
      records.push(record);
      builder.addRecord(record);
      lastTMs.set(line.connId, line.tMs);
    }
  }
  for (const [connId, tMs] of lastTMs) builder.closeConnection(connId, tMs);
  return { records, requests, runs: builder.runs(), bytes: Buffer.byteLength(text) };
}
