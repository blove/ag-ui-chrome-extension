import { describe, expect, it } from 'vitest';

import { isKnownMode, parseEventName } from './names';

describe('parseEventName', () => {
  it('splits a subgraph namespace off the mode', () => {
    expect(parseEventName('messages|research:9f1c|tools:ab')).toEqual({
      mode: 'messages',
      namespace: ['research:9f1c', 'tools:ab'],
    });
  });

  it('leaves a top-level name whole, slashes included', () => {
    expect(parseEventName('messages/partial')).toEqual({ mode: 'messages/partial', namespace: [] });
    expect(parseEventName('values')).toEqual({ mode: 'values', namespace: [] });
  });

  it('treats a missing name as the empty mode', () => {
    expect(parseEventName(undefined)).toEqual({ mode: '', namespace: [] });
  });
});

describe('isKnownMode', () => {
  it('knows every mode LangGraph Platform emits', () => {
    for (const mode of [
      'metadata', 'values', 'updates', 'messages', 'messages/partial', 'messages/complete',
      'messages/metadata', 'custom', 'error', 'debug', 'tasks', 'checkpoints', 'events', 'tools',
      'feedback',
    ]) {
      expect(isKnownMode(mode)).toBe(true);
    }
  });

  it('does not know anything else', () => {
    expect(isKnownMode('')).toBe(false);
    expect(isKnownMode('end')).toBe(false);
    expect(isKnownMode('RUN_STARTED')).toBe(false);
  });
});
