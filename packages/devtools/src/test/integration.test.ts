import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  decodeJsonl,
  encodeJsonl,
  type JsonlEvent,
  type JsonlKeepalive,
  type JsonlLine,
} from '../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, redactLine, type RedactionGroup } from '../core/jsonl/redact';
import { createRunBuilder, type RunBuilder } from '../core/normalizer/run-builder';
import type { AguiEvent, CaptureRecord, Issue, Run, StateFrame } from '../core/model/types';

function loadFixture(name: string): JsonlLine[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const { lines, errors } = decodeJsonl(text);
  expect(errors).toEqual([]);
  return lines;
}

/** A19: `CaptureRecord` is a union on `kind`, so an event record must say so explicitly. */
function toRecord(line: JsonlEvent): CaptureRecord {
  return {
    kind: 'event',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: line.event,
    event: line.event as AguiEvent,
    issues: [],
  };
}

/**
 * A keepalive frame carries a comment, never an event — the union is what makes that
 * structural. `raw` is reconstituted as the SSE comment bytes the frame occupied on the wire
 * (Task 12's convention), so `totalStreamBytes` counts a keepalive identically on both sides
 * of a round trip.
 */
function toKeepaliveRecord(line: JsonlKeepalive): CaptureRecord {
  return {
    kind: 'keepalive',
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: `:${line.comment}\n\n`,
    comment: line.comment,
    issues: [],
  };
}

/** Replays a decoded stream exactly as the panel does, closing every connection at the end. */
/**
 * `redacted` is what a caller would read off the file's own `JsonlHeader.redacted` and hand to
 * the fold. Omitting it is the honest default for a caller that has no header to read — and it
 * is exactly what the panel's `loadJsonl` does NOT do, since line 1 always says.
 */
function buildFrom(lines: JsonlLine[], redacted: RedactionGroup[] = []): RunBuilder {
  const builder = createRunBuilder({ redacted });
  const lastTMsByConn = new Map<string, number>();

  for (const line of lines) {
    if (line.kind === 'request') {
      builder.addRequest(line.connId, line.method, line.url, line.input);
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'event') {
      builder.addRecord(toRecord(line));
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'keepalive') {
      // A keepalive is a real frame on the connection: it extends the connection's lifetime
      // and it is what a `keepalive-gap` anchors to, even though it never enters recordSeqs.
      builder.addRecord(toKeepaliveRecord(line));
      lastTMsByConn.set(line.connId, line.tMs);
    }
  }

  for (const [connId, tMs] of lastTMsByConn) builder.closeConnection(connId, tMs);
  return builder;
}

describe('Done-when #5: a malformed stream produces exactly three validator entries', () => {
  it('flags the empty delta, the failed patch and the missing terminal event', () => {
    const builder = buildFrom(loadFixture('malformed.agui.jsonl'));

    const issues = builder.allIssues();

    expect(issues).toHaveLength(3);
    expect(
      [...issues].sort((a, b) => a.seq - b.seq).map((issue) => [issue.code, issue.seq]),
    ).toEqual([
      ['empty-text-delta', 5],
      ['state-patch-failed', 9],
      ['run-never-terminated', 10],
    ]);

    const runs = builder.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe('r_bad');
    // `buildFrom` closes the connection at the last frame's tMs, and Task 13c's
    // `closeConnection` turns a run still `'running'` at close into `'aborted'` with
    // `endedAtMs = tMs`. The missing terminal event shows up as the `run-never-terminated`
    // issue above, not as a run left in `'running'`.
    expect(runs[0]!.outcome).toBe('aborted');
    // The two clean sub-structures stay clean: the message closed, the steps balanced.
    expect(runs[0]!.messages.get('m_1')?.closed).toBe(true);
    expect(runs[0]!.steps).toEqual([
      { stepName: 'analyze', startedAtMs: 20, endedAtMs: 130, closed: true },
    ]);
  });
});

/**
 * `Run.messages` / `toolCalls` / `activities` are Maps, which `toEqual` compares by
 * identity of insertion order rather than by content in a readable way. This flattens a
 * Run into a plain, order-stable object so a mismatch prints as a readable diff.
 */
