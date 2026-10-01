import { describe, expect, it } from 'vitest';
import type { CaptureRecord } from '../model/types';
import { MATCH_WINDOW_MS, matchReport, recordEventName } from './match';
import type { ThreadplaneDevtoolsReport } from './report';

function agUi(seq: number, tMs: number, type: string, connId = 'c1'): CaptureRecord {
  return { kind: 'event', seq, tMs, connId, raw: '', issues: [], event: { type } };
}

function langGraph(seq: number, tMs: number, sseEvent: string): CaptureRecord {
  return { kind: 'event', seq, tMs, connId: 'c1', raw: '', issues: [], event: null, sseEvent };
}

function report(
  seq: number,
  eventType: string,
  tMs: number,
  agent = 'a1',
  adapter: ThreadplaneDevtoolsReport['adapter'] = 'ag-ui',
): ThreadplaneDevtoolsReport {
  return { v: 1, agent, adapter, seq, eventType, wrote: ['messages'], tMs };
}

describe('recordEventName', () => {
  it('reads AG-UI from the payload and LangGraph from the SSE event name', () => {
    expect(recordEventName(agUi(1, 0, 'RUN_STARTED'), 'ag-ui')).toBe('RUN_STARTED');
    expect(recordEventName(langGraph(1, 0, 'values'), 'langgraph')).toBe('values');
  });

  it('reads the name the way the report’s adapter does, when a frame carries both', () => {
    const both: CaptureRecord = {
      kind: 'event', seq: 1, tMs: 0, connId: 'c1', raw: '', issues: [], event: { type: 'RUN_STARTED' }, sseEvent: 'agui',
    };
    expect(recordEventName(both, 'ag-ui')).toBe('RUN_STARTED');
    expect(recordEventName(both, 'langgraph')).toBe('agui');
  });

  it('keeps a LangGraph namespace, cut at the hook’s 128 characters', () => {
    expect(recordEventName(langGraph(1, 0, 'messages|research:t1'), 'langgraph')).toBe('messages|research:t1');
    const long = `values|${'n'.repeat(200)}`;
    expect(recordEventName(langGraph(1, 0, long), 'langgraph')).toBe(long.slice(0, 128));
  });

  it('has no name for a keepalive or an unparsed AG-UI frame', () => {
    expect(
      recordEventName({ kind: 'keepalive', seq: 1, tMs: 0, connId: 'c', raw: '', issues: [], comment: '' }, 'ag-ui'),
    ).toBeNull();
    expect(
      recordEventName({ kind: 'event', seq: 1, tMs: 0, connId: 'c', raw: '', issues: [], event: null }, 'ag-ui'),
    ).toBeNull();
  });
});

describe('matchReport', () => {
  const records = [
    agUi(1, 10, 'RUN_STARTED'),
    agUi(2, 20, 'TEXT_MESSAGE_CONTENT'),
    agUi(3, 30, 'TEXT_MESSAGE_CONTENT'),
    agUi(4, 40, 'TEXT_MESSAGE_CONTENT'),
    agUi(5, 50, 'RUN_FINISHED'),
  ];

  it('matches by name and order when the counts agree — even against a nearer frame by time', () => {
    const reports = [
      report(1, 'RUN_STARTED', 11),
      report(2, 'TEXT_MESSAGE_CONTENT', 21),
      report(3, 'TEXT_MESSAGE_CONTENT', 31),
      // Stamped right beside seq 2's frame, but it is the third of three: order wins.
      report(4, 'TEXT_MESSAGE_CONTENT', 19),
      report(5, 'RUN_FINISHED', 51),
    ];
    expect(matchReport(reports[3]!, reports, records)).toEqual({ kind: 'order', seq: 4 });
    expect(matchReport(reports[0]!, reports, records)).toEqual({ kind: 'order', seq: 1 });
    expect(matchReport(reports[4]!, reports, records)).toEqual({ kind: 'order', seq: 5 });
  });

  it('orders by report seq, not by the order the reports are held in', () => {
    const reports = [
      report(4, 'TEXT_MESSAGE_CONTENT', 41),
      report(2, 'TEXT_MESSAGE_CONTENT', 21),
      report(3, 'TEXT_MESSAGE_CONTENT', 31),
    ];
    expect(matchReport(reports[0]!, reports, records)).toEqual({ kind: 'order', seq: 4 });
  });

  it('falls back to the nearest same-named frame by time when the counts disagree', () => {
    // Two reports for three frames — the first frame came before the hook was listening, say.
    const reports = [report(1, 'TEXT_MESSAGE_CONTENT', 31.5), report(2, 'TEXT_MESSAGE_CONTENT', 41)];
    expect(matchReport(reports[0]!, reports, records)).toEqual({
      kind: 'time',
      seq: 3,
      deltaMs: 1.5,
    });
  });

  it('counts per agent: another agent with the same event names forces the time fallback', () => {
    const reports = [
      report(1, 'RUN_STARTED', 12, 'a1'),
      report(1, 'RUN_STARTED', 300, 'a2'),
    ];
    const two = [agUi(1, 10, 'RUN_STARTED', 'c1'), agUi(2, 299, 'RUN_STARTED', 'c2')];
    expect(matchReport(reports[1]!, reports, two)).toEqual({ kind: 'time', seq: 2, deltaMs: 1 });
  });

  it('matches a namespaced LangGraph event by its full name, as Threadplane reports it', () => {
    // Threadplane's bridge reports `StreamEvent.type` verbatim: the subgraph's `messages|…` frames
    // and the parent's `messages` frames are different names, counted apart.
    const lg = [
      langGraph(1, 5, 'metadata'),
      langGraph(2, 9, 'messages|research:t1'),
      langGraph(3, 12, 'messages'),
      langGraph(4, 15, 'messages|research:t1'),
    ];
    const reports = [
      report(1, 'messages|research:t1', 10, 'g', 'langgraph'),
      report(2, 'messages', 13, 'g', 'langgraph'),
      report(3, 'messages|research:t1', 16, 'g', 'langgraph'),
    ];
    expect(matchReport(reports[0]!, reports, lg)).toEqual({ kind: 'order', seq: 2 });
    expect(matchReport(reports[1]!, reports, lg)).toEqual({ kind: 'order', seq: 3 });
    expect(matchReport(reports[2]!, reports, lg)).toEqual({ kind: 'order', seq: 4 });
  });

  it('matches nothing for a pseudo-event, which has no frame on the wire', () => {
    const reports = [report(1, 'run:start', 9)];
    expect(matchReport(reports[0]!, reports, records)).toEqual({ kind: 'none' });
  });

  it('matches nothing by time beyond the window — another document’s clock is not comparable', () => {
    const reports = [report(1, 'RUN_FINISHED', 50 + MATCH_WINDOW_MS + 1), report(2, 'RUN_FINISHED', 9e6)];
    expect(matchReport(reports[0]!, reports, records)).toEqual({ kind: 'none' });
  });

  it('matches nothing in an empty capture', () => {
    const reports = [report(1, 'RUN_STARTED', 1)];
    expect(matchReport(reports[0]!, reports, [])).toEqual({ kind: 'none' });
  });
});
