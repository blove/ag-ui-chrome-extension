import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import { isThreadplaneReport, MAX_EVENT_TYPE_LENGTH, type ThreadplaneDevtoolsReport } from './report';

/**
 * Every report shape Threadplane's devtools hook is known to emit must validate here.
 *
 * The `[eventType, wrote]` lists below are copied from Threadplane's own tests on the hook's PR
 * (cacheplane/threadplane#1203): `libs/langgraph/src/lib/devtools.spec.ts`,
 * `libs/ag-ui/src/lib/devtools.spec.ts` and `libs/chat/src/lib/devtools/devtools-emitter.spec.ts`
 * — i.e. what the real instrumentation writes, not what this repo assumes it writes. A list that
 * changes there and fails here is the drift this file exists to catch: the extension would drop
 * the report silently, and the Signals tab would just look empty.
 *
 * The other fields follow the emitter (`devtools-emitter.ts`): `agent` is `crypto.randomUUID()`,
 * or `agent-<n>-<8 base36>` where that is missing; `seq` counts from 1 per agent; `tMs` is
 * `performance.now()` (or `Date.now()` without one); `eventType` is cut to 128 characters.
 */
type Shape = readonly [eventType: string, wrote: readonly string[]];

const LANGGRAPH: readonly Shape[] = [
  // Per stream event (MockAgentTransport).
  ['messages', ['messages', 'messageMetadata', 'subagents', 'toolCalls']],
  ['values', ['values', 'messages', 'subagents', 'toolCalls']],
  ['updates', ['values']],
  ['custom', ['custom']],
  ['error', ['subagents', 'error', 'status']],
  ['values', ['values']],
  // Run bracketing — note `run:end` twice in a row, one report per settle step.
  ['run:start', ['status', 'error', 'custom', 'toolProgress', 'messages']],
  ['run:end', ['subagents']],
  ['run:end', ['status']],
  // User actions outside a stream.
  ['branch', ['branch']],
  [
    'reset',
    [
      'status', 'error', 'values', 'messages', 'history', 'interrupt', 'interrupts', 'toolProgress',
      'toolCalls', 'messageMetadata', 'subagents', 'queue', 'custom', 'isThreadLoading',
    ],
  ],
  ['submit', ['error']],
  // History refresh.
  ['history', ['isThreadLoading']],
  ['history', ['history', 'messages', 'values', 'toolCalls']],
  // A nested bracket joins its outer report.
  ['values', ['values', 'queue', 'messages']],
  // Not from those tests: event NAMES the bridge handles (`processEvent`), with a representative
  // name list, because what is under test here is the eventType. `StreamEvent.type` is the SDK's
  // SSE event name verbatim, so subgraph events keep their namespace (`messages|research:t1`).
  ['messages|research:t1', ['subagents', 'messageMetadata']],
  ['messages/partial', ['messages']],
  ['messages/complete', ['messages']],
  ['values|research:t1', ['subagents']],
  ['updates|tools:call_abc123', ['values']],
  ['checkpoints', ['history']],
  ['tasks', ['subagents']],
  ['metadata', ['status']],
];

const AG_UI: readonly Shape[] = [
  ['submit', ['messages']],
  ['RUN_STARTED', ['status', 'isLoading', 'error', 'interrupt', 'customEvents', 'activities']],
  ['TEXT_MESSAGE_START', ['messages']],
  ['TEXT_MESSAGE_CONTENT', ['messages']],
  ['STATE_SNAPSHOT', ['state', 'messages']],
  ['STATE_DELTA', ['state', 'messages']],
  ['TOOL_CALL_START', ['toolCalls', 'messages']],
  ['TOOL_CALL_ARGS', ['toolCalls']],
  ['TOOL_CALL_END', ['toolCalls']],
  ['CUSTOM', ['customEvents']],
  ['RUN_FINISHED', ['messages', 'status', 'isLoading', 'interruptSession', 'interrupt']],
  ['RUN_ERROR', ['messages', 'status', 'isLoading', 'error', 'state']],
  ['run:end', ['state', 'messages', 'status', 'isLoading', 'error']],
  // The emitter's own tests.
  ['RUN_STARTED', ['status', 'isLoading', 'error']],
  ['STATE_DELTA', ['state']],
];

function reportsOf(adapter: ThreadplaneDevtoolsReport['adapter'], agent: string, shapes: readonly Shape[]) {
  return shapes.map(
    ([eventType, wrote], index): ThreadplaneDevtoolsReport => ({
      v: 1,
      agent,
      adapter,
      seq: index + 1,
      eventType,
      wrote: [...wrote],
      // A fractional `performance.now()` reading.
      tMs: 1234.567 + index * 0.1,
    }),
  );
}

describe('Threadplane-shaped reports (cacheplane/threadplane#1203)', () => {
  it('validates every LangGraph report Threadplane’s tests show it emitting', () => {
    for (const report of reportsOf('langgraph', '3b241101-e2bb-4255-8caf-4136c566a962', LANGGRAPH)) {
      expect(isThreadplaneReport(report), JSON.stringify(report)).toBe(true);
    }
  });

  it('validates every AG-UI report Threadplane’s tests show it emitting', () => {
    for (const report of reportsOf('ag-ui', '3b241101-e2bb-4255-8caf-4136c566a962', AG_UI)) {
      expect(isThreadplaneReport(report), JSON.stringify(report)).toBe(true);
    }
  });

  it('validates every AG-UI protocol event type as an eventType', () => {
    for (const type of Object.values(EventType)) {
      const [report] = reportsOf('ag-ui', 'a', [[type, ['messages']]]);
      expect(isThreadplaneReport(report), type).toBe(true);
    }
  });

  it('validates the fallback agent id and a Date.now() clock', () => {
    const [report] = reportsOf('ag-ui', 'agent-12-k3j9x0qz', [['submit', ['messages']]]);
    expect(isThreadplaneReport({ ...report, tMs: 1_790_000_000_000 })).toBe(true);
  });

  it('validates an eventType the emitter cut to 128 characters', () => {
    const cut = `messages|${'subgraph:'.repeat(40)}`.slice(0, MAX_EVENT_TYPE_LENGTH);
    const [report] = reportsOf('langgraph', 'a', [[cut, ['messages']]]);
    expect(isThreadplaneReport(report)).toBe(true);
  });

  it('validates the reset report, the largest Threadplane writes (14 names)', () => {
    const reset = LANGGRAPH.find(([type]) => type === 'reset');
    expect(reset?.[1]).toHaveLength(14);
  });
});
