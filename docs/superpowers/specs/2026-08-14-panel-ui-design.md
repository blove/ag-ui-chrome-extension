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
| P12 | **Capture status reports what the DOCUMENT says, never what the origin allows.** The extension's own ISOLATED-world relay reports that the capture layer is **loaded**; absence of that report — after a short grace period — is what produces the warning. **Revised 2026-08-15, see §5b: the report moved out of the page's view, and the claim weakened to match.** | Found in a real browser, 2026-08-15. The panel flipped capture to `on` from `chrome.permissions.contains` alone, but `chrome.scripting.registerContentScripts` affects only FUTURE navigations, so a document already open when the grant landed had no content scripts in it: `Function.prototype.toString.call(window.fetch)` still read `[native code]`, and the panel said it was capturing. Three divergence paths — a grant from a previous session, an extension reload with the page open, and a grant the user never acts on — and only the third was handled, by `awaitingReload`. The grace period is not optional: rendering the warning before the report is due would flash a false alarm on every panel open, and a warning that is usually wrong teaches the user to ignore the one that matters. `executeScript` into the open document was rejected as the remedy — it produces a PARTIALLY patched document (bundlers hoist `const f = window.fetch`; an already-constructed `EventSource` is unreachable) that reports itself fully patched, which is the same failure class again. A reload is honest. **Revised again 2026-08-15, see §5c: a reload is honest for the state P12 was written about and useless for one it did not know existed, so the panel now tells the two apart.** |
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

Five honest states, never a silent empty one. Under P11 both capture-off states offer Enable; the
detection signal changes only the wording. Under P12 "capture on" splits in three, because the
origin being granted and the document being patched are different facts:

- **An event stream was seen** (strongest) — names the origin, and says only what the network log
  can support: an SSE response finished here, contents unknown. Deliberately not "an AG-UI stream":
  `chrome.devtools.network` sees finished responses, never a frame, so it cannot tell an AG-UI
  stream from a progress-bar one
- **Capture is off for this origin** — says that AG-UI traffic often only appears once the user
  sends a message, so the panel cannot tell yet. It may NOT say "nothing detected": that reads as a
  verdict on the page when it is only an absence of evidence. Per §4a there is no third, stronger
  pre-traffic state to reach for
- **Capture on, checking** (P12) — the origin is enabled and nothing has reported the capture layer
  in this document yet. It may NOT say "capture is on": that is the claim that was wrong. It may not
  warn either, until the grace period is out
- **Capture on, but the capture scripts are not registered for this origin** (§5c) — granted, and
  nothing is registered, so nothing loads on any navigation. It may NOT offer a reload: there is
  nothing registered for a reload to load, and the user would come back to the identical message.
  It offers re-registration instead
- **Capture on, the capture layer is not loaded in this document** (P12) — granted, registered, and
  nothing is being captured *here*. Carries the same reload affordance a fresh grant does, for the
  same reason
- **Capture on, capture layer loaded, idle** — waiting for a run. It says *loaded*, not
  *instrumented* and not *capturing*: see §5b for what the evidence supports

All of them explain the reload requirement **except the not-registered one, which must not**, and
the two capture-off ones carry the same Enable button.

The framework label of §4a appears on the **Session** tab (`Framework: Angular 21.1.6`) and never in
this banner — it is a fact about how the app was built, not about what it speaks.

---

## 5b. P12 revised — the signal moved worlds, and the claim shrank to fit

**2026-08-15.** P12 as first shipped was right about the *fact* and wrong about the *channel*.

### What the page could observe before

The MAIN-world script announced itself at `document_start` by posting

```js
{ source: 'agui-dt', v: 1, kind: 'capture-installed', tMs: <number> }
```

through `window.postMessage` **to the page's own window** — twice, to survive the MAIN/ISOLATED
injection race. The relay picked it up. So did every `message` listener on the page, and many apps
have one, for iframe communication.

That is a bigger change than it looks. Before P12, a page could learn this extension existed only by
actively **probing** — `Function.prototype.toString.call(window.fetch)` no longer reads
`[native code]` — or once AG-UI traffic had started, by which point `agui-dt` messages were on the
bus anyway. P12 turned that into a **push**, and widened it from *AG-UI pages* to *every page on a
granted origin*, including the overwhelming majority that never make an AG-UI request.

The concern is not fingerprinting. It is an application that **behaves differently when it can tell
it is being inspected** — which is the one thing a devtools product must never cause. §11 asks for
the extension to be unobtrusive, and this was the loudest thing it did.

### What the page can observe now

