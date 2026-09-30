/**
 * LangGraph Platform captures, end to end through `loadJsonl` — the same fold live capture uses.
 */
import { describe, expect, it } from 'vitest';

import happyJsonl from './fixtures/happy-run.agui.jsonl?raw';
import lgReasoningJsonl from './fixtures/lg-reasoning.agui.jsonl?raw';
import lgReasoningCanonical from './fixtures/lg-reasoning.canonical.txt?raw';
import { encodeJsonl } from '../core/jsonl/codec';
import type { Run } from '../core/model/types';
import { buildExport } from '../panel/export/build';
import { loadJsonl } from '../panel/import/load-jsonl';
import { aiChunk, langGraphJsonl, type LangGraphTestFrame } from './langgraph-capture';

function load(frames: readonly LangGraphTestFrame[], options = {}): ReturnType<typeof loadJsonl> {
  return loadJsonl(langGraphJsonl(frames, options));
}

function only(loaded: ReturnType<typeof loadJsonl>): Run {
  expect(loaded.runs).toHaveLength(1);
  return loaded.runs[0]!;
}

const codes = (run: Run): Array<[string, number]> => run.issues.map((issue) => [issue.code, issue.seq]);

describe('LangGraph: text and reasoning', () => {
  const frames: LangGraphTestFrame[] = [
    { event: 'metadata', data: { run_id: 'r-1', attempt: 1 } },
    { event: 'values', data: { messages: [{ type: 'human', content: 'hi', id: 'h1' }] } },
    aiChunk('resp_x', []),
    aiChunk('m1', [{ type: 'reasoning', index: 0, summary: [{ index: 0, type: 'summary_text', text: 'Think' }] }]),
    aiChunk('m1', [{ type: 'reasoning', index: 0, summary: [{ index: 0, type: 'summary_text', text: 'ing' }] }]),
    aiChunk('m1', [{ type: 'text', index: 1, text: 'Hel' }]),
    aiChunk('m1', [{ type: 'text', index: 1, text: 'lo' }]),
    aiChunk('m1', [], { chunk_position: 'last', usage_metadata: { output_tokens: 5 } }),
    { event: 'updates', data: { agent: { messages: [] } } },
    { event: 'values', data: { messages: [{ type: 'human', content: 'hi' }, { type: 'ai', id: 'm1', content: 'Hello' }] } },
  ];

  it('reconstructs the answer and its reasoning, and invents no message for the empty resp_ chunk', () => {
    const run = only(load(frames));
    expect(run.runId).toBe('r-1');
    expect(run.threadId).toBe('t-1');
    expect(run.outcome).toBe('finished');
    expect([...run.messages.keys()].sort()).toEqual(['m1', 'm1:reasoning']);
    expect(run.messages.get('m1')).toMatchObject({ kind: 'text', content: 'Hello', closed: true, contentSeqs: [6, 7] });
    expect(run.messages.get('m1:reasoning')).toMatchObject({ kind: 'reasoning', content: 'Thinking', closed: true });
    expect(run.issues).toEqual([]);
  });

  it('keeps state, steps, timing and wire counts', () => {
    const run = only(load(frames));
    expect(run.stateTimeline).toHaveLength(2);
    expect(run.steps).toEqual([{ stepName: 'agent', startedAtMs: 90, endedAtMs: 90, closed: true }]);
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(run.metrics.ttftMs).toBe(50);
    expect(run.metrics.eventCountByType).toEqual({ metadata: 1, values: 2, messages: 6, updates: 1 });
  });
});

describe('LangGraph: tool calls', () => {
  it('accumulates streamed args by index, parses them, and takes the result once', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        aiChunk('m2', [], { tool_call_chunks: [{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci', type: 'tool_call_chunk' }] }),
        aiChunk('m2', [], { tool_call_chunks: [{ index: 0, args: 'ty":"SF"}' }] }),
        aiChunk('m2', [], { chunk_position: 'last' }),
        { event: 'messages', data: [{ type: 'tool', id: 'tm1', tool_call_id: 'call_1', content: 'Sunny' }, { langgraph_node: 'tools' }] },
        { event: 'values', data: { messages: [{ type: 'tool', id: 'tm1', tool_call_id: 'call_1', content: 'Sunny' }] } },
      ]),
    );
    const call = run.toolCalls.get('call_1');
    expect(call).toMatchObject({
      toolCallName: 'get_weather',
      parentMessageId: 'm2',
      argsText: '{"city":"SF"}',
      args: { city: 'SF' },
      closed: true,
      result: 'Sunny',
      resultAtMs: 50,
    });
    expect(run.issues).toEqual([]);
  });

  it('gives a call with no id a stable synthetic one (L8)', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        aiChunk('m3', [], { tool_call_chunks: [{ index: 0, name: 'lookup', args: '{}' }], chunk_position: 'last' }),
        { event: 'values', data: {} },
      ]),
    );
    expect([...run.toolCalls.keys()]).toEqual(['m3#0']);
  });

  it('does not attach an earlier run’s tool result from the thread history in values', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-2' } },
        { event: 'values', data: { messages: [{ type: 'tool', tool_call_id: 'old_call', content: 'from run 1' }] } },
      ]),
    );
    expect(run.toolCalls.size).toBe(0);
  });
});

