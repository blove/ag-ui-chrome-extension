/**
 * @vitest-environment node
 *
 * Pure formatting: no DOM needed.
 */
import { describe, expect, it } from 'vitest';

import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import { formatBytes, formatDuration, summarizeEvent } from './format';

function eventRecord(event: AguiEvent | null): CaptureRecord {
  return { kind: 'event', seq: 1, tMs: 0, connId: 'c_1', raw: null, issues: [], event };
}

function keepaliveRecord(comment: string): CaptureRecord {
  return { kind: 'keepalive', seq: 1, tMs: 0, connId: 'c_1', raw: null, issues: [], comment };
}

/**
 * True if any UTF-16 code unit is an unpaired surrogate — the thing that renders as a
 * replacement box. Checks the whole string, not just the end: a part sliced mid-pair puts one
 * in the middle of the row, where the trailing-only check would miss it.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('formatDuration', () => {
  it('renders an em dash for undefined', () => {
    expect(formatDuration(undefined)).toBe('—');
  });

  it('renders sub-second values in milliseconds', () => {
    expect(formatDuration(240)).toBe('240ms');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders seconds to two decimals', () => {
    expect(formatDuration(1840)).toBe('1.84s');
    expect(formatDuration(1000)).toBe('1.00s');
  });

  it('promotes a value that would round up past its unit', () => {
    expect(formatDuration(999.6)).toBe('1.00s');
    expect(formatDuration(59_999)).toBe('1m 0s');
  });

  it('renders a minute or more as minutes and seconds', () => {
    expect(formatDuration(83_000)).toBe('1m 23s');
    expect(formatDuration(600_000)).toBe('10m 0s');
  });

  it('renders an em dash for values that cannot be a duration', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('renders bytes below a kilobyte unscaled', () => {
    expect(formatBytes(840)).toBe('840 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('renders decimal kilobytes to one decimal', () => {
    expect(formatBytes(12_400)).toBe('12.4 kB');
  });

  it('drops a trailing .0', () => {
    expect(formatBytes(1000)).toBe('1 kB');
  });

  it('promotes to the next unit rather than rendering 1000 of the smaller one', () => {
    expect(formatBytes(999_999)).toBe('1 MB');
  });

  /*
   * The byte unit renders with `Math.round`, not `toFixed(1)`, so its promotion threshold is
   * 999.5 — not the 999.95 the loop uses one unit up. A `bytes < 1000` guard admits 999.5 and
   * then rounds it to the `1000 B` the loop exists to prevent.
   */
  it('promotes at the byte boundary too, where rounding is to whole bytes', () => {
    expect(formatBytes(999.4)).toBe('999 B');
    expect(formatBytes(999.5)).toBe('1 kB');
  });

  it('never renders 1000 of a unit at any scale', () => {
    const near = [999.4, 999.5, 999.9, 999.94, 999.95, 999.99, 999.999, 1000];
    const bad: string[] = [];
    // B through GB: `1000 TB` is the top unit overflowing, which no promotion can fix.
    for (let exponent = 0; exponent <= 3; exponent += 1) {
      for (const value of near) {
        const rendered = formatBytes(value * 1000 ** exponent);
        if (/^1000\b/.test(rendered)) bad.push(`${value * 1000 ** exponent} -> ${rendered}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('scales through megabytes and gigabytes', () => {
    expect(formatBytes(8_400_000)).toBe('8.4 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });

  it('renders zero and nonsense as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('summarizeEvent', () => {
  it('renders an id and its text payload', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello' }),
    );
    expect(summary).toBe('m_1 · "Hello"');
  });

  it('does not repeat the event type, which is its own column', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello' }),
    );
    expect(summary).not.toContain('TEXT_MESSAGE_CONTENT');
  });

  it('renders a bare name unquoted after the id', () => {
    expect(
      summarizeEvent(eventRecord({ type: 'TOOL_CALL_START', toolCallId: 'tc_1', toolCallName: 'search' })),
    ).toBe('tc_1 · search');
    expect(
      summarizeEvent(eventRecord({ type: 'TEXT_MESSAGE_START', messageId: 'm_1', role: 'assistant' })),
    ).toBe('m_1 · assistant');
  });

  it('prefers the run id over the thread id', () => {
    expect(summarizeEvent(eventRecord({ type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' }))).toBe(
      'r_1',
    );
  });

  it('collapses whitespace so a multi-line delta stays one row', () => {
    expect(
      summarizeEvent(eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'a\n  b\tc' })),
    ).toBe('m_1 · "a b c"');
  });

  it('renders a structured payload as compact JSON', () => {
    expect(
      summarizeEvent(eventRecord({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: 1 }] })),
    ).toBe('[{"op":"add","path":"/a","value":1}]');
  });

  it('summarizes a keepalive with its comment', () => {
    expect(summarizeEvent(keepaliveRecord('ping'))).toBe('keepalive · ping');
  });

  it('summarizes a bare keepalive heartbeat', () => {
    expect(summarizeEvent(keepaliveRecord(''))).toBe('keepalive');
    expect(summarizeEvent(keepaliveRecord('   '))).toBe('keepalive');
  });

  it('summarizes a record whose payload would not parse', () => {
    expect(summarizeEvent(eventRecord(null))).toBe('unparsed payload');
  });

  it('returns an empty summary for an event with no distinctive fields', () => {
    expect(summarizeEvent(eventRecord({ type: 'CUSTOM_PING' }))).toBe('');
  });

  it('never returns more than 80 characters', () => {
    const records: CaptureRecord[] = [
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'x'.repeat(5000) }),
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'y'.repeat(300), delta: 'z'.repeat(300) }),
      eventRecord({ type: 'STATE_SNAPSHOT', snapshot: { items: Array.from({ length: 200 }, (_, i) => i) } }),
      eventRecord({ type: 'TOOL_CALL_ARGS', toolCallId: 't'.repeat(120), delta: '{"q":"…"}' }),
      keepaliveRecord('k'.repeat(400)),
      eventRecord(null),
      eventRecord({ type: 'CUSTOM_PING' }),
    ];
    for (const record of records) {
      expect(summarizeEvent(record).length).toBeLessThanOrEqual(80);
    }
  });

  it('marks truncation with an ellipsis', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'x'.repeat(5000) }),
    );
    expect(summary.length).toBe(80);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.startsWith('m_1 · "xxx')).toBe(true);
  });

  it('never truncates in the middle of a surrogate pair', () => {
    const summary = summarizeEvent(
      eventRecord({ type: 'TEXT_MESSAGE_CONTENT', delta: `${'a'.repeat(77)}😀😀` }),
    );
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith('…')).toBe(true);
    const lastKept = summary.charCodeAt(summary.length - 2);
    expect(lastKept >= 0xd800 && lastKept <= 0xdbff).toBe(false);
  });

  /*
   * `truncate` repairs a split surrogate pair, but it only runs when the text is *over* the
   * cap. Each branch that pre-slices its own part to exactly 80 units lands on
   * `text.length <= max` and returns early, so the repair never sees it. Sweeping the emoji
   * across the cap is what distinguishes "the one branch we thought about" from "every branch".
   */
  it('never leaves a lone surrogate at any emoji offset, in any branch', () => {
    const payload = (n: number): string => `${'a'.repeat(n)}😀😀`;
    const shapes: Record<string, (text: string) => CaptureRecord> = {
      string: (text) => eventRecord({ type: 'TEXT_MESSAGE_CONTENT', delta: text }),
      id: (text) => eventRecord({ type: 'TEXT_MESSAGE_START', messageId: text }),
      name: (text) => eventRecord({ type: 'TOOL_CALL_START', toolCallName: text }),
      jsonArray: (text) => eventRecord({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: text }] }),
      jsonObject: (text) => eventRecord({ type: 'STATE_SNAPSHOT', snapshot: { t: text } }),
      keepalive: (text) => keepaliveRecord(text),
    };

    const broken: string[] = [];
    for (const [shape, make] of Object.entries(shapes)) {
      for (let n = 0; n <= 120; n += 1) {
        const summary = summarizeEvent(make(payload(n)));
        if (summary.length > 80) broken.push(`${shape} n=${n}: ${summary.length} chars`);
        if (hasLoneSurrogate(summary)) broken.push(`${shape} n=${n}: lone surrogate`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('survives a payload that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeEvent(eventRecord({ type: 'CUSTOM', value: circular }))).toBe('[unserializable]');
  });
});
