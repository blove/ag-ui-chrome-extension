import { describe, it, expect } from 'vitest';
import type { Issue, Run, RunMetrics } from '../../../core/model/types';
import { ORPHANED_RUN_ID, makeIssue } from '../../../core/model/types';
import { RUN_COLUMNS, runRows, type RunColumnKey } from './rows';

function emptyMetrics(): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
  };
}

function run(partial: Partial<Run> = {}): Run {
  return {
    runId: 'r_1',
    threadId: 't_1',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: emptyMetrics(),
    issues: [],
    recordSeqs: [],
    redacted: [],
    ...partial,
  };
}

/** The one row a single run produces, so each test can read the cell it is about. */
function rowOf(built: Run): ReturnType<typeof runRows>[number] {
  const [row] = runRows([built]);
  expect(row).toBeDefined();
  return row!;
}

function cell(built: Run, key: RunColumnKey): { text: string; known: boolean; note?: string } {
  return rowOf(built).cells[key];
}

describe('runRows — identity (R1)', () => {
  it('produces one row per run, in the order the capture produced them', () => {
    const rows = runRows([run({ runId: 'r_1' }), run({ runId: 'r_2' }), run({ runId: 'r_3' })]);

    expect(rows.map((row) => row.runId)).toEqual(['r_1', 'r_2', 'r_3']);
  });

  it('carries every §9.2 column and nothing else', () => {
    expect(RUN_COLUMNS.map((column) => column.key)).toEqual([
      'thread',
      'agent',
      'outcome',
      'duration',
      'ttft',
      'events',
      'issues',
    ]);
  });

  it('reads the thread and the agent the run reported', () => {
    const built = run({ threadId: 't_alpha', agentId: 'weather-agent' });

    expect(cell(built, 'thread')).toMatchObject({ text: 't_alpha', known: true });
    expect(cell(built, 'agent')).toMatchObject({ text: 'weather-agent', known: true });
  });
});

/*
 * The R1 clause this module exists for: `agentId`, `durationMs` and `ttftMs` are all optional,
 * and each is absent for a DIFFERENT reason. Printing `0` would be a measurement nobody took;
 * printing a bare `—` in every case would fold "the run is still going" together with "this
 * agent never named itself", which are different findings about a capture.
 */
describe('runRows — absence is stated, never invented', () => {
  it('never reports an unknown value as zero', () => {
    const built = run({ outcome: 'running', metrics: emptyMetrics() });
    const row = rowOf(built);

    for (const key of ['agent', 'duration', 'ttft'] as const) {
      expect(row.cells[key].known).toBe(false);
      expect(row.cells[key].text).not.toBe('0');
      expect(row.cells[key].text).not.toBe('0ms');
    }
  });

  it('says a run still going has no duration YET, rather than that none was reported', () => {
    const running = cell(run({ outcome: 'running' }), 'duration');
    const finished = cell(run({ outcome: 'finished' }), 'duration');

    expect(running.known).toBe(false);
    expect(running.text).toMatch(/still running/i);
    // The two absences are different facts and must not render alike.
    expect(finished.text).not.toBe(running.text);
  });

  it('says an orphaned run has no run start to measure from', () => {
    const built = run({ runId: ORPHANED_RUN_ID, threadId: '', outcome: 'orphaned' });

    expect(cell(built, 'duration')).toMatchObject({ known: false });
    expect(cell(built, 'duration').text).toMatch(/no run start/i);
    // `threadId` is '' for the orphan bucket: there was no RUN_STARTED to carry one.
    expect(cell(built, 'thread')).toMatchObject({ known: false });
    expect(cell(built, 'thread').text).toMatch(/no thread/i);
  });

  it('says a run that emitted no text has no TTFT, distinctly from one still streaming', () => {
    const silent = cell(run({ outcome: 'finished' }), 'ttft');
    const streaming = cell(run({ outcome: 'running' }), 'ttft');

    expect(silent.known).toBe(false);
    expect(silent.text).toMatch(/no text/i);
    expect(streaming.known).toBe(false);
    expect(streaming.text).not.toBe(silent.text);
  });

  it('says why an agent id is missing rather than leaving a blank cell', () => {
    const agent = cell(run({ agentId: undefined }), 'agent');

    expect(agent.known).toBe(false);
    expect(agent.text.trim()).not.toBe('');
    expect(agent.note).toMatch(/RUN_STARTED/);
  });

  it('formats the durations it does know', () => {
    const built = run({ metrics: { ...emptyMetrics(), durationMs: 1840, ttftMs: 140 } });

    expect(cell(built, 'duration')).toMatchObject({ text: '1.84s', known: true });
    expect(cell(built, 'ttft')).toMatchObject({ text: '140ms', known: true });
  });

  /*
   * Zero is a MEASUREMENT here, not an absence: the run recorded no issues, which is a fact the
   * validator established. It must render as `0` and stay `known`, or the table would report a
   * clean run exactly as it reports one whose duration nobody could measure.
   */
  it('reports a count of zero as a known zero', () => {
    const built = run({ issues: [], recordSeqs: [] });

    expect(cell(built, 'issues')).toMatchObject({ text: '0', known: true });
    expect(cell(built, 'events')).toMatchObject({ text: '0', known: true });
  });
});

