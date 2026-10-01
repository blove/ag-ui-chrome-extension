// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RenderDevtoolsReport } from '../../../core/signals/render-report';
import { loadJsonl } from '../../import/load-jsonl';
import { buildUiModel, type UiNode, type UiSurface } from './ui-model';

/** The golden fixtures (provenance in core/genui/extract.test.ts), through the panel's own import path. */
function fixture(name: string): { records: ReturnType<typeof loadJsonl>['records']; requests: ReturnType<typeof loadJsonl>['requests']; runs: ReturnType<typeof loadJsonl>['runs'] } {
  const loaded = loadJsonl(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8'));
  return { records: loaded.records, requests: loaded.requests, runs: loaded.runs };
}

const copilotkit = fixture('genui-copilotkit.agui.jsonl');
const threadplane = fixture('genui-threadplane-agui.agui.jsonl');

function surfaceOf(model: ReturnType<typeof buildUiModel>, id: string, runId?: string): UiSurface {
  for (const group of model.groups) {
    for (const surface of group.surfaces) {
      if (surface.surface.id === id && (runId === undefined || surface.surface.runId === runId)) return surface;
    }
  }
  throw new Error(`no surface ${id}`);
}

/** `id:state` for every node in a tree, depth first; `id:-` for a reference that is not on the surface. */
function flat(node: UiNode | undefined): string[] {
  if (node === undefined) return [];
  return [`${node.id}:${node.state ?? '-'}${node.repeat ? '(repeat)' : ''}`, ...node.children.flatMap(flat)];
}

function report(surface: string, elements: RenderDevtoolsReport['elements'], registry: string[], seq = 1): RenderDevtoolsReport {
  return { v: 1, kind: 'render', surface, seq, registry, elements, tMs: seq };
}

describe('buildUiModel — grouping', () => {
  it('groups surfaces by run, in run order, and carries each one’s framework, format, catalog and status', () => {
    const model = buildUiModel({ ...copilotkit, renders: [] }, null);
    expect(model.groups.map((group) => group.runId)).toEqual(['r-v10', 'r-v02']);
    expect(model.groups[0]?.surfaces.map((s) => s.surface.id)).toEqual(['hotels', 'notice', 'a2ui-surface-outer1']);
    expect(model.groups[1]?.surfaces.map((s) => s.surface.id)).toEqual(['test-surface', 'login-form', 'card-1']);
    const hotels = surfaceOf(model, 'hotels');
    expect(hotels.surface.framework).toBe('copilotkit');
    expect(hotels.catalog).toMatchObject({ basis: 'exact', source: 'copilotkit-context' });
    expect(surfaceOf(model, 'a2ui-surface-outer1').surface.status).toBe('failed');
    expect(model.surfaceCount).toBe(6);
  });

  it('narrows to the scoped run', () => {
    const model = buildUiModel({ ...copilotkit, renders: [] }, 'r-v02');
    expect(model.groups.map((group) => group.runId)).toEqual(['r-v02']);
  });

  it('puts extraction findings (no surface) under their run', () => {
    const model = buildUiModel({ ...threadplane, renders: [] }, null);
    const tp1 = model.groups.find((group) => group.runId === 'r-tp1');
    expect(tp1?.findings.map((finding) => finding.code)).toEqual([
      'unparsed_envelope',
      'unterminated_envelope',
      'truncated_payload',
      'partial_args_invalid',
    ]);
  });

  it('is empty for a capture with no generative UI', () => {
    const model = buildUiModel({ records: [], requests: [], runs: [], renders: [] }, null);
    expect(model).toEqual({ groups: [], surfaceCount: 0 });
  });
});

describe('buildUiModel — the tree and its states from the wire checks', () => {
  it('builds the tree from the root; an unknown type and its subtree are badged', () => {
    const hotels = surfaceOf(buildUiModel({ ...copilotkit, renders: [] }, null), 'hotels');
    expect(flat(hotels.tree)).toEqual([
      'root:rendered',
      'title:rendered',
      'list:rendered',
      'card:rendered',
      'badge:unknown-type',
      'badgeText:not-rendered',
    ]);
    expect(hotels.stateSource).toBe('checks');
    expect(hotels.findings.map((finding) => finding.code)).toEqual([
      'unknown_component',
      'missing_required_prop',
      'orphaned_subtree',
    ]);
    expect(hotels.unreachable).toEqual([]);
  });

  it('shows a child the surface does not hold as a reference without a state', () => {
    const tp = surfaceOf(buildUiModel({ ...threadplane, renders: [] }, null), 'spec:root', 'r-tp1');
    expect(flat(tp.tree)).toContain('load_card:-');
  });

  it('lists what the root cannot reach separately, as not rendered — all of it when there is no root', () => {
    const card = surfaceOf(buildUiModel({ ...copilotkit, renders: [] }, null), 'card-1');
    expect(card.tree).toBeUndefined();
    expect(card.unreachable.flatMap(flat)).toEqual(['root:not-rendered', 'text:-']);
  });

  it('a deleted surface renders nothing', () => {
    const gone = surfaceOf(buildUiModel({ ...copilotkit, renders: [] }, null), 'test-surface');
    expect(gone.surface.status).toBe('deleted');
    expect([...flat(gone.tree), ...gone.unreachable.flatMap(flat)].every((entry) => entry.endsWith(':not-rendered'))).toBe(true);
  });

  it('draws a repeated child once and marks the repeat, so a cycle cannot recurse', () => {
    const sText = surfaceOf(buildUiModel({ ...threadplane, renders: [] }, null), 's-text');
    expect(flat(sText.tree)).toEqual(['root:rendered', 'a:rendered', 'a:rendered(repeat)']);
  });
});

describe('buildUiModel — states from the app’s render report', () => {
  const COCKPIT_REPORT = report(
    'spec:root',
    [
      { key: 'root', type: 'dashboard_grid', state: 'mounted' },
      { key: 'stats_row', type: 'container', state: 'mounted' },
      { key: 'on_time_card', type: 'stat_card', state: 'mounted' },
      { key: 'flights_card', type: 'stat_card', state: 'mounted' },
      { key: 'delay_card', type: 'stat_card', state: 'fallback' },
      { key: 'load_card', type: 'stat_card', state: 'mounted' },
      { key: 'charts_row', type: 'container', state: 'mounted' },
      { key: 'trend_chart', type: 'line_chart', state: 'unresolved' },
      { key: 'airline_chart', type: 'bar_chart', state: 'unresolved' },
    ],
    ['dashboard_grid', 'container', 'stat_card', 'data_grid'],
  );

  it('takes each node’s state from the latest report whose surface is this surface’s id', () => {
    const stale = report('spec:root', [{ key: 'root', type: 'dashboard_grid', state: 'hidden' }], [], 1);
    const model = buildUiModel({ ...threadplane, renders: [stale, { ...COCKPIT_REPORT, seq: 2 }] }, null);
    const cockpit = surfaceOf(model, 'spec:root', 'r-tp2');
    expect(cockpit.stateSource).toBe('app');
    expect(cockpit.report?.seq).toBe(2);
    expect(flat(cockpit.tree)).toEqual([
      'root:rendered',
      'stats_row:rendered',
      'on_time_card:rendered',
      'flights_card:rendered',
      'delay_card:fallback',
      'load_card:rendered',
      'charts_row:rendered',
      'trend_chart:unknown-type',
      'airline_chart:unknown-type',
      // Not in the report: from the checks, which now run against the reported registry.
      'table_section:rendered',
    ]);
    expect(cockpit.tree?.stateFrom).toBe('app');
    expect(cockpit.tree?.children.at(-1)?.stateFrom).toBe('checks');
  });

  it('passes the report’s registry into the checks, which become exact for that surface', () => {
    const cockpit = surfaceOf(buildUiModel({ ...threadplane, renders: [COCKPIT_REPORT] }, null), 'spec:root', 'r-tp2');
    expect(cockpit.catalog).toMatchObject({ basis: 'exact', source: 'registry' });
    expect(cockpit.findings.map((finding) => `${finding.code} ${finding.basis} ${finding.componentId ?? ''}`)).toEqual([
      'unknown_component exact trend_chart',
      'unknown_component exact airline_chart',
    ]);
  });

  it('applies a report to the most recent surface with that id only', () => {
    const model = buildUiModel({ ...threadplane, renders: [COCKPIT_REPORT] }, null);
    const first = surfaceOf(model, 'spec:root', 'r-tp1');
    expect(first.stateSource).toBe('checks');
    expect(first.report).toBeUndefined();
    expect(first.catalog).toBeUndefined();
  });

  it('maps hidden to not rendered, and ignores reports for surfaces the capture does not hold', () => {
    const model = buildUiModel(
      {
        ...threadplane,
        renders: [
          report('live', [{ key: 'root', type: 'Column', state: 'mounted' }, { key: 't1', type: 'Text', state: 'hidden' }], ['Column', 'Text']),
          report('elsewhere', [{ key: 'x', type: 'X', state: 'mounted' }], []),
        ],
      },
      null,
    );
    expect(flat(surfaceOf(model, 'live').tree)).toEqual(['root:rendered', 't1:not-rendered']);
  });

  it('never applies a Threadplane report to a CopilotKit surface', () => {
    const model = buildUiModel(
      { ...copilotkit, renders: [report('hotels', [{ key: 'badge', type: 'MysteryBadge', state: 'mounted' }], ['MysteryBadge'])] },
      null,
    );
    const hotels = surfaceOf(model, 'hotels');
    expect(hotels.stateSource).toBe('checks');
    expect(flat(hotels.tree)).toContain('badge:unknown-type');
  });
});
