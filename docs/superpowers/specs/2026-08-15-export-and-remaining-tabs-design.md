# Export and the remaining tabs — design

**Date:** 2026-08-15
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §9, §10, §11, §12, §13
**Panel design:** [`2026-08-14-panel-ui-design.md`](2026-08-14-panel-ui-design.md)
**Status:** Timeline and Session ship. Runs, State and Messages are `ComingNext` placeholders.
Export does not exist in any form.

This closes phase 1. It is four milestones in one design because they share one substrate; each
ships as its own PR.

---

## 1. What this finishes

Measured against §13's "Done when", the prototype currently meets four and a half of eight:

| # | Criterion | Today | After |
|---|---|---|---|
| 1 | Decoded events, correct run grouping, no config | ✅ | ✅ |
| 2 | `/info`-derived agent metadata in Session before any run | ❌ | ❌ — see §7 |
| 3 | Streaming text reconstructs, chunk expansion both ways | ✅ | ✅ |
| 4 | Tool args accumulate **and** State scrubs snapshot + patches | ½ | ✅ |
| 5 | Malformed fixture → exactly three validator entries | ✅ | ✅ |
| 6 | Export a run, clear, re-import, tabs identical | ❌ | ✅ |
| 7 | Redacted export has no message text, still validates and renders | ❌ | ✅ |
| 8 | Capture off on non-localhost until enabled | ✅ | ✅ |

Two of the four gaps are the same missing feature, which is why export goes first.

## 2. The substrate, and what it means

Every one of these four is **presentation over data `core/` already computes and tests**:

| Tab | Reads | Already built |
|---|---|---|
| Export | `CaptureRecord[]`, `Run.recordSeqs`, `encodeJsonl`, `redactLine` | all of it |
| Messages | `Run.messages`, `Run.toolCalls` | `run-builder` |
| State | `Run.stateTimeline: StateFrame[]` | `state/timeline`, `json-patch` |
| Runs | `Run`, `RunMetrics`, `Run.issues` | `run-metrics`, validator |

**Decision T0 — if a tab needs data `core/` does not compute, it goes in `core/` with tests, not
into a component.** `core/` is Chrome-free so it can be reused in a CLI or a VS Code panel (§13),
and a selector computed inside a `.tsx` is one that cannot follow. No `core/` change is *expected*
here; this decides what to do if one turns out to be needed.

---

## 3. Export

### Decisions

| # | Decision | Rationale |
|---|---|---|
| **E1** | **Blob + object URL + a programmatic anchor. No `downloads` permission.** | The manifest is `permissions: ['storage', 'scripting']` and §11 forbids widening it for convenience. A `Blob` and `URL.createObjectURL` need no permission at all. **Risk:** programmatic download from a DevTools panel document is unverified — the visual gate must assert a real click produces a real file, because this is exactly the class of thing that passes every unit test and fails in the product. |
| **E2** | **Re-encode from records; never pass bytes through.** | One code path for live and imported captures. Done-when #6 asks that a re-import be *identical in the tabs*, which is semantic identity — provable by round-trip — not byte identity. Byte-passthrough would need a second path that only imported captures exercise. |
| **E3** | **`header.redacted` is cumulative, never replaced.** | Re-exporting an already-redacted file must union the original header's groups with the ones applied now. **You cannot un-redact.** A header claiming `redacted: ["state"]` on a file whose text was already replaced upstream is a lie a colleague will act on. Gets its own test. |
| **E4** | **Five modes**, per §10: full · single run · redacted bug report · clipboard JSON · fixture export. | Single run filters on `Run.recordSeqs`. "Redacted bug report" is a *modifier* on the first two, not a third scope — modelled as `{ scope, groups }` so the combinations cannot drift apart. |
| **E5** | **Two surfaces, one implementation.** Toolbar = one click: current scope, **unredacted**, and labelled as such. Session tab = full control: mode, group checkboxes, and a statement of what will be included. | §9 puts export in both places. The toolbar is the developer exporting their own capture for themselves, where a silently-redacted file would be useless; §10 lists "full" and "redacted bug report" as separate modes for this reason. Redaction is therefore a deliberate act, never a default — and the toolbar says "unredacted" so it is never a surprise either way. Two call sites of one function; no duplicated policy. |
| **E6** | **A redacted export is gated by an independent leak check in tests**, modelled on the harness's `leakedValues`. | `redact.ts`'s first consumer shipped a hole that its own tests could not see (harness design §10, found 2026-08-15). Export is its second consumer and the one aimed at *sharing a file with another person*. The check restates §11 rather than importing the redactor, so it fails when the redactor stops covering a field. |
| **E7** | **Fixture export stays minimal**: a `.ts` file with the event array plus an `@ag-ui/client` scaffold. | §10 asks for it; §14.2 grows it into `MockAgentTransport`, which is the high-value version. Building the elaborate one now guesses at a Phase 2 seam. |

### Shape

```
panel/export/
  build.ts        records + scope + groups -> JsonlLine[]   (pure, no DOM)
  header.ts       header construction, incl. E3's cumulative `redacted`
  filename.ts     agui-<host>-<ISO>.agui.jsonl
  download.ts     the only file that touches Blob/anchor/clipboard
  fixture.ts      JsonlLine[] -> TypeScript fixture text
  export-panel.tsx  the Session-tab controls
```

