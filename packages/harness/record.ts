/**
 * Tier B recording — put a recorder in front of a real AG-UI agent and keep what it says.
 *
 * Design §7: this is the highest-value part of the harness, because it is the only thing that
 * can tell us the hand-written Tier A fixtures are wrong. It is also the only part that ever
 * sees real model output, which is why H7 makes redaction mandatory rather than advisory:
 * nothing recorded here reaches `fixtures/` without passing through
 * `packages/devtools/src/core/jsonl/redact.ts` first.
 *
 * H8: the key never enters CI. This file is run by hand, occasionally, and CI only replays what
 * it committed.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AGUIMock } from '@copilotkit/aimock';

import type { JsonlEvent } from '@devtools/core/jsonl/codec';
import { ALL_REDACTION_GROUPS, redactLine } from '@devtools/core/jsonl/redact';

/* ------------------------------------------------------------------ shapes */

/** What aimock writes: `{ fixtures: [{ match, events, delayMs? }] }`. */
export interface RecordedMatch {
  message?: string;
  toolCallId?: string;
  toolName?: string;
  stateKey?: string;
}

export interface RecordedFixture {
  match: RecordedMatch;
  events: unknown[];
  delayMs?: number;
}

export interface RecordedFixtureFile {
  fixtures: RecordedFixture[];
}

/* -------------------------------------------------------------- redaction */

/**
 * Run one recorded event through `redactLine`.
 *
 * The event is wrapped as a `JsonlEvent` because that is the unit `redact.ts` operates on — it
 * redacts a capture line, not a bare event. The wrapper's `seq`/`tMs`/`connId` are structure,
 * never written anywhere, and `redactLine` returns them untouched.
 */
function redactEvent(event: unknown): unknown {
  const line: JsonlEvent = { kind: 'event', connId: 'rec', seq: 0, tMs: 0, event };
  const redacted = redactLine(line, [...ALL_REDACTION_GROUPS]);
  return redacted.kind === 'event' ? redacted.event : event;
}

/** Every recorded event, redacted. All five groups — a recording gets no exemptions. */
export function redactRecordedEvents(events: readonly unknown[]): unknown[] {
  return events.map((event) => redactEvent(event));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every string leaf under `value`, however deeply nested. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
}

/**
 * The payload strings one event carries, by event type.
 *
 * This deliberately RESTATES requirements §11's five groups rather than importing anything from
 * `redact.ts`. A check that shares its subject's definition of the answer verifies nothing; this
 * one fails if `redact.ts` ever stops covering a field it covers today — which matters more here
 * than anywhere, because `redact.ts` has no other production consumer to notice.
 */
function payloadStrings(event: unknown): string[] {
  if (!isObject(event)) return [];
  const out: string[] = [];
  const type = typeof event.type === 'string' ? event.type : '';
  switch (type) {
    case 'TEXT_MESSAGE_CONTENT':
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CONTENT':
    case 'REASONING_MESSAGE_CHUNK':
    case 'TOOL_CALL_ARGS':
    case 'TOOL_CALL_CHUNK':
      stringLeaves(event.delta, out);
      break;
    case 'TOOL_CALL_RESULT':
      stringLeaves(event.content, out);
      break;
    case 'REASONING_ENCRYPTED_VALUE':
      stringLeaves(event.encryptedValue, out);
      break;
    case 'STATE_SNAPSHOT':
      stringLeaves(event.snapshot, out);
      break;
    case 'STATE_DELTA':
      if (Array.isArray(event.delta)) {
        for (const op of event.delta) if (isObject(op)) stringLeaves(op.value, out);
      }
      break;
    default:
      break;
  }
  // Two characters cannot identify anyone, and a stream is full of them — `delta: "I"` would
  // match half the file's structure and fail every recording for nothing. The length of a short
  // delta survives redaction by design anyway.
  return out.filter((text) => text.trim().length >= 3);
}

