import { describe, it, expect } from 'vitest';
import { createRunBuilder } from './run-builder';
import type { RedactionGroup } from '../jsonl/redact';
import { ORPHANED_RUN_ID } from '../model/types';
import type { AguiEvent, CaptureRecord } from '../model/types';

/** `CaptureRecord` is a discriminated union, so every record has to declare its `kind`. */
function rec(seq: number, tMs: number, connId: string, event: AguiEvent): CaptureRecord {
  return { kind: 'event', seq, tMs, connId, raw: event, event, issues: [] };
}

describe('createRunBuilder — lifecycle and text messages', () => {
  it('folds a complete happy run end to end', () => {
    const builder = createRunBuilder();
    const input = { threadId: 't1', runId: 'r1', messages: [], tools: [] };

    builder.addRequest('c1', 'POST', 'https://example.test/agent', input);
    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' }));
    builder.addRecord(rec(5, 40, 'c1', { type: 'TEXT_MESSAGE_END', messageId: 'm1' }));
    builder.addRecord(rec(6, 50, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));

    const runs = builder.runs();
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.runId).toBe('r1');
    expect(run.threadId).toBe('t1');
    expect(run.connId).toBe('c1');
    expect(run.input).toEqual(input);
    expect(run.outcome).toBe('finished');
    expect(run.startedAtMs).toBe(0);
    expect(run.endedAtMs).toBe(50);
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6]);

    const message = run.messages.get('m1')!;
    // `kind` records which event family opened the message — NOT the protocol's own
    // `role` field, which the START event also carries with different semantics.
    expect(message.kind).toBe('text');
    expect(message.content).toBe('Hello');
    expect(message.startedAtMs).toBe(10);
    expect(message.endedAtMs).toBe(40);
    expect(message.closed).toBe(true);
    expect(message.contentSeqs).toEqual([3, 4]);

    expect(run.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(run.metrics.durationMs).toBe(50);
    expect(run.metrics.ttftMs).toBe(20);
    expect(run.metrics.eventCountByType).toEqual({
      RUN_STARTED: 1,
      TEXT_MESSAGE_START: 1,
      TEXT_MESSAGE_CONTENT: 2,
      TEXT_MESSAGE_END: 1,
      RUN_FINISHED: 1,
    });
  });

  it('reconstructs reasoning messages and reports ttfrtMs', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 5, 'c1', { type: 'REASONING_MESSAGE_START', messageId: 'rm1', role: 'assistant' }));
    builder.addRecord(rec(3, 15, 'c1', { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'th' }));
    builder.addRecord(rec(4, 25, 'c1', { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'ink' }));
    builder.addRecord(rec(5, 35, 'c1', { type: 'REASONING_MESSAGE_END', messageId: 'rm1' }));

    const run = builder.getRun('r1')!;
    const message = run.messages.get('rm1')!;
    expect(message.kind).toBe('reasoning');
    expect(message.content).toBe('think');
    expect(message.closed).toBe(true);
    expect(run.metrics.ttfrtMs).toBe(15);
    expect(run.metrics.ttftMs).toBeUndefined();
  });

  it('marks a RUN_ERROR run as errored', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 12, 'c1', { type: 'RUN_ERROR', message: 'boom', code: 'E_BOOM' }));

    const run = builder.getRun('r1')!;
    expect(run.outcome).toBe('error');
    expect(run.endedAtMs).toBe(12);
  });

  it('has no runs at all before any record arrives', () => {
    expect(createRunBuilder().runs()).toEqual([]);
    expect(createRunBuilder().allIssues()).toEqual([]);
  });

  it('attaches events with no RUN_STARTED to the synthetic orphaned run', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 5, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.addRecord(rec(2, 6, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'orphan' }));

    const runs = builder.runs();
    expect(runs.map((run) => run.runId)).toEqual([ORPHANED_RUN_ID]);

    const orphan = runs[0]!;
    expect(orphan.outcome).toBe('orphaned');
    expect(orphan.recordSeqs).toEqual([1, 2]);
    expect(orphan.messages.get('m1')!.content).toBe('orphan');
    expect(builder.getRun(ORPHANED_RUN_ID)).toBe(orphan);
    expect(builder.allIssues().some((issue) => issue.code === 'event-before-run-started')).toBe(true);
  });

  it('keeps two concurrent connections from cross-contaminating', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'cA', { type: 'RUN_STARTED', threadId: 'tA', runId: 'rA' }));
    builder.addRecord(rec(2, 1, 'cB', { type: 'RUN_STARTED', threadId: 'tB', runId: 'rB' }));
    builder.addRecord(rec(3, 2, 'cA', { type: 'TEXT_MESSAGE_START', messageId: 'mA', role: 'assistant' }));
    builder.addRecord(rec(4, 3, 'cB', { type: 'TEXT_MESSAGE_START', messageId: 'mB', role: 'assistant' }));
    builder.addRecord(rec(5, 4, 'cA', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mA', delta: 'A1' }));
    builder.addRecord(rec(6, 5, 'cB', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mB', delta: 'B1' }));
    builder.addRecord(rec(7, 6, 'cA', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mA', delta: 'A2' }));
    builder.addRecord(rec(8, 7, 'cB', { type: 'RUN_FINISHED', threadId: 'tB', runId: 'rB' }));
    builder.addRecord(rec(9, 8, 'cA', { type: 'RUN_FINISHED', threadId: 'tA', runId: 'rA' }));

    expect(builder.runs().map((run) => run.runId)).toEqual(['rA', 'rB']);

    const runA = builder.getRun('rA')!;
    const runB = builder.getRun('rB')!;

    expect(runA.connId).toBe('cA');
    expect(runB.connId).toBe('cB');
    expect([...runA.messages.keys()]).toEqual(['mA']);
    expect([...runB.messages.keys()]).toEqual(['mB']);
    expect(runA.messages.get('mA')!.content).toBe('A1A2');
    expect(runB.messages.get('mB')!.content).toBe('B1');
    expect(runA.recordSeqs).toEqual([1, 3, 5, 7, 9]);
    expect(runB.recordSeqs).toEqual([2, 4, 6, 8]);
    expect(builder.runs().map((run) => run.runId)).not.toContain(ORPHANED_RUN_ID);
  });

  it('attaches an unparseable record and its issues to the connection run without decoding it', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord({
      kind: 'event',
      seq: 2,
      tMs: 5,
      connId: 'c1',
      raw: 'not json',
      event: null,
      issues: [{ code: 'shape-invalid', severity: 'error', message: 'unparseable frame', seq: 2 }],
    });

    const run = builder.getRun('r1')!;
    expect(run.recordSeqs).toEqual([1, 2]);

    const issue = run.issues.find((candidate) => candidate.code === 'shape-invalid')!;
    expect(issue.message).toBe('unparseable frame');
    expect(issue.runId).toBe('r1');
  });

  it('returns every issue across every run sorted by seq', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm0', role: 'assistant' }));
    builder.addRecord(rec(2, 1, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord({
      kind: 'event',
      seq: 3,
      tMs: 2,
      connId: 'c1',
      raw: '{',
      event: null,
      issues: [{ code: 'shape-invalid', severity: 'error', message: 'truncated', seq: 3 }],
    });

    const seqs = builder.allIssues().map((issue) => issue.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toContain(3);
  });
});

describe('createRunBuilder — tool calls, state and steps', () => {
  function rec(seq: number, tMs: number, connId: string, event: AguiEvent): CaptureRecord {
    return { kind: 'event', seq, tMs, connId, raw: event, event, issues: [] };
  }

  it('accumulates TOOL_CALL_ARGS across deltas and parses them at TOOL_CALL_END', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(
      rec(2, 10, 'c1', {
        type: 'TOOL_CALL_START',
        toolCallId: 'tc1',
        toolCallName: 'search',
        parentMessageId: 'm1',
      }),
    );
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '"cats"' }));
    builder.addRecord(rec(5, 35, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '}' }));
    builder.addRecord(rec(6, 40, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));
    builder.addRecord(
      rec(7, 60, 'c1', { type: 'TOOL_CALL_RESULT', messageId: 'm2', toolCallId: 'tc1', content: '12 results' }),
    );
    builder.addRecord(rec(8, 70, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));

    const run = builder.getRun('r1')!;
    const call = run.toolCalls.get('tc1')!;

    expect(call.argsText).toBe('{"q":"cats"}');
    expect(call.args).toEqual({ q: 'cats' });
    expect(call.argsParseError).toBeUndefined();
    expect(call.toolCallName).toBe('search');
    expect(call.parentMessageId).toBe('m1');
    expect(call.startedAtMs).toBe(10);
    expect(call.endedAtMs).toBe(40);
    expect(call.resultAtMs).toBe(60);
    expect(call.result).toBe('12 results');
    expect(call.closed).toBe(true);
    expect(run.metrics.toolLatencyMs).toEqual({ tc1: 50 });
    expect(run.issues.some((issue) => issue.code === 'tool-args-not-json')).toBe(false);
  });

  it('records argsParseError and raises tool-args-not-json when the accumulated args are invalid', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: 'cats' }));
    builder.addRecord(rec(5, 40, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));

    const run = builder.getRun('r1')!;
    const call = run.toolCalls.get('tc1')!;

    expect(call.argsText).toBe('{"q":cats');
    expect(call.args).toBeUndefined();
    expect(typeof call.argsParseError).toBe('string');
    expect(call.argsParseError!.length).toBeGreaterThan(0);

    const issue = run.issues.find((candidate) => candidate.code === 'tool-args-not-json')!;
    expect(issue.severity).toBe('error');
    expect(issue.runId).toBe('r1');
  });

  it('leaves args and argsParseError unset for a tool call that carried no args at all', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'ping' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));

    const call = builder.getRun('r1')!.toolCalls.get('tc1')!;
    expect(call.argsText).toBe('');
    expect(call.args).toBeUndefined();
    expect(call.argsParseError).toBeUndefined();
  });

  it('builds a state timeline of snapshot, applied delta, and failed delta', () => {
    const builder = createRunBuilder();
    const good = [{ op: 'replace', path: '/count', value: 2 }];
    const bad = [{ op: 'replace', path: '/nope', value: 9 }];

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'STATE_SNAPSHOT', snapshot: { count: 1, items: ['a'] } }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'STATE_DELTA', delta: good }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'STATE_DELTA', delta: bad }));

    const run = builder.getRun('r1')!;
    expect(run.stateTimeline).toHaveLength(3);

    // `StateFrame` is a discriminated union: `patch` and `failure` exist only on the
    // `delta` arm, so the test has to narrow on `kind` before reading them.
    const [snapshot, applied, failed] = run.stateTimeline;

    expect(snapshot?.kind).toBe('snapshot');
    expect(snapshot?.value).toEqual({ count: 1, items: ['a'] });

    expect(applied?.kind).toBe('delta');
    if (applied?.kind !== 'delta') throw new Error('expected frame 1 to be a delta');
    expect(applied.value).toEqual({ count: 2, items: ['a'] });
    expect(applied.patch).toEqual(good);
    expect(applied.failure).toBeUndefined();

    expect(failed?.kind).toBe('delta');
    if (failed?.kind !== 'delta') throw new Error('expected frame 2 to be a delta');
    expect(failed.failure?.opIndex).toBe(0);
    expect(failed.failure?.reason).toBe('path-not-found');
    // a failed patch leaves the value at the previous frame
    expect(failed.value).toEqual({ count: 2, items: ['a'] });

    expect(run.issues.some((issue) => issue.code === 'state-patch-failed')).toBe(true);
    expect(run.metrics.statePatchCount).toBe(2);
    expect(run.metrics.statePatchBytes).toBe(JSON.stringify(good).length + JSON.stringify(bad).length);
  });

  it('tracks steps, closing the most recent open step of the same name', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'STEP_STARTED', stepName: 'plan' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'STEP_FINISHED', stepName: 'plan' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'STEP_STARTED', stepName: 'act' }));

    expect(builder.getRun('r1')!.steps).toEqual([
      { stepName: 'plan', startedAtMs: 10, endedAtMs: 20, closed: true },
      { stepName: 'act', startedAtMs: 30, closed: false },
    ]);
  });

  it('folds activity snapshots and patches them with activity deltas', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(
      rec(2, 10, 'c1', {
        type: 'ACTIVITY_SNAPSHOT',
        activityType: 'progress',
        messageId: 'm1',
        content: { pct: 10, label: 'starting' },
      }),
    );
    builder.addRecord(
      rec(3, 20, 'c1', {
        type: 'ACTIVITY_DELTA',
        activityType: 'progress',
        messageId: 'm1',
        patch: [{ op: 'replace', path: '/pct', value: 60 }],
      }),
    );

    const activity = builder.getRun('r1')!.activities.get('m1#progress')!;
    expect(activity.activityId).toBe('m1#progress');
    expect(activity.value).toEqual({ pct: 60, label: 'starting' });
    expect(activity.updatedAtMs).toBe(20);
  });
});

