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
import { redactionNote } from '../../core/fixture/redaction-note';
import { dialectsOfLines } from '../../core/normalizer/dialect';

function headerOf(lines: readonly JsonlLine[]): JsonlHeader | null {
  const first = lines[0];
  return first !== undefined && first.kind === 'header' ? first : null;
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
  const dialects = dialectsOfLines(lines);
  const eventLines = lines.flatMap((line) => (line.kind === 'event' ? [line] : []));
  const events = eventLines.filter((line) => dialects.get(line.connId) !== 'langgraph').map((line) => line.event);
  /*
   * L18: a LangGraph frame's type is its SSE event name, not a field of its payload, so a bare
   * payload array is not replayable by anything. These are written as the named frames they were.
   * §14.2 grows this into a `MockAgentTransport` module; this is the minimum that stays true.
   */
  const langGraphFrames = eventLines
    .filter((line) => dialects.get(line.connId) === 'langgraph')
    .map((line) => ({ event: line.sseEvent ?? 'message', data: line.event }));
  const langGraphBlock =
    langGraphFrames.length === 0
      ? ''
      : `
/** LangGraph Platform frames: \`event\` is the SSE event name, \`data\` its payload. */
export type LangGraphFrame = { event: string; data: unknown };

export const langGraphEvents: LangGraphFrame[] = ${JSON.stringify(langGraphFrames, null, 2)};
`;
  const langGraphNote =
    langGraphFrames.length === 0
      ? ''
      : ' *\n * LangGraph frames are exported as named frames (`langGraphEvents`); §14.2 will generate a\n * `MockAgentTransport` replay for them.\n';
  const defaultExport = events.length === 0 && langGraphFrames.length > 0 ? 'langGraphEvents' : 'events';

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
${langGraphNote} */

/** The loose event shape this capture holds. An unknown \`type\` is data, not an error. */
export type AguiEvent = { type: string; [key: string]: unknown };

export const events: AguiEvent[] = ${JSON.stringify(events, null, 2)} as AguiEvent[];
${langGraphBlock}
export default ${defaultExport};
`;
}
