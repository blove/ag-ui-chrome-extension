/**
 * The conversation turns the APP sent, read out of a captured request body.
 *
 * Why this is in `core/` and not in a component (design decision T0): requirements §9.4 defines
 * the Messages tab as "the conversation as the client would render it: user/assistant/tool/
 * reasoning". `Run.messages` holds only what the SERVER streamed back — the run builder
 * reconstructs `TEXT_MESSAGE_*` and `REASONING_MESSAGE_*` and nothing else — so the user's own
 * prompt, and any prior turns the app replayed, exist in the model only as `Run.input`, an
 * untyped body straight off the wire. Reading it is parsing, it is testable without a DOM, and
 * a CLI or a VS Code panel would need exactly the same function, so it lives here.
 *
 * Everything is optional and nothing is repaired. The body is whatever the app POSTed; a turn
 * with no `role` is a real divergence and the tab's whole job is to show it, so such a turn is
 * kept and labelled rather than dropped.
 */

/** One turn of a `RunAgentInput.messages` array, as it arrived. */
export interface InputMessage {
  /** The app's id for the turn. Absent when the body carried none. */
  id: string | undefined;
  /** `user`, `assistant`, `system`, `tool` — or {@link UNKNOWN_ROLE} when the body had none. */
  role: string;
  /**
   * The turn's content, untouched.
   *
   * `unknown`, not `string`: multi-part content (`[{type:'text'},{type:'image'}]`) is real, and
   * an assistant turn replaying only `toolCalls` has no `content` key at all. `undefined` means
   * the key was absent, which is a different fact from an empty string.
   */
  content: unknown;
}

/** Stands in for a `role` the body did not carry. Never inferred from anything else. */
export const UNKNOWN_ROLE = 'unknown';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read `input.messages`. Returns `[]` for any body that does not carry one — an absent request
 * line, a non-AG-UI body, a `messages` that is not an array.
 */
export function inputMessages(input: unknown): InputMessage[] {
  if (!isPlainObject(input) || !Array.isArray(input.messages)) return [];

  const out: InputMessage[] = [];
  for (const entry of input.messages) {
    if (!isPlainObject(entry)) continue;
    out.push({
      id: typeof entry.id === 'string' ? entry.id : undefined,
      role: typeof entry.role === 'string' ? entry.role : UNKNOWN_ROLE,
      content: entry.content,
    });
  }
  return out;
}
