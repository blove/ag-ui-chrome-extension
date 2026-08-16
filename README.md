# AG-UI DevTools

A Chrome DevTools extension that captures, decodes, validates, and replays
[AG-UI](https://github.com/ag-ui-protocol/ag-ui) event streams from any page — no SDK, no code
change, no license key.

AG-UI is an event protocol over SSE. When a run misbehaves, the network tab shows you an opaque
`text/event-stream` and `console.log` shows you what the app _thinks_ happened. This tool shows you
the wire: every event in order, grouped into runs, with the protocol violations named and located.

## Status

**Pre-release, and phase 1 is functionally complete.** Not yet on the Chrome Web Store.

Capture works end to end: `src/inject/` patches `fetch`, `XMLHttpRequest`, and `EventSource` in the
page's own world, tees the SSE bodies, and relays them across the world boundary to a service-worker
ring buffer that the panel reads live. All five panel tabs are real — **Timeline**, **Runs**,
**State**, **Messages**, **Session** — with protocol issues annotated inline and a toolbar issue
count that doubles as a filter. Captures export and re-import as `.agui.jsonl`, redacted or not.
On a page backed by a CopilotKit runtime, Session also names the runtime's version, its mode and the
agents it reports, read passively from the `/info` response the page's own client fetches when it
connects — so the agent list is there before any run. Most AG-UI apps have no CopilotKit runtime and
never make that request, and Session says so without implying anything is wrong.

Underneath, `core/` is Chrome-free and runs under Node: the generated event table and shape
checking, the incremental SSE frame parser, connection detection, chunk expansion, the run model,
the validator rules, run metrics, the RFC 6902 JSON Patch state timeline, and the `.agui.jsonl`
codec with redaction. 1,501 tests, plus a Playwright harness that drives the extension in a real
browser against real sockets.

What is not done: the Chrome Web Store submission itself. The listing pipeline is built and all five
of its screenshots render — see [Store listing assets](#store-listing-assets).

## Privacy

The tool sits on the wire where prompts and completions flow, so its posture is non-negotiable:

- **No egress.** No `host_permissions` for any remote origin, no fetch from the service worker or
  the panel, no telemetry, no update pings, no crash reporting. Verifiable by reading
  `packages/devtools/dist/manifest.json`: no `debugger` permission, no `webRequest`, no static host
  permissions — only `optional_host_permissions`, which the user grants per origin.
  `pnpm verify:build` asserts all of that against the built artifact.
- **Opt-in per origin.** The extension ships inert. `localhost`, `127.0.0.1`, and `0.0.0.0` are the
  only statically registered content-script matches; any other origin is designed to take one click
  and a reload, registered at runtime via `chrome.scripting.registerContentScripts`.
- **No persistence by default.** Capture is designed to live in memory with a
  `chrome.storage.session` mirror that Chrome clears on browser close. Nothing touches disk unless
  you export.
- **Headers are never captured** except `content-type`. `Authorization` and cookies are never read,
  never stored, never exported.
- **Redaction on export is opt-in, and off by default.** Text deltas, reasoning content, tool
  arguments, tool results, and state values can each be replaced with `«redacted: 412 chars»`;
  structure, types, ordering, sizes, and timings survive, which is what a protocol bug report
  actually needs, and the export header records exactly what was redacted. Until you select a
  group the control reads **Export (unredacted)** and the file carries the real content of the
  streams you captured — so treat a capture you are about to share the way you would treat the
  conversation it came from.
- **Bounded memory.** The capture buffer caps at a configurable default of 5k events / 8 MB, oldest
  dropped.

The full policy, including how to verify each claim yourself, is in [PRIVACY.md](./PRIVACY.md).

## Development

Requires Node 22+ and pnpm 10. `pnpm icons` and `pnpm screenshot:panel` drive a real headless
Chromium and need it installed once, after `pnpm install`:
`pnpm exec playwright install chromium-headless-shell`.

```bash
pnpm install          # install workspace dependencies
pnpm dev              # watch build for load-unpacked development
pnpm build            # production build → packages/devtools/dist/
pnpm test             # Vitest, node environment
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
pnpm verify:build     # assert dist/ is correct, and public/icons/ fresh (run after pnpm build)
pnpm screenshot:panel # render dist/ in a real browser and assert it is not blank
pnpm package          # → packages/devtools/ag-ui-devtools-<version>.zip
pnpm gen:events       # regenerate the AG-UI event table from @ag-ui/core
pnpm icons            # listing/icon.svg → public/icons/*.png (run BEFORE build)
pnpm listing:fixture  # regenerate the demo capture the screenshots use
pnpm listing:assets   # → packages/devtools/listing/out/*.png (run AFTER build)
pnpm verify:listing   # assert the store copy fits every CWS field limit
```

`pnpm package` requires an existing `dist/`, so the release sequence is
`pnpm build && pnpm verify:build && pnpm package`. Packaging shells out to the platform `zip` CLI
(no extra dependency) and names the archive from `packages/devtools/package.json`'s version.

### Load unpacked

1. `pnpm build`
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → select `packages/devtools/dist`.
4. Open DevTools on any `http://localhost` page; the **AG-UI** panel is in the tab strip (behind
   the `»` overflow if the strip is full).

Chrome 111+ is required: the manifest declares a `world: 'MAIN'` content script, which older Chrome
silently ignores.

### Store listing assets

Everything the Chrome Web Store form needs is generated from the build, in this order — icons are
*source* (Vite copies `public/` into `dist/`), screenshots read `dist/`, so they sit on opposite
sides of `pnpm build`. `listing:assets` exits non-zero the moment a storyboard shot's subject goes
missing, so run each command on its own line rather than chaining with `&&`, or a refusal will take
`verify:listing` down with it.

    pnpm icons
    pnpm build
    pnpm listing:assets
    pnpm verify:listing

Copy lives in `packages/devtools/listing/copy.md`; the generated upload set lands in
`packages/devtools/listing/out/`. `pnpm listing:assets` fails while any storyboard shot's subject is
unreachable, rather than quietly shipping a short gallery, and a refused shot deletes its own stale
PNG so the directory can never claim a delivery the run denied. **All five shots render today**, so
the command exits 0 — which is the gallery having caught up with the product, not the gates being
relaxed. The last one to land was the privacy shot: its subject is the per-origin capture grant
offer, and what it needed turned out to be an *un*granted origin and no imported capture, so the
frame is the extension's honest first-run state. See
[the listing design](docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md).

### Tests

```bash
pnpm test                                  # run once, whole workspace
pnpm --filter ag-ui-devtools exec vitest   # watch mode
```

`pnpm test` runs the two packages **one after the other** (`--workspace-concurrency=1`), not at
once. The harness package drives a real browser and asserts on wall-clock arrival times, and
running it alongside the devtools unit suite made it measure a machine with no spare cores: the
capture path was observed lagging by tens of seconds, and the capture e2e failed intermittently
because of it. The serial run costs about ten seconds and buys a gate whose failures mean
something.

Tests live next to their sources as `*.test.ts` and run under Node — `src/core/` contains no Chrome
APIs, which is enforced by an ESLint rule and by a check that no `chrome.` reference survives into
`core/`'s build output. That boundary is also what lets `core/` be lifted into a CLI or a VS Code
panel later.

### Verifying the build output

`pnpm verify:build` runs against a real `dist/` and asserts what typecheck, lint, and unit tests
structurally cannot see:

- each manifest entry point's **emitted chunk contains the code it should** — the MAIN-world script
  carries the `__AGUI_DEVTOOLS__` marker and no `chrome.runtime` reference, the ISOLATED relay
  carries its message listener, the service worker carries its `onConnect` handler;
- the manifest privacy invariants above;
- `panel.html` and `devtools.html` reached `dist/`;
- no `*.map` files ship;
- `public/icons/*.png` are fresh against `listing/icon.svg` — checked by comparing a committed
  SHA-256 of the source SVG, not by re-rendering, so this needs no browser and is identical on
  every platform.

This exists because a real regression got through everything else: two entry points shared the
basename `index.ts`, CRXJS keys emitted scripts by basename, and the MAIN-world content script was
silently pointed at the **service worker's** chunk. The build exited 0 and every other gate passed
on an extension that threw on every page load. Keep entry-point basenames distinct.

### Keeping up with the protocol

AG-UI is pre-1.0 and still moving. `@ag-ui/core` is a **devDependency only** — no Zod in the shipped
bundle, no version coupling. The event-shape table is generated from its Zod schemas and committed:

```bash
pnpm gen:events
git diff --stat packages/devtools/src/core/events/event-table.generated.ts
```

A clean diff means the protocol has not moved. A non-empty diff is the chore: review it, run
`pnpm test`, and commit the regenerated table. Unknown event types always render as warnings, never
errors, so a protocol addition degrades gracefully between regenerations.

## Releases

CI runs typecheck, lint, test, build, `verify:build`, `verify:listing`, and `screenshot:panel` on
every push and pull request. `screenshot:panel` is the gate that catches an unstyled or blank
panel — the whole of the rest of that list once passed on a `dist/` whose panel had no stylesheet
at all. Pushing a `v*` tag runs the same checks and attaches `ag-ui-devtools-<version>.zip` to a
GitHub release.
Chrome Web Store upload is manual.

## Contributing

Pull requests welcome — start with [CONTRIBUTING.md](./CONTRIBUTING.md), which covers the setup, the
gates CI runs, and the four conventions that explain most review comments here. Participation is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).

Found a security problem? Please follow [SECURITY.md](./SECURITY.md) rather than opening a public
issue.

## License

MIT. See [LICENSE](./LICENSE).

## Credits

Built and maintained by the [Threadplane](https://threadplane.ai) team. The tool is deliberately
framework-neutral: it works against any AG-UI stream — CopilotKit, the AG-UI Dojo, a hand-rolled
server — and requires nothing from Threadplane.
