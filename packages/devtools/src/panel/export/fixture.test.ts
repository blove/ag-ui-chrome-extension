import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import type { JsonlLine } from '../../core/jsonl/codec';
import { loadJsonl } from '../import/load-jsonl';
import { buildExport } from './build';
import { toFixtureModule } from './fixture';

function linesOf(text = happyJsonl): JsonlLine[] {
  const loaded = loadJsonl(text);
  return buildExport(
    {
      records: loaded.records,
      requests: loaded.requests,
      runs: loaded.runs,
      importedHeader: loaded.header,
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
