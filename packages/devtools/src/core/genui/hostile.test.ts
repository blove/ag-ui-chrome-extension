/**
 * Extraction and checks against captures built to hurt: huge, deep, cyclic. What is asserted is
 * that nothing throws and nothing goes quadratic — the panel runs this on every append.
 */
import { describe, expect, it } from 'vitest';
import type { AguiEvent, CaptureRecord } from '../model/types';
import { a2uiText, textRun } from '../../test/genui-capture';
import { inspectGenui } from './check';
import { extractSurfaces, type GenuiCapture } from './extract';

describe('generative-UI extraction against hostile captures', () => {
  it('checks a 20,000-deep chain of unknown types in linear time', () => {
    // Each unknown parent used to walk its whole subtree again: quadratic in the chain length.
    const n = 20_000;
    const components = Array.from({ length: n }, (_, i) => ({
      id: i === 0 ? 'root' : `c${String(i)}`,
      component: 'Mystery',
      ...(i + 1 < n ? { child: `c${String(i + 1)}` } : {}),
    }));
    const capture = textRun([a2uiText(components)]);
    const started = performance.now();
    const result = inspectGenui(capture);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(result.surfaces).toHaveLength(1);
    const codes = result.findings.map((finding) => finding.code);
    expect(codes.filter((code) => code === 'unknown_component')).toHaveLength(n);
    // Every component but the root sits under an unknown type, and is reported once.
    expect(codes.filter((code) => code === 'orphaned_subtree')).toHaveLength(n - 1);
  });

  it('survives a cycle among child references', () => {
    const capture = textRun([
      a2uiText([
        { id: 'root', component: 'Mystery', child: 'a' },
        { id: 'a', component: 'Column', children: ['b', 'root'] },
        { id: 'b', component: 'Mystery', child: 'a' },
      ]),
    ]);
    const result = inspectGenui(capture);
    // Everything below the unknown root is reported once; the cycle back to the root ends the walk.
    expect(result.findings.filter((finding) => finding.code === 'orphaned_subtree').map((f) => f.componentId).sort()).toEqual(
      ['a', 'b'],
    );
    expect(result.findings.filter((finding) => finding.code === 'unknown_component').map((f) => f.componentId).sort()).toEqual(
      ['b', 'root'],
    );
  });

  it('reads a message streamed in 150,000 deltas without overflowing the stack', () => {
    // `Math.max(...seqs)` spreads one argument per frame and throws past the engine's limit.
    const chunks = Array.from({ length: 150_000 }, () => ' ');
    chunks[0] = '{"root":"r","elements":{"r":{"type":"Text","props":{}}}}';
    const capture = textRun(chunks);
    const { surfaces } = extractSurfaces(capture);
    expect(surfaces.map((surface) => surface.id)).toEqual(['spec:r']);
  });

  it('flags 50,000 duplicate ids without going quadratic', () => {
    const components = Array.from({ length: 100_000 }, (_, i) => ({ id: `d${String(i % 50_000)}`, component: 'Text', text: '' }));
    const started = performance.now();
    const { surfaces } = extractSurfaces(textRun([a2uiText(components)]));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(surfaces[0]?.duplicateIds).toHaveLength(50_000);
  });

  it('does not throw on a LangGraph message nested too deep to stringify', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    const request = { connId: 'c1', method: 'POST', url: 'http://localhost:2024/threads/t/runs/stream', input: {} };
    const frame = (seq: number, messages: unknown[]): CaptureRecord => ({
      kind: 'event',
      seq,
      tMs: seq,
      connId: 'c1',
      sseEvent: 'values',
      raw: { messages },
      event: { messages } as unknown as AguiEvent,
      issues: [],
    });
    const capture: GenuiCapture = {
      records: [
        frame(1, []),
        frame(2, [{ id: 'ai-1', type: 'ai', content: deep }]),
        frame(3, [{ id: 'ai-2', type: 'ai', content: '{"root":"r","elements":{"r":{"type":"Text","props":{}}}}' }]),
      ],
      requests: [request],
      runs: [],
    };
    const { surfaces } = extractSurfaces(capture);
    // The deep message is skipped; the next one is still read.
    expect(surfaces.map((surface) => surface.id)).toEqual(['spec:r']);
  });

  it('reports 150,000 unknown components without spreading them into one call', () => {
    const n = 150_000;
    const components = Array.from({ length: n }, (_, i) => ({ id: i === 0 ? 'root' : `c${String(i)}`, component: 'Mystery' }));
    const result = inspectGenui(textRun([a2uiText(components)]));
    expect(result.findings.filter((finding) => finding.code === 'unknown_component')).toHaveLength(n);
  });
});
