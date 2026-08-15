# AG-UI DevTools — Panel UI Design

**Date:** 2026-08-14
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §9
**Prior design:** [`2026-08-13-ag-ui-devtools-design.md`](2026-08-13-ag-ui-devtools-design.md)
**Status of the codebase:** `core/` complete — 355 tests, event decoding, validation, state
reconstruction, metrics, and JSONL round-trip all landed. `inject/`, `relay/`, `sw/`, and the panel
are stubs.

This document designs the panel surface. It does not design the capture layer.

---

## 1. Decisions

Requirements §9 specifies the panel in five short paragraphs. That is enough to name the tabs and
not enough to build them. The decisions below fill the gap; where one departs from §9, the departure
is stated.

| # | Decision | Rationale |
|---|---|---|
| P1 | Design for bug-hunting first; make conformance impossible to miss | All three jobs (bug-hunting, conformance, performance) are real, but "my agent misbehaved" is the common entry and protocol validation is the differentiator. The layout optimises for the first and refuses to let the second hide. |
| P2 | **No dedicated Issues tab.** Issues appear inline, plus a persistent issue count in the toolbar that doubles as a filter toggle | §9 leaves the validator homeless — inline annotations and a line in Session. A sixth tab would make issues discoverable but divorce them from surrounding events, which is where they are understood. The toolbar count costs ~80px and answers "is my stream correct?" at a glance. |
| P3 | **Persistent run scope bar above the tab strip**, with an "all runs" option | Departs from §9, which puts the run selector inside Timeline's toolbar. State and Messages are per-run views; Session is global; Timeline is cross-run. Without a visible scope, switching Timeline → State silently carries a selection the user cannot see. ~24px of vertical beats ~96px of horizontal, and "all runs" preserves the cross-run view that concurrent connections and the orphaned-run bucket require. |
| P4 | Timeline splits list/detail horizontally when wide; below ~600px the detail becomes a resizable bottom pane | Matches Chrome's Network panel, so it needs no explanation. DevTools docked right is commonly 400–500px — the dock most likely for a panel watched alongside a page — so a wide-only layout would exclude a large fraction of use. |
| P5 | ~~Capture-off origins get **detect-then-offer**~~ **SUPERSEDED by P11.** | D3 ships the extension inert. On a non-localhost origin the panel would otherwise open empty, indistinguishable from broken. A passive detection path via `chrome.devtools.network` turns the dead state into the tool's best discovery moment. |
| P11 | **Always offer; never claim nothing is there.** The panel offers to enable capture on the current origin unconditionally, and uses detection only to *strengthen* the message, never to gate the offer | P5 was wrong in practice, found by testing against a real deployment (`ag-ui.threadplane.ai/embed`). A production AG-UI app emits **no AG-UI traffic at all until the user sends a message** — page load is Angular bundles, fonts, and Maps. So `chrome.devtools.network` has nothing to see precisely when the user first opens the panel, and "no AG-UI stream detected" is both true and misleading. **Two** honest levels replace it: capture is off here (always offered) → an event stream was seen. A third "page-load markers" level was drafted and then rejected — see §4a, there is no pre-traffic AG-UI marker and there cannot be one. Verified working: detection did fire once a message was sent. |
| P6 | Live list tails while pinned to the bottom; scrolling up stops the follow | The console/terminal convention. Chosen without debate as the least surprising behaviour. |
| P7 | The list's left gutter shows `CaptureRecord.seq`, not a row index | Filtering reorders visible rows. `seq` is stable, and it is literally what `Issue.seq` refers to, so an issue and its event stay cross-referenceable under any filter. |
| P8 | **Build the panel against imported fixtures before the capture layer exists** | See §7. This is the highest-leverage sequencing decision in the document. |
| P9 | **Eviction is surfaced, never silent.** When the ring buffer drops events, the list shows a truncation marker at the boundary and the toolbar carries a persistent dropped-event count | Sessions are expected to be long and ongoing with multiple runs, so the 5k-event / 8MB default *will* evict in normal use. Requirements §15 asks for a visible "buffer full" state but §9 gives it no home. A panel that silently renders a truncated stream is the same class of trust failure as a hidden validator issue — the user would compute TTFT from a run whose start had been evicted and never know. |
| P10 | The scope bar's run selector is a **searchable, virtualized list**, not a plain dropdown | Follows from the same answer: with many runs per session, a 4-item dropdown assumption breaks. Runs are labelled by thread, outcome, and issue count so the interesting one is findable without opening Runs. |

---

## 2. Shell

Three fixed bands, roughly 72px total, above the tab content.