`build.ts` is pure and holds all the policy, so the interesting behaviour — scoping, redaction,
cumulative headers — is testable in Node with no DOM. `download.ts` is the thin, hard-to-test
edge, and is kept deliberately small for that reason.

### Data flow

```
PanelState ──▶ build(scope, groups) ──▶ JsonlLine[] ──▶ encodeJsonl ──▶ string
                     │                                                    │
                     │ redactLine per line (E3 header union)              ├─▶ download.ts ─▶ file
                     ▼                                                    └─▶ clipboard
              Run.recordSeqs filter                                fixture.ts ─▶ .ts text
```

### Errors

Export is local and synchronous; the failure modes are small and specific. An empty capture
disables the control with a reason rather than producing a zero-record file. A clipboard write can
be refused by the browser, and that is reported inline rather than swallowed — a silent no-op on
"copy" is indistinguishable from success, which is the failure class this project keeps meeting.

---

## 4. Messages

The "is the bug in my UI or in the stream?" tab (§9.4). Its value is entirely in being a faithful
render of **what the wire said**, so any divergence from the page is attributable.

| # | Decision |
|---|---|
| **M1** | Conversation ordered by `startedAtMs`, with each run's `toolCalls` inline at their position. |
| **M2** | A tool call shows its name, its streamed arguments, **whether those arguments currently parse**, and its result. Args and result are independently expandable. A tool call whose args never parsed is the bug this tab exists to make obvious. |
| **M3** | Reasoning messages are visually distinct and collapsed by default — long, and usually not what you came for. |
| **M4** | A message with `closed: false` is labelled streaming. It is a real state; rendering it as though it were complete would misrepresent a run that is still going, or one that never terminated. |
| **M5** | Clicking a message selects its `contentSeqs` in Timeline. This is the whole workflow: see it wrong here, jump straight to the frames that produced it. |

## 5. State

| # | Decision |
|---|---|
| **S1** | A scrubber over `Run.stateTimeline`; the selected frame renders its `value` as a JSON tree. |
| **S2** | A `delta` frame also shows its `patch` ops. A frame carrying `failure` marks the failing op at `failure.opIndex`, with `failure.reason`. |
| **S3** | Failed frames are red at their **position on the scrubber**, per §9.3 — the point is to see *when* state broke without scrubbing to find it. |
| **S4** | The JSON tree is a new `common/json-tree.tsx`: collapsible, and lazy below a depth threshold so a large state object cannot freeze the panel. Messages reuses it for args and results. Adopting it in Timeline's existing detail pane is **out of scope** — that is working code, and swapping it here would be unrelated refactoring. |

## 6. Runs

| # | Decision |
|---|---|
| **R1** | Table with §9.2's columns: thread, agent, outcome, duration, TTFT, event count, issue count — all from `Run`, `RunMetrics`, `Run.issues` and `Run.recordSeqs`. |
| **R2** | Clicking a row scopes to that run and switches to Timeline. |
| **R3** | Virtualized via the existing `common/virtual-list`. §9 requires virtualization, the component is built and tested, and `preserve on navigate` lets runs accumulate across a long session. |

## 7. Explicitly out of scope

- **`/info` agent discovery** (done-when #2). There are two candidate paths and they are not
  equivalent. **Passive**: the app calls `/info` itself and we capture the response the same way
  we capture a run — `core/detect/classifier.ts` already carries an `INFO_RE` route hint, and this
  costs nothing under §11 because the extension initiates nothing. **Active**: the extension
  fetches `/info`, which collides head-on with §11's "no network egress from the extension, ever".
  The passive path is obviously preferable and may well be sufficient — but done-when #2 requires
  the metadata *before any run*, so it hinges on whether real apps call `/info` early enough and
  reliably enough. That is a measurement, not a design decision, and it belongs in its own
  milestone rather than smuggled in beside four presentation ones.
- **Protobuf decoding** — §5.4 defers it to Phase 3.
- **All of §14 Phase 2**, including the `MockAgentTransport` fixture export that E7 leaves room for.
- **Refactoring Timeline's detail pane** onto the new JSON tree (S4).

## 8. Testing

Standard for every milestone here: unit tests in the `panel` project, plus a **screenshot
assertion in the visual gate for each new tab**.

That last one is not ceremony. This project has shipped a panel with no stylesheet at all — black
on black, invisible, with typecheck, lint, tests, build and `verify:build` all green — and a
virtual list that rendered blank on shrink while thirteen tests passed. Both were caught by
looking. A tab that renders nothing and a tab that renders correctly are indistinguishable to
every gate except the one that draws pixels.

Each tab is additionally tested against: empty state, an imported capture, a live capture, a
**redacted** capture (placeholders where content would be), and a run carrying issues.

Export adds the E6 leak check, and a round-trip test that is the literal statement of done-when
#6 — export a run, clear, re-import, assert the resulting state matches.

## 9. Sequencing

Export → Messages → State → Runs, one PR each, merged on green.

Export first because it closes two done-when criteria rather than one, and because it gives
`redact.ts` the second consumer it was designed for. Messages before State because it is the tab
with the clearest diagnostic story. Runs last because it is the cheapest and the most nearly
covered by Timeline's existing run selector.

**Ordering constraint:** an in-flight change adds instrumentation detection across `inject/`,
`relay/`, `sw/` and `panel/capture/`, touching `app.tsx`. Export touches `app.tsx` and
`shell/toolbar.tsx`. Export starts after that lands.
