import { describe, expect, it } from 'vitest';
import type { ThreadplaneDevtoolsReport } from '../../../core/signals/report';
import { columnLabel, MAX_COLUMN_LABEL, MAX_COLUMNS, signalBlocks } from './matrix';

function report(
  agent: string,
  seq: number,
  wrote: string[],
  adapter: ThreadplaneDevtoolsReport['adapter'] = 'ag-ui',
  eventType = 'TEXT_MESSAGE_CONTENT',
): ThreadplaneDevtoolsReport {
  return { v: 1, agent, adapter, seq, eventType, wrote, tMs: seq };
}

describe('signalBlocks', () => {
  it('is empty without reports', () => {
    expect(signalBlocks([])).toEqual([]);
  });

  it('groups per agent instance, in the order each agent first reported', () => {
    const blocks = signalBlocks([
      report('bbbbbbbb-2', 1, ['status'], 'langgraph', 'values'),
      report('aaaaaaaa-1', 1, ['messages']),
      report('bbbbbbbb-2', 2, ['messages'], 'langgraph', 'messages'),
    ]);
    expect(blocks.map((b) => [b.agent, b.adapter, b.total])).toEqual([
      ['bbbbbbbb-2', 'langgraph', 2],
      ['aaaaaaaa-1', 'ag-ui', 1],
    ]);
    expect(blocks[0]?.adapterLabel).toBe('LangGraph');
    expect(blocks[1]?.adapterLabel).toBe('AG-UI');
    expect(blocks[0]?.shortAgent).toBe('bbbbbbbb');
  });

  it('rows are the names seen in the block, in the vocabulary’s order — not write order', () => {
    const [block] = signalBlocks([
      report('a', 1, ['state', 'messages']),
      report('a', 2, ['isLoading', 'status']),
    ]);
    // AG-UI vocabulary: messages, status, isLoading, error, toolCalls, state, …
    expect(block?.rows).toEqual(['messages', 'status', 'isLoading', 'state']);
  });

  it('columns are the reports in seq order, each with the names it lit', () => {
    const [block] = signalBlocks([report('a', 3, ['status']), report('a', 1, ['messages'])]);
    expect(block?.columns.map((c) => c.report.seq)).toEqual([1, 3]);
    expect(block?.columns[0]?.lit.has('messages')).toBe(true);
    expect(block?.columns[0]?.lit.has('status')).toBe(false);
  });

  it(`caps each block at the last ${String(MAX_COLUMNS)} columns and says how many there were`, () => {
    const reports = Array.from({ length: MAX_COLUMNS + 20 }, (_, i) =>
      report('a', i + 1, [i === 0 ? 'error' : 'messages']),
    );
    const [block] = signalBlocks(reports);
    expect(block?.total).toBe(MAX_COLUMNS + 20);
    expect(block?.columns).toHaveLength(MAX_COLUMNS);
    expect(block?.columns[0]?.report.seq).toBe(21);
    expect(block?.capped).toBe(true);
    // A row that only the hidden columns lit would be a row of nothing.
    expect(block?.rows).toEqual(['messages']);
  });
});

describe('columnLabel', () => {
  it('shows every common AG-UI event name in full, so TEXT_MESSAGE_* columns are told apart', () => {
    const names = ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'TOOL_CALL_RESULT'];
    expect(names.map((name) => columnLabel(name))).toEqual(names);
    expect(Math.max(...names.map((name) => name.length))).toBeLessThanOrEqual(MAX_COLUMN_LABEL);
  });

  it('keeps the first word and the distinguishing end of a longer name', () => {
    expect(columnLabel('REASONING_MESSAGE_CONTENT')).toBe('REASONING…CONTENT');
    expect(columnLabel('REASONING_MESSAGE_START')).toBe('REASONING…START');
    expect(columnLabel('THINKING_TEXT_MESSAGE_CONTENT')).toBe('THINKING…CONTENT');
    expect(columnLabel('THINKING_TEXT_MESSAGE_END')).toBe('THINKING…MESSAGE_END');
  });

  it('keeps a LangGraph base name and marks the namespace', () => {
    expect(columnLabel('messages|research:9f1c0d2e-77aa')).toBe('messages|…');
    expect(columnLabel('values')).toBe('values');
  });

  it('never exceeds the limit, whatever the name', () => {
    for (const name of ['X'.repeat(128), `${'A'.repeat(30)}_B`, `A_${'B'.repeat(30)}`, `${'m'.repeat(40)}|ns`]) {
      expect(columnLabel(name).length).toBeLessThanOrEqual(MAX_COLUMN_LABEL);
    }
    expect(columnLabel('X'.repeat(128))).toBe(`${'X'.repeat(19)}…`);
  });
});