describe('LangGraph: how a run ends', () => {
  it('interrupted', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        { event: 'values', data: { messages: [] } },
        { event: 'updates', data: { __interrupt__: [{ value: 'approve?', id: 'i1' }] } },
        { event: 'values', data: { __interrupt__: [{ value: 'approve?', id: 'i1' }] } },
      ]),
    );
    expect(run.outcome).toBe('interrupted');
    expect(run.stateTimeline).toHaveLength(1);
    expect(run.steps).toEqual([]);
    expect(run.issues).toEqual([]);
  });

  it('error, with the open message closed and no finish on top', () => {
    const run = only(
      load([
        { event: 'metadata', data: { run_id: 'r-1' } },
        aiChunk('m1', [{ type: 'text', text: 'partial' }]),
        { event: 'error', data: { error: 'ValueError', message: 'boom' } },
      ]),
    );
    expect(run.outcome).toBe('error');
    expect(run.endedAtMs).toBe(30);
    expect(run.messages.get('m1')).toMatchObject({ content: 'partial', closed: true });
    expect(run.issues).toEqual([]);
  });
});

describe('LangGraph: the legacy messages mode', () => {
  const body = { assistant_id: 'agent', stream_mode: ['messages', 'values'] };
  const partial = (content: string): LangGraphTestFrame => ({ event: 'messages/partial', data: [{ type: 'ai', id: 'm1', content }] });

  it('turns cumulative partials into one message', () => {
    const run = only(
      load(
        [
          { event: 'metadata', data: { run_id: 'r-1' } },
          { event: 'messages/metadata', data: { m1: { metadata: { langgraph_node: 'agent' } } } },
          partial('He'),
          partial('Hello'),
          partial('Hello world'),
          { event: 'messages/complete', data: [{ type: 'ai', id: 'm1', content: 'Hello world' }] },
          { event: 'values', data: { messages: [] } },
        ],
        { body },
      ),
    );
    expect(run.messages.get('m1')).toMatchObject({ content: 'Hello world', closed: true, contentSeqs: [3, 4, 5] });
    expect(run.outcome).toBe('finished');
    expect(run.issues).toEqual([]);
  });

  it('flags a partial that does not extend the last, and a complete that disagrees', () => {
    const run = only(
      load(
        [
          { event: 'metadata', data: { run_id: 'r-1' } },
          partial('Hello'),
          partial('Help'),
          { event: 'messages/complete', data: [{ type: 'ai', id: 'm1', content: 'Nope' }] },
          { event: 'values', data: {} },
        ],
        { body },
      ),
    );
    expect(codes(run)).toEqual([
      ['lg-partial-regressed', 3],
      ['lg-complete-mismatch', 4],
    ]);
  });
});

describe('LangGraph: a malformed stream produces exactly its issues, at the right frames', () => {
  it('unknown event, undecodable payload, bad tool args, no final values', () => {
    const run = only(
      load(
        [
          { event: 'metadata', data: { run_id: 'r-1' } },
          { event: 'wat', data: { x: 1 } },
          { event: 'messages', data: { not: 'an array' } },
          aiChunk('m1', [], { tool_call_chunks: [{ index: 0, id: 'c1', name: 'f', args: 'not json' }], chunk_position: 'last' }),
        ],
        { body: { assistant_id: 'agent', stream_mode: ['values', 'messages-tuple'] } },
      ),
    );
    expect(codes(run)).toEqual([
      ['lg-unknown-event', 2],
      ['lg-undecodable', 3],
      ['lg-tool-args-invalid', 4],
      ['lg-no-final-values', 4],
    ]);
    expect(run.outcome).toBe('aborted');
  });

  it('a stream that opens without metadata', () => {
    const run = only(load([aiChunk('m1', 'Hi'), { event: 'values', data: {} }]));
    expect(run.runId).toBe('lg:c1');
    expect(codes(run)).toEqual([['lg-no-metadata', 1]]);
  });
});

