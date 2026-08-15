# AG-UI DevTools — Chrome Web Store Listing Design

**Date:** 2026-08-15
**Requirements:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md) §11, §12
**Prior design:** [`2026-08-14-panel-ui-design.md`](2026-08-14-panel-ui-design.md)
**Reference:** [Chrome Web Store — best listing practices](https://developer.chrome.com/docs/webstore/best-listing?hl=en)
**Status of the codebase:** `core/` and the capture layer are landed and e2e-covered. Of the five
panel tabs, **Timeline** and **Session** are real; **Runs**, **State**, and **Messages** render
`.agui-coming` placeholders. There are no image assets in the repository at all — no icon, no
`icons` block in `manifest.config.ts`, and therefore no possible CWS upload today.

This document designs the listing and the pipeline that generates it. It does not design any
product feature, and it does not itself submit anything to the store.

---

## 1. Decisions

| # | Decision | Rationale |
|---|---|---|
| L1 | **Build the pipeline now; submit later.** The generator is repo infrastructure that regenerates every asset from the real build | Three of five tabs still say "coming soon". Store screenshots are the first and often only thing a developer evaluates, and a gallery containing an empty placeholder tab is worse than no listing. Building the pipeline first means the assets are correct the day the product is whole, instead of being a rushed pass at submission time. |
| L2 | **Screenshots render a purpose-built demo fixture**, committed and deterministic | `happy-run.agui.jsonl` is 15 events and `malformed.agui.jsonl` is a validator unit test. Neither reads as a product in a screenshot. A recorded Tier B fixture is authentic but passes through `redact.ts`, so every payload string photographs as `«redacted: N chars»` — the opposite of a compelling shot. |
| L3 | **Each screenshot is a captioned frame**: real panel pixels inset on a 1280×800 canvas with one headline | CWS guidance is one message per screenshot. The panel alone is a dense grey table that carries no message to someone who has not yet been told what AG-UI is. Only the surround is marketing; the panel itself is the genuine build. |
| L4 | **The mark is an event-tick stream on a filled tile**, not a transparent glyph | The toolbar renders icons over both light and dark chrome, so a bare mark disappears in one of them. Ticks of varying height with one in error red encode the actual differentiator — the validator finds the bad event — and survive 16px as a silhouette. |
| L5 | **Listing copy is a versioned source-of-truth file with a length/format validator** | Every CWS-constrained field has a limit that is discovered at the upload form otherwise. Keeping copy in the repo also makes it reviewable in a PR alongside the behaviour it describes. |
| L6 | **Extract a shared panel harness; keep the visual gate's contract unchanged** | `screenshot-panel.mts` exists to *fail the build*. Asset generation has the opposite contract — it always succeeds and writes files. Merging them would give one 600-line file two contradictory jobs. |
| L7 | **CWS API upload is out of scope**, deferred until after the first manual submission | The API needs OAuth client credentials and an existing item ID, and the item ID does not exist until a human has submitted once. Automating publication before that is automating a path nobody has walked. |
| L8 | **Claim-verification against `dist/manifest.json` and a CI drift gate are out of scope** | Both fit the repo's house style and both are natural follow-ups. Explicitly deferred by the user for this pass; recorded here so the omission reads as a decision rather than an oversight. See §8. |

---

## 2. Pipeline shape

```
packages/devtools/
  listing/
    icon.svg                    # single source for every raster size
    copy.md                     # store copy: YAML front matter + markdown body
    frames/
      screenshot.html           # caption frame: headline band + panel iframe
      tile.html                 # 440×280 small promo tile
      marquee.html              # 1400×560 marquee
    fixtures/
      demo.agui.jsonl           # committed output of scripts/build-demo-fixture.ts
    out/                        # generated and committed: the exact PNGs uploaded to CWS
  scripts/
    panel-harness.ts            # EXTRACTED from screenshot-panel.mts
    screenshot-panel.mts        # unchanged contract: the visual gate
    render-icons.mts            # icon.svg -> public/icons/*.png; runs BEFORE the build
    build-demo-fixture.ts       # generator for the demo capture
    listing-assets.mts          # writes listing/out/*.png; runs AFTER the build
    verify-listing-copy.ts      # asserts every CWS field limit
```

**All TypeScript lives in `scripts/`**, not in `listing/`: `tsconfig.json` includes only `src`,
`scripts`, and the config files, and the Vitest projects only cover `src/**` and `scripts/**`. A
generator under `listing/` would be neither typechecked nor testable. `listing/` holds data and
assets only.

**Icons and screenshots are separate scripts** because they sit on opposite sides of `pnpm build`:
icons are *source* that Vite copies out of `public/`, so they must exist before it; screenshots read
`dist/`, so they must run after it.

**`panel-harness.ts`** is a pure extraction — no behaviour change. It takes the three pieces
`screenshot-panel.mts` already has and that the asset generator needs verbatim:

- `startServer(root)` — a local static server over `dist/`, because ES modules will not load over
  `file://`.
- `CHROME_SHIM` — enough of `chrome` for the panel bundle to boot outside DevTools.
- `openPanel(browser, origin, options)` and `importFixture(scope, file)` — open the panel at a colour
  scheme and load a capture through the panel's own file input, exactly as a user would. `options`
  defaults to the gate's historical values, and `scope` is a `Page` **or** a `FrameLocator`, so the
  same helper drives a panel embedded in a composing frame.

The gate keeps its own assertions, its own failure list, and its own `main()`. The extraction is
verified by the gate continuing to pass unchanged, including against a deliberately unstyled build
via `PANEL_DIST`.

**Rendering mechanics.** Playwright only; no new dependency.

- *Icons.* Load `icon.svg`, set the viewport to the target square, screenshot with
  `omitBackground: true`. Emitted at 16, 32, 48, 128. Icons are the one output written **outside**
  `listing/out/` — they go to `packages/devtools/public/icons/`, because they ship in the bundle
  rather than being uploaded to the store form. `icon-128.png` doubles as the CWS store icon.
- *Screenshots and tiles.* Compose an HTML document that embeds the live panel in an iframe pointed
  at the local `dist/` server, drive the panel through the harness to the state the shot needs, then
  screenshot the composed document. Shot at `deviceScaleFactor: 2` and downsampled through an
  in-page canvas pass to the exact required pixel dimensions, so panel text stays retina-sharp at
  1280×800 rather than being rendered at 1×.

CWS accepts 1280×800 or 640×400 for screenshots; the pipeline emits 1280×800 only.

---

## 3. The mark

A rounded-square tile filled `--agui-accent` (`#1a73e8`), carrying **four** white vertical rounded
ticks of varying height that read left-to-right as a stream. The third tick is the tallest and is
rendered in `--agui-severity-error`'s **dark-scheme** value (`#f28b82`).

Two corrections against the first draft of this section, both found by rendering rather than by
reasoning. *Four* ticks, not six: at 16px a tick is `width/128*16` px wide, so six render as ~1.2px
bars with sub-pixel gaps and turn to mush; four render ~1.9px with ~1.1px gaps and survive. And the
dark-scheme red, not the light-scheme `#b3261e`, which is near-unreadable against this blue at
16px.

Authored once as `listing/icon.svg` on a 128×128 viewBox with no rasterisation-dependent detail:
stroke widths, corner radii, and tick spacing are chosen so the 16px render is a legible silhouette
plus one red bar. Colours are the panel's own tokens, so the icon cannot drift from the product's
palette by accident.

The `icons` block is added to `manifest.config.ts` referencing `icons/icon-{16,32,48,128}.png`, and
the generated PNGs are written to `packages/devtools/public/icons/`, which Vite copies to `dist/`
verbatim. This closes the blocker that
[`public/icons/README.md`](../../../packages/devtools/public/icons/README.md) has been carrying.

---

## 4. The demo fixture

`listing/fixtures/demo.agui.jsonl`, produced by `scripts/build-demo-fixture.ts` and committed. Events are
constructed through the real generated event table rather than hand-typed, so a fixture that would
not decode cannot be written.

**Run 1 — clean, and the reason the tool looks good.** A user turn, streamed assistant text, a
`lookup_order` tool call with plausible arguments, a tool result, `STATE_DELTA` patches that
actually mutate a small order object, step boundaries, and `RUN_FINISHED`.

**Run 2 — one genuine violation.** A single real protocol error the validator names and locates, so
the issue badge reads a non-zero count and shot 2 has something true to show.

Constraints: 35 events (enough to fill the timeline, few enough to read), a fictional
domain, no real product names, no credentials, no content that would need redacting. Deterministic —
identical bytes on every regeneration, so the fixture is diffable in review.

---

## 5. Storyboard

Five screenshots, one message each, hero first.

| # | Caption | What is on screen | Renderable today |
|---|---|---|---|
| 1 | Every AG-UI event, decoded and in order | Timeline with the waterfall and an event detail pane open on a tool call | ✅ |
| 2 | Protocol violations, named and located | The flagged row selected in context, detail showing the rule | ✅ |
| 3 | Watch state rebuild, patch by patch | State tab, RFC 6902 patch timeline | ✅ since the State tab shipped |
| 4 | Record a run. Replay it anywhere. | The export panel: §11's five redaction groups, and the `.agui.jsonl` download | ✅ since the export panel shipped |
| 5 | No network egress. Ever. | The capture banner over an empty panel: `Enable capture for https://app.example.com` | ✅ since the `devtools-ungranted` shim |

**This table has been wrong four times, in both directions.** It first claimed 4 and 5 were
renderable and building them proved otherwise; it then listed 3 as blocked and the State tab
shipped, at which point the generator produced that shot with no change to this pipeline at all;
then it recorded shot 4 as blocked on harness work that could never have unblocked it; and finally
it said shot 5 needed a *live, granted* source, when what it actually needed was the opposite — an
UNGRANTED one. Every correction is kept rather than smoothed away, because this is the table
someone reads to plan the submission — and because the second one is the evidence that L1 works:
the gallery filled itself in as the product caught up.

**Shot 4's blocker was mis-diagnosed, not merely unfinished.** This document previously said the one
thing still refusing it was the harness shim, which leaves capture reporting `unavailable in this
build` no matter what the product ships. That analysis was incomplete. The shot was gated by a scan
for unbuilt-capability wording *anywhere* in the Session tab, and two of the strings tripping it are
hardcoded rows — `Endpoints` and `Agents` both read `ships with the capture layer`
(`session.tsx:154,156`) — so no shim, however rich, could ever have cleared that gate. The scan was
over-broad for this caption besides: endpoint and `/info` discovery say nothing about export or
replay, so they were never a contradiction of it.

The fix was to re-subject the shot, and needed no new product work. It now frames the **export
panel** — §11's five redaction groups, the summary of what the file will contain, and the
`.agui.jsonl` download — and gates on that panel actually offering an export: no
`.agui-export__blocked`, an enabled download button labelled with the extension, and all five group
checkboxes enabled. The tab is scrolled with the panel's own scroller so the export section, not the
status rows, fills the card. That framing also made this shot byte-reproducible for the first time,
because the Source row's `(imported 11:36:29 AM)` wall clock now sits above the fold. Its sub-caption
was rewritten to describe the redaction choice that is now on screen; the headline still carries the
round trip.

**Shot 5's blocker was the frame, not the product.** It was recorded here as needing "a live,
granted source", and that was backwards. `CaptureBanner` returns `null` outright for an imported
source (`capture-status.tsx:54`) and renders no control at all while capture is `unsupported` — so
what the shot needed was an inspected origin that has NOT been granted, and no fixture. Both were
reachable without touching the product:

- **A second harness shim, `devtools-ungranted`.** It adds exactly one call to `no-devtools`:
  `chrome.devtools.inspectedWindow.eval`, answering `location.origin` with the RFC 2606 reserved
  `https://app.example.com` and `null` to anything else. That is the whole API `resolveOrigin`
  (`app.tsx:32`) uses to name the inspected page, and naming it is what moves capture from
  `unsupported` to `off`. `chrome.permissions`, `chrome.devtools.network` and
  `chrome.runtime.connect` stay absent — each is a branch the panel already handles honestly, and
  faking a service-worker port would mean staging capture in the one shot about not capturing.
- **No fixture.** Shot 5 is the one storyboard entry that imports nothing, which is what lets the
  banner render at all.

What is left is the extension's honest first-run state: an empty panel offering to enable capture on
a site. The empty timeline is the **subject**, not a shortcoming — the tool ships inert and asks
before it does anything, and a frame full of somebody's captured prompts under "No network egress.
Ever." would argue the opposite.

The shot **drops the whole-tab unbuilt-capability scan entirely**, and that scan is now deleted from
`listing-assets.mts` rather than left unused. It was shot 5's second gate while shot 5 photographed
the Session tab; the frame is now the Timeline, `.agui-session` is not in the image, and a gate
looking at a tab its shot never opens is the same defect this document already records twice. The
one gate left checks exactly one `.agui-banner__action` reading `Enable capture for <origin>`.

The sub-caption changed with the framing. "Nothing is uploaded, synced, or persisted to disk" was
written for a Session-tab frame; the toolbar is in this one, `Export (unredacted)` with it, and a
flat no-disk claim over a visible export control is a caption arguing with its own pixels. It now
reads "Per-origin opt-in, offered up front. No remote host permissions, no fetch, no telemetry." —
`copy.md`'s own list under this same headline, every clause asserted by `pnpm verify:build`. It
stops short of "capture is off until you grant an origin", which is false for the localhost family.

`listing-assets.mts` **fails loudly** when a storyboard entry's required UI is absent, and a
refused shot deletes its own stale asset, so the directory can never claim a delivery the run
denied. All five render today, so the script now exits 0 — that is the L1 gallery filling in, not
the gates being relaxed; both of shot 5's failure paths (the shim reverted, and a localhost origin
that auto-enables straight to `on`) were re-verified to refuse and delete. Shot 2 is deliberately
*not* filtered to the flagged row: "located" is a claim a one-row list cannot make.

