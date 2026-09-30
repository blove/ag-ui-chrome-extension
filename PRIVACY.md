# Privacy Policy — AG-UI DevTools

**Effective 30 September 2026.** Applies to the AG-UI DevTools Chrome extension and this repository.

## The short version

**AG-UI DevTools sends nothing anywhere.** It has no server, no analytics, no telemetry, no crash
reporting, and no update pings. It cannot send data off your machine, because it holds no permission
to reach any remote origin and contains no code that makes a network request.

Everything below is a description of code you can read, and most of it is asserted by an automated
check that fails the build. Where that is true, the check is named.

## What the extension can see

AG-UI DevTools is a debugger. On a page where **you have explicitly enabled it**, it observes the
AG-UI event streams that page is already receiving — the same `fetch`, `XMLHttpRequest`, and
`EventSource` responses the application itself reads. That necessarily includes the content of those
streams: prompts, completions, tool calls, tool results, and agent state.

That data is shown to you, in your own DevTools panel, on your own machine.

## What it does with what it sees

| | |
|---|---|
| **Transmitted** | Nothing. Ever. |
| **Stored** | In memory, plus a `chrome.storage.session` mirror that Chrome erases when the browser closes. |
| **Written to disk** | Only when you click Export, to a file you choose. |
| **Shared with the developer** | Nothing. We receive no data of any kind from your use of this extension. |
| **Sold or disclosed to third parties** | Nothing, because we have nothing. |

## What it deliberately never reads

- **Request and response headers**, with exactly one exception: `content-type`, which is how a
  stream is identified as server-sent events at all. `Authorization` headers are never read, never
  stored, never exported. Neither are cookies. The internal record type for a captured request has
  no field for headers, so there is nowhere for them to go.
- **Any origin you have not enabled.** The extension ships inert. Only `localhost`, `127.0.0.1`, and
  `0.0.0.0` are registered up front. Every other site requires an explicit click and a page reload,
  granted one origin at a time.
- **Browsing history, bookmarks, saved credentials, or autofill data.** The extension requests no
  permission that would allow it to read any of these.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Remembers which origins you enabled and your panel preferences. Captured events live in `chrome.storage.session`, cleared by Chrome on browser close. |
| `scripting` | Registers the capture scripts at runtime on origins you grant. Required *because* the extension ships with no standing access to any site. |
| `optional_host_permissions` | Requested one origin at a time, only when you click to enable capture there. Never granted at install. |

The extension requests **no** `debugger` permission, **no** `webRequest`, and **no** static
`host_permissions`. `pnpm verify:build` fails the build if any of those appear in the built
manifest, and if any remote host permission is declared statically.

## Export and redaction

Export is the only way data leaves the extension, and you initiate it.

**Redaction is opt-in, and off by default.** This is the one thing on this page most worth reading
carefully, because it is the one place where assuming the safer behaviour would be wrong.

The export panel offers five categories — message text, reasoning content, tool arguments, tool
results, and state values. Selecting any of them replaces that content with a marker recording only
how many characters were removed, while structure, types, ordering, sizes, and timings survive,
which is what a protocol bug report actually needs. The export header records exactly which
categories were redacted.

Until you select at least one, the export control is labelled **Export (unredacted)** and the file
you get contains the real content of the streams you captured — prompts, completions, tool
arguments and results included. What happens to that file afterwards is up to you. Treat a capture
you are about to attach to an issue, or send to anyone, with the same care as the conversation it
came from.

Selecting every category does not make the file empty of everything, and it is better to say so here
than to let you find out from a diff. Structure survives by design, and so does anything the
**developer** wrote rather than anything the **user** typed: in AG-UI events, event types, message,
tool-call, run and thread ids, message roles, step names, activity types, `CUSTOM` event names, the
provider a `RAW` event names as its source, error codes, JSON Pointer paths and patch operations,
tool names and their schemas, and — on a page backed by a CopilotKit runtime — the runtime version
and the agent ids, names and descriptions its `/info` response reported. On a stream whose events
carry a name in the SSE `event:` field — LangGraph Platform, for one — that name survives too,
including subgraph namespaces such as `messages|research:<task id>`, which name nodes in the
developer's own graph. None of the five categories covers that material, because removing it would
cost a bug report most of what makes it legible while protecting nothing anyone typed. One more
field survives that can hold something closer to personal data: a message's optional `name`, which
identifies who wrote it, and an app may fill it with the user's own display name. If
an agent id or description is itself sensitive in your deployment, a capture is not the place to
find that out — check the file before you share it.

A frame whose SSE event name is the same string as the AG-UI event type it carries — an AG-UI
server that names its `event:` field after the event, as Hono's `writeSSE({ event, data })` does —
is treated as that AG-UI event and redacted the normal, precise way. Any other named frame —
LangGraph Platform's, for one, whose names (`metadata`, `values`, `messages|<namespace>`) never
match an AG-UI type — plus any payload the extension does not otherwise recognise as an AG-UI
event, and any frame that failed to parse at all, are redacted in full as soon as any category is
selected. The extension cannot tell which category their content belongs to, so it does not guess;
it keeps only their shape, their keys, the SSE event name when the frame had one, and, for a
payload with no event name, a `type` field that follows AG-UI's own naming convention. On a
LangGraph Platform request, everything in the request body except its settings — the assistant id,
the stream modes and similar — is redacted in full as soon as any category is selected, the prompt
you typed included. Keeping keys has a real edge to it: if an app keys a state map, or any other object, by text a user typed — a
note keyed by its own title, say — that text is exported as a key, and no category redacts a key.

Every field of every AG-UI event type is accounted for, including the ones whose content fits no
single category. A `MESSAGES_SNAPSHOT` is redacted message by message according to who wrote each
one: user, assistant, system and developer messages under message text, tool messages under tool
results, reasoning messages under reasoning content, activity messages under state values, and the
tool calls an assistant message replays under tool arguments. The older `THINKING_*` events count
as reasoning content, and activities count as state values. Some content cannot be attributed to
any one category, so it is removed as soon as you select any category: a `CUSTOM` event's value, a
`RAW` event's payload, a run's error message, result and interrupt details, your answer to an
interrupt, and the `rawEvent` field any AG-UI event may carry. A server may use that field to echo
the underlying provider's own chunk, even on an event whose own content a category already covers.
The same applies to any field the protocol does not define, because the extension cannot know what
that field holds.

## Remote code

None. The extension executes no remotely-hosted code, loads no external scripts, fonts, or styles,
and pulls nothing from a CDN. Everything it runs ships in the package you installed.

## Children

This is a developer tool. It is not directed at children and collects no information from anyone.

## Verifying all of this yourself

You do not have to take our word for any of it:

- Read `packages/devtools/dist/manifest.json` in the built extension and confirm the permissions
  above are all it asks for.
- Run `pnpm verify:build`, which asserts the privacy invariants against the built artifact rather
  than against intentions.
- Search the shipped source for outbound calls — `fetch`, `sendBeacon`, `WebSocket`,
  `XMLHttpRequest`, `importScripts`. The extension patches those APIs to observe the page's own use
  of them; it never originates a request of its own.
- Watch it in Chrome's own Network panel while you use it.

## Changes

Material changes will be published in this file, with the effective date above updated, and
described in the release notes for the version that introduces them. The file's full history is
public in this repository.

## Contact

Open an issue at
<https://github.com/blove/ag-ui-chrome-extension/issues>.

For anything security-sensitive, please follow [SECURITY.md](./SECURITY.md) instead of filing a
public issue.
