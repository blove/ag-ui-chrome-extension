import type { Message } from '@ag-ui/core';

/**
 * `Message['content']` is `string | InputContentPart[] | Record<string, unknown> | undefined`.
 * Anything that is not text is labelled rather than dropped: a run whose only output was an
 * image must not render as an empty line, because "nothing rendered" and "nothing arrived"
 * are the two states this page exists to tell apart.
 */
export function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    parts.push(part.type === 'text' ? part.text : `[${part.type}]`);
  }
  return parts.join('');
}

/** One plain-text line per reconstructed message, comparable by eye with the Messages tab. */
export function lineFor(message: Message): string {
  const body = textOf(message.content);
  if (message.role !== 'assistant') return body;
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) return body;
  const rendered = calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(' ');
  return body.length > 0 ? `${body} ${rendered}` : rendered;
}