describe('LangGraph: subgraphs fold into child runs (L11)', () => {
  const frames: LangGraphTestFrame[] = [
    { event: 'metadata', data: { run_id: 'r-1' } },
    { event: 'values', data: { messages: [{ type: 'human', content: 'hi' }] } },
    { ...aiChunk('s1', [{ type: 'text', text: 'Looking' }]), event: 'messages|research:t1' },
    { ...aiChunk('s1', [], { chunk_position: 'last' }), event: 'messages|research:t1' },
    { event: 'updates|research:t1', data: { search: { notes: 'x' } } },
    { event: 'values|research:t1', data: { notes: 'x' } },
    { event: 'updates', data: { research: { notes: 'x' } } },
    aiChunk('m1', 'Answer', { chunk_position: 'last' }),
    { event: 'values', data: { messages: [] } },
  ];

  it('gives the subgraph its own run, under its parent', () => {
    const loaded = load(frames);
    expect(loaded.runs.map((run) => [run.runId, run.parentRunId, run.outcome])).toEqual([
      ['r-1', undefined, 'finished'],
      ['r-1/research:t1', 'r-1', 'finished'],
    ]);
  });

  it('splits frames, messages, steps, state and counts between parent and child', () => {
    const [top, child] = load(frames).runs;
    expect(child?.recordSeqs).toEqual([3, 4, 5, 6]);
    expect(child?.messages.get('s1')).toMatchObject({ content: 'Looking', closed: true });
    expect(child?.steps.map((step) => step.stepName)).toEqual(['search']);
    expect(child?.stateTimeline).toHaveLength(1);
    expect(child?.metrics.eventCountByType).toEqual({
      'messages|research:t1': 2,
      'updates|research:t1': 1,
      'values|research:t1': 1,
    });
    expect(top?.recordSeqs).toEqual([1, 2, 7, 8, 9]);
    expect(top?.messages.get('m1')?.content).toBe('Answer');
    expect(top?.steps.map((step) => step.stepName)).toEqual(['research']);
    expect(top?.metrics.eventCountByType).toEqual({ metadata: 1, values: 2, updates: 1, messages: 1 });
    expect([...(top?.issues ?? []), ...(child?.issues ?? [])]).toEqual([]);
  });

  it('nests: a two-segment namespace is a child of the one-segment run', () => {
    const loaded = load([
      { event: 'metadata', data: { run_id: 'r-1' } },
      { event: 'values|a:1|b:2', data: { x: 1 } },
      { event: 'values', data: {} },
    ]);
    expect(loaded.runs.map((run) => [run.runId, run.parentRunId, run.outcome])).toEqual([
      ['r-1', undefined, 'finished'],
      ['r-1/a:1', 'r-1', 'finished'],
      ['r-1/a:1|b:2', 'r-1/a:1', 'finished'],
    ]);
    // The frame is the innermost run's alone; the ancestor it opened sent nothing of its own (S3).
    expect(loaded.runs.map((run) => run.recordSeqs)).toEqual([[1, 3], [], [2]]);
  });

  it('a child error is the child’s; a parent error aborts its children', () => {
    const childError = load([
      { event: 'metadata', data: { run_id: 'r-1' } },
      { ...aiChunk('s1', 'x'), event: 'messages|sub:1' },
      { event: 'error|sub:1', data: { error: 'E', message: 'child boom' } },
      { event: 'values', data: {} },
    ]);
    expect(childError.runs.map((run) => [run.outcome, run.recordSeqs])).toEqual([
      ['finished', [1, 4]],
      ['error', [2, 3]],
    ]);

    const parentError = load([
      { event: 'metadata', data: { run_id: 'r-1' } },
      { ...aiChunk('s1', 'x'), event: 'messages|sub:1' },
      { event: 'error', data: { error: 'E', message: 'boom' } },
    ]);
    // The top-level error frame closes the child's message, but it is the top run's frame (S3).
    expect(parentError.runs.map((run) => [run.outcome, run.recordSeqs])).toEqual([
      ['error', [1, 3]],
      ['aborted', [2]],
    ]);
    expect(parentError.runs[1]?.messages.get('s1')?.closed).toBe(true);
    expect(parentError.runs[1]?.metrics.eventCountByType).toEqual({ 'messages|sub:1': 1 });
    expect(parentError.runs.flatMap((run) => run.issues)).toEqual([]);
  });
});

