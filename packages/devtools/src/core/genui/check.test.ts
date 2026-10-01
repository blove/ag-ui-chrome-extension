/**
 * U3 checks over the golden fixtures (provenance in extract.test.ts) and a few hand-built surfaces.
 */
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/load-capture';
import { COPILOTKIT_BASIC_CATALOG_ID, THREADPLANE_BASIC_CATALOG_ID, basicCatalog } from './catalog';
import { checkSurface, inspectGenui } from './check';
import type { GenuiComponent, GenuiFinding, GenuiSurface } from './extract';

/** Findings as `code basis surfaceId/componentId`, the shape the UI tab badges. */
function brief(findings: readonly GenuiFinding[], surfaces: readonly GenuiSurface[]): string[] {
  const idOf = new Map(surfaces.map((surface) => [surface.key, surface.id]));
  return findings.map((finding) => {
    const where = [finding.surfaceKey === undefined ? '-' : idOf.get(finding.surfaceKey), finding.componentId]
      .filter((part) => part !== undefined)
      .join('/');
    return `${finding.code} ${finding.basis} ${where}`;
  });
}

describe('inspectGenui over the golden fixtures', () => {
  it('finds nothing wrong with the real Threadplane surface (LangGraph, inferred basic catalog)', () => {
    const result = inspectGenui(loadFixture('genui-lg-a2ui.agui.jsonl'));
    expect(result.surfaces.map((surface) => surface.id)).toEqual(['cleanup-report-120']);
    expect(result.catalogs.get(result.surfaces[0]?.key ?? '')?.basis).toBe('inferred');
    expect(result.findings).toEqual([]);
  });

  it('checks CopilotKit surfaces against the catalog the request advertised (exact)', () => {
    const result = inspectGenui(loadFixture('genui-copilotkit.agui.jsonl'));
    expect(brief(result.findings, result.surfaces)).toEqual([
      'unknown_component exact hotels/badge',
      'missing_required_prop exact hotels/card',
      'orphaned_subtree exact hotels/badgeText',
      'catalog_mismatch exact notice',
      'no_root exact card-1',
      'unresolved_child exact card-1/root',
    ]);
    const missing = result.findings.find((finding) => finding.code === 'missing_required_prop');
    expect(missing?.message).toBe("HotelCard requires 'rating', which component card does not set");
    const mismatch = result.findings.find((finding) => finding.code === 'catalog_mismatch');
    expect(mismatch?.message).toBe(
      `The surface names catalog ${THREADPLANE_BASIC_CATALOG_ID} (Threadplane's id for the basic catalog), ` +
        `but the app advertised ${COPILOTKIT_BASIC_CATALOG_ID}`,
    );
    const hotels = result.surfaces.find((surface) => surface.id === 'hotels');
    expect(result.catalogs.get(hotels?.key ?? '')?.source).toBe('copilotkit-context');
    // The v0.0.2 run sent no schema entry, and v0.8 has no inferred catalog: structure only.
    const login = result.surfaces.find((surface) => surface.id === 'login-form');
    expect(result.catalogs.get(login?.key ?? '')).toBeUndefined();
  });

  it('checks Threadplane AG-UI surfaces: structure always, the inferred catalog for A2UI v0.9', () => {
    const result = inspectGenui(loadFixture('genui-threadplane-agui.agui.jsonl'));
    expect(brief(result.findings, result.surfaces)).toEqual([
      // Extraction findings first, in capture order.
      'unparsed_envelope exact -',
      'unterminated_envelope exact -',
      'truncated_payload exact -',
      'partial_args_invalid exact -',
      // Then each surface's checks.
      'unresolved_child exact spec:root/stats_row',
      'duplicate_id exact s-text/a',
      'catalog_mismatch inferred s-text',
    ]);
    const mismatch = result.findings.find((finding) => finding.code === 'catalog_mismatch');
    expect(mismatch?.message).toBe(
      `The surface names catalog ${COPILOTKIT_BASIC_CATALOG_ID} (CopilotKit's id for the basic catalog), ` +
        `but Threadplane's basic catalog is ${THREADPLANE_BASIC_CATALOG_ID}`,
    );
  });

  it('with a reported registry, a json-render type outside it is unknown and its subtree orphaned', () => {
    const result = inspectGenui(loadFixture('genui-threadplane-agui.agui.jsonl'), {
      registry: ['dashboard_grid', 'container', 'stat_card', 'text', 'Column', 'Text'],
    });
    const spec = result.surfaces.find((surface) => surface.id === 'spec:root' && surface.runId === 'r-tp1');
    expect(brief(result.findings.filter((finding) => finding.surfaceKey === spec?.key), result.surfaces)).toEqual([
      'unresolved_child exact spec:root/stats_row',
      'unknown_component exact spec:root/table_section',
      'orphaned_subtree exact spec:root/grid_footer',
      'orphaned_subtree exact spec:root/footer_note',
    ]);
    // The cockpit dashboard uses types this registry lacks.
    const cockpit = result.surfaces.find((surface) => surface.runId === 'r-tp2');
    expect(
      result.findings
        .filter((finding) => finding.surfaceKey === cockpit?.key && finding.code === 'unknown_component')
        .map((finding) => finding.componentId),
    ).toEqual(['trend_chart', 'airline_chart', 'table_section']);
  });
});

describe('checkSurface', () => {
  const component = (id: string, type: string, children: string[] = [], props: Record<string, unknown> = {}): GenuiComponent => ({
    id,
    type,
    props,
    children,
    seq: 1,
  });
  const surface = (components: GenuiComponent[], extra: Partial<GenuiSurface> = {}): GenuiSurface => ({
    key: 's',
    id: 's',
    framework: 'threadplane',
    format: 'a2ui',
    a2uiVersion: 'v0.9',
    components: new Map(components.map((c) => [c.id, c])),
    root: 'root',
    sourceSeqs: [1],
    duplicateIds: [],
    ...extra,
  });

  it('labels an unknown type inferred under the basic catalog, and never claims a missing prop there', () => {
    const findings = checkSurface(
      surface([component('root', 'Column', ['x']), component('x', 'Fancy', ['y']), component('y', 'Button', [])]),
      basicCatalog('threadplane'),
    );
    expect(findings.map((f) => `${f.code} ${f.basis} ${f.componentId ?? ''}`)).toEqual([
      'unknown_component inferred x',
      'orphaned_subtree inferred y',
    ]);
  });

  it('reports a root that does not resolve, and survives a child cycle', () => {
    const findings = checkSurface(
      surface([component('a', 'Fancy', ['b']), component('b', 'Text', ['a'])], { root: 'missing' }),
      basicCatalog('threadplane'),
    );
    expect(findings.map((f) => `${f.code} ${f.componentId ?? ''}`)).toEqual([
      'no_root ',
      'unknown_component a',
      'orphaned_subtree b',
    ]);
    expect(findings[0]?.message).toBe('The surface root "missing" is not a component on it');
  });

  it('says nothing about a deleted surface, or one that never painted', () => {
    expect(checkSurface(surface([], { status: 'deleted', root: undefined }), undefined)).toEqual([]);
    expect(checkSurface(surface([], { status: 'failed', root: undefined }), undefined)).toEqual([]);
  });
});
