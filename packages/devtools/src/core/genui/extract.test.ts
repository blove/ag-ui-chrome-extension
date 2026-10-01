/**
 * U1 extraction over three golden fixtures.
 *
 * PROVENANCE
 *
 * `genui-lg-a2ui.agui.jsonl` (~155 KB) — a slice of a real LangGraph Platform SSE recording:
 *   Threadplane `examples/chat/angular/public/stage-replay.json` (recordedAt 2026-09-08T19:11:43Z),
 *   `runs[7]` (beat `render`: "Show a compact cleanup report…"), whose 1005 events are
 *   `{tMs, event: {type: <SSE event name>, data: <SSE data>, …data spread}}`. Each frame is rebuilt as
 *   `{event: type, data}` and written with `langGraphJsonl` (src/test/langgraph-capture.ts). Kept:
 *   event 0 (`metadata`), 1 (the run's first `values` — the thread's history), 2–16 (the streamed
 *   preamble and the `render_a2ui_surface` call's opening chunks), every 10th `custom`
 *   `a2ui-partial` plus the last (50 of 490), 996–1004 except the two intermediate `values`.
 *   Dropped for size: tool-call chunk frames 17–995 (the call's complete args arrive in the
 *   `updates` frame, event 997). `messages` tuple metadata is cut to `langgraph_node` and
 *   `langgraph_step`; nothing else is edited. Timings are the helper's (`seq * 10`).
 *
 * `genui-copilotkit.agui.jsonl` — hand-built from `@ag-ui/a2ui-middleware`'s own tests:
 *   connection c1 is v0.0.10 (`ag-ui/.worktrees/main-reassessment/middlewares/a2ui-middleware`,
 *   `__tests__/a2ui-middleware.test.ts` + `recovery-gate.test.ts`): `render_a2ui` args, a `building`
 *   lifecycle snapshot, cumulative `{a2ui_operations}` paints on `a2ui-surface-<toolCallId>`, and a
 *   `failed` lifecycle for an exhausted `generate_a2ui`. Its request's `RunAgentInput.context`
 *   carries the A2UI schema entry in CopilotKit's `extractCatalogComponentSchemas` form, advertising
 *   CopilotKit's basic id plus `HotelCard` (required `name`, `rating`, from the recovery-gate test).
 *   The `hotels` surface uses `MysteryBadge` (not in the catalog) and a `HotelCard` without `rating`;
 *   `notice` names Threadplane's basic id. Connection c2 is v0.0.2 (`ag-ui/middlewares/a2ui-middleware`
 *   tests): A2UI v0.8 `{operations}`, each surface an `ACTIVITY_DELTA` (`add /operations/-`) then an
 *   `ACTIVITY_SNAPSHOT` with `replace: false`, as `createA2UIActivityEvents` emits them, ending
 *   with a `deleteSurface` appended to `test-surface`. No schema entry (v0.0.2 predates it).
 *
 * `genui-threadplane-agui.agui.jsonl` — Threadplane over AG-UI, hand-built: a json-render spec
 *   streamed as assistant text (cockpit `c-generative-ui` element types; `data_grid` with children,
 *   and a child that does not exist), an A2UI sentinel message (a malformed line, an `updateComponents`
 *   sending one id twice, a surface created then deleted, an unterminated last line), `a2ui-partial`
 *   CUSTOM events whose last args are cut mid-envelope, a second call whose args turn invalid; and in
 *   a second run, the cockpit fixture's real `render_spec` tool call verbatim
 *   (`cockpit/chat/generative-ui/angular/e2e/fixtures/c-generative-ui.json`).
 */
import { describe, expect, it } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../model/types';
import { loadFixture } from '../../test/load-capture';
import { COPILOTKIT_BASIC_CATALOG_ID, THREADPLANE_BASIC_CATALOG_ID } from './catalog';
import { extractSurfaces, type GenuiSurface } from './extract';

/** A surface as `id: type[children]` lines — the tree the UI tab draws. */
function tree(surface: GenuiSurface | undefined): string[] {
  return [...(surface?.components.values() ?? [])].map((c) => `${c.id}: ${c.type}[${c.children.join(',')}]`);
}

const byId = (surfaces: readonly GenuiSurface[], id: string, runId?: string): GenuiSurface | undefined =>
  surfaces.find((surface) => surface.id === id && (runId === undefined || surface.runId === runId));

