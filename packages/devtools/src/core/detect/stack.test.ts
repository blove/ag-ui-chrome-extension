import { describe, expect, it } from 'vitest';
import type { CaptureRecord } from '../model/types';
import type { RuntimeInfo } from './info';
import {
  BADGE_DEFAULT_TITLE,
  badgeFor,
  createStackTracker,
  detectStack,
  type StackInput,
  type StackRequest,
} from './stack';

let seq = 0;

function event(connId: string, payload: unknown, sseEvent?: string): CaptureRecord {
  seq += 1;
  const isObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload);
  return {
    kind: 'event',
    seq,
    tMs: seq,
    connId,
    raw: payload,
    event: isObject ? (payload as { type: string }) : null,
    ...(sseEvent !== undefined ? { sseEvent } : {}),
    issues: [],
  };
}

function keepalive(connId: string): CaptureRecord {
  seq += 1;
  return { kind: 'keepalive', seq, tMs: seq, connId, raw: ':', comment: '', issues: [] };
}

function request(connId: string, url = '/agent', method = 'POST'): StackRequest {
  return { connId, method, url };
}

function input(partial: Partial<StackInput>): StackInput {
  return { requests: [], records: [], runtime: null, binaryConnections: [], ...partial };
}

const RUNTIME: RuntimeInfo = { version: '1.52.1', mode: 'multi-route', agents: [] };

describe('detectStack', () => {
  it('sees nothing in an empty tab, and the badge says nothing', () => {
    const stack = detectStack(input({}));
    expect(stack).toEqual({ agui: 0, langGraph: 0 });
    expect(badgeFor(stack)).toEqual({ text: '', title: 'AG-UI DevTools' });
    expect(BADGE_DEFAULT_TITLE).toBe('AG-UI DevTools');
  });

  it('counts a connection as AG-UI once one of its records has a known AG-UI type', () => {
    const stack = detectStack(
      input({
        requests: [request('c1')],
        records: [event('c1', { type: 'RUN_STARTED', threadId: 't', runId: 'r' })],
      }),
    );
    expect(stack).toEqual({ agui: 1, langGraph: 0 });
    expect(badgeFor(stack)).toEqual({
      text: 'AG',
      title: 'AG-UI DevTools — AG-UI · 1 connection — open DevTools → AG-UI',
    });
  });

  it('does not count a stream of other JSON or unparseable frames (B4)', () => {
    // Capture takes every SSE stream on a granted origin. A random SSE app on localhost must not
    // light the badge.
    const stack = detectStack(
      input({
        requests: [request('c1', '/ticks', 'GET')],
        records: [
          event('c1', { hello: 1 }),
          event('c1', 'not json'),
          event('c1', { type: 'TOTALLY_MADE_UP' }),
          keepalive('c1'),
        ],
      }),
    );
    expect(stack).toEqual({ agui: 0, langGraph: 0 });
    expect(badgeFor(stack)).toEqual({ text: '', title: 'AG-UI DevTools' });
  });

  it('does not count a connection that opened and has sent nothing yet', () => {
    expect(detectStack(input({ requests: [request('c1')] }))).toEqual({ agui: 0, langGraph: 0 });
  });

  it('counts a LangGraph route as LangGraph, even when a payload has a known AG-UI type', () => {
    const stack = detectStack(
      input({
        requests: [request('c1', 'http://localhost:2024/threads/t1/runs/stream')],
        records: [event('c1', { type: 'RUN_STARTED' }, 'values')],
      }),
    );
    expect(stack).toEqual({ agui: 0, langGraph: 1 });
    expect(badgeFor(stack)).toEqual({
      text: 'LG',
      title: 'AG-UI DevTools — LangGraph Platform · 1 connection — open DevTools → AG-UI',
    });
  });

  it('counts a proxied LangGraph stream by its first metadata frame', () => {
    const stack = detectStack(
      input({
        requests: [request('c1', '/api/chat')],
        records: [
          event('c1', { run_id: 'r1', attempt: 1 }, 'metadata'),
          event('c1', { type: 'TEXT_MESSAGE_CONTENT' }, 'values'),
        ],
      }),
    );
    expect(stack).toEqual({ agui: 0, langGraph: 1 });
  });

  it('names both stacks when a tab speaks both', () => {
    const stack = detectStack(
      input({
        requests: [request('a'), request('l', '/threads/t1/runs/stream')],
        records: [
          event('a', { type: 'RUN_STARTED' }),
          event('l', { run_id: 'r1' }, 'metadata'),
        ],
      }),
    );
    expect(stack).toEqual({ agui: 1, langGraph: 1 });
    expect(badgeFor(stack)).toEqual({
      text: 'A+L',
      title:
        'AG-UI DevTools — AG-UI · LangGraph Platform · 2 connections — open DevTools → AG-UI',
    });
  });

  it('counts a binary (protobuf) connection as AG-UI', () => {
    const stack = detectStack(input({ binaryConnections: ['b1'] }));
    expect(stack).toEqual({ agui: 1, langGraph: 0 });
    expect(badgeFor(stack).text).toBe('AG');
  });

  it('counts each connection once, however many records it has', () => {
    const records = [
      event('c1', { type: 'RUN_STARTED' }),
      event('c1', { type: 'TEXT_MESSAGE_START' }),
      event('c1', { type: 'RUN_FINISHED' }),
      event('c2', { type: 'RUN_STARTED' }),
      event('c3', { type: 'RUN_STARTED' }),
    ];
    const stack = detectStack(input({ records, binaryConnections: ['c1'] }));
    expect(stack).toEqual({ agui: 3, langGraph: 0 });
  });

  it('names the runtime when an /info response was seen', () => {
    const stack = detectStack(
      input({
        records: [
          event('c1', { type: 'RUN_STARTED' }),
          event('c2', { type: 'RUN_STARTED' }),
          event('c3', { type: 'RUN_STARTED' }),
        ],
        runtime: RUNTIME,
      }),
    );
    expect(stack).toEqual({ agui: 3, langGraph: 0, runtime: RUNTIME });
    expect(badgeFor(stack)).toEqual({
      text: 'AG',
      title:
        'AG-UI DevTools — AG-UI · CopilotKit runtime 1.52.1 (multi-route) · 3 connections — open DevTools → AG-UI',
    });
  });

  it('names a runtime with no reported version without inventing one', () => {
    const stack = detectStack(
      input({ runtime: { version: null, mode: 'single-route', agents: null } }),
    );
    // An /info answer alone is not a stream: no badge, but the title says what was seen.
    expect(badgeFor(stack)).toEqual({
      text: '',
      title: 'AG-UI DevTools — CopilotKit runtime (single-route) — open DevTools → AG-UI',
    });
  });
});