function runToPlain(run: Run): Record<string, unknown> {
  const entries = <T>(map: Map<string, T>): Array<[string, T]> =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    runId: run.runId,
    threadId: run.threadId,
    parentRunId: run.parentRunId,
    agentId: run.agentId,
    connId: run.connId,
    input: run.input,
    startedAtMs: run.startedAtMs,
    endedAtMs: run.endedAtMs,
    outcome: run.outcome,
    messages: entries(run.messages).map(([id, message]) => [
      id,
      { ...message, contentSeqs: [...message.contentSeqs] },
    ]),
    toolCalls: entries(run.toolCalls).map(([id, toolCall]) => [id, { ...toolCall }]),
    activities: entries(run.activities).map(([id, activity]) => [id, { ...activity }]),
    steps: run.steps.map((step) => ({ ...step })),
    // A16: `StateFrame` is a discriminated union — `patch` and `failure` live on the `delta`
    // arm only, so touching them without narrowing on `kind` is a TS2339.
    stateTimeline: run.stateTimeline.map((frame) =>
      frame.kind === 'delta'
        ? {
            ...frame,
            patch: frame.patch.map((op) => ({ ...op })),
            failure: frame.failure ? { ...frame.failure } : undefined,
          }
        : { ...frame },
    ),
    metrics: {
      ...run.metrics,
      stalls: run.metrics.stalls.map((stall) => ({ ...stall })),
      toolLatencyMs: { ...run.metrics.toolLatencyMs },
      eventCountByType: { ...run.metrics.eventCountByType },
    },
    issues: run.issues.map((issue) => ({ ...issue })),
    recordSeqs: [...run.recordSeqs],
  };
}

