/**
 * The component catalog a generative-UI surface is checked against (design U2).
 *
 * EXACT when the wire says it: CopilotKit's renderer ships the app's catalog in
 * `RunAgentInput.context`, as the entry described by `A2UI_SCHEMA_CONTEXT_DESCRIPTION` whose value is
 * `JSON.stringify({ catalogId, components: { Name: { allOf: [...] } } })`
 * (`@copilotkit/a2ui-renderer` `extractCatalogComponentSchemas`; the middleware reads the same entry).
 * A Threadplane render report's registry (part A2) is exact too, names only.
 *
 * INFERRED otherwise: the A2UI v0.9 basic catalog, which both frameworks register by default. It is
 * a guess about the app — an app is free to register more — so every finding made against it says
 * so. Threadplane's registry is never on the wire.
 *
 * Pure and Chrome-free.
 */
import type { Run } from '../model/types';
import type { GenuiFramework, GenuiRequest, GenuiSurface } from './extract';

/** Threadplane's id for the basic catalog (`@threadplane/a2ui` `A2UI_BASIC_CATALOG_ID`). */
export const THREADPLANE_BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
/** CopilotKit's id for the same catalog (`a2ui-renderer` `BASIC_CATALOG_ID`, the middleware's default). */
export const COPILOTKIT_BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';
export const BASIC_CATALOG_IDS: readonly string[] = [THREADPLANE_BASIC_CATALOG_ID, COPILOTKIT_BASIC_CATALOG_ID];

/**
 * The context-entry description CopilotKit's renderer and `@ag-ui/a2ui-middleware` (v0.0.10) both
 * match by exact equality. Byte-identical to theirs, em dash included.
 */
export const A2UI_SCHEMA_CONTEXT_DESCRIPTION =
  'A2UI Component Schema — available components for generating UI surfaces. Use these component names and properties when creating A2UI operations.';

/**
 * The A2UI v0.9 basic catalog: each component and the props its schema requires, in catalog order.
 * Derived from Threadplane's `libs/a2ui/schemas/basic-catalog.json` (`components.<Name>.allOf[].required`,
 * less `component`, which every component carries).
 */
export const BASIC_CATALOG_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  Text: ['text'],
  Image: ['url'],
  Icon: ['name'],
  Video: ['url'],
  AudioPlayer: ['url'],
  Row: ['children'],
  Column: ['children'],
  List: ['children'],
  Card: ['child'],
  Tabs: ['tabs'],
  Modal: ['trigger', 'content'],
  Divider: [],
  Button: ['child', 'action'],
  TextField: ['label'],
  CheckBox: ['label', 'value'],
  ChoicePicker: ['options', 'value'],
  Slider: ['value', 'max'],
  DateTimeInput: ['value'],
};

export type CatalogBasis = 'exact' | 'inferred';

export interface CatalogComponent {
  /** Props the schema requires, besides `id` and `component`. */
  readonly required: readonly string[];
}

