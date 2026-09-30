/**
 * Spec L2: the SSE event name survives export, import, re-export and redaction — and an older
 * file, which has no name anywhere, is untouched by the new field.
 */
import { describe, expect, test } from 'vitest';

import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import { decodeJsonl, encodeJsonl, type JsonlLine } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport } from './build';

/** A minimal LangGraph-shaped capture: one request, three named events. */
const LANGGRAPH_JSONL = [
  {
    kind: 'header',
    schemaVersion: 1,
    tool: 'ag-ui-devtools@0.1.0',
    capturedAt: '2026-09-29T12:00:00.000Z',
    url: 'http://localhost:2024',
    transport: 'sse',
    redacted: [],
  },
  {
    kind: 'request',
    connId: 'c1',
    tMs: 0,
    method: 'POST',
    url: 'http://localhost:2024/threads/t1/runs/stream',
    input: {
      assistant_id: 'agent',
      input: { messages: [{ type: 'human', content: 'tell me about the zanzibar quarterly forecast' }] },
    },
  },
  { kind: 'event', connId: 'c1', seq: 1, tMs: 5, sseEvent: 'metadata', event: { run_id: 'r1', attempt: 1 } },
  {
    kind: 'event',
    connId: 'c1',
    seq: 2,
    tMs: 9,
    sseEvent: 'messages',
    event: [
      { type: 'AIMessageChunk', id: 'm1', content: 'Hello from the model' },
      { langgraph_node: 'agent' },
    ],
  },
  { kind: 'event', connId: 'c1', seq: 3, tMs: 12, sseEvent: 'values', event: { messages: [] } },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

function reExport(text: string, groups: RedactionGroup[] = []): JsonlLine[] {
  const loaded = loadJsonl(text);
  return buildExport(
    {
      records: loaded.records,
      requests: loaded.requests,
      runs: loaded.runs,
      importedHeader: loaded.header,
      runtime: loaded.runtime,
      framework: null,
      binaryTransport: null,
      source: { kind: 'imported', filename: 'lg.agui.jsonl', importedAtMs: 0 },
    },
    { scope: null, groups, toolVersion: '0.1.0', exportedAtIso: '2026-09-29T12:00:00.000Z' },
  ).lines;
}

function namesOf(lines: readonly JsonlLine[]): (string | undefined)[] {
  return lines.flatMap((line) => (line.kind === 'event' ? [line.sseEvent] : []));
}

describe('the SSE event name in .agui.jsonl (L2)', () => {
  test('import puts it on the record', () => {
    const records = loadJsonl(LANGGRAPH_JSONL).records;
    expect(records.map((record) => (record.kind === 'event' ? record.sseEvent : null))).toEqual([
      'metadata',
      'messages',
      'values',
    ]);
  });

  test('export → import → export keeps every name, in order', () => {
    const once = reExport(LANGGRAPH_JSONL);
    expect(namesOf(once)).toEqual(['metadata', 'messages', 'values']);
    const twice = reExport(encodeJsonl(once));
    expect(namesOf(twice)).toEqual(['metadata', 'messages', 'values']);
  });

  test('redaction keeps the name: it is structure, not content', () => {
    expect(namesOf(reExport(LANGGRAPH_JSONL, [...ALL_REDACTION_GROUPS]))).toEqual([
      'metadata',
      'messages',
      'values',
    ]);
  });

  test('an AG-UI capture gains no sseEvent key on any line', () => {
    for (const line of reExport(happyJsonl)) {
      expect(Object.keys(line)).not.toContain('sseEvent');
    }
  });

  test('an imported name is untrusted: a non-string or "message" is dropped, the event kept', () => {
    const hostile = [
      JSON.stringify({ kind: 'event', connId: 'c1', seq: 1, tMs: 1, sseEvent: 42, event: { a: 1 } }),
      JSON.stringify({ kind: 'event', connId: 'c1', seq: 2, tMs: 2, sseEvent: 'message', event: { a: 2 } }),
    ].join('\n');
    const records = loadJsonl(hostile).records;
    expect(records).toHaveLength(2);
    for (const record of records) expect('sseEvent' in record).toBe(false);
  });

  test('the codec passes the key through without validating it, like every event field', () => {
    const { lines, errors } = decodeJsonl(LANGGRAPH_JSONL);
    expect(errors).toEqual([]);
    expect(namesOf(lines)).toEqual(['metadata', 'messages', 'values']);
  });

  test('redacting a LangGraph capture with every group removes its content but keeps sseEvent', () => {
    // Task 6b: redact.ts fails closed on payloads it does not recognise as AG-UI events. This
    // pins that a fully-redacted LangGraph export — the case PRIVACY.md's "redaction" section
    // describes — does not leak the model's message content into the exported file, while the
    // SSE event name (structure, not content) survives on every event line.
    const lines = reExport(LANGGRAPH_JSONL, [...ALL_REDACTION_GROUPS]);
    const file = encodeJsonl(lines);

    expect(file).not.toContain('Hello from the model');
    // The user's own prompt lives in the request body, not in any event.
    expect(file).not.toContain('zanzibar quarterly forecast');
    expect(namesOf(lines)).toEqual(['metadata', 'messages', 'values']);
  });
});
