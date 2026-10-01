/**
 * The UI tab — UI inspector U6.
 *
 * Every generative-UI surface in the capture (A2UI or json-render, from Threadplane or CopilotKit's
 * A2UI middleware), grouped by run: what it is, which catalog it was checked against and how sure
 * that is, its component tree from the root with a state per node, what the root cannot reach, and
 * its findings. Selecting a node shows its props and links the frame that set it in Timeline.
 *
 * The model is `./ui-model` (pure). Node states come from the app's render report for the surface
 * when there is one (live only, U7), else from the wire checks — and the tab says which.
 *
 * The empty state is the common one — most captures carry no generative UI — so it is worded as an
 * ordinary absence, never as a fault.
 */
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { GenuiCatalog } from '../../../core/genui/catalog';
import type { GenuiFinding, GenuiFindingCode, GenuiSurface } from '../../../core/genui/extract';
import { JsonTree } from '../../common/json-tree';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { selectScope, selectSeq, selectTab } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import { buildUiModel, NODE_STATE_LABEL, type UiNode, type UiRunGroup, type UiSurface } from './ui-model';

/** Exported so the tests and the visual gate hold the exact wording. */
export const UI_EMPTY_TEXT =
  'No generative UI in this capture yet — the UI view lists A2UI and json-render surfaces from Threadplane and from CopilotKit’s A2UI middleware as they arrive.';

export const FINDING_LABEL: Readonly<Record<GenuiFindingCode, string>> = {
  unknown_component: 'Unknown type',
  missing_required_prop: 'Missing required prop',
  unresolved_child: 'Unresolved child',
  orphaned_subtree: 'Under an unknown type',
  no_root: 'No root',
  duplicate_id: 'Duplicate id',
  catalog_mismatch: 'Catalog mismatch',
  unparsed_envelope: 'Unparsed envelope',
  unterminated_envelope: 'Unterminated envelope',
  unparsed_payload: 'Unparsed payload',
  truncated_payload: 'Truncated payload',
  partial_args_invalid: 'Partial args invalid',
  malformed_component: 'Malformed component',
};

export interface UiProps {
  store: PanelStore;
}

