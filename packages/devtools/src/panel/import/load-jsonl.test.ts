// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { loadJsonl } from './load-jsonl';

function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');
}

const key = (issues: { code: string; seq: number }[]): string[] =>
  issues.map((issue) => `${issue.code}@${issue.seq}`).sort();

describe('loadJsonl: happy-run', () => {
  it('rebuilds one clean run with its records in seq order', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.issues).toEqual([]);
    expect(loaded.runs).toHaveLength(1);

    const run = loaded.runs[0]!;
    expect(run.runId).toBe('r_happy');
    expect(run.threadId).toBe('t_happy');
    expect(run.outcome).toBe('finished');
    expect(run.messages.get('m_1')?.content).toBe(
      'The weather in Paris is sunny and 24 degrees.\nEnjoy!',
    );
    expect(run.toolCalls.get('tc_1')?.args).toEqual({ city: 'Paris', units: 'metric' });

    // Header and request lines are not records; every event and keepalive line is one.
    expect(loaded.records.map((record) => record.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('keeps the keepalive as a record but out of recordSeqs', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    const keepalive = loaded.records.find((record) => record.kind === 'keepalive');
    expect(keepalive).toBeDefined();
    expect(keepalive?.seq).toBe(11);
    // A19: the union is what makes `comment` reachable at all.
    expect(keepalive?.kind === 'keepalive' ? keepalive.comment : undefined).toBe('ping');

    expect(loaded.runs[0]!.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
    expect(loaded.runs[0]!.recordSeqs).not.toContain(11);
  });

  it('carries the POST body through as the run input', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    expect((loaded.runs[0]!.input as { threadId?: string }).threadId).toBe('t_happy');
  });
});

describe('loadJsonl: malformed', () => {
  it('surfaces exactly the three issues the integration test pins', () => {
    const loaded = loadJsonl(fixture('malformed.agui.jsonl'));

    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.issues).toHaveLength(3);
    expect(key(loaded.issues)).toEqual([
      'empty-text-delta@5',
      'run-never-terminated@10',
      'state-patch-failed@9',
    ]);

    expect(loaded.runs).toHaveLength(1);
    const run = loaded.runs[0]!;
    expect(run.runId).toBe('r_bad');
    // The connection is closed at the last frame's tMs, so a run still 'running' aborts.
    expect(run.outcome).toBe('aborted');
    // Every issue is attributed to the run that raised it, which is what `scopedIssues` reads.
    expect(loaded.issues.every((issue) => issue.runId === 'r_bad')).toBe(true);
  });
});

describe('loadJsonl: chunked-run', () => {
  it('reconstructs message content and parsed tool args with expandChunks: true', () => {
    const loaded = loadJsonl(fixture('chunked-run.agui.jsonl'), { expandChunks: true });

    expect(loaded.decodeErrors).toEqual([]);
    expect(loaded.issues).toEqual([]);
    expect(loaded.runs).toHaveLength(1);

    const run = loaded.runs[0]!;
    expect(run.runId).toBe('r_chunk');
    expect(run.outcome).toBe('finished');
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const message = run.messages.get('m_1');
    expect(message?.content).toBe('Hello, world!');
    expect(message?.closed).toBe(true);

    const toolCall = run.toolCalls.get('tc_1');
    expect(toolCall?.toolCallName).toBe('search_docs');
    expect(toolCall?.closed).toBe(true);
    expect(toolCall?.args).toEqual({ q: 'ag-ui', limit: 5 });
    expect(toolCall?.argsParseError).toBeUndefined();
  });

  it('leaves the chunks unexpanded when expandChunks is false', () => {
    const loaded = loadJsonl(fixture('chunked-run.agui.jsonl'), { expandChunks: false });

    const run = loaded.runs[0]!;
    expect(run.messages.size).toBe(0);
    expect(run.toolCalls.size).toBe(0);
    // The raw records are unchanged either way — only the model built from them differs.
    expect(loaded.records).toHaveLength(7);
  });
});

describe('loadJsonl: bad input', () => {
  it('reports a malformed line in decodeErrors and still loads the rest', () => {
    const text = [
      '{"kind":"event","connId":"c1","seq":1,"tMs":1,"event":{"type":"RUN_STARTED","threadId":"t","runId":"r"}}',
      '{oops',
      '{"kind":"event","connId":"c1","seq":2,"tMs":2,"event":{"type":"RUN_FINISHED","threadId":"t","runId":"r"}}',
    ].join('\n');

    const loaded = loadJsonl(text);

    expect(loaded.decodeErrors).toHaveLength(1);
    expect(loaded.decodeErrors[0]).toContain('line 2');
    expect(loaded.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0]!.outcome).toBe('finished');
  });

  it('returns empty everything for an empty string', () => {
    const loaded = loadJsonl('');

    expect(loaded).toEqual({ runs: [], records: [], issues: [], decodeErrors: [] });
  });
});
