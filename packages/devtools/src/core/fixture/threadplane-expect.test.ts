import { describe, expect, test } from 'vitest';
import lgReasoningJsonl from '../../test/fixtures/lg-reasoning.agui.jsonl?raw';
import lgReasoningCanonical from '../../test/fixtures/lg-reasoning.canonical.txt?raw';
import lgSubgraphJsonl from '../../test/fixtures/lg-subgraph.agui.jsonl?raw';
import { aiChunk, type LangGraphTestFrame } from '../../test/langgraph-capture';
import { expectationsFor } from './threadplane-expect';
import { frameOf, type ThreadplaneFrame } from './threadplane-normalizer';

/*
 * Every expectation below was also observed by replaying the same frames through
 * @threadplane/langgraph 0.2.0 itself (MockAgentTransport + toStreamEvent, a fresh agent,
 * `submit({ state })`), so these tests pin Threadplane's behaviour, not a guess at it. Task 5
 * re-runs generated specs inside Threadplane for the end-to-end proof.
 */

const human = { type: 'human', id: 'h1', content: 'hi' };
const submitted = { state: { messages: [{ type: 'human', content: 'hi' }] } };

function values(data: Record<string, unknown>, event = 'values'): LangGraphTestFrame {
  return { event, data };
}

function capturedFrames(jsonl: string): { input: unknown; frames: ThreadplaneFrame[] } {
  const lines = jsonl.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = lines.find((line) => line['kind'] === 'request') as { input: { input: unknown } };
  const frames = lines
    .filter((line) => line['kind'] === 'event')
    .map((line) => frameOf(line as { sseEvent?: string; event: unknown }));
  return { input: request.input.input, frames };
}

