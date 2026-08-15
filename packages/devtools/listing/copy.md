---
title: AG-UI DevTools
summary: Inspect, validate, and replay AG-UI agent event streams from any page. No SDK, no code change, no data leaves your browser.
category: Developer Tools
language: en
single_purpose: Capture and inspect AG-UI protocol event streams on pages the user explicitly enables, for debugging.
uses_remote_code: false
privacy_policy_url: https://github.com/blove/ag-ui-chrome-extension/blob/main/PRIVACY.md
website: https://threadplane.ai
support_url: https://github.com/blove/ag-ui-chrome-extension/issues
permissions:
  storage: Stores the user's per-origin capture opt-in and panel preferences. Captured events live in chrome.storage.session, which Chrome clears when the browser closes. Nothing is synced and nothing is written to disk unless the user exports a capture themselves.
  scripting: Registers the capture content scripts at runtime on origins the user has explicitly granted, via chrome.scripting.registerContentScripts. This is required precisely because the extension ships with no static remote host permissions - without it, capture could only ever work on localhost.
  optional_host_permissions: Requested one origin at a time, only when the user clicks to enable capture on that page. It is needed to read the server-sent-event response bodies the page is already receiving. No origin is granted at install time.
---

# Debug AG-UI agent streams on the wire, not in your app

AG-UI is an event protocol over server-sent events. When an agent run misbehaves, the Network
panel shows you an opaque `text/event-stream` and `console.log` shows you what your app *thinks*
happened. AG-UI DevTools shows you the wire: every event in order, grouped into runs, with the
protocol violations named and located.

## Why the existing options do not work

- **Chrome's Network panel** gives you raw `data:` lines. No decoding, no run grouping, no state
  reconstruction, no validation.
- **In-app inspectors** ship inside your bundle, are tied to one framework, and cannot help an
  Angular, Vue, or vanilla AG-UI app at all.
- **Editor extensions** need a runtime in dev mode, so they go dark exactly where bugs are hardest
  to reproduce.

This is a wire-level tool. It attaches to the protocol instead of the framework.

## What it does

- **Captures** AG-UI events from `fetch`, `XMLHttpRequest`, and `EventSource`
- **Decodes** SSE framing and groups events into runs and threads
- **Validates** protocol invariants and names each violation at the event that caused it
- **Reconstructs** messages, tool-call trees, and state with full RFC 6902 patch history
- **Measures** time to first token, run duration, and streaming stalls — in the run table and on the timeline
- **Records and replays** — export a capture as `.agui.jsonl` and reopen it anywhere

## Privacy, stated as fact

This tool sits where prompts and completions flow, so its posture is not a matter of trust:

- **No network egress. Ever.** No remote host permissions, no fetch from the service worker or the
  panel, no telemetry, no update pings, no crash reporting.
- **Opt in per origin.** The extension ships inert. Only `localhost`, `127.0.0.1`, and `0.0.0.0`
  are registered up front; every other origin takes an explicit click.
- **Nothing on disk by default.** Capture lives in memory with a `chrome.storage.session` mirror
  that Chrome clears when the browser closes.
- **Headers are never captured** except `content-type`. Authorization headers and cookies are
  never read, never stored, never exported.
- **Redaction on export** for bug-report bundles: text, reasoning, tool arguments, tool results and
  state values are replaced, while structure, types, ordering, sizes and timings survive — which is
  what a protocol bug report actually needs.

Every claim above is checkable by reading the built `manifest.json`, and the repository's build
verification asserts them on every commit.

## Open source

MIT licensed. Source, issues, and the full specification:
https://github.com/blove/ag-ui-chrome-extension
