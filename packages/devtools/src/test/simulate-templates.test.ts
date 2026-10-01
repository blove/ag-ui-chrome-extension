/**
 * The run simulator's templates (design R9), run through the extension's own reader as a sanity
 * check: a template the extension itself would misread is not one to hand an app.
 *
 * LangGraph templates go through `loadJsonl` — the expander and run builder live capture uses —
 * one connection per run, exactly as the app's scripted streams would be captured.
 */
import { describe, expect, it } from 'vitest';

import { parseArmCommand, type AgUiRunScript, type LangGraphRunScript } from '../core/simulate/commands';
import { armCommand, replayScript, TEMPLATE_IDS, templateScript } from '../core/simulate/templates';
import { loadJsonl } from '../panel/import/load-jsonl';
import { langGraphJsonl } from './langgraph-capture';

function loadLangGraphRun(run: LangGraphRunScript, connId = 'c1'): ReturnType<typeof loadJsonl> {
  return loadJsonl(langGraphJsonl(run.frames, { connId }));
}

function agUiJsonl(run: AgUiRunScript): string {
  const lines: unknown[] = [
    {
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@test',
      capturedAt: '2026-09-30T12:00:00.000Z',
      url: 'http://localhost:8000',
      transport: 'sse',
      redacted: [],
    },
    {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: 'http://localhost:8000/agent',
      input: { threadId: 'sim-thread', runId: 'r', messages: [], tools: [], context: [], state: {}, forwardedProps: {} },
    },
    ...run.events.map((event, i) => ({ kind: 'event', connId: 'c1', seq: i + 1, tMs: (i + 1) * 10, event })),
  ];
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

describe('every template is a valid arm command', () => {
  it.each(TEMPLATE_IDS.flatMap((id) => [['langgraph', id], ['ag-ui', id]] as const))('%s %s', (adapter, id) => {
    const command = armCommand('arm-1', templateScript(adapter, id));
    const parsed = parseArmCommand(command);
    expect(parsed).toEqual({ ok: true, value: command });
  });

  it('returns a fresh copy each time, so editing one cannot change the next', () => {
    const first = templateScript('langgraph', 'interrupt');
    const second = templateScript('langgraph', 'interrupt');
    expect(first).toEqual(second);
    expect(first.runs[0]).not.toBe(second.runs[0]);
  });
});

describe('LangGraph templates, through the extension’s own expander', () => {
  it('interrupt: run 1 stops at the interrupt, run 2 completes on resume', () => {
    const script = templateScript('langgraph', 'interrupt');
    if (script.adapter !== 'langgraph') throw new Error('adapter');
    expect(script.runs).toHaveLength(2);
    const [first, second] = script.runs.map((run) => loadLangGraphRun(run));
    expect(first!.runs.map((run) => run.outcome)).toEqual(['interrupted']);
    expect(second!.runs.map((run) => run.outcome)).toEqual(['finished']);
    expect(first!.issues).toEqual([]);
    expect(second!.issues).toEqual([]);
  });

  it('subagent handoff: the binding custom event and a namespaced child, finishing cleanly', () => {
    const script = templateScript('langgraph', 'subagent-handoff');
    if (script.adapter !== 'langgraph') throw new Error('adapter');
    const frames = script.runs[0]!.frames;
    expect(frames).toContainEqual({
      event: 'custom',
      data: { type: 'threadplane.subagent_binding', namespace: 'tools:sim-child-1', tool_call_id: 'sim-call-1' },
    });
    expect(frames.some((frame) => frame.event === 'messages|tools:sim-child-1')).toBe(true);
    const loaded = loadLangGraphRun(script.runs[0]!);
    const top = loaded.runs.find((run) => run.parentRunId === undefined);
    expect(top?.outcome).toBe('finished');
    // The child's namespace is a run of its own in the extension's model (S1).
    expect(loaded.runs.length).toBeGreaterThan(1);
    expect(loaded.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('malformed event: the extension flags it', () => {
    const script = templateScript('langgraph', 'malformed-event');
    if (script.adapter !== 'langgraph') throw new Error('adapter');
    const loaded = loadLangGraphRun(script.runs[0]!);
    expect(loaded.issues.length).toBeGreaterThan(0);
  });
});

describe('AG-UI templates', () => {
  it('interrupt: run 1 ends in RUN_FINISHED with an interrupt outcome, run 2 in a plain one', () => {
    const script = templateScript('ag-ui', 'interrupt');
    if (script.adapter !== 'ag-ui') throw new Error('adapter');
    expect(script.runs).toHaveLength(2);
    expect(script.runs[0]!.events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'interrupt', interrupts: [{ id: 'sim-interrupt-1' }] },
    });
    expect(script.runs[1]!.events.at(-1)).toEqual({ type: 'RUN_FINISHED', threadId: 'sim-thread', runId: 'sim-run-2' });
    for (const run of script.runs) {
      const loaded = loadJsonl(agUiJsonl(run));
      expect(loaded.runs.map((r) => r.outcome)).toEqual(['finished']);
      expect(loaded.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });

  it('subagent handoff: the child’s content carries its subagentRunId between STARTED and FINISHED', () => {
    const script = templateScript('ag-ui', 'subagent-handoff');
    if (script.adapter !== 'ag-ui') throw new Error('adapter');
    const types = script.runs[0]!.events.map((event) => event.type);
    const started = types.indexOf('SUBAGENT_STARTED');
    const finished = types.indexOf('SUBAGENT_FINISHED');
    expect(started).toBeGreaterThan(-1);
    expect(finished).toBeGreaterThan(started);
    const between = script.runs[0]!.events.slice(started + 1, finished);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((event) => event['subagentRunId'] === 'sim-child-1')).toBe(true);
  });

  it('malformed event: the extension’s validator flags it', () => {
    const script = templateScript('ag-ui', 'malformed-event');
    if (script.adapter !== 'ag-ui') throw new Error('adapter');
    const loaded = loadJsonl(agUiJsonl(script.runs[0]!));
    expect(loaded.issues.map((issue) => issue.code)).toContain('unopened-message-id');
  });
});

describe('replayScript', () => {
  it('LangGraph: the run’s frames as captured, in order, keepalives and other runs left out', () => {
    const loaded = loadJsonl(
      langGraphJsonl([
        { event: 'metadata', data: { run_id: 'r-1' } },
        { event: 'values', data: { messages: [] } },
      ]),
    );
    const run = loaded.runs[0]!;
    const records = [
      ...loaded.records,
      { kind: 'keepalive' as const, seq: 99, tMs: 1, connId: 'c1', raw: ':\n\n', comment: '', issues: [] },
    ];
    const script = replayScript('langgraph', records, [...run.recordSeqs, 99]);
    expect(script).toEqual({
      adapter: 'langgraph',
      runs: [{ frames: [{ event: 'metadata', data: { run_id: 'r-1' } }, { event: 'values', data: { messages: [] } }] }],
    });
    expect(parseArmCommand(armCommand('a', script)).ok).toBe(true);
  });

  it('AG-UI: the run’s events as captured, a frame that did not decode left out', () => {
    const records = [
      { kind: 'event' as const, seq: 1, tMs: 1, connId: 'c1', raw: {}, event: { type: 'RUN_STARTED', threadId: 't', runId: 'r' }, issues: [] },
      { kind: 'event' as const, seq: 2, tMs: 2, connId: 'c1', raw: 'garbage', event: null, issues: [] },
      { kind: 'event' as const, seq: 3, tMs: 3, connId: 'c1', raw: {}, event: { type: 'RUN_FINISHED', threadId: 't', runId: 'r' }, issues: [] },
    ];
    expect(replayScript('ag-ui', records, [1, 2, 3])).toEqual({
      adapter: 'ag-ui',
      runs: [{ events: [records[0]!.event, records[2]!.event] }],
    });
  });

  it('an empty run makes a script the validator refuses, with a reason', () => {
    const parsed = parseArmCommand(armCommand('a', replayScript('ag-ui', [], [])));
    expect(parsed).toEqual({ ok: false, reason: 'runs[0].events is empty' });
  });
});