/**
 * Payload strings from `raw` that still appear verbatim in `redacted`. Empty means clean.
 *
 * This is the gate `main` refuses to write past. A recording that trips it is a redaction bug,
 * not a bad recording, and the right response is to fix `redact.ts` rather than to commit.
 */
export function leakedValues(raw: readonly unknown[], redacted: readonly unknown[]): string[] {
  /*
   * The haystack is every string LEAF of the redacted events, not `JSON.stringify` of them.
   *
   * Serializing first looked equivalent and was not: a payload containing a quote — which is
   * every `TOOL_CALL_ARGS` delta, since those carry JSON — comes back with its quotes
   * backslash-escaped, so a substring search for the original text missed it. That is the
   * failure this gate exists to catch, and it would have passed silently. Comparing leaf
   * against leaf has no encoding step to disagree about.
   */
  const survivors: string[] = [];
  stringLeaves(redacted, survivors);
  const leaks = new Set<string>();
  for (const event of raw) {
    for (const text of payloadStrings(event)) {
      // `includes` rather than equality: a partial leak — the payload embedded in a larger
      // string — is still a leak.
      if (survivors.some((survivor) => survivor.includes(text))) leaks.add(text);
    }
  }
  return [...leaks];
}

/* ---------------------------------------------------------------- parsing */

export function parseRecordedFile(text: string): RecordedFixtureFile {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed) || !Array.isArray(parsed.fixtures)) {
    throw new Error('Recorded file has no `fixtures` array — aimock did not write a fixture.');
  }
  const fixtures = parsed.fixtures.map((entry, index) => {
    if (!isObject(entry) || !Array.isArray(entry.events)) {
      throw new Error(`Recorded fixture ${String(index)} has no \`events\` array.`);
    }
    return {
      match: isObject(entry.match) ? (entry.match as RecordedMatch) : {},
      events: entry.events,
    };
  });
  return { fixtures };
}

/**
 * Turn a recorded fixture into a committable one.
 *
 * The `match` is replaced with the prompt this run actually sent rather than kept from the
 * recording. Two reasons: it is authored text we already have, so nothing about the match is a
 * guess; and aimock keys `match.message` on the last user message, which on a recording from a
 * shared machine is the one field most likely to carry something personal.
 */
export function toCommittableFixture(fixture: RecordedFixture, prompt: string): RecordedFixture {
  return { match: { message: prompt }, events: redactRecordedEvents(fixture.events) };
}

/* -------------------------------------------------------------- recording */

export interface RecordOptions {
  /** The real AG-UI endpoint to sit in front of. */
  upstream: string;
  /** The user message to send. Authored, never taken from anything personal. */
  prompt: string;
  /** Where the redacted fixture is written. */
  outFile: string;
}

export interface RecordResult {
  outFile: string;
  eventCount: number;
  eventTypes: string[];
}

/**
 * Record one run and write the redacted fixture.
 *
 * The raw recording lands in a temp directory that is removed in a `finally`, so unredacted
 * model output never survives the process even if the redaction gate throws.
 */
