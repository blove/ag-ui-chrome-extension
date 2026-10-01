/**
 * The Signals matrix, as data (design G6). Pure: the tab only draws what this returns.
 *
 * One block per agent instance. Rows are the signal names that block's shown columns wrote, in the
 * adapter's fixed vocabulary order (`core/signals/report.ts` — the order is part of the contract,
 * so two captures of the same app always lay out the same). Columns are the reports in `seq`
 * order. A cell is lit when that event wrote that signal; nothing here claims which computed
 * signals RECOMPUTED, which no hook can observe from names alone.
 */
import {
  AG_UI_SIGNALS,
  LANGGRAPH_SIGNALS,
  type ThreadplaneAdapter,
  type ThreadplaneDevtoolsReport,
} from '../../../core/signals/report';

/**
 * The most columns one block draws. Capped rather than virtualised: `common/virtual-list` is
 * vertical-only, and 500 columns × at most 15 rows is a table the browser lays out without effort.
 * The newest are kept, because a developer watching a session is looking at what just happened —
 * and the tab says, in the block, how many were not drawn.
 */
export const MAX_COLUMNS = 500;

const VOCABULARY: Record<ThreadplaneAdapter, readonly string[]> = {
  langgraph: LANGGRAPH_SIGNALS,
  'ag-ui': AG_UI_SIGNALS,
};

const ADAPTER_LABEL: Record<ThreadplaneAdapter, string> = {
  langgraph: 'LangGraph',
  'ag-ui': 'AG-UI',
};

export interface SignalColumn {
  report: ThreadplaneDevtoolsReport;
  lit: ReadonlySet<string>;
}

export interface SignalBlock {
  agent: string;
  /** The first 8 characters of `agent` — enough to tell two instances apart on screen. */
  shortAgent: string;
  adapter: ThreadplaneAdapter;
  adapterLabel: string;
  /** Every report this agent has held, drawn or not. */
  total: number;
  columns: SignalColumn[];
  rows: string[];
  /** True when `columns` is the last `MAX_COLUMNS` of `total`. */
  capped: boolean;
}

export function signalBlocks(
  reports: readonly ThreadplaneDevtoolsReport[],
  maxColumns: number = MAX_COLUMNS,
): SignalBlock[] {
  const byAgent = new Map<string, ThreadplaneDevtoolsReport[]>();
  for (const report of reports) {
    const held = byAgent.get(report.agent);
    if (held === undefined) byAgent.set(report.agent, [report]);
    else held.push(report);
  }

  const blocks: SignalBlock[] = [];
  for (const [agent, held] of byAgent) {
    const first = held[0];
    if (first === undefined) continue;
    // An agent id is per instance and an instance has one adapter, so the first report's stands.
    const adapter = first.adapter;
    const ordered = [...held].sort((a, b) => a.seq - b.seq);
    const shown = ordered.slice(Math.max(0, ordered.length - maxColumns));
    const columns = shown.map((report) => ({ report, lit: new Set(report.wrote) }));
    const seen = new Set<string>();
    for (const column of columns) for (const name of column.lit) seen.add(name);
    blocks.push({
      agent,
      shortAgent: agent.slice(0, 8),
      adapter,
      adapterLabel: ADAPTER_LABEL[adapter],
      total: ordered.length,
      columns,
      rows: VOCABULARY[adapter].filter((name) => seen.has(name)),
      capped: shown.length < ordered.length,
    });
  }
  return blocks;
}

/**
 * The most characters a column header shows. Every AG-UI event name in common use fits
 * (`TEXT_MESSAGE_CONTENT` is 20), so the three TEXT_MESSAGE_* columns read as themselves rather
 * than as three identical truncations; the header is sized for this many in `panel.css`.
 */
export const MAX_COLUMN_LABEL = 20;

/**
 * A column header's text: the event name, or — when it is longer than `MAX_COLUMN_LABEL` — an
 * abbreviation that keeps what tells neighbouring columns apart. The full name is always in the
 * header's `title` and accessible name; this is only what is painted.
 *
 *  - A LangGraph namespaced name (`messages|research:t1…`) keeps its base and marks the namespace:
 *    the base is the event, the namespace a long id.
 *  - Otherwise the first word and the longest tail that fit, joined by `…` at a `_` or `/`
 *    boundary: `REASONING_MESSAGE_CONTENT` → `REASONING…MESSAGE_CONTENT` would not fit, so
 *    `REASONING…CONTENT`. The END of a protocol name (`_START`, `_CONTENT`, `_END`) is what
 *    differs between neighbours; a plain end-truncation is exactly what hides it.
 */
export function columnLabel(eventType: string, max: number = MAX_COLUMN_LABEL): string {
  if (eventType.length <= max) return eventType;
  const bar = eventType.indexOf('|');
  if (bar > 0 && bar + 2 <= max) return `${eventType.slice(0, bar)}|…`;
  const boundaries: number[] = [];
  for (let index = 0; index < eventType.length; index += 1) {
    const char = eventType[index];
    if (char === '_' || char === '/') boundaries.push(index);
  }
  const first = boundaries[0];
  if (first !== undefined) {
    const head = eventType.slice(0, first);
    // Boundaries in order, so the first tail that fits is the longest one.
    for (const boundary of boundaries) {
      const candidate = `${head}…${eventType.slice(boundary + 1)}`;
      if (candidate.length <= max) return candidate;
    }
    const last = boundaries[boundaries.length - 1] ?? first;
    const tail = `…${eventType.slice(last + 1)}`;
    if (tail.length <= max) return tail;
  }
  return `${eventType.slice(0, max - 1)}…`;
}
