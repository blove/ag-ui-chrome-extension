/**
 * LangGraph Platform SSE event names (spec §2).
 *
 * With `stream_subgraphs` on, an event from inside a subgraph is named
 * `` `${mode}|${ns.join('|')}` `` — `messages|research:9f1c…` — where each namespace segment is
 * `node:task_id`. `metadata` and `feedback` are never namespaced.
 */
const KNOWN_MODES: ReadonlySet<string> = new Set([
  'metadata',
  'values',
  'updates',
  'messages',
  'messages/partial',
  'messages/complete',
  'messages/metadata',
  'custom',
  'error',
  'debug',
  'tasks',
  'checkpoints',
  'events',
  'tools',
  'feedback',
]);

export interface ParsedEventName {
  readonly mode: string;
  readonly namespace: readonly string[];
}

export function parseEventName(name: string | undefined): ParsedEventName {
  const [mode = '', ...namespace] = (name ?? '').split('|');
  return { mode, namespace };
}

export function isKnownMode(mode: string): boolean {
  return KNOWN_MODES.has(mode);
}