Nothing, until it opens a stream itself. The relay is a content script in the **ISOLATED** world
and already holds a `chrome.runtime` port; it now reports `{ v: 1, kind: 'capture-loaded' }` there,
once, at module evaluation. `chrome.runtime` is a channel the page cannot see, read, or forge. The
MAIN world's announcement and its `postMessage` are gone, so every message the page can observe from
this extension is downstream of a `fetch`, `XMLHttpRequest` or `EventSource` **the page opened**.

`window.__AGUI_DEVTOOLS__` remains, and remains a *pull* signal: a page has to go looking for it.
That is the pre-P12 posture, deliberately restored rather than exceeded.

### An explicit message, not the bare port connection

The port would be cheaper — the worker reads `tabId` and `frameId` off `port.sender` either way, so
frame identity comes from Chrome in both designs. It cannot carry the fact the worker needs.
`markLoaded` **replaces** a top-level frame's record and clears the subframes beneath it, because a
new top-level document destroys them. That is correct only for a genuinely new document, and a port
connection cannot be told apart from a **reconnect**: MV3 terminates an idle worker (§15), the next
message reopens the port, and a re-mark from the main frame would wipe still-live subframes. The
message is sent exactly once per document, so its arrival means "a document just loaded here" —
precisely what the replace-on-navigation behaviour is keyed on.

`ConnectionMessage` — `Exclude<InjectMessage, { kind: 'capture-installed' }>`, which existed so a
transport could not structurally claim installation — is deleted rather than left as a vacuous
exclusion. The intent it encoded is now enforced by the world boundary: the claim is not an
`InjectMessage` arm at all, so no page-side code has a shape in which to make it.

### The accepted residual

The relay running proves **the content scripts were registered for this document** — exactly the
broken case P12 exists to catch, since an already-open document has none of them. It does **not**
prove the MAIN-world patches installed: `installInject` swallows its own throw, and the relay would
report regardless. So the panel's claim weakened from "the capture hooks are installed" to **"the
capture layer is loaded in this page"**, which is exactly true.

That residual is our own tested code rather than a state a user can configure their way into, and it
**self-corrects**: the first AG-UI request produces a `conn-open`, which is proof the patches work,
and the banner then goes quiet on records. Records are the only stronger claim the panel ever makes.

Strengthening it later at zero page-visible cost is possible — the two worlds share the DOM, so the
MAIN world could record its install result on a detached node's attribute for the relay to forward.
Not built: it trades a page-visible signal for a DOM-visible one, and the extra fact is worth less
than the simplicity.

### The gate

`packages/harness/e2e/quiet-page.spec.ts`. A `message` collector installed via `addInitScript`
before the document exists, a page that makes no AG-UI request, and an assertion of **zero**
`agui-dt` messages — while the worker still reports the document loaded. It cannot pass vacuously:
it asserts the collector caught a control message the harness posted itself, that the page's own
inline script ran, and that `window.__AGUI_DEVTOOLS__` is present, so a dead listener or an
extension that never loaded fails loudly. Both directions were mutation-tested — removing the
relay's report fails the not-loaded path, and re-adding a page-visible post fails the zero-messages
assertion while leaving the worker-state assertions green.

Import is first-class here rather than a fallback. Dropping a `.agui.jsonl` on a panel with no
capture loads it read-only with every tab working, which is the shareable-bug-report workflow from
requirements §10.

---

## 5c. P12 revised again — a reload is not always the remedy, and once it was not one at all

**2026-08-15, later the same day.** P12 got the *fact* right — capture status must report what the
DOCUMENT says — and then drew one conclusion too many from it: that a page reload is what fixes a
document with no capture layer in it. That is true when the scripts are registered and this
particular document predates them, which is the case P12 was written from. It is false when nothing
is registered at all, and that case turned out to be every user's second day.

### The failure mode

`chrome.scripting.registerContentScripts` was called from exactly one trigger:
`chrome.permissions.onAdded`. **Chrome discards dynamically registered content scripts when an
extension is reloaded or updated, and keeps the host permission.** So after any update:

- the origin is still granted, so `hasOriginGrant` is true and the panel flips capture to `on`;
- nothing is registered for it, so no navigation loads anything and `loaded` settles to `false`;
- `onAdded` never fires again, because nothing was added — **re-granting could not repair it**.

Capture died silently and permanently for every origin the user had ever granted. The only escape
was to revoke the origin and grant it again, which nothing told them to do. The service worker
stated the wrong assumption in a comment on the `catch` that swallowed the evidence:
`registerContentScripts` "persists across sessions by default".

**Measured, rather than reasoned about.** A probe registration was made with
`persistAcrossSessions: true` stated explicitly, under an id the reconciliation can neither restore
nor remove, and the browser was relaunched on the same profile:

