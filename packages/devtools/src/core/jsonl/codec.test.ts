import { describe, it, expect } from 'vitest';
import {
  decodeJsonl,
  encodeJsonl,
  type JsonlEvent,
  type JsonlHeader,
  type JsonlKeepalive,
  type JsonlLine,
  type JsonlRequest,
} from './codec';

const header: JsonlHeader = {
  kind: 'header',
  schemaVersion: 1,
  tool: 'ag-ui-devtools@0.1.0',
  capturedAt: '2026-08-13T10:00:00.000Z',
  url: 'http://localhost:3000/',
  framework: 'react/copilotkit',
  transport: 'sse',
  redacted: ['text', 'toolArgs'],
};

const request: JsonlRequest = {
  kind: 'request',
  connId: 'c1',
  tMs: 0,
  method: 'POST',
  url: '/api/copilotkit/agent/default/run',
  input: { threadId: 't_1', messages: [{ id: 'm_user_1', role: 'user', content: 'hi' }] },
};

const event: JsonlEvent = {
  kind: 'event',
  connId: 'c1',
  seq: 1,
  tMs: 12,
  event: { type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' },
};

const keepalive: JsonlKeepalive = {
  kind: 'keepalive',
  connId: 'c1',
  seq: 2,
  tMs: 15_012,
  comment: 'ping',
};

/** A bare `:` SSE heartbeat — a comment frame with no body. */
const bareKeepalive: JsonlKeepalive = {
  kind: 'keepalive',
  connId: 'c1',
  seq: 3,
  tMs: 30_020,
  comment: '',
};

describe('encodeJsonl', () => {
  it('emits one JSON object per line with a trailing newline', () => {
    const text = encodeJsonl([header, request, event]);

    expect(text.endsWith('\n')).toBe(true);
    const physical = text.split('\n');
    expect(physical).toHaveLength(4);
    expect(physical[3]).toBe('');
    // `!` after the length assertion above: `noUncheckedIndexedAccess` types these as
    // `string | undefined`, and `JSON.parse` takes a `string`.
    expect(JSON.parse(physical[0]!)).toEqual(header);
    expect(JSON.parse(physical[1]!)).toEqual(request);
    expect(JSON.parse(physical[2]!)).toEqual(event);
  });

  it('encodes an empty list as the empty string', () => {
    expect(encodeJsonl([])).toBe('');
  });

  it('emits keepalive lines, empty comment included', () => {
    const text = encodeJsonl([keepalive, bareKeepalive]);

    const physical = text.split('\n').filter((l) => l !== '');
    expect(physical).toHaveLength(2);
    expect(physical.map((l) => JSON.parse(l))).toEqual([keepalive, bareKeepalive]);
    // `comment: ''` is falsy but must still be written: a bare `:` heartbeat has to stay
    // distinguishable from a keepalive whose comment field went missing.
    expect(text).toContain('"comment":""');
  });
});

describe('decodeJsonl', () => {
  it('round-trips a header, a request and an event', () => {
    const lines: JsonlLine[] = [header, request, event];

    const decoded = decodeJsonl(encodeJsonl(lines));

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual(lines);
  });

  it('round-trips a keepalive inside a mixed stream', () => {
    const finished: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 4,
      tMs: 40,
      event: { type: 'RUN_FINISHED', threadId: 't_1', runId: 'r_1' },
    };
    const lines: JsonlLine[] = [header, request, event, keepalive, finished];

    const decoded = decodeJsonl(encodeJsonl(lines));

    // `keepalive` is a known kind: it must not be collected as an `unrecognized kind`
    // error and dropped, which is what would silently lose the frames §5.4 requires.
    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual(lines);
  });

  it('round-trips a bare `:` heartbeat, keeping the empty comment and the seq', () => {
    const decoded = decodeJsonl(encodeJsonl([bareKeepalive]));

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([bareKeepalive]);

    const [only] = decoded.lines;
    if (only?.kind !== 'keepalive') throw new Error('expected a keepalive line');
    expect(only.comment).toBe('');
    // `keepalive-gap` anchors to the seq of the keepalive that closed the gap, so an
    // imported capture has to carry it.
    expect(only.seq).toBe(3);
  });

  it('survives a payload containing a newline inside a string', () => {
    const multiline: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 2,
      tMs: 20,
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm_1',
        delta: 'line one\nline two\r\nline three',
      },
    };

    const text = encodeJsonl([multiline]);

    // The physical file is still exactly one record line: the newline is escaped, not literal.
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(text).toContain('line one\\nline two\\r\\nline three');

    const decoded = decodeJsonl(text);
    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([multiline]);
    expect((decoded.lines[0] as JsonlEvent).event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: 'line one\nline two\r\nline three',
    });
  });

  it('skips blank and whitespace-only lines', () => {
    const text = ['', JSON.stringify(header), '', '   ', JSON.stringify(event), ''].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([header, event]);
  });

  it('decodes identically with and without a trailing newline', () => {
    const body = [JSON.stringify(header), JSON.stringify(event)].join('\n');

    const withNewline = decodeJsonl(`${body}\n`);
    const withoutNewline = decodeJsonl(body);

    expect(withNewline.lines).toEqual(withoutNewline.lines);
    expect(withNewline.errors).toEqual([]);
    expect(withoutNewline.errors).toEqual([]);
  });

  it('handles CRLF line terminators', () => {
    const text = `${JSON.stringify(header)}\r\n${JSON.stringify(event)}\r\n`;

    const decoded = decodeJsonl(text);

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([header, event]);
  });

  it('collects an error for a malformed JSON line and continues', () => {
    const text = [JSON.stringify(header), '{"kind":"event",', JSON.stringify(event)].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.lines).toEqual([header, event]);
    expect(decoded.errors).toHaveLength(1);
    expect(decoded.errors[0]).toContain('line 2');
    expect(decoded.errors[0]).toContain('invalid JSON');
  });

  it('collects an error for a valid JSON line with an unrecognized kind and continues', () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify({ kind: 'summary', total: 3 }),
      JSON.stringify({ seq: 9 }),
      JSON.stringify(event),
    ].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.lines).toEqual([header, event]);
    expect(decoded.errors).toHaveLength(2);
    expect(decoded.errors[0]).toContain('line 2');
    expect(decoded.errors[0]).toContain('unrecognized kind');
    expect(decoded.errors[0]).toContain('"summary"');
    expect(decoded.errors[1]).toContain('line 3');
    expect(decoded.errors[1]).toContain('unrecognized kind');
  });

  it('collects an error for a JSON line that is not an object', () => {
    const text = ['42', '[1,2,3]', 'null', JSON.stringify(event)].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.lines).toEqual([event]);
    expect(decoded.errors).toHaveLength(3);
    expect(decoded.errors[0]).toContain('line 1');
    expect(decoded.errors[0]).toContain('not a JSONL record object');
    expect(decoded.errors[1]).toContain('line 2');
    expect(decoded.errors[2]).toContain('line 3');
  });

  it('returns empty results for empty input', () => {
    expect(decodeJsonl('')).toEqual({ lines: [], errors: [] });
    expect(decodeJsonl('\n\n')).toEqual({ lines: [], errors: [] });
  });
});
