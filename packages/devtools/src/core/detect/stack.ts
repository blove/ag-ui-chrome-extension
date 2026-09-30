/**
 * Which stacks a tab has spoken, and the toolbar badge that says so (spec §14.6).
 *
 * Pure and Chrome-free so the one rule is testable without a browser: the service worker feeds a
 * tracker per tab and hands `badgeFor` to `chrome.action`, and nothing else decides what the badge
 * shows.
 *
 * STRICT, ON PURPOSE (B4). Capture takes every `text/event-stream` on a granted origin, so "the
 * extension captured something" is not evidence of AG-UI — a random SSE app on localhost would
 * light the badge. A connection counts only once it has said something in a protocol this
 * extension knows: an event whose `type` is in the generated AG-UI table, a binary AG-UI stream,
 * or a LangGraph Platform stream by the same `dialectOf` rule the panel and the export use. If the
 * badge and the panel disagreed about which connections are LangGraph, one of them would be lying.
 */
import { EVENT_TYPES } from '../events/event-table.generated';
import type { CaptureRecord } from '../model/types';
import { dialectOf, type DialectFirstFrame } from '../normalizer/dialect';
import type { RuntimeInfo } from './info';

export type StackKind = 'agui' | 'langgraph';

/** The request-line fields detection reads. Structural, so the worker's `RequestLine` fits. */
export interface StackRequest {
  readonly connId: string;
  readonly method: string;
  readonly url: string;
}

export interface StackInput {
  readonly requests: readonly StackRequest[];
  readonly records: readonly CaptureRecord[];
  readonly runtime: RuntimeInfo | null;
  /** Connections that were reported as a binary (protobuf) AG-UI transport. */
  readonly binaryConnections: Iterable<string>;
}

/** Counts of CONNECTIONS, not events: the tooltip reports how many streams, not how busy they were. */
export interface StackSummary {
  agui: number;
  langGraph: number;
  runtime?: RuntimeInfo;
}

export interface StackDecision {
  connId: string;
  kind: StackKind;
}

/**
 * Incremental detection for one tab.
 *
 * Every method returns whether the tab's answer could have changed, so a caller can skip the
 * `chrome.action` round-trip when it did not. DECISIONS ARE STICKY: once a connection is decided,
 * its later records are a single map lookup and are never rescanned — a 1,213-frame stream costs
 * one decision, not 1,213. The one thing that can move a decided connection is its request line
 * arriving after its frames and naming a LangGraph route, because `dialectOf` ranks the route
 * above anything a frame says.
 */
export interface StackTracker {
  request(line: StackRequest): boolean;
  record(record: CaptureRecord): boolean;
  binary(connId: string): boolean;
  summary(runtime: RuntimeInfo | null): StackSummary;
  /** What has been decided, in a shape that survives `chrome.storage.session`. */
  decisions(): StackDecision[];
}

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

function isStackKind(value: unknown): value is StackKind {
  return value === 'agui' || value === 'langgraph';
}

function firstFrameOf(record: CaptureRecord | undefined): DialectFirstFrame | undefined {
  if (record?.kind !== 'event') return undefined;
  return {
    ...(record.sseEvent !== undefined ? { sseEvent: record.sseEvent } : {}),
    payload: record.raw,
  };
}

/**
 * `seed` restores decisions made by a previous worker incarnation. Without it, a connection whose
 * deciding records were trimmed out of the session mirror — or a binary stream, which leaves no
 * records at all — would drop out of the count on a worker restart, and the badge would change
 * for a tab where nothing happened.
 */
