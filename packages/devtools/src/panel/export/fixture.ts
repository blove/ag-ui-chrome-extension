/**
 * E7 — fixture export: a `.ts` module holding the event array plus an `@ag-ui/client` scaffold.
 *
 * Requirements §10 asks for exactly that and no more. §14.2 grows it into a `MockAgentTransport`
 * variant, which is the high-value version and the whole record-to-test loop — but that seam does
 * not exist yet, and writing the elaborate version now would be guessing at it. So this stays
 * minimal on purpose.
 *
 * Pure: `JsonlLine[]` in, TypeScript text out. The lines are the ones `build.ts` already produced,
 * so a redacted export produces a redacted fixture with no second policy path.
 */
import type { JsonlHeader, JsonlLine } from '../../core/jsonl/codec';

function headerOf(lines: readonly JsonlLine[]): JsonlHeader | null {
  const first = lines[0];
  return first !== undefined && first.kind === 'header' ? first : null;
}

/**
 * What was redacted, in words.
 *
 * A fixture is read far from the panel that produced it, by someone who did not choose the
 * redaction. Debugging against `«redacted: 412 chars»` while believing it is the model's real
 * output is a specific and costly way to waste an afternoon, so the file says so at the top.
 */
function redactionNote(header: JsonlHeader | null): string {
  const groups = header?.redacted ?? [];
  return groups.length === 0
    ? 'Captured verbatim — nothing was redacted.'
    : `PARTIALLY REDACTED (requirements §11 groups redacted: ${groups.join(', ')}). Payload values ` +
        'below are `«redacted: N chars»` placeholders: sizes and structure are real, contents are not.';
}

/**
 * Turn an export bundle into a TypeScript fixture module.
 *
 * `filename` is stamped into the header comment so a fixture sitting in someone else's repo can
 * be traced back to the capture it came from.
 */
export function toFixtureModule(lines: readonly JsonlLine[], filename: string): string {
  const header = headerOf(lines);
  /*
   * Only `event` lines. A header is metadata, a request line is the POST that opened the stream,
   * and a keepalive is a proxy heartbeat — none of the three is a protocol event, and a replay
   * that fed them to a client would be testing something no client ever sees. An event whose
   * payload never parsed is kept as whatever it was: dropping it would make the fixture's length
   * disagree with the capture it was taken from, which is the one thing a replay counts on.
   */
  const events = lines.flatMap((line) => (line.kind === 'event' ? [line.event] : []));

  return `/**
 * AG-UI protocol capture, exported as a test fixture by AG-UI DevTools.
 *
 * Source: ${filename}
 * Origin: ${header?.url ?? 'unknown'}
 * Captured: ${header?.capturedAt ?? 'unknown'}
 *
 * ${redactionNote(header)}
 *
 * Replay it against a client under test:
 *
 *   import { AbstractAgent } from '@ag-ui/client';
 *   import { events } from './${filename.replace(/\.ts$/, '')}';
 *
 *   class ReplayAgent extends AbstractAgent {
 *     protected run() {
 *       return new Observable((subscriber) => {
 *         for (const event of events) subscriber.next(event as never);
 *         subscriber.complete();
 *       });
 *     }
 *   }
 */

/** The loose event shape this capture holds. An unknown \`type\` is data, not an error. */
export type AguiEvent = { type: string; [key: string]: unknown };

export const events: AguiEvent[] = ${JSON.stringify(events, null, 2)} as AguiEvent[];

export default events;
`;
}