interface Selection {
  surfaceKey: string;
  componentId: string;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Whether the shell's run scope shows `seq` — `selectScope` would otherwise hide the selection. */
function scopeShows(s: PanelState, seq: number): boolean {
  if (s.scope === null) return true;
  const run = s.runs.find((candidate) => candidate.runId === s.scope);
  return run !== undefined && run.recordSeqs.includes(seq);
}

function frameworkLabel(surface: GenuiSurface): string {
  return surface.framework === 'threadplane' ? 'Threadplane' : 'CopilotKit';
}

function formatLabel(surface: GenuiSurface): string {
  if (surface.format === 'json-render') return 'json-render';
  return surface.a2uiVersion === undefined ? 'A2UI' : `A2UI ${surface.a2uiVersion}`;
}

/** The catalog line: what the surface was checked against, and the basis badge beside it. */
function catalogLine(catalog: GenuiCatalog | undefined): { text: string; basis: 'exact' | 'inferred' | 'none' } {
  if (catalog === undefined) return { text: 'No catalog on the wire — component types are not checked', basis: 'none' };
  switch (catalog.source) {
    case 'registry':
      return { text: `The app’s registry (${plural(catalog.components.size, 'component', 'components')}), reported by the app`, basis: 'exact' };
    case 'copilotkit-context':
      return { text: `Catalog ${catalog.catalogId ?? '(no id)'}, advertised by the app`, basis: 'exact' };
    case 'a2ui-basic':
      return { text: 'The A2UI basic catalog, assumed', basis: 'inferred' };
  }
}

function statesNote(view: UiSurface): string {
  if (view.report !== undefined) return `Node states reported by the app (render report ${String(view.report.seq)}).`;
  return 'Node states inferred from the wire checks.';
}

function NodeRow({
  node,
  surfaceKey,
  selected,
  onSelect,
}: {
  node: UiNode;
  surfaceKey: string;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}): JSX.Element {
  const isSelected = selected?.surfaceKey === surfaceKey && selected.componentId === node.id && node.component !== undefined;
  return (
    <li class="agui-ui__item">
      {node.component === undefined || node.state === undefined ? (
        <span class="agui-ui__node agui-ui__node--absent" data-component={node.id}>
          <span class="agui-ui__id">{node.id}</span>
          <span class="agui-ui__absent">not on this surface</span>
        </span>
      ) : (
        <button
          type="button"
          class="agui-ui__node"
          data-component={node.id}
          data-state={node.state}
          data-from={node.stateFrom}
          aria-pressed={isSelected}
          onClick={() => {
            onSelect({ surfaceKey, componentId: node.id });
          }}
        >
          <span class="agui-ui__id">{node.id}</span>
          <span class="agui-ui__type">{node.component.type}</span>
          <span
            class="agui-ui__badge"
            data-state={node.state}
            title={node.stateFrom === 'app' ? 'Reported by the app' : 'Inferred from the wire checks'}
          >
            {NODE_STATE_LABEL[node.state]}
          </span>
          {node.repeat === true ? <span class="agui-ui__repeat">(again)</span> : null}
          {node.truncated === true ? <span class="agui-ui__truncated">(deeper levels not shown)</span> : null}
        </button>
      )}
      {node.children.length > 0 ? (
        <ul class="agui-ui__tree">
          {node.children.map((child, index) => (
            <NodeRow key={`${child.id}:${String(index)}`} node={child} surfaceKey={surfaceKey} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Findings({
  findings,
  onFrame,
  onComponent,
}: {
  findings: GenuiFinding[];
  onFrame: (seq: number) => void;
  onComponent?: (componentId: string) => void;
}): JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <ul class="agui-ui__findings" aria-label="Findings">
      {findings.map((finding, index) => (
        <li key={String(index)} class="agui-ui__finding" data-code={finding.code} data-basis={finding.basis}>
          <span class="agui-ui__code">{FINDING_LABEL[finding.code]}</span>
          <span class="agui-ui__basis" data-basis={finding.basis}>
            {finding.basis}
          </span>
          <span class="agui-ui__message">{finding.message}</span>
          {finding.componentId !== undefined && onComponent !== undefined ? (
            <button
              type="button"
              class="agui-ui__link"
              onClick={() => {
                onComponent(finding.componentId as string);
              }}
            >
              Select {finding.componentId}
            </button>
          ) : null}
          {finding.seq !== undefined ? (
            <button
              type="button"
              class="agui-ui__link"
              onClick={() => {
                onFrame(finding.seq as number);
              }}
            >
              Show frame {String(finding.seq)} in Timeline
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SurfaceView({
  view,
  selected,
  onSelect,
  onFrame,
}: {
  view: UiSurface;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
  onFrame: (seq: number) => void;
}): JSX.Element {
  const { surface } = view;
  const catalog = catalogLine(view.catalog);
  const select = (componentId: string): void => {
    onSelect({ surfaceKey: surface.key, componentId });
  };
  return (
    <section class="agui-ui__surface" data-surface={surface.id} data-run={surface.runId} aria-label={`Surface ${surface.id}`}>
      <h4 class="agui-ui__heading">
        <span class="agui-ui__surface-id">{surface.id}</span>
        <span class="agui-ui__chip">{frameworkLabel(surface)}</span>
        <span class="agui-ui__chip">{formatLabel(surface)}</span>
        {surface.status !== undefined ? (
          <span class="agui-ui__chip agui-ui__status" data-status={surface.status}>
            {surface.status}
          </span>
        ) : null}
      </h4>
      <p class="agui-ui__meta">
        <span class="agui-ui__basis" data-basis={catalog.basis}>
          {catalog.basis === 'none' ? 'no catalog' : catalog.basis}
        </span>{' '}
        <span class="agui-ui__catalog">{catalog.text}</span>
        {surface.catalogId !== undefined ? (
          <>
            {' · surface names '}
            <code class="agui-ui__catalog-id">{surface.catalogId}</code>
          </>
        ) : null}
      </p>
      <p class="agui-ui__states" data-source={view.stateSource}>
        {statesNote(view)}
      </p>
      {view.tree !== undefined ? (
        <ul class="agui-ui__tree agui-ui__tree--root" aria-label={`Components of ${surface.id}`}>
          <NodeRow node={view.tree} surfaceKey={surface.key} selected={selected} onSelect={onSelect} />
        </ul>
      ) : null}
      {view.unreachable.length > 0 ? (
        <>
          <h5 class="agui-ui__subheading">Not reachable from the root</h5>
          <ul class="agui-ui__tree agui-ui__tree--unreachable" aria-label={`Components of ${surface.id} not reachable from the root`}>
            {view.unreachable.map((node, index) => (
              <NodeRow key={`${node.id}:${String(index)}`} node={node} surfaceKey={surface.key} selected={selected} onSelect={onSelect} />
            ))}
          </ul>
        </>
      ) : null}
      {view.findings.length > 0 ? (
        <h5 class="agui-ui__subheading">{plural(view.findings.length, 'finding', 'findings')}</h5>
      ) : null}
      <Findings findings={view.findings} onFrame={onFrame} onComponent={select} />
    </section>
  );
}

function Details({
  view,
  componentId,
  onFrame,
}: {
  view: UiSurface | undefined;
  componentId: string | undefined;
  onFrame: (seq: number) => void;
}): JSX.Element {
  const component = componentId === undefined ? undefined : view?.surface.components.get(componentId);
  if (view === undefined || component === undefined) {
    return (
      <aside class="agui-ui__details" aria-label="Component details">
        <p class="agui-ui__hint">Select a component to see its props and the frame that set it.</p>
      </aside>
    );
  }
  const node = findNode(view, component.id);
  return (
    <aside class="agui-ui__details" aria-label="Component details" data-component={component.id}>
      <h4 class="agui-ui__heading">
        <span class="agui-ui__surface-id">{component.id}</span>
        <span class="agui-ui__chip">{component.type}</span>
        {node?.state !== undefined ? (
          <span class="agui-ui__badge" data-state={node.state}>
            {NODE_STATE_LABEL[node.state]}
          </span>
        ) : null}
      </h4>
      <p class="agui-ui__meta">
        {node?.stateFrom === 'app' ? 'State reported by the app.' : 'State inferred from the wire checks.'} Surface{' '}
        <code>{view.surface.id}</code>.
      </p>
      <button
        type="button"
        class="agui-ui__link agui-ui__frame"
        data-seq={component.seq}
        onClick={() => {
          onFrame(component.seq);
        }}
      >
        Show frame {String(component.seq)} in Timeline
      </button>
      <h5 class="agui-ui__subheading">Props</h5>
      <div class="agui-ui__props">
        <JsonTree value={component.props} label="props" />
      </div>
    </aside>
  );
}

function findNode(view: UiSurface, id: string): UiNode | undefined {
  const stack: UiNode[] = [...(view.tree !== undefined ? [view.tree] : []), ...view.unreachable];
  while (stack.length > 0) {
    const node = stack.pop() as UiNode;
    if (node.id === id && node.component !== undefined && node.repeat !== true) return node;
    for (const child of node.children) stack.push(child);
  }
  return undefined;
}

function RunGroup({
  group,
  selected,
  onSelect,
  onFrame,
}: {
  group: UiRunGroup;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
  onFrame: (seq: number) => void;
}): JSX.Element {
  const heading = group.runId === undefined ? 'Outside a run' : `Run ${group.runId}`;
  return (
    <section class="agui-ui__run" data-run={group.runId} aria-label={heading}>
      <h3 class="agui-ui__run-heading">
        {heading} · {plural(group.surfaces.length, 'surface', 'surfaces')}
      </h3>
      <Findings findings={group.findings} onFrame={onFrame} />
      {group.surfaces.map((view) => (
        <SurfaceView key={view.surface.key} view={view} selected={selected} onSelect={onSelect} onFrame={onFrame} />
      ))}
    </section>
  );
}

export function Ui({ store }: UiProps): JSX.Element {
  const state = usePanelState(store);
  const [selected, setSelected] = useState<Selection | null>(null);
  const { records, requests, runs, scope } = state;
  const renders = state.renders.reports;
  const model = useMemo(
    () => buildUiModel({ records, requests, runs, renders }, scope),
    [records, requests, runs, renders, scope],
  );

  const showFrame = (seq: number): void => {
    // Same hand-off as Signals/Runs/State: one write, the scope dropped only when it would hide the frame.
    store.update((s) => selectTab(selectSeq(scopeShows(s, seq) ? s : selectScope(s, null), seq), 'timeline'));
  };

  if (model.surfaceCount === 0 && model.groups.length === 0) {
    return (
      <section class="agui-ui" aria-label="UI">
        <p class="agui-ui__empty">{UI_EMPTY_TEXT}</p>
      </section>
    );
  }

  const views = model.groups.flatMap((group) => group.surfaces);
  const selectedView = selected === null ? undefined : views.find((view) => view.surface.key === selected.surfaceKey);

  return (
    <section class="agui-ui" aria-label="UI">
      <div class="agui-ui__main">
        <p class="agui-ui__lede">
          Generative-UI surfaces by run, each component with its state. Select one to see its props and the frame
          that set it.
        </p>
        {state.source.kind === 'imported' ? (
          <p class="agui-ui__note">
            An imported capture carries no render reports from the app, so node states come from the wire checks.
          </p>
        ) : null}
        {model.groups.map((group) => (
          <RunGroup key={group.runId ?? '-'} group={group} selected={selected} onSelect={setSelected} onFrame={showFrame} />
        ))}
      </div>
      <Details view={selectedView} componentId={selected?.componentId} onFrame={showFrame} />
    </section>
  );
}
