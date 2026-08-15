import type { AguiEvent } from '@devtools/core/model/types';

import { convertGoldenFixture, type ScenarioKeepalive } from './convert.js';

export type { ScenarioKeepalive } from './convert.js';

export interface Scenario {
  name: string;
  description: string;
  events: AguiEvent[];
  delayMs?: number;
  /** Expected issue codes after capture, for the e2e assertion. */
  expectIssues: string[];
  /**
   * Comment frames interleaved with the events. Additive to the locked contract — see
   * `Contract gaps` (GAP-A1). `keepalive-gap` cannot be provoked without it: aimock's writer emits
   * only `data:` frames, so a `Scenario` of events alone can never put a `:` comment on the wire.
   */
  keepalives?: ScenarioKeepalive[];
  /**
   * Response `Content-Type`. Defaults to `text/event-stream`. Additive to the locked contract —
   * see `Contract gaps` (GAP-A2). Requirements §5.4 asks capture to detect and label a binary
   * transport, which is a property of the response headers and of no event in the stream.
   */
  contentType?: string;
}

const happyGolden = convertGoldenFixture('happy-run.agui.jsonl');
const malformedGolden = convertGoldenFixture('malformed.agui.jsonl');
const chunkedGolden = convertGoldenFixture('chunked-run.agui.jsonl');

/**
 * A gap longer than the run builder's 15 000 ms threshold, with margin for scheduler jitter.
 * It is real wall-clock sleep on the server: the capture layer stamps `tMs` from arrival time,
 * so the gap cannot be faked by lying in the payload.
 */
const KEEPALIVE_GAP_SLEEP_MS = 15_500;

/** Authored: a clean run whose only defect is a stalled heartbeat. */
const keepaliveGapEvents: AguiEvent[] = [
  { type: 'RUN_STARTED', threadId: 't_gap', runId: 'r_gap' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Thinking about it' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm_1' },
  { type: 'RUN_FINISHED', threadId: 't_gap', runId: 'r_gap' },
];

/** Authored: chunk-only stream, the CopilotKit default shape, paced slowly on purpose. */
const slowChunkEvents: AguiEvent[] = [
  { type: 'RUN_STARTED', threadId: 't_slow', runId: 'r_slow' },
  { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm_1', role: 'assistant', delta: 'Streaming' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' one' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' word' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' at' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' a' },
  { type: 'TEXT_MESSAGE_CHUNK', delta: ' time.' },
  { type: 'RUN_FINISHED', threadId: 't_slow', runId: 'r_slow' },
];

/** Authored: the §5.4 binary transport. Same events, framed as opaque bytes. */
const binaryEvents: AguiEvent[] = [
  { type: 'RUN_STARTED', threadId: 't_bin', runId: 'r_bin' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Encoded as protobuf.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm_1' },
  { type: 'RUN_FINISHED', threadId: 't_bin', runId: 'r_bin' },
];

export const AGUI_PROTO_CONTENT_TYPE = 'application/vnd.ag-ui.event+proto';

export const SCENARIOS: Record<string, Scenario> = {
  happy: {
    name: 'happy',
    description:
      'Converted from happy-run.agui.jsonl: text, a tool call with a result, a state snapshot ' +
      'and a delta, one keepalive, RUN_FINISHED. Nothing wrong with it.',
    events: happyGolden.events,
    keepalives: happyGolden.keepalives,
    expectIssues: [],
  },
  malformed: {
    name: 'malformed',
    description:
      'Converted from malformed.agui.jsonl: an empty TEXT_MESSAGE_CONTENT delta, a STATE_DELTA ' +
      'whose path has no parent, and no terminal event.',
    events: malformedGolden.events,
    keepalives: malformedGolden.keepalives,
    expectIssues: ['empty-text-delta', 'state-patch-failed', 'run-never-terminated'],
  },
  chunked: {
    name: 'chunked',
    description:
      'Converted from chunked-run.agui.jsonl: TEXT_MESSAGE_CHUNK and TOOL_CALL_CHUNK triads with ' +
      'the id carried forward, which the chunk expander must reconstruct.',
    events: chunkedGolden.events,
    keepalives: chunkedGolden.keepalives,
    expectIssues: [],
  },
  'keepalive-gap': {
    name: 'keepalive-gap',
    description:
      'Authored: two comment frames 15.5 s apart around an otherwise clean run. The only ' +
      'scenario that reaches the keepalive-gap code path.',
    events: keepaliveGapEvents,
    keepalives: [
      { afterEvents: 4, comment: 'ping', delayBeforeMs: 0 },
      { afterEvents: 4, comment: 'ping', delayBeforeMs: KEEPALIVE_GAP_SLEEP_MS },
    ],
    expectIssues: ['keepalive-gap'],
  },
  'slow-chunks': {
    name: 'slow-chunks',
    description:
      'Authored: a chunk-only run written one event every 150 ms, so the tee() consumer is ' +
      'exercised across many small reads rather than one buffered flush (requirements §15).',
    events: slowChunkEvents,
    delayMs: 150,
    expectIssues: [],
  },
  binary: {
    name: 'binary',
    description:
      'Authored: a clean run served as length-prefixed opaque frames under the protobuf content ' +
      'type. Requirements §5.4 asks capture to label it, not to decode it, so it yields no ' +
      'records and therefore no issues.',
    events: binaryEvents,
    contentType: AGUI_PROTO_CONTENT_TYPE,
    expectIssues: [],
  },
};
