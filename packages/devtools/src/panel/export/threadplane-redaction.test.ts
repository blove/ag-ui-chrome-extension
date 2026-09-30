import { describe, expect, test } from 'vitest';
import { toThreadplaneSpec } from '../../core/fixture/threadplane';
import { expectationsFor } from '../../core/fixture/threadplane-expect';
import { frameOf } from '../../core/fixture/threadplane-normalizer';
import { ALL_REDACTION_GROUPS } from '../../core/jsonl/redact';
import { aiChunk, langGraphJsonl } from '../../test/langgraph-capture';
import { applyLoaded } from '../import/apply-loaded';
import { loadJsonl } from '../import/load-jsonl';
import { initialPanelState } from '../model/panel-types';
import { buildExport } from './build';

/*
 * T5 through the real export path: the spec is built from the lines `buildExport` produced, so a
 * redacted export yields a redacted spec. Lives beside `build.ts` because core/ may not import it.
 */

const FILENAME = 'threadplane-localhost-2024-2026-09-30T12-00-00.000Z.spec.ts';
const human = { type: 'human', id: 'h1', content: 'hi' };
const smallFrames = [
  { event: 'metadata', data: { run_id: 'run-1' } },
  { event: 'values', data: { messages: [human] } },
  aiChunk('a1', 'Hel'),
  aiChunk('a1', 'lo'),
  { event: 'values', data: { messages: [human, { type: 'ai', id: 'a1', content: 'Hello' }] } },
];

describe('toThreadplaneSpec over a redacted export (T5)', () => {
  test('a redacted export carries the redaction note, placeholders, and assertions on the redacted text', () => {
    const text = langGraphJsonl(smallFrames);
    const state = applyLoaded(initialPanelState(), loadJsonl(text), 'small.agui.jsonl', 1000);
    const { lines } = buildExport(state, {
      scope: null,
      groups: [...ALL_REDACTION_GROUPS],
      toolVersion: 'test',
      exportedAtIso: '2026-09-30T12:00:00.000Z',
    });
    const out = toThreadplaneSpec(lines, { filename: FILENAME }) ?? '';

    expect(out).toContain('PARTIALLY REDACTED (requirements §11 groups redacted: text, reasoning, toolArgs, toolResults, state)');
    expect(out).not.toContain('Hello');
    expect(out).not.toContain('"hi"');
    const request = lines.find((line) => line.kind === 'request');
    const frames = lines.flatMap((line) => (line.kind === 'event' ? [frameOf(line)] : []));
    const redactedInput = (request?.input as { input: unknown }).input;
    const expected = expectationsFor(frames, { state: redactedInput }).lastAssistantText;
    expect(expected).toContain('«redacted');
    expect(out).toContain(`expect(lastAssistantText(agent)).toBe(${JSON.stringify(expected)});`);
  });

});