Promo tiles carry the mark, the name, and the summary line: 440×280 small tile, and a 1400×560
marquee that is only used if the store features the item but costs nothing to emit alongside.

---

## 6. Copy

`listing/copy.md` — YAML front matter for the fields CWS constrains, markdown body for the one it
does not.

```yaml
title:              # ≤ 75 chars
summary:            # ≤ 132 chars, plain text, no HTML
category: Developer Tools
language: en
single_purpose:     # Privacy tab
permissions:
  storage: …
  scripting: …
  optional_host_permissions: …
uses_remote_code: false
privacy_policy_url: …
```

**Summary** (126 chars):

> Inspect, validate, and replay AG-UI agent event streams from any page. No SDK, no code change, no
> data leaves your browser.

**Detailed description**, five blocks, ~2,000 of the available 16,000 characters:

1. The hook — what it is in one sentence.
2. Why the Network panel and in-app inspectors fail: an SSE body with no decoding, no run grouping,
   no validation; and inspectors that ship in your bundle, are framework-specific, or need a dev-mode
   runtime.
3. What it does: capture from `fetch` / `XHR` / `EventSource`, decode SSE framing, group into runs
   and threads, validate protocol invariants, reconstruct state, measure timings, export and replay.
4. The privacy posture, stated as verifiable fact rather than reassurance. This block does the most
   work in the whole listing, because it is the claim no competing tool can make.
