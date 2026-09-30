import { describe, expect, it } from 'vitest';

import { contentParts, roleOf, toolCallChunks } from './messages';

describe('roleOf', () => {
  it('reads both serializations of a message type', () => {
    expect(roleOf('ai')).toBe('ai');
    expect(roleOf('AIMessageChunk')).toBe('ai');
    expect(roleOf('AIMessage')).toBe('ai');
    expect(roleOf('tool')).toBe('tool');
    expect(roleOf('ToolMessageChunk')).toBe('tool');
    expect(roleOf('human')).toBe('human');
    expect(roleOf('HumanMessage')).toBe('human');
    expect(roleOf('system')).toBe('system');
  });

  it('is other for anything unrecognised', () => {
    expect(roleOf('remove')).toBe('other');
    expect(roleOf('RemoveMessage')).toBe('other');
    expect(roleOf('ChatMessage')).toBe('other');
    expect(roleOf('FunctionMessage')).toBe('other');
    expect(roleOf('generic')).toBe('other');
    expect(roleOf(undefined)).toBe('other');
    expect(roleOf(3)).toBe('other');
  });
});

describe('contentParts', () => {
  it('takes a string as text', () => {
    expect(contentParts('Hello')).toEqual({ text: 'Hello', reasoning: '' });
  });

  it('splits content blocks into text and reasoning, in order', () => {
    expect(
      contentParts([
        { type: 'reasoning', index: 0, summary: [{ index: 0, type: 'summary_text', text: 'Think' }] },
        { type: 'text', index: 1, text: 'Hel' },
        { type: 'text', index: 1, text: 'lo' },
        { type: 'thinking', thinking: 'ing' },
      ]),
    ).toEqual({ text: 'Hello', reasoning: 'Thinking' });
  });

  it('reads a standard reasoning block, and skips a summary entry without text', () => {
    expect(
      contentParts([
        { type: 'reasoning', reasoning: 'Plan' },
        { type: 'reasoning', summary: [{ type: 'summary_text' }, { type: 'summary_text', text: 'ned' }] },
      ]),
    ).toEqual({ text: '', reasoning: 'Planned' });
  });

  it('ignores blocks it does not understand, and non-content', () => {
    expect(contentParts([{ type: 'image_url', image_url: 'x' }, null, 3])).toEqual({ text: '', reasoning: '' });
    expect(contentParts([])).toEqual({ text: '', reasoning: '' });
    expect(contentParts(undefined)).toEqual({ text: '', reasoning: '' });
  });
});

describe('toolCallChunks', () => {
  it('keeps index, id, name and the args fragment', () => {
    expect(
      toolCallChunks([{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci', type: 'tool_call_chunk' }]),
    ).toEqual([{ index: 0, id: 'call_1', name: 'get_weather', args: '{"ci' }]);
  });

  it('leaves id and name absent when the chunk does not carry them', () => {
    expect(toolCallChunks([{ index: 0, args: 'ty":"SF"}', id: null, name: '' }])).toEqual([
      { index: 0, args: 'ty":"SF"}' },
    ]);
  });

  it('falls back to array position for a missing index, and to empty args', () => {
    expect(toolCallChunks([{ id: 'a' }, { id: 'b', args: 7 }])).toEqual([
      { index: 0, id: 'a', args: '' },
      { index: 1, id: 'b', args: '' },
    ]);
  });

  it('falls back to array position for an index that is not a non-negative integer', () => {
    const chunks = toolCallChunks([{ index: null }, { index: Number.NaN }, { index: -1 }, { index: 1.5 }]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
  });

  it('is empty for anything that is not a list', () => {
    expect(toolCallChunks(undefined)).toEqual([]);
    expect(toolCallChunks({ index: 0 })).toEqual([]);
  });
});