describe('extractSurfaces — LangGraph (stage-replay slice)', () => {
  const capture = loadFixture('genui-lg-a2ui.agui.jsonl');
  const { surfaces, findings } = extractSurfaces(capture);

  it('is a small fixture', () => {
    expect(capture.bytes).toBeLessThan(300 * 1024);
  });

  it('reads one complete A2UI surface from partials, the tool call and the final message', () => {
    expect(surfaces).toHaveLength(1);
    const surface = surfaces[0];
    expect(surface).toMatchObject({
      id: 'cleanup-report-120',
      framework: 'threadplane',
      format: 'a2ui',
      a2uiVersion: 'v0.9',
      catalogId: THREADPLANE_BASIC_CATALOG_ID,
      runId: '01a0826f-7ca2-7631-8534-f03d1461b517',
      root: 'root',
      duplicateIds: [],
    });
    expect(surface?.status).toBeUndefined();
    expect(tree(surface)).toEqual([
      'root: Column[title,summaryRow,divider,notesLabel,followUp,saveBtn]',
      'title: Text[]',
      'summaryRow: Row[deletedCard,freedCard,remainingCard,windowCard]',
      'deletedCard: Card[deletedText]',
      'freedCard: Card[freedText]',
      'remainingCard: Card[remainingText]',
      'windowCard: Card[windowText]',
      'deletedText: Text[]',
      'freedText: Text[]',
      'remainingText: Text[]',
      'windowText: Text[]',
      'divider: Divider[]',
      'notesLabel: Text[]',
      'followUp: TextField[]',
      'saveBtn: Button[saveText]',
      'saveText: Text[]',
    ]);
    expect(surface?.components.get('followUp')?.props).toEqual({
      label: 'Follow-up notes',
      value: { path: '/followUpNotes' },
      variant: 'longText',
    });
    expect(findings).toEqual([]);
  });

  it('cites every contributing frame, and not the history the run started from', () => {
    const seqs = surfaces[0]?.sourceSeqs ?? [];
    const name = (seq: number): string | undefined =>
      capture.records.find((record) => record.seq === seq && record.kind === 'event')?.kind === 'event'
        ? (capture.records.find((record) => record.seq === seq) as Extract<CaptureRecord, { kind: 'event' }>).sseEvent
        : undefined;
    const kinds = new Set(seqs.map(name));
    expect(kinds).toEqual(new Set(['messages', 'custom', 'updates', 'values']));
    expect(seqs.filter((seq) => name(seq) === 'custom')).toHaveLength(50);
    // Seq 2 is the run's first `values`: the thread as it stood, not this run's output.
    expect(seqs).not.toContain(2);
    expect(seqs.at(-1)).toBe(73);
  });

  it('takes the last a2ui-partial parse alone when the rest of the stream is missing', () => {
    // Keep only the frames up to the 25th partial: the surface is what had closed by then.
    const cut = capture.records.filter((record) => record.seq <= 42);
    const partialOnly = extractSurfaces({ ...capture, records: cut });
    const surface = partialOnly.surfaces[0];
    expect(surface?.sourceSeqs.at(-1)).toBe(42);
    // The second envelope (updateComponents) has not closed yet: only createSurface applied.
    expect(surface?.components.size).toBe(0);
    expect(partialOnly.findings.map((finding) => finding.code)).toEqual(['truncated_payload']);
  });
});

