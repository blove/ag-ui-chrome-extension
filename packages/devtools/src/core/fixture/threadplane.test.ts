import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import { aiChunk, langGraphJsonl, type LangGraphTestFrame } from '../../test/langgraph-capture';
import { decodeJsonl, type JsonlLine } from '../jsonl/codec';
import golden from './__golden__/small.spec.ts.txt?raw';
import { toThreadplaneSpec } from './threadplane';

const FILENAME = 'threadplane-localhost-2024-2026-09-30T12-00-00.000Z.spec.ts';
const human = { type: 'human', id: 'h1', content: 'hi' };

/** A finished five-frame run: metadata, the submitted message, two chunks, the final values. */
const smallFrames: LangGraphTestFrame[] = [
  { event: 'metadata', data: { run_id: 'run-1' } },
  { event: 'values', data: { messages: [human] } },
  aiChunk('a1', 'Hel'),
  aiChunk('a1', 'lo'),
  { event: 'values', data: { messages: [human, { type: 'ai', id: 'a1', content: 'Hello' }] } },
];

function linesOf(text: string): JsonlLine[] {
  return decodeJsonl(text).lines;
}

function spec(text: string): string {
  const out = toThreadplaneSpec(linesOf(text), { filename: FILENAME });
  if (out === null) throw new Error('expected a spec');
  return out;
}

/** The body of the `it` whose title names `connId`. */
function caseOf(text: string, connId: string): string {
  const start = text.indexOf(`it("replays connection ${connId} `);
  if (start < 0) throw new Error(`no it for ${connId}`);
  const end = text.indexOf('\n  });', start);
  return text.slice(start, end);
}

/** Every identifier the TypeScript scanner sees outside comments, strings and templates' text. */
function codeIdentifiers(source: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, source);
  const out: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier) out.push(scanner.getTokenText());
  }
  return out;
}

