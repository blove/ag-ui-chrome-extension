import { describe, it, expect } from 'vitest';
import { createRunBuilder } from './run-builder';
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
