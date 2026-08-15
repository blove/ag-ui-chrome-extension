import { describe, expect, it } from 'vitest';
import { loadJsonl } from '../src/panel/import/load-jsonl';
import { buildDemoFixture } from './build-demo-fixture';

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
