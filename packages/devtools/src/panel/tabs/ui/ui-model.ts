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
import type { GenuiCatalog } from '../../../core/genui/catalog';
import { inspectGenui } from '../../../core/genui/check';
import { extractSurfaces, type GenuiComponent, type GenuiFinding, type GenuiRequest, type GenuiSurface } from '../../../core/genui/extract';
import type { RenderDevtoolsReport, RenderElementState } from '../../../core/signals/render-report';

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

  const visited = new Set<string>();

  const node = (id: string, reachable: boolean): UiNode => {
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
      else if (surface.status === 'deleted' || !reachable || orphaned.has(id)) state = 'not-rendered';
      else state = 'rendered';
    }
    if (visited.has(id)) return { id, component, state, stateFrom, children: [], repeat: true };
    visited.add(id);
    return { id, component, state, stateFrom, children: component.children.map((child) => node(child, reachable)) };
  };

  const root = surface.root;
  const tree = root !== undefined && surface.components.has(root) ? node(root, true) : undefined;

  // What the root does not reach: start from components no other unreached component references,
  // so each subtree is drawn whole; then whatever is left (a cycle among them) on its own.
  const unreachable: UiNode[] = [];
  const rest = [...surface.components.values()].filter((component) => !visited.has(component.id));
  const referenced = new Set(rest.flatMap((component) => component.children));
  for (const component of rest) {
    if (!referenced.has(component.id) && !visited.has(component.id)) unreachable.push(node(component.id, false));
  }
  for (const component of rest) {
    if (!visited.has(component.id)) unreachable.push(node(component.id, false));
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
  const latest = latestReports(input.renders);
  // Which report each surface takes is decided before checking, so its registry can be passed in.
  const targets =
    latest.size > 0 ? reportTargets(extractSurfaces(input).surfaces, latest) : new Map<string, RenderDevtoolsReport>();
  const result = inspectGenui(input, { registryFor: (surface) => targets.get(surface.key)?.registry });

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
