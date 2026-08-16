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

    expect(loaded).toEqual({
      runs: [],
      records: [],
      requests: [],
      issues: [],
      header: null,
      runtime: null,
      decodeErrors: [],
    });
  });
});

describe('loadJsonl: what an export has to put back', () => {
  it('keeps the request lines, which hold the RunAgentInput no record carries', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    expect(loaded.requests).toEqual([
      {
        connId: 'c1',
        tMs: 0,
        method: 'POST',
        url: '/api/copilotkit/agent/default/run',
        input: {
          threadId: 't_happy',
          runId: 'r_happy',
          state: { counter: 0 },
          messages: [{ id: 'm_user_1', role: 'user', content: 'What is the weather in Paris?' }],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      },
    ]);
  });

  it('keeps the header, which is where E3 reads what was already redacted', () => {
    const loaded = loadJsonl(fixture('happy-run.agui.jsonl'));

    expect(loaded.header).toEqual({
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@0.1.0',
      capturedAt: '2026-08-13T10:00:00.000Z',
      url: 'http://localhost:3000/',
      framework: 'react/copilotkit',
      transport: 'sse',
      redacted: [],
    });
  });

  it('reports no header rather than inventing one when the file has none', () => {
    const loaded = loadJsonl(
      '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t","runId":"r"}}\n',
    );

    expect(loaded.header).toBeNull();
  });

  it('takes the FIRST header, because line 1 is the one the format specifies', () => {
    const two =
      '{"kind":"header","schemaVersion":1,"tool":"a","capturedAt":"1","url":"u1","transport":"sse","redacted":["text"]}\n' +
      '{"kind":"header","schemaVersion":1,"tool":"b","capturedAt":"2","url":"u2","transport":"sse","redacted":[]}\n';

    expect(loadJsonl(two).header?.url).toBe('u1');
  });
});

/**
 * The header is not only kept for export: it is an INPUT to the fold.
 *
 * `JsonlHeader.redacted` is the file's own statement about what was taken out of it, and the
 * validator needs it to know which of its claims the file can still support. This is the wire
 * between the two.
 */
describe('loadJsonl: the header tells the fold what evidence is missing', () => {
  const header = (redacted: string): string =>
    `{"kind":"header","schemaVersion":1,"tool":"t","capturedAt":"1","url":"u","transport":"sse","redacted":${redacted}}\n`;
  const body =
    '{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/a","input":{}}\n' +
    '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t","runId":"r"}}\n' +
    '{"kind":"event","connId":"c1","seq":2,"tMs":10,"event":{"type":"TOOL_CALL_START","toolCallId":"tc","toolCallName":"f"}}\n' +
    '{"kind":"event","connId":"c1","seq":3,"tMs":20,"event":{"type":"TOOL_CALL_ARGS","toolCallId":"tc","delta":"«redacted: 16 chars»"}}\n' +
    '{"kind":"event","connId":"c1","seq":4,"tMs":30,"event":{"type":"TOOL_CALL_END","toolCallId":"tc"}}\n' +
    '{"kind":"event","connId":"c1","seq":5,"tMs":40,"event":{"type":"RUN_FINISHED","threadId":"t","runId":"r"}}\n';

  it('carries the declared groups onto every run', () => {
    expect(loadJsonl(header('["text","toolArgs"]') + body).runs[0]?.redacted).toEqual([
      'text',
      'toolArgs',
    ]);
    expect(loadJsonl(fixture('happy-run.agui.jsonl')).runs[0]?.redacted).toEqual([]);
  });

  it('treats a file with no header as unredacted, which is the only safe reading', () => {
    // Nothing claims anything was removed, so every rule keeps its full voice. The arguments in
    // this file really do not parse and nobody has said otherwise.
    const loaded = loadJsonl(body);

    expect(loaded.header).toBeNull();
    expect(loaded.runs[0]?.redacted).toEqual([]);
    expect(key(loaded.issues)).toEqual(['tool-args-not-json@4']);
  });

  it('declines the tool-args claim when the header declares toolArgs redacted', () => {
    expect(key(loadJsonl(header('["toolArgs"]') + body).issues)).toEqual([]);
  });

  it('still makes the claim when the header names only groups that spared the arguments', () => {
    expect(key(loadJsonl(header('["text","reasoning","state"]') + body).issues)).toEqual([
      'tool-args-not-json@4',
    ]);
  });

  it('reads the header before folding, so a header out of position still counts', () => {
    // §10 puts the header on line 1 and the export writes it there. A capture that has been
    // concatenated or hand-edited must not quietly validate as though nothing was removed,
    // which is what folding first and reading the header afterwards would do.
    const late = body + header('["toolArgs"]');

    expect(key(loadJsonl(late).issues)).toEqual([]);
  });
});
