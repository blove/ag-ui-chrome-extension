/**
 * LangGraph Platform scenarios: what `POST /threads/:threadId/runs/stream` writes, as frames.
 *
 * A LangGraph stream is not AG-UI on the wire (spec L3): the event type is the SSE `event:` field,
 * not a `type` in the payload, and the JS server pretty-prints every payload across many `data:`
 * lines. So a scenario here is a list of `{ event, data }` frames — the name and the payload, kept
 * apart exactly as the server keeps them — and `encodeLangGraphFrame` is the one place that turns
 * one into bytes.
 *
 * NOT `convert.ts`. That converter keeps only lines whose payload has an AG-UI `type`, which is
 * precisely what a LangGraph payload never has: run through it, the real recording would convert
 * to zero events and every assertion downstream would be vacuous.
 */
import { readFileSync } from 'node:fs';

import { aiChunk, type LangGraphTestFrame } from '@devtools/test/langgraph-capture';

export type LangGraphFrame = LangGraphTestFrame;

export interface LangGraphScenario {
  readonly name: string;
  readonly description: string;
  readonly frames: readonly LangGraphFrame[];
  /**
   * Frames served on a JOIN (`GET /threads/:t/runs/:runId/stream`) rather than on the POST. A
   * scenario with none is served whole on the POST and has no join route.
   */
  readonly joinFrames?: readonly LangGraphFrame[];
}

const GOLDEN_DIR = new URL('../../devtools/src/test/fixtures/', import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The server-side frames that reproduce one LangGraph golden `.agui.jsonl`: every `event` line in
 * seq order, its `sseEvent` as the frame name and its `event` as the payload. A line with no
 * `sseEvent` is a hard error rather than a skip — in a LangGraph capture that is a lost name, the
 * very defect the e2e exists to catch, and a converter that dropped it would hide it.
 */
export function convertLangGraphGolden(fileName: string): LangGraphFrame[] {
  const text = readFileSync(new URL(fileName, GOLDEN_DIR), 'utf8');
  const frames: LangGraphFrame[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.kind !== 'event') continue;
    if (typeof parsed.sseEvent !== 'string') {
      throw new Error(`${fileName}: event seq ${String(parsed.seq)} has no sseEvent`);
    }
    frames.push({ event: parsed.sseEvent, data: parsed.event });
  }
  return frames;
}

/** The recording's streamed answer, byte for byte — what the Messages tab must reconstruct. */
export function langGraphCanonicalText(fileName: string): string {
  return readFileSync(new URL(fileName, GOLDEN_DIR), 'utf8');
}

/**
 * One frame as the LangGraph Platform JS server writes it: the name, then ONE `data:` line per
 * line of the two-space pretty-printed payload, then the blank line that ends the event.
 *
 * The multi-line `data:` is the point. An SSE parser that kept only the last `data:` line, or
 * joined them with anything but `\n`, would decode none of these payloads.
 */
export function encodeLangGraphFrame(frame: LangGraphFrame): string {
  const data = JSON.stringify(frame.data, null, 2)
    .split('\n')
    .map((line) => `data: ${line}\n`)
    .join('');
  return `event: ${frame.event}\n${data}\n`;
}

/** Tool call split across chunks, a tool result, and a subgraph under namespace `research:t1`. */
const toolsSubgraphFrames: LangGraphFrame[] = [
  { event: 'metadata', data: { run_id: 'r-tools', attempt: 1 } },
  { event: 'values', data: { messages: [{ type: 'human', id: 'h1', content: 'weather in SF?' }] } },
  { ...aiChunk('s1', [{ type: 'text', text: 'Looking' }]), event: 'messages|research:t1' },
  { ...aiChunk('s1', [], { chunk_position: 'last' }), event: 'messages|research:t1' },
  { event: 'updates|research:t1', data: { search: { notes: 'x' } } },
  { event: 'values|research:t1', data: { notes: 'x' } },
  { event: 'updates', data: { research: { notes: 'x' } } },
  aiChunk('m2', [], {
    tool_call_chunks: [{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci', type: 'tool_call_chunk' }],
  }),
  aiChunk('m2', [], { tool_call_chunks: [{ index: 0, args: 'ty":"SF"}' }] }),
  aiChunk('m2', [], { chunk_position: 'last' }),
  {
    event: 'messages',
    data: [{ type: 'tool', id: 'tm1', tool_call_id: 'call_1', content: 'Sunny' }, { langgraph_node: 'tools' }],
  },
  aiChunk('m1', 'It is sunny in SF.', { chunk_position: 'last' }),
  {
    event: 'values',
    data: {
      messages: [
        { type: 'human', id: 'h1', content: 'weather in SF?' },
        { type: 'tool', id: 'tm1', tool_call_id: 'call_1', content: 'Sunny' },
        { type: 'ai', id: 'm1', content: 'It is sunny in SF.' },
      ],
    },
  },
];

/** A graph that stops for human approval: `__interrupt__` in `updates`, then in the last `values`. */
const interruptFrames: LangGraphFrame[] = [
  { event: 'metadata', data: { run_id: 'r-interrupt', attempt: 1 } },
  { event: 'values', data: { messages: [{ type: 'human', id: 'h1', content: 'delete the file' }] } },
  aiChunk('m1', 'I need your approval first.', { chunk_position: 'last' }),
  { event: 'updates', data: { __interrupt__: [{ value: 'approve deleting the file?', id: 'i1' }] } },
  { event: 'values', data: { __interrupt__: [{ value: 'approve deleting the file?', id: 'i1' }] } },
];

let cache: Record<string, LangGraphScenario> | undefined;

/**
 * Built on first use, not at import: `page/serve.ts` imports this, and every AG-UI spec starts a
 * page server, so reading a 575 KB golden eagerly would tax suites that never touch LangGraph.
 */
export function langGraphScenarios(): Record<string, LangGraphScenario> {
  cache ??= {
    'lg-reasoning': {
      name: 'lg-reasoning',
      description:
        'Converted from lg-reasoning.agui.jsonl, the real Python-server recording (gpt-5): ' +
        'metadata, 1210 messages-tuple chunks of reasoning then text, two values. Served whole.',
      frames: convertLangGraphGolden('lg-reasoning.agui.jsonl'),
    },
    'lg-tools-subgraph': {
      name: 'lg-tools-subgraph',
      description:
        'Authored from the integration test sequences: a subgraph under research:t1, a tool call ' +
        'whose args are split across chunks, its result, and a final answer.',
      frames: toolsSubgraphFrames,
    },
    'lg-interrupt': {
      name: 'lg-interrupt',
      description: 'Authored: a run that ends on __interrupt__ waiting for human approval.',
      frames: interruptFrames,
    },
    'lg-join': {
      name: 'lg-join',
      description:
        'Authored: the POST stream ends after the first chunk without final values; a join ' +
        '(GET /threads/:t/runs/:runId/stream) continues the same run to its end.',
      frames: [{ event: 'metadata', data: { run_id: 'r-join', attempt: 1 } }, aiChunk('m1', 'Hel')],
      joinFrames: [aiChunk('m1', 'lo', { chunk_position: 'last' }), { event: 'values', data: { messages: [] } }],
    },
  };
  return cache;
}

export function requireLangGraphScenario(name: string): LangGraphScenario {
  const scenario = langGraphScenarios()[name];
  if (scenario === undefined) throw new Error(`no LangGraph scenario named '${name}'`);
  return scenario;
}
