# Privacy Policy — AG-UI DevTools

**Effective 15 August 2026.** Applies to the AG-UI DevTools Chrome extension and this repository.

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