export interface GenuiCatalog {
  readonly basis: CatalogBasis;
  readonly source: 'copilotkit-context' | 'a2ui-basic' | 'registry';
  /** The id this catalog is advertised under, when it has one. */
  readonly catalogId?: string;
  /** Every id a surface may name and still mean this catalog. */
  readonly ids: readonly string[];
  readonly components: ReadonlyMap<string, CatalogComponent>;
  /** False when the source names components without their schemas (a registry). */
  readonly knowsRequired: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The inferred basic catalog, advertised under `framework`'s own id for it. */
export function basicCatalog(framework: GenuiFramework): GenuiCatalog {
  return {
    basis: 'inferred',
    source: 'a2ui-basic',
    catalogId: framework === 'copilotkit' ? COPILOTKIT_BASIC_CATALOG_ID : THREADPLANE_BASIC_CATALOG_ID,
    ids: BASIC_CATALOG_IDS,
    components: new Map(Object.entries(BASIC_CATALOG_REQUIRED).map(([name, required]) => [name, { required }])),
    knowsRequired: true,
  };
}

/** An exact catalog of names only — what a renderer reports it has registered. */
export function registryCatalog(names: readonly string[]): GenuiCatalog {
  return {
    basis: 'exact',
    source: 'registry',
    ids: [],
    components: new Map(names.map((name) => [name, { required: [] }])),
    knowsRequired: false,
  };
}

/** `required` at the schema's top level and in each inline `allOf` member, without `component`/`id`. */
function requiredOf(schema: unknown): string[] {
  if (!isObject(schema)) return [];
  const names: string[] = [];
  const take = (part: unknown): void => {
    if (!isObject(part) || !Array.isArray(part.required)) return;
    for (const name of part.required) {
      if (typeof name === 'string' && name !== 'component' && name !== 'id' && !names.includes(name)) names.push(name);
    }
  };
  take(schema);
  if (Array.isArray(schema.allOf)) schema.allOf.forEach(take);
  return names;
}

/**
 * The app's catalog from a request's `RunAgentInput`, or `undefined` when the request does not
 * carry the A2UI schema entry, or carries one that is not a `{ catalogId?, components }` object.
 * Never throws: the input is whatever the page sent.
 */
export function contextCatalog(input: unknown): GenuiCatalog | undefined {
  try {
    if (!isObject(input) || !Array.isArray(input.context)) return undefined;
    const entry: unknown = input.context.find(
      (candidate: unknown) => isObject(candidate) && candidate.description === A2UI_SCHEMA_CONTEXT_DESCRIPTION,
    );
    if (!isObject(entry)) return undefined;
    let value: unknown = entry.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    }
    if (!isObject(value) || !isObject(value.components)) return undefined;
    const catalogId = typeof value.catalogId === 'string' && value.catalogId !== '' ? value.catalogId : undefined;
    const components = new Map<string, CatalogComponent>();
    for (const [name, schema] of Object.entries(value.components)) components.set(name, { required: requiredOf(schema) });
    return {
      basis: 'exact',
      source: 'copilotkit-context',
      ...(catalogId !== undefined ? { catalogId } : {}),
      ids: catalogId !== undefined ? [catalogId] : [],
      components,
      knowsRequired: true,
    };
  } catch {
    return undefined;
  }
}

export interface CatalogContext {
  readonly runs: readonly Run[];
  readonly requests: readonly GenuiRequest[];
  /**
   * The component names a Threadplane renderer reported it has registered (part A2's render
   * report), when there is one: an exact catalog for that app's surfaces.
   */
  readonly registry?: readonly string[];
}

/**
 * The catalog `surface` is checked against, or `undefined` when nothing on the wire says which
 * catalog it renders with.
 *
 * - A Threadplane surface with a reported registry: that registry (exact, names only).
 * - A CopilotKit surface whose run's request carried the schema context entry: that (exact).
 * - An A2UI v0.9 surface naming no catalog or a basic one: the basic catalog (inferred). A surface
 *   naming some other catalog is rendered with one we cannot see, so it gets none.
 * - json-render, A2UI v0.8, and a lifecycle-only placeholder: none.
 */
export function catalogForSurface(surface: GenuiSurface, context: CatalogContext): GenuiCatalog | undefined {
  if (surface.framework === 'threadplane' && context.registry !== undefined) return registryCatalog(context.registry);
  if (surface.format !== 'a2ui') return undefined;
  if (surface.framework === 'copilotkit' && surface.runId !== undefined) {
    const run = context.runs.find((candidate) => candidate.runId === surface.runId);
    const request = run === undefined ? undefined : context.requests.find((candidate) => candidate.connId === run.connId);
    const exact = request === undefined ? undefined : contextCatalog(request.input);
    if (exact !== undefined) return exact;
  }
  if (surface.a2uiVersion !== 'v0.9') return undefined;
  if (surface.catalogId !== undefined && !BASIC_CATALOG_IDS.includes(surface.catalogId)) return undefined;
  return basicCatalog(surface.framework);
}