export async function recordOnce(options: RecordOptions): Promise<RecordResult> {
  const rawDir = await mkdtemp(join(tmpdir(), 'agui-record-'));
  const mock = new AGUIMock({ port: 0 });
  mock.enableRecording({ upstream: options.upstream, fixturePath: rawDir });
  const url = await mock.start();

  try {
    const threadId = `t_${randomUUID().slice(0, 8)}`;
    const runId = `r_${randomUUID().slice(0, 8)}`;
    // The request shape measured on a real deployment (verified fact 5): POST, JSON body,
    // `Accept: text/event-stream`.
    const response = await fetch(new URL('/', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId,
        runId,
        messages: [{ id: 'u1', role: 'user', content: options.prompt }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Upstream returned ${String(response.status)}. Is ${options.upstream} running, and does it have a model key?`,
      );
    }
    // Drain: the fixture is written when the upstream stream ends, so the read has to finish
    // before the temp directory is inspected.
    await response.text();

    const written = (await readdir(rawDir)).filter((name) => name.endsWith('.json')).sort();
    const newest = written.at(-1);
    if (newest === undefined) {
      throw new Error(
        'Nothing was recorded. aimock only records a run it did not already have a fixture for.',
      );
    }

    const parsed = parseRecordedFile(await readFile(join(rawDir, newest), 'utf-8'));
    const recorded = parsed.fixtures[0];
    if (recorded === undefined) throw new Error('Recorded file held an empty `fixtures` array.');

    const committable = toCommittableFixture(recorded, options.prompt);

    // H7, enforced rather than trusted.
    const leaks = leakedValues(recorded.events, committable.events);
    if (leaks.length > 0) {
      throw new Error(
        `Redaction gate failed: ${String(leaks.length)} payload string(s) survived redact.ts. ` +
          'Nothing was written. Fix packages/devtools/src/core/jsonl/redact.ts before recording again.',
      );
    }

    await mkdir(dirname(options.outFile), { recursive: true });
    await writeFile(
      options.outFile,
      `${JSON.stringify({ fixtures: [committable] }, null, 2)}\n`,
      'utf-8',
    );

    const eventTypes = [
      ...new Set(
        committable.events.map((event) =>
          isObject(event) && typeof event.type === 'string' ? event.type : 'unknown',
        ),
      ),
    ];
    return { outFile: options.outFile, eventCount: committable.events.length, eventTypes };
  } finally {
    await mock.stop();
    // The unredacted recording does not outlive the process. Requirements §11.
    await rm(rawDir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------- CLI */

/**
 * The AG-UI Dojo's endpoint for an integration with no backend of its own.
 *
 * Derived, not guessed. `@copilotkitnext/runtime` mounts `POST /agent/:agentId/run`, the Dojo
 * mounts that app at `/api/copilotkitnext/<integrationId>`, and its route falls back to
 * `BuiltInAgent({ model: 'openai/gpt-5-mini' })` registered as `default` for an integrationId it
 * does not recognise. So this path needs `OPENAI_API_KEY` and nothing else — no Python backend,
 * no Mastra store, no second process.
 */
const DOJO_UPSTREAM = 'http://localhost:3000/api/copilotkitnext/builtin/agent/default/run';

const USAGE = `Usage: pnpm --filter ag-ui-harness record -- [options]

  --upstream <url>   AG-UI endpoint to record from
                     (default: ${DOJO_UPSTREAM})
  --prompt <text>    the user message to send
  --name <slug>      fixture name, written to fixtures/recorded/<slug>.json

Start the Dojo first, with the key from this repo's .env:

  set -a && . /path/to/ag-ui-chrome-extension/.env && set +a
  cd ~/repos/ag-ui/apps/dojo && npm run dev
`;

function arg(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  // Node reads `.env` itself; there is no dotenv dependency and no key in any committed file.
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
  } catch {
    // Absent `.env` is not fatal here — the key belongs to the upstream's process, not this one.
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in — the Dojo needs it,\n' +
        'and CI never does (design decision H8).\n',
    );
    console.error(USAGE);
    return 1;
  }

  const name = arg(argv, '--name') ?? 'recorded-run';
  const prompt = arg(argv, '--prompt') ?? 'In one short sentence, what is the AG-UI protocol?';
  const upstream = arg(argv, '--upstream') ?? DOJO_UPSTREAM;
  const outFile = new URL(`fixtures/recorded/${name}.json`, import.meta.url).pathname;

  const result = await recordOnce({ upstream, prompt, outFile });
  console.log(`Recorded ${String(result.eventCount)} events from ${upstream}`);
  console.log(`Event types: ${result.eventTypes.join(', ')}`);
  console.log(`Redacted fixture written to ${result.outFile}`);
  console.log('Review it before committing — redaction preserves structure, not content.');
  return 0;
}

// `process.argv[1]` is this file only when it was executed directly, so importing the module
// from a test never starts a server.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