| Second session | Probe registration |
|---|---|
| same version (a plain browser restart) | **gone** |
| bumped version (an extension update) | **gone** |

So the comment was not merely wrong about updates — the registration did not survive a new session
at all. That was measured on an unpacked extension under `--load-extension`, which is how the
harness loads it, and it is not proof about a Web-Store-installed build; what it does establish is
that the assumption the old code rested on fails, in at least one ordinary configuration, for the
plainest case it claimed. **The fix deliberately encodes no cause.** Reload, update, restart and
idle respawn all arrive at the same worker spawn, and the reconciliation repairs the state it finds
rather than predicting how it got there.

Measured in a real browser on 2026-08-15, on an origin granted that morning: `window.fetch`
unpatched, `XMLHttpRequest.prototype.open` unpatched, `window.__AGUI_DEVTOOLS__` absent — **before
and after a page reload**, which is what rules out P12's already-known "the document was open before
the grant" case.

### What the panel said, and why it was worse than saying nothing

It rendered P12's banner — *"the capture layer is not loaded in this page"* — and offered **Reload
the inspected page**. Both halves are individually true and the combination is a dead end: the user
reloads, the new document has no content scripts either, the identical banner comes back, and the
reasonable conclusion is that the tool is broken. A remedy that cannot work is worse than no remedy,
for the same reason a warning that is usually wrong is worse than no warning.

### The fix, in two places

**The worker reconciles at module scope.** `chrome.permissions.getAll()` against
`chrome.scripting.getRegisteredContentScripts()`, registering whatever is granted and missing, on
every worker spawn. `onInstalled` + `onStartup` was rejected as insufficient — neither fires when
Chrome respawns a worker it terminated for idleness, which is the most common spawn there is — and
module scope is a strict superset of both. Registration work is serialized so a concurrent `onAdded`
cannot race it, the manifest's own static matches are excluded (`permissions.getAll()` reports them,
and registering a second dynamic copy would inject the capture layer twice), and what the worker
believes is registered is **rebuilt from Chrome** rather than held in memory. That last part fixed a
second latent bug of the same species: the in-memory set came back empty on every respawn, so
revoking an origin after one unregistered nothing and a revoked origin kept being captured.

The `catch` no longer discards everything. A duplicate-id rejection is the end state it wanted and
is not reported; anything else is retained and travels to the panel.

**The panel tells the two states apart.** `RegistrationState` — the dynamically registered match
patterns, plus the last real registration failure — rides on the existing `snapshot` message and on
a `registration` push. `isRegisteredForOrigin` reads it against the inspected origin, answering
`true` for the manifest's static localhost family without consulting it, and `null` while no worker
has answered so the P12 grace period is untouched. When it answers `false` the panel says the
scripts are not registered, names the failure if there was one, and offers **Register the capture
scripts for &lt;origin&gt;**, which sends `reconcile-registrations`. It offers no reload, and the
post-grant reload note is suppressed in that state too — a panel offering both would be
contradicting itself in two paragraphs.

The two states are **sequential, not alternatives**. Registering fixes the ORIGIN; the document that
predates the registration still has no capture layer in it, so the moment the worker answers, P12's
banner takes over and asks for the reload *then* — which is the point at which a reload is true.

The command deliberately carries no origin. The worker takes the list from
`chrome.permissions.getAll()`, so nothing arriving on that port can cause an origin the user never
opted in to to have code injected into it.

### Why no test caught it

Every harness e2e installed a **fresh** extension and granted the origin **inside** the test, so
`onAdded` always fired and the one trigger the worker had always ran. Nothing exercised a second
session against an existing grant — which is every real user's second day. That is the fourth hole
this project has found in its own verification, and the first where the gap was in the FIXTURE
rather than in an assertion.

### The gates

- `packages/devtools/src/sw/index.test.ts`, *"a second session against an existing grant"*: the
  worker's boot path driven with a granted origin and nothing registered, and **no `onAdded` event**.
- `packages/harness/e2e/registration-after-update.spec.ts`: the same sequence in a real browser —
  the registrations unregistered with the grant left in place, the boot path re-run, a page loaded
  and a run driven, and capture has to deliver it. It asserts the fixture as well as the product, so
  an unregister that silently did nothing fails rather than passing everything.
- `pnpm screenshot:panel` photographs the not-registered banner and asserts its wording never says
  *reload*, and that no Reload control is on screen beside it.

All three were mutation-tested: reverting the reconciliation fails the unit tests and the e2e (the
latter with *"capture did not settle … 0 record(s)"*), and reverting the panel's distinction fails
the visual gate with the exact wording that shipped.

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
