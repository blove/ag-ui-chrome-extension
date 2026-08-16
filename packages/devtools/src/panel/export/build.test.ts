import { describe, expect, test } from 'vitest';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// rewritten and the relative URL no longer resolves.
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import type { JsonlEvent, JsonlHeader, JsonlLine, JsonlRequest } from '../../core/jsonl/codec';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport, exportBlockedReason, type ExportSource } from './build';

const OPTIONS = { toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' };

/** An imported capture, exactly as the panel would hold it. */
function importedSource(text = happyJsonl): ExportSource {
  const loaded = loadJsonl(text);
  return {
    records: loaded.records,
    requests: loaded.requests,
    runs: loaded.runs,
    importedHeader: loaded.header,
    runtime: loaded.runtime,
    framework: null,
    binaryTransport: null,
    source: { kind: 'imported', filename: 'happy-run.agui.jsonl', importedAtMs: 0 },
  };
}

/** The same stream as a LIVE capture: same records, no file and therefore no header. */
function liveSource(): ExportSource {
  return { ...importedSource(), importedHeader: null, source: { kind: 'live', origin: 'http://localhost:3000' } };
}

function headerOf(lines: JsonlLine[]): JsonlHeader {
  const first = lines[0];
  if (first === undefined || first.kind !== 'header') throw new Error('line 1 is not a header');
  return first;
}

function eventsOf(lines: JsonlLine[]): JsonlEvent[] {
  return lines.filter((line): line is JsonlEvent => line.kind === 'event');
}

function requestsOf(lines: JsonlLine[]): JsonlRequest[] {
  return lines.filter((line): line is JsonlRequest => line.kind === 'request');
}

describe('buildExport: shape', () => {
  test('line 1 is the header, per requirements §10', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    expect(headerOf(lines).kind).toBe('header');
  });

  test('request lines come before the records, so a run is never seen without its input', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    // seq 11 is the keepalive; records are emitted in seq order, so it lands in the middle.
    expect(lines.map((line) => line.kind)).toEqual([
      'header',
      'request',
      ...Array<string>(10).fill('event'),
      'keepalive',
      ...Array<string>(4).fill('event'),
    ]);
  });

  test('records are emitted in seq order, keepalive included, exactly once each', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    const seqs = lines.flatMap((line) =>
      line.kind === 'event' || line.kind === 'keepalive' ? [line.seq] : [],
    );
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test('a keepalive is re-emitted as a keepalive line, not as an event', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    const keepalive = lines.find((line) => line.kind === 'keepalive');
    expect(keepalive).toEqual({ kind: 'keepalive', connId: 'c1', seq: 11, tMs: 220, comment: 'ping' });
  });

  test('E2: a live capture re-encodes to the same lines as the imported one, having no bytes to pass through', () => {
    const imported = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    const live = buildExport(liveSource(), { scope: null, groups: [], ...OPTIONS });
    expect(live.lines.slice(1)).toEqual(imported.lines.slice(1));
  });

  test('counts what is going in the file, so the UI can state it before the click', () => {
    const built = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    expect(built.counts).toEqual({ events: 14, keepalives: 1, requests: 1, runs: 1 });
  });
});

describe('buildExport: scope (E4)', () => {
  test('a run scope keeps exactly that run’s records, per Run.recordSeqs', () => {
    const source = importedSource();
    const { lines } = buildExport(source, { scope: 'r_happy', groups: [], ...OPTIONS });
    const run = source.runs[0];
    if (run === undefined) throw new Error('the fixture has no run');
    expect(eventsOf(lines).map((line) => line.seq)).toEqual(run.recordSeqs);
  });

  test('a run scope keeps the keepalives inside the run’s span — the gap signal is the reason they are recorded', () => {
    const { lines } = buildExport(importedSource(), { scope: 'r_happy', groups: [], ...OPTIONS });
    expect(lines.filter((line) => line.kind === 'keepalive').map((line) => line.seq)).toEqual([11]);
  });

  test('a run scope keeps only its own connection’s request line', () => {
    const { lines } = buildExport(importedSource(), { scope: 'r_happy', groups: [], ...OPTIONS });
    expect(requestsOf(lines).map((line) => line.connId)).toEqual(['c1']);
  });

  test('a scope naming a run that is not here exports no records rather than silently exporting all of them', () => {
    const { counts } = buildExport(importedSource(), { scope: 'r_gone', groups: [], ...OPTIONS });
    expect(counts).toEqual({ events: 0, keepalives: 0, requests: 0, runs: 0 });
  });

  test('two runs on two connections: scoping to one drops the other’s records and request', () => {
    const second =
      '{"kind":"request","connId":"c2","tMs":500,"method":"POST","url":"/run","input":{"threadId":"t2","runId":"r_2","messages":[]}}\n' +
      '{"kind":"event","connId":"c2","seq":16,"tMs":510,"event":{"type":"RUN_STARTED","threadId":"t2","runId":"r_2"}}\n' +
      '{"kind":"event","connId":"c2","seq":17,"tMs":520,"event":{"type":"RUN_FINISHED","threadId":"t2","runId":"r_2"}}\n';
    const source = importedSource(happyJsonl + second);

    const { lines, counts } = buildExport(source, { scope: 'r_2', groups: [], ...OPTIONS });

    expect(requestsOf(lines).map((line) => line.connId)).toEqual(['c2']);
    expect(eventsOf(lines).map((line) => line.seq)).toEqual([16, 17]);
    expect(counts.runs).toBe(1);
  });
});