describe('Done-when #6: export a run, re-import it, tabs are identical', () => {
  it('rebuilds an identical run model from an encode/decode round trip', () => {
    const lines = loadFixture('happy-run.agui.jsonl');
    const originalBuilder = buildFrom(lines);
    const original = originalBuilder.runs();

    const roundTripped = decodeJsonl(encodeJsonl(lines));
    expect(roundTripped.errors).toEqual([]);
    expect(roundTripped.lines).toEqual(lines);
    const reimported = buildFrom(roundTripped.lines).runs();

    expect(original).toHaveLength(1);
    expect(original[0]!.outcome).toBe('finished');
    expect(original[0]!.messages.get('m_1')?.content).toBe(
      'The weather in Paris is sunny and 24 degrees.\nEnjoy!',
    );
    expect(original[0]!.toolCalls.get('tc_1')?.args).toEqual({ city: 'Paris', units: 'metric' });

    // The keepalive is a first-class line: it decodes, it survives the round trip above, and
    // it is attributed per the keepalive rules — never a protocol event, so never in
    // `recordSeqs`, and its 70 ms gap is far under the 15 s threshold, so it raises nothing.
    expect(lines.some((line) => line.kind === 'keepalive')).toBe(true);
    expect(original[0]!.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
    expect(originalBuilder.allIssues().filter((issue) => issue.code === 'keepalive-gap')).toEqual(
      [],
    );

    expect(reimported.map(runToPlain)).toEqual(original.map(runToPlain));
  });
});

describe('Done-when #7: a redacted export leaks no text and still builds', () => {
  const SECRETS = [
    'What is the weather',
    'The weather in Paris',
    ' is sunny and 24',
    'Enjoy!',
    'Paris',
    'metric',
    'tempC',
    'Sunny',
    'first note',
    'second note',
  ];

  it('contains no original message text anywhere in the serialized output', () => {
    const lines = loadFixture('happy-run.agui.jsonl');

    const redacted = lines.map((line) => redactLine(line, [...ALL_REDACTION_GROUPS]));
    const out = encodeJsonl(redacted);

    for (const secret of SECRETS) {
      expect(out).not.toContain(secret);
    }
    // Sizes survive: "The weather in Paris" is 20 characters.
    expect(out).toContain('«redacted: 20 chars»');
    // Structure survives: types, ids, ordering and timings are untouched.
    expect(out).toContain('"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1"');
    expect(out).toContain('"seq":14,"tMs":360');
    expect(out).toContain('"op":"replace","path":"/counter"');
    expect(out).toContain('"toolCallName":"get_weather"');
    // A keepalive holds no user payload, so redaction passes the whole line through verbatim.
    expect(out).toContain('{"kind":"keepalive","connId":"c1","seq":11,"tMs":220,"comment":"ping"}');
    // The originals are untouched — redactLine copies.
    expect(encodeJsonl(lines)).toContain('The weather in Paris');
  });

  it('still builds the same run structure from the redacted stream', () => {
    const lines = loadFixture('happy-run.agui.jsonl');
    const redacted = lines.map((line) => redactLine(line, [...ALL_REDACTION_GROUPS]));

    const originalRuns = buildFrom(lines).runs();
    const originalIssues = buildFrom(lines).allIssues();
    const redactedBuilder = buildFrom(redacted);
    const redactedRuns = redactedBuilder.runs();
    const redactedIssues = redactedBuilder.allIssues();

    expect(redactedRuns).toHaveLength(originalRuns.length);
    expect(redactedRuns[0]!.runId).toBe(originalRuns[0]!.runId);
    expect(redactedRuns[0]!.threadId).toBe(originalRuns[0]!.threadId);
    expect(redactedRuns[0]!.outcome).toBe(originalRuns[0]!.outcome);
    expect([...redactedRuns[0]!.messages.keys()]).toEqual([...originalRuns[0]!.messages.keys()]);
    expect([...redactedRuns[0]!.toolCalls.keys()]).toEqual([...originalRuns[0]!.toolCalls.keys()]);
    expect(redactedRuns[0]!.recordSeqs).toEqual(originalRuns[0]!.recordSeqs);
    expect(redactedRuns[0]!.steps).toEqual(originalRuns[0]!.steps);
    // A16: `failure` is on the `delta` arm only, so the shape has to be read through `kind`.
    const frameShape = (frames: StateFrame[]): Array<[number, string, unknown]> =>
      frames.map((frame) => [
        frame.seq,
        frame.kind,
        frame.kind === 'delta' ? frame.failure : undefined,
      ]);
    expect(frameShape(redactedRuns[0]!.stateTimeline)).toEqual(
      frameShape(originalRuns[0]!.stateTimeline),
    );

    /*
     * A fold told nothing about the file it is reading has no choice: `«redacted: N chars»`
     * really is not JSON, so it reports `tool-args-not-json` and it is right to, given what it
     * knows. That is the raw arithmetic of redaction, pinned here.
     */
    const key = (issues: Issue[]): string[] =>
      issues.map((issue) => `${issue.code}@${issue.seq}`).sort();
    expect(key(redactedIssues).filter((k) => !k.startsWith('tool-args-not-json@'))).toEqual(
      key(originalIssues),
    );
    expect(key(redactedIssues).filter((k) => k.startsWith('tool-args-not-json@'))).toEqual([
      'tool-args-not-json@10',
    ]);
  });

  it('reports NOTHING extra once the fold is told what the header declares', () => {
    /*
     * The same bytes, the same fold, one difference: the builder has been told what the file
     * says was taken out of it — which is what every real reader has, because the export writes
     * `redacted` into the header on line 1.
     *
     * Redaction removes evidence, so the rule that judged that evidence declines its claim. The
     * recipient of a shared bug report reads a badge and a row tint, and neither may accuse
     * their agent of a defect the redactor introduced.
     */
    const lines = loadFixture('happy-run.agui.jsonl');
    const groups: RedactionGroup[] = [...ALL_REDACTION_GROUPS];
    const redacted = lines.map((line) => redactLine(line, groups));

    const originalIssues = buildFrom(lines).allIssues();
    const awareBuilder = buildFrom(redacted, groups);

    expect(originalIssues).toEqual([]);
    expect(awareBuilder.allIssues()).toEqual([]);
    // The reconstruction is untouched — only the CLAIM is withdrawn. The bytes are still there
    // to read, and the run still says what was removed from it.
    expect(awareBuilder.getRun('r_happy')!.redacted).toEqual(groups);
    expect(awareBuilder.getRun('r_happy')!.toolCalls.get('tc_1')!.argsParseError).toBeDefined();
  });
});

/**
 * The plan lists `chunked-run.agui.jsonl` as written-but-never-loaded. It is loaded here
 * instead, because the behaviour it exercises changed after the plan text was written:
 * Task 13c made the run builder flush outstanding chunk state at `RUN_FINISHED`/`RUN_ERROR`,
 * at `closeConnection` and at a run switch. A cleanly-finished chunk-only stream — the
 * CopilotKit default — therefore closes its last message and tool call, which means no
 * `unclosed-message` / `unclosed-tool-call` warning and a `ToolCallRecord.args` that is
 * actually parsed. An unloaded fixture would leave that regression-prone behaviour unpinned
 * at the integration level.
 */
describe('chunk-only streams reconstruct into the same model as explicit triads', () => {
  it('closes the trailing message and tool call at RUN_FINISHED, raising nothing', () => {
    const builder = buildFrom(loadFixture('chunked-run.agui.jsonl'));

    // The end-of-stream flush is what makes this list empty: without it the trailing
    // TEXT_MESSAGE_CHUNK and TOOL_CALL_CHUNK would each leave an `unclosed-*` warning.
    expect(builder.allIssues()).toEqual([]);

    const runs = builder.runs();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.runId).toBe('r_chunk');
    expect(run.outcome).toBe('finished');
    // Synthesized events carry the terminal frame's seq, so they add no new entries.
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const message = run.messages.get('m_1');
    expect(message?.content).toBe('Hello, world!');
    expect(message?.closed).toBe(true);

    const toolCall = run.toolCalls.get('tc_1');
    expect(toolCall?.toolCallName).toBe('search_docs');
    expect(toolCall?.parentMessageId).toBe('m_1');
    expect(toolCall?.closed).toBe(true);
    // Parsed, not merely accumulated: `args` is filled in by the builder's TOOL_CALL_END
    // case, which a chunk-only stream only ever reaches through the flush.
    expect(toolCall?.args).toEqual({ q: 'ag-ui', limit: 5 });
    expect(toolCall?.argsParseError).toBeUndefined();
  });
});
