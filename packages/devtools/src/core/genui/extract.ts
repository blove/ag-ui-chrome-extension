/**
 * Generative-UI surfaces, read off a capture (design U1).
 *
 * Pure and Chrome-free: records + request lines + runs in, surfaces out. Nothing here throws on
 * what the wire carried — a malformed envelope, a poisoned partial, a spec that does not parse
 * becomes a finding, and extraction carries on.
 *
 * WHERE A SURFACE COMES FROM
 *
 *   Threadplane (`@threadplane/chat`), over AG-UI or LangGraph:
 *   - assistant text that starts with `---a2ui_JSON---`, then A2UI v0.9 JSONL envelopes. Threadplane's
 *     parser applies a line only once its newline arrives (`createA2uiMessageParser`), so a final
 *     unterminated line is reported, not applied;
 *   - assistant text whose first character is `{`: a json-render spec `{root, elements}`
 *     (`content-classifier.ts`);
 *   - `a2ui-partial` custom events `{tool_call_id, args_so_far}` — AG-UI `CUSTOM.value`, LangGraph
 *     `custom` frames `{name, data}` — parsed as Threadplane's `partial-args-bridge.ts` does: an
 *     args prefix that is no JSON prefix poisons the call; otherwise the LAST valid parse wins and
 *     its closed envelopes apply, an `updateComponents` before any `createSurface` synthesising
 *     one on the basic catalog;
 *   - GenUI tool calls' arguments: A2UI envelope args in the four shapes `envelope-normalizer.ts`
 *     accepts, or a json-render spec.
 *   CopilotKit (`@ag-ui/a2ui-middleware`), over AG-UI:
 *   - `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` with `activityType: 'a2ui-surface'`, content
 *     `{a2ui_operations}` (v0.0.10, A2UI v0.9) or `{operations}` (v0.0.2, A2UI v0.8), applied with
 *     AG-UI's activity semantics (a `replace: false` snapshot is ignored once the activity exists;
 *     a delta patches it). Lifecycle snapshots (`status: building | retrying | failed`) mark the
 *     activity's surfaces, or stand in for a surface that never painted.
 *
 * HOW ENVELOPES APPLY. In capture order. `createSurface`/`beginRendering` creates (a deleted surface
 * starts over), `updateComponents`/`surfaceUpdate` merges by component id, `deleteSurface` marks the
 * surface deleted. The same surface reached by several sources in one run — Threadplane's partials,
 * then its tool args, then its final message — is one surface; applying an envelope twice is
 * idempotent. Surfaces are per run: the same surface id in two runs is two surfaces.
 */
import type { AguiEvent, CaptureRecord, Run } from '../model/types';
import { dialectOf, type Dialect } from '../normalizer/dialect';
import { contentParts, isObject, roleOf } from '../normalizer/langgraph/messages';
import { parseEventName } from '../normalizer/langgraph/names';
import { applyPatch } from '../state/json-patch';
import { THREADPLANE_BASIC_CATALOG_ID, type CatalogBasis } from './catalog';
import { parsePartialJson, type PartialJson } from './partial-json';

export type GenuiFramework = 'threadplane' | 'copilotkit';
export type GenuiFormat = 'a2ui' | 'json-render';
/** CopilotKit's pre-paint lifecycle, or `deleted` after a `deleteSurface`. Absent: live. */
export type SurfaceStatus = 'building' | 'retrying' | 'failed' | 'deleted';

export interface GenuiComponent {
  id: string;
  /** A2UI `component` (v0.9) or the single key of `component` (v0.8); json-render `type`. */
  type: string;
  /** Everything else the component carried, child references included. Captured content. */
  props: Record<string, unknown>;
  /** Referenced child ids, in order: `child`, `children` (list or template), Modal, Tabs. */
  children: string[];
  /** The seq of the frame whose envelope last set this component. */
  seq: number;
}

export interface GenuiSurface {
  /** Unique within one extraction: run, framework, format and id. */
  key: string;
  /** A2UI `surfaceId`; `spec:` + root key for json-render; the activity id for a surface that never painted. */
  id: string;
  framework: GenuiFramework;
  format: GenuiFormat;
  a2uiVersion?: 'v0.8' | 'v0.9';
  catalogId?: string;
  runId?: string;
  components: Map<string, GenuiComponent>;
  /** v0.9: `root` when a component has that id; v0.8: `beginRendering.root`; json-render: `spec.root`. */
  root?: string;
  /** Every frame that contributed, ascending. */
  sourceSeqs: number[];
  status?: SurfaceStatus;
  /** Ids sent twice within one `updateComponents` — a merge would otherwise hide them. */
  duplicateIds: string[];
}

