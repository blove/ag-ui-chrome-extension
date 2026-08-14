# AG-UI DevTools — Specification v0.1

A Chrome DevTools extension that captures, decodes, validates, and replays AG-UI
event streams from any page — no SDK, no code change, no license key.

**Status:** draft for approval. Phase 1 (generic / CopilotKit-friendly) is specified to
prototype depth. Phase 2 (Threadplane) is specified to intent depth.

---

## 0. Decisions needed before build

Answer these six and the build prompt can be generated.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Name + branding | Neutral: **AG-UI DevTools**. Threadplane credited in the About tab and README only. A Threadplane-branded tool will not get installed by React/CopilotKit users, and they are the reach. |
| D2 | License | MIT, public repo, separate from the Threadplane monorepo. Matches the existing "MIT adapters stay open" posture and removes any licensing question from CWS review. |
| D3 | Capture scope default | **Opt-in per origin.** Ships inert. `localhost`, `127.0.0.1`, `0.0.0.0` auto-enabled. Any other origin requires one click + reload. Costs one UX step, buys a clean privacy story and a much easier store review. |
| D4 | Runtime dependency on `@ag-ui/core` | No. Vendor a generated event-shape table; keep `@ag-ui/core` as a dev dependency used only to regenerate it. Avoids version coupling and Zod in the bundle. |
| D5 | Surface | DevTools panel only for the prototype. Side panel and page overlay deferred. |
| D6 | Prototype validation target | AG-UI Dojo + a CopilotKit v1.50 quickstart app + one deliberately malformed stream. |

---

## 1. Problem

AG-UI is an event protocol over SSE. When a run misbehaves, the developer has three
options today, all bad:

1. **Chrome's Network panel.** Shows the request. The response body is a streaming SSE
   body, so the EventStream tab gives raw `data:` lines with no decoding, no run
   grouping, no state reconstruction, no validation.
2. **CopilotKit's Inspector.** Good, and genuinely the closest thing that exists. But it
   is an in-app React overlay: it ships in your bundle, it is CopilotKit-specific, it
   defaults to localhost-only and needs `enableInspector={true}` to run anywhere else,
   and its Threads views sit behind an Intelligence license. It cannot help an Angular,
   Vue, or vanilla AG-UI app at all.
3. **CopilotKit's VS Code Event Inspector.** Requires a CopilotKit runtime in dev mode;
   the debug endpoint is disabled when `NODE_ENV=production`.

The protocol's own debugging documentation recommends the AG-UI Dojo — i.e. "go
reproduce it in a reference app." There is no protocol-level, framework-agnostic,
zero-install-in-your-app inspector. Nothing on the Chrome Web Store targets AG-UI.
Generic SSE viewers exist (SSE Viewer, StreamPanel) but know nothing about run
lifecycles, JSON Patch state, or event-sequence invariants.

**Gap:** a debugger that attaches to the wire instead of the framework.

### Why it's worth building now

Better AG-UI stream devtools are on CopilotKit's public roadmap. The window is open,
not indefinite. The defensible position is not "an event list" — they will ship that.
It's the three things a wire-level tool can do that an in-app panel structurally
cannot: work on any framework, work on deployed environments without a code change,
and turn a captured production stream into a runnable test fixture.

---

## 2. Scope

### Phase 1 — generic (this spec, prototype target)

Any page, any framework, any AG-UI-speaking backend. CopilotKit is the primary
compatibility target because it is the largest AG-UI client population.

- Capture AG-UI events from `fetch`, `XMLHttpRequest`, and `EventSource`
- Decode SSE framing; group events into runs and threads
- Timeline, message reconstruction, tool-call tree, state inspector with patch history
- Protocol validator (the differentiator)
- Timing metrics (TTFT, token gaps, tool latency, stalls)
- Record → export `.agui.jsonl` → import and replay
- Redacted bug-report bundle

### Phase 2 — Threadplane (specified in §14, not built yet)

Angular signal graph, LangGraph-adapter normalization, `MockAgentTransport` fixture
export, interrupt simulator, A2UI/json-render spec inspector.

### Non-goals

- Modifying live traffic (no request mocking, no response rewriting) in v1
- Any network egress from the extension. Ever. No analytics, no cloud sync
- Decoding protobuf transport in Phase 1 (detect and label only — see §5.4)
- Supporting non-Chromium browsers in v1 (Firefox port is mechanical; defer)

