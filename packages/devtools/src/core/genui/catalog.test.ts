import { describe, expect, it } from 'vitest';
import {
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  BASIC_CATALOG_REQUIRED,
  COPILOTKIT_BASIC_CATALOG_ID,
  THREADPLANE_BASIC_CATALOG_ID,
  basicCatalog,
  contextCatalog,
  registryCatalog,
} from './catalog';

/** The entry CopilotKit's `A2UICatalogContext` ships: `extractCatalogComponentSchemas` output, stringified. */
function schemaEntry(value: unknown): { description: string; value: string } {
  return { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: JSON.stringify(value) };
}

describe('contextCatalog (exact, from RunAgentInput.context)', () => {
  it('reads names and required props from the allOf form CopilotKit generates', () => {
    const catalog = contextCatalog({
      threadId: 't',
      context: [
        { description: 'A2UI catalog capabilities: …', value: 'Available A2UI catalog:' },
        schemaEntry({
          catalogId: COPILOTKIT_BASIC_CATALOG_ID,
          components: {
            Text: {
              allOf: [
                { $ref: 'common_types.json#/$defs/ComponentCommon' },
                { properties: { component: { const: 'Text' } }, required: ['component', 'text'] },
              ],
            },
            // The middleware's inline-schema form (its recovery-gate tests): `required` at the top.
            HotelCard: { type: 'object', required: ['name', 'rating'] },
          },
        }),
      ],
    });
    expect(catalog).toBeDefined();
    expect(catalog?.basis).toBe('exact');
    expect(catalog?.source).toBe('copilotkit-context');
    expect(catalog?.catalogId).toBe(COPILOTKIT_BASIC_CATALOG_ID);
    expect([...(catalog?.components.keys() ?? [])]).toEqual(['Text', 'HotelCard']);
    expect(catalog?.components.get('Text')?.required).toEqual(['text']);
    expect(catalog?.components.get('HotelCard')?.required).toEqual(['name', 'rating']);
  });

  it('is undefined without the entry, or when its value is not a catalog', () => {
    expect(contextCatalog({ context: [] })).toBeUndefined();
    expect(contextCatalog(undefined)).toBeUndefined();
    expect(contextCatalog({ context: [{ description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: '{not json' }] })).toBeUndefined();
    expect(contextCatalog({ context: [{ description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: '[]' }] })).toBeUndefined();
    expect(contextCatalog({ context: 'nope' })).toBeUndefined();
  });

  it('accepts an already-parsed value', () => {
    const catalog = contextCatalog({
      context: [{ description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: { catalogId: 'x', components: { A: {} } } }],
    });
    expect(catalog?.catalogId).toBe('x');
    expect(catalog?.components.get('A')?.required).toEqual([]);
  });
});

describe('basicCatalog (inferred)', () => {
  it('is the 18 components of the A2UI v0.9 basic catalog, answering to both ids', () => {
    const catalog = basicCatalog('threadplane');
    expect(catalog.basis).toBe('inferred');
    expect(catalog.components.size).toBe(18);
    expect(Object.keys(BASIC_CATALOG_REQUIRED)).toEqual([
      'Text', 'Image', 'Icon', 'Video', 'AudioPlayer', 'Row', 'Column', 'List', 'Card', 'Tabs', 'Modal',
      'Divider', 'Button', 'TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'DateTimeInput',
    ]);
    expect(catalog.components.get('Button')?.required).toEqual(['child', 'action']);
    expect(catalog.catalogId).toBe(THREADPLANE_BASIC_CATALOG_ID);
    expect(basicCatalog('copilotkit').catalogId).toBe(COPILOTKIT_BASIC_CATALOG_ID);
    expect(catalog.ids).toEqual([THREADPLANE_BASIC_CATALOG_ID, COPILOTKIT_BASIC_CATALOG_ID]);
  });
});

describe('registryCatalog', () => {
  it('is exact names with no required props', () => {
    const catalog = registryCatalog(['stat_card', 'container']);
    expect(catalog.basis).toBe('exact');
    expect(catalog.source).toBe('registry');
    expect([...catalog.components.keys()]).toEqual(['stat_card', 'container']);
    expect(catalog.knowsRequired).toBe(false);
  });
});
