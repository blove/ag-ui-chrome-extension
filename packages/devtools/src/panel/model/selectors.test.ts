// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  makeIssue,
  type AguiEvent,
  type CaptureRecord,
  type Issue,
  type Run,
} from '../../core/model/types';
import { initialPanelState, type PanelState } from './panel-types';
import {
  visibleRecords,
  scopedIssues,
  issueCounts,
  scopedRun,
  selectedRecord,
  issuesBySeq,
} from './selectors';

function eventRecord(seq: number, event: AguiEvent): CaptureRecord {
  return { kind: 'event', seq, tMs: seq * 10, connId: 'c1', raw: event, event, issues: [] };
}

function keepaliveRecord(seq: number, comment: string): CaptureRecord {
  return {
    kind: 'keepalive',
    seq,
    tMs: seq * 10,
    connId: 'c1',
    raw: `:${comment}\n\n`,
    comment,
    issues: [],
  };
}

function run(runId: string, recordSeqs: number[]): Run {
  return {
    runId,
    threadId: 't_1',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs,
  };
}

const RECORDS: CaptureRecord[] = [
  eventRecord(1, { type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' }),
  eventRecord(2, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello Paris' }),
  eventRecord(3, { type: 'RUN_FINISHED', threadId: 't_1', runId: 'r_1' }),
  keepaliveRecord(4, 'ping'),
  eventRecord(5, { type: 'RUN_STARTED', threadId: 't_1', runId: 'r_2' }),
  eventRecord(6, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_2', delta: '' }),
];

const ISSUES: Issue[] = [
  makeIssue('unclosed-message', 'Message m_1 never closed', 2, { runId: 'r_1' }),
  makeIssue('keepalive-gap', 'Keepalive gap of 20000ms', 2, { runId: 'r_1' }),
  makeIssue('empty-text-delta', 'TEXT_MESSAGE_CONTENT carried an empty delta', 6, {
    runId: 'r_2',
  }),
];

function state(overrides: Partial<PanelState> = {}): PanelState {
  return {
    ...initialPanelState(),
    runs: [run('r_1', [1, 2, 3]), run('r_2', [5, 6])],
    records: RECORDS,
    issues: ISSUES,
    ...overrides,
  };
}

const seqs = (records: CaptureRecord[]): number[] => records.map((record) => record.seq);

describe('visibleRecords', () => {
  it('returns every record, in order, when the scope is null', () => {
    expect(seqs(visibleRecords(state()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('scopes to one run’s records', () => {
    expect(seqs(visibleRecords(state({ scope: 'r_1' })))).toEqual([1, 2, 3]);
    expect(seqs(visibleRecords(state({ scope: 'r_2' })))).toEqual([5, 6]);
  });

  it('returns nothing for an unknown run id', () => {
    expect(visibleRecords(state({ scope: 'r_nope' }))).toEqual([]);
  });

  it('excludes keepalives from a run scope, because they never enter recordSeqs', () => {
    expect(seqs(visibleRecords(state({ scope: 'r_1' })))).not.toContain(4);
  });

  it('filters to records carrying issues when issuesOnly is set', () => {
    expect(seqs(visibleRecords(state({ filter: { text: '', issuesOnly: true } })))).toEqual([2, 6]);
  });

  it('filters by case-insensitive substring over the serialized record', () => {
    expect(seqs(visibleRecords(state({ filter: { text: 'PARIS', issuesOnly: false } })))).toEqual([
      2,
    ]);
    expect(seqs(visibleRecords(state({ filter: { text: 'paris', issuesOnly: false } })))).toEqual([
      2,
    ]);
    expect(
      seqs(visibleRecords(state({ filter: { text: 'RUN_STARTED', issuesOnly: false } }))),
    ).toEqual([1, 5]);
  });

  it('serializes a keepalive by its comment, not its event', () => {
    expect(seqs(visibleRecords(state({ filter: { text: 'ping', issuesOnly: false } })))).toEqual([
      4,
    ]);
  });

  it('composes the text filter with issuesOnly', () => {
    expect(seqs(visibleRecords(state({ filter: { text: 'hello', issuesOnly: true } })))).toEqual([
      2,
    ]);
    // 'hello' alone matches only seq 2; issuesOnly alone matches 2 and 6; together, 2.
    expect(seqs(visibleRecords(state({ filter: { text: 'hello', issuesOnly: false } })))).toEqual([
      2,
    ]);
    expect(
      seqs(visibleRecords(state({ filter: { text: 'RUN_STARTED', issuesOnly: true } }))),
    ).toEqual([]);
  });

  it('composes the scope with both filters', () => {
    expect(
      seqs(visibleRecords(state({ scope: 'r_1', filter: { text: '', issuesOnly: true } }))),
    ).toEqual([2]);
  });
});

describe('scopedIssues', () => {
  it('returns every issue when the scope is null', () => {
    expect(scopedIssues(state()).map((issue) => issue.code)).toEqual([
      'unclosed-message',
      'keepalive-gap',
      'empty-text-delta',
    ]);
  });

  it('returns only the scoped run’s issues', () => {
    expect(scopedIssues(state({ scope: 'r_2' })).map((issue) => issue.code)).toEqual([
      'empty-text-delta',
    ]);
  });

  it('returns nothing for an unknown run id', () => {
    expect(scopedIssues(state({ scope: 'r_nope' }))).toEqual([]);
  });
});

describe('issueCounts', () => {
  it('tallies by severity and total', () => {
    expect(issueCounts(state())).toEqual({ error: 1, warning: 1, info: 1, total: 3 });
  });

  it('tallies within the current scope', () => {
    expect(issueCounts(state({ scope: 'r_1' }))).toEqual({
      error: 0,
      warning: 1,
      info: 1,
      total: 2,
    });
  });

  it('is all zeroes with no issues', () => {
    expect(issueCounts(state({ issues: [] }))).toEqual({
      error: 0,
      warning: 0,
      info: 0,
      total: 0,
    });
  });
});

describe('issuesBySeq', () => {
  it('groups issues by seq, keeping several on one seq', () => {
    const bySeq = issuesBySeq(state());

    expect([...bySeq.keys()].sort((a, b) => a - b)).toEqual([2, 6]);
    expect(bySeq.get(2)?.map((issue) => issue.code)).toEqual(['unclosed-message', 'keepalive-gap']);
    expect(bySeq.get(6)?.map((issue) => issue.code)).toEqual(['empty-text-delta']);
    expect(bySeq.get(1)).toBeUndefined();
  });

  it('groups only the scoped issues', () => {
    expect([...issuesBySeq(state({ scope: 'r_2' })).keys()]).toEqual([6]);
  });
});

describe('scopedRun', () => {
  it('returns the named run', () => {
    expect(scopedRun(state({ scope: 'r_2' }))?.runId).toBe('r_2');
  });

  it('returns undefined for an unknown id', () => {
    expect(scopedRun(state({ scope: 'r_nope' }))).toBeUndefined();
  });

  it('returns undefined for the all-runs scope', () => {
    expect(scopedRun(state({ scope: null }))).toBeUndefined();
  });
});

describe('selectedRecord', () => {
  it('returns the record for selectedSeq', () => {
    expect(selectedRecord(state({ selectedSeq: 4 }))?.kind).toBe('keepalive');
  });

  it('returns undefined when selectedSeq is null', () => {
    expect(selectedRecord(state({ selectedSeq: null }))).toBeUndefined();
  });

  it('returns undefined for a seq that no record carries', () => {
    expect(selectedRecord(state({ selectedSeq: 99 }))).toBeUndefined();
  });

  it('ignores the scope and the filter, so a selection survives them', () => {
    const s = state({ scope: 'r_1', filter: { text: 'zzz', issuesOnly: true }, selectedSeq: 5 });

    expect(selectedRecord(s)?.seq).toBe(5);
  });
});
