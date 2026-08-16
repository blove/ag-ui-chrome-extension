/**
 * `/info` agent discovery — the shape, and the one place an untrusted body becomes a typed claim.
 *
 * Pure, Chrome-free, DOM-free: the MAIN world parses with it, the relay and the service worker
 * re-validate with it, and the JSONL import path validates a header field with it. One grammar,
 * four consumers, so a shape that is rejected at one boundary cannot be accepted at another.
 *
 * WHAT THIS IS FOR (spec §13 done-when #2). The CopilotKit v2 client fetches runtime info at
 * CONNECT time, before any run: measured in `@copilotkitnext/core`'s dist, the caller sets
 * `_runtimeConnectionStatus = Connecting`, awaits `fetchRuntimeInfo()`, populates `remoteAgents`
 * and only then notifies. So the agent list is on the wire before the user has typed anything, and
 * capturing it passively — riding a request the page already made (§11) — is enough to satisfy
 * "shown in Session before any run" with zero egress of our own.
 *
 * WHAT IT IS NOT. Most AG-UI apps never call `/info` at all. Measured across three page loads of a
 * production Angular AG-UI deployment: no `/info` request, ever, because it is not a CopilotKit
 * app. That is the COMMON case, not an error case, and everything downstream of this module —
 * especially the Session tab's wording — is written for it.
 *
 * PRIVACY (§11). Agent ids, names and descriptions and a runtime version are DEVELOPER-AUTHORED
 * METADATA, not user content. None of §11's five redaction groups — text, reasoning, toolArgs,
 * toolResults, state — covers them, which is the same reasoning already applied to `tools` in
 * `redactInput` and to tool schemas elsewhere: a schema is structure the developer wrote, and
 * removing it costs the reader most of what makes a capture legible while protecting nothing the
 * user typed. So a redacted export keeps this metadata verbatim, deliberately. If a runtime ever
 * put user content in a description, that would be the runtime putting user content in its own
 * source code; nothing here can detect that, and inventing a group for it would be a claim this
 * module cannot make good on.
 */

/**
 * Which transport served the info response — requirements §4's "runtime mode".
 *
 * OBSERVED FROM THE REQUEST, not read out of the body: the body is identical either way. It rides
 * on `RuntimeInfo` rather than beside it so that persisting the metadata persists the mode with
 * it, and a re-imported capture reports the same runtime mode the live one did.
 */
export type RuntimeMode = 'multi-route' | 'single-route';

/**
 * One agent the runtime says it has.
 *
 * `id` is the KEY of the runtime's `agents` map, which is the id the client addresses. `name` and
 * `description` are the values the runtime reported, and either can legitimately be absent —
 * measured against the Dojo, every agent's `description` is the empty string. `null` means the
 * field was absent or was not a string; the empty string means the runtime authored an empty one.
 * The distinction is kept because it is the difference between "not reported" and "reported as
 * blank", and collapsing it would be the panel inventing a fact.
 */
export interface AgentInfo {
  id: string;
  name: string | null;
  description: string | null;
}

export interface RuntimeInfo {
  /** The runtime's own version string, or `null` when the response did not report one. */
  version: string | null;
  mode: RuntimeMode;
  /**
   * The agents the runtime reported, or `null` when the response carried no readable agent map.
   *
   * `null` and `[]` are different claims and must stay different: `[]` is "the runtime answered,
   * and it has no agents registered", `null` is "the runtime answered, and this build could not
   * read an agent list out of the answer". Reporting the second as the first would put a finding
   * about the runtime's configuration on screen that the response never made.
   */
  agents: AgentInfo[] | null;
}