5. Open source, MIT, repository link.

**Permission justifications**, each written to the reviewer's actual question:

| Permission | Justification |
|---|---|
| `storage` | Per-origin capture opt-in and panel preferences only. Captures live in `chrome.storage.session`, which Chrome clears on browser close. |
| `scripting` | Registers the capture content scripts at runtime on origins the user has granted. Required precisely *because* the extension ships with no static remote host permissions. |
| `optional_host_permissions` | Requested one origin at a time, on an explicit click, to read SSE response bodies the page is already receiving. |
| Remote code | No. |

**Single purpose:** capture and inspect AG-UI protocol event streams on pages the user explicitly
enables, for debugging.

`verify-listing-copy.ts` parses the file and fails on any limit breach, any empty required field, or
any permission present in `manifest.config.ts` without a justification entry.

---

## 7. Dependencies outside this pipeline

Two prerequisites for submission that this design does not itself deliver, named here so they are
not discovered at the upload form:

1. **A privacy policy at a stable URL.** Simplest honest answer is `PRIVACY.md` in the repository,
   linked by permalink — which requires the repository to be public.
2. **[`README.md`](../../../README.md) is stale.** It still says the extension "does not capture
   anything yet", several commits after capture landed and was e2e-covered. It is the first thing a
   reviewer or a developer clicks through to from the listing. Fixing it is not part of this
   pipeline, but it should not trail it.

---

## 8. Deliberately not built

Per L7 and L8:

- **CWS API upload.** Revisit once an item ID exists.
- **Listing claims verified against `dist/manifest.json`.** The natural extension of
  `verify-build.ts`: if someone adds a permission, the listing should fail rather than quietly
  become a false statement to reviewers.
- **CI drift gate.** Regenerating assets in CI and failing when the committed PNGs disagree with the
  current build, so screenshots cannot go stale against the UI they depict.

The first is sequenced. The second and third are scope choices, and both remain good ideas.

Added during implementation, from review of §6:

- **A `status:` field in `copy.md` that the validator refuses to let be `draft` at submission.**
  The copy deliberately describes the finished product — export, State, Messages, metrics — while
  several of those do not exist yet. That is L1 working as designed, and the *asset* generator
  already refuses loudly. But `verify-listing-copy.ts` will print "within every Chrome Web Store
  limit" forever without ever knowing that the document it blessed describes software that has not
  shipped, and nothing in `copy.md` records the gap either. One field would close the loop. It is a
  new requirement rather than a defect, so it is recorded here rather than built.