describe('buildExport: redaction (E4 — a modifier, not a scope)', () => {
  test('replaces text deltas while structure, ids and timings survive', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: ['text'], ...OPTIONS });
    const content = eventsOf(lines).find(
      (line) => (line.event as { type?: string }).type === 'TEXT_MESSAGE_CONTENT',
    );
    expect(content?.event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: '«redacted: 20 chars»',
    });
    expect(content?.seq).toBe(3);
    expect(content?.tMs).toBe(55);
  });

  test('redacts the request body too — the user’s own prompt lives there, not in any event', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: ['text'], ...OPTIONS });
    const input = requestsOf(lines)[0]?.input as { messages?: { content?: unknown }[] };
    expect(input.messages?.[0]?.content).toBe('«redacted: 29 chars»');
  });

  test('redaction combines with a run scope rather than replacing it', () => {
    const { lines, counts } = buildExport(importedSource(), {
      scope: 'r_happy',
      groups: ['text', 'state'],
      ...OPTIONS,
    });
    expect(counts.events).toBe(14);
    expect(headerOf(lines).redacted).toEqual(['text', 'state']);
  });

  test('an unredacted export says so in the header', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    expect(headerOf(lines).redacted).toEqual([]);
  });

  test('E3: re-exporting an already-redacted capture unions the header groups', () => {
    const alreadyRedacted = happyJsonl.replace('"redacted":[]', '"redacted":["state"]');
    const { lines } = buildExport(importedSource(alreadyRedacted), {
      scope: null,
      groups: ['text'],
      ...OPTIONS,
    });
    expect(headerOf(lines).redacted).toEqual(['text', 'state']);
  });
});

describe('buildExport: provenance', () => {
  test('an imported capture keeps the origin and moment it was captured at', () => {
    const { lines } = buildExport(importedSource(), { scope: null, groups: [], ...OPTIONS });
    expect(headerOf(lines).url).toBe('http://localhost:3000/');
    expect(headerOf(lines).capturedAt).toBe('2026-08-13T10:00:00.000Z');
  });

  test('a live capture is stamped with the inspected origin and the export moment', () => {
    const { lines } = buildExport(liveSource(), { scope: null, groups: [], ...OPTIONS });
    expect(headerOf(lines).url).toBe('http://localhost:3000');
    expect(headerOf(lines).capturedAt).toBe('2026-08-15T12:00:00.000Z');
  });

  test('a capture that saw a binary transport says so, because it holds no decoded events', () => {
    const source: ExportSource = {
      ...liveSource(),
      binaryTransport: { connId: 'c9', tMs: 1, contentType: 'application/x-protobuf', bytes: 42 },
    };
    expect(headerOf(buildExport(source, { scope: null, groups: [], ...OPTIONS }).lines).transport).toBe(
      'binary',
    );
  });
});

describe('exportBlockedReason', () => {
  test('is null when there is something to export', () => {
    expect(exportBlockedReason(importedSource(), null)).toBeNull();
  });

  test('states the reason for an empty capture rather than emitting a zero-record file', () => {
    const empty: ExportSource = {
      records: [],
      requests: [],
      runs: [],
      importedHeader: null,
      runtime: null,
      framework: null,
      binaryTransport: null,
      source: { kind: 'empty' },
    };
    expect(exportBlockedReason(empty, null)).toBe(
      'Nothing has been captured yet, so there is nothing to export.',
    );
  });

  test('states the reason when the scoped run holds no records', () => {
    expect(exportBlockedReason(importedSource(), 'r_gone')).toBe(
      'The selected run holds no records, so there is nothing to export. Switch the scope to all runs.',
    );
  });
});