describe('expectationsFor (T4)', () => {
  test('a run that ends on a final root values is idle, not interrupted, with its answer', () => {
    const frames = [
      { event: 'metadata', data: { run_id: 'r1' } },
      values({ messages: [human] }),
      aiChunk('a1', 'Hel'),
      aiChunk('a1', 'lo'),
      values({ messages: [human, { type: 'ai', id: 'a1', content: 'Hello' }] }),
    ];
    expect(expectationsFor(frames, submitted)).toEqual({ status: 'idle', interrupted: false, lastAssistantText: 'Hello' });
  });

  test('a stream cut off after chunks, with no root values after them, is an error', () => {
    const frames = [values({ messages: [human] }), aiChunk('a1', 'Hel')];
    expect(expectationsFor(frames, submitted)).toEqual({ status: 'error', interrupted: false, lastAssistantText: 'Hel' });
  });

  test('a root values carrying __interrupt__ pauses: idle and interrupted', () => {
    const frames = [
      values({ messages: [human] }),
      aiChunk('a1', 'Ok'),
      values({ messages: [human, { type: 'ai', id: 'a1', content: 'Ok' }], __interrupt__: [{ value: 'approve?', id: 'i1' }] }),
    ];
    expect(expectationsFor(frames, submitted)).toEqual({ status: 'idle', interrupted: true, lastAssistantText: 'Ok' });
  });

  test('a root error frame is an error, and no assistant text is claimed when there is none', () => {
    const frames = [values({ messages: [human] }), { event: 'error', data: { error: 'ValueError', message: 'boom' } }];
    expect(expectationsFor(frames, submitted)).toEqual({ status: 'error', interrupted: false });
  });

  test('tool calls come from the final type-ai message, in order', () => {
    const call = (name: string, id: string) => ({ name, id, args: {} });
    const asking = { type: 'ai', id: 'a1', content: '', tool_calls: [call('lookup', 'c1'), call('fetch', 'c2')] };
    const frames = [
      aiChunk('a1', '', { tool_call_chunks: [{ name: 'lookup', id: 'c1', args: '{}', index: 0 }] }),
      values({ messages: [human, asking] }),
      values({ messages: [human, asking, { type: 'tool', id: 't1', tool_call_id: 'c1', content: 'r' }] }),
      aiChunk('a2', 'Done'),
      values({ messages: [human, asking, { type: 'tool', id: 't1', tool_call_id: 'c1', content: 'r' }, { type: 'ai', id: 'a2', content: 'Done' }] }),
    ];
    expect(expectationsFor(frames, submitted)).toEqual({
      status: 'idle',
      interrupted: false,
      lastAssistantText: 'Done',
      toolCallNames: ['lookup', 'fetch'],
    });
  });

  test('streamed tool_call_chunks alone show no tool calls: Threadplane reads only tool_calls on type ai', () => {
    const frames = [
      aiChunk('m2', [], { tool_call_chunks: [{ index: 0, id: 'call_1', name: 'get_weather', args: '{}' }] }),
      values({ messages: [human, { type: 'ai', id: 'm1', content: 'Sunny.' }] }),
    ];
    expect(expectationsFor(frames, submitted).toolCallNames).toBeUndefined();
  });

  test('subgraph messages and values change neither status nor text', () => {
    const root = [aiChunk('a1', 'Root answer'), values({ messages: [human, { type: 'ai', id: 'a1', content: 'Root answer' }] })];
    const withSubgraph = [
      { ...aiChunk('s1', 'Sub text'), event: 'messages|research:t1' },
      values({ notes: 'x' }, 'values|research:t1'),
      ...root,
      { ...aiChunk('s2', 'Later sub text'), event: 'messages|research:t1' },
      values({ __interrupt__: [{ value: 'child' }] }, 'values|research:t1'),
    ];
    expect(expectationsFor(withSubgraph, submitted)).toEqual(expectationsFor(root, submitted));
    expect(expectationsFor(withSubgraph, submitted)).toEqual({ status: 'idle', interrupted: false, lastAssistantText: 'Root answer' });
  });

  test('a subgraph values after the last chunk is not the end of the run', () => {
    const frames = [aiChunk('a1', 'x'), values({ notes: 'x' }, 'values|sub:1')];
    expect(expectationsFor(frames, submitted).status).toBe('error');
  });

  test('a namespaced error still fails the run: Threadplane does not filter error events by namespace', () => {
    const frames = [
      aiChunk('a1', 'x'),
      values({ messages: [human, { type: 'ai', id: 'a1', content: 'x' }] }),
      { event: 'error|sub:1', data: { message: 'boom' } },
    ];
    expect(expectationsFor(frames, submitted).status).toBe('error');
  });

  test('no status is claimed when an interruption is left showing as running', () => {
    // An `updates` __interrupt__ sets interrupt() without ending the attempt, so the cut-off
    // close is an interruption Threadplane stays silent about: status() stays running.
    const frames = [aiChunk('a1', 'Ok'), values({ __interrupt__: [{ value: 'q', id: 'i1' }] }, 'updates')];
    expect(expectationsFor(frames, submitted)).toEqual({ interrupted: true, lastAssistantText: 'Ok' });
  });

  test('a submitted message with no type counts as an assistant message, as Threadplane shows it', () => {
    const frames = [{ event: 'error', data: { message: 'boom' } }];
    expect(expectationsFor(frames, { state: { messages: [{ role: 'user', content: 'hi' }] } }).lastAssistantText).toBe('hi');
    expect(expectationsFor(frames, { resume: 'yes' }).lastAssistantText).toBeUndefined();
  });

  test('chunks under changing ids merge into one message, as the bridge merges them', () => {
    const frames = [
      aiChunk('e1', 'Hel'),
      aiChunk('e2', 'lo'),
      aiChunk('e3', ' world'),
      values({ messages: [human, { type: 'ai', id: 'final', content: 'Hello world' }] }),
    ];
    expect(expectationsFor(frames, submitted)).toEqual({ status: 'idle', interrupted: false, lastAssistantText: 'Hello world' });
  });

  test('a state key named type re-types the event (the toStreamEvent spread quirk), so it is no terminal values', () => {
    const frames = [values({ type: 'other', messages: [human, { type: 'ai', id: 'a', content: 'x' }] })];
    expect(expectationsFor(frames, submitted)).toEqual({ status: 'error', interrupted: false });
  });

  test('an unparseable replay yields no expectations rather than wrong ones', () => {
    expect(expectationsFor([values({ messages: [null] })], submitted)).toEqual({});
  });

  test('lg-reasoning: idle, with the canonical answer as the last assistant text', () => {
    const { input, frames } = capturedFrames(lgReasoningJsonl);
    expect(expectationsFor(frames, { state: input })).toEqual({
      status: 'idle',
      interrupted: false,
      lastAssistantText: lgReasoningCanonical,
    });
  });

  test('lg-subgraph: idle, with the root answer', () => {
    const { input, frames } = capturedFrames(lgSubgraphJsonl);
    expect(expectationsFor(frames, { state: input })).toEqual({ status: 'idle', interrupted: false, lastAssistantText: 'Answer' });
  });
});
