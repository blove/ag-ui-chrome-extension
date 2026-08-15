import { describe, expect, it } from 'vitest';
import type { CaptureRecord } from '../core/model/types';
import type { RequestLine } from './protocol';
import { createRingBuffer } from './ring-buffer';

function eventRecord(seq: number, content = 'x'): CaptureRecord {
  const event = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: content };
  return { kind: 'event', seq, tMs: seq, connId: 'c1', raw: event, event, issues: [] };
}

function keepalive(seq: number): CaptureRecord {
  return {
    kind: 'keepalive',
    seq,
    tMs: seq,
    connId: 'c1',
    raw: ':ping\n\n',
    comment: 'ping',
    issues: [],
  };
}

function requestLine(connId: string): RequestLine {
  return { connId, tMs: 0, method: 'POST', url: '/agent', input: { threadId: 't1' } };
}

function seqs(records: CaptureRecord[]): number[] {
  return records.map((record) => record.seq);
}

describe('createRingBuffer', () => {
  it('starts empty with nothing dropped', () => {
    const buffer = createRingBuffer();
    expect(buffer.records()).toEqual([]);
    expect(buffer.requests()).toEqual([]);
    expect(buffer.droppedBefore()).toBe(0);
    expect(buffer.bytes()).toBe(0);
  });

  it('keeps records in push order below the caps', () => {
    const buffer = createRingBuffer();
    buffer.push(eventRecord(1));
    buffer.push(keepalive(2));
    buffer.push(eventRecord(3));
    expect(seqs(buffer.records())).toEqual([1, 2, 3]);
    expect(buffer.droppedBefore()).toBe(0);
  });

  it('evicts oldest-first and counts every eviction once the record cap is passed', () => {
    const buffer = createRingBuffer({ maxRecords: 3 });
    for (let seq = 1; seq <= 10; seq += 1) buffer.push(eventRecord(seq));
    expect(seqs(buffer.records())).toEqual([8, 9, 10]);
    expect(buffer.droppedBefore()).toBe(7);
  });

  it('keeps evicting correctly past the compaction threshold', () => {
    const buffer = createRingBuffer({ maxRecords: 5 });
    for (let seq = 1; seq <= 500; seq += 1) buffer.push(eventRecord(seq));
    expect(seqs(buffer.records())).toEqual([496, 497, 498, 499, 500]);
    expect(buffer.droppedBefore()).toBe(495);
  });

  it('evicts on the byte cap and keeps bytes() in step with what is retained', () => {
    // Two-digit seqs only, so every record serializes to the same length and the cap is exact.
    const probe = createRingBuffer();
    probe.push(eventRecord(10));
    const perRecord = probe.bytes();

    const buffer = createRingBuffer({ maxBytes: perRecord * 3 });
    for (let seq = 10; seq <= 29; seq += 1) buffer.push(eventRecord(seq));

    expect(buffer.records().length).toBe(3);
    expect(seqs(buffer.records())).toEqual([27, 28, 29]);
    expect(buffer.bytes()).toBe(perRecord * 3);
    expect(buffer.droppedBefore()).toBe(17);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // `raw` only — an unparseable frame — so the payload is serialized exactly once.
    const unparsed = (text: string): CaptureRecord => ({
      kind: 'event',
      seq: 1,
      tMs: 1,
      connId: 'c1',
      raw: text,
      event: null,
      issues: [],
    });
    const ascii = createRingBuffer();
    ascii.push(unparsed('aaa'));
    const cjk = createRingBuffer();
    cjk.push(unparsed('日本語'));

    // Same String.length, 3x the bytes on the wire. A code-unit count would report these equal
    // and the buffer would hold ~3x its configured memory.
    expect('aaa'.length).toBe('日本語'.length);
    expect(cjk.bytes()).toBe(ascii.bytes() + 6);
  });

  it('retains the newest record even when it alone exceeds the byte cap', () => {
    const buffer = createRingBuffer({ maxBytes: 10 });
    buffer.push(eventRecord(1));
    buffer.push(eventRecord(2));
    expect(seqs(buffer.records())).toEqual([2]);
    expect(buffer.droppedBefore()).toBe(1);
    expect(buffer.bytes()).toBeGreaterThan(10);
  });

  it('holds request lines separately and counts their bytes', () => {
    const buffer = createRingBuffer();
    buffer.addRequest(requestLine('c1'));
    buffer.addRequest(requestLine('c2'));
    expect(buffer.requests().map((request) => request.connId)).toEqual(['c1', 'c2']);
    expect(buffer.bytes()).toBeGreaterThan(0);
    expect(buffer.droppedBefore()).toBe(0);
  });

  it('does not count request eviction as a dropped record', () => {
    const buffer = createRingBuffer({ maxRecords: 2 });
    buffer.addRequest(requestLine('c1'));
    buffer.addRequest(requestLine('c2'));
    buffer.addRequest(requestLine('c3'));
    expect(buffer.requests().map((request) => request.connId)).toEqual(['c2', 'c3']);
    expect(buffer.droppedBefore()).toBe(0);
  });

  it('returns a copy, so a caller cannot mutate the buffer through it', () => {
    const buffer = createRingBuffer();
    buffer.push(eventRecord(1));
    const taken = buffer.records();
    taken.push(eventRecord(2));
    expect(buffer.records().length).toBe(1);
  });

  it('clear() empties everything and resets the dropped count', () => {
    const buffer = createRingBuffer({ maxRecords: 2 });
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(eventRecord(seq));
    buffer.addRequest(requestLine('c1'));
    expect(buffer.droppedBefore()).toBe(3);

    buffer.clear();

    expect(buffer.records()).toEqual([]);
    expect(buffer.requests()).toEqual([]);
    expect(buffer.bytes()).toBe(0);
    // A cleared buffer has dropped nothing before its own start; leaving the count set would
    // leave P9's truncation marker on screen forever.
    expect(buffer.droppedBefore()).toBe(0);
  });
});