describe('LangGraph: a join stream continues the run it rejoins (S8)', () => {
  it('one run, the whole answer, finished by the joining connection', () => {
    const original = langGraphJsonl([
      { event: 'metadata', data: { run_id: 'r-1' } },
      aiChunk('m1', 'Hel'),
    ]);
    const join = langGraphJsonl(
      [aiChunk('m1', 'lo', { chunk_position: 'last' }), { event: 'values', data: { messages: [] } }],
      {
        connId: 'c2',
        method: 'GET',
        url: 'http://localhost:2024/threads/t-1/runs/r-1/stream',
        body: null,
        header: false,
        firstSeq: 3,
      },
    );
    const loaded = loadJsonl(`${original}\n${join}`);
    const run = only(loaded);
    expect(run.outcome).toBe('finished');
    expect(run.messages.get('m1')?.content).toBe('Hello');
    expect(run.recordSeqs).toEqual([1, 2, 3, 4]);
    // True of the connection that dropped, and kept: it did close without its final values.
    // Anchored to that connection's own last frame, not the run's (S6).
    expect(codes(run)).toEqual([['lg-no-final-values', 2]]);
  });
});

describe('LangGraph and AG-UI side by side in one capture', () => {
  it('folds each connection in its own dialect', () => {
    const lg = langGraphJsonl(
      [{ event: 'metadata', data: { run_id: 'lg-run' } }, aiChunk('m1', 'Hi'), { event: 'values', data: {} }],
      { connId: 'lg1', header: false },
    );
    const loaded = loadJsonl(`${happyJsonl.trimEnd()}\n${lg}`);
    const alone = loadJsonl(happyJsonl);
    const aguiRun = loaded.runs.find((run) => run.dialect === undefined);
    const lgRun = loaded.runs.find((run) => run.dialect === 'langgraph');
    expect(lgRun?.runId).toBe('lg-run');
    expect(lgRun?.messages.get('m1')?.content).toBe('Hi');
    // The AG-UI run is exactly what it is without the LangGraph connection beside it.
    expect(aguiRun?.issues).toEqual(alone.runs[0]?.issues);
    expect(aguiRun?.metrics).toEqual(alone.runs[0]?.metrics);
    expect([...(aguiRun?.messages.values() ?? [])]).toEqual([...(alone.runs[0]?.messages.values() ?? [])]);
  });
});

describe('LangGraph: export, clear, re-import — the tabs are identical', () => {
  function project(run: Run): unknown {
    return {
      runId: run.runId,
      threadId: run.threadId,
      outcome: run.outcome,
      dialect: run.dialect,
      messages: [...run.messages.values()],
      toolCalls: [...run.toolCalls.values()],
      steps: run.steps,
      stateTimeline: run.stateTimeline,
      issues: run.issues.map((issue) => [issue.code, issue.seq]),
      counts: run.metrics.eventCountByType,
    };
  }

  it('round-trips a LangGraph capture', () => {
    const text = langGraphJsonl([
      { event: 'metadata', data: { run_id: 'r-1' } },
      aiChunk('m1', [], { tool_call_chunks: [{ index: 0, id: 'c1', name: 'f', args: '{"a":1}' }] }),
      aiChunk('m1', 'done', { chunk_position: 'last' }),
      { event: 'values', data: { messages: [] } },
    ]);
    const first = loadJsonl(text);
    const exported = buildExport(
      {
        records: first.records,
        requests: first.requests,
        runs: first.runs,
        importedHeader: first.header,
        runtime: first.runtime,
        framework: null,
        binaryTransport: null,
        source: { kind: 'imported', filename: 'lg.agui.jsonl', importedAtMs: 0 },
      },
      { scope: null, groups: [], toolVersion: 'test', exportedAtIso: '2026-09-30T12:00:00.000Z' },
    );
    const again = loadJsonl(encodeJsonl(exported.lines));
    expect(again.runs.map(project)).toEqual(first.runs.map(project));
  });
});

describe('LangGraph golden: a real Python-server recording (gpt-5, reasoning then text)', () => {
  const loaded = loadJsonl(lgReasoningJsonl);

  it('reconstructs the streamed answer byte for byte', () => {
    const run = only(loaded);
    const text = [...run.messages.values()].filter((message) => message.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.content).toBe(lgReasoningCanonical);
  });

  it('has one reasoning message, streamed before the text, and nothing under the resp_ id', () => {
    const run = only(loaded);
    const reasoning = [...run.messages.values()].filter((message) => message.kind === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.content.length).toBeGreaterThan(0);
    expect([...run.messages.keys()].some((id) => id.startsWith('resp_'))).toBe(false);
    expect(run.metrics.ttfrtMs).toBeLessThan(run.metrics.ttftMs ?? 0);
  });

  it('finishes cleanly, with the wire counts of the recording', () => {
    const run = only(loaded);
    expect(run.runId).toBe('019e0a0b-6976-7c72-8d57-479ba0c859f6');
    expect(run.outcome).toBe('finished');
    expect(run.issues).toEqual([]);
    expect(run.metrics.eventCountByType).toEqual({ metadata: 1, messages: 1210, values: 2 });
  });
});
