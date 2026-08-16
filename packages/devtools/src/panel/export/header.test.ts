import { describe, expect, test } from 'vitest';
import type { JsonlHeader } from '../../core/jsonl/codec';
import { buildHeader, unionRedacted } from './header';

const IMPORTED: JsonlHeader = {
  kind: 'header',
  schemaVersion: 1,
  tool: 'ag-ui-devtools@0.0.9',
  capturedAt: '2026-08-01T09:00:00.000Z',
  url: 'https://agent.example.com/chat',
  framework: 'react/copilotkit',
  transport: 'sse',
  redacted: ['text', 'state'],
};

describe('unionRedacted', () => {
  test('E3: re-exporting an already-redacted capture keeps the groups it arrived with', () => {
    expect(unionRedacted(['text', 'state'], ['toolArgs'])).toEqual(['text', 'toolArgs', 'state']);
  });

  test('reports each group once, however many times it is claimed', () => {
    expect(unionRedacted(['text'], ['text', 'text'])).toEqual(['text']);
  });

  test('orders groups canonically, so two equal headers compare equal as text', () => {
    expect(unionRedacted(['state', 'toolResults'], ['reasoning', 'text'])).toEqual([
      'text',
      'reasoning',
      'toolResults',
      'state',
    ]);
  });

  test('keeps a group the running build does not know about rather than dropping it', () => {
    // A file written by a later version can name a group this build has never heard of.
    // Dropping it would under-report redaction, which is exactly what E3 forbids.
    const future = ['text', 'attachments'] as JsonlHeader['redacted'];
    expect(unionRedacted(future, [])).toEqual(['text', 'attachments']);
  });
});

describe('buildHeader', () => {
  test('E3: unions the imported header’s groups with the ones applied now', () => {
    const header = buildHeader({
      previous: IMPORTED,
      groups: ['toolArgs'],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect(header.redacted).toEqual(['text', 'toolArgs', 'state']);
  });

  test('E3: an unredacted re-export still reports what the original file redacted', () => {
    const header = buildHeader({
      previous: IMPORTED,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    // You cannot un-redact. A header reading `[]` over content whose text was already replaced
    // upstream is a lie a colleague would act on.
    expect(header.redacted).toEqual(['text', 'state']);
  });

  test('keeps the moment and the origin the capture was taken at, not the moment of re-export', () => {
    const header = buildHeader({
      previous: IMPORTED,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect(header.capturedAt).toBe('2026-08-01T09:00:00.000Z');
    expect(header.url).toBe('https://agent.example.com/chat');
    expect(header.framework).toBe('react/copilotkit');
  });

  test('stamps the exporting build, because this file was written by this build', () => {
    const header = buildHeader({
      previous: IMPORTED,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect(header.tool).toBe('ag-ui-devtools@0.1.0');
    expect(header.schemaVersion).toBe(1);
  });

  test('a live capture is stamped with the export moment and the inspected origin', () => {
    const header = buildHeader({
      previous: null,
      groups: ['text'],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: 'http://localhost:3000',
      framework: 'Angular 21.1.6',
      transport: 'sse',
      runtime: null,
    });
    expect(header).toEqual({
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@0.1.0',
      capturedAt: '2026-08-15T12:00:00.000Z',
      url: 'http://localhost:3000',
      framework: 'Angular 21.1.6',
      transport: 'sse',
      redacted: ['text'],
    });
  });

  test('omits framework entirely when none was identified, rather than claiming one', () => {
    const header = buildHeader({
      previous: null,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: 'http://localhost:3000',
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect('framework' in header).toBe(false);
  });

  test('records an unknown origin as such instead of inventing one', () => {
    const header = buildHeader({
      previous: null,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect(header.url).toBe('unknown');
  });

  test('labels a binary transport, because that capture holds no decoded events', () => {
    const header = buildHeader({
      previous: null,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: 'http://localhost:3000',
      framework: null,
      transport: 'binary',
      runtime: null,
    });
    expect(header.transport).toBe('binary');
  });
});

/**
 * `/info` agent metadata in the header.
 *
 * It lives here rather than in a new line kind, and the reason is what an OLDER decoder does with
 * each: `decodeJsonl` rejects an unknown `kind` and records an error for it, so a new kind would
 * make a perfectly intact capture written by this build open in an older build reporting itself as
 * damaged. An unknown object key is ignored by every JSON decoder ever written.
 */
describe('buildHeader — runtime metadata', () => {
  const RUNTIME = {
    version: '1.52.1-next.1',
    mode: 'multi-route' as const,
    agents: [{ id: 'default', name: 'default', description: '' }],
  };

  test('writes what this capture saw', () => {
    const header = buildHeader({
      previous: null,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: 'http://localhost:3000',
      framework: null,
      transport: 'sse',
      runtime: RUNTIME,
    });
    expect(header.runtime).toEqual(RUNTIME);
  });

  test('omits the key entirely when the capture saw no /info response', () => {
    // Absent rather than `null`: a `null` would decode as a claim that discovery ran and
    // reported nothing, which is a different and false statement about the user's app.
    const header = buildHeader({
      previous: null,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: 'http://localhost:3000',
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect('runtime' in header).toBe(false);
  });

  test('preserves the imported capture’s runtime rather than this panel’s', () => {
    // Same rule as `capturedAt`, `url` and `framework`: it describes the CAPTURE. Re-stamping it
    // would say the shared file's stream came from a runtime it never touched.
    const header = buildHeader({
      previous: { ...IMPORTED, runtime: RUNTIME },
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: { version: '9.9.9', mode: 'single-route', agents: [] },
    });
    expect(header.runtime).toEqual(RUNTIME);
  });

  test('copies rather than aliases the header it came from', () => {
    const previous = { ...IMPORTED, runtime: RUNTIME };
    const header = buildHeader({
      previous,
      groups: [],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
      url: null,
      framework: null,
      transport: 'sse',
      runtime: null,
    });
    expect(header.runtime).not.toBe(previous.runtime);
    expect(header.runtime).toEqual(RUNTIME);
  });
});