describe('extractSurfaces — CopilotKit middleware', () => {
  const capture = loadFixture('genui-copilotkit.agui.jsonl');
  const { surfaces, findings } = extractSurfaces(capture);

  it('reads v0.0.10 a2ui_operations snapshots and v0.0.2 operations deltas', () => {
    expect(surfaces.map((s) => [s.runId, s.id, s.a2uiVersion ?? null, s.status ?? null])).toEqual([
      ['r-v10', 'hotels', 'v0.9', null],
      ['r-v10', 'notice', 'v0.9', null],
      ['r-v10', 'a2ui-surface-outer1', null, 'failed'],
      ['r-v02', 'test-surface', 'v0.8', 'deleted'],
      ['r-v02', 'login-form', 'v0.8', null],
      ['r-v02', 'card-1', 'v0.8', null],
    ]);
    expect(surfaces.every((s) => s.framework === 'copilotkit' && s.format === 'a2ui')).toBe(true);
    expect(findings).toEqual([]);
  });

  it('builds the v0.9 tree, template children included, and replaces the building skeleton in place', () => {
    const hotels = byId(surfaces, 'hotels');
    expect(hotels?.catalogId).toBe(COPILOTKIT_BASIC_CATALOG_ID);
    expect(hotels?.root).toBe('root');
    expect(tree(hotels)).toEqual([
      'root: Column[title,list,badge]',
      'title: Text[]',
      'list: Row[card]',
      'card: HotelCard[]',
      'badge: MysteryBadge[badgeText]',
      'badgeText: Text[]',
    ]);
    expect(hotels?.components.get('list')?.props).toEqual({ children: { componentId: 'card', path: '/items' } });
    // seq 3 is the `building` lifecycle snapshot on the same activity id; 5 and 6 are the paints.
    expect(hotels?.sourceSeqs).toEqual([3, 5, 6]);
    expect(byId(surfaces, 'notice')?.catalogId).toBe(THREADPLANE_BASIC_CATALOG_ID);
  });

  it('reads v0.8 components and roots, and marks a deleted surface', () => {
    const deleted = byId(surfaces, 'test-surface');
    expect(deleted?.status).toBe('deleted');
    expect(deleted?.root).toBe('root-component');
    expect(tree(deleted)).toEqual(['root: Text[]']);
    expect(deleted?.components.get('root')?.props).toEqual({ text: { literalString: 'Hello' } });
    // The delete arrived as a delta on the existing activity; its replace:false snapshot was ignored.
    expect(deleted?.sourceSeqs).toEqual([24, 38]);
    expect(byId(surfaces, 'login-form')?.root).toBe('root');
    expect(tree(byId(surfaces, 'card-1'))).toEqual(['root: Card[text]']);
    expect(byId(surfaces, 'card-1')?.root).toBeUndefined();
  });
});

describe('extractSurfaces — Threadplane over AG-UI', () => {
  const capture = loadFixture('genui-threadplane-agui.agui.jsonl');
  const { surfaces, findings } = extractSurfaces(capture);

  it('reads every source into its own surface', () => {
    expect(surfaces.map((s) => [s.runId, s.id, s.format, s.status ?? null])).toEqual([
      ['r-tp1', 'spec:root', 'json-render', null],
      ['r-tp1', 's-text', 'a2ui', null],
      ['r-tp1', 's-gone', 'a2ui', 'deleted'],
      ['r-tp1', 'live', 'a2ui', null],
      ['r-tp1', 'poisoned', 'a2ui', null],
      ['r-tp2', 'spec:root', 'json-render', null],
    ]);
    expect(surfaces.every((s) => s.framework === 'threadplane')).toBe(true);
  });

  it('reads a streamed json-render spec as components, unknown type and its children included', () => {
    const spec = byId(surfaces, 'spec:root', 'r-tp1');
    expect(spec?.root).toBe('root');
    expect(spec?.sourceSeqs).toEqual([3, 4, 5]);
    expect(tree(spec)).toEqual([
      'root: dashboard_grid[stats_row,table_section]',
      'stats_row: container[on_time_card,load_card]',
      'on_time_card: stat_card[]',
      'table_section: data_grid[grid_footer]',
      'grid_footer: text[footer_note]',
      'footer_note: text[]',
    ]);
    expect(spec?.components.get('on_time_card')?.props).toEqual({ label: 'On-time %', value: { $state: '/on_time/value' } });
  });

  it('reads the cockpit render_spec tool call', () => {
    const cockpit = byId(surfaces, 'spec:root', 'r-tp2');
    expect(cockpit?.components.size).toBe(10);
    expect(tree(cockpit).slice(0, 2)).toEqual([
      'root: dashboard_grid[stats_row,charts_row,table_section]',
      'stats_row: container[on_time_card,flights_card,delay_card,load_card]',
    ]);
  });

  it('applies sentinel lines as Threadplane does: skips a bad line, keeps the last duplicate, holds an unterminated line back', () => {
    const text = byId(surfaces, 's-text');
    expect(text?.catalogId).toBe(COPILOTKIT_BASIC_CATALOG_ID);
    expect(text?.duplicateIds).toEqual(['a']);
    expect(text?.components.get('a')?.props).toEqual({ text: 'two' });
    expect(tree(byId(surfaces, 's-gone'))).toEqual(['root: Text[]']);
  });

  it('takes the last complete parse of the partial args, and a poisoned call keeps its last good parse', () => {
    const live = byId(surfaces, 'live');
    // No createSurface was streamed: the bridge's synthesised one, on Threadplane's basic catalog.
    expect(live?.catalogId).toBe(THREADPLANE_BASIC_CATALOG_ID);
    // The second envelope (`t2`) was cut open by the last partial, so it is not applied.
    expect(tree(live)).toEqual(['root: Column[t1]', 't1: Text[]']);
    expect(live?.sourceSeqs).toEqual([10, 11, 12]);
    expect(tree(byId(surfaces, 'poisoned'))).toEqual(['root: Text[]']);
    expect(byId(surfaces, 'poisoned')?.sourceSeqs).toEqual([13]);
  });

  it('records what it could not apply as findings, in capture order', () => {
    expect(findings.map((finding) => [finding.code, finding.seq, finding.basis])).toEqual([
      ['unparsed_envelope', 8, 'exact'],
      ['unterminated_envelope', 8, 'exact'],
      ['truncated_payload', 12, 'exact'],
      ['partial_args_invalid', 14, 'exact'],
    ]);
  });
});

