/**
 * Reading LangChain messages as LangGraph Platform serializes them.
 *
 * The JS server writes `type: 'ai'`; the Python server writes `type: 'AIMessageChunk'` inside
 * `messages` tuples. The LangGraph SDK normalizes the second to the first; so does this.
 */
export type MessageRole = 'ai' | 'tool' | 'human' | 'system' | 'other';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The role a message `type` names, from either serialization. Only the four roles the expander
 * translates are recognised; every other LangChain type — `ChatMessage` / `generic`,
 * `FunctionMessage` / `function`, `RemoveMessage` / `remove` — is `other`, deliberately.
 */
export function roleOf(type: unknown): MessageRole {
  if (typeof type !== 'string') return 'other';
  let role = type;
  if (role.endsWith('MessageChunk')) role = role.slice(0, -'MessageChunk'.length).toLowerCase();
  else if (role.endsWith('Message')) role = role.slice(0, -'Message'.length).toLowerCase();
  return role === 'ai' || role === 'tool' || role === 'human' || role === 'system' ? role : 'other';
}

export interface ContentParts {
  readonly text: string;
  readonly reasoning: string;
}

/**
 * The text and the reasoning a message's `content` carries.
 *
 * `content` is a string, or a list of blocks:
 * - `{type:'text', text}` — text;
 * - `{type:'reasoning', summary:[{text}]}` — OpenAI Responses; a summary entry without a string
 *   `text` contributes nothing;
 * - `{type:'reasoning', reasoning}` — LangChain's standard reasoning block;
 * - `{type:'thinking', thinking}` — Anthropic.
 *
 * Anything else (images, tool-use blocks, Anthropic `redacted_thinking`) carries neither and is
 * skipped.
 */
export function contentParts(content: unknown): ContentParts {
  if (typeof content === 'string') return { text: content, reasoning: '' };
  let text = '';
  let reasoning = '';
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'reasoning') {
        if (Array.isArray(block.summary)) {
          for (const part of block.summary) {
            if (isObject(part) && typeof part.text === 'string') reasoning += part.text;
          }
        }
        if (typeof block.reasoning === 'string') reasoning += block.reasoning;
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        reasoning += block.thinking;
      }
    }
  }
  return { text, reasoning };
}

export interface ToolCallChunk {
  /** Chunks of one tool call share an `index`; its `args` fragments concatenate in order. */
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly args: string;
}

/**
 * The `tool_call_chunks` of one message chunk.
 *
 * A chunk without a usable `index` (absent, `null`, or not a non-negative integer) falls back to
 * its position in this list. That is right for the common one-call-per-chunk stream, but the
 * position is local to this chunk: two parallel calls that both omit `index` each land on 0, so a
 * consumer merging across chunks must also split on a change of `id`.
 */
export function toolCallChunks(value: unknown): ToolCallChunk[] {
  if (!Array.isArray(value)) return [];
  const chunks: ToolCallChunk[] = [];
  value.forEach((entry, position) => {
    if (!isObject(entry)) return;
    const id = nonEmpty(entry.id);
    const name = nonEmpty(entry.name);
    const index = entry.index;
    chunks.push({
      index: typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : position,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      args: typeof entry.args === 'string' ? entry.args : '',
    });
  });
  return chunks;
}
