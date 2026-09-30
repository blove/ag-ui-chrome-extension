import { describe, expect, it } from 'vitest';

import { dialectOf, dialectsOfLines } from './dialect';

const LG_URL = 'http://localhost:2024/threads/t-1/runs/stream';
const CK_URL = 'http://localhost:3000/api/copilotkit/agent/default/run';

describe('dialectOf (L4)', () => {
  it('is langgraph when the request is a LangGraph run-stream route', () => {
    expect(dialectOf({ method: 'POST', url: LG_URL }, undefined)).toBe('langgraph');
    expect(dialectOf({ method: 'GET', url: 'http://h/runs/r-1/stream' }, undefined)).toBe('langgraph');
  });

  it('is langgraph when there is no telling request but the first frame is a metadata event with a run id', () => {
    const first = { sseEvent: 'metadata', payload: { run_id: 'r-1', attempt: 1 } };
    expect(dialectOf(undefined, first)).toBe('langgraph');
    expect(dialectOf({ method: 'POST', url: 'http://h/my/proxy' }, first)).toBe('langgraph');
  });

  it('is agui for a CopilotKit route carrying AG-UI frames', () => {
    expect(dialectOf({ method: 'POST', url: CK_URL }, { payload: { type: 'RUN_STARTED' } })).toBe('agui');
  });

  it('lets the first frame decide on a CopilotKit route, which is not a LangGraph route', () => {
    // The route is checked first, but only a LangGraph route decides on its own; any other
    // route falls through to the metadata check (spec L4).
    const first = { sseEvent: 'metadata', payload: { run_id: 'r-1' } };
    expect(dialectOf({ method: 'POST', url: CK_URL }, first)).toBe('langgraph');
  });

  it('is agui for an AG-UI server that names its events after the event type', () => {
    expect(
      dialectOf({ method: 'POST', url: 'http://h/agent' }, { sseEvent: 'RUN_STARTED', payload: { type: 'RUN_STARTED' } }),
    ).toBe('agui');
  });

  it('is agui when a metadata-named frame carries no run id', () => {
    expect(dialectOf(undefined, { sseEvent: 'metadata', payload: { attempt: 1 } })).toBe('agui');
    expect(dialectOf(undefined, { sseEvent: 'metadata', payload: 'r-1' })).toBe('agui');
  });

  it('is agui with nothing to go on', () => {
    expect(dialectOf(undefined, undefined)).toBe('agui');
  });
});

describe('dialectsOfLines (L5, per connection)', () => {
  it('decides each connection from its request line and first event, ignoring headers and keepalives', () => {
    const dialects = dialectsOfLines([
      { kind: 'header', schemaVersion: 1, tool: 't', capturedAt: '2026-09-30T00:00:00.000Z', url: 'http://h', transport: 'sse', redacted: [] },
      { kind: 'request', connId: 'lg', tMs: 0, method: 'POST', url: 'http://h/threads/t/runs/stream', input: {} },
      { kind: 'request', connId: 'ag', tMs: 0, method: 'POST', url: 'http://h/agent', input: {} },
      { kind: 'keepalive', connId: 'px', seq: 1, tMs: 1, comment: '' },
      { kind: 'event', connId: 'px', seq: 2, tMs: 2, sseEvent: 'metadata', event: { run_id: 'r-1' } },
      { kind: 'event', connId: 'ag', seq: 3, tMs: 3, event: { type: 'RUN_STARTED' } },
      { kind: 'event', connId: 'px', seq: 4, tMs: 4, event: { type: 'RUN_STARTED' } },
    ]);
    expect(Object.fromEntries(dialects)).toEqual({ lg: 'langgraph', ag: 'agui', px: 'langgraph' });
  });
});
