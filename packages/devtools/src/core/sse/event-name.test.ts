import { describe, expect, it } from 'vitest';

import { normalizeEventName } from './event-name';

describe('normalizeEventName', () => {
  it('keeps a real event name verbatim', () => {
    expect(normalizeEventName('values')).toBe('values');
    expect(normalizeEventName('messages|research:9f1c')).toBe('messages|research:9f1c');
    expect(normalizeEventName('messages/partial')).toBe('messages/partial');
  });

  it('treats the SSE default "message" as no name, because EventSource cannot tell them apart', () => {
    expect(normalizeEventName('message')).toBeUndefined();
  });

  it('treats an empty name as no name', () => {
    expect(normalizeEventName('')).toBeUndefined();
  });

  it('is case-sensitive, as the SSE grammar is', () => {
    expect(normalizeEventName('Message')).toBe('Message');
  });

  it('rejects anything that is not a string', () => {
    for (const value of [undefined, null, 0, 1, true, {}, [], ['values']]) {
      expect(normalizeEventName(value)).toBeUndefined();
    }
  });
});
