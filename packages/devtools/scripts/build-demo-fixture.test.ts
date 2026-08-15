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

  it('carries nothing that looks like a redaction placeholder or a secret', () => {
    const text = buildDemoFixture();
    expect(text).not.toMatch(/«redacted/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text.toLowerCase()).not.toMatch(/authorization|api[_-]?key|bearer /);
  });
});
