/**
 * The LangGraph scenarios and their wire encoding, checked offline — so that when
 * `e2e/langgraph.spec.ts` goes red, "the fixture or the writer is wrong" has already been ruled out
 * and what is left is the extension.
 */
import { expect, test } from '@playwright/test';

import { createSseParser } from '@devtools/core/sse/parser';

import {
  convertLangGraphGolden,
  encodeLangGraphFrame,
  langGraphScenarios,
} from '../fixtures/langgraph.js';

test('lg-reasoning converts whole: every event line, every one named', () => {
  const frames = convertLangGraphGolden('lg-reasoning.agui.jsonl');
  expect(frames).toHaveLength(1213);
  expect(frames[0]).toEqual({
    event: 'metadata',
    data: { run_id: '019e0a0b-6976-7c72-8d57-479ba0c859f6', attempt: 1 },
  });
  const counts: Record<string, number> = {};
  for (const frame of frames) counts[frame.event] = (counts[frame.event] ?? 0) + 1;
  expect(counts).toEqual({ metadata: 1, messages: 1210, values: 2 });
});

test('a frame is its name, one data: line per pretty-printed line, and a blank line', () => {
  expect(encodeLangGraphFrame({ event: 'metadata', data: { run_id: 'r-1' } })).toBe(
    'event: metadata\ndata: {\ndata:   "run_id": "r-1"\ndata: }\n\n',
  );
});

test('every scenario round-trips through the extension’s own SSE parser, cut anywhere', () => {
  for (const scenario of Object.values(langGraphScenarios())) {
    const frames = [...scenario.frames, ...(scenario.joinFrames ?? [])];
    const text = frames.map(encodeLangGraphFrame).join('');
    // A prime piece size, so cuts land at every offset within a line over the stream.
    const parser = createSseParser();
    const parsed = [];
    for (let at = 0; at < text.length; at += 97) parsed.push(...parser.push(text.slice(at, at + 97)));
    parsed.push(...parser.flush());
    expect(
      parsed.map((frame) => (frame.kind === 'event' ? { event: frame.eventName, data: JSON.parse(frame.data) } : frame)),
      scenario.name,
    ).toEqual(frames);
  }
});
