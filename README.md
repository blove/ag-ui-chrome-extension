# AG-UI DevTools

A Chrome DevTools extension that captures, decodes, validates, and replays
[AG-UI](https://github.com/ag-ui-protocol/ag-ui) event streams from any page — no SDK, no code
change, no license key.

AG-UI is an event protocol over SSE. When a run misbehaves, the network tab shows you an opaque
`text/event-stream` and `console.log` shows you what the app _thinks_ happened. This tool shows you
the wire: every event in order, grouped into runs, with the protocol violations named and located.

## Status

**Pre-release, and it does not capture anything yet.**

What is implemented and unit-tested (355 tests) is the `core/` layer: the generated event table and
shape checking, the incremental SSE frame parser, AG-UI connection detection, chunk expansion, the
run model, the validator rules, run metrics, the RFC 6902 JSON Patch state timeline, and the
`.agui.jsonl` codec with redaction. `core/` is Chrome-free and runs under Node.

What is **not** implemented: the capture layer. `src/inject/` (the MAIN-world hook that would patch
`fetch`, `XMLHttpRequest`, and `EventSource`), `src/relay/`, `src/sw/`, and the panel UI are stubs.
The extension builds, loads unpacked, and opens an empty **AG-UI** DevTools panel that says
"No capture yet". No page API is patched, no events are buffered, and the five panel tabs of the
spec (Timeline, Session, Messages, State, Issues) do not exist yet. That is the next milestone.

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
- **Redaction on export**, on by default for bug-report bundles: text deltas, reasoning content,
  tool arguments, tool results, and state values become `«redacted: 412 chars»`. Structure, types,
  ordering, sizes, and timings survive — which is what a protocol bug report actually needs. The
  export header records exactly what was redacted. This part is implemented and tested today, in
  `src/core/jsonl/`.
- **Bounded memory.** The capture buffer caps at a configurable default of 5k events / 8 MB, oldest
  dropped.

Points that describe capture behaviour are the design the capture layer must meet; the current
build has no capture path at all, so it reads nothing from any page.

## Development

Requires Node 22+ and pnpm 10.

```bash
pnpm install          # install workspace dependencies
pnpm dev              # watch build for load-unpacked development
pnpm build            # production build → packages/devtools/dist/
pnpm test             # Vitest, node environment
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
pnpm verify:build     # assert dist/ is correct (run after pnpm build)
pnpm screenshot:panel # render dist/ in a real browser and assert it is not blank
pnpm package          # → packages/devtools/ag-ui-devtools-<version>.zip
pnpm gen:events       # regenerate the AG-UI event table from @ag-ui/core
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

### Tests

```bash
pnpm test                                  # run once, whole workspace
pnpm --filter ag-ui-devtools exec vitest   # watch mode
```

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
- no `*.map` files ship.

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

CI runs typecheck, lint, test, build, `verify:build`, and `screenshot:panel` on every push and pull
request. `screenshot:panel` is the gate that catches an unstyled or blank panel — the whole of the
rest of that list once passed on a `dist/` whose panel had no stylesheet at all. Pushing a
`v*` tag runs the same checks and attaches `ag-ui-devtools-<version>.zip` to a GitHub release.
Chrome Web Store upload is manual.

## License

MIT. See [LICENSE](./LICENSE).

## Credits

Built and maintained by the [Threadplane](https://threadplane.com) team. The tool is deliberately
framework-neutral: it works against any AG-UI stream — CopilotKit, the AG-UI Dojo, a hand-rolled
server — and requires nothing from Threadplane.