describe('toThreadplaneSpec (T2, T3, T5)', () => {
  test('the whole file for a small capture, as pinned in __golden__/small.spec.ts.txt', () => {
    expect(spec(langGraphJsonl(smallFrames))).toBe(golden);
  });

  test('is deterministic: the same export yields the same text', () => {
    expect(spec(langGraphJsonl(smallFrames))).toBe(spec(langGraphJsonl(smallFrames)));
  });

  test('is null when no connection is LangGraph', () => {
    expect(toThreadplaneSpec(linesOf(happyJsonl), { filename: FILENAME })).toBeNull();
  });

  test('imports from where it is told to, for a spec run inside Threadplane itself', () => {
    const text = toThreadplaneSpec(linesOf(langGraphJsonl(smallFrames)), { filename: FILENAME, importFrom: '../../public-api' });
    expect(text).toContain("provideAgent, type StreamEvent } from '../../public-api';");
  });

  test('one it per LangGraph connection, in order, each replaying only its own frames; AG-UI connections are left out', () => {
    const second = langGraphJsonl([{ event: 'metadata', data: { run_id: 'run-2' } }, aiChunk('b1', 'Second')], {
      header: false,
      connId: 'c9',
      firstSeq: 100,
    });
    const agui = happyJsonl.split('\n').slice(1).join('\n').replace(/"connId":"c1"/g, '"connId":"c5"');
    const text = spec(`${langGraphJsonl(smallFrames)}\n${agui}\n${second}`);

    expect(text.match(/\n {2}it\(/g)).toHaveLength(2);
    expect(text.indexOf('replays connection c1 (run run-1)')).toBeLessThan(text.indexOf('replays connection c9 (run run-2)'));
    expect(caseOf(text, 'c1')).toContain('frames_1.map(toStreamEvent)');
    expect(caseOf(text, 'c9')).toContain('frames_2.map(toStreamEvent)');
    const frames2 = text.slice(text.indexOf('const frames_2'), text.indexOf('describe('));
    expect(frames2).toContain('"Second"');
    expect(frames2).not.toContain('"Hel"');
    expect(text).not.toContain('RUN_STARTED');
  });

  test('a join connection (GET, no body) submits {} and asserts no payload', () => {
    const post = langGraphJsonl([{ event: 'metadata', data: { run_id: 'r-join' } }, aiChunk('m1', 'Hel')]);
    const join = langGraphJsonl([aiChunk('m1', 'lo'), { event: 'values', data: { messages: [] } }], {
      header: false,
      connId: 'c2',
      method: 'GET',
      url: 'http://localhost:2024/threads/t-1/runs/r-join/stream',
      body: null,
      firstSeq: 3,
    });
    const text = spec(`${post}\n${join}`);
    const joinCase = caseOf(text, 'c2');

    expect(joinCase).toContain('replays connection c2 (run r-join)');
    expect(joinCase).toContain('const submitted = agent.submit({});');
    expect(joinCase).toContain("assistantId: 'agent'");
    expect(joinCase).not.toContain('payload');
    expect(text).not.toContain('const request_2');
    expect(text).toContain('// Connection c2: GET http://localhost:2024/threads/t-1/runs/r-join/stream.');
  });

  test('a captured command.resume is resumed, not submitted as state', () => {
    const text = spec(langGraphJsonl(smallFrames, { body: { assistant_id: 'agent', input: null, command: { resume: 'yes' } } }));
    expect(caseOf(text, 'c1')).toContain('const submitted = agent.submit({ resume: request_1.command.resume });');
    expect(caseOf(text, 'c1')).not.toContain('payload');
  });

  test('assertions are exactly the derived expectations: an absent one is not asserted', () => {
    // An `updates` __interrupt__ leaves Threadplane silent about the status (see expectationsFor).
    const frames = [aiChunk('a1', 'Ok'), { event: 'updates', data: { __interrupt__: [{ value: 'q', id: 'i1' }] } }];
    const body = caseOf(spec(langGraphJsonl(frames)), 'c1');
    expect(body).not.toContain('agent.status()');
    expect(body).toContain('expect(agent.interrupt()).toBeDefined();');
    expect(body).not.toContain('toolCalls');
  });

  test('tool-call names are asserted, in order, when Threadplane shows them', () => {
    const asking = { type: 'ai', id: 'a1', content: '', tool_calls: [{ name: 'lookup', id: 'c1', args: {} }] };
    const frames = [
      { event: 'values', data: { messages: [human, asking] } },
      aiChunk('a2', 'Done'),
      { event: 'values', data: { messages: [human, asking, { type: 'ai', id: 'a2', content: 'Done' }] } },
    ];
    expect(spec(langGraphJsonl(frames))).toContain('expect(agent.toolCalls().map((call) => call.name)).toEqual(["lookup"]);');
  });

  test('no lastAssistantText helper when no it asserts text', () => {
    const text = spec(langGraphJsonl([{ event: 'error', data: { message: 'boom' } }], { body: { assistant_id: 'agent', command: { resume: 1 } } }));
    expect(text).not.toContain('lastAssistantText');
    expect(text).toContain('expect(agent.status()).toBe("error");');
  });

  test('a captured URL cannot close the header comment', () => {
    const text = langGraphJsonl(smallFrames).replace('"url":"http://localhost:2024"', '"url":"http://x/*/y"');
    const out = spec(text);
    expect(out).toContain(' * Origin: http://x/* /y');
  });

  test('no captured string can become code: hostile connId, URL, method, run id and redaction groups stay inert', () => {
    const hostile = 'x\n globalThis.pwned = 1; // */ globalThis.pwned = 2; /* ` ${globalThis.pwned} \u2028 globalThis.pwned = 3; "\'';
    const body = langGraphJsonl([{ event: 'metadata', data: { run_id: hostile } }, aiChunk('a1', hostile)], {
      connId: hostile,
      method: hostile,
      url: `http://localhost:2024/${hostile}`,
      body: { assistant_id: hostile, input: { messages: [{ type: 'human', content: hostile }] } },
    }).replace(
      '"redacted":[]',
      `"redacted":${JSON.stringify(['text', hostile])}`,
    ).replace('"capturedAt":"2026-09-30T12:00:00.000Z"', `"capturedAt":${JSON.stringify(hostile)}`);
    const out = toThreadplaneSpec(linesOf(body), { filename: FILENAME }) ?? '';

    expect(codeIdentifiers(out)).not.toContain('pwned');
    const { diagnostics } = ts.transpileModule(out, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    expect((diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  });

  test('a header field of the wrong type in an imported file does not throw', () => {
    const body = langGraphJsonl(smallFrames).replace('"url":"http://localhost:2024"', '"url":42');
    expect(spec(body)).toContain(' * Origin: 42');
  });

  test('the output is TypeScript that parses without errors', () => {
    const { diagnostics } = ts.transpileModule(spec(langGraphJsonl(smallFrames)), {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    expect((diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  });
});
