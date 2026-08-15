import { describe, it, expect } from 'vitest';
import { inputMessages } from './input-messages';

describe('inputMessages', () => {
  it('reads the turns a RunAgentInput body carries, in order', () => {
    const input = {
      threadId: 't_1',
      runId: 'r_1',
      messages: [
        { id: 'm_sys', role: 'system', content: 'You are helpful.' },
        { id: 'm_user_1', role: 'user', content: 'What is the weather in Paris?' },
      ],
    };

    expect(inputMessages(input)).toEqual([
      { id: 'm_sys', role: 'system', content: 'You are helpful.' },
      { id: 'm_user_1', role: 'user', content: 'What is the weather in Paris?' },
    ]);
  });

  it('keeps a non-string content as it arrived rather than stringifying it', () => {
    // Multi-part content is real (`[{type:'text',…},{type:'image',…}]`), and a renderer that
    // received `"[object Object]"` could not tell it from an agent that genuinely sent that.
    const content = [{ type: 'text', text: 'hi' }];
    const result = inputMessages({ messages: [{ id: 'm_1', role: 'user', content }] });

    expect(result[0]?.content).toEqual(content);
  });

  it('reports a message with no content at all as undefined, not as an empty string', () => {
    // An assistant turn replaying only `toolCalls` has no `content` key. Substituting `''`
    // would render as an empty bubble, which reads as "the model said nothing" — a different
    // claim from "this turn carried no content field".
    const result = inputMessages({ messages: [{ id: 'm_1', role: 'assistant' }] });

    expect(result).toEqual([{ id: 'm_1', role: 'assistant', content: undefined }]);
  });

  it('keeps a turn whose role is missing, labelling the role as unknown', () => {
    // The body is off the wire, so a missing `role` is a real possibility and is exactly the
    // kind of divergence this panel exists to show. Dropping the turn would hide it.
    const result = inputMessages({ messages: [{ id: 'm_1', content: 'orphan' }] });

    expect(result).toEqual([{ id: 'm_1', role: 'unknown', content: 'orphan' }]);
  });

  it('keeps a turn with no id', () => {
    const result = inputMessages({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result).toEqual([{ id: undefined, role: 'user', content: 'hi' }]);
  });

  it('returns nothing for a body that carries no messages array', () => {
    expect(inputMessages(undefined)).toEqual([]);
    expect(inputMessages(null)).toEqual([]);
    expect(inputMessages('not an object')).toEqual([]);
    expect(inputMessages({ threadId: 't_1' })).toEqual([]);
    expect(inputMessages({ messages: 'not an array' })).toEqual([]);
  });

  it('skips array entries that are not objects', () => {
    const result = inputMessages({ messages: ['bare string', null, { role: 'user', content: 'hi' }] });

    expect(result).toEqual([{ id: undefined, role: 'user', content: 'hi' }]);
  });

  it('carries a redacted placeholder through unchanged', () => {
    // A redacted capture replaces the value and keeps the shape (§11). The reader must see the
    // placeholder, because a turn rendered blank is indistinguishable from a turn never sent.
    const result = inputMessages({
      messages: [{ id: 'm_1', role: 'user', content: '«redacted: 29 chars»' }],
    });

    expect(result[0]?.content).toBe('«redacted: 29 chars»');
  });
});