**Scope bar.** `run r_2 of 4 · thread t_1 · aborted`, right-aligned run duration and TTFT. A
dropdown selects among runs, including an "all runs" entry and the synthetic orphaned bucket. This
bar is the answer to "what am I looking at" from every tab.

**Tab strip.** Timeline · Runs · State · Messages · Session. Unchanged from §9.

**Toolbar.** Record/pause, clear, preserve-on-navigate, expand-chunks, export, filter input, and the
issue count. The issue count is the only chrome permitted to use a danger colour — nothing else
competes with it.

---

## 3. Timeline

The default tab, and the most complex.

**Waterfall strip** sits directly under the toolbar: run bar, message bars, tool bars, step bars,
with stalls marked. Hovering a bar highlights the corresponding events in the list. All of its
inputs already exist in `RunMetrics`. It collapses at the same ~600px breakpoint as the detail pane
(P4) — at that width it is the least load-bearing band on screen, and the alternative is squeezing
the event list from both ends. Collapsed, it becomes a single-line summary that expands on click.

**Event list** (left, or top when narrow). Virtualized. Each row is `seq`, event type, and a
one-line summary. Rows carrying issues get a left border and a tinted background in the issue's
severity colour. The toolbar's issue count filters the list to offending events only.

**Detail pane** (right, or bottom when narrow), in this order:

1. The issue verdict, if any — code, severity, and the specific failing detail. For
   `state-patch-failed` that means the operation index and reason, which is precisely why the JSON
   Patch implementation was hand-rolled to return `opIndex`.
2. The decoded payload, field by field.
3. A `raw` toggle showing the event exactly as received.

Putting the verdict above both views is what makes P2 work without a dedicated tab.

---

## 4. Runs, State, Messages, Session

**Runs.** Table of thread, agent, outcome, duration, TTFT, event count, issue count. Selecting a row
sets the scope bar and switches to Timeline filtered to that run.

**State.** The reconstructed document as a JSON tree, with a scrubber over `Run.stateTimeline`. Each
scrubber position is a `StateFrame`; frames whose `failure` is set are marked red in place. A diff
view per frame shows what the patch changed. Because a failed delta retains the previous frame's
value, the scrubber correctly shows state not advancing across a failure.

**Messages.** The conversation as the client would render it — user, assistant, tool, reasoning —
with tool calls inline and their arguments and results expandable. `ReconstructedMessage.kind`
distinguishes text from reasoning. This is the "is the bug in my UI or in the stream?" view: if the
message reads correctly here and wrong on the page, the bug is in the app.

**Session.** Detected framework and versions, endpoints, transport, runtime mode, agents from
`/info`, capture settings, issue summary, and export controls. Also the drop target for import.

---

## 4a. Framework fingerprinting — corrections from a real deployment

Measured against `https://ag-ui.threadplane.ai/embed`, a production Angular AG-UI app. These
correct requirements §4.3, which was written from expectation rather than measurement.

| Signal | §4.3 says | Measured | Verdict |
|---|---|---|---|
| `ng-version` attribute | framework fingerprint | `"21.1.6"`, present in the DOM at page load | **Reliable.** Readable via `inspectedWindow.eval`, no content script needed |
| `window.ng` | framework fingerprint | **absent** — stripped in production builds | **Unreliable.** Fails on exactly the deployments that matter |
| `window.getAllAngularRootElements` | framework fingerprint | absent | Unreliable, same reason |
| React DevTools hook | framework fingerprint | **present on this Angular app** | **Misleading.** Would label an Angular app as React. Never use alone |
| AG-UI custom elements (`ag-ui-*`) | not mentioned | `ag-ui-shell` present at page load | ~~Strongest pre-traffic signal~~ **REJECTED — see below** |

### There is no pre-traffic AG-UI marker, and there cannot be one

An earlier draft of this section treated the `ag-ui-shell` custom element as an AG-UI detection
signal. That was wrong, and it is worth recording why rather than quietly deleting.

`ag-ui-shell` is *that application's own component name*. It is not part of AG-UI, and no other
AG-UI app will necessarily have it. The rule was generalised from a single measured deployment.

The deeper reason it cannot be salvaged: **AG-UI is a wire protocol and specifies nothing in the
DOM.** There is no markup, no global, and no custom element that an AG-UI app is obliged to
produce. That is not an oversight in the protocol — it is what lets requirements §4.1 promise
content-based detection that "works on a custom endpoint at `/v3/chat`, on a framework nobody has
heard of, on an app that never imported CopilotKit." Any DOM heuristic trades that promise for a
guess that happens to fit one codebase.

So the honest position is: **nothing on this page can tell you it speaks AG-UI until it emits
traffic.** Which is exactly why P11 always offers rather than waiting for a signal.

