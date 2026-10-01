import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadJsonl } from '../src/panel/import/load-jsonl';
import { toThreadplaneSpec } from '../src/core/fixture/threadplane';
import { decodeJsonl } from '../src/core/jsonl/codec';
import {
  buildDemoFixture,
  buildGenUiDemoFixture,
  buildLangGraphDemoFixture,
  LISTING_FIXTURES,
} from './build-demo-fixture';

describe('buildDemoFixture', () => {
  it('decodes without a single malformed line', () => {
    const { decodeErrors } = loadJsonl(buildDemoFixture());
    expect(decodeErrors).toEqual([]);
  });

  it('contains two runs, so the run scope bar has something to show', () => {
    const { runs } = loadJsonl(buildDemoFixture());
    expect(runs).toHaveLength(2);
  });

  it('carries exactly one protocol violation, and it is the one we meant', () => {
    const { issues } = loadJsonl(buildDemoFixture());
    expect(issues.map((i) => i.code)).toEqual(['unopened-message-id']);
  });

  it('anchors that violation to the delta that arrives before its message opens', () => {
    const { issues, records } = loadJsonl(buildDemoFixture());
    const issue = issues[0];
    expect(issue).toBeDefined();
    const record = records.find((r) => r.kind === 'event' && r.seq === issue?.seq);
    expect(record).toBeDefined();
    expect((record as { event?: { type?: string } }).event?.type).toBe('TEXT_MESSAGE_CONTENT');
  });

  it('is byte-deterministic, so the committed fixture is diffable', () => {
    expect(buildDemoFixture()).toBe(buildDemoFixture());
  });

  /*
   * The committed fixture is what `listing-assets.mts` photographs, and nothing else compares it
   * to its generator: edit `buildDemoFixture` and forget `pnpm listing:fixture`, and every gate
   * stays green while the store screenshots show the OLD capture. The icons have exactly this
   * guard (`public/icons/.source-sha256`, checked by verify-build.ts); this is the fixture's.
   */
  it('matches the committed listing/fixtures/demo.agui.jsonl', () => {
    const committed = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../listing/fixtures/demo.agui.jsonl'),
      'utf8',
    );
    expect(committed).toBe(buildDemoFixture());
  });

  // Pins run 2's seq offset to run 1's actual event count. Without this, a collision (offset
  // too low) or a gap (offset too high) would pass silently: no codec or validator rule checks
  // seq uniqueness or contiguity, and the "anchors that violation" test above resolves by
  // `records.find(r => r.seq === issue.seq)`, which under a collision would just find the wrong
  // record and still pass.
  it('numbers event seqs contiguously 1..N across both connections', () => {
    const { records } = loadJsonl(buildDemoFixture());
    const eventSeqs = records.filter((r) => r.kind === 'event').map((r) => r.seq);
    expect(eventSeqs).toEqual(Array.from({ length: eventSeqs.length }, (_, i) => i + 1));
  });

  it('carries nothing that looks like a redaction placeholder or a secret', () => {
    const text = buildDemoFixture();
    expect(text).not.toMatch(/«redacted/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text.toLowerCase()).not.toMatch(/authorization|api[_-]?key|bearer /);
  });
});

/*
 * The two 0.2.0 captures. Each is the subject of a store screenshot whose caption makes a claim,
 * and these pin the property that claim rests on, so a re-cut fixture fails here rather than in a
 * Playwright run that only says a gate refused.
 */
describe('buildLangGraphDemoFixture', () => {
  it('decodes into one clean run, with no validator issue', () => {
    const { decodeErrors, runs, issues } = loadJsonl(buildLangGraphDemoFixture());
    expect(decodeErrors).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it('names every frame with its LangGraph SSE event, which is what the shot shows', () => {
    const { lines } = decodeJsonl(buildLangGraphDemoFixture());
    const names = new Set(lines.flatMap((line) => (line.kind === 'event' ? [line.sseEvent] : [])));
    expect([...names].sort()).toEqual(['messages', 'metadata', 'updates', 'values']);
  });

  it('exports as a Threadplane test — the button shot 5 photographs enabled', () => {
    const { lines } = decodeJsonl(buildLangGraphDemoFixture());
    expect(toThreadplaneSpec(lines, { filename: 'demo.spec.ts' })).not.toBeNull();
  });
});

describe('buildGenUiDemoFixture', () => {
  it('decodes into one run with no protocol issue — its findings are catalog findings, not violations', () => {
    const { decodeErrors, runs, issues } = loadJsonl(buildGenUiDemoFixture());
    expect(decodeErrors).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it('renders one component type the advertised catalog lacks', () => {
    const text = buildGenUiDemoFixture();
    expect(text).toContain('"component":"DeliveryMap"');
    // The advertised schema (a JSON string inside the request's context) defines OrderCard and
    // not DeliveryMap, which is what makes the finding EXACT rather than inferred.
    expect(text).toContain('\\"OrderCard\\":');
    expect(text).not.toContain('\\"DeliveryMap\\":');
    expect(text).toContain('plus:\\n  - OrderCard');
  });
});

describe('LISTING_FIXTURES', () => {
  it.each(LISTING_FIXTURES.map(([file, build]) => [file, build] as const))(
    '%s matches its committed file, byte for byte, and is deterministic',
    (file, build) => {
      const committed = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../listing/fixtures', file),
        'utf8',
      );
      expect(build()).toBe(build());
      expect(committed).toBe(build());
    },
  );

  it.each(LISTING_FIXTURES.map(([file, build]) => [file, build] as const))(
    '%s carries nothing that looks like a redaction placeholder or a secret',
    (_file, build) => {
      const text = build();
      expect(text).not.toMatch(/«redacted/);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(text.toLowerCase()).not.toMatch(/authorization|api[_-]?key|bearer /);
    },
  );
});