/**
 * Own-property check that does not go through the value's own `hasOwnProperty`.
 *
 * Same reasoning as `inject/protocol.ts`: a page-built lookalike can define one, and this grammar
 * is applied to values that crossed the page boundary. Inherited properties never count.
 */
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or `null` when it is absent or is not a string. Never coerced. */
function optionalString(source: Record<string, unknown>, key: string): string | null {
  if (!hasOwn(source, key)) return null;
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The runtime's `agents` map, as measured live against the Dojo at
 * `GET /api/copilotkitnext/builtin/info`:
 *
 * ```json
 * {"a2ui_chat":{"name":"a2ui_chat","description":"","className":"BuiltInAgent"}}
 * ```
 *
 * Keyed by agent id, so the KEY is the load-bearing half — a value that is not an object still
 * proves the id exists, and is recorded with both descriptive fields `null` rather than dropped.
 * Dropping it would under-report the agent list; inventing a name for it would be repair. Unknown
 * value fields (`className` above) are read and discarded: they are not part of any claim this
 * panel makes, so they must not ride into a typed one.
 */
function parseAgents(value: unknown): AgentInfo[] | null {
  if (!isPlainRecord(value)) return null;
  const agents: AgentInfo[] = [];
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainRecord(entry)) {
      agents.push({ id, name: null, description: null });
      continue;
    }
    agents.push({
      id,
      name: optionalString(entry, 'name'),
      description: optionalString(entry, 'description'),
    });
  }
  return agents;
}

/**
 * Turn a decoded `/info` response body into a `RuntimeInfo`, or `null` when it is not one.
 *
 * `null` means "this body is not an info response this build can read" — it is not a `RuntimeInfo`
 * with everything blank, because a blank one would be rendered as a runtime that answered and had
 * nothing to say. Nothing is repaired: a non-string `version` is reported as unreported, an
 * unreadable `agents` map is reported as unread, and neither is guessed at.
 */
export function parseInfoBody(body: unknown, mode: RuntimeMode): RuntimeInfo | null {
  if (!isPlainRecord(body)) return null;
  const agents = parseAgents(hasOwn(body, 'agents') ? body['agents'] : undefined);
  const version = optionalString(body, 'version');
  // A body with neither half is not an info response — it is some other JSON that happened to come
  // back from a URL matching the route grammar. Claiming it would put an empty Runtime row on
  // screen for a request that told us nothing.
  if (agents === null && version === null) return null;
  return { version, mode, agents };
}

function isAgentInfo(value: unknown): value is AgentInfo {
  if (!isPlainRecord(value)) return false;
  if (!hasOwn(value, 'id') || typeof value['id'] !== 'string') return false;
  for (const key of ['name', 'description'] as const) {
    if (!hasOwn(value, key)) return false;
    const field = value[key];
    if (field !== null && typeof field !== 'string') return false;
  }
  return true;
}

/**
 * Shape guard for a `RuntimeInfo` that arrived from somewhere untrusted — across the page
 * boundary, off a relay port, or out of an imported `.agui.jsonl` header.
 *
 * Own-property strict, and it cannot throw: a hostile value may carry a throwing getter or a
 * `Proxy` with a hostile `has` trap, and taking down the relay's message listener is exactly what
 * this must not allow.
 */
export function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  try {
    if (!isPlainRecord(value)) return false;
    if (!hasOwn(value, 'version')) return false;
    const version = value['version'];
    if (version !== null && typeof version !== 'string') return false;
    if (!hasOwn(value, 'mode')) return false;
    if (value['mode'] !== 'multi-route' && value['mode'] !== 'single-route') return false;
    if (!hasOwn(value, 'agents')) return false;
    const agents = value['agents'];
    if (agents === null) return true;
    return Array.isArray(agents) && agents.every(isAgentInfo);
  } catch {
    return false;
  }
}

/**
 * Rebuild a `RuntimeInfo` from known fields only.
 *
 * `isRuntimeInfo` proves the required fields are present; it does not prove the value carries
 * NOTHING ELSE. The relay copies every message field by field for exactly this reason, and this is
 * that copy for the one nested structure a message carries — without it a `__proto__` key or an
 * extra payload riding on an otherwise valid info message would reach the service worker, the
 * panel, and eventually a `.agui.jsonl` file someone shares.
 */
export function cloneRuntimeInfo(info: RuntimeInfo): RuntimeInfo {
  return {
    version: info.version,
    mode: info.mode,
    agents:
      info.agents === null
        ? null
        : info.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
          })),
  };
}