export type GenuiFindingCode =
  // U3 — checks over a surface (check.ts).
  | 'unknown_component'
  | 'missing_required_prop'
  | 'unresolved_child'
  | 'orphaned_subtree'
  | 'no_root'
  | 'duplicate_id'
  | 'catalog_mismatch'
  // Extraction — what the wire carried that could not be applied.
  | 'unparsed_envelope'
  | 'unterminated_envelope'
  | 'unparsed_payload'
  | 'truncated_payload'
  | 'partial_args_invalid'
  | 'malformed_component';

export interface GenuiFinding {
  code: GenuiFindingCode;
  /** `inferred` only when the finding rests on the inferred basic catalog. */
  basis: CatalogBasis;
  message: string;
  surfaceKey?: string;
  componentId?: string;
  /** The frame the finding is about, for extraction findings. */
  seq?: number;
  runId?: string;
}

export interface GenuiExtraction {
  surfaces: GenuiSurface[];
  findings: GenuiFinding[];
}

/** A request line — structurally `RequestLine` from `sw/protocol`, which core/ cannot import. */
export interface GenuiRequest {
  readonly connId: string;
  readonly method: string;
  readonly url: string;
  readonly input: unknown;
}

export interface GenuiCapture {
  readonly records: readonly CaptureRecord[];
  readonly requests: readonly GenuiRequest[];
  readonly runs: readonly Run[];
}

/** Threadplane's sentinel for A2UI assistant text (`content-classifier.ts`). */
export const A2UI_SENTINEL = '---a2ui_JSON---';
/** Threadplane's GenUI tools whose args are A2UI envelopes (`envelope-normalizer.ts` shapes). */
export const A2UI_TOOL_NAMES: readonly string[] = ['generate_a2ui_schema', 'render_a2ui_surface'];
/** Threadplane's GenUI tools whose args are a json-render spec. */
export const JSON_RENDER_TOOL_NAMES: readonly string[] = ['generate_json_render_spec', 'render_spec'];
export const A2UI_PARTIAL_EVENT = 'a2ui-partial';
export const A2UI_ACTIVITY_TYPE = 'a2ui-surface';

const V09_KEYS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const;
const V08_KEYS = ['beginRendering', 'surfaceUpdate', 'dataModelUpdate'] as const;
const OP_KEYS: readonly string[] = [...V09_KEYS, ...V08_KEYS];
const LIFECYCLE: ReadonlySet<string> = new Set(['building', 'retrying', 'failed']);

interface Origin {
  runId: string | undefined;
  framework: GenuiFramework;
  /** The frame this application happens at. */
  seq: number;
  /** Every frame the application stands for. */
  seqs: readonly number[];
}

interface SurfaceState {
  surface: GenuiSurface;
  /** v0.8's `beginRendering.root`. */
  declaredRoot?: string;
}

interface Step {
  seq: number;
  order: number;
  apply: () => void;
}

const isWhitespace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function firstNonWhitespace(text: string): number {
  for (let i = 0; i < text.length; i += 1) if (!isWhitespace(text[i] as string)) return i;
  return -1;
}

/** Child ids a component references, in the order a renderer reaches them. */
function childRefs(type: string, props: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') refs.push(value);
    else if (isObject(value) && typeof value.componentId === 'string') refs.push(value.componentId);
  };
  push(props.child);
  const children = props.children;
  if (Array.isArray(children)) children.forEach(push);
  else if (isObject(children)) {
    if (Array.isArray(children.explicitList)) children.explicitList.forEach(push); // v0.8
    else if (isObject(children.template)) push(children.template); // v0.8 template
    else push(children); // v0.9 template `{componentId, path}`
  }
  if (type === 'Modal') {
    push(props.trigger);
    push(props.content);
    push(props.entryPointChild);
    push(props.contentChild);
  }
  if (type === 'Tabs') {
    for (const list of [props.tabs, props.tabItems]) {
      if (Array.isArray(list)) for (const tab of list) if (isObject(tab)) push(tab.child);
    }
  }
  return refs;
}

/**
 * Normalise envelope-tool args into a list (`envelope-normalizer.ts`), and say at which container
 * depth its elements sit, so a partial parse can tell a closed element from one the cut closed.
 */