describe('createRunBuilder — chunk expansion and connection close', () => {
  function rec(seq: number, tMs: number, connId: string, event: AguiEvent): CaptureRecord {
    return { kind: 'event', seq, tMs, connId, raw: event, event, issues: [] };
  }

  /** A keepalive frame: the comment arm of the union, carrying no `event` at all. */
  function keepalive(seq: number, tMs: number, connId: string, comment: string): CaptureRecord {
    return { kind: 'keepalive', seq, tMs, connId, raw: `:${comment}\n\n`, comment, issues: [] };
  }

  it('reconstructs the same message content from chunks as from an explicit triad', () => {
    const chunked = createRunBuilder({ expandChunks: true });
    chunked.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    chunked.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hel' }));
    chunked.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CHUNK', delta: 'lo ' }));
    chunked.addRecord(rec(4, 30, 'c1', { type: 'TEXT_MESSAGE_CHUNK', delta: 'world' }));

    const explicit = createRunBuilder({ expandChunks: false });
    explicit.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    explicit.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    explicit.addRecord(rec(3, 10, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' }));
    explicit.addRecord(rec(4, 20, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo ' }));
    explicit.addRecord(rec(5, 30, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'world' }));

    const fromChunks = chunked.getRun('r1')!.messages.get('m1')!;
    const fromTriad = explicit.getRun('r1')!.messages.get('m1')!;

    expect(fromChunks.content).toBe('Hello world');
    expect(fromChunks.content).toBe(fromTriad.content);
    expect(fromChunks.kind).toBe(fromTriad.kind);

    // expansion feeds metrics too: the chunk record at tMs 10 became the first content delta
    expect(chunked.getRun('r1')!.metrics.ttftMs).toBe(10);
    expect(chunked.getRun('r1')!.metrics.eventCountByType).toEqual({
      RUN_STARTED: 1,
      TEXT_MESSAGE_START: 1,
      TEXT_MESSAGE_CONTENT: 3,
    });
  });

  it('does not reconstruct chunked messages when expandChunks is false', () => {
    const builder = createRunBuilder({ expandChunks: false });

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hel' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CHUNK', delta: 'lo' }));

    const run = builder.getRun('r1')!;
    expect(run.messages.size).toBe(0);
    expect(run.recordSeqs).toEqual([1, 2, 3]);
    expect(run.metrics.eventCountByType).toEqual({ RUN_STARTED: 1, TEXT_MESSAGE_CHUNK: 2 });
  });

  it('expands TOOL_CALL_CHUNK into a start plus accumulated args', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(
      rec(2, 10, 'c1', { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":' }),
    );
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_CHUNK', delta: '1}' }));

    const call = builder.getRun('r1')!.toolCalls.get('tc1')!;
    expect(call.toolCallName).toBe('search');
    expect(call.argsText).toBe('{"q":1}');
    expect(call.closed).toBe(false);
  });

  it('closes the trailing chunked message, reasoning and tool call at RUN_FINISHED', () => {
    const builder = createRunBuilder();
    const frames: AguiEvent[] = [
      { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hi' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'rm1', delta: 'hmm' },
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":"cats"}' },
      { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
    ];

    frames.forEach((frame, index) => builder.addRecord(rec(index + 1, index * 10, 'c1', frame)));
    builder.closeConnection('c1', 50);

    const run = builder.getRun('r1')!;

    // A chunk-only stream is the CopilotKit default. `expandChunk` synthesizes a trailing
    // END only when a NEW id opens, so without the run-end flush every healthy chunked run
    // reported these two warnings — and the panel got no structured tool arguments.
    expect(run.issues.filter((issue) => issue.code === 'unclosed-message')).toEqual([]);
    expect(run.issues.filter((issue) => issue.code === 'unclosed-tool-call')).toEqual([]);
    // the flush runs BEFORE the terminal transition, so the synthesized ENDs are still legal
    expect(run.issues.filter((issue) => issue.code === 'event-after-terminal')).toEqual([]);

    const message = run.messages.get('m1')!;
    expect(message.closed).toBe(true);
    expect(message.endedAtMs).toBe(40);

    const reasoning = run.messages.get('rm1')!;
    expect(reasoning.closed).toBe(true);
    expect(reasoning.endedAtMs).toBe(40);

    const call = run.toolCalls.get('tc1')!;
    expect(call.closed).toBe(true);
    expect(call.endedAtMs).toBe(40);
    // `args` is parsed only in the TOOL_CALL_END case, so this is what the flush buys the panel
    expect(call.args).toEqual({ q: 'cats' });
    expect(call.argsParseError).toBeUndefined();
    expect(run.outcome).toBe('finished');
    expect(run.endedAtMs).toBe(40);

    // `eventCountByType` counts the RECONSTRUCTED stream, so the flushed ENDs count exactly
    // as the expander's synthesized STARTs always have. Five frames arrived; eleven events
    // were reconstructed.
    expect(run.metrics.eventCountByType).toEqual({
      RUN_STARTED: 1,
      TEXT_MESSAGE_START: 1,
      TEXT_MESSAGE_CONTENT: 1,
      TEXT_MESSAGE_END: 1,
      REASONING_MESSAGE_START: 1,
      REASONING_MESSAGE_CONTENT: 1,
      REASONING_MESSAGE_END: 1,
      TOOL_CALL_START: 1,
      TOOL_CALL_ARGS: 1,
      TOOL_CALL_END: 1,
      RUN_FINISHED: 1,
    });
    // `totalStreamBytes` is the WIRE-FRAME measure and does not move: every synthesized
    // event's record carries `raw: undefined`. The two numbers answer different questions.
    expect(run.metrics.totalStreamBytes).toBe(
      frames.reduce((total, frame) => total + JSON.stringify(frame).length, 0),
    );
  });

  it('closes the trailing chunked message and tool call when the connection closes mid-run', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hi' }));
    builder.addRecord(
      rec(3, 20, 'c1', { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":1}' }),
    );
    builder.closeConnection('c1', 90);

    const run = builder.getRun('r1')!;

    expect(run.issues.filter((issue) => issue.code === 'unclosed-message')).toEqual([]);
    expect(run.issues.filter((issue) => issue.code === 'unclosed-tool-call')).toEqual([]);
    // the stream still died without a terminal event — that issue is real and stays
    expect(run.issues.filter((issue) => issue.code === 'run-never-terminated')).toHaveLength(1);

    const message = run.messages.get('m1')!;
    expect(message.closed).toBe(true);
    expect(message.endedAtMs).toBe(90);

    const call = run.toolCalls.get('tc1')!;
    expect(call.closed).toBe(true);
    expect(call.endedAtMs).toBe(90);
    expect(call.args).toEqual({ q: 1 });

    expect(run.outcome).toBe('aborted');
    // the flush is not a frame off the wire: it contributes no seq of its own
    expect(run.recordSeqs).toEqual([1, 2, 3]);
  });

  it('closes an unterminated run chunk state against that run when the next run starts', () => {
    const builder = createRunBuilder();

    // requirements §4.2: `POST {base}/agent/:agentId/connect` resumes a stream on a
    // connection that may already have carried a run, so two runs on one connection —
    // the first of them never terminated — is a first-class path, not a curiosity.
    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'rA' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'mA', role: 'assistant', delta: 'A' }));
    builder.addRecord(
      rec(3, 20, 'c1', { type: 'TOOL_CALL_CHUNK', toolCallId: 'tcA', toolCallName: 'search', delta: '{"q":"a"}' }),
    );
    builder.addRecord(rec(4, 30, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'rB' }));

    const runA = builder.getRun('rA')!;
    const runB = builder.getRun('rB')!;

    // the chunk state is connection-scoped, so it has to be flushed against the OUTGOING run
    const message = runA.messages.get('mA')!;
    expect(message.closed).toBe(true);
    expect(message.endedAtMs).toBe(30);

    const call = runA.toolCalls.get('tcA')!;
    expect(call.closed).toBe(true);
    expect(call.endedAtMs).toBe(30);
    expect(call.args).toEqual({ q: 'a' });

    // run B emitted nothing of its own yet, and must not inherit run A's leftovers
    expect([...runB.messages.keys()]).toEqual([]);
    expect([...runB.toolCalls.keys()]).toEqual([]);
    expect(runB.recordSeqs).toEqual([4]);
    // the flush is not a frame off the wire: run A's record list is unchanged
    expect(runA.recordSeqs).toEqual([1, 2, 3]);
  });

  it('attaches any unclosed-* warning from a run switch to the outgoing run, never the incoming one', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'rA' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'mA', role: 'assistant', delta: 'A' }));
    builder.addRecord(
      rec(3, 20, 'c1', { type: 'TOOL_CALL_CHUNK', toolCallId: 'tcA', toolCallName: 'search', delta: '{"q":"a"}' }),
    );
    builder.addRecord(rec(4, 30, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'rB' }));
    builder.closeConnection('c1', 100);

    const runA = builder.getRun('rA')!;
    const runB = builder.getRun('rB')!;

    // run A's entities were closed by the switch, so neither run reports them as unclosed
    expect(runA.issues.filter((issue) => issue.code === 'unclosed-message')).toEqual([]);
    expect(runA.issues.filter((issue) => issue.code === 'unclosed-tool-call')).toEqual([]);
    expect(runB.issues.filter((issue) => issue.code === 'unclosed-message')).toEqual([]);
    expect(runB.issues.filter((issue) => issue.code === 'unclosed-tool-call')).toEqual([]);
    // both runs really did end without a terminal event, and each says so once
    expect(runA.issues.filter((issue) => issue.code === 'run-never-terminated')).toHaveLength(1);
    expect(runB.issues.filter((issue) => issue.code === 'run-never-terminated')).toHaveLength(1);
  });

  it('changes nothing when a RUN_STARTED arrives with an empty chunk state', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'rA' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'mA', role: 'assistant' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_END', messageId: 'mA' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'rB' }));

    const runA = builder.getRun('rA')!;

    // an explicit triad never touches the chunk state, and the first RUN_STARTED on a
    // connection has no outgoing run at all — both must be pure no-ops
    expect(runA.messages.get('mA')!.endedAtMs).toBe(20);
    expect(runA.recordSeqs).toEqual([1, 2, 3]);
    expect(runA.metrics.eventCountByType).toEqual({
      RUN_STARTED: 1,
      TEXT_MESSAGE_START: 1,
      TEXT_MESSAGE_END: 1,
    });
    expect(builder.getRun('rB')!.messages.size).toBe(0);
    expect(builder.runs().map((run) => run.runId)).toEqual(['rA', 'rB']);
  });

  it('gives a chunked run the same closure and parsed args as the equivalent explicit triad', () => {
    const chunked = createRunBuilder({ expandChunks: true });
    chunked.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    chunked.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hello' }));
    chunked.addRecord(
      rec(3, 20, 'c1', { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":"cats"}' }),
    );
    chunked.addRecord(rec(4, 30, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));

    const explicit = createRunBuilder({ expandChunks: false });
    explicit.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    explicit.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    explicit.addRecord(rec(3, 10, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hello' }));
    explicit.addRecord(rec(4, 20, 'c1', { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }));
    explicit.addRecord(rec(5, 20, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":"cats"}' }));
    explicit.addRecord(rec(6, 30, 'c1', { type: 'TEXT_MESSAGE_END', messageId: 'm1' }));
    explicit.addRecord(rec(7, 30, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));
    explicit.addRecord(rec(8, 30, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));

    const fromChunks = chunked.getRun('r1')!;
    const fromTriad = explicit.getRun('r1')!;
    const chunkMessage = fromChunks.messages.get('m1')!;
    const triadMessage = fromTriad.messages.get('m1')!;
    const chunkCall = fromChunks.toolCalls.get('tc1')!;
    const triadCall = fromTriad.toolCalls.get('tc1')!;

    // equivalence that matters to the panel, not just `content`
    expect([chunkMessage.content, chunkMessage.closed, chunkMessage.endedAtMs]).toEqual([
      triadMessage.content,
      triadMessage.closed,
      triadMessage.endedAtMs,
    ]);
    expect([chunkMessage.closed, chunkMessage.endedAtMs]).toEqual([true, 30]);

    expect([chunkCall.argsText, chunkCall.closed, chunkCall.endedAtMs, chunkCall.args]).toEqual([
      triadCall.argsText,
      triadCall.closed,
      triadCall.endedAtMs,
      triadCall.args,
    ]);
    expect(chunkCall.args).toEqual({ q: 'cats' });

    expect(fromChunks.outcome).toBe(fromTriad.outcome);
    expect(fromChunks.endedAtMs).toBe(fromTriad.endedAtMs);
  });

  it('attaches chunk-expansion issues to the run even when nothing could be synthesized', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_CHUNK', delta: '{}' }));

    const run = builder.getRun('r1')!;
    expect(run.recordSeqs).toEqual([1, 2]);

    const issue = run.issues.find((candidate) => candidate.code === 'chunk-missing-tool-call-id')!;
    expect(issue.seq).toBe(2);
    expect(issue.runId).toBe('r1');
  });

  it('raises run-never-terminated and aborts the run when the connection closes mid-run', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' }));
    builder.closeConnection('c1', 100);

    const run = builder.getRun('r1')!;
    const raised = run.issues.filter((issue) => issue.code === 'run-never-terminated');

    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('error');
    expect(raised[0]!.runId).toBe('r1');
    expect(raised[0]!.seq).toBe(3);
    expect(run.outcome).toBe('aborted');
    expect(run.endedAtMs).toBe(100);
    expect(run.metrics.durationMs).toBe(100);
  });

  it('leaves a run that already finished untouched when its connection closes', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));
    builder.closeConnection('c1', 100);
    builder.closeConnection('c1', 200);

    const run = builder.getRun('r1')!;
    expect(run.issues.filter((issue) => issue.code === 'run-never-terminated')).toEqual([]);
    expect(run.outcome).toBe('finished');
    expect(run.endedAtMs).toBe(10);
    // NOTE: the second close proves nothing here — `finalizeRules` emits nothing for a
    // FINISHED run however many times it runs. The `closedAtMs` guard is pinned by the
    // next test, which closes an UNTERMINATED run twice.
  });

  it('emits the run-end issues exactly once when an unterminated run is closed twice', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.closeConnection('c1', 100);
    builder.closeConnection('c1', 200);

    const run = builder.getRun('r1')!;

    // `conn.closedAtMs` is the only thing standing between this and a double emission:
    // `finalizeRules` is a pure function of a validation state that closing does not reset,
    // so a second pass over an unterminated run re-raises every run-end issue — which is
    // exactly what breaks Task 16's "exactly three issues" assertion.
    expect(run.issues.filter((issue) => issue.code === 'run-never-terminated')).toHaveLength(1);
    expect(run.issues.filter((issue) => issue.code === 'unclosed-message')).toHaveLength(1);
    // the FIRST close wins: the run ended when its connection did, not at a later redundant close
    expect(run.endedAtMs).toBe(100);
    expect(run.metrics.durationMs).toBe(100);
    expect(run.outcome).toBe('aborted');
  });

  it('closes only the runs belonging to the connection that closed', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'cA', { type: 'RUN_STARTED', threadId: 'tA', runId: 'rA' }));
    builder.addRecord(rec(2, 1, 'cB', { type: 'RUN_STARTED', threadId: 'tB', runId: 'rB' }));
    builder.closeConnection('cA', 50);

    expect(builder.getRun('rA')!.outcome).toBe('aborted');
    expect(builder.getRun('rB')!.outcome).toBe('running');
    expect(builder.getRun('rB')!.issues.some((issue) => issue.code === 'run-never-terminated')).toBe(false);
  });

  it('records keepalives without counting them as events', () => {
    const builder = createRunBuilder();
    const started = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    builder.addRecord(rec(1, 0, 'c1', started));
    builder.addRecord(keepalive(2, 5_000, 'c1', 'ka'));
    builder.addRecord(keepalive(3, 10_000, 'c1', ''));

    const run = builder.getRun('r1')!;

    // requirements §5.4: keepalives are recorded but excluded from the event count, while
    // their bytes still count — diagnosing proxy buffering is the whole point of keeping them.
    expect(run.recordSeqs).toEqual([1]);
    expect(run.metrics.eventCountByType).toEqual({ RUN_STARTED: 1 });
    expect(run.metrics.totalStreamBytes).toBe(
      JSON.stringify(started).length +
        JSON.stringify(':ka\n\n').length +
        JSON.stringify(':\n\n').length,
    );
    expect(run.issues.filter((issue) => issue.code === 'keepalive-gap')).toEqual([]);
  });

  it('raises keepalive-gap on the keepalive that closed a gap longer than 15 s', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(keepalive(2, 1_000, 'c1', 'ka'));
    builder.addRecord(keepalive(3, 12_000, 'c1', 'ka')); // 11 s — under the threshold
    builder.addRecord(keepalive(4, 40_000, 'c1', 'ka')); // 28 s — over it

    const run = builder.getRun('r1')!;
    const gaps = run.issues.filter((issue) => issue.code === 'keepalive-gap');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe('info');
    expect(gaps[0]!.runId).toBe('r1');
    // anchored to the keepalive that CLOSED the gap, not the one that opened it
    expect(gaps[0]!.seq).toBe(4);
    expect(gaps[0]!.tMs).toBe(40_000);
    expect(run.recordSeqs).toEqual([1]);
  });

  it('treats an exactly-15 s keepalive gap as no gap at all', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(keepalive(2, 1_000, 'c1', 'ka'));
    builder.addRecord(keepalive(3, 16_000, 'c1', 'ka')); // exactly 15 000 ms

    // requirements §7 flags a gap LONGER than 15 s, so the comparison is strictly greater
    // and the boundary itself is clean. 11 s and 28 s cannot tell `<=` from `<`; this can.
    expect(builder.getRun('r1')!.issues.filter((issue) => issue.code === 'keepalive-gap')).toEqual([]);
  });

  it('raises keepalive-gap one millisecond past the 15 s threshold', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(keepalive(2, 1_000, 'c1', 'ka'));
    builder.addRecord(keepalive(3, 16_001, 'c1', 'ka')); // 15 001 ms — the first gap there is

    const gaps = builder.getRun('r1')!.issues.filter((issue) => issue.code === 'keepalive-gap');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.seq).toBe(3);
    expect(gaps[0]!.message).toContain('15001ms');
  });

  it('attaches a keepalive gap to the orphaned run when the connection has no run', () => {
    const builder = createRunBuilder();

    builder.addRecord(keepalive(1, 0, 'c1', 'ka'));
    builder.addRecord(keepalive(2, 30_000, 'c1', 'ka'));

    const orphan = builder.getRun(ORPHANED_RUN_ID)!;
    const gaps = orphan.issues.filter((issue) => issue.code === 'keepalive-gap');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.seq).toBe(2);
    expect(gaps[0]!.runId).toBe(ORPHANED_RUN_ID);
    // a keepalive is not a protocol event: it contributes no record seqs, so the orphaned
    // run is still empty as far as `runs()` is concerned
    expect(orphan.recordSeqs).toEqual([]);
    expect(builder.runs()).toEqual([]);
  });

  it('tracks the keepalive gap per connection, not builder-wide', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'cA', { type: 'RUN_STARTED', threadId: 'tA', runId: 'rA' }));
    builder.addRecord(rec(2, 0, 'cB', { type: 'RUN_STARTED', threadId: 'tB', runId: 'rB' }));
    builder.addRecord(keepalive(3, 1_000, 'cA', 'ka'));
    builder.addRecord(keepalive(4, 2_000, 'cB', 'ka'));
    builder.addRecord(keepalive(5, 30_000, 'cA', 'ka'));
    builder.addRecord(keepalive(6, 31_000, 'cB', 'ka'));

    // 29 s on cA and 29 s on cB — one gap each, not one interleaved 1 s gap each
    expect(builder.getRun('rA')!.issues.filter((issue) => issue.code === 'keepalive-gap')).toHaveLength(1);
    expect(builder.getRun('rB')!.issues.filter((issue) => issue.code === 'keepalive-gap')).toHaveLength(1);
  });
});

