/**
 * The UI tab's model (UI inspector U6) — pure, so every rule below is unit-tested without a DOM.
 *
 * From what the panel holds — records, request lines, runs, and the live render reports — it builds:
 * the generative-UI surfaces grouped by run, each surface's component tree from its root, the
 * components the root cannot reach, its findings, and a state per node.
 *
 * WHERE A NODE'S STATE COMES FROM. When the app reported how this surface rendered (a Threadplane
 * render report whose `surface` is this surface's id — the A2UI surface id, or `spec:` + root for
 * json-render), the report says, element by element: `mounted` → rendered, `fallback` → fallback,
 * `unresolved` → unknown type, `hidden` → not rendered. Its `registry` is also handed to the checks
 * as that surface's exact catalog. A component the report does not name, and every surface without
 * a report, takes its state from the wire checks (U3): an unknown type is `unknown-type`; anything
 * under one, unreachable from the root, or on a deleted surface is `not-rendered`; the rest is
 * `rendered` — an inference, which is why each node carries `stateFrom`.
 *
 * A report describes what the page is showing NOW, so it is applied to the most recent surface with
 * its id; an earlier run's surface of the same id keeps the checks' states. Threadplane is the only
 * framework that reports, so a CopilotKit surface never takes one.
 */
import type { CaptureRecord, Run } from '../../../core/model/types';
import { catalogForSurface, type GenuiCatalog } from '../../../core/genui/catalog';
import { checkSurface } from '../../../core/genui/check';
import { extractSurfaces, type GenuiComponent, type GenuiFinding, type GenuiRequest, type GenuiSurface } from '../../../core/genui/extract';
import {
  MAX_RENDER_NAME_LENGTH,
  MAX_RENDER_REGISTRY,
  type RenderDevtoolsReport,
  type RenderElementState,
} from '../../../core/signals/render-report';

/**
 * How deep a drawn tree goes, the root at depth 1. A surface is whatever the wire carried, and a
 * 10,000-deep chain would otherwise be 10,000 nested list items — and as many nested renders, which
 * overflow the stack. Real surfaces are a few levels deep; a node at the cap is drawn `truncated`.
 */
export const MAX_TREE_DEPTH = 64;

export type NodeState = 'rendered' | 'fallback' | 'not-rendered' | 'unknown-type';

/** What a reader sees on each node's badge. */
export const NODE_STATE_LABEL: Readonly<Record<NodeState, string>> = {
  rendered: 'rendered',
  fallback: 'fallback',
  'not-rendered': 'not rendered',
  'unknown-type': 'unknown type',
};

const FROM_REPORT: Readonly<Record<RenderElementState, NodeState>> = {
  mounted: 'rendered',
  fallback: 'fallback',
  unresolved: 'unknown-type',
  hidden: 'not-rendered',
};

export interface UiNode {
  /** The component id this node stands for. */
  id: string;
  /** Absent when a parent references an id the surface does not hold. */
  component?: GenuiComponent;
  /** Absent exactly when `component` is. */
  state?: NodeState;
  stateFrom?: 'app' | 'checks';
  children: UiNode[];
  /** Already drawn elsewhere in this tree (a repeated child, or a cycle): not expanded again. */
  repeat?: boolean;
  /** At `MAX_TREE_DEPTH` with children of its own, which are not drawn. */
  truncated?: boolean;
}

export interface UiSurface {
  surface: GenuiSurface;
  /** The catalog the checks used; `undefined` when nothing on the wire says which one renders it. */
  catalog: GenuiCatalog | undefined;
  findings: GenuiFinding[];
  /** The render report this surface's states come from, when the app sent one. */
  report?: RenderDevtoolsReport;
  stateSource: 'app' | 'checks';
  /** The tree from the root, or `undefined` when the root is not a component on the surface. */
  tree?: UiNode;
  /** Subtrees of the components the root does not reach. */
  unreachable: UiNode[];
}

export interface UiRunGroup {
  /** `undefined` for surfaces outside any run. */
  runId?: string;
  surfaces: UiSurface[];
  /** Extraction findings for this run that belong to no surface (an envelope that did not parse…). */
  findings: GenuiFinding[];
}

export interface UiModel {
  groups: UiRunGroup[];
  surfaceCount: number;
}

