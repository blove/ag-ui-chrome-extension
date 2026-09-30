/**
 * What counts as an SSE event name, for everything downstream of the parser (spec L1).
 *
 * LangGraph Platform puts its event type in the `event:` field, so the name has to survive
 * capture. But the three capture transports do not see it equally: `EventSource` dispatches a
 * frame with no `event:` line and a frame with `event: message` identically, to the `message`
 * listener, and cannot tell them apart. Normalizing both — and the empty name, which the SSE
 * grammar also dispatches as `message` — to "no name" is what lets `raw-invariant.test.ts` keep
 * all three transports in agreement. No protocol this extension reads uses `message` as a
 * meaningful name; LangGraph's is `messages`, plural.
 *
 * `unknown` in, so the same function guards untrusted input: a relayed frame and an imported
 * `.agui.jsonl` line.
 */
export function normalizeEventName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === '' || value === 'message') return undefined;
  return value;
}
