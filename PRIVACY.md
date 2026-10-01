# Privacy Policy — AG-UI DevTools

**Effective 1 October 2026.** Applies to the AG-UI DevTools Chrome extension and this repository.

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

On such a page, if it is a Threadplane app running in development mode, the extension also hears
the app's own devtools reports: the **names** of the agent signals each event wrote and when —
never the values written — shown in the Signals tab and never exported. Its render report, likewise,
carries only **names and states** — which component names the app has registered and whether each
generative-UI element rendered — never a prop value; it is shown in the UI tab and never exported.

That data is shown to you, in your own DevTools panel, on your own machine. The toolbar icon's badge
and tooltip show only a summary of it — which protocol a tab spoke, how many connections, and the
CopilotKit runtime version if the page fetched one — never its content; the page cannot read them.

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

## Developer mode: the only feature that changes what your app does

Capture has to touch the page to see anything: it wraps the page's `fetch`, `XMLHttpRequest`, and
`EventSource` so it can read a copy of each stream, and hands every request and response on to your app
with the same content. It does not change what your app sends, receives, or does. The **Simulate** tab is the
exception, and it is off until you turn it on. Developer mode is a switch in the panel, **per origin**, **off by
default**, offered only on an origin you have already enabled capture on, and remembered in
`chrome.storage.local` until you turn it off or revoke the origin. While it is on, a banner on every
panel tab says so.

With Developer mode on, the panel can script the **next agent run** on that origin: when you press
Arm, the extension hands the page's Threadplane app a script of events (an interrupt, a subagent
handoff, a malformed event, or a run you captured), and the app plays it instead of calling its
model. The script is what you see in the panel's editor and nothing else; it goes to the page's top
frame only, and nothing leaves your machine. What comes back is only what became of the script —
armed, consumed, expired, cancelled or rejected — shown in the arm list. The extension checks the switch inside the page's
isolated content script, for that page's own origin, before anything is handed over.

An honest limit: any script already running on a development page could hand the app the same
script itself — the app cannot tell who sent it. That is no more than page code can already do to
its own app. Developer mode guards against scripting a page **by accident**, not against code
already in the page. And none of this exists in a production build: Threadplane only listens in a
development build, so on a production app there is nothing for the panel to script.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Remembers which origins you turned Developer mode on for (`chrome.storage.local`, and nothing else is kept there). Captured events, and what was detected on each tab, live in `chrome.storage.session`, cleared by Chrome on browser close. Which origins you enabled capture on is Chrome's own record of the permission you granted, not something the extension stores. |
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
field survives that can hold something closer to personal data: an AG-UI message's optional
`name`, which identifies who wrote it, and an app may fill it with the user's own display name (on
a LangGraph capture, a user's own name goes with message text). If
an agent id or description is itself sensitive in your deployment, a capture is not the place to
find that out — check the file before you share it.

A frame whose SSE event name is the same string as the AG-UI event type it carries — an AG-UI
server that names its `event:` field after the event, as Hono's `writeSSE({ event, data })` does —
is treated as that AG-UI event and redacted the normal, precise way. A LangGraph Platform capture
is redacted field by field, as described below. Any other named frame — on a connection the
extension does not recognise as LangGraph Platform — plus any payload the extension does not
otherwise recognise as an AG-UI event, and any frame that failed to parse at all, are redacted in
full as soon as any category is selected. The extension cannot tell which category their content
belongs to, so it does not guess; it keeps only their shape, their keys, the SSE event name when the
frame had one, and, for a payload with no event name, a `type` field that follows AG-UI's own
naming convention.

Every field of every AG-UI event type is accounted for, including the ones whose content fits no
single category. A `MESSAGES_SNAPSHOT` is redacted message by message according to who wrote each
one: user, assistant, system and developer messages under message text, tool messages under tool
results, reasoning messages under reasoning content, activity messages under state values, and the
tool calls an assistant message replays under tool arguments. The older `THINKING_*` events count
as reasoning content, and activities count as state values. Some content cannot be attributed to
any one category, so it is removed as soon as you select any category: a `CUSTOM` event's value, a
`RAW` event's payload, a run's error message, result and interrupt details, your answer to an
interrupt sent in an AG-UI request, and the `rawEvent` field any AG-UI event may carry. A server may
use that field to echo the underlying provider's own chunk, even on an event whose own content a
category already covers. The same applies to any field the protocol does not define, because the
extension cannot know what that field holds.

An AG-UI request body, and the copy of it a `RUN_STARTED` event may echo, keeps its thread and run
ids and its tool schemas. Its messages are redacted by the same rules as a `MESSAGES_SNAPSHOT`'s;
its `state`, `context` and `forwardedProps` go with state values; and an answer to an interrupt
keeps only the interrupt's id and status. Any other top-level field of that body, and a body that
is not a JSON object at all, is redacted in full as soon as any category is selected.

The extension recognises a LangGraph Platform connection by its request going to a LangGraph run
route, or by its first event being LangGraph's `metadata` event. On such a capture, each category
removes its own content wherever it appears — in the streamed events, in graph state, and in the
request body. Message text removes the prompt and the text of every message, a user's display name
on their own messages, and the answer sent to resume an interrupt. Reasoning content removes
reasoning and thinking blocks and reasoning summaries. Tool arguments removes the arguments of
every tool call. Tool results removes what a tool returned, and its artifact. State values removes
graph state: every value in a `values`, `updates` or checkpoint payload, including the question an
interrupt puts to the user, the state a request sends with a command, and the content of every
message inside that state. A request's input fields other than its messages — a graph's own input
schema, such as a `question` field — are often what the user typed, so selecting either message
text or state values removes them.

What survives on a LangGraph capture is the run's structure: event names, subgraph namespaces
included; node names; run, thread, message and tool-call ids; tool names; the model's name and why
it stopped; token counts; and the request's settings, such as the assistant id and the stream modes.

Some LangGraph content belongs to no one category, so it is redacted in full as soon as any
category is selected: `custom` events (anything the graph chose to write), and any other event type
the extension does not classify, such as `debug`; a payload that is not the shape its event name
promises; a message's `additional_kwargs`, where providers put reasoning and function-call arguments
of their own; any content block other than text and reasoning, such as an image or a file; the
provider's response metadata beyond the model's name, the stop reason and a few identifiers like
them; error messages, of which only the exception's class name survives; the metadata LangGraph
attaches to a streamed message beyond its own bookkeeping, which includes the authenticated user
LangGraph Platform records there; any field of the opening `metadata` event other than the run,
thread and assistant ids and the attempt number; and a request's `config`, `context`, `metadata`,
`checkpoint` and `webhook`, along with any request field the extension has never seen.

Keeping keys has a real edge to it: if an app keys a state map, or any other object, by text a user
typed — a note keyed by its own title, say — that text is exported as a key, and no category
redacts a key.

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