export interface UiInput {
  records: readonly CaptureRecord[];
  requests: readonly GenuiRequest[];
  runs: readonly Run[];
  renders: readonly RenderDevtoolsReport[];
}

/** The latest render report per surface id, in arrival order (last wins). */
function latestReports(renders: readonly RenderDevtoolsReport[]): Map<string, RenderDevtoolsReport> {
  const latest = new Map<string, RenderDevtoolsReport>();
  for (const report of renders) latest.set(report.surface, report);
  return latest;
}

/** Which surface (by key) each report applies to: the last Threadplane surface with its id. */
function reportTargets(
  surfaces: readonly GenuiSurface[],
  latest: ReadonlyMap<string, RenderDevtoolsReport>,
): Map<string, RenderDevtoolsReport> {
  const lastKey = new Map<string, string>();
  for (const surface of surfaces) {
    if (surface.framework === 'threadplane' && latest.has(surface.id)) lastKey.set(surface.id, surface.key);
  }
  const targets = new Map<string, RenderDevtoolsReport>();
  for (const [id, key] of lastKey) {
    const report = latest.get(id);
    if (report !== undefined) targets.set(key, report);
  }
  return targets;
}

/**
 * The component names a surface's render report vouches for: its registry, and — because the
 * emitter caps the registry at 500 names and drops any name over 128 characters without saying
 * so — every type the report shows resolving (only `unresolved` means "no registry entry"). When
 * the registry is AT the cap it may have been cut, so every wire type the report does not call
 * `unresolved` is given the benefit of the doubt; a type too long to be reported is never judged.
 * Without this, a component the app mounted could be reported as "not in the app's catalog".
 */
function vouchedRegistry(report: RenderDevtoolsReport, surface: GenuiSurface): string[] {
  const names = new Set(report.registry);
  const unresolved = new Set<string>();
  for (const element of report.elements) {
    if (element.state === 'unresolved') unresolved.add(element.key);
    else names.add(element.type);
  }
  const mayBeCut = report.registry.length >= MAX_RENDER_REGISTRY;
  for (const component of surface.components.values()) {
    if (component.type.length > MAX_RENDER_NAME_LENGTH || (mayBeCut && !unresolved.has(component.id))) {
      names.add(component.type);
    }
  }
  return [...names];
}

/** Every component id reachable from `start` (itself included), walked without recursion. */
function reachFrom(surface: GenuiSurface, start: string, into: Set<string>): void {
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (into.has(id)) continue;
    const component = surface.components.get(id);
    if (component === undefined) continue;
    into.add(id);
    for (const child of component.children) if (!into.has(child)) stack.push(child);
  }
}

function buildSurface(
  surface: GenuiSurface,
  catalog: GenuiCatalog | undefined,
  findings: GenuiFinding[],
  report: RenderDevtoolsReport | undefined,
): UiSurface {
  const unknown = new Set<string>();
  const orphaned = new Set<string>();
  for (const finding of findings) {
    if (finding.componentId === undefined) continue;
    if (finding.code === 'unknown_component') unknown.add(finding.componentId);
    else if (finding.code === 'orphaned_subtree') orphaned.add(finding.componentId);
  }
  const reported = new Map<string, RenderElementState>();
  for (const element of report?.elements ?? []) if (!reported.has(element.key)) reported.set(element.key, element.state);

  // Reachability is walked apart from drawing, so a component below the depth cap still counts.
  const root = surface.root;
  const reached = new Set<string>();
  if (root !== undefined) reachFrom(surface, root, reached);

  /** Components already drawn, so a repeat or a cycle is drawn once. */
  const visited = new Set<string>();

  // Recursion is bounded by MAX_TREE_DEPTH, so a hostile depth cannot overflow the stack.
  const node = (id: string, depth: number): UiNode => {
    const component = surface.components.get(id);
    if (component === undefined) return { id, children: [] };
    const fromApp = reported.get(id);
    let state: NodeState;
    let stateFrom: 'app' | 'checks';
    if (fromApp !== undefined) {
      state = FROM_REPORT[fromApp];
      stateFrom = 'app';
    } else {
      stateFrom = 'checks';
      if (unknown.has(id)) state = 'unknown-type';
      else if (surface.status === 'deleted' || !reached.has(id) || orphaned.has(id)) state = 'not-rendered';
      else state = 'rendered';
    }
    if (visited.has(id)) return { id, component, state, stateFrom, children: [], repeat: true };
    visited.add(id);
    if (depth >= MAX_TREE_DEPTH && component.children.length > 0) {
      return { id, component, state, stateFrom, children: [], truncated: true };
    }
    return {
      id,
      component,
      state,
      stateFrom,
      children: component.children.map((child) => node(child, depth + 1)),
    };
  };

  const tree = root !== undefined && surface.components.has(root) ? node(root, 1) : undefined;

  // What the root does not reach: start from components no other unreached component references,
  // so each subtree is drawn whole; then whatever is left (a cycle among them) on its own. A drawn
  // subtree covers everything below it, drawn or past the depth cap.
  const unreachable: UiNode[] = [];
  const rest = [...surface.components.values()].filter((component) => !reached.has(component.id));
  const referenced = new Set<string>();
  for (const component of rest) for (const child of component.children) referenced.add(child);
  const covered = new Set<string>();
  const drawFrom = (id: string): void => {
    unreachable.push(node(id, 1));
    reachFrom(surface, id, covered);
  };
  for (const component of rest) {
    if (!referenced.has(component.id) && !covered.has(component.id)) drawFrom(component.id);
  }
  for (const component of rest) {
    if (!covered.has(component.id)) drawFrom(component.id);
  }

  return {
    surface,
    catalog,
    findings,
    ...(report !== undefined ? { report } : {}),
    stateSource: report !== undefined ? 'app' : 'checks',
    ...(tree !== undefined ? { tree } : {}),
    unreachable,
  };
}

