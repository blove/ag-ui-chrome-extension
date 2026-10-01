/**
 * What is wrong with a surface (design U3), and how sure we are.
 *
 * Structural findings — `duplicate_id`, `no_root`, `unresolved_child` — are facts about what the
 * wire carried, so always `exact`. Catalog findings carry the catalog's basis: `exact` against a
 * catalog the wire advertised (or a renderer reported), `inferred` against the basic catalog we
 * assume. `missing_required_prop` is made only against an exact catalog that knows its schemas:
 * an inferred catalog may well be the wrong one, and a wrong schema would invent missing props.
 *
 * `orphaned_subtree` marks every component under an unknown type: Threadplane renders nothing for
 * an unresolved element, children included, and says nothing about it.
 *
 * Pure and Chrome-free.
 */
import {
  COPILOTKIT_BASIC_CATALOG_ID,
  THREADPLANE_BASIC_CATALOG_ID,
  catalogForSurface,
  type CatalogContext,
  type GenuiCatalog,
} from './catalog';
import { extractSurfaces, type GenuiCapture, type GenuiFinding, type GenuiSurface } from './extract';

const OTHER_BASIC_ID: Readonly<Record<string, string>> = {
  [THREADPLANE_BASIC_CATALOG_ID]: "Threadplane's id for the basic catalog",
  [COPILOTKIT_BASIC_CATALOG_ID]: "CopilotKit's id for the basic catalog",
};

/** Every finding about one surface, grouped by code in a fixed order. */
export function checkSurface(surface: GenuiSurface, catalog: GenuiCatalog | undefined): GenuiFinding[] {
  // A deleted surface is gone, and a lifecycle placeholder never painted: neither renders a tree.
  if (surface.status === 'deleted') return [];
  if (surface.status !== undefined && surface.components.size === 0) return [];

  const findings: GenuiFinding[] = [];
  const add = (code: GenuiFinding['code'], basis: GenuiFinding['basis'], message: string, componentId?: string): void => {
    findings.push({
      code,
      basis,
      message,
      surfaceKey: surface.key,
      ...(componentId !== undefined ? { componentId } : {}),
      ...(surface.runId !== undefined ? { runId: surface.runId } : {}),
    });
  };
  const { components } = surface;

  for (const id of surface.duplicateIds) {
    add('duplicate_id', 'exact', `Component id "${id}" is sent twice in one update; the last one wins`, id);
  }

  if (surface.root === undefined) {
    add(
      'no_root',
      'exact',
      surface.format === 'json-render'
        ? 'The spec names no root element'
        : surface.a2uiVersion === 'v0.8'
          ? 'No beginRendering names a root for this surface'
          : 'No component has the id "root"',
    );
  } else if (!components.has(surface.root)) {
    add('no_root', 'exact', `The surface root "${surface.root}" is not a component on it`);
  }

  for (const component of components.values()) {
    for (const child of component.children) {
      if (!components.has(child)) {
        add('unresolved_child', 'exact', `Component ${component.id} references child "${child}", which is not on the surface`, component.id);
      }
    }
  }

  if (catalog !== undefined) {
    const unknown = [...components.values()].filter((component) => !catalog.components.has(component.type));
    for (const component of unknown) {
      add(
        'unknown_component',
        catalog.basis,
        catalog.basis === 'exact'
          ? `${component.type} is not in the app's catalog`
          : `${component.type} is not in the A2UI basic catalog (the app may register it)`,
        component.id,
      );
    }

    if (catalog.basis === 'exact' && catalog.knowsRequired) {
      for (const component of components.values()) {
        for (const prop of catalog.components.get(component.type)?.required ?? []) {
          if (!Object.prototype.hasOwnProperty.call(component.props, prop)) {
            add('missing_required_prop', 'exact', `${component.type} requires '${prop}', which component ${component.id} does not set`, component.id);
          }
        }
      }
    }

    const orphaned = new Set<string>();
    for (const parent of unknown) {
      const queue = [...parent.children];
      const seen = new Set<string>([parent.id]);
      while (queue.length > 0) {
        const id = queue.shift() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const child = components.get(id);
        if (child === undefined) continue;
        if (!orphaned.has(id)) {
          orphaned.add(id);
          add(
            'orphaned_subtree',
            catalog.basis,
            `Under ${parent.type} (${parent.id}), which has no renderer: this component does not render either`,
            id,
          );
        }
        queue.push(...child.children);
      }
    }

    if (surface.catalogId !== undefined && catalog.catalogId !== undefined && surface.catalogId !== catalog.catalogId) {
      const note = OTHER_BASIC_ID[surface.catalogId];
      const named = `The surface names catalog ${surface.catalogId}${note !== undefined ? ` (${note})` : ''}`;
      add(
        'catalog_mismatch',
        catalog.basis,
        catalog.basis === 'exact'
          ? `${named}, but the app advertised ${catalog.catalogId}`
          : `${named}, but ${surface.framework === 'copilotkit' ? "CopilotKit's" : "Threadplane's"} basic catalog is ${catalog.catalogId}`,
      );
    }
  }

  return findings;
}

export interface GenuiInspection {
  surfaces: GenuiSurface[];
  /** Extraction findings, then each surface's checks in surface order. */
  findings: GenuiFinding[];
  /** The catalog each surface was checked against, by surface key; `undefined` when none applies. */
  catalogs: Map<string, GenuiCatalog | undefined>;
}

/** Extract every surface from a capture and check each against its catalog. */
export function inspectGenui(
  capture: GenuiCapture,
  options: Pick<CatalogContext, 'registry'> = {},
): GenuiInspection {
  const { surfaces, findings } = extractSurfaces(capture);
  const context: CatalogContext = { runs: capture.runs, requests: capture.requests, ...options };
  const catalogs = new Map<string, GenuiCatalog | undefined>();
  const all = [...findings];
  for (const surface of surfaces) {
    const catalog = catalogForSurface(surface, context);
    catalogs.set(surface.key, catalog);
    all.push(...checkSurface(surface, catalog));
  }
  return { surfaces, findings: all, catalogs };
}
