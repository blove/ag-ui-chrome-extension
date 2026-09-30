// packages/devtools/src/core/normalizer/langgraph/messages.ts
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
 * `content` is a string, or a list of blocks: `{type:'text', text}`, OpenAI's
 * `{type:'reasoning', summary:[{text}]}`, Anthropic's `{type:'thinking', thinking}`. Anything
 * else (images, tool-use blocks) carries neither and is skipped.
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

export function toolCallChunks(value: unknown): ToolCallChunk[] {
  if (!Array.isArray(value)) return [];
  const chunks: ToolCallChunk[] = [];
  value.forEach((entry, position) => {
    if (!isObject(entry)) return;
    const id = nonEmpty(entry.id);
    const name = nonEmpty(entry.name);
    chunks.push({
      index: typeof entry.index === 'number' ? entry.index : position,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      args: typeof entry.args === 'string' ? entry.args : '',
    });
  });
  return chunks;
}
