import { createRunBuilder } from '@devtools/core/normalizer/run-builder';
import { createSseParser, type SseFrame } from '@devtools/core/sse/parser';
import type { AguiEvent, CaptureRecord, Issue } from '@devtools/core/model/types';

const CONN_ID = 'c1';

export interface ReplayResult {
  records: CaptureRecord[];
  issues: Issue[];
  contentType: string | null;
  binaryBytes: number;
}

/**
 * Drive one run against the harness server and fold it with the real `core/` pipeline.
 *
 * This is the offline half of the corpus: the same bytes the capture layer will see, parsed by the
 * same parser and folded by the same run builder, with no extension in the way. Its purpose is to
 * make `Scenario.expectIssues` an observation instead of a guess — if this and the Playwright e2e
 * disagree, the capture layer is what is wrong.
 *
 * The request body is fed in by default. Verified fact 4: with no captured `RunAgentInput` every
 * run additionally reports `run-started-without-input`, so omitting it would bake a spurious info
 * issue into every scenario in the corpus. `withRequest: false` exists only to demonstrate that,
 * so the fact stays observed rather than remembered.
 */
export async function replayScenario(
  url: string,
  opts: { withRequest?: boolean } = {},
): Promise<ReplayResult> {
  const withRequest = opts.withRequest ?? true;
  const input = {
    threadId: 't_harness',
    runId: 'r_harness',
    state: {},
    messages: [{ id: 'm_user_1', role: 'user', content: 'run the scenario' }],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
  });

  const contentType = response.headers.get('content-type');
  const builder = createRunBuilder();
  if (withRequest) builder.addRequest(CONN_ID, 'POST', url, input);

  const body = response.body;
  if (body === null) throw new Error('harness response had no body');

  // requirements §5.4: a non-SSE transport is detected and labelled, never parsed. Reading it as
  // text would manufacture records that the capture layer will correctly refuse to produce.
  if (contentType === null || !contentType.startsWith('text/event-stream')) {
    const bytes = (await response.arrayBuffer()).byteLength;
    builder.closeConnection(CONN_ID, 0);
    return { records: [], issues: builder.allIssues(), contentType, binaryBytes: bytes };
  }

  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const records: CaptureRecord[] = [];
  const startedAt = Date.now();
  let seq = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      records.push(toRecord(frame, ++seq, Date.now() - startedAt));
    }
  }
  for (const frame of parser.flush()) {
    records.push(toRecord(frame, ++seq, Date.now() - startedAt));
  }

  for (const record of records) builder.addRecord(record);
  builder.closeConnection(CONN_ID, Date.now() - startedAt);

  return { records, issues: builder.allIssues(), contentType, binaryBytes: 0 };
}

function toRecord(frame: SseFrame, seq: number, tMs: number): CaptureRecord {
  if (frame.kind === 'keepalive') {
    return {
      kind: 'keepalive',
      seq,
      tMs,
      connId: CONN_ID,
      raw: frame.comment,
      comment: frame.comment,
      issues: [],
    };
  }
  let event: AguiEvent | null = null;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    const hasType =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === 'string';
    event = hasType ? (parsed as AguiEvent) : null;
  } catch {
    event = null;
  }
  return { kind: 'event', seq, tMs, connId: CONN_ID, raw: frame.data, event, issues: [] };
}