export function createStackTracker(seed: readonly StackDecision[] = []): StackTracker {
  const requests = new Map<string, StackRequest>();
  const firstEvents = new Map<string, CaptureRecord>();
  const decided = new Map<string, StackKind>();
  for (const decision of seed) {
    if (typeof decision.connId === 'string' && isStackKind(decision.kind)) {
      decided.set(decision.connId, decision.kind);
    }
  }

  const dialect = (connId: string): StackKind =>
    dialectOf(requests.get(connId), firstFrameOf(firstEvents.get(connId)));

  return {
    request(line) {
      if (requests.has(line.connId)) return false;
      requests.set(line.connId, line);
      // A route alone decides LangGraph; it can never decide AG-UI, which needs an event.
      if (dialect(line.connId) !== 'langgraph') return false;
      if (decided.get(line.connId) === 'langgraph') return false;
      decided.set(line.connId, 'langgraph');
      return true;
    },
    record(record) {
      if (record.kind !== 'event') return false;
      if (!firstEvents.has(record.connId)) firstEvents.set(record.connId, record);
      if (decided.has(record.connId)) return false;
      if (dialect(record.connId) === 'langgraph') {
        decided.set(record.connId, 'langgraph');
        return true;
      }
      const type = record.event?.type;
      if (typeof type !== 'string' || !KNOWN_EVENT_TYPES.has(type)) return false;
      decided.set(record.connId, 'agui');
      return true;
    },
    binary(connId) {
      if (decided.has(connId)) return false;
      decided.set(connId, 'agui');
      return true;
    },
    summary(runtime) {
      let agui = 0;
      let langGraph = 0;
      for (const kind of decided.values()) {
        if (kind === 'agui') agui += 1;
        else langGraph += 1;
      }
      return runtime === null ? { agui, langGraph } : { agui, langGraph, runtime };
    },
    decisions() {
      return [...decided].map(([connId, kind]) => ({ connId, kind }));
    },
  };
}

/** The whole rule over a whole tab — `createStackTracker` fed everything at once. */
export function detectStack(input: StackInput): StackSummary {
  const tracker = createStackTracker();
  for (const line of input.requests) tracker.request(line);
  for (const record of input.records) tracker.record(record);
  for (const connId of input.binaryConnections) tracker.binary(connId);
  return tracker.summary(input.runtime);
}

/* -------------------------------------------------------------------------- */
/* The badge                                                                    */
/* -------------------------------------------------------------------------- */

export const BADGE_DEFAULT_TITLE = 'AG-UI DevTools';

/**
 * The panel's own accent (`listing/icon.svg`'s tile). A saturated mid-blue with white text reads
 * on both the light and the dark toolbar, which a pale or a near-black badge would not.
 */
export const BADGE_COLOR = '#1a73e8';

export interface Badge {
  text: string;
  title: string;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function runtimeLabel(runtime: RuntimeInfo): string {
  // A missing version is left out rather than filled in: the runtime did not report one.
  const version = runtime.version === null ? '' : ` ${runtime.version}`;
  return `CopilotKit runtime${version} (${runtime.mode})`;
}

/**
 * Badge text from connections only (B2); the title names everything the worker knows (B3).
 *
 * An `/info` answer with no stream yet lights no badge — it is not a stream, and B4 counts
 * streams — but it does reach the title, because it is a true statement about the page. The page
 * framework is not here: it is probed from the panel, and the worker does not know it.
 */
export function badgeFor(stack: StackSummary): Badge {
  const text =
    stack.agui > 0 && stack.langGraph > 0
      ? 'A+L'
      : stack.agui > 0
        ? 'AG'
        : stack.langGraph > 0
          ? 'LG'
          : '';
  const parts: string[] = [];
  if (stack.agui > 0) parts.push('AG-UI');
  if (stack.langGraph > 0) parts.push('LangGraph Platform');
  if (stack.runtime !== undefined) parts.push(runtimeLabel(stack.runtime));
  const connections = stack.agui + stack.langGraph;
  if (connections > 0) parts.push(plural(connections, 'connection'));
  if (parts.length === 0) return { text, title: BADGE_DEFAULT_TITLE };
  return {
    text,
    title: `${BADGE_DEFAULT_TITLE} — ${parts.join(' · ')} — open DevTools → AG-UI`,
  };
}