describe('createStackTracker', () => {
  it('decides a connection once and keeps the decision (sticky)', () => {
    const tracker = createStackTracker();
    tracker.request(request('c1'));
    expect(tracker.record(event('c1', { type: 'RUN_STARTED' }))).toBe(true);
    // Already decided: a later record changes nothing and says so.
    expect(tracker.record(event('c1', { hello: 1 }))).toBe(false);
    expect(tracker.record(event('c1', { type: 'RUN_FINISHED' }))).toBe(false);
    expect(tracker.summary(null)).toEqual({ agui: 1, langGraph: 0 });
  });

  it('reports a change only when a decision is made', () => {
    const tracker = createStackTracker();
    expect(tracker.request(request('c1'))).toBe(false);
    expect(tracker.record(event('c1', { hello: 1 }))).toBe(false);
    expect(tracker.record(event('c1', { type: 'RUN_STARTED' }))).toBe(true);
    expect(tracker.binary('c1')).toBe(false);
    expect(tracker.binary('b1')).toBe(true);
    expect(tracker.binary('b1')).toBe(false);
  });

  it('moves a connection to LangGraph when its request line arrives after its frames', () => {
    const tracker = createStackTracker();
    tracker.record(event('c1', { type: 'RUN_STARTED' }, 'values'));
    expect(tracker.summary(null)).toEqual({ agui: 1, langGraph: 0 });
    expect(tracker.request(request('c1', '/threads/t1/runs/stream'))).toBe(true);
    expect(tracker.summary(null)).toEqual({ agui: 0, langGraph: 1 });
  });

  it('keeps the first request line for a connection', () => {
    const tracker = createStackTracker();
    tracker.request(request('c1'));
    tracker.record(event('c1', { type: 'RUN_STARTED' }));
    expect(tracker.request(request('c1', '/threads/t1/runs/stream'))).toBe(false);
    expect(tracker.summary(null)).toEqual({ agui: 1, langGraph: 0 });
  });

  it('round-trips its decisions, so a restored tracker keeps what it had decided', () => {
    const tracker = createStackTracker();
    tracker.record(event('a', { type: 'RUN_STARTED' }));
    tracker.binary('b');
    tracker.request(request('l', '/threads/t1/runs/stream'));

    const restored = createStackTracker(tracker.decisions());
    expect(restored.summary(null)).toEqual({ agui: 2, langGraph: 1 });
    expect(restored.record(event('a', { type: 'RUN_FINISHED' }))).toBe(false);
  });

  it('ignores a seeded decision it cannot read', () => {
    const restored = createStackTracker([
      { connId: 'a', kind: 'agui' },
      { connId: 'x', kind: 'bogus' as 'agui' },
    ]);
    expect(restored.summary(null)).toEqual({ agui: 1, langGraph: 0 });
  });
});