function envelopeList(args: unknown): { list: unknown[]; depth: number } | null {
  if (!isObject(args)) return null;
  if (Array.isArray(args.envelopes)) return { list: args.envelopes, depth: 2 };
  if (Array.isArray(args.envelope)) return { list: args.envelope, depth: 2 };
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  if (keys.every((k) => /^\d+$/.test(k))) {
    return { list: keys.map(Number).sort((a, b) => a - b).map((k) => args[String(k)]), depth: 1 };
  }
  if (V09_KEYS.some((k) => k in args)) return { list: [args], depth: 0 };
  return null;
}

/** `partial-args-bridge.ts` `isStructurallyComplete`. */
function structurallyComplete(env: unknown): boolean {
  if (!isObject(env)) return false;
  for (const key of V09_KEYS) {
    const body = env[key];
    if (!isObject(body)) continue;
    if (key === 'updateComponents') {
      return (
        typeof body.surfaceId === 'string' &&
        Array.isArray(body.components) &&
        body.components.length > 0 &&
        body.components.every((c) => isObject(c) && typeof c.id === 'string' && typeof c.component === 'string')
      );
    }
    if (key === 'createSurface') return typeof body.surfaceId === 'string' && typeof body.catalogId === 'string';
    return true;
  }
  return false;
}

