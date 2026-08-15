# Recorded fixtures (Tier B)

Real traffic, recorded from a live agent, redacted before it landed here.

These are **not** part of the CI corpus. CI replays Tier A — the hand-written scenarios in
`../` — and never needs a key (design decision H8). What lives here exists to answer a question
Tier A cannot: *are our assumptions about AG-UI actually right?*

## Provenance

| | |
|---|---|
| `happy-real.json` | AG-UI Dojo, `builtin` integration → `BuiltInAgent` (`openai/gpt-5-mini`), 2026-08-15 |

Recorded with:

```bash
pnpm --filter ag-ui-harness record -- --name happy-real --prompt "In one short sentence, what is the AG-UI protocol?"
```

That needs the Dojo running on `:3000` with `OPENAI_API_KEY` in its environment, taken from this
repo's gitignored root `.env`:

```bash
set -a && . /path/to/ag-ui-chrome-extension/.env && set +a && cd ~/repos/ag-ui/apps/dojo && pnpm dev
```

## What redaction leaves behind

Every payload string is replaced with `«redacted: N chars»`. Structure survives on purpose —
event `type`, message and run ids, roles, ordering, and the *length* of what was removed. That is
what makes a recording useful as a fixture while carrying none of the content (requirements §11,
decision H7).

`match.message` is the authored prompt in plaintext. That is deliberate: it is text we wrote, and
keying the fixture on the recorded `match` would preserve whatever the last user message happened
to be. See `toCommittableFixture` in `../../record.ts`.

The recorder refuses to write a file at all if any payload string survives redaction, and the raw
recording is deleted in a `finally` so it never outlives the process.

## What the first recording changed

It found a real privacy defect on its first run, which is precisely why Tier B exists.

`RUN_STARTED` carries an optional `input` field (`@ag-ui/core`'s `RunStartedEventSchema`) that
echoes the entire `RunAgentInput` back over the wire — the user's messages, the app's state, its
forwarded props. All three hand-written golden fixtures omit it, so the whole suite agreed that
lifecycle events carry nothing worth protecting. A real deployment sends it on every run, and
`redact.ts` published it verbatim.

Fixed in `redact.ts`, along with a second hole in the same function: the captured request body was
gated wholesale on the `state` group, so a user who selected `text` — the group that means "my
prompts" — still exported their own messages in the clear. Group ownership is now per field.