/** Build the UI tab's model; `scope` narrows it to one run, as the shell's run selector does. */
export function buildUiModel(input: UiInput, scope: string | null): UiModel {
  // `inspectGenui`, unrolled so the capture is extracted once (the tab re-runs this per append):
  // which report each surface takes is decided before checking, so its registry can be passed in.
  const extraction = extractSurfaces(input);
  const latest = latestReports(input.renders);
  const targets = latest.size > 0 ? reportTargets(extraction.surfaces, latest) : new Map<string, RenderDevtoolsReport>();
  const context = {
    runs: input.runs,
    requests: input.requests,
    registryFor: (surface: GenuiSurface): readonly string[] | undefined => {
      const report = targets.get(surface.key);
      return report === undefined ? undefined : vouchedRegistry(report, surface);
    },
  };
  const result = { surfaces: extraction.surfaces, findings: [...extraction.findings], catalogs: new Map<string, GenuiCatalog | undefined>() };
  for (const surface of extraction.surfaces) {
    const catalog = catalogForSurface(surface, context);
    result.catalogs.set(surface.key, catalog);
    for (const finding of checkSurface(surface, catalog)) result.findings.push(finding);
  }

  const runOrder = new Map(input.runs.map((run, index) => [run.runId, index]));
  const groups = new Map<string | undefined, UiRunGroup>();
  const groupFor = (runId: string | undefined): UiRunGroup => {
    let group = groups.get(runId);
    if (group === undefined) {
      group = { ...(runId !== undefined ? { runId } : {}), surfaces: [], findings: [] };
      groups.set(runId, group);
    }
    return group;
  };

  const bySurface = new Map<string, GenuiFinding[]>();
  for (const finding of result.findings) {
    if (finding.surfaceKey === undefined) {
      if (scope === null || finding.runId === scope) groupFor(finding.runId).findings.push(finding);
      continue;
    }
    const list = bySurface.get(finding.surfaceKey) ?? [];
    list.push(finding);
    bySurface.set(finding.surfaceKey, list);
  }

  let surfaceCount = 0;
  for (const surface of result.surfaces) {
    if (scope !== null && surface.runId !== scope) continue;
    surfaceCount += 1;
    groupFor(surface.runId).surfaces.push(
      buildSurface(surface, result.catalogs.get(surface.key), bySurface.get(surface.key) ?? [], targets.get(surface.key)),
    );
  }

  const ordered = [...groups.values()].sort((a, b) => {
    const left = a.runId === undefined ? Number.MAX_SAFE_INTEGER : (runOrder.get(a.runId) ?? Number.MAX_SAFE_INTEGER - 1);
    const right = b.runId === undefined ? Number.MAX_SAFE_INTEGER : (runOrder.get(b.runId) ?? Number.MAX_SAFE_INTEGER - 1);
    return left - right;
  });
  return { groups: ordered, surfaceCount };
}