---

## 3. Architecture

```
┌─ page (MAIN world) ──────────────────────────────────────┐
│  inject.js  @document_start                              │
│  ├─ patches fetch / XHR / EventSource                    │
│  ├─ tees SSE bodies, parses frames                       │
│  ├─ classifies: is this AG-UI?                           │
│  └─ window.postMessage({source:'agui-dt', ...})          │
└──────────────────────┬───────────────────────────────────┘
                       │ postMessage (same-origin, tagged)
┌─ content script (ISOLATED world) ────────────────────────┐
│  relay.js — validates shape, drops anything unrecognized │
└──────────────────────┬───────────────────────────────────┘
                       │ chrome.runtime port
┌─ service worker ─────────────────────────────────────────┐
│  ring buffer per tabId (default 5k events / 8 MB)        │
│  survives panel-opened-late via replay                   │
│  chrome.storage.session mirror for SW restart            │
└──────────────────────┬───────────────────────────────────┘
                       │ port, tabId-scoped
┌─ DevTools panel ─────────────────────────────────────────┐
│  normalizer → run model → validator → UI                 │
└──────────────────────────────────────────────────────────┘
```

**Why MAIN-world patching and not the DevTools network API or CDP:**
`chrome.devtools.network` cannot give you a streaming body incrementally — you get
content after completion, if at all, and it misses events that matter for timing.
`chrome.debugger` (CDP) works but shows the yellow "being debugged" banner on every
tab and draws extra scrutiny in store review. `Network.eventSourceMessageReceived`
only fires for the `EventSource` API, and AG-UI's `HttpAgent` uses `fetch` POST with
`Accept: text/event-stream` — so CDP wouldn't even see the main case. MAIN-world
injection at `document_start` is the only approach that sees every frame as it lands.

---

## 4. Detection

Detection is **content-based first, URL-based second**. This is deliberate: content-based
detection means the tool works on a custom endpoint at `/v3/chat`, on a framework nobody
has heard of, on an app that never imported CopilotKit.

### 4.1 Primary signal (definitive)

A response with `Content-Type: text/event-stream` whose `data:` payloads parse to JSON
objects carrying a `type` field matching the AG-UI `EventType` enum. Two matching events
on one response ⇒ classified AG-UI. One match ⇒ provisional.

### 4.2 Secondary signals

Fast-path hints, and used for the "AG-UI detected" badge before any run happens.

CopilotKit runtime routes, given a `basePath` such as `/api/copilotkit`:

| Route | Meaning |
|---|---|
| `GET {base}/info` | Agent discovery. Response lists registered agents + `threadEndpoints` capabilities. Best pre-run detection signal. |
| `POST {base}/agent/:agentId/run` | Run start. Body is AG-UI `RunAgentInput`; response is the SSE event stream. |
| `POST {base}/agent/:agentId/connect` | Resume/reconnect stream. Also SSE. |
| `POST {base}/agent/:agentId/stop/:threadId` | Stop. |
| `GET {base}/inspector-metadata` | Intelligence-backed runtime. Indicates a licensed deployment. |
| `POST {base}` with `{method, params, body}` | Single-route mode. Unwrap the envelope before classifying. |

Direct-to-agent (`HttpAgent`, no runtime): POST with `Accept: text/event-stream` and a
JSON body containing `threadId` + `runId` + `messages`.

### 4.3 Framework fingerprint (labels the session, never gates capture)

`window.__COPILOTKIT*` globals · React DevTools hook · `ng-version` attribute /
`window.ng` / `getAllAngularRootElements` · Vue `__VUE__` · Threadplane globals (Phase 2).

---

## 5. Capture layer (`inject.js`)

### 5.1 fetch

```js
const orig = window.fetch;
window.fetch = async function (input, init) {
  const meta = captureRequestMeta(input, init);   // url, method, body snapshot
  const res  = await orig.apply(this, arguments);
  if (!isStreamCandidate(res)) return res;
  const [toPage, toUs] = res.body.tee();
  readAndParse(toUs, meta);                        // async, never awaited
  return new Response(toPage, {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });
};
```

