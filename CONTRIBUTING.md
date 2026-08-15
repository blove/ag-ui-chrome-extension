# Contributing

Thanks for looking. This is a small, opinionated codebase, and the opinions are mostly about
verification. Reading this first will save you a round of review.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Contributions are
accepted under the [MIT License](./LICENSE).

## Getting set up

Node 22+ and pnpm 10.

```bash
pnpm install
pnpm exec playwright install chromium-headless-shell   # once; the browser-driven gates need it
pnpm build
```

Then load `packages/devtools/dist` as an unpacked extension — see
[Load unpacked](./README.md#load-unpacked) in the README.

## Before you open a pull request

Run the same gates CI runs:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build && pnpm verify:build
pnpm screenshot:panel
pnpm verify:listing
```

`pnpm listing:assets` is deliberately **not** in that list. It exits non-zero whenever a store
screenshot's subject is not on screen, and that is the point of it: making it pass by relaxing a
gate is not a fix. All five shots render today, so it happens to exit 0 — do not read that as
permission to keep it green by editing the gate rather than the thing it caught.

## How this codebase thinks

Four conventions explain most review comments here.

**Comments explain *why*, and name the failure that motivated the choice.** A comment restating what
the code does is noise; a comment recording the bug that made the code look strange is the most
valuable thing in the file. Several modules carry a header explaining a regression that shipped once
and must not ship again. Match that register — read a neighbouring file before writing yours.

**A gate you have not watched fail is not a gate.** If you add a check, break the thing it checks and
confirm it goes red, then restore. This applies to tests too: a test that passes against the broken
implementation is worse than no test, because it stops anyone looking. Several tests in this repo
exist because that happened.

**Dimensions and exit codes are not proof of content.** This project has three times produced an
artifact of exactly the right size that was completely wrong — blank PNGs from an SVG that failed to
parse, a screenshot of a broken image reported as success. If you generate something, assert on what
is *in* it.

**`src/core/` is Chrome-free.** No `chrome.*`, no DOM. It runs under plain Node, which is what lets
it be tested honestly and lifted into a CLI later. An ESLint rule enforces it, and `verify-build`
checks no `chrome.` reference survives into `core/`'s build output.

## Things that will bite you

- **Entry-point basenames must be distinct.** CRXJS keys emitted scripts by basename. Two content
  scripts named `index.ts` fail loudly; a content script colliding with the service worker fails
  *silently*, pointing the MAIN-world script at the service worker's chunk. That shipped once.
- **`src/relay/` is a security boundary.** It is the only thing between page-controlled `postMessage`
  data and extension privilege. Changes there need tests that assume the page is hostile.
- **HTML and XML comments cannot contain two adjacent hyphens.** A comment mentioning a CSS custom
  property by its `--name` made Chrome silently refuse to parse an SVG, which still rasterised to
  correctly-sized, entirely blank PNGs.
- **Generated files are committed and gated.** `public/icons/*` (against `listing/icon.svg`),
  `listing/fixtures/demo.agui.jsonl` (against its generator), and
  `src/core/events/event-table.generated.ts` (against `@ag-ui/core`). Regenerate and commit rather
  than hand-editing.

## Tests

Tests live beside their sources as `*.test.ts` and run under Vitest in four projects — `core`
(Node), `panel` (jsdom), `capture` (jsdom), and `scripts` (Node). `packages/harness` is a private
Playwright harness that serves real AG-UI streams over real sockets and drives the extension in a
real browser; it ships in nothing.

```bash
pnpm test                                  # whole workspace, once
pnpm --filter ag-ui-devtools exec vitest   # watch
```

## Commits and pull requests

Conventional-ish prefixes (`feat:`, `fix:`, `docs:`, `refactor:`) with a subject that says what
changed and a body that says *why*. The body matters more than the prefix.

Keep pull requests to one coherent change. If you find an unrelated problem on the way, mention it
rather than folding it in.

## Privacy is a hard constraint, not a preference

This tool sits where prompts and completions flow. **No change may introduce network egress, widen
the permission set, or capture data on an origin the user has not explicitly enabled.**
`pnpm verify:build` enforces the manifest half of that, and a pull request that trips it will not be
merged on the strength of a good reason. If you believe a feature genuinely requires one of those,
open an issue and make the case before writing code.

See [PRIVACY.md](./PRIVACY.md) for what the extension promises users, and
[SECURITY.md](./SECURITY.md) for reporting vulnerabilities — please do not file those as public
issues.
