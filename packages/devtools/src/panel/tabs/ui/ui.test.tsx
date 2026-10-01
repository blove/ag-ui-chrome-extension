import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/preact';
// `?raw`: under the jsdom project `import.meta.url` does not point at the file (see state.test.tsx).
import copilotkitJsonl from '../../../test/fixtures/genui-copilotkit.agui.jsonl?raw';
import threadplaneJsonl from '../../../test/fixtures/genui-threadplane-agui.agui.jsonl?raw';
import type { RenderDevtoolsReport } from '../../../core/signals/render-report';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore, type PanelStore } from '../../model/store';
import { Ui, UI_EMPTY_TEXT } from './ui';

const FAULT_WORDS =
  /\b(not detected|detection|failed|failure|error|unable|could not|missing|broken|none found|no agents)\b/i;

function stateOf(jsonl: string, renders: RenderDevtoolsReport[] = []): PanelState {
  const loaded = loadJsonl(jsonl);
  return {
    ...initialPanelState(),
    source: { kind: 'live', origin: 'http://localhost:5173' },
    tab: 'ui',
    records: loaded.records,
    requests: loaded.requests,
    runs: loaded.runs,
    renders: { reports: renders, droppedBefore: 0 },
  };
}

function renderTab(state: PanelState): PanelStore {
  const store = createPanelStore(state);
  render(<Ui store={store} />);
  return store;
}