`tee()` buffers if one branch lags, so the parse branch must drain eagerly and never
block on the panel. Parsing is synchronous per chunk; delivery to the relay is batched
on a microtask.

**Request body capture:** `init.body` may be a string, `Blob`, `FormData`,
`URLSearchParams`, or a `ReadableStream`. Handle the first four; for a stream body,
record `[unreadable stream body]` rather than consuming it. The `RunAgentInput` is the
single most valuable artifact for reproduction — it carries `threadId`, `runId`,
`messages`, `tools`, `context`, `state`, `forwardedProps`.

### 5.2 XMLHttpRequest

Patch `open`/`send`. On `readyState === 3`, slice `responseText` from the last consumed
offset and feed the SSE parser. Lower fidelity on timing than fetch; acceptable.

### 5.3 EventSource

Patch the constructor. `EventSource` cannot send a POST body, so it is rare for AG-UI —
but it costs ~30 lines and some middlewares use it.

### 5.4 SSE frame parser

Standard `text/event-stream` framing: records separated by blank lines, `data:` lines
concatenated with `\n`, plus `event:`, `id:`, `retry:`, and `:` comment/heartbeat lines.
Must handle a chunk boundary splitting a frame mid-line, and CRLF. Heartbeat comments
are recorded as keepalives (useful for diagnosing proxy buffering) but excluded from the
event count.

**Binary transport:** `@ag-ui/encoder` supports protobuf under
`application/vnd.ag-ui.event+proto` with SSE fallback. Phase 1 detects that content type
and shows a first-class "binary transport — decoding not supported yet" state with byte
counts and timing, rather than a confusing empty panel. Decoding is Phase 3.

### 5.5 Timestamps

`performance.now()` at frame boundary, plus one `Date.now()` epoch anchor per session.
Record arrival time of the first byte of the frame, not the parse-completion time.

---

## 6. Normalized model

```ts
type CaptureRecord = {
  seq: number;            // monotonic per session
  tMs: number;            // ms since session start
  connId: string;         // one HTTP response = one connection
  raw: unknown;           // event exactly as received, never mutated
  event: AguiEvent | null;// null when unparseable — still shown, flagged
  issues: Issue[];
};

type Run = {
  runId: string; threadId: string; parentRunId?: string;
  agentId?: string; connId: string;
  input?: RunAgentInput;              // from the POST body
  startedAt: number; endedAt?: number;
  outcome: 'running' | 'finished' | 'error' | 'aborted' | 'orphaned';
  messages: Map<string, ReconstructedMessage>;   // incl. reasoning messages
  toolCalls: Map<string, ToolCallRecord>;
  activities: Map<string, ActivityRecord>;
  steps: StepRecord[];
  stateTimeline: StateFrame[];        // snapshot + each applied patch
  metrics: RunMetrics;
  issues: Issue[];
};
```

Reconstruction rules:

- `TEXT_MESSAGE_CHUNK` / `TOOL_CALL_CHUNK` / `REASONING_MESSAGE_CHUNK` are expanded into
  their start/content/end triads exactly as the JS client does, and the panel shows both
  the raw and expanded views (toggle). Getting this wrong makes the panel disagree with
  the app, which destroys trust in the tool.
- `TOOL_CALL_ARGS` deltas are concatenated and parsed at `TOOL_CALL_END`.
- `STATE_SNAPSHOT` replaces; `STATE_DELTA` applies RFC 6902 JSON Patch to the previous
  frame. Every frame retains the patch that produced it, so the state tab is scrubbable.
- Events arriving with no open run are attached to a synthetic `orphaned` run rather than
  dropped.

Full event coverage (26 types): lifecycle (`RUN_STARTED/FINISHED/ERROR`,
`STEP_STARTED/FINISHED`), text (`START/CONTENT/END/CHUNK`), tool
(`START/ARGS/END/RESULT/CHUNK`), state (`STATE_SNAPSHOT/DELTA`, `MESSAGES_SNAPSHOT`),
activity (`ACTIVITY_SNAPSHOT/DELTA`), reasoning (`REASONING_START/END`,
`REASONING_MESSAGE_START/CONTENT/END/CHUNK`, `REASONING_ENCRYPTED_VALUE`), and
`RAW`/`CUSTOM`. Deprecated `THINKING_*` events are decoded and flagged as deprecated.