describe('extractSurfaces — tolerance', () => {
  const record = (seq: number, event: AguiEvent): CaptureRecord => ({
    kind: 'event',
    seq,
    tMs: seq,
    connId: 'c1',
    raw: event,
    event,
    issues: [],
  });
  const run = (recordSeqs: number[], extra: Partial<Run> = {}): Run => ({
    runId: 'r',
    threadId: 't',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs,
    redacted: [],
    ...extra,
  });

  it('never throws on hostile or malformed payloads', () => {
    const hostile: AguiEvent[] = [
      { type: 'CUSTOM', name: 'a2ui-partial', value: null },
      { type: 'CUSTOM', name: 'a2ui-partial', value: '{"tool_call_id":' },
      // A valid prefix that is no envelope list yet: nothing to say.
      { type: 'CUSTOM', name: 'a2ui-partial', value: { tool_call_id: 'x', args_so_far: '[[[[' } },
      { type: 'CUSTOM', name: 'a2ui-partial', value: { tool_call_id: 'y', args_so_far: '{"envelopes":[]}}' } },
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'm', activityType: 'a2ui-surface', content: { a2ui_operations: [null, 3, { createSurface: 'no' }, { updateComponents: { surfaceId: 's', components: 'x' } }] } },
      { type: 'ACTIVITY_DELTA', messageId: 'm', activityType: 'a2ui-surface', patch: [{ op: 'remove', path: '/nope' }] },
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'n', activityType: 'a2ui-surface', content: { operations: [{ surfaceUpdate: { surfaceId: 's', components: [{ id: 'a', component: { A: 1, B: 2 } }, { component: 'X' }] } }] } },
    ];
    const records = hostile.map((event, i) => record(i + 1, event));
    const result = extractSurfaces({ records, requests: [], runs: [run(records.map((r) => r.seq))] });
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'unparsed_payload',
      'unparsed_payload',
      'partial_args_invalid',
      'unparsed_envelope',
      'unparsed_envelope',
      'unparsed_envelope',
      'unparsed_envelope',
      'unparsed_payload',
      'malformed_component',
      'malformed_component',
    ]);
    expect(result.surfaces.map((surface) => [surface.id, surface.components.size])).toEqual([['s', 0]]);
  });

  it('reads A2UI and json-render from assistant text in the run model', () => {
    const messages = new Map([
      ['m1', { messageId: 'm1', kind: 'text' as const, content: '  {"root":"r","elements":{"r":{"type":"card"}}}', startedAtMs: 0, closed: true, contentSeqs: [1] }],
      ['m2', { messageId: 'm2', kind: 'text' as const, content: 'Just prose with {"root": 1}', startedAtMs: 0, closed: true, contentSeqs: [2] }],
      ['m3', { messageId: 'm3', kind: 'text' as const, content: '{"answer": 42}', startedAtMs: 0, closed: true, contentSeqs: [3] }],
    ]);
    const result = extractSurfaces({ records: [], requests: [], runs: [run([1, 2, 3], { messages })] });
    expect(result.surfaces.map((surface) => [surface.id, tree(surface)])).toEqual([['spec:r', ['r: card[]']]]);
    expect(result.findings).toEqual([]);
  });
});
