import { expect, test } from '@playwright/test';

import type { Message } from '@ag-ui/core';

import { lineFor, textOf } from './render.js';

test.describe('textOf', () => {
  test('passes a plain string through', () => {
    expect(textOf('hello')).toBe('hello');
  });

  test('joins text parts and labels non-text parts', () => {
    expect(
      textOf([
        { type: 'text', text: 'look: ' },
        { type: 'image', source: { type: 'url', value: 'http://x/y.png' } },
      ]),
    ).toBe('look: [image]');
  });

  test('renders absent content as the empty string', () => {
    expect(textOf(undefined)).toBe('');
  });
});

test.describe('lineFor', () => {
  test('renders a user message as its text', () => {
    const message: Message = { id: 'u1', role: 'user', content: 'hi' };
    expect(lineFor(message)).toBe('hi');
  });

  test('renders an assistant tool call so a run with no text is still visible', () => {
    const message: Message = {
      id: 'a1',
      role: 'assistant',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"SF"}' },
        },
      ],
    };
    expect(lineFor(message)).toBe('get_weather({"city":"SF"})');
  });

  test('renders text and tool calls together', () => {
    const message: Message = {
      id: 'a2',
      role: 'assistant',
      content: 'checking',
      toolCalls: [{ id: 'tc2', type: 'function', function: { name: 'f', arguments: '{}' } }],
    };
    expect(lineFor(message)).toBe('checking f({})');
  });
});
