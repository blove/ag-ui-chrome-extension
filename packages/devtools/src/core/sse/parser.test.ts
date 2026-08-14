import { describe, it, expect } from 'vitest';
import { createSseParser } from './parser';

describe('createSseParser — basic framing', () => {
  it('emits a single complete frame delivered in one push', () => {
    const parser = createSseParser();
    const frames = parser.push('data: {"type":"RUN_STARTED"}\n\n');
    expect(frames).toEqual([{ kind: 'event', data: '{"type":"RUN_STARTED"}' }]);
  });

  it('does not emit before the blank line arrives', () => {
    const parser = createSseParser();
    expect(parser.push('data: hello\n')).toEqual([]);
  });

  it('joins multiple data lines with a newline', () => {
    const parser = createSseParser();
    const frames = parser.push('data: line one\ndata: line two\ndata: line three\n\n');
    expect(frames).toEqual([{ kind: 'event', data: 'line one\nline two\nline three' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    const parser = createSseParser();
    expect(parser.push('data:no-space\n\n')).toEqual([{ kind: 'event', data: 'no-space' }]);
    expect(parser.push('data: one-space\n\n')).toEqual([{ kind: 'event', data: 'one-space' }]);
    expect(parser.push('data:  two-spaces\n\n')).toEqual([
      { kind: 'event', data: ' two-spaces' },
    ]);
  });

  it('treats a field line with no colon as an empty value', () => {
    const parser = createSseParser();
    expect(parser.push('data\n\n')).toEqual([{ kind: 'event', data: '' }]);
  });

  it('populates eventName, id and retry', () => {
    const parser = createSseParser();
    const frames = parser.push('event: message\nid: 42\nretry: 1500\ndata: hi\n\n');
    expect(frames).toEqual([
      { kind: 'event', data: 'hi', eventName: 'message', id: '42', retry: 1500 },
    ]);
  });

  it('ignores a retry value that is not a number rather than producing NaN', () => {
    const parser = createSseParser();
    const frames = parser.push('retry: soon\ndata: hi\n\n');
    expect(frames).toEqual([{ kind: 'event', data: 'hi' }]);
    expect(frames[0]).not.toHaveProperty('retry');
  });

  it('ignores unknown fields', () => {
    const parser = createSseParser();
    expect(parser.push('bogus: nope\ndata: hi\n\n')).toEqual([{ kind: 'event', data: 'hi' }]);
  });

  it('emits multiple frames from a single push', () => {
    const parser = createSseParser();
    const frames = parser.push('data: a\n\ndata: b\n\ndata: c\n\n');
    expect(frames).toEqual([
      { kind: 'event', data: 'a' },
      { kind: 'event', data: 'b' },
      { kind: 'event', data: 'c' },
    ]);
  });

  it('does not emit a frame that has no data lines, and resets its fields', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\nid: 7\n\n')).toEqual([]);
    expect(parser.push('data: after\n\n')).toEqual([{ kind: 'event', data: 'after' }]);
  });

  it('does not emit anything for a run of blank lines', () => {
    const parser = createSseParser();
    expect(parser.push('\n\n\n')).toEqual([]);
  });
});

describe('createSseParser — chunk boundaries', () => {
  it('reassembles a frame split mid-line across two pushes', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"ty')).toEqual([]);
    expect(parser.push('pe":"X"}\n\n')).toEqual([{ kind: 'event', data: '{"type":"X"}' }]);
  });

  it('reassembles a frame split exactly at the blank-line boundary', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"RUN_FINISHED"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ kind: 'event', data: '{"type":"RUN_FINISHED"}' }]);
  });

  it('reassembles a frame split one character at a time', () => {
    const parser = createSseParser();
    const wire = 'data: abc\n\n';
    const frames: unknown[] = [];
    for (const ch of wire) frames.push(...parser.push(ch));
    expect(frames).toEqual([{ kind: 'event', data: 'abc' }]);
  });

  it('handles CRLF line endings', () => {
    const parser = createSseParser();
    const frames = parser.push('event: message\r\ndata: hi\r\n\r\n');
    expect(frames).toEqual([{ kind: 'event', data: 'hi', eventName: 'message' }]);
  });

  it('handles a CRLF pair split across two pushes', () => {
    const parser = createSseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('\ndata: y\r\n\r\n')).toEqual([{ kind: 'event', data: 'x\ny' }]);
  });

  it('handles lone CR line endings', () => {
    const parser = createSseParser();
    const frames = parser.push('data: a\r\rdata: b\r\r');
    // The final CR is held back: it may still turn out to be the CR of a CRLF pair.
    expect(frames).toEqual([{ kind: 'event', data: 'a' }]);
    expect(parser.push('data: c\r\r')).toEqual([{ kind: 'event', data: 'b' }]);
  });

  it('does not split on a CR that is followed by more content', () => {
    const parser = createSseParser();
    expect(parser.push('data: one\rdata: two\r\rtail')).toEqual([
      { kind: 'event', data: 'one\ntwo' },
    ]);
  });

  it('mixes CRLF and LF terminators in one stream', () => {
    const parser = createSseParser();
    const frames = parser.push('data: a\r\n\ndata: b\n\r\n');
    expect(frames).toEqual([
      { kind: 'event', data: 'a' },
      { kind: 'event', data: 'b' },
    ]);
  });
});
