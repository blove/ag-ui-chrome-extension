import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import type { JsonlLine } from '../../core/jsonl/codec';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport } from './build';
import { toFixtureModule } from './fixture';
import { langGraphJsonl, aiChunk } from '../../test/langgraph-capture';

function linesOf(text = happyJsonl): JsonlLine[] {
  const loaded = loadJsonl(text);
  return buildExport(
    {
      records: loaded.records,
      requests: loaded.requests,
      runs: loaded.runs,
      importedHeader: loaded.header,
      runtime: loaded.runtime,
      framework: null,
      binaryTransport: null,
      source: { kind: 'imported', filename: 'happy-run.agui.jsonl', importedAtMs: 0 },
    },
    { scope: null, groups: [], toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' },
  ).lines;
}

describe('toFixtureModule', () => {
  test('exports the event array, which is what a test replays', () => {
    const module = toFixtureModule(linesOf(), 'agui-localhost-3000.fixture.ts');
    expect(module).toContain('export const events: AguiEvent[] = [');
    expect(module).toContain('"type": "RUN_STARTED"');
    expect(module).toContain('"type": "RUN_FINISHED"');
  });

  test('carries only the events — a header, a request line and a keepalive are not protocol events', () => {
    const module = toFixtureModule(linesOf(), 'f.fixture.ts');
    expect(module).not.toContain('"kind": "header"');
    expect(module).not.toContain('"kind": "keepalive"');
    expect(module).not.toContain('/api/copilotkit/agent/default/run');
  });

  test('keeps the events in stream order, because order is the whole subject of a protocol test', () => {
    const module = toFixtureModule(linesOf(), 'f.fixture.ts');
    const types = [...module.matchAll(/"type": "([A-Z_]+)"/g)].map((match) => match[1]);
    expect(types).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'STATE_SNAPSHOT',
      'STATE_DELTA',
      'RUN_FINISHED',
    ]);
  });

  test('E7: scaffolds an @ag-ui/client test and nothing more', () => {
    const module = toFixtureModule(linesOf(), 'f.fixture.ts');
    expect(module).toContain("@ag-ui/client");
    // §14.2 grows this into a MockAgentTransport. Building it now would guess at a phase 2 seam.
    expect(module).not.toContain('MockAgentTransport');
  });

  test('names the capture it came from, so a fixture in a repo can be traced back', () => {
    const module = toFixtureModule(linesOf(), 'agui-localhost-3000-2026-08-15.fixture.ts');
    expect(module).toContain('agui-localhost-3000-2026-08-15.fixture.ts');
  });

  test('states what was redacted, so nobody debugs against a placeholder thinking it is real', () => {
    const loaded = loadJsonl(happyJsonl);
    const { lines } = buildExport(
      {
        records: loaded.records,
        requests: loaded.requests,
        runs: loaded.runs,
        importedHeader: loaded.header,
        runtime: loaded.runtime,
        framework: null,
        binaryTransport: null,
        source: { kind: 'imported', filename: 'f', importedAtMs: 0 },
      },
      {
        scope: null,
        groups: ['text', 'state'],
        toolVersion: '0.1.0',
        exportedAtIso: '2026-08-15T12:00:00.000Z',
      },
    );
    expect(toFixtureModule(lines, 'f.fixture.ts')).toContain('redacted: text, state');
  });

  test('says so plainly when nothing was redacted', () => {
    expect(toFixtureModule(linesOf(), 'f.fixture.ts')).toContain('nothing was redacted');
  });

  test('is valid TypeScript source: every brace and bracket balances', () => {
    const module = toFixtureModule(linesOf(), 'f.fixture.ts');
    const count = (char: string): number => module.split(char).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('[')).toBe(count(']'));
  });

  test('an event whose payload never parsed is kept as it was, not dropped', () => {
    const module = toFixtureModule(
      [{ kind: 'event', connId: 'c1', seq: 1, tMs: 0, event: 'not an object' }],
      'f.fixture.ts',
    );
    // The array length is what a replay counts on; silently dropping a frame would make the
    // fixture disagree with the capture it was taken from.
    expect(module).toContain('"not an object"');
  });
});

describe('the emitted module is importable TypeScript', () => {
  test('the replay snippet imports the module by its own name, extension dropped', () => {
    const module = toFixtureModule(linesOf(), 'agui-localhost-3000.fixture.ts');
    expect(module).toContain("from './agui-localhost-3000.fixture'");
  });
});

describe('toFixtureModule — LangGraph connections (L18)', () => {
  const lgText = langGraphJsonl([
    { event: 'metadata', data: { run_id: 'r-1' } },
    aiChunk('m1', 'Hi'),
    { event: 'values', data: { messages: [] } },
  ]);

  test('writes LangGraph frames as {event, data} pairs, named, in order', () => {
    const module = toFixtureModule(linesOf(lgText), 'lg.fixture.ts');
    expect(module).toContain('export const langGraphEvents: LangGraphFrame[] = [');
    const names = [...module.matchAll(/"event": "([a-z/|:]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(['metadata', 'messages', 'values']);
  });

  test('a LangGraph-only capture has an empty AG-UI array and defaults to its LangGraph frames', () => {
    const module = toFixtureModule(linesOf(lgText), 'lg.fixture.ts');
    expect(module).toContain('export const events: AguiEvent[] = [] as AguiEvent[];');
    expect(module).toContain('export default langGraphEvents;');
  });

  test('points at the Threadplane test for a MockAgentTransport replay, now that §14.2 is built', () => {
    const module = toFixtureModule(linesOf(lgText), 'lg.fixture.ts');
    expect(module).not.toContain('will generate');
    expect(module).toContain('Download Threadplane test');
  });

  test("an imported header's origin, capture time and redaction groups cannot end the header comment", () => {
    const hostile = 'x\n*/ globalThis.pwned = 1; /*';
    const text = happyJsonl.replace(/^\{[^\n]*\n/, (header) => {
      const parsed = JSON.parse(header) as Record<string, unknown>;
      return `${JSON.stringify({ ...parsed, url: hostile, capturedAt: hostile, redacted: ['text', hostile] })}\n`;
    });
    const module = toFixtureModule(linesOf(text), 'f.fixture.ts');
    const comment = module.slice(0, module.indexOf('*/') + 2);
    expect(comment).toContain('Origin: x * / globalThis.pwned = 1; /*');
    expect(module.indexOf('globalThis.pwned')).toBeLessThan(comment.length);
    expect(module.lastIndexOf('globalThis.pwned')).toBeLessThan(comment.length);
  });

  test('an AG-UI capture has no LangGraph block at all', () => {
    const module = toFixtureModule(linesOf(), 'f.fixture.ts');
    expect(module).not.toContain('langGraphEvents');
    expect(module).toContain('export default events;');
  });
});