---

## 7. Validator

This is the feature that makes the tool worth installing rather than reading the Network
tab. Each rule fires as an inline annotation on the offending event plus a run-level
issue count.

**Errors**

- Event before `RUN_STARTED`, or after the run's terminal event
- Run with no terminal `RUN_FINISHED` / `RUN_ERROR` when the connection closed
- `TEXT_MESSAGE_CONTENT` with an empty `delta` (spec requires non-empty)
- `TEXT_MESSAGE_CONTENT` / `_END` referencing an unopened `messageId`
- `TOOL_CALL_ARGS` / `_END` referencing an unopened `toolCallId`
- `TOOL_CALL_RESULT` for a tool call that never ended
- Accumulated tool-call args that don't parse as JSON at `TOOL_CALL_END`
- `STATE_DELTA` whose JSON Patch fails to apply (missing path, bad `op`) — with the
  specific failing operation highlighted; per spec, the client should be requesting a
  fresh `STATE_SNAPSHOT` here
- First `*_CHUNK` for a message missing `messageId`; first `TOOL_CALL_CHUNK` missing
  `toolCallId` or `toolCallName`
- Payload fails the event's shape check (missing required field, wrong type)

**Warnings**

- Unbalanced `STEP_STARTED` / `STEP_FINISHED`
- Unclosed message or tool call at run end
- Deprecated `THINKING_*` events
- Unknown `type` (forward-compat: shown, not treated as an error)
- Two text messages streaming concurrently (legal, frequently unintended)
- No `STATE_SNAPSHOT` before the first `STATE_DELTA`

**Info**

- Keepalive/heartbeat gaps > 15 s (suggests proxy buffering)
- `RUN_STARTED` without `input` (reproduction will be harder)

---

## 8. Metrics

Per run: total duration · TTFT (`RUN_STARTED` → first `TEXT_MESSAGE_CONTENT`) · time to
first reasoning token · inter-token gap p50/p95/max · stall detection (configurable, default
> 2 s with an open message) · per-tool latency (`TOOL_CALL_START` → matching
`TOOL_CALL_RESULT`) · state-patch count and cumulative bytes · event count by type ·
total stream bytes.

Rendered as a horizontal waterfall: run bar, message bars, tool bars, step bars, with
stalls marked. Hover a bar, the corresponding events highlight in the timeline.

---

## 9. Panel UI

Five tabs. Dark/light following DevTools theme. Virtualized list — a long agent run is
easily 10k events.

1. **Timeline** — the default. Left: filterable event list (by type category, run,
   thread, text search over payloads). Right: detail pane with the raw JSON and a
   decoded view. Top: run selector + waterfall strip. Toolbar: record/pause, clear,
   preserve-on-navigate, expand-chunks toggle, export.
2. **Runs** — table of runs (thread, agent, outcome, duration, TTFT, event count, issue
   count). Click through to Timeline filtered to that run.
3. **State** — current reconstructed state as a JSON tree, with a scrubber over the
   patch history and a diff view per patch. Failed patches are marked red at their
   position on the scrubber.
4. **Messages** — the conversation as the client would render it: user/assistant/tool/
   reasoning, with tool calls inline and their arguments and results expandable. This is
   the "is the bug in my UI or in the stream?" tab — if the message looks right here and
   wrong on the page, the bug is in the app.
5. **Session** — detected framework and versions, endpoint(s), transport, runtime mode
   (multi-route vs single-route), agents from `/info`, capture settings, issue summary,
   export controls.

---

## 10. Record, export, replay

**Format — `.agui.jsonl`.** Line 1 is a header record; each subsequent line is one
`CaptureRecord`. Streamable, greppable, diffable, appendable.

```jsonl
{"kind":"header","schemaVersion":1,"tool":"ag-ui-devtools@0.1.0","capturedAt":"2026-08-13T…","url":"https://…","framework":"react/copilotkit","transport":"sse","redacted":["text","toolArgs"]}
{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/api/copilotkit/agent/default/run","input":{…}}
{"kind":"event","connId":"c1","seq":1,"tMs":12,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}
```

**Export modes:** full · single run · redacted bug report (see §11) · clipboard JSON.