function surface(id: string, run?: string): HTMLElement {
  const selector = `[data-surface="${id}"]${run === undefined ? '' : `[data-run="${run}"]`}`;
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no surface ${id}`);
  return element;
}

function badges(element: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of element.querySelectorAll<HTMLElement>('.agui-ui__node[data-state]')) {
    const id = node.getAttribute('data-component') ?? '';
    if (!(id in out)) out[id] = node.querySelector('.agui-ui__badge')?.textContent ?? '';
  }
  return out;
}

const COCKPIT_REPORT: RenderDevtoolsReport = {
  v: 1,
  kind: 'render',
  surface: 'spec:root',
  seq: 7,
  registry: ['dashboard_grid', 'container', 'stat_card', 'data_grid'],
  elements: [
    { key: 'root', type: 'dashboard_grid', state: 'mounted' },
    { key: 'delay_card', type: 'stat_card', state: 'fallback' },
    { key: 'trend_chart', type: 'line_chart', state: 'unresolved' },
    { key: 'airline_chart', type: 'bar_chart', state: 'unresolved' },
    { key: 'table_section', type: 'data_grid', state: 'hidden' },
  ],
  tMs: 1,
};

describe('UI tab', () => {
  it('says what it lists when the capture has no generative UI, with no fault words', () => {
    renderTab({ ...initialPanelState(), tab: 'ui' });
    const empty = screen.getByText(UI_EMPTY_TEXT);
    expect(FAULT_WORDS.exec(empty.closest('section')?.textContent ?? '')).toBeNull();
  });

  it('groups surfaces by run, each with framework, format, catalog basis and status', () => {
    renderTab(stateOf(copilotkitJsonl));
    expect(screen.getByRole('heading', { name: 'Run r-v10 · 3 surfaces' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run r-v02 · 3 surfaces' })).toBeTruthy();
    const hotels = surface('hotels');
    expect(hotels.querySelector('h4')?.textContent).toContain('CopilotKit');
    expect(hotels.querySelector('h4')?.textContent).toContain('A2UI v0.9');
    expect(hotels.querySelector('.agui-ui__meta .agui-ui__basis')?.textContent).toBe('exact');
    expect(hotels.querySelector('.agui-ui__catalog')?.textContent).toContain('advertised by the app');
    expect(surface('a2ui-surface-outer1').querySelector('.agui-ui__status')?.textContent).toBe('failed');
    expect(surface('test-surface').querySelector('.agui-ui__status')?.textContent).toBe('deleted');
  });

  it('draws the tree from the root with a badge per node, and lists the surface’s findings', () => {
    renderTab(stateOf(copilotkitJsonl));
    const hotels = surface('hotels');
    expect(badges(hotels)).toEqual({
      root: 'rendered',
      title: 'rendered',
      list: 'rendered',
      card: 'rendered',
      badge: 'unknown type',
      badgeText: 'not rendered',
    });
    expect(hotels.querySelector('.agui-ui__states')?.textContent).toBe('Node states inferred from the wire checks.');
    const findings = within(hotels).getByRole('list', { name: 'Findings' });
    expect([...findings.querySelectorAll('li')].map((li) => li.getAttribute('data-code'))).toEqual([
      'unknown_component',
      'missing_required_prop',
      'orphaned_subtree',
    ]);
  });

  it('lists what the root cannot reach separately, and a reference the surface does not hold', () => {
    renderTab(stateOf(copilotkitJsonl));
    const card = surface('card-1');
    expect(within(card).getByText('Not reachable from the root')).toBeTruthy();
    expect(card.querySelector('.agui-ui__tree--unreachable [data-component="root"]')?.getAttribute('data-state')).toBe('not-rendered');
    expect(card.querySelector('.agui-ui__node--absent[data-component="text"]')?.textContent).toContain('not on this surface');
  });

  it('shows a selected node’s props and links its source frame in Timeline', () => {
    const store = renderTab(stateOf(copilotkitJsonl));
    fireEvent.click(surface('hotels').querySelector('.agui-ui__node[data-component="card"]') as HTMLElement);
    const details = screen.getByRole('complementary', { name: 'Component details' });
    expect(details.getAttribute('data-component')).toBe('card');
    expect(details.textContent).toContain('HotelCard');
    expect(details.textContent).toContain('props');
    fireEvent.click(within(details).getByRole('button', { name: 'Show frame 5 in Timeline' }));
    expect(store.get().tab).toBe('timeline');
    expect(store.get().selectedSeq).toBe(5);
  });

  it('a finding selects its component', () => {
    renderTab(stateOf(copilotkitJsonl));
    fireEvent.click(within(surface('hotels')).getByRole('button', { name: 'Select badge' }));
    expect(screen.getByRole('complementary', { name: 'Component details' }).getAttribute('data-component')).toBe('badge');
  });

  it('takes node states from the app’s render report for the surface, and says so', () => {
    renderTab(stateOf(threadplaneJsonl, [COCKPIT_REPORT]));
    const cockpit = surface('spec:root', 'r-tp2');
    expect(badges(cockpit)).toMatchObject({
      root: 'rendered',
      delay_card: 'fallback',
      trend_chart: 'unknown type',
      airline_chart: 'unknown type',
      table_section: 'not rendered',
    });
    expect(cockpit.querySelector('.agui-ui__states')?.textContent).toBe('Node states reported by the app (render report 7).');
    expect(cockpit.querySelector('.agui-ui__catalog')?.textContent).toContain('reported by the app');
    expect(cockpit.querySelector('[data-component="delay_card"]')?.getAttribute('data-from')).toBe('app');
    // The earlier run's surface of the same id keeps the checks' states.
    expect(surface('spec:root', 'r-tp1').querySelector('.agui-ui__states')?.textContent).toBe(
      'Node states inferred from the wire checks.',
    );
  });

  it('without a report, the same json-render surface has no catalog and every node is inferred rendered', () => {
    renderTab(stateOf(threadplaneJsonl));
    const cockpit = surface('spec:root', 'r-tp2');
    expect(new Set(Object.values(badges(cockpit)))).toEqual(new Set(['rendered']));
    expect(cockpit.querySelector('.agui-ui__meta .agui-ui__basis')?.textContent).toBe('no catalog');
  });

  it('lists a run’s extraction findings under the run, with a link to their frame', () => {
    const store = renderTab(stateOf(threadplaneJsonl));
    const run = document.querySelector<HTMLElement>('.agui-ui__run[data-run="r-tp1"]') as HTMLElement;
    const first = run.querySelector(':scope > .agui-ui__findings li');
    expect(first?.getAttribute('data-code')).toBe('unparsed_envelope');
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Show frame 8 in Timeline' }));
    expect(store.get().selectedSeq).toBe(8);
  });

  it('notes that an imported capture’s states come from the checks', () => {
    renderTab({ ...stateOf(copilotkitJsonl), source: { kind: 'imported', filename: 'x.agui.jsonl', importedAtMs: 1 } });
    expect(screen.getByText(/carries no render reports/)).toBeTruthy();
  });
});