/** The envelopes of a parse that closed on the wire, stopping at the first that did not. */
function closedEnvelopes(parsed: Extract<PartialJson, { ok: true }>): unknown[] {
  const normalised = envelopeList(parsed.value);
  if (normalised === null) return [];
  const { list, depth } = normalised;
  const lastClosed = parsed.complete || parsed.cutDepth <= depth;
  const out: unknown[] = [];
  for (let i = 0; i < list.length; i += 1) {
    if (i === list.length - 1 && !lastClosed) break;
    if (!structurallyComplete(list[i])) break;
    out.push(list[i]);
  }
  return out;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const jsonEqual = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Pull every surface out of a capture. Never throws on what the capture holds. */
export function extractSurfaces(capture: GenuiCapture): GenuiExtraction {
  const findings: GenuiFinding[] = [];
  const surfaces = new Map<string, SurfaceState>();
  const steps: Step[] = [];
  const addStep = (seq: number, apply: () => void): void => {
    steps.push({ seq, order: steps.length, apply });
  };

  // ---- Where each frame belongs ----
  const runOfSeq = new Map<number, Run>();
  for (const run of capture.runs) for (const seq of run.recordSeqs) if (!runOfSeq.has(seq)) runOfSeq.set(seq, run);
  const records = [...capture.records].sort((a, b) => a.seq - b.seq);
  const recordBySeq = new Map<number, CaptureRecord>();
  for (const record of records) recordBySeq.set(record.seq, record);
  const dialects = new Map<string, Dialect>();
  {
    const requestOf = new Map<string, GenuiRequest>();
    for (const request of capture.requests) if (!requestOf.has(request.connId)) requestOf.set(request.connId, request);
    const firstOf = new Map<string, CaptureRecord>();
    for (const record of records) if (record.kind === 'event' && !firstOf.has(record.connId)) firstOf.set(record.connId, record);
    for (const connId of new Set([...requestOf.keys(), ...firstOf.keys()])) {
      const first = firstOf.get(connId);
      dialects.set(
        connId,
        dialectOf(
          requestOf.get(connId),
          first === undefined
            ? undefined
            : { ...(first.kind === 'event' && first.sseEvent !== undefined ? { sseEvent: first.sseEvent } : {}), payload: first.raw },
        ),
      );
    }
  }

  // ---- Surfaces ----
  const finding = (code: GenuiFindingCode, message: string, extra: Partial<GenuiFinding> = {}): void => {
    findings.push({ code, basis: 'exact', message, ...extra });
  };
  const surfaceKey = (runId: string | undefined, framework: GenuiFramework, format: GenuiFormat, id: string): string =>
    JSON.stringify([runId ?? null, framework, format, id]);
  const touch = (state: SurfaceState, origin: Origin): void => {
    for (const seq of origin.seqs) state.surface.sourceSeqs.push(seq);
    state.surface.sourceSeqs.push(origin.seq);
  };
  const surfaceFor = (origin: Origin, format: GenuiFormat, id: string): SurfaceState => {
    const key = surfaceKey(origin.runId, origin.framework, format, id);
    let state = surfaces.get(key);
    if (state === undefined) {
      state = {
        surface: {
          key,
          id,
          framework: origin.framework,
          format,
          ...(origin.runId !== undefined ? { runId: origin.runId } : {}),
          components: new Map(),
          sourceSeqs: [],
          duplicateIds: [],
        },
      };
      surfaces.set(key, state);
    }
    touch(state, origin);
    return state;
  };
  const restart = (state: SurfaceState): void => {
    if (state.surface.status !== 'deleted') return;
    state.surface.components = new Map();
    state.surface.duplicateIds = [];
    delete state.surface.status;
    delete state.declaredRoot;
  };

  /** Apply one A2UI operation (v0.9 or v0.8). Returns the surface it touched. */
  const applyA2ui = (raw: unknown, origin: Origin): SurfaceState | undefined => {
    const where = { seq: origin.seq, ...(origin.runId !== undefined ? { runId: origin.runId } : {}) };
    if (!isObject(raw)) {
      finding('unparsed_envelope', 'An A2UI envelope that is not a JSON object', where);
      return undefined;
    }
    const key = OP_KEYS.find((k) => isObject(raw[k]));
    if (key === undefined) {
      finding('unparsed_envelope', 'Not an A2UI envelope: no createSurface, updateComponents, updateDataModel or deleteSurface', where);
      return undefined;
    }
    const body = raw[key] as Record<string, unknown>;
    const surfaceId = body.surfaceId;
    if (typeof surfaceId !== 'string' || surfaceId === '') {
      finding('unparsed_envelope', `An A2UI ${key} without a surfaceId`, where);
      return undefined;
    }
    const existing = surfaces.get(surfaceKey(origin.runId, origin.framework, 'a2ui', surfaceId));
    switch (key) {
      case 'createSurface':
      case 'beginRendering': {
        const state = surfaceFor(origin, 'a2ui', surfaceId);
        restart(state);
        state.surface.a2uiVersion = key === 'createSurface' ? 'v0.9' : 'v0.8';
        if (typeof body.catalogId === 'string') state.surface.catalogId = body.catalogId;
        if (key === 'beginRendering' && typeof body.root === 'string') state.declaredRoot = body.root;
        return state;
      }
      case 'updateComponents':
      case 'surfaceUpdate': {
        const state = surfaceFor(origin, 'a2ui', surfaceId);
        state.surface.a2uiVersion ??= key === 'updateComponents' ? 'v0.9' : 'v0.8';
        if (!Array.isArray(body.components)) {
          finding('unparsed_envelope', `An A2UI ${key} whose components is not a list`, { ...where, surfaceKey: state.surface.key });
          return state;
        }
        const seen = new Set<string>();
        body.components.forEach((item: unknown, index: number) => {
          const id = isObject(item) ? item.id : undefined;
          let type: string | undefined;
          let props: Record<string, unknown> = {};
          if (isObject(item) && typeof item.component === 'string') {
            type = item.component;
            props = { ...item };
            delete props.id;
            delete props.component;
          } else if (isObject(item) && isObject(item.component)) {
            const names = Object.keys(item.component);
            const inner = names.length === 1 ? item.component[names[0] as string] : undefined;
            if (names.length === 1 && isObject(inner)) {
              type = names[0];
              props = { ...inner };
            }
          }
          if (typeof id !== 'string' || id === '' || type === undefined || type === '') {
            finding('malformed_component', `Component ${String(index)} of an A2UI ${key} has no string id or component type`, {
              ...where,
              surfaceKey: state.surface.key,
            });
            return;
          }
          if (seen.has(id) && !state.surface.duplicateIds.includes(id)) state.surface.duplicateIds.push(id);
          seen.add(id);
          state.surface.components.set(id, { id, type, props, children: childRefs(type, props), seq: origin.seq });
        });
        return state;
      }
      case 'deleteSurface': {
        if (existing === undefined) return undefined;
        touch(existing, origin);
        existing.surface.status = 'deleted';
        return existing;
      }
      default: {
        // Data-model updates do not change the tree; they still belong to the surface's history.
        if (existing !== undefined) touch(existing, origin);
        return existing;
      }
    }
  };

  const applySpec = (spec: unknown, origin: Origin): void => {
    if (!isObject(spec)) return;
    const root = typeof spec.root === 'string' ? spec.root : undefined;
    const state = surfaceFor(origin, 'json-render', `spec:${root ?? ''}`);
    // A spec is a whole document: each one replaces the last.
    state.surface.components = new Map();
    if (root !== undefined) state.surface.root = root;
    else delete state.surface.root;
    if (!isObject(spec.elements)) return;
    for (const [id, element] of Object.entries(spec.elements)) {
      if (!isObject(element) || typeof element.type !== 'string' || element.type === '') {
        finding('malformed_component', `json-render element "${id}" has no string type`, {
          seq: origin.seq,
          surfaceKey: state.surface.key,
          ...(origin.runId !== undefined ? { runId: origin.runId } : {}),
        });
        continue;
      }
      const children = Array.isArray(element.children)
        ? element.children.filter((c: unknown): c is string => typeof c === 'string')
        : [];
      state.surface.components.set(id, {
        id,
        type: element.type,
        props: isObject(element.props) ? element.props : {},
        children,
        seq: origin.seq,
      });
    }
  };

  /** A json-render spec from text or args; partial text is closed at its last complete value. */
  const specFrom = (text: string, origin: Origin, describe: string): void => {
    const parsed = parsePartialJson(text);
    const where = { seq: origin.seq, ...(origin.runId !== undefined ? { runId: origin.runId } : {}) };
    if (!parsed.ok || !isObject(parsed.value)) {
      if (text.includes('"elements"') || text.includes('"root"')) {
        finding('unparsed_payload', `${describe} looks like a json-render spec but does not parse`, where);
      }
      return;
    }
    let spec: unknown = parsed.value;
    if (!('elements' in parsed.value) && !('root' in parsed.value) && isObject(parsed.value.spec)) spec = parsed.value.spec;
    if (!isObject(spec) || (!('elements' in spec) && !('root' in spec))) return;
    if (!parsed.complete) finding('truncated_payload', `${describe} ended before its JSON closed; what had closed is shown`, where);
    applySpec(spec, origin);
  };

  const a2uiText = (text: string, start: number, origin: Origin, closed: boolean): void => {
    const body = text.slice(start + A2UI_SENTINEL.length);
    const lines = body.split('\n');
    const tail = lines.pop() ?? '';
    const where = { seq: origin.seq, ...(origin.runId !== undefined ? { runId: origin.runId } : {}) };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        finding('unparsed_envelope', 'A line after the A2UI sentinel is not JSON; Threadplane skips it', where);
        continue;
      }
      applyA2ui(parsed, origin);
    }
    const last = tail.trim();
    if (closed && last !== '') {
      try {
        JSON.parse(last);
        finding('unterminated_envelope', 'The last A2UI line has no newline; Threadplane applies a line only once it ends', where);
      } catch {
        // A line still streaming, or cut off with its message: nothing to apply yet.
      }
    }
  };

  const classifyText = (text: string, origin: Origin, closed: boolean): void => {
    const start = firstNonWhitespace(text);
    if (start < 0) return;
    if (text.startsWith(A2UI_SENTINEL, start)) a2uiText(text, start, origin, closed);
    else if (text[start] === '{') specFrom(text.slice(start), origin, 'Assistant text');
  };

  /** Envelope args as Threadplane reads them: the closed envelopes of the last valid parse. */
  const envelopeArgs = (args: unknown, origin: Origin, describe: string): void => {
    let envelopes: unknown[];
    if (typeof args === 'string') {
      const parsed = parsePartialJson(args);
      const where = { seq: origin.seq, ...(origin.runId !== undefined ? { runId: origin.runId } : {}) };
      if (!parsed.ok) {
        finding('unparsed_payload', `${describe} are not JSON`, where);
        return;
      }
      envelopes = closedEnvelopes(parsed);
      // Args cut before they read as envelopes at all say nothing yet; the run's tool-args checks own them.
      if (!parsed.complete && envelopeList(parsed.value) !== null) {
        finding('truncated_payload', `${describe} ended before their JSON closed; the closed envelopes are applied`, where);
      }
    } else {
      envelopes = envelopeList(args)?.list ?? [];
    }
    for (const envelope of envelopes) applyA2ui(envelope, origin);
  };

  // ---- Sources: text and tool calls, newest version per message / call ----
  interface Versioned<T> {
    runId: string | undefined;
    anchor: number;
    seqs: number[];
    value: T;
    closed: boolean;
  }
  const texts = new Map<string, Versioned<string>>();
  const tools = new Map<string, Versioned<{ name: string; args: unknown }>>();
  const offer = <T>(map: Map<string, Versioned<T>>, key: string, next: Versioned<T>): void => {
    const current = map.get(key);
    if (current === undefined) {
      map.set(key, next);
      return;
    }
    const seqs = [...current.seqs, ...next.seqs];
    map.set(key, next.anchor >= current.anchor ? { ...next, seqs } : { ...current, seqs });
  };

  for (const run of capture.runs) {
    for (const message of run.messages.values()) {
      if (message.kind !== 'text' || message.contentSeqs.length === 0) continue;
      offer(texts, `${run.runId}#${message.messageId}`, {
        runId: run.runId,
        anchor: Math.max(...message.contentSeqs),
        seqs: [...message.contentSeqs],
        value: message.content,
        closed: message.closed,
      });
    }
    // Each tool call's frames: AG-UI events by `toolCallId`; a LangGraph frame by what it was read as.
    const toolSeqs = new Map<string, number[]>();
    for (const seq of run.recordSeqs) {
      const record = recordBySeq.get(seq);
      const derived = run.derived?.get(seq);
      const events: readonly (AguiEvent | null)[] = derived ?? (record?.kind === 'event' ? [record.event] : []);
      for (const event of events) {
        const id = event?.toolCallId;
        if (typeof id !== 'string') continue;
        const list = toolSeqs.get(id) ?? [];
        if (!list.includes(seq)) list.push(seq);
        toolSeqs.set(id, list);
      }
    }
    for (const call of run.toolCalls.values()) {
      const name = call.toolCallName;
      if (name === undefined || (!A2UI_TOOL_NAMES.includes(name) && !JSON_RENDER_TOOL_NAMES.includes(name))) continue;
      const seqs = toolSeqs.get(call.toolCallId) ?? [];
      if (seqs.length === 0) continue;
      offer(tools, `${run.runId}#${call.toolCallId}`, {
        runId: run.runId,
        anchor: Math.max(...seqs),
        seqs,
        value: { name, args: call.argsText },
        closed: call.closed,
      });
    }
  }

  // ---- Frames read directly: partials, activities, LangGraph state messages ----
  const partials = new Map<string, Array<{ seq: number; runId: string | undefined; args: string }>>();
  const firstValues = new Map<string, Map<string, string>>();
  for (const record of records) {
    if (record.kind !== 'event') continue;
    const run = runOfSeq.get(record.seq);
    const runId = run?.runId;
    const dialect = dialects.get(record.connId) ?? 'agui';
    let partial: unknown;
    if (dialect === 'langgraph') {
      const { mode, namespace } = parseEventName(record.sseEvent);
      const payload = record.raw;
      if (mode === 'custom' && isObject(payload) && payload.name === A2UI_PARTIAL_EVENT) partial = parseMaybeJson(payload.data);
      if (mode === 'values' || mode === 'updates') {
        const ns = `${record.connId}|${namespace.join('|')}`;
        const lists: unknown[] = [];
        if (mode === 'values' && isObject(payload)) lists.push(payload.messages);
        if (mode === 'updates' && isObject(payload)) {
          for (const node of Object.values(payload)) if (isObject(node)) lists.push(node.messages);
        }
        const messages = lists.flatMap((list) => (Array.isArray(list) ? list : isObject(list) ? [list] : []));
        // A run's first `values` is the thread as it stood: history, not this run's output.
        let history = mode === 'values' ? firstValues.get(ns) : undefined;
        const isFirstValues = mode === 'values' && history === undefined;
        if (isFirstValues) {
          history = new Map();
          firstValues.set(ns, history);
        }
        messages.forEach((message: unknown, index: number) => {
          if (!isObject(message) || roleOf(message.type) !== 'ai') return;
          const id = typeof message.id === 'string' && message.id !== '' ? message.id : `${String(record.seq)}:${String(index)}`;
          const fingerprint = JSON.stringify([message.content, message.tool_calls]);
          if (isFirstValues) {
            history?.set(id, fingerprint);
            return;
          }
          if (history?.get(id) === fingerprint) return;
          const text = contentParts(message.content).text;
          if (text !== '') {
            offer(texts, `${runId ?? ''}#${id}`, { runId, anchor: record.seq, seqs: [record.seq], value: text, closed: true });
          }
          if (Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
              if (!isObject(call) || typeof call.name !== 'string' || typeof call.id !== 'string') continue;
              if (!A2UI_TOOL_NAMES.includes(call.name) && !JSON_RENDER_TOOL_NAMES.includes(call.name)) continue;
              offer(tools, `${runId ?? ''}#${call.id}`, {
                runId,
                anchor: record.seq,
                seqs: [record.seq],
                value: { name: call.name, args: call.args },
                closed: true,
              });
            }
          }
        });
      }
    } else {
      const event = record.event;
      if (event?.type === 'CUSTOM' && event.name === A2UI_PARTIAL_EVENT) partial = parseMaybeJson(event.value);
      if ((event?.type === 'ACTIVITY_SNAPSHOT' || event?.type === 'ACTIVITY_DELTA') && event.activityType === A2UI_ACTIVITY_TYPE) {
        const seq = record.seq;
        addStep(seq, () => activity(event, { runId, framework: 'copilotkit', seq, seqs: [] }));
      }
    }
    if (partial !== undefined) {
      if (isObject(partial) && typeof partial.tool_call_id === 'string' && typeof partial.args_so_far === 'string') {
        const key = `${runId ?? ''}#${partial.tool_call_id}`;
        const list = partials.get(key) ?? [];
        list.push({ seq: record.seq, runId, args: partial.args_so_far });
        partials.set(key, list);
      } else {
        finding('unparsed_payload', 'An a2ui-partial event without a string tool_call_id and args_so_far', {
          seq: record.seq,
          ...(runId !== undefined ? { runId } : {}),
        });
      }
    }
  }

  // ---- CopilotKit activities ----
  interface ActivityState {
    content: unknown;
    ops: unknown[];
    surfaceKeys: Set<string>;
    placeholder?: SurfaceState;
  }
  const activities = new Map<string, ActivityState>();
  const activity = (event: AguiEvent, origin: Origin): void => {
    const messageId = typeof event.messageId === 'string' ? event.messageId : '';
    const id = `${origin.runId ?? ''}#${messageId}`;
    let state = activities.get(id);
    if (event.type === 'ACTIVITY_SNAPSHOT') {
      // AG-UI: `replace: false` creates the activity only if it does not exist yet.
      if (event.replace === false && state !== undefined) return;
      state ??= { content: undefined, ops: [], surfaceKeys: new Set() };
      state.content = event.content;
      activities.set(id, state);
    } else {
      if (state === undefined || !Array.isArray(event.patch)) return;
      const result = applyPatch(state.content, event.patch);
      if (!result.ok) {
        finding('unparsed_payload', `An a2ui-surface activity delta did not apply (${result.reason})`, {
          seq: origin.seq,
          ...(origin.runId !== undefined ? { runId: origin.runId } : {}),
        });
        return;
      }
      state.content = result.value;
    }
    const content = state.content;
    if (!isObject(content)) return;
    const ops = Array.isArray(content.a2ui_operations)
      ? content.a2ui_operations
      : Array.isArray(content.operations)
        ? content.operations
        : undefined;
    if (ops !== undefined) {
      // A cumulative snapshot repeats what was applied; only what is new applies again.
      const previous = state.ops;
      const isPrefix = previous.length <= ops.length && previous.every((op, i) => jsonEqual(op, ops[i]));
      const fresh = isPrefix ? ops.slice(previous.length) : ops;
      state.ops = [...ops];
      const touched: SurfaceState[] = [];
      for (const op of fresh) {
        const surface = applyA2ui(op, origin);
        if (surface !== undefined && !touched.includes(surface)) touched.push(surface);
      }
      for (const surface of touched) {
        state.surfaceKeys.add(surface.surface.key);
        if (surface.surface.status !== 'deleted') delete surface.surface.status;
      }
      // The painted surface replaces the lifecycle placeholder in place (same activity id).
      const placeholder = state.placeholder;
      const heir = touched[0];
      if (placeholder !== undefined && heir !== undefined) {
        surfaces.delete(placeholder.surface.key);
        heir.surface.sourceSeqs.push(...placeholder.surface.sourceSeqs);
        delete state.placeholder;
      }
      return;
    }
    const status = content.status;
    if (typeof status !== 'string' || !LIFECYCLE.has(status)) return;
    const lifecycle = status as SurfaceStatus;
    if (state.surfaceKeys.size > 0) {
      for (const key of state.surfaceKeys) {
        const surface = surfaces.get(key);
        if (surface === undefined) continue;
        touch(surface, origin);
        if (surface.surface.status !== 'deleted') surface.surface.status = lifecycle;
      }
      return;
    }
    const placeholder = surfaceFor(origin, 'a2ui', messageId);
    placeholder.surface.status = lifecycle;
    state.placeholder = placeholder;
  };

  // ---- Schedule text, tool and partial sources ----
  for (const text of texts.values()) {
    const origin: Origin = { runId: text.runId, framework: 'threadplane', seq: text.anchor, seqs: text.seqs };
    addStep(text.anchor, () => classifyText(text.value, origin, text.closed));
  }
  for (const tool of tools.values()) {
    const origin: Origin = { runId: tool.runId, framework: 'threadplane', seq: tool.anchor, seqs: tool.seqs };
    const { name, args } = tool.value;
    addStep(tool.anchor, () => {
      if (JSON_RENDER_TOOL_NAMES.includes(name)) {
        if (typeof args === 'string') specFrom(args, origin, `${name} arguments`);
        else if (isObject(args)) applySpec(isObject(args.spec) && !('elements' in args) ? args.spec : args, origin);
      } else {
        envelopeArgs(args, origin, `${name} arguments`);
      }
    });
  }
  for (const list of partials.values()) {
    let best: { seq: number; envelopes: unknown[]; truncated: boolean; runId: string | undefined } | undefined;
    const seqs: number[] = [];
    for (const partial of list) {
      const parsed = parsePartialJson(partial.args);
      if (!parsed.ok) {
        // Threadplane's bridge poisons the call here and ignores everything after it.
        finding('partial_args_invalid', 'a2ui-partial args stopped being a JSON prefix; Threadplane ignores this call from here on', {
          seq: partial.seq,
          ...(partial.runId !== undefined ? { runId: partial.runId } : {}),
        });
        break;
      }
      seqs.push(partial.seq);
      best = {
        seq: partial.seq,
        envelopes: closedEnvelopes(parsed),
        truncated: !parsed.complete && envelopeList(parsed.value) !== null,
        runId: partial.runId,
      };
    }
    if (best === undefined) continue;
    const chosen = best;
    const origin: Origin = { runId: chosen.runId, framework: 'threadplane', seq: chosen.seq, seqs };
    addStep(chosen.seq, () => {
      const created = new Set<string>();
      for (const envelope of chosen.envelopes) {
        if (!isObject(envelope)) continue;
        if (isObject(envelope.createSurface) && typeof envelope.createSurface.surfaceId === 'string') {
          created.add(envelope.createSurface.surfaceId);
        } else if (isObject(envelope.updateComponents) && typeof envelope.updateComponents.surfaceId === 'string') {
          const surfaceId = envelope.updateComponents.surfaceId;
          // The bridge's safety net: components before any createSurface get one on the basic catalog.
          if (!created.has(surfaceId) && !surfaces.has(surfaceKey(origin.runId, 'threadplane', 'a2ui', surfaceId))) {
            applyA2ui({ version: 'v0.9', createSurface: { surfaceId, catalogId: THREADPLANE_BASIC_CATALOG_ID } }, origin);
          }
          created.add(surfaceId);
        }
        applyA2ui(envelope, origin);
      }
      if (chosen.truncated) {
        finding('truncated_payload', 'The last a2ui-partial args never closed; the envelopes that had closed are applied', {
          seq: chosen.seq,
          ...(chosen.runId !== undefined ? { runId: chosen.runId } : {}),
        });
      }
    });
  }

  steps.sort((a, b) => a.seq - b.seq || a.order - b.order);
  for (const step of steps) {
    try {
      step.apply();
    } catch {
      // Defensive: a value off the wire this code did not anticipate must not take extraction down.
      finding('unparsed_payload', 'A generative-UI payload could not be read', { seq: step.seq });
    }
  }

  const out = [...surfaces.values()].map(({ surface, declaredRoot }) => {
    surface.sourceSeqs = [...new Set(surface.sourceSeqs)].sort((a, b) => a - b);
    if (surface.format === 'a2ui') {
      if (surface.a2uiVersion === 'v0.8') {
        if (declaredRoot !== undefined) surface.root = declaredRoot;
      } else if (surface.components.has('root')) {
        surface.root = 'root';
      }
    }
    return surface;
  });
  out.sort((a, b) => (a.sourceSeqs[0] ?? 0) - (b.sourceSeqs[0] ?? 0));
  // Capture order; a finding with no frame last. `sort` is stable, so ties keep the order found.
  findings.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  return { surfaces: out, findings };
}