**Import & replay:** drag a `.agui.jsonl` onto the panel to load it read-only, with the
validator and all tabs working. This makes the file a shareable bug report: a colleague
who can't reproduce your issue gets your exact stream. It also makes the tool useful
against streams captured by other tools or generated by tests.

**Fixture export:** emit a TypeScript file containing the event array plus a scaffold for
`@ag-ui/client` tests. In Phase 2 this gains a `MockAgentTransport` variant, which is the
whole record-to-test loop.

---

## 11. Privacy & security

Non-negotiable, because the tool sits on the wire where prompts and completions flow, and
its value depends entirely on being trusted with them.

- **No egress.** No `host_permissions` for any remote origin. No fetch from the SW or
  panel. No telemetry, no update pings, no crash reporting. Verifiable by reading the
  manifest.
- **No persistence by default.** Capture lives in memory (`chrome.storage.session`
  mirror, cleared on browser close). Nothing touches disk unless the user exports.
- **Opt-in per origin** (D3). Localhost family auto-enabled; everything else is one
  click and a reload.
- **Headers never captured** except `content-type`. `Authorization` and cookies are
  never read, never stored, never exported.
- **Redaction profile for export**, on by default for the bug-report bundle: text deltas,
  reasoning content, tool arguments, tool results, and state values are replaced with
  `«redacted: 412 chars»`. Structure, types, ordering, sizes, and timings survive — which
  is what a protocol bug report actually needs. The user can opt back into full fidelity
  per field group, and the header records what was redacted.
- **Ring buffer caps** on memory (default 5k events / 8 MB, configurable), oldest dropped.

The MAIN-world script is a supply-chain surface in someone else's page. It patches only
`fetch`, `XMLHttpRequest`, and `EventSource`, preserves original behaviour on every path
including errors, holds original references before patching, and never evaluates page
data. Messages crossing the postMessage boundary are tagged, origin-checked, and
shape-validated on the receiving side.

---

## 12. Manifest & permissions

```json
{
  "manifest_version": 3,
  "name": "AG-UI DevTools",
  "version": "0.1.0",
  "devtools_page": "devtools.html",
  "background": { "service_worker": "sw.js", "type": "module" },
  "permissions": ["storage", "scripting"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "content_scripts": [{
    "matches": ["http://localhost/*", "http://127.0.0.1/*", "http://0.0.0.0/*"],
    "js": ["inject.js"], "run_at": "document_start", "world": "MAIN", "all_frames": true
  }, {
    "matches": ["http://localhost/*", "http://127.0.0.1/*", "http://0.0.0.0/*"],
    "js": ["relay.js"], "run_at": "document_start", "world": "ISOLATED", "all_frames": true
  }]
}
```

No `debugger`, no `webRequest`, no broad static host permissions. Non-localhost origins
are added at runtime via `chrome.scripting.registerContentScripts` after the user grants
that origin. `all_frames: true` because agent chat is frequently in an iframe.

---

## 13. Prototype definition

**Stack:** TypeScript, Vite + CRXJS, Preact for the panel (small; the panel must not be
the slow part), no runtime dependencies beyond a JSON Patch implementation.

**Repo:**

```
src/
  inject/     patches, sse-parser, classifier, postMessage bridge
  relay/      content script
  sw/         ring buffer, ports, session storage
  panel/      devtools page + panel UI
  core/       event table, normalizer, run model, validator, metrics, jsonl codec
  test/       fixtures (golden streams, incl. malformed)
```

`core/` is deliberately free of Chrome APIs so it can be unit-tested in Node and later
reused in a CLI or a VS Code panel.

**Done when:**

1. Load unpacked, open DevTools on the AG-UI Dojo, run an example, see decoded events in
   the timeline with correct run grouping — no configuration.
2. Same on a CopilotKit v1.50 quickstart app, with `/info`-derived agent metadata shown
   in Session before any run.
3. Streaming text reconstructs to exactly what the page renders, chunk expansion on and off.
4. Tool call shows streamed args accumulating and parsing; state tab scrubs through
   snapshot + patches.
5. A fixture stream with a missing `RUN_FINISHED`, an empty `delta`, and a bad patch path
   produces exactly three validator entries at the right positions.
6. Export a run, clear, re-import, tabs are identical.
7. Redacted export contains no message text, and still validates and renders.
8. Capture is off on a non-localhost origin until enabled.