describe('runRows — counts', () => {
  it('counts the records the run builder attributed to the run', () => {
    const built = run({ recordSeqs: [1, 2, 3, 4, 5] });

    expect(rowOf(built).eventCount).toBe(5);
    expect(cell(built, 'events').text).toBe('5');
  });

  it('counts issues and reports the worst severity, so an error cannot hide behind an info', () => {
    const issues: Issue[] = [
      makeIssue('keepalive-gap', 'a gap', 4),
      makeIssue('unclosed-message', 'still open', 5),
      makeIssue('tool-args-not-json', 'not json', 6),
    ];
    const row = rowOf(run({ issues }));

    expect(row.issueCount).toBe(3);
    expect(row.worstSeverity).toBe('error');
    expect(row.cells.issues.text).toBe('3');
  });

  it('leaves the severity undefined when a run recorded no issues at all', () => {
    expect(rowOf(run({ issues: [] })).worstSeverity).toBeUndefined();
  });
});

describe('runRows — redaction and the Timeline jump (R2)', () => {
  it('marks a run reconstructed from a redacted file', () => {
    expect(rowOf(run({ redacted: ['text', 'toolArgs'] })).redacted).toBe(true);
    expect(rowOf(run({ redacted: [] })).redacted).toBe(false);
  });

  it('offers the run’s first record as the frame to land on in Timeline', () => {
    expect(rowOf(run({ recordSeqs: [7, 8, 9] })).firstSeq).toBe(7);
  });

  it('offers no frame when a run recorded none, rather than inventing seq 0', () => {
    expect(rowOf(run({ recordSeqs: [] })).firstSeq).toBeUndefined();
  });
});

describe('runRows — the accessible name', () => {
  /*
   * The row is one control, so a screen reader announces its NAME, not its cells. Everything the
   * sighted reader can see has to be in it — including the absences, in the same words.
   */
  it('names every column, absences included', () => {
    const built = run({
      runId: 'r_beta',
      threadId: 't_beta',
      agentId: undefined,
      outcome: 'error',
      metrics: { ...emptyMetrics(), durationMs: 120 },
      recordSeqs: [6, 7, 8, 9, 10],
      issues: [makeIssue('tool-args-not-json', 'not json', 8)],
    });
    const { label } = rowOf(built);

    expect(label).toContain('r_beta');
    expect(label).toContain('t_beta');
    expect(label).toContain('error');
    expect(label).toContain('120ms');
    expect(label).toMatch(/no text/i);
    expect(label).toContain('5 events');
    expect(label).toContain('1 issue');
  });

  it('says a row is redacted in its name, not only in its markup', () => {
    expect(rowOf(run({ redacted: ['text'] })).label).toMatch(/redacted/i);
  });
});
