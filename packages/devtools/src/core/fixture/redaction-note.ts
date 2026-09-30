import type { JsonlHeader } from '../jsonl/codec';

/**
 * What was redacted, in words — the sentence every generated file (the E7 fixture, the
 * Threadplane spec) carries at the top, so both say it the same way (T5).
 *
 * A fixture is read far from the panel that produced it, by someone who did not choose the
 * redaction. Debugging against `«redacted: 412 chars»` while believing it is the model's real
 * output is a specific and costly way to waste an afternoon, so the file says so at the top.
 */
export function redactionNote(header: JsonlHeader | null): string {
  const groups = header?.redacted ?? [];
  return groups.length === 0
    ? 'Captured verbatim — nothing was redacted.'
    : `PARTIALLY REDACTED (requirements §11 groups redacted: ${groups.join(', ')}). Payload values ` +
        'below are `«redacted: N chars»` placeholders: sizes and structure are real, contents are not.';
}