---

## 14. Phase 2 — Threadplane

Ordered by leverage, not effort.

**14.1 LangGraph normalization.** Threadplane's `@threadplane/langgraph` adapter talks to
LangGraph Platform, which is *not* AG-UI on the wire: `POST /threads/{id}/runs/stream`
with `stream_mode` of `values`/`updates`/`messages-tuple`/`custom`, SSE events named
`messages/partial`, `messages/complete`, `messages/metadata`, `values`, `updates`, and
namespaced variants like `messages|node:uuid` when `stream_subgraphs` is on. Mapping
those into the same internal run model means one timeline covers both Threadplane
adapters — and it makes the extension the only tool that shows a LangGraph stream and an
AG-UI stream side by side in one format. Useful well beyond Threadplane.

**14.2 `MockAgentTransport` fixture export.** Captured run → a test file that replays it
through Threadplane's transport seam. Threadplane's testing story already says "swap the
transport, never mock `injectAgent()`" — this generates the swap. Prod bug to failing
test in one click. Highest-value item on the list.

**14.3 Signal graph.** *Requires a page-side hook.* Angular signals are not externally
introspectable; there is no equivalent of the React DevTools global. This needs a small
MIT `@threadplane/devtools` package exposing
`window.__THREADPLANE_DEVTOOLS_HOOK__` — a no-op in production builds — that reports
which of `messages()`, `status()`, `toolCalls()`, `interrupt()`, `subagents()`,
`history()`, `queue()` recomputed on each event. Worth flagging early: this is a
Threadplane release dependency, not just extension work. It is also the single feature
CopilotKit cannot copy.

**14.4 Interrupt / HITL simulator.** Inject a synthetic interrupt, subagent handoff, or
malformed event into the running app to exercise approval UI without a model call. Also
needs the hook. This crosses from observation into mutation — gate it behind an explicit
"developer mode" toggle, and never allow it on an origin the user hasn't enabled.

**14.5 Generative UI inspector.** For `@threadplane/render` / A2UI: spec JSON ↔ rendered
component mapping, with warnings for spec nodes that have no match in the app's
registry. Also applies to CopilotKit's A2UI middleware, so it isn't Threadplane-only.

**14.6 Detection badge.** Toolbar icon lights up on any AG-UI page and names the stack.
Cheap, and it's the discovery mechanism — people find out the tool exists by seeing it
activate somewhere they didn't expect.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| MV3 service worker terminates at ~30 s idle, losing the buffer | Mirror to `chrome.storage.session`; keep the panel port open as a keepalive; restore on wake |
| `tee()` back-pressure stalls the page if the parse branch lags | Drain eagerly, never await panel delivery, hard byte cap with visible "buffer full" state |
| App routes agent traffic through a service worker (bypasses page `fetch`) | Detect and show an explicit unsupported-path message rather than silently capturing nothing; SW interception is a later spike |
| Page uses Trusted Types / strict CSP | MAIN-world manifest injection is not affected by page CSP; verify against a strict-CSP fixture anyway |
| CopilotKit ships equivalent devtools | Compete on the axes an in-app panel can't reach: framework independence, deployed environments, fixture export. Don't compete on "an event list" |
| Chrome Web Store review of a tool that reads page traffic | No `debugger`, no broad static host perms, no egress, opt-in origins, open source. Privacy declaration writes itself |
| AG-UI protocol evolves (it is pre-1.0) | Unknown event types render as warnings, never errors; event table is generated from `@ag-ui/core` and regenerating is a one-command chore |

---

## 16. Open questions

1. Does the redaction default belong on **capture** as well as export? Capture-time
   redaction is a stronger privacy claim but destroys the "does the stream match the UI"
   workflow. Current spec: export-only. Reasonable to disagree.
2. Should replay be able to drive a live page (inject a recorded stream into the running
   app), or stay read-only in the panel? Live replay is a much better testing tool and a
   much bigger security surface.
3. Is `@threadplane/devtools` (§14.3) something you're willing to publish and maintain,
   or should Phase 2 be scoped to what works without a page hook?
4. Ship the CopilotKit-route fast-path detection at all, given content-based detection
   already covers it? It's a better pre-run experience; it's also maintenance coupled to
   someone else's routes.
