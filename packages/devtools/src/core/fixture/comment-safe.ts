/**
 * Captured text placed inside a generated file's comment — a block comment or a `//` line.
 *
 * Everything a capture holds is whatever the page (or, for an imported `.agui.jsonl`, whoever
 * wrote the file) put there, and none of it is validated on import. A `*\/` would end a block
 * comment and a line break would end a line comment, turning the rest of the text into code that
 * runs when the generated spec or fixture does. So both are neutralised, and a value that is not
 * even a string — an imported header's `url: 42` — is written as text rather than thrown on.
 */
export function commentSafe(text: unknown): string {
  return String(text)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\*\//g, '* /');
}