What a page-load probe *can* honestly yield is a **framework label** — `ng-version` is reliable —
and requirements §4.3 already says a framework fingerprint "labels the session, never gates
capture." So it belongs in the Session tab as metadata, not in the capture banner as a claim.

## 5. Capture-off and first run

Three honest states, never a silent empty one. Under P11 both capture-off states offer Enable; the
detection signal changes only the wording:

- **An event stream was seen** (strongest) — names the origin, and says only what the network log
  can support: an SSE response finished here, contents unknown. Deliberately not "an AG-UI stream":
  `chrome.devtools.network` sees finished responses, never a frame, so it cannot tell an AG-UI
  stream from a progress-bar one
- **Capture is off for this origin** — says that AG-UI traffic often only appears once the user
  sends a message, so the panel cannot tell yet. It may NOT say "nothing detected": that reads as a
  verdict on the page when it is only an absence of evidence. Per §4a there is no third, stronger
  pre-traffic state to reach for
- **Capture on, idle** — waiting for a run

All three explain the reload requirement, and the two capture-off ones carry the same Enable button.

The framework label of §4a appears on the **Session** tab (`Framework: Angular 21.1.6`) and never in
this banner — it is a fact about how the app was built, not about what it speaks.

Import is first-class here rather than a fallback. Dropping a `.agui.jsonl` on a panel with no
capture loads it read-only with every tab working, which is the shareable-bug-report workflow from
requirements §10.

---

## 6. Rendering constraints

- **Virtualization is mandatory.** A long agent run is comfortably 10k events. Preact plus a small
  windowing implementation; no heavy grid dependency, consistent with the zero-runtime-dependency
  posture.
- **The panel's port to the service worker is also the MV3 keepalive.** Holding it open addresses
  the ~30s idle termination noted in requirements §15. This applies only once the capture layer
  lands; under §7's sequencing the panel initially has no service worker to talk to, and the import
  path needs none.
- **Theme follows `prefers-color-scheme`**, already implemented and verified in both schemes.
- **Chunk expansion is a global toggle**, not per-message, matching the single `expandChunks` option
  the run builder already exposes.

---

## 7. Sequencing — build against fixtures first

The obvious order is capture layer, then panel. That is wrong, and this is the most useful
conclusion in the document.

`core/` already round-trips `.agui.jsonl`, and three golden fixtures exist — `happy-run`,
`malformed`, and `chunked-run`. Import replays them through the *same* `run-builder` path that live
capture will use. So the entire panel can be built, demoed, and tested with no capture layer at all:

1. **Import + Timeline + Session** against the existing fixtures. Fully testable, no Chrome APIs,
   no MAIN-world injection, no service worker.
2. **Runs**, then **State**, then **Messages** — each against the same fixtures.
3. **Capture layer** last, feeding the identical model into an already-working UI.

This decouples the two hardest remaining pieces, makes the panel testable in Node, and means a
capture-layer bug can never be confused with a rendering bug. It also means the malformed fixture —
which produces exactly three issues at known positions — doubles as the visual test case for P2.

---

## 8. Deliberately out of scope

Requirements §14's Phase 2 items (LangGraph normalization, `MockAgentTransport` export, the Angular
signal graph, the interrupt simulator, the generative-UI inspector) and the §16 open questions.
Live replay into a running page stays out; the panel remains read-only, per §2's non-goals.

---

## 9. Questions resolved during review

1. **Does the waterfall earn its vertical space at narrow widths?** **Resolved: no.** It collapses
   at the same ~600px breakpoint as the detail pane, to a single-line summary that expands on click.
2. **How many runs does a typical session actually have?** **Resolved: sessions are long and
   ongoing, with more than one run.** This confirms P3's scope bar rather than collapsing it, and
   drives two additions — P9 (eviction must be visible, because the ring buffer will actually evict
   in normal use) and P10 (the run selector must be searchable and virtualized, not a plain
   dropdown). It also raises the stakes on virtualization in §6: the list is a long-session
   component, not a convenience.

## 10. Open questions

1. **Passive detection via `chrome.devtools.network` is a second, weaker detection path** than the
   content-based classifier in `core/`. It sees completed responses rather than live frames, so it
   can report "AG-UI detected" but never decode. Keeping the two paths from disagreeing is a real
   maintenance cost that P5 accepts.
2. **What is the right ring-buffer default for a long ongoing session?** 5k events / 8MB comes from
   requirements §11 and was chosen before "long and ongoing" was established. P9 makes eviction
   visible rather than silent, which is the safety property; whether the default should be larger is
   a separate question best answered from a real capture.