/**
 * The provenance of the records, carried onto every run the fold produces.
 *
 * `core/` is Chrome-free so a CLI or a VS Code extension can reuse this fold (§13), which is
 * exactly why the fact travels here rather than being applied by the panel afterwards: a
 * consumer that filtered issues downstream would re-inherit the defect this closes.
 */
describe('createRunBuilder — what the capture says was redacted out of it', () => {
  const ARGS_DELTA = '«redacted: 16 chars»';

  function foldToolCall(builder: ReturnType<typeof createRunBuilder>, argsText: string): void {
    // The request line matters: without it the run also reports `run-started-without-input`,
    // which would make the issue lists below about something other than the tool arguments.
    builder.addRequest('c1', 'POST', 'https://example.test/agent', { threadId: 't1' });
    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'f' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: argsText }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));
    builder.addRecord(rec(5, 40, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));
  }

  it('defaults to nothing redacted, because a live capture never is', () => {
    const builder = createRunBuilder();
    foldToolCall(builder, '{"q":"x"}');

    expect(builder.getRun('r1')!.redacted).toEqual([]);
  });

  it('puts the declared groups on every run it produces, orphans included', () => {
    const builder = createRunBuilder({ redacted: ['text', 'toolArgs'] });
    builder.addRecord(rec(1, 0, 'c1', { type: 'TEXT_MESSAGE_END', messageId: 'm1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));

    expect(builder.getRun('r1')!.redacted).toEqual(['text', 'toolArgs']);
    expect(builder.getRun(ORPHANED_RUN_ID)!.redacted).toEqual(['text', 'toolArgs']);
  });

  it('copies the array, so a caller mutating theirs cannot rewrite what a run claims', () => {
    const groups: RedactionGroup[] = ['toolArgs'];
    const builder = createRunBuilder({ redacted: groups });
    foldToolCall(builder, ARGS_DELTA);
    groups.length = 0;

    expect(builder.getRun('r1')!.redacted).toEqual(['toolArgs']);
  });

  it('is what stops the fold inventing tool-args-not-json on a redacted capture', () => {
    // The whole defect, at the level `core/` owns it. Same bytes, same fold; the only
    // difference is whether the capture says its tool arguments are still the agent's.
    const unaware = createRunBuilder();
    foldToolCall(unaware, ARGS_DELTA);
    expect(unaware.allIssues().map((issue) => issue.code)).toEqual(['tool-args-not-json']);

    const aware = createRunBuilder({ redacted: ['toolArgs'] });
    foldToolCall(aware, ARGS_DELTA);
    expect(aware.allIssues()).toEqual([]);

    // The reconstruction is untouched: the bytes are still shown, and `argsParseError` still
    // records that they did not parse. Only the CLAIM about whose fault that is is withdrawn.
    const call = aware.getRun('r1')!.toolCalls.get('tc1')!;
    expect(call.argsText).toBe(ARGS_DELTA);
    expect(call.argsParseError).toBeDefined();
  });
});
