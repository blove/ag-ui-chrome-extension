/**
 * Tolerant parsing of a JSON prefix — tool-call arguments still streaming, or cut off by the end
 * of a capture (design U1: "partial tool args parsed tolerantly — last complete parse wins").
 *
 * Threadplane's `partial-args-bridge.ts` does this with `@cacheplane/partial-json`; core/ takes no
 * dependency, so this is a small scanner with the same verdicts that matter here: a text that is
 * no JSON prefix at all is rejected (the bridge "poisons" that tool call), and anything else is
 * closed at its last complete value. `cutDepth` says how many containers were still open at that
 * cut, which is how a caller tells an array element that closed on the wire from one the cut
 * closed for it.
 */
export type PartialJson =
  | { ok: true; value: unknown; complete: boolean; cutDepth: number }
  | { ok: false };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export function parsePartialJson(text: string): PartialJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown, complete: true, cutDepth: 0 };
  } catch {
    // Not complete JSON — scan it as a prefix below.
  }
  const len = text.length;
  const stack: Array<'}' | ']'> = [];
  let state: 'value' | 'key' | 'colon' | 'after' = 'value';
  /** The container was opened by the previous token, so its closer is allowed here. */
  let justOpened = false;
  let i = 0;
  let cut = -1;
  /*
   * Only the cut's offset is recorded. Every push and pop of `stack` is followed at once by
   * `mark()`, so the stack at the last mark IS the stack when the scan stops, and its closers are
   * built once, below. (Snapshotting the stack per mark was quadratic in the nesting depth — a
   * hostile `[[[[…` partial cost seconds per frame.)
   */
  const mark = (): void => {
    cut = i;
  };
  /** Scans a string from its opening quote. False when the text ends inside it. */
  const scanString = (): boolean => {
    i += 1;
    while (i < len) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      if (c === '"') return true;
    }
    return false;
  };

  scan: while (i < len) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    const opened = justOpened;
    justOpened = false;
    switch (state) {
      case 'value': {
        if (c === '{' || c === '[') {
          i += 1;
          stack.push(c === '{' ? '}' : ']');
          state = c === '{' ? 'key' : 'value';
          justOpened = true;
          mark();
        } else if (c === ']' && opened && stack.at(-1) === ']') {
          i += 1;
          stack.pop();
          state = 'after';
          mark();
        } else if (c === '"') {
          if (!scanString()) break scan;
          state = 'after';
          mark();
        } else if (c === 't' || c === 'f' || c === 'n') {
          const literal = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
          const seen = text.slice(i, i + literal.length);
          if (!literal.startsWith(seen)) return { ok: false };
          if (seen.length < literal.length) break scan;
          i += literal.length;
          state = 'after';
          mark();
        } else if (c === '-' || (c >= '0' && c <= '9')) {
          NUMBER.lastIndex = i;
          const match = NUMBER.exec(text);
          if (match === null) {
            if (c === '-' && i + 1 === len) break scan;
            return { ok: false };
          }
          i += match[0].length;
          // A number the text ends on may be cut mid-digit: not a complete value yet.
          if (i >= len) break scan;
          state = 'after';
          mark();
        } else {
          return { ok: false };
        }
        break;
      }
      case 'key': {
        if (c === '"') {
          if (!scanString()) break scan;
          state = 'colon';
        } else if (c === '}' && opened) {
          i += 1;
          stack.pop();
          state = 'after';
          mark();
        } else {
          return { ok: false };
        }
        break;
      }
      case 'colon': {
        if (c !== ':') return { ok: false };
        i += 1;
        state = 'value';
        break;
      }
      case 'after': {
        const top = stack.at(-1);
        if (top === undefined) return { ok: false };
        if (c === ',') {
          i += 1;
          state = top === '}' ? 'key' : 'value';
        } else if (c === top) {
          i += 1;
          stack.pop();
          state = 'after';
          mark();
        } else {
          return { ok: false };
        }
        break;
      }
    }
  }

  if (cut < 0) return { ok: true, value: undefined, complete: false, cutDepth: 0 };
  const cutDepth = stack.length;
  let cutClosers = '';
  for (let index = stack.length - 1; index >= 0; index -= 1) cutClosers += stack[index] as string;
  try {
    return { ok: true, value: JSON.parse(text.slice(0, cut) + cutClosers) as unknown, complete: false, cutDepth };
  } catch {
    return { ok: false };
  }
}
