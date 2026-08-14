/**
 * Parse an RFC 6901 JSON Pointer into its unescaped reference tokens.
 *
 * Returns `[]` for the whole-document pointer `''`, and `null` for any string that is
 * neither `''` nor slash-prefixed. Escapes are undone in the order mandated by RFC 6901:
 * `~1` -> `/` first, then `~0` -> `~`, so that `~01` decodes to the literal `~1`.
 */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (pointer[0] !== '/') return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.split('~1').join('/').split('~0').join('~'));
}
