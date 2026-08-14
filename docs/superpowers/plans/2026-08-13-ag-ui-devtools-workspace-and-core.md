# AG-UI DevTools — Workspace & `core/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a pnpm workspace containing one publishable Chrome extension package, with a complete, fully tested, Chrome-free `core/` layer that decodes, validates, measures, and round-trips AG-UI event streams.

**Architecture:** A single package `packages/devtools` built by Vite + CRXJS. Inside it, `src/core/` holds all protocol logic and touches no Chrome API, so it runs under Node in Vitest and can later be reused by a CLI. Bytes flow `sse/parser → detect/classifier → CaptureRecord → normalizer/chunk-expander → normalizer/run-builder → Run`, with the validator, state timeline, and metrics hanging off the run builder, and `jsonl/` providing the export/import round trip. The capture layer, service worker, and panel UI ship as typed stubs in this pass; only `core/` is implemented.

**Tech Stack:** TypeScript 5.9 (strict), pnpm 10.33, Node 22, Vite 8, CRXJS 2.7.1, Preact 10, Vitest 4, `tsx` for script entry points. `@ag-ui/core@0.0.57` + `zod@3.25.76` are devDependencies used only to generate the committed event table. **Zero runtime dependencies** beyond Preact — the JSON Patch implementation is hand-rolled.

**Source spec:** [`docs/spec/ag-ui-devtools-v0.1.md`](../../spec/ag-ui-devtools-v0.1.md)
**Design:** [`docs/superpowers/specs/2026-08-13-ag-ui-devtools-design.md`](../specs/2026-08-13-ag-ui-devtools-design.md)

---

## File structure

Paths under `packages/devtools/` unless marked *(root)*.

| File | Responsibility | Task |
|---|---|---|
| `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `LICENSE`, `.gitignore` *(root)* | Workspace orchestration, shared strict TS config, MIT license | 1 |
| `package.json`, `tsconfig.json`, `vite.config.ts`, `manifest.config.ts`, `vitest.config.ts`, `eslint.config.js` | Package build, typed MV3 manifest, `core/` no-Chrome lint boundary | 2 |
| `src/core/model/types.ts` | Every shared type: `CaptureRecord`, `Run`, `Issue`, `PatchOp`, `StateFrame`, `RunMetrics` | 3 |
| `scripts/gen-event-table.ts`, `src/core/events/event-table.generated.ts`, `src/core/events/table.ts` | Event shape table generated from `@ag-ui/core` Zod schemas; lookups, deprecated set, chunk mapping | 4 |
| `src/core/events/shape-check.ts` | Raw payload → shape `Issue[]`, no Zod in the bundle | 5 |
| `src/core/sse/parser.ts` | Incremental SSE framing: chunk boundaries, CRLF, keepalives | 6 |
| `src/core/detect/classifier.ts` | Content-first AG-UI detection; CopilotKit route hints | 7 |
| `src/core/state/json-patch.ts` | Hand-rolled RFC 6902 apply-only, positioned failures | 8 |
| `src/core/state/timeline.ts` | Snapshot/delta frames retaining their patch and failure | 9 |
| `src/core/normalizer/chunk-expander.ts` | `*_CHUNK` → start/content/end triads | 10 |
| `src/core/validator/rules/*.ts`, `src/core/validator/index.ts`, `src/core/validator/types.ts` | Every spec §7 rule as a pure function; `finalizeRules` for run-end rules | 11 |
| `src/core/metrics/run-metrics.ts` | Duration, TTFT, gap percentiles, stalls, tool latency, byte counts | 12 |
| `src/core/normalizer/run-builder.ts` | The incremental fold; owns all state mutation | 13 |
| `src/core/jsonl/codec.ts` | `.agui.jsonl` encode + tolerant streaming decode | 14 |
| `src/core/jsonl/redact.ts` | Redaction groups, `«redacted: N chars»` | 15 |
| `src/test/fixtures/*.agui.jsonl`, `src/test/integration.test.ts` | Golden streams; the three Done-when proofs | 16 |
| `src/inject/index.ts`, `src/relay/relay.ts`, `src/sw/index.ts`, `src/panel/devtools.ts`, `src/panel/panel.tsx` | Typed stubs so the extension loads; capture lands next milestone | 17 |
| `.github/workflows/ci.yml` *(root)*, `README.md` *(root)*, `scripts/package.ts` | CI, docs, versioned zip artifact | 18 |

Every `src/core/**` module has a sibling `*.test.ts` written **before** the implementation.

## Task dependency order

Tasks are numbered in execution order. Task 3 (types) unblocks everything; Task 13 (run builder) integrates Tasks 9–12 and must come after them; Task 16 (integration) must come after Tasks 13–15.

## Conventions

- All commands run from `packages/devtools/` unless the step says *(root)*.
- Vitest 4, node environment, `import { describe, it, expect } from 'vitest'`.
- Extensionless relative imports (bundler resolution).
- Commit after every green test cycle.

---

### Task 1: Root pnpm workspace scaffold

Prerequisites: Node 22 (`node -v` → `v22.14.0` or newer 22.x) and pnpm 10.33 (`pnpm -v` → `10.33.0`).

Tasks 1 and 2 are scaffolding, so they are not TDD. Each ends with a verification command
step proving the scaffold works.

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `LICENSE`
- Create: `.gitignore`
- Create: `.npmrc`

---

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 2: Create the private root `package.json`**

Every script delegates with `pnpm -r`, so the root stays a thin orchestrator and a second
consumer of `core/` (a CLI, a VS Code panel) can be added later without restructuring.

```json
{
  "name": "ag-ui-devtools-workspace",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "pnpm -r dev",
    "build": "pnpm -r build",
    "package": "pnpm -r package",
    "test": "pnpm -r run test:ci",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "gen:events": "pnpm -r gen:events"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```

**Note on the `test` script.** pnpm special-cases `test` as a lifecycle script: `pnpm -r test`
exits **0 with no output** when no package defines a `test` script, whereas every other name
fails with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. Since Task 18 wires CI to `run: pnpm test`, the
lifecycle form would let CI report success having executed zero tests. The root therefore
delegates to the non-lifecycle name `test:ci`, which Task 2 defines alongside a plain `test`
for local use.

- [ ] **Step 3: Create `tsconfig.base.json`**

`noEmit: true` is correct at the base level: Vite/rolldown does the transpiling, and `tsc`
is only ever run as a type checker. `jsx`/`jsxImportSource` are set here so the Preact
panel package inherits them.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  }
}
```

- [ ] **Step 4: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Brian Love

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 5: Create `.gitignore`**

`pnpm-lock.yaml` is deliberately absent from this list — the lockfile is committed.

`*.crx` and `*.pem` matter more than they look: Chrome's "Pack extension" writes a `.pem`
private signing key next to the source directory, and committing it would let anyone forge a
CRX that Chrome accepts under this extension's ID.

```
node_modules/
dist/
*.zip
*.crx
*.pem
*.log
.DS_Store
.idea/
*.swp
.vite/
coverage/
.env
.env.*
!.env.example
*.tsbuildinfo
```

- [ ] **Step 6: Create `.npmrc`**

pnpm 10 already defaults `auto-install-peers` to true, which is what pulls in
`@babel/core@7.x` for `@preact/preset-vite`. The only thing worth pinning here is that the
declared Node engine is enforced rather than warned about.

```
engine-strict=true
```

- [ ] **Step 7: Verify the root installs cleanly**

```bash
pnpm install
```

Expected output: no errors, ending with a line matching
`Done in <n>ms using pnpm v10.33.0`. The `packages/*` glob matches nothing yet, which is
fine — pnpm reports `Scope: all 1 workspace project` (or `Already up to date`) and exits 0.
A `pnpm-lock.yaml` is created at the repo root.

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json LICENSE .gitignore .npmrc pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace root with shared tsconfig and MIT license"
```

---

### Task 2: `packages/devtools` package scaffold

**Files:**
- Create: `packages/devtools/package.json`
- Create: `packages/devtools/tsconfig.json`
- Create: `packages/devtools/manifest.config.ts`
- Create: `packages/devtools/vite.config.ts`
- Create: `packages/devtools/vitest.config.ts`
- Create: `packages/devtools/eslint.config.js`
- Create: `packages/devtools/src/panel/devtools.html`
- Create: `packages/devtools/src/panel/panel.html`
- Create: `packages/devtools/public/icons/README.md`

---

- [ ] **Step 1: Create `packages/devtools/package.json`**

Only `preact` is a runtime dependency — design §4 (D9) commits to zero other runtime deps,
and requirements §11's "verifiable by reading the manifest" posture depends on that holding
at the dependency level too. `@ag-ui/core` and `zod` are devDependencies used only by
`scripts/gen-event-table.ts` (Task 3); the generated table is committed, so neither ships.
`zod@^3.25.76` matches `@ag-ui/core@0.0.57`'s own `zod@^3.22.4` dependency, so the schema
objects the generator introspects are the same class instances.

**RESOLVED AT ASSEMBLY — TypeScript runner.** This section originally wired `gen:events`
through Node 22's native `--experimental-strip-types`. Task 4's generator and Task 18's
packaging script both need multi-construct TypeScript that native stripping does not
guarantee, so the plan standardizes on `tsx` for every `.ts` script entry point. It is a
devDependency, so it does not affect the shipped bundle, and it removes an experimental
flag from two build-critical commands.

The `package` script is a placeholder here and is replaced in Task 18 by
`tsx scripts/package.ts`, which reads the version from `package.json` instead of hardcoding
`0.1.0`.

```json
{
  "name": "ag-ui-devtools",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Chrome DevTools panel for inspecting AG-UI protocol streams",
  "license": "MIT",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "package": "vite build && cd dist && zip -qr ../ag-ui-devtools-0.1.0.zip .",
    "test": "vitest run",
    "test:ci": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint .",
    "gen:events": "tsx scripts/gen-event-table.ts"
  },
  "dependencies": {
    "preact": "^10.29.8"
  },
  "devDependencies": {
    "@ag-ui/core": "0.0.57",
    "@crxjs/vite-plugin": "^2.7.1",
    "@eslint/js": "^9.39.5",
    "@preact/preset-vite": "^2.10.6",
    "@types/chrome": "^0.2.6",
    "@types/node": "^22.20.1",
    "eslint": "^9.39.5",
    "globals": "^17.11.0",
    "tsx": "^4.19.2",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.67.0",
    "vite": "^8.2.1",
    "vitest": "^4.1.10",
    "zod": "^3.25.76"
  }
}
```

- [ ] **Step 2: Create `packages/devtools/tsconfig.json`**

All compiler options come from the base config. The package file adds only the ambient type
packages and the file set. `scripts` is in `include` so Task 3's generator is type-checked
alongside `src`.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["chrome", "node"]
  },
  "include": ["src", "scripts", "manifest.config.ts", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `packages/devtools/manifest.config.ts`**

Requirements §12's manifest as a typed TS module. Every security-relevant field is verbatim:
`manifest_version: 3`, name, version, `permissions: ["storage", "scripting"]`,
`optional_host_permissions` only, the three localhost-family match patterns, `world: "MAIN"`
and `world: "ISOLATED"`, `run_at: "document_start"`, `all_frames: true`. There is no
`debugger` permission, no `webRequest` permission, and no static remote `host_permissions`.

The one difference from the spec's JSON block: entry-point values are **source** paths
(`src/sw/index.ts`) rather than **built** filenames (`sw.js`). CRXJS resolves entry points
relative to the Vite project root and rewrites them to the hashed build output; pointing at
`sw.js` would fail the build because no such source file exists. The emitted
`dist/manifest.json` carries the built filenames. The comment in the file records this.

```ts
import { defineManifest } from '@crxjs/vite-plugin';

/**
 * Requirements spec §12, as a typed module.
 *
 * Security posture is verbatim and load-bearing:
 *   - no "debugger" permission
 *   - no "webRequest" permission
 *   - no static remote host_permissions; remote origins are granted at runtime via
 *     chrome.scripting.registerContentScripts after the user opts the origin in (D3)
 *   - content scripts are statically registered for the localhost family only
 *
 * Entry-point values are SOURCE paths, not the built filenames shown in §12. CRXJS
 * resolves them relative to the Vite project root and rewrites them in the emitted
 * dist/manifest.json.
 */

const LOCALHOST_MATCHES = [
  'http://localhost/*',
  'http://127.0.0.1/*',
  'http://0.0.0.0/*',
];

export default defineManifest({
  manifest_version: 3,
  name: 'AG-UI DevTools',
  version: '0.1.0',
  devtools_page: 'src/panel/devtools.html',
  background: {
    service_worker: 'src/sw/index.ts',
    type: 'module',
  },
  permissions: ['storage', 'scripting'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  content_scripts: [
    {
      matches: LOCALHOST_MATCHES,
      js: ['src/inject/index.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: true,
    },
    {
      matches: LOCALHOST_MATCHES,
      js: ['src/relay/relay.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
      all_frames: true,
    },
  ],
});
```

- [ ] **Step 4: Create `packages/devtools/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

- [ ] **Step 5: Create `packages/devtools/vitest.config.ts`**

A separate config file, not `test` inside `vite.config.ts`. Vitest prefers
`vitest.config.ts` when both exist, which keeps the CRXJS plugin — and its manifest
resolution — out of the test run entirely. `environment: 'node'` is what makes the `core/`
boundary observable: a stray Chrome API in `core/` fails under Node rather than silently
passing in a DOM shim.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 6: Create `packages/devtools/eslint.config.js`**

The final block is the enforced half of design §3's `core/` boundary. `no-restricted-globals`
reports references that resolve to the global scope, so it fires on `chrome.*` inside
`src/core/**/*.ts` whether or not `chrome` is declared in `globals`. Files outside `core/`
keep the `webextensions` globals and are unaffected.

The generated event table is ignored because it is machine-written and re-checked by
`pnpm gen:events` producing an unchanged file (design §7.5).

```js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/core/events/event-table.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // Design §3 / D10: core/ is Chrome-free so it runs under Node in Vitest and can be
    // lifted into a CLI later. This rule is the enforcement, not the documentation.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'chrome',
          message:
            'core/ must stay Chrome-free. Move Chrome API usage to sw/, relay/, inject/, or panel/ and pass plain data into core/.',
        },
        // Amendment A5: tsconfig `lib` includes DOM (the panel needs it) and TypeScript
        // cannot express a per-directory `lib`, so `document`/`window`/`localStorage`
        // typecheck inside core/ even though core/ runs under Node in Vitest. ESLint is the
        // only place this boundary can actually be enforced.
        {
          name: 'document',
          message: 'core/ must run under Node. Keep DOM access in panel/, inject/, or relay/.',
        },
        {
          name: 'window',
          message: 'core/ must run under Node. Keep DOM access in panel/, inject/, or relay/.',
        },
        {
          name: 'localStorage',
          message: 'core/ must run under Node and must not persist anything. See requirements §11.',
        },
      ],
    },
  },
);
```

- [ ] **Step 7: Create `packages/devtools/src/panel/devtools.html`**

The DevTools page named by `manifest.config.ts`. Its only job is to register the panel;
`./devtools.ts` and `./panel.tsx` are created by the panel stub task (Task 17).

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AG-UI DevTools</title>
  </head>
  <body>
    <script type="module" src="./devtools.ts"></script>
  </body>
</html>
```

- [ ] **Step 8: Create `packages/devtools/src/panel/panel.html`**

The panel document mounted by `chrome.devtools.panels.create`.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AG-UI</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./panel.tsx"></script>
  </body>
</html>
```

- [ ] **Step 9: Create `packages/devtools/public/icons/README.md`**

Git does not track empty directories, so the placeholder is a note that states what belongs
here and why the manifest does not reference it yet.

```markdown
# Extension icons

Vite copies everything under `public/` into `dist/` verbatim, so files placed here land at
`dist/icons/*` and can be referenced from `manifest.config.ts` as `icons/<file>`.

Requirements §12's manifest has no `icons` key, so nothing here is wired up yet. Adding
icons is a Chrome Web Store submission requirement, not a load-unpacked one; drop
`icon-16.png`, `icon-32.png`, `icon-48.png`, and `icon-128.png` here and add the matching
`icons` block to `manifest.config.ts` before the first CWS upload (design §6, D8).
```

- [ ] **Step 10: Install the package dependencies**

```bash
pnpm install
```

Expected output: `Scope: all 2 workspace projects`, roughly 237 packages added, ending in
`Done in <n>s using pnpm v10.33.0`. Exit code 0. No `ERR_PNPM_*` lines, no
`Ignored build scripts` warning — Vite 8 uses rolldown and lightningcss, both of which ship
prebuilt native binaries and need no postinstall step. pnpm's `auto-install-peers` default
resolves `@preact/preset-vite`'s `@babel/core@7.x` peer automatically; verify with
`ls node_modules/.pnpm | grep '@babel+core'` → `@babel+core@7.29.7`.

- [ ] **Step 11: Verify the empty skeleton type-checks**

```bash
pnpm typecheck
```

Expected output: the two delegating banner lines
(`> ag-ui-devtools-workspace@0.1.0 typecheck` then `> ag-ui-devtools@0.1.0 typecheck`),
then `tsc` prints nothing and exits 0. Any diagnostic here means the base config or the
manifest module is wrong — fix it before moving on.

Sanity-check the toolchain version while you are here:

```bash
pnpm --filter ag-ui-devtools exec tsc --version
```

Expected output: `Version 5.9.3`.

Note: `pnpm test` is expected to FAIL at this point with
`No test files found, exiting with code 1`. That is correct — the first tests arrive with
the `core/` tasks. Likewise `pnpm build` fails until the `inject/`, `relay/`, `sw/`, and
`panel/` stubs named by `manifest.config.ts` exist. `pnpm install`, `pnpm typecheck`, and
`pnpm lint` are the three that must pass now.

- [ ] **Step 12: Verify the `core/` boundary rule actually fires**

The ESLint rule is the enforcement mechanism for design §3, so prove it works before
writing any `core/` code against it.

```bash
mkdir -p packages/devtools/src/core/__boundary_probe && \
printf 'export function boom(): unknown {\n  return chrome.runtime.id;\n}\n' > packages/devtools/src/core/__boundary_probe/probe.ts && \
mkdir -p packages/devtools/src/sw && \
printf 'export function ok(): unknown {\n  return chrome.runtime.id;\n}\n' > packages/devtools/src/sw/probe.ts && \
pnpm lint; echo "exit=$?"
```

Expected output: exactly one error, on the `core/` file only:

```
src/core/__boundary_probe/probe.ts
  2:10  error  Unexpected use of 'chrome'. core/ must stay Chrome-free. Move Chrome API usage to sw/, relay/, inject/, or panel/ and pass plain data into core/.  no-restricted-globals

✖ 1 problem (1 error, 0 warnings)
```

`src/sw/probe.ts` must NOT be reported — that is what proves the rule is scoped rather than
global. Now delete both probes and confirm lint is clean:

```bash
rm -rf packages/devtools/src/core packages/devtools/src/sw && pnpm lint; echo "exit=$?"
```

Expected output: no findings and `exit=0`.

- [ ] **Step 13: Commit**

```bash
git add packages/devtools pnpm-lock.yaml
git commit -m "chore: scaffold ag-ui-devtools package with CRXJS, Vitest, and core/ lint boundary"
```

---

## Contract gaps

1. **Manifest entry paths are source paths, not the built filenames in requirements §12.**
   The spec's JSON literally reads `"service_worker": "sw.js"`, `"js": ["inject.js"]`,
   `"js": ["relay.js"]`, `"devtools_page": "devtools.html"`. CRXJS requires source paths at
   config time and emits the built names into `dist/manifest.json`, so `manifest.config.ts`
   uses `src/sw/index.ts`, `src/inject/index.ts`, `src/relay/relay.ts`, and
   `src/panel/devtools.html`. Everything security-relevant (permissions, optional host
   permissions, match patterns, `world`, `run_at`, `all_frames`, absence of `debugger` and
   `webRequest`) is verbatim. The stub task must create files at exactly those four source
   paths or the build breaks. Flagging because "VERBATIM" was the instruction and this is a
   deliberate, load-bearing deviation.

2. **Four devDependencies were added beyond the assigned list**, all required for
   `pnpm typecheck` and `pnpm lint` to pass: `@eslint/js@^9.39.5` and `globals@^17.11.0`
   (both consumed directly by `eslint.config.js`), `@types/chrome@^0.2.6` (`sw/`, `relay/`,
   `panel/` need it; CRXJS's own `.d.ts` also references the `chrome` namespace), and
   `@types/node@^22.20.1` (Task 3's `scripts/gen-event-table.ts` is inside `tsconfig.json`'s
   `include`). Verified: `@eslint/js` and `eslint` both resolve to 9.39.5;
   `typescript-eslint@8.67.0`'s peer range is `eslint ^8.57.0 || ^9.0.0 || ^10.0.0` and
   `typescript >=4.8.4 <6.1.0`, both satisfied.

3. ~~**`gen:events` runner is unspecified by the contract.**~~ **SUPERSEDED — see resolution R3
   and the "RESOLVED AT ASSEMBLY" note earlier in this task.** This note originally proposed
   `node --experimental-strip-types scripts/gen-event-table.ts`. The plan standardizes on
   **`tsx`** for every `.ts` script entry point, and the authoritative `package.json` block in
   this task's Step 1 already reads `"gen:events": "tsx scripts/gen-event-table.ts"`. Task 4
   must use `tsx`. Do not reintroduce the experimental flag.

4. **`pnpm test` and `pnpm build` fail at the end of Task 2**, by construction: no test
   files exist yet, and the manifest names four entry-point source files that the stub task
   has not created. Design §7's "Done when #1" (`pnpm install && pnpm typecheck && pnpm lint
   && pnpm test && pnpm build`) only becomes true after the `core/` and stub tasks land.
   Whichever task owns the stubs should carry that full command as its verification step.

5. **Everything above was executed and verified, not written from memory.** A working copy
   of both tasks was built in a scratch directory: `pnpm install` completed clean (237
   packages, no ignored build scripts), `pnpm typecheck` exited 0, `pnpm lint` produced
   exactly the one expected `core/` error and left `src/sw/` alone, `tsc --version` reported
   5.9.3, and `@babel/core@7.29.7` was auto-installed as a peer. All cited versions were
   confirmed against the registry with `npm view`: `preact@10.29.8`, `@ag-ui/core@0.0.57`
   (which itself depends on `zod@^3.22.4`, so `zod@^3.25.76` is compatible),
   `@crxjs/vite-plugin@2.7.1` (peer `vite ^3–^8`), `vite@8.2.1`, `vitest@4.1.10` (peer
   `vite ^6–^8`), `typescript@5.9.3`, `@preact/preset-vite@2.10.6` (peer `vite 2.x–8.x`,
   `@babel/core 7.x`), `eslint@9.39.5`, `typescript-eslint@8.67.0`, `zod@3.25.76`.

---

### Task 3: Core model types

**Files:**
- Create: `src/core/model/types.ts`
- Test: none — pure type declarations have no runtime behavior. Verification is `pnpm typecheck`.

This file is the shared vocabulary for every later task. It contains no runtime logic other
than the single exported constant `ORPHANED_RUN_ID`.

- [ ] **Step 1: Write the file**

`src/core/model/types.ts`

```ts
/**
 * Shared model types for the AG-UI DevTools core.
 *
 * This module is type-only apart from `ORPHANED_RUN_ID`. It must never import
 * from `@ag-ui/core` — the runtime core is decoupled from the upstream package
 * (see `scripts/gen-event-table.ts`, which is the only place that touches it).
 */

/** Synthetic run id used for events that arrive with no open run. */
export const ORPHANED_RUN_ID = '__orphaned__';

export type AguiEvent = { type: string; [key: string]: unknown };

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'event-before-run-started'
  | 'event-after-terminal'
  | 'run-never-terminated'
  | 'empty-text-delta'
  | 'unopened-message-id'
  | 'unopened-tool-call-id'
  | 'tool-result-before-end'
  | 'tool-args-not-json'
  | 'state-patch-failed'
  | 'chunk-missing-message-id'
  | 'chunk-missing-tool-call-id'
  | 'chunk-missing-tool-call-name'
  | 'shape-invalid'
  | 'unbalanced-steps'
  | 'unclosed-message'
  | 'unclosed-tool-call'
  | 'deprecated-event'
  | 'unknown-event-type'
  | 'concurrent-text-messages'
  | 'delta-before-snapshot'
  | 'keepalive-gap'
  | 'run-started-without-input';

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  seq: number;
  runId?: string;
  path?: string;
  opIndex?: number;
}

export interface CaptureRecord {
  seq: number;
  tMs: number;
  connId: string;
  raw: unknown;
  event: AguiEvent | null;
  issues: Issue[];
}

export type MessageRole = 'assistant' | 'reasoning';

export interface ReconstructedMessage {
  messageId: string;
  role: MessageRole;
  content: string;
  startedAtMs: number;
  endedAtMs?: number;
  closed: boolean;
  chunkSeqs: number[];
}

export interface ToolCallRecord {
  toolCallId: string;
  toolCallName?: string;
  parentMessageId?: string;
  argsText: string;
  args?: unknown;
  argsParseError?: string;
  result?: unknown;
  startedAtMs: number;
  endedAtMs?: number;
  resultAtMs?: number;
  closed: boolean;
}

export interface ActivityRecord {
  activityId: string;
  value: unknown;
  updatedAtMs: number;
}

export interface StepRecord {
  stepName: string;
  startedAtMs: number;
  endedAtMs?: number;
  closed: boolean;
}

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; path: string; from: string }
  | { op: 'copy'; path: string; from: string }
  | { op: 'test'; path: string; value: unknown };

export type PatchFailure =
  | 'path-not-found'
  | 'parent-not-found'
  | 'invalid-path'
  | 'invalid-op'
  | 'test-failed'
  | 'index-out-of-bounds';

export type PatchResult =
  | { ok: true; value: unknown }
  | { ok: false; opIndex: number; op: PatchOp; reason: PatchFailure };

export interface StateFrame {
  seq: number;
  tMs: number;
  kind: 'snapshot' | 'delta';
  value: unknown;
  patch?: PatchOp[];
  failure?: { opIndex: number; reason: PatchFailure };
}

export interface RunMetrics {
  durationMs?: number;
  ttftMs?: number;
  ttfrtMs?: number;
  gapP50Ms?: number;
  gapP95Ms?: number;
  gapMaxMs?: number;
  stalls: Array<{ startMs: number; endMs: number; messageId: string }>;
  toolLatencyMs: Record<string, number>;
  statePatchCount: number;
  statePatchBytes: number;
  eventCountByType: Record<string, number>;
  totalStreamBytes: number;
}

export type RunOutcome = 'running' | 'finished' | 'error' | 'aborted' | 'orphaned';

export interface Run {
  runId: string;
  threadId: string;
  parentRunId?: string;
  agentId?: string;
  connId: string;
  input?: unknown;
  startedAtMs: number;
  endedAtMs?: number;
  outcome: RunOutcome;
  messages: Map<string, ReconstructedMessage>;
  toolCalls: Map<string, ToolCallRecord>;
  activities: Map<string, ActivityRecord>;
  steps: StepRecord[];
  stateTimeline: StateFrame[];
  metrics: RunMetrics;
  issues: Issue[];
  recordSeqs: number[];
}
```

- [ ] **Step 2: Run typecheck to verify it compiles**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Verify the constant is actually emitted at runtime**

Run: `pnpm vitest run --reporter=basic src/core/model 2>&1 | tail -5`
Expected: `No test files found` (there is intentionally no test for this file). This step
only confirms the path glob is correct and no stray test file was created.

- [ ] **Step 4: Commit**

`git add src/core/model/types.ts && git commit -m "feat(devtools): core model types"`

---

### Task 4: Event table generation from `@ag-ui/core`

**Files:**
- Create: `scripts/gen-event-table.ts`
- Create (generated, committed): `src/core/events/event-table.generated.ts`
- Create: `src/core/events/table.ts`
- Test: `src/core/events/table.test.ts`

**Spec correction — 33 event types, not 26.** Requirements §6 says "Full event coverage
(26 types)". The real count in `@ag-ui/core@0.0.57` is **33**. The spec's prose list omits
`TEXT_MESSAGE_CHUNK` from its own count, folds the five deprecated `THINKING_*` events into
a footnote, and does not mention `TOOL_CALL_RESULT` in the count. Verified by enumerating
`*EventSchema` exports: 34 exports match `/^(.+)EventSchema$/`, of which `BaseEventSchema`
is discarded because its `type` field is a `ZodNativeEnum` rather than a `ZodLiteral`,
leaving 33 concrete event types. **Use 33.** The spec should be amended.

The 33 types (this is the exact sorted `EVENT_TYPES` output):

```
ACTIVITY_DELTA, ACTIVITY_SNAPSHOT, CUSTOM, MESSAGES_SNAPSHOT, RAW,
REASONING_ENCRYPTED_VALUE, REASONING_END, REASONING_MESSAGE_CHUNK,
REASONING_MESSAGE_CONTENT, REASONING_MESSAGE_END, REASONING_MESSAGE_START,
REASONING_START, RUN_ERROR, RUN_FINISHED, RUN_STARTED, STATE_DELTA, STATE_SNAPSHOT,
STEP_FINISHED, STEP_STARTED, TEXT_MESSAGE_CHUNK, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END,
TEXT_MESSAGE_START, THINKING_END, THINKING_START, THINKING_TEXT_MESSAGE_CONTENT,
THINKING_TEXT_MESSAGE_END, THINKING_TEXT_MESSAGE_START, TOOL_CALL_ARGS, TOOL_CALL_CHUNK,
TOOL_CALL_END, TOOL_CALL_RESULT, TOOL_CALL_START
```

**Prerequisite (belongs to the scaffold task, restated here so this task is runnable):**
`package.json` must have

```json
{
  "scripts": {
    "gen:events": "tsx scripts/gen-event-table.ts"
  },
  "devDependencies": {
    "@ag-ui/core": "0.0.57",
    "tsx": "^4.19.2"
  }
}
```

`@ag-ui/core` is a **devDependency only**. It is imported by `scripts/gen-event-table.ts`
and by nothing else — never from `src/`. `zod` does not need to be declared; it is a direct
dependency of `@ag-ui/core`.

- [ ] **Step 1: Write the failing test**

`src/core/events/table.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  EVENT_TABLE,
  EVENT_TYPES,
  GENERATED_FROM_VERSION,
} from './event-table.generated';
import {
  DEPRECATED_EVENT_TYPES,
  chunkKindOf,
  getEventSpec,
  isDeprecatedEventType,
  isKnownEventType,
} from './table';

const ALL_EVENT_TYPES = [
  'ACTIVITY_DELTA',
  'ACTIVITY_SNAPSHOT',
  'CUSTOM',
  'MESSAGES_SNAPSHOT',
  'RAW',
  'REASONING_ENCRYPTED_VALUE',
  'REASONING_END',
  'REASONING_MESSAGE_CHUNK',
  'REASONING_MESSAGE_CONTENT',
  'REASONING_MESSAGE_END',
  'REASONING_MESSAGE_START',
  'REASONING_START',
  'RUN_ERROR',
  'RUN_FINISHED',
  'RUN_STARTED',
  'STATE_DELTA',
  'STATE_SNAPSHOT',
  'STEP_FINISHED',
  'STEP_STARTED',
  'TEXT_MESSAGE_CHUNK',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TEXT_MESSAGE_START',
  'THINKING_END',
  'THINKING_START',
  'THINKING_TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_END',
  'THINKING_TEXT_MESSAGE_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_CHUNK',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'TOOL_CALL_START',
];

describe('event-table.generated', () => {
  it('covers all 33 AG-UI event types (spec says 26; the real count is 33)', () => {
    expect(EVENT_TYPES.length).toBe(33);
    expect([...EVENT_TYPES]).toEqual(ALL_EVENT_TYPES);
  });

  it('records the @ag-ui/core version it was generated from', () => {
    expect(GENERATED_FROM_VERSION).toBe('@ag-ui/core@0.0.57');
  });

  it('has one table entry per event type, keyed by type', () => {
    expect(Object.keys(EVENT_TABLE).sort()).toEqual(ALL_EVENT_TYPES);
    for (const type of ALL_EVENT_TYPES) {
      expect(EVENT_TABLE[type]?.type).toBe(type);
    }
  });

  it('is deterministic: types and fields are sorted alphabetically', () => {
    expect([...EVENT_TYPES]).toEqual([...EVENT_TYPES].slice().sort());
    for (const type of EVENT_TYPES) {
      const names = EVENT_TABLE[type]?.fields.map((f) => f.name) ?? [];
      expect(names).toEqual(names.slice().sort());
    }
  });

  it('marks the discriminant `type` field as a required literal on every event', () => {
    for (const type of EVENT_TYPES) {
      const field = EVENT_TABLE[type]?.fields.find((f) => f.name === 'type');
      expect(field).toEqual({ name: 'type', kind: 'literal', required: true });
    }
  });
});

describe('getEventSpec', () => {
  it('returns the spec for a known type', () => {
    const spec = getEventSpec('RUN_STARTED');
    expect(spec?.type).toBe('RUN_STARTED');
    expect(spec?.fields).toEqual([
      { name: 'input', kind: 'object', required: false },
      { name: 'parentRunId', kind: 'string', required: false },
      { name: 'rawEvent', kind: 'unknown', required: false },
      { name: 'runId', kind: 'string', required: true },
      { name: 'threadId', kind: 'string', required: true },
      { name: 'timestamp', kind: 'number', required: false },
      { name: 'type', kind: 'literal', required: true },
    ]);
  });

  it('maps Zod field types onto FieldKind', () => {
    expect(getEventSpec('TEXT_MESSAGE_CONTENT')?.fields).toContainEqual({
      name: 'delta',
      kind: 'string',
      required: true,
    });
    expect(getEventSpec('STATE_DELTA')?.fields).toContainEqual({
      name: 'delta',
      kind: 'array',
      required: true,
    });
    expect(getEventSpec('ACTIVITY_SNAPSHOT')?.fields).toContainEqual({
      name: 'content',
      kind: 'object',
      required: true,
    });
    expect(getEventSpec('ACTIVITY_SNAPSHOT')?.fields).toContainEqual({
      name: 'replace',
      kind: 'boolean',
      required: false,
    });
    // STATE_SNAPSHOT.snapshot is `z.any()` — kind 'unknown', and z.any() is
    // optional in Zod, so `required` is false. Both facts are load-bearing.
    expect(getEventSpec('STATE_SNAPSHOT')?.fields).toContainEqual({
      name: 'snapshot',
      kind: 'unknown',
      required: false,
    });
  });

  it('unwraps ZodOptional so the inner kind survives', () => {
    expect(getEventSpec('TOOL_CALL_CHUNK')?.fields).toContainEqual({
      name: 'toolCallId',
      kind: 'string',
      required: false,
    });
    expect(getEventSpec('TOOL_CALL_CHUNK')?.fields).toContainEqual({
      name: 'delta',
      kind: 'string',
      required: false,
    });
  });

  it('returns undefined for an unknown type', () => {
    expect(getEventSpec('NOT_A_REAL_EVENT')).toBeUndefined();
  });

  it('does not leak Object.prototype members', () => {
    expect(getEventSpec('toString')).toBeUndefined();
    expect(getEventSpec('constructor')).toBeUndefined();
    expect(getEventSpec('__proto__')).toBeUndefined();
  });
});

describe('isKnownEventType', () => {
  it('is true for every generated type', () => {
    for (const type of EVENT_TYPES) expect(isKnownEventType(type)).toBe(true);
  });

  it('is false for unknown types and prototype keys', () => {
    expect(isKnownEventType('NOT_A_REAL_EVENT')).toBe(false);
    expect(isKnownEventType('')).toBe(false);
    expect(isKnownEventType('constructor')).toBe(false);
    expect(isKnownEventType('hasOwnProperty')).toBe(false);
  });
});

describe('DEPRECATED_EVENT_TYPES', () => {
  it('contains exactly the five THINKING_* events', () => {
    expect([...DEPRECATED_EVENT_TYPES].sort()).toEqual([
      'THINKING_END',
      'THINKING_START',
      'THINKING_TEXT_MESSAGE_CONTENT',
      'THINKING_TEXT_MESSAGE_END',
      'THINKING_TEXT_MESSAGE_START',
    ]);
  });

  it('only lists types that are actually in the table', () => {
    for (const type of DEPRECATED_EVENT_TYPES) {
      expect(isKnownEventType(type)).toBe(true);
    }
  });

  it('isDeprecatedEventType agrees with the set', () => {
    expect(isDeprecatedEventType('THINKING_START')).toBe(true);
    expect(isDeprecatedEventType('THINKING_TEXT_MESSAGE_CONTENT')).toBe(true);
    expect(isDeprecatedEventType('REASONING_START')).toBe(false);
    expect(isDeprecatedEventType('TEXT_MESSAGE_START')).toBe(false);
    expect(isDeprecatedEventType('NOT_A_REAL_EVENT')).toBe(false);
  });
});

describe('chunkKindOf', () => {
  it('maps the three chunk events', () => {
    expect(chunkKindOf('TEXT_MESSAGE_CHUNK')).toBe('text');
    expect(chunkKindOf('TOOL_CALL_CHUNK')).toBe('tool');
    expect(chunkKindOf('REASONING_MESSAGE_CHUNK')).toBe('reasoning');
  });

  it('returns undefined for everything else', () => {
    expect(chunkKindOf('TEXT_MESSAGE_CONTENT')).toBeUndefined();
    expect(chunkKindOf('RUN_STARTED')).toBeUndefined();
    expect(chunkKindOf('NOT_A_REAL_EVENT')).toBeUndefined();
    expect(chunkKindOf('')).toBeUndefined();
  });

  it('covers every table type whose name ends in _CHUNK', () => {
    const chunkTypes = EVENT_TYPES.filter((t) => t.endsWith('_CHUNK'));
    expect(chunkTypes.length).toBe(3);
    for (const type of chunkTypes) expect(chunkKindOf(type)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/events/table.test.ts`
Expected: FAIL with `Failed to resolve import "./event-table.generated" from "src/core/events/table.test.ts"` (and the same for `./table`) — neither module exists yet.

- [ ] **Step 3: Write the generator**

`scripts/gen-event-table.ts`

```ts
/**
 * Generates `src/core/events/event-table.generated.ts` from the Zod schemas
 * exported by `@ag-ui/core`.
 *
 * `@ag-ui/core` is a devDependency and is imported HERE AND NOWHERE ELSE. The
 * runtime core must stay free of it so the extension does not ship a Zod copy
 * and does not break when upstream changes its schema internals.
 *
 * Zod v3 introspection (verified against zod@3.25.76 + @ag-ui/core@0.0.57):
 *   - each `*EventSchema` export is a ZodObject exposing `.shape`
 *   - every field carries `._def.typeName` ('ZodString', 'ZodOptional', ...)
 *   - `field.isOptional()` reports optionality
 *   - a ZodOptional/ZodDefault wraps its inner schema at `._def.innerType`
 *   - the discriminant is `shape.type`, a ZodLiteral whose `._def.value` is the
 *     event-type string. `BaseEventSchema` is the one export that fails this
 *     check (its `type` is a ZodNativeEnum) and is correctly skipped.
 *
 * Output is deterministic: event types sorted alphabetically, fields sorted by
 * name, so re-running produces a byte-identical file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@ag-ui/core';

type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'unknown'
  | 'literal';

interface ZodDefLike {
  typeName?: string;
  innerType?: ZodLike;
  value?: unknown;
}

interface ZodLike {
  _def?: ZodDefLike;
  shape?: Record<string, ZodLike>;
  isOptional?: () => boolean;
}

interface FieldSpec {
  name: string;
  kind: FieldKind;
  required: boolean;
}

interface EventSpec {
  type: string;
  fields: FieldSpec[];
}

const KIND_BY_TYPE_NAME: Record<string, FieldKind> = {
  ZodString: 'string',
  ZodEnum: 'string',
  ZodNativeEnum: 'string',
  ZodNumber: 'number',
  ZodBoolean: 'boolean',
  ZodObject: 'object',
  ZodRecord: 'object',
  ZodArray: 'array',
  ZodLiteral: 'literal',
};

const WRAPPERS = new Set(['ZodOptional', 'ZodDefault']);

/** Strip ZodOptional / ZodDefault wrappers to reach the value schema. */
function unwrap(field: ZodLike): ZodLike {
  let node = field;
  for (let depth = 0; depth < 10; depth += 1) {
    const typeName = node._def?.typeName;
    const inner = node._def?.innerType;
    if (typeName !== undefined && WRAPPERS.has(typeName) && inner) {
      node = inner;
      continue;
    }
    return node;
  }
  return node;
}

function kindOf(field: ZodLike): FieldKind {
  const typeName = unwrap(field)._def?.typeName;
  if (typeName === undefined) return 'unknown';
  return KIND_BY_TYPE_NAME[typeName] ?? 'unknown';
}

function collectSpecs(): EventSpec[] {
  const exports = core as unknown as Record<string, ZodLike | undefined>;
  const specs: EventSpec[] = [];

  for (const exportName of Object.keys(exports)) {
    if (!/^(.+)EventSchema$/.test(exportName)) continue;

    const schema = exports[exportName];
    const shape = schema?.shape;
    if (!shape || typeof shape !== 'object') continue;

    // The discriminant must be a ZodLiteral; BaseEventSchema (ZodNativeEnum) is skipped.
    const typeField = shape.type;
    if (typeField?._def?.typeName !== 'ZodLiteral') continue;
    const eventType = typeField._def?.value;
    if (typeof eventType !== 'string') continue;

    const fields: FieldSpec[] = Object.keys(shape)
      .sort()
      .map((name) => {
        const field = shape[name] as ZodLike;
        return {
          name,
          kind: kindOf(field),
          required: field.isOptional?.() !== true,
        };
      });

    specs.push({ type: eventType, fields });
  }

  specs.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return specs;
}

function render(specs: EventSpec[], coreVersion: string): string {
  const lines: string[] = [];
  lines.push('// AUTO-GENERATED by scripts/gen-event-table.ts — DO NOT EDIT.');
  lines.push('// Run `pnpm gen:events` to regenerate.');
  lines.push('');
  lines.push('export type FieldKind =');
  lines.push("  | 'string'");
  lines.push("  | 'number'");
  lines.push("  | 'boolean'");
  lines.push("  | 'object'");
  lines.push("  | 'array'");
  lines.push("  | 'unknown'");
  lines.push("  | 'literal';");
  lines.push('');
  lines.push('export interface FieldSpec {');
  lines.push('  name: string;');
  lines.push('  kind: FieldKind;');
  lines.push('  required: boolean;');
  lines.push('}');
  lines.push('');
  lines.push('export interface EventSpec {');
  lines.push('  type: string;');
  lines.push('  fields: FieldSpec[];');
  lines.push('}');
  lines.push('');
  lines.push(`export const GENERATED_FROM_VERSION = '@ag-ui/core@${coreVersion}';`);
  lines.push('');
  lines.push('export const EVENT_TABLE: Record<string, EventSpec> = {');
  for (const spec of specs) {
    lines.push(`  ${spec.type}: {`);
    lines.push(`    type: '${spec.type}',`);
    lines.push('    fields: [');
    for (const field of spec.fields) {
      lines.push(
        `      { name: '${field.name}', kind: '${field.kind}', required: ${field.required} },`,
      );
    }
    lines.push('    ],');
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('export const EVENT_TYPES: readonly string[] = [');
  for (const spec of specs) lines.push(`  '${spec.type}',`);
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const requireFromHere = createRequire(import.meta.url);
  const corePkg = requireFromHere('@ag-ui/core/package.json') as { version: string };

  const specs = collectSpecs();
  if (specs.length === 0) {
    throw new Error('gen-event-table: no *EventSchema exports found in @ag-ui/core');
  }

  const outPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/core/events/event-table.generated.ts',
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, render(specs, corePkg.version), 'utf8');

  process.stdout.write(
    `gen-event-table: wrote ${specs.length} event types from @ag-ui/core@${corePkg.version}\n`,
  );
}

main();
```

- [ ] **Step 4: Run the generator and verify its output**

Run: `pnpm gen:events`
Expected: `gen-event-table: wrote 33 event types from @ag-ui/core@0.0.57`

Verify all 33 types landed and the version stamp is right:

```sh
grep -c "^  [A-Z_]*: {$" src/core/events/event-table.generated.ts   # expect: 33
grep -c "^export const EVENT_TABLE" src/core/events/event-table.generated.ts  # expect: 1
grep -n "GENERATED_FROM_VERSION" src/core/events/event-table.generated.ts
# expect: export const GENERATED_FROM_VERSION = '@ag-ui/core@0.0.57';
```

Verify determinism — re-running must produce a byte-identical file:

```sh
shasum src/core/events/event-table.generated.ts && pnpm gen:events >/dev/null && shasum src/core/events/event-table.generated.ts
```
Expected: the two hashes are identical.

Verify the devDependency boundary — nothing under `src/` may import `@ag-ui/core`:

```sh
grep -rn "@ag-ui/core" src/ ; echo "exit=$?"
```
Expected: no output, `exit=1`.

- [ ] **Step 5: Write the implementation**

`src/core/events/table.ts`

```ts
/**
 * Hand-written wrapper over the generated event table.
 *
 * Everything downstream reads the table through this module so the generated
 * file stays a dumb data blob and lookups are prototype-safe.
 */
import {
  EVENT_TABLE,
  EVENT_TYPES,
  type EventSpec,
  type FieldKind,
  type FieldSpec,
} from './event-table.generated';

export type { EventSpec, FieldKind, FieldSpec };
export { EVENT_TABLE, EVENT_TYPES };

/**
 * Superseded by the REASONING_* family. Decoded normally, flagged as deprecated.
 */
export const DEPRECATED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'THINKING_START',
  'THINKING_END',
  'THINKING_TEXT_MESSAGE_START',
  'THINKING_TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_END',
]);

export function getEventSpec(type: string): EventSpec | undefined {
  if (!Object.prototype.hasOwnProperty.call(EVENT_TABLE, type)) return undefined;
  return EVENT_TABLE[type];
}

export function isKnownEventType(type: string): boolean {
  return getEventSpec(type) !== undefined;
}

export function isDeprecatedEventType(type: string): boolean {
  return DEPRECATED_EVENT_TYPES.has(type);
}

export type ChunkKind = 'text' | 'tool' | 'reasoning';

const CHUNK_KIND_BY_TYPE: ReadonlyMap<string, ChunkKind> = new Map<string, ChunkKind>([
  ['TEXT_MESSAGE_CHUNK', 'text'],
  ['TOOL_CALL_CHUNK', 'tool'],
  ['REASONING_MESSAGE_CHUNK', 'reasoning'],
]);

export function chunkKindOf(type: string): ChunkKind | undefined {
  return CHUNK_KIND_BY_TYPE.get(type);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/core/events/table.test.ts`
Expected: PASS, all assertions green.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add scripts/gen-event-table.ts src/core/events/event-table.generated.ts \
        src/core/events/table.ts src/core/events/table.test.ts package.json
git commit -m "feat(devtools): generated AG-UI event table (33 types) + lookup wrapper"
```

---

### Task 5: Event shape check

**Files:**
- Create: `src/core/events/shape-check.ts`
- Test: `src/core/events/shape-check.test.ts`

Implements the requirements §7 error "Payload fails the event's shape check (missing
required field, wrong type)" and the warning "Unknown `type` (forward-compat: shown, not
treated as an error)".

Behavior, per the LOCKED CONTRACT:
- returns `[]` when the payload is valid;
- emits one `shape-invalid` (severity `error`) **per violated field**;
- emits `unknown-event-type` (severity `warning`) when `type` is not in `EVENT_TABLE`, and
  in that case emits **no** field errors (there is no spec to check against);
- when `raw` is not an object, or has no string `type`, emits a **single** `shape-invalid`.

Field kinds `literal` and `unknown` carry no runtime type constraint (Zod models them as
literals/unions/`z.any()`), so those fields are only presence-checked when required.
Unknown extra properties are allowed — forward compatibility, same reason unknown event
types are a warning.

- [ ] **Step 1: Write the failing test**

`src/core/events/shape-check.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { checkShape } from './shape-check';

describe('checkShape — non-events', () => {
  it('emits a single shape-invalid for a non-object', () => {
    for (const raw of [null, undefined, 42, 'RUN_STARTED', true, []]) {
      const issues = checkShape(raw, 7);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('shape-invalid');
      expect(issues[0]?.severity).toBe('error');
      expect(issues[0]?.seq).toBe(7);
    }
  });

  it('emits a single shape-invalid when `type` is missing or not a string', () => {
    for (const raw of [{}, { type: 5 }, { type: null }, { runId: 'r1' }]) {
      const issues = checkShape(raw, 3);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('shape-invalid');
      expect(issues[0]?.severity).toBe('error');
      expect(issues[0]?.path).toBe('type');
      expect(issues[0]?.seq).toBe(3);
    }
  });
});

describe('checkShape — unknown event types', () => {
  it('warns once and does not field-check', () => {
    const issues = checkShape({ type: 'NOT_A_REAL_EVENT' }, 11);
    expect(issues).toEqual([
      {
        code: 'unknown-event-type',
        severity: 'warning',
        message: 'unknown event type `NOT_A_REAL_EVENT`',
        seq: 11,
        path: 'type',
      },
    ]);
  });

  it('does not treat Object.prototype keys as known types', () => {
    const issues = checkShape({ type: 'constructor' }, 1);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unknown-event-type');
  });
});

describe('checkShape — valid payloads', () => {
  it('accepts a minimal RUN_STARTED', () => {
    expect(checkShape({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }, 1)).toEqual([]);
  });

  it('accepts optional fields when present and well typed', () => {
    expect(
      checkShape(
        {
          type: 'RUN_STARTED',
          threadId: 't1',
          runId: 'r1',
          parentRunId: 'r0',
          timestamp: 1700000000000,
          input: { messages: [] },
        },
        1,
      ),
    ).toEqual([]);
  });

  it('accepts optional fields that are explicitly undefined', () => {
    expect(
      checkShape({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1', timestamp: undefined }, 1),
    ).toEqual([]);
  });

  it('allows unknown extra properties (forward compat)', () => {
    expect(
      checkShape({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1', futureField: 'x' }, 1),
    ).toEqual([]);
  });

  it('accepts the other core events', () => {
    expect(
      checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' }, 1),
    ).toEqual([]);
    expect(
      checkShape({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }, 1),
    ).toEqual([]);
    expect(
      checkShape({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: 1 }] }, 1),
    ).toEqual([]);
    expect(checkShape({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } }, 1)).toEqual([]);
    expect(checkShape({ type: 'THINKING_START' }, 1)).toEqual([]);
  });

  it('does not type-constrain `literal` or `unknown` kinds', () => {
    // TOOL_CALL_RESULT.role is an optional ZodLiteral; STATE_SNAPSHOT.snapshot is z.any().
    expect(
      checkShape(
        { type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 'tc1', content: 'ok', role: 'tool' },
        1,
      ),
    ).toEqual([]);
    expect(checkShape({ type: 'STATE_SNAPSHOT', snapshot: 'a string' }, 1)).toEqual([]);
  });
});

describe('checkShape — missing required fields', () => {
  it('reports one issue per missing field, in field order', () => {
    const issues = checkShape({ type: 'TOOL_CALL_RESULT' }, 4);
    expect(issues.map((i) => i.path)).toEqual(['content', 'messageId', 'toolCallId']);
    for (const issue of issues) {
      expect(issue.code).toBe('shape-invalid');
      expect(issue.severity).toBe('error');
      expect(issue.seq).toBe(4);
    }
  });

  it('names the event and the field in the message', () => {
    const issues = checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1' }, 9);
    expect(issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT: missing required field `delta`',
        seq: 9,
        path: 'delta',
      },
    ]);
  });

  it('treats an explicit undefined as missing but null as a type error', () => {
    expect(checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: undefined }, 1)[0]
      ?.message).toBe('TEXT_MESSAGE_CONTENT: missing required field `delta`');
    expect(checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: null }, 1)[0]
      ?.message).toBe('TEXT_MESSAGE_CONTENT: field `delta` should be string, got null');
  });
});

describe('checkShape — wrong field types', () => {
  it('checks strings', () => {
    const issues = checkShape({ type: 'TEXT_MESSAGE_CONTENT', messageId: 1, delta: 'hi' }, 2);
    expect(issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT: field `messageId` should be string, got number',
        seq: 2,
        path: 'messageId',
      },
    ]);
  });

  it('checks numbers, and rejects NaN/Infinity', () => {
    const base = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };
    expect(checkShape({ ...base, timestamp: 'now' }, 1)[0]?.message).toBe(
      'RUN_STARTED: field `timestamp` should be number, got string',
    );
    expect(checkShape({ ...base, timestamp: Number.NaN }, 1)[0]?.message).toBe(
      'RUN_STARTED: field `timestamp` should be number, got number',
    );
    expect(checkShape({ ...base, timestamp: Number.POSITIVE_INFINITY }, 1)).toHaveLength(1);
  });

  it('checks booleans', () => {
    const issues = checkShape(
      {
        type: 'ACTIVITY_SNAPSHOT',
        activityType: 'a',
        messageId: 'm1',
        content: {},
        replace: 'yes',
      },
      1,
    );
    expect(issues).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: 'ACTIVITY_SNAPSHOT: field `replace` should be boolean, got string',
        seq: 1,
        path: 'replace',
      },
    ]);
  });

  it('checks objects — arrays and null are not objects', () => {
    const mk = (content: unknown) => ({
      type: 'ACTIVITY_SNAPSHOT',
      activityType: 'a',
      messageId: 'm1',
      content,
    });
    expect(checkShape(mk([]), 1)[0]?.message).toBe(
      'ACTIVITY_SNAPSHOT: field `content` should be object, got array',
    );
    expect(checkShape(mk(null), 1)[0]?.message).toBe(
      'ACTIVITY_SNAPSHOT: field `content` should be object, got null',
    );
  });

  it('checks arrays', () => {
    expect(checkShape({ type: 'STATE_DELTA', delta: { op: 'add' } }, 1)[0]?.message).toBe(
      'STATE_DELTA: field `delta` should be array, got object',
    );
  });

  it('reports every violated field, not just the first', () => {
    const issues = checkShape({ type: 'TOOL_CALL_START', toolCallId: 1, toolCallName: 2 }, 5);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toEqual(['toolCallId', 'toolCallName']);
  });

  it('mixes missing and mistyped fields in one pass', () => {
    const issues = checkShape({ type: 'RUN_STARTED', threadId: 5 }, 6);
    expect(issues.map((i) => i.path)).toEqual(['runId', 'threadId']);
    expect(issues.map((i) => i.message)).toEqual([
      'RUN_STARTED: missing required field `runId`',
      'RUN_STARTED: field `threadId` should be string, got number',
    ]);
  });
});

describe('checkShape — issue plumbing', () => {
  it('never sets runId or opIndex', () => {
    const issues = checkShape({ type: 'RUN_STARTED' }, 1);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.runId).toBeUndefined();
      expect(issue.opIndex).toBeUndefined();
    }
  });

  it('threads seq through every issue', () => {
    for (const issue of checkShape({ type: 'TOOL_CALL_RESULT' }, 123)) {
      expect(issue.seq).toBe(123);
    }
  });

  it('does not mutate the input', () => {
    const raw = { type: 'RUN_STARTED', threadId: 't1' };
    const before = JSON.stringify(raw);
    checkShape(raw, 1);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/events/shape-check.test.ts`
Expected: FAIL with `Failed to resolve import "./shape-check" from "src/core/events/shape-check.test.ts"` — the module does not exist yet.

- [ ] **Step 3: Write the implementation**

`src/core/events/shape-check.ts`

```ts
/**
 * Structural validation of a captured AG-UI payload against the generated
 * event table. Deliberately permissive about extra properties: an unrecognised
 * field is forward compatibility, not a bug.
 */
import type { Issue } from '../model/types';
import { getEventSpec, type FieldKind } from './table';

function invalid(message: string, seq: number, path?: string): Issue {
  const issue: Issue = { code: 'shape-invalid', severity: 'error', message, seq };
  if (path !== undefined) issue.path = path;
  return issue;
}

/** Human-readable runtime type, used in the "got X" half of a message. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * `literal` and `unknown` kinds carry no runtime constraint — Zod models them
 * as literals, unions or `z.any()`, so presence is all we can assert.
 */
function matchesKind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'literal':
    case 'unknown':
      return true;
    default:
      return true;
  }
}

export function checkShape(raw: unknown, seq: number): Issue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [invalid(`event is not an object, got ${describe(raw)}`, seq)];
  }

  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string') {
    return [invalid(`event has no string \`type\` field, got ${describe(type)}`, seq, 'type')];
  }

  const spec = getEventSpec(type);
  if (spec === undefined) {
    return [
      {
        code: 'unknown-event-type',
        severity: 'warning',
        message: `unknown event type \`${type}\``,
        seq,
        path: 'type',
      },
    ];
  }

  const issues: Issue[] = [];
  for (const field of spec.fields) {
    const value = record[field.name];

    if (value === undefined) {
      if (field.required) {
        issues.push(invalid(`${type}: missing required field \`${field.name}\``, seq, field.name));
      }
      continue;
    }

    if (!matchesKind(value, field.kind)) {
      issues.push(
        invalid(
          `${type}: field \`${field.name}\` should be ${field.kind}, got ${describe(value)}`,
          seq,
          field.name,
        ),
      );
    }
  }

  return issues;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/events/shape-check.test.ts`
Expected: PASS.

Run: `pnpm vitest run src/core/events && pnpm typecheck`
Expected: PASS — Task 4 and Task 5 tests both green, no type errors.

- [ ] **Step 5: Commit**

```sh
git add src/core/events/shape-check.ts src/core/events/shape-check.test.ts
git commit -m "feat(devtools): event shape check against generated table"
```

---

### Task 6: Incremental SSE frame parser

**Files:**
- Create: `src/core/sse/parser.ts`
- Test: `src/core/sse/parser.test.ts`

Three TDD cycles: (1) basic framing on `\n`, (2) chunk boundaries and CR/CRLF, (3) comments,
keepalives, and `flush()`.

---

#### Cycle 1 — basic framing

- [ ] **Step 1: Write the failing test**

Create `src/core/sse/parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createSseParser } from './parser';

describe('createSseParser — basic framing', () => {
  it('emits a single complete frame delivered in one push', () => {
    const parser = createSseParser();
    const frames = parser.push('data: {"type":"RUN_STARTED"}\n\n');
    expect(frames).toEqual([{ kind: 'event', data: '{"type":"RUN_STARTED"}' }]);
  });

  it('does not emit before the blank line arrives', () => {
    const parser = createSseParser();
    expect(parser.push('data: hello\n')).toEqual([]);
  });

  it('joins multiple data lines with a newline', () => {
    const parser = createSseParser();
    const frames = parser.push('data: line one\ndata: line two\ndata: line three\n\n');
    expect(frames).toEqual([{ kind: 'event', data: 'line one\nline two\nline three' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    const parser = createSseParser();
    expect(parser.push('data:no-space\n\n')).toEqual([{ kind: 'event', data: 'no-space' }]);
    expect(parser.push('data: one-space\n\n')).toEqual([{ kind: 'event', data: 'one-space' }]);
    expect(parser.push('data:  two-spaces\n\n')).toEqual([
      { kind: 'event', data: ' two-spaces' },
    ]);
  });

  it('treats a field line with no colon as an empty value', () => {
    const parser = createSseParser();
    expect(parser.push('data\n\n')).toEqual([{ kind: 'event', data: '' }]);
  });

  it('populates eventName, id and retry', () => {
    const parser = createSseParser();
    const frames = parser.push('event: message\nid: 42\nretry: 1500\ndata: hi\n\n');
    expect(frames).toEqual([
      { kind: 'event', data: 'hi', eventName: 'message', id: '42', retry: 1500 },
    ]);
  });

  it('ignores a retry value that is not a number rather than producing NaN', () => {
    const parser = createSseParser();
    const frames = parser.push('retry: soon\ndata: hi\n\n');
    expect(frames).toEqual([{ kind: 'event', data: 'hi' }]);
    expect(frames[0]).not.toHaveProperty('retry');
  });

  it('ignores unknown fields', () => {
    const parser = createSseParser();
    expect(parser.push('bogus: nope\ndata: hi\n\n')).toEqual([{ kind: 'event', data: 'hi' }]);
  });

  it('emits multiple frames from a single push', () => {
    const parser = createSseParser();
    const frames = parser.push('data: a\n\ndata: b\n\ndata: c\n\n');
    expect(frames).toEqual([
      { kind: 'event', data: 'a' },
      { kind: 'event', data: 'b' },
      { kind: 'event', data: 'c' },
    ]);
  });

  it('does not emit a frame that has no data lines, and resets its fields', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\nid: 7\n\n')).toEqual([]);
    expect(parser.push('data: after\n\n')).toEqual([{ kind: 'event', data: 'after' }]);
  });

  it('does not emit anything for a run of blank lines', () => {
    const parser = createSseParser();
    expect(parser.push('\n\n\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/sse/parser.test.ts`
Expected: FAIL with `Failed to resolve import "./parser" from "src/core/sse/parser.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `src/core/sse/parser.ts`:

```ts
export type SseFrame =
  | { kind: 'event'; data: string; eventName?: string; id?: string; retry?: number }
  | { kind: 'keepalive'; comment: string };

export interface SseParser {
  push(chunk: string): SseFrame[];
  flush(): SseFrame[];
}

type SseEventFrame = Extract<SseFrame, { kind: 'event' }>;

function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value;
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;
  let retry: number | undefined;
  let hasData = false;

  function resetFrame(): void {
    dataLines = [];
    eventName = undefined;
    lastId = undefined;
    retry = undefined;
    hasData = false;
  }

  function dispatch(out: SseFrame[]): void {
    if (!hasData) {
      resetFrame();
      return;
    }
    const frame: SseEventFrame = { kind: 'event', data: dataLines.join('\n') };
    if (eventName !== undefined) frame.eventName = eventName;
    if (lastId !== undefined) frame.id = lastId;
    if (retry !== undefined) frame.retry = retry;
    out.push(frame);
    resetFrame();
  }

  function handleLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      dispatch(out);
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : stripOneLeadingSpace(line.slice(colon + 1));
    switch (field) {
      case 'data':
        dataLines.push(value);
        hasData = true;
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        lastId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const out: SseFrame[] = [];
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl), out);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      return out;
    },

    flush(): SseFrame[] {
      // Trailing-frame handling is driven out in cycle 3.
      return [];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/sse/parser.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

Message: `feat(sse): incremental frame parser with LF framing`

---

#### Cycle 2 — chunk boundaries, CRLF and lone CR

- [ ] **Step 6: Write the failing test**

Append to `src/core/sse/parser.test.ts`:

```ts
describe('createSseParser — chunk boundaries', () => {
  it('reassembles a frame split mid-line across two pushes', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"ty')).toEqual([]);
    expect(parser.push('pe":"X"}\n\n')).toEqual([{ kind: 'event', data: '{"type":"X"}' }]);
  });

  it('reassembles a frame split exactly at the blank-line boundary', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"RUN_FINISHED"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ kind: 'event', data: '{"type":"RUN_FINISHED"}' }]);
  });

  it('reassembles a frame split one character at a time', () => {
    const parser = createSseParser();
    const wire = 'data: abc\n\n';
    const frames: unknown[] = [];
    for (const ch of wire) frames.push(...parser.push(ch));
    expect(frames).toEqual([{ kind: 'event', data: 'abc' }]);
  });

  it('handles CRLF line endings', () => {
    const parser = createSseParser();
    const frames = parser.push('event: message\r\ndata: hi\r\n\r\n');
    expect(frames).toEqual([{ kind: 'event', data: 'hi', eventName: 'message' }]);
  });

  it('handles a CRLF pair split across two pushes', () => {
    const parser = createSseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('\ndata: y\r\n\r\n')).toEqual([{ kind: 'event', data: 'x\ny' }]);
  });

  it('handles lone CR line endings', () => {
    const parser = createSseParser();
    const frames = parser.push('data: a\r\rdata: b\r\r');
    // The final CR is held back: it may still turn out to be the CR of a CRLF pair.
    expect(frames).toEqual([{ kind: 'event', data: 'a' }]);
    expect(parser.push('data: c\r\r')).toEqual([{ kind: 'event', data: 'b' }]);
  });

  it('does not split on a CR that is followed by more content', () => {
    const parser = createSseParser();
    expect(parser.push('data: one\rdata: two\r\rtail')).toEqual([
      { kind: 'event', data: 'one\ntwo' },
    ]);
  });

  it('mixes CRLF and LF terminators in one stream', () => {
    const parser = createSseParser();
    const frames = parser.push('data: a\r\n\ndata: b\n\r\n');
    expect(frames).toEqual([
      { kind: 'event', data: 'a' },
      { kind: 'event', data: 'b' },
    ]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/core/sse/parser.test.ts`
Expected: FAIL — `createSseParser > chunk boundaries > handles CRLF line endings`:
`AssertionError: expected [] to deeply equal [ { kind: 'event', …} ]` (the LF-only scanner
leaves a `\r` glued to each value and never sees a blank line).

- [ ] **Step 8: Write the implementation**

Replace the returned `push` in `src/core/sse/parser.ts` with a scanner that understands all
three terminators. Full file:

```ts
export type SseFrame =
  | { kind: 'event'; data: string; eventName?: string; id?: string; retry?: number }
  | { kind: 'keepalive'; comment: string };

export interface SseParser {
  push(chunk: string): SseFrame[];
  flush(): SseFrame[];
}

type SseEventFrame = Extract<SseFrame, { kind: 'event' }>;

function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value;
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;
  let retry: number | undefined;
  let hasData = false;

  function resetFrame(): void {
    dataLines = [];
    eventName = undefined;
    lastId = undefined;
    retry = undefined;
    hasData = false;
  }

  function dispatch(out: SseFrame[]): void {
    if (!hasData) {
      resetFrame();
      return;
    }
    const frame: SseEventFrame = { kind: 'event', data: dataLines.join('\n') };
    if (eventName !== undefined) frame.eventName = eventName;
    if (lastId !== undefined) frame.id = lastId;
    if (retry !== undefined) frame.retry = retry;
    out.push(frame);
    resetFrame();
  }

  function handleLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      dispatch(out);
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : stripOneLeadingSpace(line.slice(colon + 1));
    switch (field) {
      case 'data':
        dataLines.push(value);
        hasData = true;
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        lastId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const out: SseFrame[] = [];
      let start = 0;
      let i = 0;
      while (i < buffer.length) {
        const ch = buffer[i];
        if (ch === '\n') {
          handleLine(buffer.slice(start, i), out);
          i += 1;
          start = i;
        } else if (ch === '\r') {
          if (i === buffer.length - 1) {
            // A trailing CR may be the first half of a CRLF pair split across
            // chunks. Hold it in the buffer until the next push or flush().
            break;
          }
          handleLine(buffer.slice(start, i), out);
          i += buffer[i + 1] === '\n' ? 2 : 1;
          start = i;
        } else {
          i += 1;
        }
      }
      buffer = buffer.slice(start);
      return out;
    },

    flush(): SseFrame[] {
      // Trailing-frame handling is driven out in cycle 3.
      return [];
    },
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/core/sse/parser.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 10: Commit**

Message: `feat(sse): handle CRLF, lone CR and chunk-boundary splits`

---

#### Cycle 3 — comments, keepalives and flush

- [ ] **Step 11: Write the failing test**

Append to `src/core/sse/parser.test.ts`:

```ts
describe('createSseParser — comments and keepalives', () => {
  it('emits a comment line as a keepalive frame with the leading space stripped', () => {
    const parser = createSseParser();
    expect(parser.push(': keepalive\n')).toEqual([{ kind: 'keepalive', comment: 'keepalive' }]);
  });

  it('emits a bare colon heartbeat as an empty keepalive', () => {
    const parser = createSseParser();
    expect(parser.push(':\n')).toEqual([{ kind: 'keepalive', comment: '' }]);
  });

  it('keeps everything after the first colon and one space in the comment', () => {
    const parser = createSseParser();
    expect(parser.push('::ping: 1\n')).toEqual([{ kind: 'keepalive', comment: ':ping: 1' }]);
  });

  it('emits keepalives immediately, before the frame terminates', () => {
    const parser = createSseParser();
    expect(parser.push(': ka\ndata: hi\n')).toEqual([{ kind: 'keepalive', comment: 'ka' }]);
    expect(parser.push('\n')).toEqual([{ kind: 'event', data: 'hi' }]);
  });

  it('does not emit an event for a frame containing only comments', () => {
    const parser = createSseParser();
    expect(parser.push(': one\n: two\n\n')).toEqual([
      { kind: 'keepalive', comment: 'one' },
      { kind: 'keepalive', comment: 'two' },
    ]);
  });

  it('interleaves keepalives and events in emission order', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\n\n: ka\ndata: b\n\n')).toEqual([
      { kind: 'event', data: 'a' },
      { kind: 'keepalive', comment: 'ka' },
      { kind: 'event', data: 'b' },
    ]);
  });
});

describe('createSseParser — flush', () => {
  it('returns [] when nothing has been pushed', () => {
    expect(createSseParser().flush()).toEqual([]);
  });

  it('emits a trailing frame that was never terminated by a blank line', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"RUN_ERROR"}\n')).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: 'event', data: '{"type":"RUN_ERROR"}' }]);
  });

  it('emits a trailing frame whose last line has no terminator at all', () => {
    const parser = createSseParser();
    expect(parser.push('event: done\ndata: tail')).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: 'event', data: 'tail', eventName: 'done' }]);
  });

  it('emits a trailing comment as a keepalive', () => {
    const parser = createSseParser();
    expect(parser.push(': bye')).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: 'keepalive', comment: 'bye' }]);
  });

  it('resolves a held-back trailing CR as a line terminator', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r\r')).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: 'event', data: 'a' }]);
  });

  it('returns [] when the stream ended on a clean frame boundary', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\n\n')).toEqual([{ kind: 'event', data: 'a' }]);
    expect(parser.flush()).toEqual([]);
  });

  it('resets after flushing so a second flush returns []', () => {
    const parser = createSseParser();
    parser.push('data: a');
    expect(parser.flush()).toEqual([{ kind: 'event', data: 'a' }]);
    expect(parser.flush()).toEqual([]);
  });

  it('can keep parsing after a flush', () => {
    const parser = createSseParser();
    parser.push('data: a');
    expect(parser.flush()).toEqual([{ kind: 'event', data: 'a' }]);
    expect(parser.push('data: b\n\n')).toEqual([{ kind: 'event', data: 'b' }]);
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/core/sse/parser.test.ts`
Expected: FAIL — `comments and keepalives > emits a comment line as a keepalive frame …`:
`AssertionError: expected [] to deeply equal [ { kind: 'keepalive', comment: 'keepalive' } ]`,
and every test in the `flush` block except the two that expect `[]`.

- [ ] **Step 13: Write the implementation**

Final `src/core/sse/parser.ts`:

```ts
export type SseFrame =
  | { kind: 'event'; data: string; eventName?: string; id?: string; retry?: number }
  | { kind: 'keepalive'; comment: string };

export interface SseParser {
  push(chunk: string): SseFrame[];
  flush(): SseFrame[];
}

type SseEventFrame = Extract<SseFrame, { kind: 'event' }>;

function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value;
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;
  let retry: number | undefined;
  let hasData = false;

  function resetFrame(): void {
    dataLines = [];
    eventName = undefined;
    lastId = undefined;
    retry = undefined;
    hasData = false;
  }

  function dispatch(out: SseFrame[]): void {
    if (!hasData) {
      resetFrame();
      return;
    }
    const frame: SseEventFrame = { kind: 'event', data: dataLines.join('\n') };
    if (eventName !== undefined) frame.eventName = eventName;
    if (lastId !== undefined) frame.id = lastId;
    if (retry !== undefined) frame.retry = retry;
    out.push(frame);
    resetFrame();
  }

  function handleLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) {
      out.push({ kind: 'keepalive', comment: stripOneLeadingSpace(line.slice(1)) });
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : stripOneLeadingSpace(line.slice(colon + 1));
    switch (field) {
      case 'data':
        dataLines.push(value);
        hasData = true;
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        lastId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const out: SseFrame[] = [];
      let start = 0;
      let i = 0;
      while (i < buffer.length) {
        const ch = buffer[i];
        if (ch === '\n') {
          handleLine(buffer.slice(start, i), out);
          i += 1;
          start = i;
        } else if (ch === '\r') {
          if (i === buffer.length - 1) {
            // A trailing CR may be the first half of a CRLF pair split across
            // chunks. Hold it in the buffer until the next push or flush().
            break;
          }
          handleLine(buffer.slice(start, i), out);
          i += buffer[i + 1] === '\n' ? 2 : 1;
          start = i;
        } else {
          i += 1;
        }
      }
      buffer = buffer.slice(start);
      return out;
    },

    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer !== '') {
        // A held-back trailing CR was a real terminator after all.
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        buffer = '';
        handleLine(line, out);
      }
      dispatch(out);
      return out;
    },
  };
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/core/sse/parser.test.ts`
Expected: PASS, 33 tests.

- [ ] **Step 15: Commit**

Message: `feat(sse): keepalive comments and flush of trailing frames`

---

### Task 7: Connection classifier and route hints

**Files:**
- Create: `src/core/detect/classifier.ts`
- Test: `src/core/detect/classifier.test.ts`

Content-based detection is primary (§4.1); route hints are a secondary fast path (§4.2).
`basePath` is the path prefix with no trailing slash — `''` when the route sits at the root.

- [ ] **Step 1: Write the failing test**

Create `src/core/detect/classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EVENT_TYPES } from '../events/event-table.generated';
import {
  classifyContentType,
  createConnClassifier,
  isAguiPayload,
  routeHint,
} from './classifier';

const RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}';
const TEXT_DELTA = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}';

describe('classifyContentType', () => {
  it('recognizes text/event-stream', () => {
    expect(classifyContentType('text/event-stream')).toBe('sse');
  });

  it('recognizes text/event-stream with parameters', () => {
    expect(classifyContentType('text/event-stream; charset=utf-8')).toBe('sse');
    expect(classifyContentType('text/event-stream;charset=UTF-8')).toBe('sse');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(classifyContentType('  Text/Event-Stream ; charset=utf-8')).toBe('sse');
  });

  it('recognizes the AG-UI protobuf content type as binary', () => {
    expect(classifyContentType('application/vnd.ag-ui.event+proto')).toBe('binary');
  });

  it('returns other for anything else, including null and undefined', () => {
    expect(classifyContentType('application/json')).toBe('other');
    expect(classifyContentType('')).toBe('other');
    expect(classifyContentType(null)).toBe('other');
    expect(classifyContentType(undefined)).toBe('other');
  });
});

describe('isAguiPayload', () => {
  it('accepts a JSON object whose type is a known event type', () => {
    expect(EVENT_TYPES).toContain('RUN_STARTED');
    expect(isAguiPayload(RUN_STARTED)).toBe(true);
    expect(isAguiPayload(TEXT_DELTA)).toBe(true);
  });

  it('rejects a JSON object whose type is not a known event type', () => {
    expect(isAguiPayload('{"type":"TOTALLY_MADE_UP"}')).toBe(false);
  });

  it('rejects a non-string type', () => {
    expect(isAguiPayload('{"type":123}')).toBe(false);
    expect(isAguiPayload('{"type":null}')).toBe(false);
    expect(isAguiPayload('{}')).toBe(false);
  });

  it('rejects malformed JSON without throwing', () => {
    expect(isAguiPayload('{"type":"RUN_STARTED"')).toBe(false);
    expect(isAguiPayload('not json at all')).toBe(false);
    expect(isAguiPayload('')).toBe(false);
    expect(isAguiPayload('[DONE]')).toBe(false);
  });

  it('rejects JSON that is not a non-null object', () => {
    expect(isAguiPayload('null')).toBe(false);
    expect(isAguiPayload('"RUN_STARTED"')).toBe(false);
    expect(isAguiPayload('42')).toBe(false);
    expect(isAguiPayload('[{"type":"RUN_STARTED"}]')).toBe(false);
  });
});

describe('createConnClassifier', () => {
  it('promotes not-agui -> provisional -> agui over two matching payloads', () => {
    const c = createConnClassifier('text/event-stream');
    expect(c.current()).toBe('not-agui');
    expect(c.observe(RUN_STARTED)).toBe('provisional');
    expect(c.current()).toBe('provisional');
    expect(c.observe(TEXT_DELTA)).toBe('agui');
    expect(c.current()).toBe('agui');
  });

  it('stays not-agui while payloads do not match', () => {
    const c = createConnClassifier('text/event-stream; charset=utf-8');
    expect(c.observe('{"choices":[{"delta":{"content":"hi"}}]}')).toBe('not-agui');
    expect(c.observe('[DONE]')).toBe('not-agui');
    expect(c.current()).toBe('not-agui');
  });

  it('reaches agui across interleaved non-matching payloads', () => {
    const c = createConnClassifier('text/event-stream');
    expect(c.observe(RUN_STARTED)).toBe('provisional');
    expect(c.observe('garbage')).toBe('provisional');
    expect(c.observe(TEXT_DELTA)).toBe('agui');
  });

  it('never regresses once agui', () => {
    const c = createConnClassifier('text/event-stream');
    c.observe(RUN_STARTED);
    c.observe(TEXT_DELTA);
    expect(c.observe('not json')).toBe('agui');
    expect(c.observe('{"type":"TOTALLY_MADE_UP"}')).toBe('agui');
    expect(c.current()).toBe('agui');
  });

  it('short-circuits to binary for the protobuf content type', () => {
    const c = createConnClassifier('application/vnd.ag-ui.event+proto');
    expect(c.current()).toBe('binary');
    expect(c.observe(RUN_STARTED)).toBe('binary');
    expect(c.observe(TEXT_DELTA)).toBe('binary');
    expect(c.current()).toBe('binary');
  });

  it('stays not-agui for a non-SSE content type even when payloads match', () => {
    const c = createConnClassifier('application/json');
    expect(c.current()).toBe('not-agui');
    expect(c.observe(RUN_STARTED)).toBe('not-agui');
    expect(c.observe(TEXT_DELTA)).toBe('not-agui');
  });

  it('stays not-agui when there is no content type at all', () => {
    const c = createConnClassifier(null);
    expect(c.observe(RUN_STARTED)).toBe('not-agui');
    expect(createConnClassifier(undefined).current()).toBe('not-agui');
  });
});

describe('routeHint', () => {
  it('recognizes GET {base}/info', () => {
    expect(routeHint('https://app.example.com/api/copilotkit/info', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/api/copilotkit',
    });
  });

  it('recognizes POST {base}/agent/:agentId/run', () => {
    expect(routeHint('https://app.example.com/api/copilotkit/agent/my-agent/run', 'POST')).toEqual({
      kind: 'copilotkit-run',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
    });
  });

  it('recognizes POST {base}/agent/:agentId/connect', () => {
    expect(routeHint('/api/copilotkit/agent/my-agent/connect', 'POST')).toEqual({
      kind: 'copilotkit-connect',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
    });
  });

  it('recognizes POST {base}/agent/:agentId/stop/:threadId', () => {
    expect(routeHint('/api/copilotkit/agent/my-agent/stop/thread-42', 'POST')).toEqual({
      kind: 'copilotkit-stop',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
      threadId: 'thread-42',
    });
  });

  it('recognizes GET {base}/inspector-metadata', () => {
    expect(routeHint('https://app.example.com/api/copilotkit/inspector-metadata', 'GET')).toEqual({
      kind: 'copilotkit-inspector-metadata',
      basePath: '/api/copilotkit',
    });
  });

  it('works for an arbitrary basePath, including the root', () => {
    expect(routeHint('/v3/ck/info', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/v3/ck',
    });
    expect(routeHint('/info', 'GET')).toEqual({ kind: 'copilotkit-info', basePath: '' });
  });

  it('works on path-only strings and ignores query and hash', () => {
    expect(routeHint('/api/copilotkit/info?v=2', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/api/copilotkit',
    });
    expect(routeHint('https://app.example.com/api/copilotkit/info?v=2#x', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/api/copilotkit',
    });
  });

  it('accepts a lowercase method', () => {
    expect(routeHint('/api/copilotkit/agent/a1/run', 'post')).toEqual({
      kind: 'copilotkit-run',
      basePath: '/api/copilotkit',
      agentId: 'a1',
    });
  });

  it('honors the HTTP method', () => {
    expect(routeHint('/api/copilotkit/info', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/inspector-metadata', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/run', 'GET')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/connect', 'GET')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/stop/t1', 'GET')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(routeHint('https://app.example.com/api/chat', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/run/extra', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent//run', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/stop', 'POST')).toBeUndefined();
    expect(routeHint('', 'GET')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/detect/classifier.test.ts`
Expected: FAIL with `Failed to resolve import "./classifier" from "src/core/detect/classifier.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `src/core/detect/classifier.ts`:

```ts
import { EVENT_TYPES } from '../events/event-table.generated';

export type Classification = 'agui' | 'provisional' | 'not-agui' | 'binary';

export interface ConnClassifier {
  observe(data: string): Classification;
  current(): Classification;
}

export type RouteHint =
  | { kind: 'copilotkit-info'; basePath: string }
  | { kind: 'copilotkit-run'; basePath: string; agentId: string }
  | { kind: 'copilotkit-connect'; basePath: string; agentId: string }
  | { kind: 'copilotkit-stop'; basePath: string; agentId: string; threadId: string }
  | { kind: 'copilotkit-inspector-metadata'; basePath: string };

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

const SSE_MIME = 'text/event-stream';
const PROTO_MIME = 'application/vnd.ag-ui.event+proto';

export function classifyContentType(
  contentType: string | null | undefined,
): 'sse' | 'binary' | 'other' {
  if (!contentType) return 'other';
  const essence = contentType.split(';')[0].trim().toLowerCase();
  if (essence === SSE_MIME) return 'sse';
  if (essence === PROTO_MIME) return 'binary';
  return 'other';
}

export function isAguiPayload(data: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const type = (parsed as Record<string, unknown>).type;
  return typeof type === 'string' && KNOWN_EVENT_TYPES.has(type);
}

export function createConnClassifier(
  contentType: string | null | undefined,
): ConnClassifier {
  const transport = classifyContentType(contentType);
  let state: Classification = transport === 'binary' ? 'binary' : 'not-agui';
  let matches = 0;

  return {
    observe(data: string): Classification {
      if (transport !== 'sse') return state;
      if (state === 'agui') return state;
      if (isAguiPayload(data)) {
        matches += 1;
        state = matches >= 2 ? 'agui' : 'provisional';
      }
      return state;
    },
    current(): Classification {
      return state;
    },
  };
}

const INFO_RE = /^(.*)\/info$/;
const INSPECTOR_METADATA_RE = /^(.*)\/inspector-metadata$/;
const RUN_RE = /^(.*)\/agent\/([^/]+)\/run$/;
const CONNECT_RE = /^(.*)\/agent\/([^/]+)\/connect$/;
const STOP_RE = /^(.*)\/agent\/([^/]+)\/stop\/([^/]+)$/;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('#')[0].split('?')[0];
  }
}

export function routeHint(url: string, method: string): RouteHint | undefined {
  const path = pathOf(url);
  const verb = method.toUpperCase();

  if (verb === 'GET') {
    const info = INFO_RE.exec(path);
    if (info) return { kind: 'copilotkit-info', basePath: info[1] };
    const meta = INSPECTOR_METADATA_RE.exec(path);
    if (meta) return { kind: 'copilotkit-inspector-metadata', basePath: meta[1] };
    return undefined;
  }

  if (verb === 'POST') {
    const run = RUN_RE.exec(path);
    if (run) return { kind: 'copilotkit-run', basePath: run[1], agentId: run[2] };
    const connect = CONNECT_RE.exec(path);
    if (connect) return { kind: 'copilotkit-connect', basePath: connect[1], agentId: connect[2] };
    const stop = STOP_RE.exec(path);
    if (stop) {
      return {
        kind: 'copilotkit-stop',
        basePath: stop[1],
        agentId: stop[2],
        threadId: stop[3],
      };
    }
    return undefined;
  }

  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/detect/classifier.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Commit**

Message: `feat(detect): content-first connection classifier and CopilotKit route hints`

---

### Task 8: Hand-rolled RFC 6902 JSON Patch (apply-only)

**Files:**
- Create: `src/core/state/json-patch.ts`
- Test: `src/core/state/json-patch.test.ts`

Three TDD cycles: (1) `parsePointer`, (2) `add`/`remove`/`replace` + immutability + root
replacement, (3) `move`/`copy`/`test` + `invalid-op` + failure positioning. Steps are
numbered continuously across all three cycles.

---

#### Cycle 1 — `parsePointer`

- [ ] **Step 1: Write the failing test**

Create `src/core/state/json-patch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePointer } from './json-patch';

describe('parsePointer', () => {
  it('returns an empty token list for the whole-document pointer', () => {
    expect(parsePointer('')).toEqual([]);
  });

  it('splits a pointer on slashes, dropping the leading slash', () => {
    expect(parsePointer('/a/b')).toEqual(['a', 'b']);
  });

  it('parses a single-token pointer', () => {
    expect(parsePointer('/a')).toEqual(['a']);
  });

  it('preserves numeric tokens as strings', () => {
    expect(parsePointer('/items/0/id')).toEqual(['items', '0', 'id']);
  });

  it('preserves empty tokens', () => {
    expect(parsePointer('/')).toEqual(['']);
    expect(parsePointer('/a//b')).toEqual(['a', '', 'b']);
  });

  it('unescapes ~1 to a slash', () => {
    expect(parsePointer('/a~1b')).toEqual(['a/b']);
  });

  it('unescapes ~0 to a tilde', () => {
    expect(parsePointer('/a~0b')).toEqual(['a~b']);
  });

  it('unescapes ~1 before ~0 so that ~01 becomes ~1 and not a slash', () => {
    expect(parsePointer('/~01')).toEqual(['~1']);
  });

  it('unescapes both escapes in the same token', () => {
    expect(parsePointer('/m~0n~1o')).toEqual(['m~n/o']);
  });

  it('returns null for a pointer that is neither empty nor slash-prefixed', () => {
    expect(parsePointer('a/b')).toBeNull();
    expect(parsePointer('#/a')).toBeNull();
    expect(parsePointer(' /a')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/state/json-patch.test.ts`

Expected: FAIL with `Error: Failed to resolve import "./json-patch" from "src/core/state/json-patch.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `src/core/state/json-patch.ts`:

```ts
/**
 * Parse an RFC 6901 JSON Pointer into its unescaped reference tokens.
 *
 * Returns `[]` for the whole-document pointer `''`, and `null` for any string that is
 * neither `''` nor slash-prefixed. Escapes are undone in the order mandated by RFC 6901:
 * `~1` -> `/` first, then `~0` -> `~`, so that `~01` decodes to the literal `~1`.
 */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (pointer[0] !== '/') return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.split('~1').join('/').split('~0').join('~'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/state/json-patch.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

Run: `git add src/core/state/json-patch.ts src/core/state/json-patch.test.ts && git commit -m "feat(core): parsePointer for RFC 6901 JSON Pointers"`

---

#### Cycle 2 — `applyPatch` for `add` / `remove` / `replace`

- [ ] **Step 6: Write the failing test**

Append to `src/core/state/json-patch.test.ts`. Replace the import line at the top of the
file with `import { applyPatch, parsePointer } from './json-patch';` and add
`import type { PatchOp } from '../model/types';` beneath it, then append these describe
blocks after the existing `describe('parsePointer', ...)` block:

```ts
describe('applyPatch — add', () => {
  it('adds a new key to an object', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { a: 1, b: 2 } });
  });

  it('overwrites an existing key', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/a', value: 9 }]);
    expect(result).toEqual({ ok: true, value: { a: 9 } });
  });

  it('inserts into an array at an index', () => {
    const doc = { list: ['a', 'c'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/1', value: 'b' }]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'b', 'c'] } });
  });

  it('appends to an array with the - token', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/-', value: 'b' }]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'b'] } });
  });

  it('allows an index equal to the array length as an append', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/1', value: 'b' }]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'b'] } });
  });

  it('fails with index-out-of-bounds past the end of an array', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/3', value: 'b' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/list/3', value: 'b' },
      reason: 'index-out-of-bounds',
    });
  });

  it('fails with invalid-path for a non-numeric array token', () => {
    const doc = { list: ['a'] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/x', value: 'b' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/list/x', value: 'b' },
      reason: 'invalid-path',
    });
  });

  it('fails with parent-not-found when an intermediate container is missing', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/nope/b', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/nope/b', value: 2 },
      reason: 'parent-not-found',
    });
  });

  it('fails with parent-not-found when an intermediate value is a scalar', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'add', path: '/a/b', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: '/a/b', value: 2 },
      reason: 'parent-not-found',
    });
  });

  it('replaces the whole document when the path is empty', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'add', path: '', value: { b: 2 } }]);
    expect(result).toEqual({ ok: true, value: { b: 2 } });
  });

  it('fails with invalid-path for a malformed pointer', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'add', path: 'a', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'add', path: 'a', value: 2 },
      reason: 'invalid-path',
    });
  });
});

describe('applyPatch — remove', () => {
  it('removes an object key', () => {
    const result = applyPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }]);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('removes an array element and closes the gap', () => {
    const result = applyPatch({ list: ['a', 'b', 'c'] }, [
      { op: 'remove', path: '/list/1' },
    ]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'c'] } });
  });

  it('fails with path-not-found for a missing object key', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'remove', path: '/b' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '/b' },
      reason: 'path-not-found',
    });
  });

  it('fails with index-out-of-bounds for a missing array index', () => {
    const result = applyPatch({ list: ['a'] }, [{ op: 'remove', path: '/list/1' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '/list/1' },
      reason: 'index-out-of-bounds',
    });
  });

  it('fails with invalid-path when removing the whole document', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'remove', path: '' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '' },
      reason: 'invalid-path',
    });
  });

  it('fails with invalid-path when removing the array append token', () => {
    const result = applyPatch({ list: ['a'] }, [{ op: 'remove', path: '/list/-' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'remove', path: '/list/-' },
      reason: 'invalid-path',
    });
  });
});

describe('applyPatch — replace', () => {
  it('replaces an existing object key', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { a: 2 } });
  });

  it('replaces an existing array element in place', () => {
    const result = applyPatch({ list: ['a', 'b'] }, [
      { op: 'replace', path: '/list/0', value: 'z' },
    ]);
    expect(result).toEqual({ ok: true, value: { list: ['z', 'b'] } });
  });

  it('fails with path-not-found for a key that does not exist', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'replace', path: '/b', value: 2 },
      reason: 'path-not-found',
    });
  });

  it('fails with index-out-of-bounds for an index that does not exist', () => {
    const result = applyPatch({ list: ['a'] }, [
      { op: 'replace', path: '/list/2', value: 'z' },
    ]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'replace', path: '/list/2', value: 'z' },
      reason: 'index-out-of-bounds',
    });
  });

  it('replaces the whole document when the path is empty', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: [1, 2] }]);
    expect(result).toEqual({ ok: true, value: [1, 2] });
  });
});

describe('applyPatch — deep nesting and escaped pointers', () => {
  it('replaces a deeply nested leaf', () => {
    const doc = { a: { b: { c: { d: [10, 20, 30] } } } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/a/b/c/d/2', value: 99 }]);
    expect(result).toEqual({ ok: true, value: { a: { b: { c: { d: [10, 20, 99] } } } } });
  });

  it('resolves escaped keys through the pointer', () => {
    const doc = { 'a/b': { 'c~d': 1 } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/a~1b/c~0d', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { 'a/b': { 'c~d': 2 } } });
  });

  it('resolves an empty-string key', () => {
    const doc: Record<string, unknown> = { '': 1 };
    const result = applyPatch(doc, [{ op: 'replace', path: '/', value: 2 }]);
    expect(result).toEqual({ ok: true, value: { '': 2 } });
  });
});

describe('applyPatch — immutability', () => {
  it('never mutates the input document', () => {
    const doc = { a: { b: [1, 2] }, keep: { x: 1 } };
    const snapshot = JSON.parse(JSON.stringify(doc)) as unknown;

    const result = applyPatch(doc, [
      { op: 'add', path: '/a/b/-', value: 3 },
      { op: 'add', path: '/c', value: true },
      { op: 'remove', path: '/a/b/0' },
    ]);

    expect(result).toEqual({ ok: true, value: { a: { b: [2, 3] }, keep: { x: 1 }, c: true } });
    expect(doc).toEqual(snapshot);
  });

  it('shares untouched subtrees with the input document', () => {
    const doc = { touched: { n: 1 }, keep: { x: 1 } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/touched/n', value: 2 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const next = result.value as { touched: unknown; keep: unknown };
    expect(next.keep).toBe(doc.keep);
    expect(next.touched).not.toBe(doc.touched);
  });

  it('returns the original document unchanged for an empty operation list', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, []);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toBe(doc);
  });

  it('does not mutate the document when a later operation fails', () => {
    const doc = { a: 1 };
    const ops: PatchOp[] = [
      { op: 'add', path: '/b', value: 2 },
      { op: 'remove', path: '/nope' },
    ];
    const result = applyPatch(doc, ops);
    expect(result.ok).toBe(false);
    expect(doc).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/core/state/json-patch.test.ts`

Expected: FAIL with `SyntaxError: [vite] The requested module '/src/core/state/json-patch.ts' does not provide an export named 'applyPatch'`

- [ ] **Step 8: Write the implementation**

Replace `src/core/state/json-patch.ts` with:

```ts
import type { PatchFailure, PatchOp, PatchResult } from '../model/types';

/**
 * Parse an RFC 6901 JSON Pointer into its unescaped reference tokens.
 *
 * Returns `[]` for the whole-document pointer `''`, and `null` for any string that is
 * neither `''` nor slash-prefixed. Escapes are undone in the order mandated by RFC 6901:
 * `~1` -> `/` first, then `~0` -> `~`, so that `~01` decodes to the literal `~1`.
 */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (pointer[0] !== '/') return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.split('~1').join('/').split('~0').join('~'));
}

/** Result of a single operation, before it is positioned within the patch. */
type OpOutcome = { ok: true; value: unknown } | { ok: false; reason: PatchFailure };

/** A terminal mutation applied to the container that owns the final reference token. */
type Terminal =
  | { kind: 'add'; value: unknown }
  | { kind: 'replace'; value: unknown }
  | { kind: 'remove' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Strict RFC 6901 array index: digits only, no sign, no leading zeros. */
function parseIndex(token: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return null;
  return Number(token);
}

function terminalArray(arr: readonly unknown[], token: string, action: Terminal): OpOutcome {
  if (action.kind === 'add') {
    const next = arr.slice();
    if (token === '-') {
      next.push(action.value);
      return { ok: true, value: next };
    }
    const idx = parseIndex(token);
    if (idx === null) return { ok: false, reason: 'invalid-path' };
    if (idx > arr.length) return { ok: false, reason: 'index-out-of-bounds' };
    next.splice(idx, 0, action.value);
    return { ok: true, value: next };
  }

  const idx = parseIndex(token);
  if (idx === null) return { ok: false, reason: 'invalid-path' };
  if (idx >= arr.length) return { ok: false, reason: 'index-out-of-bounds' };
  const next = arr.slice();
  if (action.kind === 'remove') next.splice(idx, 1);
  else next[idx] = action.value;
  return { ok: true, value: next };
}

function terminalObject(
  obj: Record<string, unknown>,
  token: string,
  action: Terminal,
): OpOutcome {
  if (action.kind === 'add') return { ok: true, value: { ...obj, [token]: action.value } };
  if (!hasOwn(obj, token)) return { ok: false, reason: 'path-not-found' };
  if (action.kind === 'replace') return { ok: true, value: { ...obj, [token]: action.value } };
  const next = { ...obj };
  delete next[token];
  return { ok: true, value: next };
}

/**
 * Apply `action` at `tokens[depth..]` inside `container`, shallow-copying every container
 * along the mutated path and sharing every untouched subtree with the input.
 */
function applyAt(
  container: unknown,
  tokens: readonly string[],
  depth: number,
  action: Terminal,
): OpOutcome {
  const token = tokens[depth];
  const isLast = depth === tokens.length - 1;

  if (Array.isArray(container)) {
    if (isLast) return terminalArray(container, token, action);
    const idx = parseIndex(token);
    if (idx === null) return { ok: false, reason: 'invalid-path' };
    if (idx >= container.length) return { ok: false, reason: 'index-out-of-bounds' };
    const child = applyAt(container[idx], tokens, depth + 1, action);
    if (!child.ok) return child;
    const next = container.slice();
    next[idx] = child.value;
    return { ok: true, value: next };
  }

  if (isRecord(container)) {
    if (isLast) return terminalObject(container, token, action);
    if (!hasOwn(container, token)) return { ok: false, reason: 'parent-not-found' };
    const child = applyAt(container[token], tokens, depth + 1, action);
    if (!child.ok) return child;
    return { ok: true, value: { ...container, [token]: child.value } };
  }

  return { ok: false, reason: 'parent-not-found' };
}

function applyOne(doc: unknown, op: PatchOp): OpOutcome {
  const tokens = parsePointer(op.path);
  if (tokens === null) return { ok: false, reason: 'invalid-path' };

  switch (op.op) {
    case 'add':
      if (tokens.length === 0) return { ok: true, value: op.value };
      return applyAt(doc, tokens, 0, { kind: 'add', value: op.value });
    case 'replace':
      if (tokens.length === 0) return { ok: true, value: op.value };
      return applyAt(doc, tokens, 0, { kind: 'replace', value: op.value });
    case 'remove':
      if (tokens.length === 0) return { ok: false, reason: 'invalid-path' };
      return applyAt(doc, tokens, 0, { kind: 'remove' });
    default:
      return { ok: false, reason: 'invalid-op' };
  }
}

/**
 * Apply an RFC 6902 patch to `doc` without mutating it.
 *
 * Operations are applied in order against the running document. The first failure aborts
 * the patch and reports its position via `opIndex`; no partial value is returned.
 */
export function applyPatch(doc: unknown, ops: PatchOp[]): PatchResult {
  let current = doc;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const outcome = applyOne(current, op);
    if (!outcome.ok) return { ok: false, opIndex: i, op, reason: outcome.reason };
    current = outcome.value;
  }
  return { ok: true, value: current };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/core/state/json-patch.test.ts`

Expected: PASS, 39 tests.

- [ ] **Step 10: Commit**

Run: `git add src/core/state/json-patch.ts src/core/state/json-patch.test.ts && git commit -m "feat(core): applyPatch for add, remove and replace"`

---

#### Cycle 3 — `move` / `copy` / `test`, `invalid-op`, and failure positioning

- [ ] **Step 11: Write the failing test**

Append these describe blocks to the end of `src/core/state/json-patch.test.ts`:

```ts
describe('applyPatch — test', () => {
  it('passes when the value is deeply equal', () => {
    const doc = { a: { b: [1, { c: 2 }] } };
    const result = applyPatch(doc, [
      { op: 'test', path: '/a', value: { b: [1, { c: 2 }] } },
    ]);
    expect(result).toEqual({ ok: true, value: doc });
  });

  it('passes for scalars and null', () => {
    const result = applyPatch({ a: null, b: false, c: 0 }, [
      { op: 'test', path: '/a', value: null },
      { op: 'test', path: '/b', value: false },
      { op: 'test', path: '/c', value: 0 },
    ]);
    expect(result).toEqual({ ok: true, value: { a: null, b: false, c: 0 } });
  });

  it('tests the whole document at the empty path', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'test', path: '', value: { a: 1 } }]);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('fails with test-failed on a scalar mismatch', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'test', path: '/a', value: 2 },
      reason: 'test-failed',
    });
  });

  it('fails with test-failed on a deep mismatch', () => {
    const result = applyPatch({ a: { b: [1, 2] } }, [
      { op: 'test', path: '/a', value: { b: [1, 2, 3] } },
    ]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'test', path: '/a', value: { b: [1, 2, 3] } },
      reason: 'test-failed',
    });
  });

  it('distinguishes an array from an object with numeric keys', () => {
    const result = applyPatch({ a: [1] }, [{ op: 'test', path: '/a', value: { 0: 1 } }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'test', path: '/a', value: { 0: 1 } },
      reason: 'test-failed',
    });
  });

  it('fails with path-not-found when the tested key is absent', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'test', path: '/b', value: 1 }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'test', path: '/b', value: 1 },
      reason: 'path-not-found',
    });
  });
});

describe('applyPatch — move', () => {
  it('moves an object key', () => {
    const result = applyPatch({ a: 1, b: { } }, [
      { op: 'move', path: '/b/a', from: '/a' },
    ]);
    expect(result).toEqual({ ok: true, value: { b: { a: 1 } } });
  });

  it('reorders an array element', () => {
    const result = applyPatch({ list: ['a', 'b', 'c'] }, [
      { op: 'move', path: '/list/0', from: '/list/2' },
    ]);
    expect(result).toEqual({ ok: true, value: { list: ['c', 'a', 'b'] } });
  });

  it('does not mutate the source document', () => {
    const doc = { a: { n: 1 }, b: {} };
    const result = applyPatch(doc, [{ op: 'move', path: '/b/a', from: '/a' }]);
    expect(result).toEqual({ ok: true, value: { b: { a: { n: 1 } } } });
    expect(doc).toEqual({ a: { n: 1 }, b: {} });
  });

  it('fails with path-not-found when the source is absent', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'move', path: '/b', from: '/zzz' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'move', path: '/b', from: '/zzz' },
      reason: 'path-not-found',
    });
  });

  it('fails with invalid-path when moving the whole document', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'move', path: '/b', from: '' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'move', path: '/b', from: '' },
      reason: 'invalid-path',
    });
  });

  it('fails with invalid-path when moving a value into its own descendant', () => {
    const result = applyPatch({ a: { b: {} } }, [
      { op: 'move', path: '/a/b/c', from: '/a' },
    ]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'move', path: '/a/b/c', from: '/a' },
      reason: 'invalid-path',
    });
  });

  it('fails with invalid-path when the source pointer is malformed', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'move', path: '/b', from: 'a' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'move', path: '/b', from: 'a' },
      reason: 'invalid-path',
    });
  });
});

describe('applyPatch — copy', () => {
  it('copies an object key, leaving the source in place', () => {
    const result = applyPatch({ a: 1, b: {} }, [
      { op: 'copy', path: '/b/a', from: '/a' },
    ]);
    expect(result).toEqual({ ok: true, value: { a: 1, b: { a: 1 } } });
  });

  it('copies into an array', () => {
    const result = applyPatch({ list: ['a'], src: 'z' }, [
      { op: 'copy', path: '/list/-', from: '/src' },
    ]);
    expect(result).toEqual({ ok: true, value: { list: ['a', 'z'], src: 'z' } });
  });

  it('copies over the whole document', () => {
    const result = applyPatch({ a: { n: 1 } }, [{ op: 'copy', path: '', from: '/a' }]);
    expect(result).toEqual({ ok: true, value: { n: 1 } });
  });

  it('does not mutate the source document', () => {
    const doc = { a: { n: 1 }, b: {} };
    const result = applyPatch(doc, [
      { op: 'copy', path: '/b/a', from: '/a' },
      { op: 'replace', path: '/b/a/n', value: 2 },
    ]);
    expect(result).toEqual({ ok: true, value: { a: { n: 1 }, b: { a: { n: 2 } } } });
    expect(doc).toEqual({ a: { n: 1 }, b: {} });
  });

  it('fails with index-out-of-bounds when the source index is absent', () => {
    const result = applyPatch({ list: ['a'], b: {} }, [
      { op: 'copy', path: '/b/x', from: '/list/4' },
    ]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'copy', path: '/b/x', from: '/list/4' },
      reason: 'index-out-of-bounds',
    });
  });

  it('fails with parent-not-found when the source parent is absent', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'copy', path: '/b', from: '/zzz/deep' }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'copy', path: '/b', from: '/zzz/deep' },
      reason: 'parent-not-found',
    });
  });
});

describe('applyPatch — invalid-op', () => {
  it('fails with invalid-op for an unrecognized op string', () => {
    const ops = [{ op: 'frobnicate', path: '/a', value: 1 }] as unknown as PatchOp[];
    const result = applyPatch({ a: 1 }, ops);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'frobnicate', path: '/a', value: 1 },
      reason: 'invalid-op',
    });
  });

  it('fails with invalid-op when op is missing entirely', () => {
    const ops = [{ path: '/a', value: 1 }] as unknown as PatchOp[];
    const result = applyPatch({ a: 1 }, ops);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { path: '/a', value: 1 },
      reason: 'invalid-op',
    });
  });

  it('fails with invalid-op for an op that is not an object', () => {
    const ops = ['add'] as unknown as PatchOp[];
    const result = applyPatch({ a: 1 }, ops);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: 'add',
      reason: 'invalid-op',
    });
  });

  it('reports invalid-op before evaluating the path', () => {
    const ops = [{ op: 'FROB', path: 'not-a-pointer' }] as unknown as PatchOp[];
    const result = applyPatch({ a: 1 }, ops);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid-op');
  });
});

describe('applyPatch — failure positioning', () => {
  it('reports opIndex 2 when the third operation fails and returns no partial value', () => {
    const doc = { a: 1, list: ['x'] };
    const ops: PatchOp[] = [
      { op: 'add', path: '/b', value: 2 },
      { op: 'replace', path: '/a', value: 10 },
      { op: 'remove', path: '/missing' },
      { op: 'add', path: '/c', value: 3 },
    ];

    const result = applyPatch(doc, ops);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.opIndex).toBe(2);
    expect(result.op).toEqual({ op: 'remove', path: '/missing' });
    expect(result.reason).toBe('path-not-found');
    expect(Object.prototype.hasOwnProperty.call(result, 'value')).toBe(false);
    expect(doc).toEqual({ a: 1, list: ['x'] });
  });

  it('carries the exact failing op object through in `op`', () => {
    const ops: PatchOp[] = [
      { op: 'test', path: '/a', value: 1 },
      { op: 'test', path: '/a', value: 2 },
    ];
    const result = applyPatch({ a: 1 }, ops);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.opIndex).toBe(1);
    expect(result.op).toBe(ops[1]);
  });

  it('stops at the first failure even when a later operation would also fail', () => {
    const ops: PatchOp[] = [
      { op: 'remove', path: '/one' },
      { op: 'remove', path: '/two' },
    ];
    const result = applyPatch({}, ops);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.opIndex).toBe(0);
  });

  it('reports opIndex 0 for a single failing operation', () => {
    const result = applyPatch({}, [{ op: 'test', path: '', value: { a: 1 } }]);
    expect(result).toEqual({
      ok: false,
      opIndex: 0,
      op: { op: 'test', path: '', value: { a: 1 } },
      reason: 'test-failed',
    });
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/core/state/json-patch.test.ts`

Expected: FAIL — `applyPatch — test > passes when the value is deeply equal` reports
`AssertionError: expected { ok: false, opIndex: 0, … } to deeply equal { ok: true, value: … }`
because `test`, `move` and `copy` currently fall through to `invalid-op`.

- [ ] **Step 13: Write the implementation**

Replace `src/core/state/json-patch.ts` with the final version:

```ts
import type { PatchFailure, PatchOp, PatchResult } from '../model/types';

/**
 * Parse an RFC 6901 JSON Pointer into its unescaped reference tokens.
 *
 * Returns `[]` for the whole-document pointer `''`, and `null` for any string that is
 * neither `''` nor slash-prefixed. Escapes are undone in the order mandated by RFC 6901:
 * `~1` -> `/` first, then `~0` -> `~`, so that `~01` decodes to the literal `~1`.
 */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (pointer[0] !== '/') return null;
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.split('~1').join('/').split('~0').join('~'));
}

/** Result of a single operation, before it is positioned within the patch. */
type OpOutcome = { ok: true; value: unknown } | { ok: false; reason: PatchFailure };

/** A terminal mutation applied to the container that owns the final reference token. */
type Terminal =
  | { kind: 'add'; value: unknown }
  | { kind: 'replace'; value: unknown }
  | { kind: 'remove' };

const KNOWN_OPS: ReadonlySet<string> = new Set([
  'add',
  'remove',
  'replace',
  'move',
  'copy',
  'test',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Strict RFC 6901 array index: digits only, no sign, no leading zeros. */
function parseIndex(token: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return null;
  return Number(token);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
      if (!hasOwn(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/** True when `prefix` addresses a strict ancestor of `full`. */
function isStrictAncestor(prefix: readonly string[], full: readonly string[]): boolean {
  if (full.length <= prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== full[i]) return false;
  }
  return true;
}

function terminalArray(arr: readonly unknown[], token: string, action: Terminal): OpOutcome {
  if (action.kind === 'add') {
    const next = arr.slice();
    if (token === '-') {
      next.push(action.value);
      return { ok: true, value: next };
    }
    const idx = parseIndex(token);
    if (idx === null) return { ok: false, reason: 'invalid-path' };
    if (idx > arr.length) return { ok: false, reason: 'index-out-of-bounds' };
    next.splice(idx, 0, action.value);
    return { ok: true, value: next };
  }

  const idx = parseIndex(token);
  if (idx === null) return { ok: false, reason: 'invalid-path' };
  if (idx >= arr.length) return { ok: false, reason: 'index-out-of-bounds' };
  const next = arr.slice();
  if (action.kind === 'remove') next.splice(idx, 1);
  else next[idx] = action.value;
  return { ok: true, value: next };
}

function terminalObject(
  obj: Record<string, unknown>,
  token: string,
  action: Terminal,
): OpOutcome {
  if (action.kind === 'add') return { ok: true, value: { ...obj, [token]: action.value } };
  if (!hasOwn(obj, token)) return { ok: false, reason: 'path-not-found' };
  if (action.kind === 'replace') return { ok: true, value: { ...obj, [token]: action.value } };
  const next = { ...obj };
  delete next[token];
  return { ok: true, value: next };
}

/**
 * Apply `action` at `tokens[depth..]` inside `container`, shallow-copying every container
 * along the mutated path and sharing every untouched subtree with the input.
 */
function applyAt(
  container: unknown,
  tokens: readonly string[],
  depth: number,
  action: Terminal,
): OpOutcome {
  const token = tokens[depth];
  const isLast = depth === tokens.length - 1;

  if (Array.isArray(container)) {
    if (isLast) return terminalArray(container, token, action);
    const idx = parseIndex(token);
    if (idx === null) return { ok: false, reason: 'invalid-path' };
    if (idx >= container.length) return { ok: false, reason: 'index-out-of-bounds' };
    const child = applyAt(container[idx], tokens, depth + 1, action);
    if (!child.ok) return child;
    const next = container.slice();
    next[idx] = child.value;
    return { ok: true, value: next };
  }

  if (isRecord(container)) {
    if (isLast) return terminalObject(container, token, action);
    if (!hasOwn(container, token)) return { ok: false, reason: 'parent-not-found' };
    const child = applyAt(container[token], tokens, depth + 1, action);
    if (!child.ok) return child;
    return { ok: true, value: { ...container, [token]: child.value } };
  }

  return { ok: false, reason: 'parent-not-found' };
}

/** Read the value at `tokens`, distinguishing a missing leaf from a missing parent. */
function readAt(doc: unknown, tokens: readonly string[]): OpOutcome {
  let current = doc;
  for (let depth = 0; depth < tokens.length; depth++) {
    const token = tokens[depth];
    if (Array.isArray(current)) {
      const idx = parseIndex(token);
      if (idx === null) return { ok: false, reason: 'invalid-path' };
      if (idx >= current.length) return { ok: false, reason: 'index-out-of-bounds' };
      current = current[idx];
    } else if (isRecord(current)) {
      if (!hasOwn(current, token)) {
        const last = depth === tokens.length - 1;
        return { ok: false, reason: last ? 'path-not-found' : 'parent-not-found' };
      }
      current = current[token];
    } else {
      return { ok: false, reason: 'parent-not-found' };
    }
  }
  return { ok: true, value: current };
}

function applyOne(doc: unknown, op: PatchOp): OpOutcome {
  const tokens = parsePointer(op.path);
  if (tokens === null) return { ok: false, reason: 'invalid-path' };

  switch (op.op) {
    case 'add':
      if (tokens.length === 0) return { ok: true, value: op.value };
      return applyAt(doc, tokens, 0, { kind: 'add', value: op.value });

    case 'replace':
      if (tokens.length === 0) return { ok: true, value: op.value };
      return applyAt(doc, tokens, 0, { kind: 'replace', value: op.value });

    case 'remove':
      if (tokens.length === 0) return { ok: false, reason: 'invalid-path' };
      return applyAt(doc, tokens, 0, { kind: 'remove' });

    case 'test': {
      const found = readAt(doc, tokens);
      if (!found.ok) return found;
      if (!deepEqual(found.value, op.value)) return { ok: false, reason: 'test-failed' };
      return { ok: true, value: doc };
    }

    case 'copy': {
      const fromTokens = parsePointer(op.from);
      if (fromTokens === null) return { ok: false, reason: 'invalid-path' };
      const found = readAt(doc, fromTokens);
      if (!found.ok) return found;
      if (tokens.length === 0) return { ok: true, value: found.value };
      return applyAt(doc, tokens, 0, { kind: 'add', value: found.value });
    }

    case 'move': {
      const fromTokens = parsePointer(op.from);
      if (fromTokens === null) return { ok: false, reason: 'invalid-path' };
      if (fromTokens.length === 0) return { ok: false, reason: 'invalid-path' };
      if (isStrictAncestor(fromTokens, tokens)) return { ok: false, reason: 'invalid-path' };
      const found = readAt(doc, fromTokens);
      if (!found.ok) return found;
      const removed = applyAt(doc, fromTokens, 0, { kind: 'remove' });
      if (!removed.ok) return removed;
      if (tokens.length === 0) return { ok: true, value: found.value };
      return applyAt(removed.value, tokens, 0, { kind: 'add', value: found.value });
    }

    default:
      return { ok: false, reason: 'invalid-op' };
  }
}

/**
 * Apply an RFC 6902 patch to `doc` without mutating it.
 *
 * Operations are applied in order against the running document. The first failure aborts
 * the patch and reports its position via `opIndex`; no partial value is returned, so the
 * caller can render the failure in place without a half-applied document.
 */
export function applyPatch(doc: unknown, ops: PatchOp[]): PatchResult {
  let current = doc;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const name: unknown = isRecord(op) ? op.op : undefined;
    if (typeof name !== 'string' || !KNOWN_OPS.has(name)) {
      return { ok: false, opIndex: i, op, reason: 'invalid-op' };
    }
    const outcome = applyOne(current, op);
    if (!outcome.ok) return { ok: false, opIndex: i, op, reason: outcome.reason };
    current = outcome.value;
  }
  return { ok: true, value: current };
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/core/state/json-patch.test.ts`

Expected: PASS, 67 tests.

- [ ] **Step 15: Commit**

Run: `git add src/core/state/json-patch.ts src/core/state/json-patch.test.ts && git commit -m "feat(core): move, copy, test ops and positioned patch failures"`

---

### Task 9: State timeline of snapshot and delta frames

**Files:**
- Create: `src/core/state/timeline.ts`
- Test: `src/core/state/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/state/timeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStateTimeline } from './timeline';
import type { PatchOp } from '../model/types';

describe('createStateTimeline — empty', () => {
  it('starts with no frames', () => {
    const timeline = createStateTimeline();
    expect(timeline.frames()).toEqual([]);
  });

  it('reports current() as undefined before any snapshot', () => {
    const timeline = createStateTimeline();
    expect(timeline.current()).toBeUndefined();
  });

  it('reports sawSnapshot() as false before any snapshot', () => {
    const timeline = createStateTimeline();
    expect(timeline.sawSnapshot()).toBe(false);
  });
});

describe('createStateTimeline — applySnapshot', () => {
  it('returns a snapshot frame carrying the value', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applySnapshot(1, 100, { count: 0 });
    expect(frame).toEqual({ seq: 1, tMs: 100, kind: 'snapshot', value: { count: 0 } });
  });

  it('appends the returned frame object itself to frames()', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applySnapshot(1, 100, { count: 0 });
    expect(timeline.frames()).toHaveLength(1);
    expect(timeline.frames()[0]).toBe(frame);
  });

  it('makes the snapshot the current value and flips sawSnapshot()', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    expect(timeline.current()).toEqual({ count: 0 });
    expect(timeline.sawSnapshot()).toBe(true);
  });

  it('replaces the whole document wholesale, discarding prior keys', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { a: 1, b: 2 });
    timeline.applyDelta(2, 110, [{ op: 'add', path: '/c', value: 3 }]);
    const frame = timeline.applySnapshot(3, 120, { z: 9 });
    expect(frame.value).toEqual({ z: 9 });
    expect(timeline.current()).toEqual({ z: 9 });
    expect(timeline.frames()).toHaveLength(3);
  });

  it('accepts a non-object snapshot value', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, null);
    expect(timeline.current()).toBeNull();
    expect(timeline.sawSnapshot()).toBe(true);
  });
});

describe('createStateTimeline — applyDelta success', () => {
  it('applies the patch to the previous frame value and retains the patch', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const ops: PatchOp[] = [{ op: 'replace', path: '/count', value: 1 }];

    const frame = timeline.applyDelta(2, 150, ops);

    expect(frame).toEqual({
      seq: 2,
      tMs: 150,
      kind: 'delta',
      value: { count: 1 },
      patch: ops,
    });
    expect(frame.failure).toBeUndefined();
    expect(timeline.current()).toEqual({ count: 1 });
  });

  it('appends the returned frame object itself to frames()', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const frame = timeline.applyDelta(2, 150, [{ op: 'replace', path: '/count', value: 1 }]);
    expect(timeline.frames()[1]).toBe(frame);
  });

  it('chains successive deltas onto the previous frame value', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { items: [] });
    timeline.applyDelta(2, 110, [{ op: 'add', path: '/items/-', value: 'a' }]);
    timeline.applyDelta(3, 120, [{ op: 'add', path: '/items/-', value: 'b' }]);

    expect(timeline.current()).toEqual({ items: ['a', 'b'] });
    expect(timeline.frames().map((f) => f.value)).toEqual([
      { items: [] },
      { items: ['a'] },
      { items: ['a', 'b'] },
    ]);
  });

  it('does not mutate the snapshot frame value when a later delta applies', () => {
    const timeline = createStateTimeline();
    const snapshot = timeline.applySnapshot(1, 100, { items: ['a'] });
    timeline.applyDelta(2, 110, [{ op: 'add', path: '/items/-', value: 'b' }]);
    expect(snapshot.value).toEqual({ items: ['a'] });
  });
});

describe('createStateTimeline — applyDelta failure', () => {
  it('records the failing opIndex and reason on the frame', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const ops: PatchOp[] = [
      { op: 'replace', path: '/count', value: 1 },
      { op: 'remove', path: '/missing' },
    ];

    const frame = timeline.applyDelta(2, 150, ops);

    expect(frame.failure).toEqual({ opIndex: 1, reason: 'path-not-found' });
    expect(frame.kind).toBe('delta');
    expect(frame.patch).toBe(ops);
  });

  it('holds the frame value at the previous frame value so state does not advance', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });

    const frame = timeline.applyDelta(2, 150, [
      { op: 'replace', path: '/count', value: 1 },
      { op: 'remove', path: '/missing' },
    ]);

    expect(frame.value).toEqual({ count: 0 });
    expect(timeline.current()).toEqual({ count: 0 });
  });

  it('still appends the failed frame so the scrubber can mark it', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const frame = timeline.applyDelta(2, 150, [{ op: 'remove', path: '/missing' }]);

    expect(timeline.frames()).toHaveLength(2);
    expect(timeline.frames()[1]).toBe(frame);
    expect(timeline.frames()[1]?.failure).toEqual({ opIndex: 0, reason: 'path-not-found' });
  });

  it('lets a subsequent delta apply against the held value', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    timeline.applyDelta(2, 150, [{ op: 'remove', path: '/missing' }]);
    const frame = timeline.applyDelta(3, 160, [{ op: 'replace', path: '/count', value: 7 }]);

    expect(frame.failure).toBeUndefined();
    expect(frame.value).toEqual({ count: 7 });
    expect(timeline.current()).toEqual({ count: 7 });
  });

  it('records test-failed with its opIndex', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { count: 0 });
    const frame = timeline.applyDelta(2, 150, [
      { op: 'add', path: '/a', value: 1 },
      { op: 'add', path: '/b', value: 2 },
      { op: 'test', path: '/count', value: 99 },
    ]);
    expect(frame.failure).toEqual({ opIndex: 2, reason: 'test-failed' });
    expect(frame.value).toEqual({ count: 0 });
  });
});

describe('createStateTimeline — delta before any snapshot', () => {
  it('does not throw and still produces a frame', () => {
    const timeline = createStateTimeline();
    const ops: PatchOp[] = [{ op: 'add', path: '/a', value: 1 }];

    const frame = timeline.applyDelta(1, 100, ops);

    expect(frame.kind).toBe('delta');
    expect(frame.seq).toBe(1);
    expect(frame.patch).toBe(ops);
    expect(timeline.frames()).toHaveLength(1);
    expect(timeline.frames()[0]).toBe(frame);
  });

  it('records the patch failure against the undefined document', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applyDelta(1, 100, [{ op: 'add', path: '/a', value: 1 }]);
    expect(frame.failure).toEqual({ opIndex: 0, reason: 'parent-not-found' });
    expect(frame.value).toBeUndefined();
  });

  it('leaves sawSnapshot() false because the warning belongs to the validator', () => {
    const timeline = createStateTimeline();
    timeline.applyDelta(1, 100, [{ op: 'add', path: '/a', value: 1 }]);
    expect(timeline.sawSnapshot()).toBe(false);
  });

  it('applies a whole-document delta even with no prior snapshot', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applyDelta(1, 100, [{ op: 'add', path: '', value: { a: 1 } }]);
    expect(frame.failure).toBeUndefined();
    expect(frame.value).toEqual({ a: 1 });
    expect(timeline.current()).toEqual({ a: 1 });
    expect(timeline.sawSnapshot()).toBe(false);
  });
});

describe('createStateTimeline — frame ordering', () => {
  it('accumulates frames in call order with their seq, tMs and kind', () => {
    const timeline = createStateTimeline();
    timeline.applySnapshot(1, 100, { n: 0 });
    timeline.applyDelta(2, 110, [{ op: 'replace', path: '/n', value: 1 }]);
    timeline.applyDelta(3, 130, [{ op: 'remove', path: '/gone' }]);
    timeline.applySnapshot(4, 160, { n: 5 });

    expect(timeline.frames().map((f) => [f.seq, f.tMs, f.kind])).toEqual([
      [1, 100, 'snapshot'],
      [2, 110, 'delta'],
      [3, 130, 'delta'],
      [4, 160, 'snapshot'],
    ]);
  });

  it('does not set patch on snapshot frames', () => {
    const timeline = createStateTimeline();
    const frame = timeline.applySnapshot(1, 100, { n: 0 });
    expect(frame.patch).toBeUndefined();
    expect(frame.failure).toBeUndefined();
  });

  it('keeps separate timelines independent', () => {
    const a = createStateTimeline();
    const b = createStateTimeline();
    a.applySnapshot(1, 100, { n: 1 });
    expect(b.frames()).toEqual([]);
    expect(b.current()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/state/timeline.test.ts`

Expected: FAIL with `Error: Failed to resolve import "./timeline" from "src/core/state/timeline.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `src/core/state/timeline.ts`:

```ts
import type { PatchOp, StateFrame } from '../model/types';
import { applyPatch } from './json-patch';

export interface StateTimeline {
  applySnapshot(seq: number, tMs: number, value: unknown): StateFrame;
  applyDelta(seq: number, tMs: number, ops: PatchOp[]): StateFrame;
  frames(): StateFrame[];
  current(): unknown;
  sawSnapshot(): boolean;
}

/**
 * Accumulates the STATE_SNAPSHOT / STATE_DELTA history for one run.
 *
 * Every call appends exactly one frame, including a delta whose patch failed: the panel's
 * scrubber needs the failed step to exist so it can be marked in place. A failed delta
 * does not advance the state — its frame carries the previous value plus the positioned
 * `failure`. A delta arriving before any snapshot is applied against `undefined` and is
 * not an error here; `delta-before-snapshot` is raised by the validator, not the timeline.
 */
export function createStateTimeline(): StateTimeline {
  const log: StateFrame[] = [];
  let value: unknown = undefined;
  let snapshotSeen = false;

  return {
    applySnapshot(seq, tMs, snapshot) {
      value = snapshot;
      snapshotSeen = true;
      const frame: StateFrame = { seq, tMs, kind: 'snapshot', value: snapshot };
      log.push(frame);
      return frame;
    },

    applyDelta(seq, tMs, ops) {
      const result = applyPatch(value, ops);
      const frame: StateFrame = result.ok
        ? { seq, tMs, kind: 'delta', value: result.value, patch: ops }
        : {
            seq,
            tMs,
            kind: 'delta',
            value,
            patch: ops,
            failure: { opIndex: result.opIndex, reason: result.reason },
          };
      if (result.ok) value = result.value;
      log.push(frame);
      return frame;
    },

    frames() {
      return log.slice();
    },

    current() {
      return value;
    },

    sawSnapshot() {
      return snapshotSeen;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/state/timeline.test.ts`

Expected: PASS, 25 tests.

- [ ] **Step 5: Commit**

Run: `git add src/core/state/timeline.ts src/core/state/timeline.test.ts && git commit -m "feat(core): state timeline with positioned delta failures"`

---

## Contract gaps

1. **Task numbering.** The LOCKED CONTRACT labels `state/json-patch.ts` as Task 9 and
   `state/timeline.ts` as Task 10; this assignment labels them Task 8 and Task 9. This
   section uses the assignment's numbering (8 = json-patch, 9 = timeline). The contract
   also labels `normalizer/chunk-expander.ts` as Task 8, so whoever assembles the final
   plan must renumber one of the two consistently.

2. **`PatchFailure` for an out-of-range index at an intermediate depth.** The contract
   fixes the six failure literals but not which one applies when a non-terminal token
   indexes past the end of an array (e.g. `replace /list/9/name` on a two-element list).
   Decided here: **`index-out-of-bounds` at any depth**, since it is strictly more
   informative than `parent-not-found`, while a missing *object* key at an intermediate
   depth stays `parent-not-found` per the assignment. A non-numeric token addressing an
   array is `invalid-path` at any depth.

3. **`remove` at the root.** The contract says root replacement is supported for
   add/replace/test but is silent on `remove ''`. Decided here: `invalid-path`, because
   there is no representation for "no document" distinct from `undefined`, and treating it
   as success would make `current()` ambiguous with the pre-snapshot state in the timeline.

4. **`move` into a descendant of its own source** (RFC 6902 §4.4 forbids it) has no
   assigned `PatchFailure` literal. Decided here: `invalid-path`. Likewise `move` with
   `from: ''`.

5. **`applyPatch` op validation.** `PatchOp` is a closed union, so an unrecognized `op`
   string is unrepresentable in the type but arrives at runtime from the wire. The
   implementation guards with a runtime `KNOWN_OPS` check before dispatch, and the failing
   result's `op` field carries the raw object through as-is (the contract types it as
   `PatchOp`; at that point it is a cast). Tests exercise it via
   `as unknown as PatchOp[]`.

6. **`frames()` copy semantics.** The contract types `frames(): StateFrame[]` without
   saying whether the array is live. Decided here: it returns a fresh array each call
   (`log.slice()`), while the `StateFrame` objects inside are the same objects returned by
   `applySnapshot` / `applyDelta`, so identity assertions on frames hold.

---

### Task 10: Chunk expander

**Files:**
- Create: `src/core/normalizer/chunk-expander.ts`
- Test: `src/core/normalizer/chunk-expander.test.ts`

Expands `TEXT_MESSAGE_CHUNK` / `TOOL_CALL_CHUNK` / `REASONING_MESSAGE_CHUNK` into
start/content/end triads the way the AG-UI JS client does. `expandChunk` mutates the
`ChunkExpanderState` it is handed (that is the whole point of the state object — it is
carried across calls by the run builder). Non-chunk events pass straight through.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/normalizer/chunk-expander.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent } from '../model/types';
import { createChunkExpanderState, expandChunk } from './chunk-expander';

describe('createChunkExpanderState', () => {
  it('starts with nothing open', () => {
    expect(createChunkExpanderState()).toEqual({});
  });
});

describe('expandChunk — non-chunk events', () => {
  it('passes a non-chunk event through unchanged', () => {
    const state = createChunkExpanderState();
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    const result = expandChunk(event, state, 1);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toBe(event);
    expect(result.issues).toEqual([]);
    expect(state).toEqual({});
  });

  it('passes a plain TEXT_MESSAGE_CONTENT through unchanged', () => {
    const state = createChunkExpanderState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' };

    const result = expandChunk(event, state, 2);

    expect(result.events).toEqual([event]);
    expect(result.issues).toEqual([]);
  });
});

describe('expandChunk — TEXT_MESSAGE_CHUNK', () => {
  it('opens a new message with START then CONTENT', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Hel' },
      state,
      1,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openTextMessageId).toBe('m1');
  });

  it('honours an explicit role on the opening chunk', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'x', role: 'assistant' },
      state,
      1,
    );

    expect(result.events[0]).toEqual({
      type: 'TEXT_MESSAGE_START',
      messageId: 'm1',
      role: 'assistant',
    });
  });

  it('emits START only when the opening chunk carries no delta', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1' }, state, 1);

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openTextMessageId).toBe('m1');
  });

  it('emits CONTENT only for a chunk with the same messageId', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Hel' }, state, 1);

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'lo' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('emits CONTENT only for a chunk that omits messageId while one is open', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Hel' }, state, 1);

    const result = expandChunk({ type: 'TEXT_MESSAGE_CHUNK', delta: 'lo' }, state, 2);

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('produces one START and two CONTENT across two same-id chunks', () => {
    const state = createChunkExpanderState();

    const first = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
      state,
      1,
    );
    const second = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'b' },
      state,
      2,
    );

    expect([...first.events, ...second.events]).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' },
    ]);
  });

  it('ends the open message before starting a new one mid-stream', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', delta: 'b' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'b' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openTextMessageId).toBe('m2');
  });

  it('emits an empty delta as CONTENT so the validator can flag it', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);

    const result = expandChunk(
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: '' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '' },
    ]);
  });

  it('reports chunk-missing-message-id when nothing is open', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'TEXT_MESSAGE_CHUNK', delta: 'orphan' }, state, 7);

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_CHUNK has no messageId and no message is currently open',
        seq: 7,
      },
    ]);
    expect(state.openTextMessageId).toBeUndefined();
  });
});

describe('expandChunk — REASONING_MESSAGE_CHUNK', () => {
  it('opens a reasoning message with START then CONTENT', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'think' },
      state,
      1,
    );

    expect(result.events).toEqual([
      { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'assistant' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openReasoningMessageId).toBe('r1');
    expect(state.openTextMessageId).toBeUndefined();
  });

  it('switches reasoning messages independently of text messages', () => {
    const state = createChunkExpanderState();
    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);
    expandChunk({ type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'x' }, state, 2);

    const result = expandChunk(
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r2', delta: 'y' },
      state,
      3,
    );

    expect(result.events).toEqual([
      { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
      { type: 'REASONING_MESSAGE_START', messageId: 'r2', role: 'assistant' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r2', delta: 'y' },
    ]);
    expect(state.openTextMessageId).toBe('m1');
    expect(state.openReasoningMessageId).toBe('r2');
  });

  it('reports chunk-missing-message-id for reasoning with nothing open', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'REASONING_MESSAGE_CHUNK', delta: 'x' }, state, 4);

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-message-id',
        severity: 'error',
        message:
          'REASONING_MESSAGE_CHUNK has no messageId and no message is currently open',
        seq: 4,
      },
    ]);
  });
});

describe('expandChunk — TOOL_CALL_CHUNK', () => {
  it('opens a new tool call with START then ARGS', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      {
        type: 'TOOL_CALL_CHUNK',
        toolCallId: 'tc1',
        toolCallName: 'search',
        delta: '{"q":',
      },
      state,
      1,
    );

    expect(result.events).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":' },
    ]);
    expect(result.issues).toEqual([]);
    expect(state.openToolCallId).toBe('tc1');
  });

  it('carries parentMessageId onto the synthesized START', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      {
        type: 'TOOL_CALL_CHUNK',
        toolCallId: 'tc1',
        toolCallName: 'search',
        parentMessageId: 'm1',
      },
      state,
      1,
    );

    expect(result.events).toEqual([
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'tc1',
        toolCallName: 'search',
        parentMessageId: 'm1',
      },
    ]);
  });

  it('emits ARGS only for a chunk with the same toolCallId', () => {
    const state = createChunkExpanderState();
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":' },
      state,
      1,
    );

    const result = expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', delta: '"x"}' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '"x"}' },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('emits ARGS only for a chunk that omits toolCallId while one is open', () => {
    const state = createChunkExpanderState();
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search' },
      state,
      1,
    );

    const result = expandChunk({ type: 'TOOL_CALL_CHUNK', delta: '{}' }, state, 2);

    expect(result.events).toEqual([{ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{}' }]);
    expect(result.issues).toEqual([]);
  });

  it('ends the open tool call before starting a new one mid-stream', () => {
    const state = createChunkExpanderState();
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{}' },
      state,
      1,
    );

    const result = expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc2', toolCallName: 'fetch', delta: '{"u":1}' },
      state,
      2,
    );

    expect(result.events).toEqual([
      { type: 'TOOL_CALL_END', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_START', toolCallId: 'tc2', toolCallName: 'fetch' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tc2', delta: '{"u":1}' },
    ]);
    expect(state.openToolCallId).toBe('tc2');
  });

  it('reports chunk-missing-tool-call-name when opening without a name', () => {
    const state = createChunkExpanderState();

    const result = expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', delta: '{}' },
      state,
      5,
    );

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-tool-call-name',
        severity: 'error',
        message: 'TOOL_CALL_CHUNK opens tool call "tc1" without a toolCallName',
        seq: 5,
      },
    ]);
    expect(state.openToolCallId).toBeUndefined();
  });

  it('reports chunk-missing-tool-call-id when nothing is open', () => {
    const state = createChunkExpanderState();

    const result = expandChunk({ type: 'TOOL_CALL_CHUNK', delta: '{}' }, state, 6);

    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      {
        code: 'chunk-missing-tool-call-id',
        severity: 'error',
        message: 'TOOL_CALL_CHUNK has no toolCallId and no tool call is currently open',
        seq: 6,
      },
    ]);
    expect(state.openToolCallId).toBeUndefined();
  });
});

describe('expandChunk — state across calls', () => {
  it('carries text, reasoning and tool state independently across calls', () => {
    const state = createChunkExpanderState();

    expandChunk({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' }, state, 1);
    expandChunk({ type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'b' }, state, 2);
    expandChunk(
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{}' },
      state,
      3,
    );
    expandChunk({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }, state, 4);

    expect(state).toEqual({
      openTextMessageId: 'm1',
      openReasoningMessageId: 'r1',
      openToolCallId: 'tc1',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/normalizer/chunk-expander.test.ts`
Expected: FAIL with `Failed to resolve import "./chunk-expander" from "src/core/normalizer/chunk-expander.test.ts"`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/normalizer/chunk-expander.ts
import type { AguiEvent, Issue, IssueCode } from '../model/types';
import { chunkKindOf } from '../events/table';

export interface ChunkExpanderState {
  openTextMessageId?: string;
  openReasoningMessageId?: string;
  openToolCallId?: string;
}

export interface ChunkExpansion {
  events: AguiEvent[];
  issues: Issue[];
}

export function createChunkExpanderState(): ChunkExpanderState {
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorIssue(code: IssueCode, message: string, seq: number): Issue {
  return { code, severity: 'error', message, seq };
}

function expandMessageChunk(
  event: AguiEvent,
  state: ChunkExpanderState,
  seq: number,
  kind: 'text' | 'reasoning',
): ChunkExpansion {
  const prefix = kind === 'text' ? 'TEXT_MESSAGE' : 'REASONING_MESSAGE';
  const openId =
    kind === 'text' ? state.openTextMessageId : state.openReasoningMessageId;
  const messageId = asString(event.messageId);
  const delta = asString(event.delta);
  const role = asString(event.role) ?? 'assistant';

  const events: AguiEvent[] = [];
  let activeId = openId;

  if (messageId !== undefined && messageId !== openId) {
    if (openId !== undefined) {
      events.push({ type: `${prefix}_END`, messageId: openId });
    }
    events.push({ type: `${prefix}_START`, messageId, role });
    activeId = messageId;
  }

  if (activeId === undefined) {
    return {
      events: [],
      issues: [
        errorIssue(
          'chunk-missing-message-id',
          `${event.type} has no messageId and no message is currently open`,
          seq,
        ),
      ],
    };
  }

  if (delta !== undefined) {
    events.push({ type: `${prefix}_CONTENT`, messageId: activeId, delta });
  }

  if (kind === 'text') {
    state.openTextMessageId = activeId;
  } else {
    state.openReasoningMessageId = activeId;
  }

  return { events, issues: [] };
}

function expandToolChunk(
  event: AguiEvent,
  state: ChunkExpanderState,
  seq: number,
): ChunkExpansion {
  const toolCallId = asString(event.toolCallId);
  const toolCallName = asString(event.toolCallName);
  const parentMessageId = asString(event.parentMessageId);
  const delta = asString(event.delta);
  const openId = state.openToolCallId;

  const events: AguiEvent[] = [];

  if (toolCallId !== undefined && toolCallId !== openId) {
    if (toolCallName === undefined) {
      return {
        events: [],
        issues: [
          errorIssue(
            'chunk-missing-tool-call-name',
            `TOOL_CALL_CHUNK opens tool call "${toolCallId}" without a toolCallName`,
            seq,
          ),
        ],
      };
    }
    if (openId !== undefined) {
      events.push({ type: 'TOOL_CALL_END', toolCallId: openId });
    }
    const start: AguiEvent = { type: 'TOOL_CALL_START', toolCallId, toolCallName };
    if (parentMessageId !== undefined) {
      start.parentMessageId = parentMessageId;
    }
    events.push(start);
    state.openToolCallId = toolCallId;
  }

  const activeId = state.openToolCallId;
  if (activeId === undefined) {
    return {
      events: [],
      issues: [
        errorIssue(
          'chunk-missing-tool-call-id',
          'TOOL_CALL_CHUNK has no toolCallId and no tool call is currently open',
          seq,
        ),
      ],
    };
  }

  if (delta !== undefined) {
    events.push({ type: 'TOOL_CALL_ARGS', toolCallId: activeId, delta });
  }

  return { events, issues: [] };
}

export function expandChunk(
  event: AguiEvent,
  state: ChunkExpanderState,
  seq: number,
): ChunkExpansion {
  const kind = chunkKindOf(event.type);
  if (kind === undefined) {
    return { events: [event], issues: [] };
  }
  if (kind === 'tool') {
    return expandToolChunk(event, state, seq);
  }
  return expandMessageChunk(event, state, seq, kind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/normalizer/chunk-expander.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

Run: `git add src/core/normalizer && git commit -m "feat(devtools): expand chunk events into start/content/end triads"`

---

### Task 11: Validator rules

**Files:**
- Create: `src/core/validator/types.ts`
- Create: `src/core/validator/rules/lifecycle.ts`
- Test: `src/core/validator/rules/lifecycle.test.ts`
- Create: `src/core/validator/rules/text.ts`
- Test: `src/core/validator/rules/text.test.ts`
- Create: `src/core/validator/rules/tool.ts`
- Test: `src/core/validator/rules/tool.test.ts`
- Create: `src/core/validator/rules/state.ts`
- Test: `src/core/validator/rules/state.test.ts`
- Create: `src/core/validator/rules/stream.ts`
- Test: `src/core/validator/rules/stream.test.ts`
- Create: `src/core/validator/index.ts`
- Test: `src/core/validator/index.test.ts`

Every rule is a pure `ValidatorRule`. **Rules never mutate `state`** — the run builder
(Task 13) owns all state transitions and calls `runRules` *before* applying the event's
transition, so `state` always describes the world as it was immediately before the event.
`shape-invalid` / `unknown-event-type` come from Task 5's `checkShape`, `chunk-missing-*`
from Task 10's `expandChunk`, and `keepalive-gap` from Task 13's run builder — none of
them are re-implemented here.

`RunValidationState` and `ValidatorRule` live in `validator/types.ts` and are re-exported
from `validator/index.ts` (see "Contract gaps"), so the rule modules never import from
`index.ts` and there is no import cycle.

- [ ] **Step 1: Write the failing test (lifecycle rules)**

```ts
// src/core/validator/rules/lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../../model/types';
import { ORPHANED_RUN_ID } from '../../model/types';
import type { RunValidationState } from '../types';
import {
  eventAfterTerminalRule,
  eventBeforeRunStartedRule,
  runStartedWithoutInputRule,
  unbalancedStepsRule,
} from './lifecycle';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

describe('eventBeforeRunStartedRule', () => {
  it('flags a non-RUN_STARTED event on the orphaned run', () => {
    const state = makeState({
      run: makeRun({ runId: ORPHANED_RUN_ID, outcome: 'orphaned' }),
    });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' };

    expect(eventBeforeRunStartedRule(event, makeRecord(event, 3), state)).toEqual([
      {
        code: 'event-before-run-started',
        severity: 'error',
        message: 'TEXT_MESSAGE_START arrived before any RUN_STARTED',
        seq: 3,
        runId: ORPHANED_RUN_ID,
      },
    ]);
  });

  it('does not flag RUN_STARTED itself', () => {
    const state = makeState({
      run: makeRun({ runId: ORPHANED_RUN_ID, outcome: 'orphaned' }),
    });
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    expect(eventBeforeRunStartedRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('does not flag events on a real run', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' };

    expect(eventBeforeRunStartedRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('eventAfterTerminalRule', () => {
  it('flags any event once the run has terminated', () => {
    const state = makeState({ terminated: true });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };

    expect(eventAfterTerminalRule(event, makeRecord(event, 9), state)).toEqual([
      {
        code: 'event-after-terminal',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT arrived after the run reached a terminal event',
        seq: 9,
        runId: 'run-1',
      },
    ]);
  });

  it('flags a second terminal event too', () => {
    const state = makeState({ terminated: true });
    const event: AguiEvent = { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' };

    expect(eventAfterTerminalRule(event, makeRecord(event, 10), state)).toEqual([
      {
        code: 'event-after-terminal',
        severity: 'error',
        message: 'RUN_FINISHED arrived after the run reached a terminal event',
        seq: 10,
        runId: 'run-1',
      },
    ]);
  });

  it('is silent while the run is live', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' };

    expect(eventAfterTerminalRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('unbalancedStepsRule', () => {
  it('flags STEP_FINISHED with no matching open step', () => {
    const state = makeState({ openSteps: ['plan'] });
    const event: AguiEvent = { type: 'STEP_FINISHED', stepName: 'execute' };

    expect(unbalancedStepsRule(event, makeRecord(event, 4), state)).toEqual([
      {
        code: 'unbalanced-steps',
        severity: 'warning',
        message: 'STEP_FINISHED "execute" has no matching open STEP_STARTED',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts STEP_FINISHED matching an open step', () => {
    const state = makeState({ openSteps: ['plan', 'execute'] });
    const event: AguiEvent = { type: 'STEP_FINISHED', stepName: 'plan' };

    expect(unbalancedStepsRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores STEP_STARTED and a non-string stepName', () => {
    const state = makeState();
    const started: AguiEvent = { type: 'STEP_STARTED', stepName: 'plan' };
    const broken: AguiEvent = { type: 'STEP_FINISHED', stepName: 42 };

    expect(unbalancedStepsRule(started, makeRecord(started), state)).toEqual([]);
    expect(unbalancedStepsRule(broken, makeRecord(broken), state)).toEqual([]);
  });
});

describe('runStartedWithoutInputRule', () => {
  it('reports RUN_STARTED with no captured input', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    expect(runStartedWithoutInputRule(event, makeRecord(event, 1), state)).toEqual([
      {
        code: 'run-started-without-input',
        severity: 'info',
        message: 'RUN_STARTED has no captured request input; reproducing this run will be harder',
        seq: 1,
        runId: 'run-1',
      },
    ]);
  });

  it('is silent when input was captured', () => {
    const state = makeState({ run: makeRun({ input: { messages: [] } }) });
    const event: AguiEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };

    expect(runStartedWithoutInputRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('is silent for other event types', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'STEP_STARTED', stepName: 'plan' };

    expect(runStartedWithoutInputRule(event, makeRecord(event), state)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/validator/rules/lifecycle.test.ts`
Expected: FAIL with `Failed to resolve import "./lifecycle" from "src/core/validator/rules/lifecycle.test.ts"`

- [ ] **Step 3: Write the implementation (types + lifecycle rules)**

```ts
// src/core/validator/types.ts
import type { AguiEvent, CaptureRecord, Issue, Run } from '../model/types';

export interface RunValidationState {
  run: Run;
  openTextMessages: Set<string>;
  openReasoningMessages: Set<string>;
  openToolCalls: Set<string>;
  endedToolCalls: Set<string>;
  openSteps: string[];
  terminated: boolean;
  sawSnapshot: boolean;
}

export type ValidatorRule = (
  event: AguiEvent,
  record: CaptureRecord,
  state: RunValidationState,
) => Issue[];
```

```ts
// src/core/validator/rules/lifecycle.ts
import { ORPHANED_RUN_ID } from '../../model/types';
import type { ValidatorRule } from '../types';

export const eventBeforeRunStartedRule: ValidatorRule = (event, record, state) => {
  if (event.type === 'RUN_STARTED') return [];
  if (state.run.outcome !== 'orphaned' && state.run.runId !== ORPHANED_RUN_ID) return [];
  return [
    {
      code: 'event-before-run-started',
      severity: 'error',
      message: `${event.type} arrived before any RUN_STARTED`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const eventAfterTerminalRule: ValidatorRule = (event, record, state) => {
  if (!state.terminated) return [];
  return [
    {
      code: 'event-after-terminal',
      severity: 'error',
      message: `${event.type} arrived after the run reached a terminal event`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const unbalancedStepsRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'STEP_FINISHED') return [];
  const stepName = typeof event.stepName === 'string' ? event.stepName : undefined;
  if (stepName === undefined) return [];
  if (state.openSteps.includes(stepName)) return [];
  return [
    {
      code: 'unbalanced-steps',
      severity: 'warning',
      message: `STEP_FINISHED "${stepName}" has no matching open STEP_STARTED`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const runStartedWithoutInputRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'RUN_STARTED') return [];
  if (state.run.input !== undefined) return [];
  return [
    {
      code: 'run-started-without-input',
      severity: 'info',
      message:
        'RUN_STARTED has no captured request input; reproducing this run will be harder',
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/validator/rules/lifecycle.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

Run: `git add src/core/validator && git commit -m "feat(devtools): add lifecycle validator rules"`

- [ ] **Step 6: Write the failing test (text rules)**

```ts
// src/core/validator/rules/text.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../../model/types';
import type { RunValidationState } from '../types';
import {
  concurrentTextMessagesRule,
  emptyTextDeltaRule,
  unopenedMessageIdRule,
} from './text';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

describe('emptyTextDeltaRule', () => {
  it('flags an empty TEXT_MESSAGE_CONTENT delta', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '' };

    expect(emptyTextDeltaRule(event, makeRecord(event, 6), state)).toEqual([
      {
        code: 'empty-text-delta',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT has an empty delta',
        seq: 6,
        runId: 'run-1',
      },
    ]);
  });

  it('flags an empty REASONING_MESSAGE_CONTENT delta', () => {
    const state = makeState({ openReasoningMessages: new Set(['r1']) });
    const event: AguiEvent = { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '' };

    expect(emptyTextDeltaRule(event, makeRecord(event, 7), state)).toEqual([
      {
        code: 'empty-text-delta',
        severity: 'error',
        message: 'REASONING_MESSAGE_CONTENT has an empty delta',
        seq: 7,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts a non-empty delta and ignores other types', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const good: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };
    const other: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '' };

    expect(emptyTextDeltaRule(good, makeRecord(good), state)).toEqual([]);
    expect(emptyTextDeltaRule(other, makeRecord(other), state)).toEqual([]);
  });
});

describe('unopenedMessageIdRule', () => {
  it('flags TEXT_MESSAGE_CONTENT for an unopened messageId', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'x' };

    expect(unopenedMessageIdRule(event, makeRecord(event, 2), state)).toEqual([
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT references messageId "m2" which is not open',
        seq: 2,
        runId: 'run-1',
      },
    ]);
  });

  it('flags TEXT_MESSAGE_END for an unopened messageId', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_END', messageId: 'm1' };

    expect(unopenedMessageIdRule(event, makeRecord(event, 3), state)).toEqual([
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_END references messageId "m1" which is not open',
        seq: 3,
        runId: 'run-1',
      },
    ]);
  });

  it('checks reasoning events against the reasoning open set', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };

    expect(unopenedMessageIdRule(event, makeRecord(event, 4), state)).toEqual([
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'REASONING_MESSAGE_CONTENT references messageId "m1" which is not open',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts open ids and ignores unrelated types', () => {
    const state = makeState({
      openTextMessages: new Set(['m1']),
      openReasoningMessages: new Set(['r1']),
    });
    const text: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' };
    const reasoning: AguiEvent = { type: 'REASONING_MESSAGE_END', messageId: 'r1' };
    const start: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm9', role: 'assistant' };

    expect(unopenedMessageIdRule(text, makeRecord(text), state)).toEqual([]);
    expect(unopenedMessageIdRule(reasoning, makeRecord(reasoning), state)).toEqual([]);
    expect(unopenedMessageIdRule(start, makeRecord(start), state)).toEqual([]);
  });

  it('ignores a non-string messageId (shape-check owns that)', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_END', messageId: 7 };

    expect(unopenedMessageIdRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('concurrentTextMessagesRule', () => {
  it('warns when a text message starts while another is open', () => {
    const state = makeState({ openTextMessages: new Set(['m1']) });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' };

    expect(concurrentTextMessagesRule(event, makeRecord(event, 5), state)).toEqual([
      {
        code: 'concurrent-text-messages',
        severity: 'warning',
        message: 'TEXT_MESSAGE_START while 1 text message(s) are still open',
        seq: 5,
        runId: 'run-1',
      },
    ]);
  });

  it('is silent for the first text message', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' };

    expect(concurrentTextMessagesRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores reasoning starts', () => {
    const state = makeState({ openReasoningMessages: new Set(['r1']) });
    const event: AguiEvent = { type: 'REASONING_MESSAGE_START', messageId: 'r2', role: 'assistant' };

    expect(concurrentTextMessagesRule(event, makeRecord(event), state)).toEqual([]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/core/validator/rules/text.test.ts`
Expected: FAIL with `Failed to resolve import "./text" from "src/core/validator/rules/text.test.ts"`

- [ ] **Step 8: Write the implementation (text rules)**

```ts
// src/core/validator/rules/text.ts
import type { ValidatorRule } from '../types';

const CONTENT_TYPES = new Set(['TEXT_MESSAGE_CONTENT', 'REASONING_MESSAGE_CONTENT']);

export const emptyTextDeltaRule: ValidatorRule = (event, record, state) => {
  if (!CONTENT_TYPES.has(event.type)) return [];
  if (event.delta !== '') return [];
  return [
    {
      code: 'empty-text-delta',
      severity: 'error',
      message: `${event.type} has an empty delta`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const unopenedMessageIdRule: ValidatorRule = (event, record, state) => {
  let open: Set<string> | undefined;
  if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_END') {
    open = state.openTextMessages;
  } else if (
    event.type === 'REASONING_MESSAGE_CONTENT' ||
    event.type === 'REASONING_MESSAGE_END'
  ) {
    open = state.openReasoningMessages;
  }
  if (open === undefined) return [];

  const messageId = typeof event.messageId === 'string' ? event.messageId : undefined;
  if (messageId === undefined) return [];
  if (open.has(messageId)) return [];

  return [
    {
      code: 'unopened-message-id',
      severity: 'error',
      message: `${event.type} references messageId "${messageId}" which is not open`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const concurrentTextMessagesRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TEXT_MESSAGE_START') return [];
  if (state.openTextMessages.size === 0) return [];
  return [
    {
      code: 'concurrent-text-messages',
      severity: 'warning',
      message: `TEXT_MESSAGE_START while ${state.openTextMessages.size} text message(s) are still open`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/core/validator/rules/text.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 10: Commit**

Run: `git add src/core/validator && git commit -m "feat(devtools): add text validator rules"`

- [ ] **Step 11: Write the failing test (tool rules)**

```ts
// src/core/validator/rules/tool.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run, ToolCallRecord } from '../../model/types';
import type { RunValidationState } from '../types';
import {
  toolArgsNotJsonRule,
  toolResultBeforeEndRule,
  unopenedToolCallIdRule,
} from './tool';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

function makeToolCall(argsText: string): ToolCallRecord {
  return {
    toolCallId: 'tc1',
    toolCallName: 'search',
    argsText,
    startedAtMs: 0,
    closed: false,
  };
}

describe('unopenedToolCallIdRule', () => {
  it('flags TOOL_CALL_ARGS for an unopened toolCallId', () => {
    const state = makeState({ openToolCalls: new Set(['tc1']) });
    const event: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc2', delta: '{}' };

    expect(unopenedToolCallIdRule(event, makeRecord(event, 3), state)).toEqual([
      {
        code: 'unopened-tool-call-id',
        severity: 'error',
        message: 'TOOL_CALL_ARGS references toolCallId "tc2" which is not open',
        seq: 3,
        runId: 'run-1',
      },
    ]);
  });

  it('flags TOOL_CALL_END for an unopened toolCallId', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(unopenedToolCallIdRule(event, makeRecord(event, 4), state)).toEqual([
      {
        code: 'unopened-tool-call-id',
        severity: 'error',
        message: 'TOOL_CALL_END references toolCallId "tc1" which is not open',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts an open toolCallId and ignores other types', () => {
    const state = makeState({ openToolCalls: new Set(['tc1']) });
    const args: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{}' };
    const start: AguiEvent = { type: 'TOOL_CALL_START', toolCallId: 'tc9', toolCallName: 'x' };

    expect(unopenedToolCallIdRule(args, makeRecord(args), state)).toEqual([]);
    expect(unopenedToolCallIdRule(start, makeRecord(start), state)).toEqual([]);
  });
});

describe('toolResultBeforeEndRule', () => {
  it('flags a result for a tool call that never ended', () => {
    const state = makeState({ openToolCalls: new Set(['tc1']) });
    const event: AguiEvent = {
      type: 'TOOL_CALL_RESULT',
      messageId: 'm1',
      toolCallId: 'tc1',
      content: 'ok',
    };

    expect(toolResultBeforeEndRule(event, makeRecord(event, 8), state)).toEqual([
      {
        code: 'tool-result-before-end',
        severity: 'error',
        message: 'TOOL_CALL_RESULT references toolCallId "tc1" which has not ended',
        seq: 8,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts a result for an ended tool call', () => {
    const state = makeState({ endedToolCalls: new Set(['tc1']) });
    const event: AguiEvent = {
      type: 'TOOL_CALL_RESULT',
      messageId: 'm1',
      toolCallId: 'tc1',
      content: 'ok',
    };

    expect(toolResultBeforeEndRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores other event types', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolResultBeforeEndRule(event, makeRecord(event), state)).toEqual([]);
  });
});

describe('toolArgsNotJsonRule', () => {
  it('flags accumulated args that do not parse at TOOL_CALL_END', () => {
    const state = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('{"q":')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolArgsNotJsonRule(event, makeRecord(event, 12), state)).toEqual([
      {
        code: 'tool-args-not-json',
        severity: 'error',
        message: 'Accumulated arguments for tool call "tc1" are not valid JSON',
        seq: 12,
        runId: 'run-1',
      },
    ]);
  });

  it('accepts args that parse', () => {
    const state = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('{"q":"x"}')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolArgsNotJsonRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('treats empty and whitespace-only args as acceptable', () => {
    const empty = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const blank = makeState({
      run: makeRun({ toolCalls: new Map([['tc1', makeToolCall('   ')]]) }),
      openToolCalls: new Set(['tc1']),
    });
    const event: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc1' };

    expect(toolArgsNotJsonRule(event, makeRecord(event), empty)).toEqual([]);
    expect(toolArgsNotJsonRule(event, makeRecord(event), blank)).toEqual([]);
  });

  it('is silent when the tool call is unknown or the type is not TOOL_CALL_END', () => {
    const state = makeState();
    const end: AguiEvent = { type: 'TOOL_CALL_END', toolCallId: 'tc9' };
    const args: AguiEvent = { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: 'nope' };

    expect(toolArgsNotJsonRule(end, makeRecord(end), state)).toEqual([]);
    expect(toolArgsNotJsonRule(args, makeRecord(args), state)).toEqual([]);
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm vitest run src/core/validator/rules/tool.test.ts`
Expected: FAIL with `Failed to resolve import "./tool" from "src/core/validator/rules/tool.test.ts"`

- [ ] **Step 13: Write the implementation (tool rules)**

```ts
// src/core/validator/rules/tool.ts
import type { ValidatorRule } from '../types';

export const unopenedToolCallIdRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_ARGS' && event.type !== 'TOOL_CALL_END') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  if (state.openToolCalls.has(toolCallId)) return [];
  return [
    {
      code: 'unopened-tool-call-id',
      severity: 'error',
      message: `${event.type} references toolCallId "${toolCallId}" which is not open`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const toolResultBeforeEndRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_RESULT') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  if (state.endedToolCalls.has(toolCallId)) return [];
  return [
    {
      code: 'tool-result-before-end',
      severity: 'error',
      message: `TOOL_CALL_RESULT references toolCallId "${toolCallId}" which has not ended`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};

export const toolArgsNotJsonRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'TOOL_CALL_END') return [];
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (toolCallId === undefined) return [];
  const call = state.run.toolCalls.get(toolCallId);
  if (call === undefined) return [];
  if (call.argsText.trim() === '') return [];
  try {
    JSON.parse(call.argsText);
    return [];
  } catch {
    return [
      {
        code: 'tool-args-not-json',
        severity: 'error',
        message: `Accumulated arguments for tool call "${toolCallId}" are not valid JSON`,
        seq: record.seq,
        runId: state.run.runId,
      },
    ];
  }
};
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm vitest run src/core/validator/rules/tool.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 15: Commit**

Run: `git add src/core/validator && git commit -m "feat(devtools): add tool-call validator rules"`

- [ ] **Step 16: Write the failing test (state rules)**

```ts
// src/core/validator/rules/state.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run, StateFrame } from '../../model/types';
import type { RunValidationState } from '../types';
import { deltaBeforeSnapshotRule, statePatchFailedRule } from './state';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

function snapshotFrame(value: unknown): StateFrame {
  return { seq: 1, tMs: 10, kind: 'snapshot', value };
}

describe('statePatchFailedRule', () => {
  it('flags the failing operation with its index and path', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [
        { op: 'add', path: '/b', value: 2 },
        { op: 'test', path: '/a', value: 99 },
      ],
    };

    expect(statePatchFailedRule(event, makeRecord(event, 14), state)).toEqual([
      {
        code: 'state-patch-failed',
        severity: 'error',
        message: 'STATE_DELTA op 1 (test /a) failed: test-failed',
        seq: 14,
        runId: 'run-1',
        path: '/a',
        opIndex: 1,
      },
    ]);
  });

  it('accepts a patch that applies cleanly', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'replace', path: '/a', value: 2 }],
    };

    expect(statePatchFailedRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores a non-array delta and non-STATE_DELTA events', () => {
    const state = makeState();
    const broken: AguiEvent = { type: 'STATE_DELTA', delta: { op: 'add' } };
    const snapshot: AguiEvent = { type: 'STATE_SNAPSHOT', snapshot: { a: 1 } };

    expect(statePatchFailedRule(broken, makeRecord(broken), state)).toEqual([]);
    expect(statePatchFailedRule(snapshot, makeRecord(snapshot), state)).toEqual([]);
  });
});

describe('deltaBeforeSnapshotRule', () => {
  it('warns on the first STATE_DELTA when no snapshot was seen', () => {
    const state = makeState();
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/a', value: 1 }],
    };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event, 2), state)).toEqual([
      {
        code: 'delta-before-snapshot',
        severity: 'warning',
        message: 'STATE_DELTA arrived before any STATE_SNAPSHOT',
        seq: 2,
        runId: 'run-1',
      },
    ]);
  });

  it('does not warn again once a state frame exists', () => {
    const state = makeState({
      run: makeRun({
        stateTimeline: [{ seq: 2, tMs: 20, kind: 'delta', value: { a: 1 }, patch: [] }],
      }),
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/b', value: 2 }],
    };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event, 3), state)).toEqual([]);
  });

  it('does not warn after a snapshot', () => {
    const state = makeState({
      run: makeRun({ stateTimeline: [snapshotFrame({ a: 1 })] }),
      sawSnapshot: true,
    });
    const event: AguiEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/b', value: 2 }],
    };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('ignores non-STATE_DELTA events', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'STATE_SNAPSHOT', snapshot: { a: 1 } };

    expect(deltaBeforeSnapshotRule(event, makeRecord(event), state)).toEqual([]);
  });
});
```

- [ ] **Step 17: Run test to verify it fails**

Run: `pnpm vitest run src/core/validator/rules/state.test.ts`
Expected: FAIL with `Failed to resolve import "./state" from "src/core/validator/rules/state.test.ts"`

- [ ] **Step 18: Write the implementation (state rules)**

```ts
// src/core/validator/rules/state.ts
import type { PatchOp } from '../../model/types';
import { applyPatch } from '../../state/json-patch';
import type { ValidatorRule } from '../types';

export const statePatchFailedRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'STATE_DELTA') return [];
  if (!Array.isArray(event.delta)) return [];

  const frames = state.run.stateTimeline;
  const current = frames.length > 0 ? frames[frames.length - 1].value : undefined;
  const result = applyPatch(current, event.delta as PatchOp[]);
  if (result.ok) return [];

  return [
    {
      code: 'state-patch-failed',
      severity: 'error',
      message: `STATE_DELTA op ${result.opIndex} (${result.op.op} ${result.op.path}) failed: ${result.reason}`,
      seq: record.seq,
      runId: state.run.runId,
      path: result.op.path,
      opIndex: result.opIndex,
    },
  ];
};

export const deltaBeforeSnapshotRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'STATE_DELTA') return [];
  if (state.sawSnapshot) return [];
  if (state.run.stateTimeline.length > 0) return [];
  return [
    {
      code: 'delta-before-snapshot',
      severity: 'warning',
      message: 'STATE_DELTA arrived before any STATE_SNAPSHOT',
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};
```

- [ ] **Step 19: Run test to verify it passes**

Run: `pnpm vitest run src/core/validator/rules/state.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 20: Commit**

Run: `git add src/core/validator && git commit -m "feat(devtools): add state validator rules"`

- [ ] **Step 21: Write the failing test (stream rules)**

```ts
// src/core/validator/rules/stream.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../../model/types';
import type { RunValidationState } from '../types';
import { deprecatedEventRule } from './stream';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

describe('deprecatedEventRule', () => {
  it('warns on each deprecated THINKING_* event type', () => {
    const state = makeState();
    const types = [
      'THINKING_START',
      'THINKING_END',
      'THINKING_TEXT_MESSAGE_START',
      'THINKING_TEXT_MESSAGE_CONTENT',
      'THINKING_TEXT_MESSAGE_END',
    ];

    for (const [index, type] of types.entries()) {
      const event: AguiEvent = { type };
      expect(deprecatedEventRule(event, makeRecord(event, index + 1), state)).toEqual([
        {
          code: 'deprecated-event',
          severity: 'warning',
          message: `${type} is deprecated in the AG-UI protocol`,
          seq: index + 1,
          runId: 'run-1',
        },
      ]);
    }
  });

  it('is silent for current event types', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'REASONING_MESSAGE_START', messageId: 'r1' };

    expect(deprecatedEventRule(event, makeRecord(event), state)).toEqual([]);
  });

  it('is silent for an unknown type (unknown-event-type is shape-check territory)', () => {
    const state = makeState();
    const event: AguiEvent = { type: 'SOMETHING_NEW' };

    expect(deprecatedEventRule(event, makeRecord(event), state)).toEqual([]);
  });
});
```

- [ ] **Step 22: Run test to verify it fails**

Run: `pnpm vitest run src/core/validator/rules/stream.test.ts`
Expected: FAIL with `Failed to resolve import "./stream" from "src/core/validator/rules/stream.test.ts"`

- [ ] **Step 23: Write the implementation (stream rules)**

```ts
// src/core/validator/rules/stream.ts
import { DEPRECATED_EVENT_TYPES } from '../../events/table';
import type { ValidatorRule } from '../types';

// Stream-level rules. `unknown-event-type` and `shape-invalid` are produced by
// `events/shape-check`, `chunk-missing-*` by `normalizer/chunk-expander`, and
// `keepalive-gap` by the run builder from keepalive frame timing — none of them
// belong here.
export const deprecatedEventRule: ValidatorRule = (event, record, state) => {
  if (!DEPRECATED_EVENT_TYPES.has(event.type)) return [];
  return [
    {
      code: 'deprecated-event',
      severity: 'warning',
      message: `${event.type} is deprecated in the AG-UI protocol`,
      seq: record.seq,
      runId: state.run.runId,
    },
  ];
};
```

- [ ] **Step 24: Run test to verify it passes**

Run: `pnpm vitest run src/core/validator/rules/stream.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 25: Commit**

Run: `git add src/core/validator && git commit -m "feat(devtools): add stream validator rules"`

- [ ] **Step 26: Write the failing test (index assembly + finalizeRules)**

```ts
// src/core/validator/index.test.ts
import { describe, it, expect } from 'vitest';
import type { AguiEvent, CaptureRecord, Run } from '../model/types';
import type { RunValidationState } from './types';
import { RULES, finalizeRules, runRules } from './index';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunValidationState> = {}): RunValidationState {
  return {
    run: makeRun(),
    openTextMessages: new Set(),
    openReasoningMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openSteps: [],
    terminated: false,
    sawSnapshot: false,
    ...overrides,
  };
}

function makeRecord(event: AguiEvent, seq = 1): CaptureRecord {
  return { seq, tMs: seq * 10, connId: 'conn-1', raw: event, event, issues: [] };
}

describe('RULES', () => {
  it('holds every per-event rule', () => {
    expect(RULES).toHaveLength(13);
    expect(RULES.every((rule) => typeof rule === 'function')).toBe(true);
  });
});

describe('runRules', () => {
  it('returns no issues for a clean event', () => {
    const state = makeState({
      run: makeRun({ input: { messages: [] } }),
      openTextMessages: new Set(['m1']),
    });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' };

    expect(runRules(event, makeRecord(event), state)).toEqual([]);
  });

  it('concatenates issues from every rule in RULES order', () => {
    const state = makeState({ terminated: true });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '' };

    expect(runRules(event, makeRecord(event, 5), state)).toEqual([
      {
        code: 'event-after-terminal',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT arrived after the run reached a terminal event',
        seq: 5,
        runId: 'run-1',
      },
      {
        code: 'empty-text-delta',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT has an empty delta',
        seq: 5,
        runId: 'run-1',
      },
      {
        code: 'unopened-message-id',
        severity: 'error',
        message: 'TEXT_MESSAGE_CONTENT references messageId "m1" which is not open',
        seq: 5,
        runId: 'run-1',
      },
    ]);
  });

  it('does not mutate the validation state', () => {
    const state = makeState({
      openTextMessages: new Set(['m1']),
      openToolCalls: new Set(['tc1']),
      openSteps: ['plan'],
    });
    const event: AguiEvent = { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' };

    runRules(event, makeRecord(event), state);

    expect([...state.openTextMessages]).toEqual(['m1']);
    expect([...state.openReasoningMessages]).toEqual([]);
    expect([...state.openToolCalls]).toEqual(['tc1']);
    expect([...state.endedToolCalls]).toEqual([]);
    expect(state.openSteps).toEqual(['plan']);
    expect(state.terminated).toBe(false);
    expect(state.sawSnapshot).toBe(false);
    expect(state.run.issues).toEqual([]);
  });
});

describe('finalizeRules', () => {
  it('returns nothing for a clean, terminated run', () => {
    const state = makeState({
      run: makeRun({ recordSeqs: [1, 2, 3], outcome: 'finished' }),
      terminated: true,
    });

    expect(finalizeRules(state, 900)).toEqual([]);
  });

  it('reports a run that never terminated', () => {
    const state = makeState({ run: makeRun({ recordSeqs: [1, 2, 3] }) });

    expect(finalizeRules(state, 900)).toEqual([
      {
        code: 'run-never-terminated',
        severity: 'error',
        message:
          'Connection closed at 900ms without RUN_FINISHED or RUN_ERROR',
        seq: 3,
        runId: 'run-1',
      },
    ]);
  });

  it('reports unclosed messages, tool calls and steps in order', () => {
    const state = makeState({
      run: makeRun({ recordSeqs: [1, 2, 3, 4] }),
      openTextMessages: new Set(['m1']),
      openReasoningMessages: new Set(['r1']),
      openToolCalls: new Set(['tc1']),
      openSteps: ['plan'],
      terminated: true,
    });

    expect(finalizeRules(state, 1200)).toEqual([
      {
        code: 'unclosed-message',
        severity: 'warning',
        message: 'Text message "m1" was never closed with TEXT_MESSAGE_END',
        seq: 4,
        runId: 'run-1',
      },
      {
        code: 'unclosed-message',
        severity: 'warning',
        message: 'Reasoning message "r1" was never closed with REASONING_MESSAGE_END',
        seq: 4,
        runId: 'run-1',
      },
      {
        code: 'unclosed-tool-call',
        severity: 'warning',
        message: 'Tool call "tc1" was never closed with TOOL_CALL_END',
        seq: 4,
        runId: 'run-1',
      },
      {
        code: 'unbalanced-steps',
        severity: 'warning',
        message: 'Step "plan" was still open at run end',
        seq: 4,
        runId: 'run-1',
      },
    ]);
  });

  it('uses seq 0 when the run recorded no events', () => {
    const state = makeState({ terminated: true, openToolCalls: new Set(['tc1']) });

    expect(finalizeRules(state, 10)).toEqual([
      {
        code: 'unclosed-tool-call',
        severity: 'warning',
        message: 'Tool call "tc1" was never closed with TOOL_CALL_END',
        seq: 0,
        runId: 'run-1',
      },
    ]);
  });

  it('does not mutate the validation state', () => {
    const state = makeState({
      run: makeRun({ recordSeqs: [1] }),
      openTextMessages: new Set(['m1']),
      openSteps: ['plan'],
    });

    finalizeRules(state, 500);

    expect([...state.openTextMessages]).toEqual(['m1']);
    expect(state.openSteps).toEqual(['plan']);
    expect(state.terminated).toBe(false);
    expect(state.run.issues).toEqual([]);
  });
});
```

- [ ] **Step 27: Run test to verify it fails**

Run: `pnpm vitest run src/core/validator/index.test.ts`
Expected: FAIL with `Failed to resolve import "./index" from "src/core/validator/index.test.ts"`

- [ ] **Step 28: Write the implementation (index assembly)**

```ts
// src/core/validator/index.ts
import type { AguiEvent, CaptureRecord, Issue } from '../model/types';
import type { RunValidationState, ValidatorRule } from './types';
import {
  eventAfterTerminalRule,
  eventBeforeRunStartedRule,
  runStartedWithoutInputRule,
  unbalancedStepsRule,
} from './rules/lifecycle';
import {
  concurrentTextMessagesRule,
  emptyTextDeltaRule,
  unopenedMessageIdRule,
} from './rules/text';
import {
  toolArgsNotJsonRule,
  toolResultBeforeEndRule,
  unopenedToolCallIdRule,
} from './rules/tool';
import { deltaBeforeSnapshotRule, statePatchFailedRule } from './rules/state';
import { deprecatedEventRule } from './rules/stream';

export type { RunValidationState, ValidatorRule } from './types';

export const RULES: readonly ValidatorRule[] = [
  eventBeforeRunStartedRule,
  eventAfterTerminalRule,
  runStartedWithoutInputRule,
  unbalancedStepsRule,
  concurrentTextMessagesRule,
  emptyTextDeltaRule,
  unopenedMessageIdRule,
  unopenedToolCallIdRule,
  toolResultBeforeEndRule,
  toolArgsNotJsonRule,
  deltaBeforeSnapshotRule,
  statePatchFailedRule,
  deprecatedEventRule,
];

export function runRules(
  event: AguiEvent,
  record: CaptureRecord,
  state: RunValidationState,
): Issue[] {
  const issues: Issue[] = [];
  for (const rule of RULES) {
    issues.push(...rule(event, record, state));
  }
  return issues;
}

/**
 * Rules that can only fire once the connection carrying the run has closed.
 * Called by the run builder from `closeConnection`, not per event.
 */
export function finalizeRules(state: RunValidationState, tMs: number): Issue[] {
  const { run } = state;
  const seq = run.recordSeqs.length > 0 ? run.recordSeqs[run.recordSeqs.length - 1] : 0;
  const issues: Issue[] = [];

  if (!state.terminated) {
    issues.push({
      code: 'run-never-terminated',
      severity: 'error',
      message: `Connection closed at ${tMs}ms without RUN_FINISHED or RUN_ERROR`,
      seq,
      runId: run.runId,
    });
  }

  for (const messageId of state.openTextMessages) {
    issues.push({
      code: 'unclosed-message',
      severity: 'warning',
      message: `Text message "${messageId}" was never closed with TEXT_MESSAGE_END`,
      seq,
      runId: run.runId,
    });
  }

  for (const messageId of state.openReasoningMessages) {
    issues.push({
      code: 'unclosed-message',
      severity: 'warning',
      message: `Reasoning message "${messageId}" was never closed with REASONING_MESSAGE_END`,
      seq,
      runId: run.runId,
    });
  }

  for (const toolCallId of state.openToolCalls) {
    issues.push({
      code: 'unclosed-tool-call',
      severity: 'warning',
      message: `Tool call "${toolCallId}" was never closed with TOOL_CALL_END`,
      seq,
      runId: run.runId,
    });
  }

  for (const stepName of state.openSteps) {
    issues.push({
      code: 'unbalanced-steps',
      severity: 'warning',
      message: `Step "${stepName}" was still open at run end`,
      seq,
      runId: run.runId,
    });
  }

  return issues;
}
```

- [ ] **Step 29: Run test to verify it passes**

Run: `pnpm vitest run src/core/validator`
Expected: PASS, 52 tests across the six validator test files
(lifecycle 12, text 11, tool 10, state 7, stream 3, index 9).

- [ ] **Step 30: Commit**

Run: `git add src/core/validator && git commit -m "feat(devtools): assemble validator rule set and run-end checks"`

---

## Contract gaps

Additions and clarifications to `LOCKED-CONTRACT.md` produced by this section. Nothing
above renames or re-signatures anything already locked.

1. **`finalizeRules(state: RunValidationState, tMs: number): Issue[]` added to
   `src/core/validator/index.ts`.** The contract only lists `RULES` and `runRules`, but
   `run-never-terminated`, `unclosed-message`, `unclosed-tool-call` and the leftover-open
   `unbalanced-steps` cases are triggered by `closeConnection`, not by an event, so they
   cannot be `ValidatorRule`s (no event, no record). Task 13's `closeConnection` must call
   `finalizeRules(state, tMs)` once per run on the closing connection and append the result
   to `run.issues`. `tMs` appears in the `run-never-terminated` message; `Issue` has no
   time field, so that is the only place the close timestamp survives.

2. **New file `src/core/validator/types.ts`** holding `RunValidationState` and
   `ValidatorRule`, re-exported from `validator/index.ts` (`export type { … } from './types'`).
   The locked import path `.../core/validator` still resolves both names. Without this the
   rule modules would have to import types from the same `index.ts` that imports them,
   and the rule tests would not be runnable before the index exists — TDD ordering would
   break. No behavioural change.

3. **Rule ordering requirement for Task 13:** `runRules` must be called **before** the run
   builder applies the event's state transition. Every rule here reads `state` as
   "the world immediately before this event" — `event-after-terminal` would swallow the
   terminal event itself, `unopened-message-id` would never fire for `TEXT_MESSAGE_END`,
   `concurrent-text-messages` would fire on every `TEXT_MESSAGE_START`, and
   `tool-args-not-json` would inspect the wrong `argsText` if that order were reversed.

4. **`statePatchFailedRule` re-applies the patch itself** (via `applyPatch` against the last
   `run.stateTimeline` frame's `value`) rather than reading a `failure` recorded by the run
   builder, because a rule must be pure and must run before the builder mutates the
   timeline. `applyPatch` is immutable, so this is side-effect free but does duplicate the
   patch application. If Task 13 wants to avoid the double apply it may reuse the rule's
   verdict instead of re-applying — but it must not invert the ordering in gap 3.

5. **`delta-before-snapshot` fires only once per run**, on a `STATE_DELTA` seen while
   `sawSnapshot === false` **and** `run.stateTimeline.length === 0`. `sawSnapshot` only
   ever flips on a `STATE_SNAPSHOT`, so without the timeline check every delta in a
   snapshot-less run would warn. Task 13 must push a frame for every state event
   (including failed deltas, per the `state/timeline.ts` contract) for this to hold.

6. **Validator issues always carry `runId`; chunk-expander issues never do.** `expandChunk`
   runs before run attribution and has no run in scope, so its three `chunk-missing-*`
   issues omit `runId`. The run builder should fill it in when it attaches the record to a
   run, or leave it unset.

7. **`expandChunk` widens two cases beyond the wording in the task brief**, both in the
   safe direction:
   - a `TEXT_MESSAGE_CHUNK` / `REASONING_MESSAGE_CHUNK` with **no `messageId` and none
     open** emits `chunk-missing-message-id` regardless of whether it carries a delta (a
     chunk with neither is equally unattributable);
   - a chunk carrying `delta: ''` emits a `*_CONTENT` with the empty delta rather than
     dropping it, so `empty-text-delta` can flag it downstream.

8. **Synthesized `REASONING_MESSAGE_START` carries `role`** (defaulting to `'assistant'`),
   mirroring `TEXT_MESSAGE_START`. If `EVENT_TABLE` (Task 3, generated from
   `@ag-ui/core@0.0.57`) shows `REASONING_MESSAGE_START` has no `role` field, the extra
   property is harmless — `checkShape` only reports missing/mistyped fields, never extras —
   but the expander test's expected object must then be updated to match whatever is
   decided.

9. **Task numbering:** the locked contract labels the chunk expander "Task 8" and the
   validator "Task 12"; this section is written as Task 10 and Task 11 per the plan's
   final ordering. Same files, same signatures.

---

### Task 12: Run metrics

**Files:**
- Create: `src/core/metrics/run-metrics.ts`
- Test: `src/core/metrics/run-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/metrics/run-metrics.test.ts
import { describe, it, expect } from 'vitest';
import { computeMetrics } from './run-metrics';
import type { AguiEvent, CaptureRecord, ReconstructedMessage, Run } from '../model/types';

function rec(seq: number, tMs: number, event: AguiEvent): CaptureRecord {
  return { seq, tMs, connId: 'c1', raw: event, event, issues: [] };
}

function message(overrides: Partial<ReconstructedMessage> & { messageId: string }): ReconstructedMessage {
  return {
    role: 'assistant',
    content: '',
    startedAtMs: 0,
    closed: false,
    chunkSeqs: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'r1',
    threadId: 't1',
    connId: 'c1',
    startedAtMs: 0,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs: [],
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('returns the empty shape for a run with no records', () => {
    const metrics = computeMetrics(makeRun(), [], 2000);

    expect(metrics).toEqual({
      durationMs: undefined,
      ttftMs: undefined,
      ttfrtMs: undefined,
      gapP50Ms: undefined,
      gapP95Ms: undefined,
      gapMaxMs: undefined,
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    });
  });

  it('leaves durationMs undefined while the run is still running', () => {
    const metrics = computeMetrics(makeRun({ startedAtMs: 100 }), [], 2000);

    expect(metrics.durationMs).toBeUndefined();
  });

  it('computes durationMs as endedAtMs - startedAtMs once the run ended', () => {
    const run = makeRun({ startedAtMs: 100, endedAtMs: 450, outcome: 'finished' });

    expect(computeMetrics(run, [], 2000).durationMs).toBe(350);
  });

  it('measures ttftMs and ttfrtMs from the run start to the first content delta of each kind', () => {
    const run = makeRun({ startedAtMs: 100 });
    const records = [
      rec(1, 110, { type: 'REASONING_MESSAGE_START', messageId: 'rm1', role: 'assistant' }),
      rec(2, 140, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'th' }),
      rec(3, 180, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'ink' }),
      rec(4, 200, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
      rec(5, 260, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      rec(6, 300, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' }),
    ];

    const metrics = computeMetrics(run, records, 2000);

    expect(metrics.ttfrtMs).toBe(40);
    expect(metrics.ttftMs).toBe(160);
  });

  it('leaves ttftMs and ttfrtMs undefined when no content delta of that kind arrived', () => {
    const records = [rec(1, 10, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' })];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.ttftMs).toBeUndefined();
    expect(metrics.ttfrtMs).toBeUndefined();
  });

  it('computes nearest-rank gap percentiles over consecutive TEXT_MESSAGE_CONTENT events', () => {
    // content arrivals: 100, 150, 250, 400, 900  ->  gaps [50, 100, 150, 500]
    // sorted ascending: [50, 100, 150, 500], N = 4
    //   p50 rank = ceil(0.50 * 4) = 2 -> 100   (linear interpolation would say 125)
    //   p95 rank = ceil(0.95 * 4) = 4 -> 500
    //   max                                -> 500
    const records = [
      rec(1, 100, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      rec(2, 150, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' }),
      rec(3, 250, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'c' }),
      rec(4, 400, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'd' }),
      rec(5, 900, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'e' }),
    ];

    const metrics = computeMetrics(makeRun(), records, 100000);

    expect(metrics.gapP50Ms).toBe(100);
    expect(metrics.gapP95Ms).toBe(500);
    expect(metrics.gapMaxMs).toBe(500);
  });

  it('leaves every gap metric undefined with fewer than two content events', () => {
    const one = computeMetrics(
      makeRun(),
      [rec(1, 30, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' })],
      2000,
    );

    expect(one.ttftMs).toBe(30);
    expect(one.gapP50Ms).toBeUndefined();
    expect(one.gapP95Ms).toBeUndefined();
    expect(one.gapMaxMs).toBeUndefined();

    const none = computeMetrics(makeRun(), [], 2000);

    expect(none.gapP50Ms).toBeUndefined();
    expect(none.gapP95Ms).toBeUndefined();
    expect(none.gapMaxMs).toBeUndefined();
  });

  it('reports stalls strictly longer than the threshold while a message is open', () => {
    // m1 alive at 10 (start), 20 (delta), 500 (delta), 520 (end) -> 10, 480, 20
    //   only 480 > 100, so exactly one stall from 20 to 500
    // m2 alive at 600 (start), 700 (delta) -> 100, which is NOT strictly greater than 100
    const run = makeRun({
      startedAtMs: 0,
      messages: new Map([
        ['m1', message({ messageId: 'm1', content: 'ab', startedAtMs: 10, endedAtMs: 520, closed: true, chunkSeqs: [2, 3] })],
        ['m2', message({ messageId: 'm2', content: 'c', startedAtMs: 600, chunkSeqs: [5] })],
      ]),
    });
    const records = [
      rec(1, 10, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
      rec(2, 20, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }),
      rec(3, 500, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'b' }),
      rec(4, 520, { type: 'TEXT_MESSAGE_END', messageId: 'm1' }),
      rec(5, 600, { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' }),
      rec(6, 700, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'c' }),
    ];

    const metrics = computeMetrics(run, records, 100);

    expect(metrics.stalls).toEqual([{ startMs: 20, endMs: 500, messageId: 'm1' }]);
    expect(metrics.gapMaxMs).toBe(480);
  });

  it('keys tool latency by toolCallId and omits tool calls with no result', () => {
    const records = [
      rec(1, 10, { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }),
      rec(2, 20, { type: 'TOOL_CALL_START', toolCallId: 'tc2', toolCallName: 'lookup' }),
      rec(3, 40, { type: 'TOOL_CALL_END', toolCallId: 'tc1' }),
      rec(4, 95, { type: 'TOOL_CALL_RESULT', messageId: 'x', toolCallId: 'tc1', content: 'ok' }),
      rec(5, 99, { type: 'TOOL_CALL_END', toolCallId: 'tc2' }),
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.toolLatencyMs).toEqual({ tc1: 85 });
  });

  it('counts state patches and their serialized delta bytes', () => {
    const d1 = [{ op: 'replace', path: '/count', value: 2 }];
    const d2 = [{ op: 'add', path: '/items/-', value: 'x' }, { op: 'remove', path: '/tmp' }];
    const records = [
      rec(1, 10, { type: 'STATE_SNAPSHOT', snapshot: { count: 1 } }),
      rec(2, 20, { type: 'STATE_DELTA', delta: d1 }),
      rec(3, 30, { type: 'STATE_DELTA', delta: d2 }),
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.statePatchCount).toBe(2);
    expect(metrics.statePatchBytes).toBe(JSON.stringify(d1).length + JSON.stringify(d2).length);
  });

  it('counts events by type and sums raw bytes, skipping unparseable and raw-less records', () => {
    const raw1 = {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'hi',
      rawEvent: { padding: '0123456789' },
    };
    const records: CaptureRecord[] = [
      {
        seq: 1,
        tMs: 10,
        connId: 'c1',
        raw: raw1,
        event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' },
        issues: [],
      },
      { seq: 2, tMs: 20, connId: 'c1', raw: 'garbage', event: null, issues: [] },
      {
        seq: 3,
        tMs: 30,
        connId: 'c1',
        raw: undefined,
        event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '!' },
        issues: [],
      },
      { seq: 4, tMs: 40, connId: 'c1', raw: { type: 'RUN_FINISHED' }, event: { type: 'RUN_FINISHED' }, issues: [] },
    ];

    const metrics = computeMetrics(makeRun(), records, 2000);

    expect(metrics.eventCountByType).toEqual({ TEXT_MESSAGE_CONTENT: 2, RUN_FINISHED: 1 });
    expect(metrics.totalStreamBytes).toBe(
      JSON.stringify(raw1).length + JSON.stringify('garbage').length + JSON.stringify({ type: 'RUN_FINISHED' }).length,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/metrics/run-metrics.test.ts`
Expected: FAIL with `Failed to resolve import "./run-metrics" from "src/core/metrics/run-metrics.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/metrics/run-metrics.ts
import type { CaptureRecord, Run, RunMetrics } from '../model/types';

/**
 * Nearest-rank percentile — no interpolation.
 *
 * For an ascending `sorted` array of N values and a percentile `p` in 0..100, the rank is
 * `ceil(p / 100 * N)` clamped into [1, N] and the result is `sorted[rank - 1]`.
 *
 * Example: sorted = [50, 100, 150, 500]
 *   p50 -> rank ceil(2.0) = 2 -> 100   (a linear-interpolation percentile would say 125)
 *   p95 -> rank ceil(3.8) = 4 -> 500
 */
function nearestRankPercentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** JSON byte length, treating non-serializable values (undefined) as zero bytes. */
function byteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : json.length;
}

function pushTime(map: Map<string, number[]>, key: string, tMs: number): void {
  const existing = map.get(key);
  if (existing) existing.push(tMs);
  else map.set(key, [tMs]);
}

export function computeMetrics(
  run: Run,
  records: CaptureRecord[],
  stallThresholdMs: number,
): RunMetrics {
  const eventCountByType: Record<string, number> = {};
  const toolLatencyMs: Record<string, number> = {};
  const toolStartMs = new Map<string, number>();
  const contentTimesByMessage = new Map<string, number[]>();
  const textContentTimes: number[] = [];
  let totalStreamBytes = 0;
  let statePatchCount = 0;
  let statePatchBytes = 0;
  let ttftMs: number | undefined;
  let ttfrtMs: number | undefined;

  for (const record of records) {
    totalStreamBytes += byteLength(record.raw);
    const event = record.event;
    if (event === null) continue;

    eventCountByType[event.type] = (eventCountByType[event.type] ?? 0) + 1;
    const messageId = typeof event.messageId === 'string' ? event.messageId : undefined;
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;

    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        if (ttftMs === undefined) ttftMs = record.tMs - run.startedAtMs;
        textContentTimes.push(record.tMs);
        if (messageId !== undefined) pushTime(contentTimesByMessage, messageId, record.tMs);
        break;
      }
      case 'REASONING_MESSAGE_CONTENT': {
        if (ttfrtMs === undefined) ttfrtMs = record.tMs - run.startedAtMs;
        if (messageId !== undefined) pushTime(contentTimesByMessage, messageId, record.tMs);
        break;
      }
      case 'TOOL_CALL_START': {
        if (toolCallId !== undefined) toolStartMs.set(toolCallId, record.tMs);
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const startedMs = toolCallId === undefined ? undefined : toolStartMs.get(toolCallId);
        if (toolCallId !== undefined && startedMs !== undefined) {
          toolLatencyMs[toolCallId] = record.tMs - startedMs;
        }
        break;
      }
      case 'STATE_DELTA': {
        statePatchCount += 1;
        statePatchBytes += byteLength(event.delta);
        break;
      }
      default:
        break;
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < textContentTimes.length; i += 1) {
    gaps.push(textContentTimes[i]! - textContentTimes[i - 1]!);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);

  // Stalls: for each reconstructed message, walk the timestamps at which the message was
  // demonstrably alive — its start, each of its own content deltas, and its end once it
  // closed — and report every consecutive pair separated by STRICTLY more than the
  // threshold. Each such interval lies inside the message's open window by construction,
  // which is what requirements §8 means by a gap "with an open message".
  const stalls: RunMetrics['stalls'] = [];
  for (const message of run.messages.values()) {
    const times = [message.startedAtMs, ...(contentTimesByMessage.get(message.messageId) ?? [])];
    if (message.closed && message.endedAtMs !== undefined) times.push(message.endedAtMs);
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      const startMs = times[i - 1]!;
      const endMs = times[i]!;
      if (endMs - startMs > stallThresholdMs) {
        stalls.push({ startMs, endMs, messageId: message.messageId });
      }
    }
  }
  stalls.sort((a, b) => a.startMs - b.startMs);

  return {
    durationMs: run.endedAtMs === undefined ? undefined : run.endedAtMs - run.startedAtMs,
    ttftMs,
    ttfrtMs,
    gapP50Ms: nearestRankPercentile(sortedGaps, 50),
    gapP95Ms: nearestRankPercentile(sortedGaps, 95),
    gapMaxMs: sortedGaps.length === 0 ? undefined : sortedGaps[sortedGaps.length - 1],
    stalls,
    toolLatencyMs,
    statePatchCount,
    statePatchBytes,
    eventCountByType,
    totalStreamBytes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/metrics/run-metrics.test.ts`
Expected: 11 passing.

- [ ] **Step 5: Commit**

`git add src/core/metrics && git commit -m "feat(core): per-run metrics (duration, TTFT, gaps, stalls, tool latency)"`

---

### Task 13a: Run builder — lifecycle, text messages, run resolution

**Files:**
- Create: `src/core/normalizer/run-builder.ts`
- Test: `src/core/normalizer/run-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/normalizer/run-builder.test.ts
import { describe, it, expect } from 'vitest';
import { createRunBuilder } from './run-builder';
import { ORPHANED_RUN_ID } from '../model/types';
import type { AguiEvent, CaptureRecord } from '../model/types';

function rec(seq: number, tMs: number, connId: string, event: AguiEvent): CaptureRecord {
  return { seq, tMs, connId, raw: event, event, issues: [] };
}

describe('createRunBuilder — lifecycle and text messages', () => {
  it('folds a complete happy run end to end', () => {
    const builder = createRunBuilder();
    const input = { threadId: 't1', runId: 'r1', messages: [], tools: [] };

    builder.addRequest('c1', 'POST', 'https://example.test/agent', input);
    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' }));
    builder.addRecord(rec(5, 40, 'c1', { type: 'TEXT_MESSAGE_END', messageId: 'm1' }));
    builder.addRecord(rec(6, 50, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));

    const runs = builder.runs();
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.runId).toBe('r1');
    expect(run.threadId).toBe('t1');
    expect(run.connId).toBe('c1');
    expect(run.input).toEqual(input);
    expect(run.outcome).toBe('finished');
    expect(run.startedAtMs).toBe(0);
    expect(run.endedAtMs).toBe(50);
    expect(run.recordSeqs).toEqual([1, 2, 3, 4, 5, 6]);

    const message = run.messages.get('m1')!;
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('Hello');
    expect(message.startedAtMs).toBe(10);
    expect(message.endedAtMs).toBe(40);
    expect(message.closed).toBe(true);
    expect(message.chunkSeqs).toEqual([3, 4]);

    expect(run.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(run.metrics.durationMs).toBe(50);
    expect(run.metrics.ttftMs).toBe(20);
    expect(run.metrics.eventCountByType).toEqual({
      RUN_STARTED: 1,
      TEXT_MESSAGE_START: 1,
      TEXT_MESSAGE_CONTENT: 2,
      TEXT_MESSAGE_END: 1,
      RUN_FINISHED: 1,
    });
  });

  it('reconstructs reasoning messages and reports ttfrtMs', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 5, 'c1', { type: 'REASONING_MESSAGE_START', messageId: 'rm1', role: 'assistant' }));
    builder.addRecord(rec(3, 15, 'c1', { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'th' }));
    builder.addRecord(rec(4, 25, 'c1', { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'ink' }));
    builder.addRecord(rec(5, 35, 'c1', { type: 'REASONING_MESSAGE_END', messageId: 'rm1' }));

    const run = builder.getRun('r1')!;
    const message = run.messages.get('rm1')!;
    expect(message.role).toBe('reasoning');
    expect(message.content).toBe('think');
    expect(message.closed).toBe(true);
    expect(run.metrics.ttfrtMs).toBe(15);
    expect(run.metrics.ttftMs).toBeUndefined();
  });

  it('marks a RUN_ERROR run as errored', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 12, 'c1', { type: 'RUN_ERROR', message: 'boom', code: 'E_BOOM' }));

    const run = builder.getRun('r1')!;
    expect(run.outcome).toBe('error');
    expect(run.endedAtMs).toBe(12);
  });

  it('has no runs at all before any record arrives', () => {
    expect(createRunBuilder().runs()).toEqual([]);
    expect(createRunBuilder().allIssues()).toEqual([]);
  });

  it('attaches events with no RUN_STARTED to the synthetic orphaned run', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 5, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.addRecord(rec(2, 6, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'orphan' }));

    const runs = builder.runs();
    expect(runs.map((run) => run.runId)).toEqual([ORPHANED_RUN_ID]);

    const orphan = runs[0]!;
    expect(orphan.outcome).toBe('orphaned');
    expect(orphan.recordSeqs).toEqual([1, 2]);
    expect(orphan.messages.get('m1')!.content).toBe('orphan');
    expect(builder.getRun(ORPHANED_RUN_ID)).toBe(orphan);
    expect(builder.allIssues().some((issue) => issue.code === 'event-before-run-started')).toBe(true);
  });

  it('keeps two concurrent connections from cross-contaminating', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'cA', { type: 'RUN_STARTED', threadId: 'tA', runId: 'rA' }));
    builder.addRecord(rec(2, 1, 'cB', { type: 'RUN_STARTED', threadId: 'tB', runId: 'rB' }));
    builder.addRecord(rec(3, 2, 'cA', { type: 'TEXT_MESSAGE_START', messageId: 'mA', role: 'assistant' }));
    builder.addRecord(rec(4, 3, 'cB', { type: 'TEXT_MESSAGE_START', messageId: 'mB', role: 'assistant' }));
    builder.addRecord(rec(5, 4, 'cA', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mA', delta: 'A1' }));
    builder.addRecord(rec(6, 5, 'cB', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mB', delta: 'B1' }));
    builder.addRecord(rec(7, 6, 'cA', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mA', delta: 'A2' }));
    builder.addRecord(rec(8, 7, 'cB', { type: 'RUN_FINISHED', threadId: 'tB', runId: 'rB' }));
    builder.addRecord(rec(9, 8, 'cA', { type: 'RUN_FINISHED', threadId: 'tA', runId: 'rA' }));

    expect(builder.runs().map((run) => run.runId)).toEqual(['rA', 'rB']);

    const runA = builder.getRun('rA')!;
    const runB = builder.getRun('rB')!;

    expect(runA.connId).toBe('cA');
    expect(runB.connId).toBe('cB');
    expect([...runA.messages.keys()]).toEqual(['mA']);
    expect([...runB.messages.keys()]).toEqual(['mB']);
    expect(runA.messages.get('mA')!.content).toBe('A1A2');
    expect(runB.messages.get('mB')!.content).toBe('B1');
    expect(runA.recordSeqs).toEqual([1, 3, 5, 7, 9]);
    expect(runB.recordSeqs).toEqual([2, 4, 6, 8]);
    expect(builder.runs().map((run) => run.runId)).not.toContain(ORPHANED_RUN_ID);
  });

  it('attaches an unparseable record and its issues to the connection run without decoding it', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord({
      seq: 2,
      tMs: 5,
      connId: 'c1',
      raw: 'not json',
      event: null,
      issues: [{ code: 'shape-invalid', severity: 'error', message: 'unparseable frame', seq: 2 }],
    });

    const run = builder.getRun('r1')!;
    expect(run.recordSeqs).toEqual([1, 2]);

    const issue = run.issues.find((candidate) => candidate.code === 'shape-invalid')!;
    expect(issue.message).toBe('unparseable frame');
    expect(issue.runId).toBe('r1');
  });

  it('returns every issue across every run sorted by seq', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm0', role: 'assistant' }));
    builder.addRecord(rec(2, 1, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord({
      seq: 3,
      tMs: 2,
      connId: 'c1',
      raw: '{',
      event: null,
      issues: [{ code: 'shape-invalid', severity: 'error', message: 'truncated', seq: 3 }],
    });

    const seqs = builder.allIssues().map((issue) => issue.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toContain(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/normalizer/run-builder.test.ts`
Expected: FAIL with `Failed to resolve import "./run-builder" from "src/core/normalizer/run-builder.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/normalizer/run-builder.ts
import {
  ORPHANED_RUN_ID,
  type AguiEvent,
  type CaptureRecord,
  type Issue,
  type ReconstructedMessage,
  type Run,
  type RunMetrics,
} from '../model/types';
import { createStateTimeline, type StateTimeline } from '../state/timeline';
import { runRules, type RunValidationState } from '../validator';
import { computeMetrics } from '../metrics/run-metrics';

export interface RunBuilderOptions {
  expandChunks?: boolean; // default true
  stallThresholdMs?: number; // default 2000
}

export interface RunBuilder {
  addRequest(connId: string, method: string, url: string, input: unknown): void;
  addRecord(record: CaptureRecord): void;
  closeConnection(connId: string, tMs: number): void;
  runs(): Run[];
  getRun(runId: string): Run | undefined;
  allIssues(): Issue[];
}

interface RunEntry {
  run: Run;
  validation: RunValidationState;
  timeline: StateTimeline;
  /** One entry per event folded into this run; drives computeMetrics. */
  records: CaptureRecord[];
  metricsDirty: boolean;
}

interface ConnEntry {
  connId: string;
  method?: string;
  url?: string;
  input?: unknown;
  openRunId?: string;
  runIds: string[];
  closedAtMs?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function emptyMetrics(): RunMetrics {
  return {
    stalls: [],
    toolLatencyMs: {},
    statePatchCount: 0,
    statePatchBytes: 0,
    eventCountByType: {},
    totalStreamBytes: 0,
  };
}

function createRun(runId: string, threadId: string, connId: string, startedAtMs: number): Run {
  return {
    runId,
    threadId,
    connId,
    startedAtMs,
    outcome: 'running',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: emptyMetrics(),
    issues: [],
    recordSeqs: [],
  };
}

function createEntry(run: Run): RunEntry {
  return {
    run,
    validation: {
      run,
      openTextMessages: new Set(),
      openReasoningMessages: new Set(),
      openToolCalls: new Set(),
      endedToolCalls: new Set(),
      openSteps: [],
      terminated: false,
      sawSnapshot: false,
    },
    timeline: createStateTimeline(),
    records: [],
    metricsDirty: true,
  };
}

export function createRunBuilder(options: RunBuilderOptions = {}): RunBuilder {
  const stallThresholdMs = options.stallThresholdMs ?? 2000;
  const entries = new Map<string, RunEntry>();
  const order: string[] = [];
  const conns = new Map<string, ConnEntry>();

  function ensureConn(connId: string): ConnEntry {
    let conn = conns.get(connId);
    if (!conn) {
      conn = { connId, runIds: [] };
      conns.set(connId, conn);
    }
    return conn;
  }

  function ensureOrphanEntry(connId: string, tMs: number): RunEntry {
    let entry = entries.get(ORPHANED_RUN_ID);
    if (!entry) {
      const run = createRun(ORPHANED_RUN_ID, '', connId, tMs);
      run.outcome = 'orphaned';
      entry = createEntry(run);
      entries.set(ORPHANED_RUN_ID, entry);
      order.push(ORPHANED_RUN_ID);
    }
    return entry;
  }

  function openRunFromStarted(conn: ConnEntry, event: AguiEvent, record: CaptureRecord): RunEntry {
    const runId = str(event.runId) ?? `__run_${record.seq}__`;
    const existing = entries.get(runId);
    if (existing) {
      conn.openRunId = runId;
      return existing;
    }
    const run = createRun(runId, str(event.threadId) ?? '', conn.connId, record.tMs);
    run.parentRunId = str(event.parentRunId);
    run.agentId = str(event.agentId);
    // The POST body stashed by addRequest is the fallback; an inlined RUN_STARTED.input wins.
    run.input = event.input !== undefined ? event.input : conn.input;
    const entry = createEntry(run);
    entries.set(runId, entry);
    order.push(runId);
    conn.openRunId = runId;
    conn.runIds.push(runId);
    return entry;
  }

  // A connection's current run stays current after its terminal event so that the validator
  // can see 'event-after-terminal' instead of the event silently becoming an orphan.
  function resolveRun(conn: ConnEntry, event: AguiEvent, record: CaptureRecord): RunEntry {
    if (event.type === 'RUN_STARTED') return openRunFromStarted(conn, event, record);
    if (conn.openRunId !== undefined) {
      const entry = entries.get(conn.openRunId);
      if (entry) return entry;
    }
    return ensureOrphanEntry(conn.connId, record.tMs);
  }

  function attachIssues(entry: RunEntry, issues: Issue[]): void {
    for (const issue of issues) {
      entry.run.issues.push(issue.runId === undefined ? { ...issue, runId: entry.run.runId } : issue);
    }
  }

  function noteRecord(
    entry: RunEntry,
    record: CaptureRecord,
    event: AguiEvent | null,
    countBytes: boolean,
  ): void {
    const seqs = entry.run.recordSeqs;
    if (seqs[seqs.length - 1] !== record.seq) seqs.push(record.seq);
    entry.records.push(
      countBytes
        ? { ...record, event, issues: [] }
        : { ...record, raw: undefined, event, issues: [] },
    );
    entry.metricsDirty = true;
  }

  function ensureMessage(
    entry: RunEntry,
    messageId: string,
    role: 'assistant' | 'reasoning',
    tMs: number,
  ): ReconstructedMessage {
    let message = entry.run.messages.get(messageId);
    if (!message) {
      // Content for a never-opened messageId is still reconstructed so the panel shows it;
      // the validator has already flagged the missing START on this same event.
      message = { messageId, role, content: '', startedAtMs: tMs, closed: false, chunkSeqs: [] };
      entry.run.messages.set(messageId, message);
      if (role === 'assistant') entry.validation.openTextMessages.add(messageId);
      else entry.validation.openReasoningMessages.add(messageId);
    }
    return message;
  }

  function applyTransition(entry: RunEntry, event: AguiEvent, record: CaptureRecord): void {
    const run = entry.run;
    const validation = entry.validation;
    switch (event.type) {
      case 'RUN_STARTED':
        break;
      case 'RUN_FINISHED':
      case 'RUN_ERROR': {
        if (run.runId === ORPHANED_RUN_ID) break;
        run.outcome = event.type === 'RUN_FINISHED' ? 'finished' : 'error';
        run.endedAtMs = record.tMs;
        validation.terminated = true;
        break;
      }
      case 'TEXT_MESSAGE_START': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) ensureMessage(entry, messageId, 'assistant', record.tMs);
        break;
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'assistant', record.tMs);
          message.content += str(event.delta) ?? '';
          message.chunkSeqs.push(record.seq);
        }
        break;
      }
      case 'TEXT_MESSAGE_END': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'assistant', record.tMs);
          message.closed = true;
          message.endedAtMs = record.tMs;
          validation.openTextMessages.delete(messageId);
        }
        break;
      }
      case 'REASONING_MESSAGE_START': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) ensureMessage(entry, messageId, 'reasoning', record.tMs);
        break;
      }
      case 'REASONING_MESSAGE_CONTENT': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'reasoning', record.tMs);
          message.content += str(event.delta) ?? '';
          message.chunkSeqs.push(record.seq);
        }
        break;
      }
      case 'REASONING_MESSAGE_END': {
        const messageId = str(event.messageId);
        if (messageId !== undefined) {
          const message = ensureMessage(entry, messageId, 'reasoning', record.tMs);
          message.closed = true;
          message.endedAtMs = record.tMs;
          validation.openReasoningMessages.delete(messageId);
        }
        break;
      }
      default:
        break;
    }
  }

  function addRecord(record: CaptureRecord): void {
    const conn = ensureConn(record.connId);

    if (record.event === null) {
      const open = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
      const entry = open ?? ensureOrphanEntry(conn.connId, record.tMs);
      noteRecord(entry, record, null, true);
      attachIssues(entry, record.issues);
      return;
    }

    const entry = resolveRun(conn, record.event, record);
    const issues = runRules(record.event, record, entry.validation);
    applyTransition(entry, record.event, record);
    noteRecord(entry, record, record.event, true);
    attachIssues(entry, issues);
    attachIssues(entry, record.issues);
  }

  function syncMetrics(entry: RunEntry): void {
    if (!entry.metricsDirty) return;
    entry.run.metrics = computeMetrics(entry.run, entry.records, stallThresholdMs);
    entry.metricsDirty = false;
  }

  return {
    addRequest(connId: string, method: string, url: string, input: unknown): void {
      const conn = ensureConn(connId);
      conn.method = method;
      conn.url = url;
      conn.input = input;
    },

    addRecord,

    closeConnection(connId: string, tMs: number): void {
      const conn = conns.get(connId);
      if (conn === undefined || conn.closedAtMs !== undefined) return;
      conn.closedAtMs = tMs;
      for (const runId of conn.runIds) {
        const entry = entries.get(runId);
        if (entry) syncMetrics(entry);
      }
    },

    runs(): Run[] {
      const result: Run[] = [];
      for (const runId of order) {
        const entry = entries.get(runId);
        if (entry === undefined) continue;
        if (runId === ORPHANED_RUN_ID && entry.run.recordSeqs.length === 0) continue;
        syncMetrics(entry);
        result.push(entry.run);
      }
      return result;
    },

    getRun(runId: string): Run | undefined {
      const entry = entries.get(runId);
      if (entry === undefined) return undefined;
      syncMetrics(entry);
      return entry.run;
    },

    allIssues(): Issue[] {
      const result: Issue[] = [];
      for (const runId of order) {
        const entry = entries.get(runId);
        if (entry) result.push(...entry.run.issues);
      }
      return result.sort((a, b) => a.seq - b.seq);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/normalizer/run-builder.test.ts`
Expected: 8 passing.

- [ ] **Step 5: Commit**

`git add src/core/normalizer/run-builder.ts src/core/normalizer/run-builder.test.ts && git commit -m "feat(core): run builder fold for run lifecycle and text messages"`

---

### Task 13b: Run builder — tool calls, state timeline, steps, activities

**Files:**
- Modify: `src/core/normalizer/run-builder.ts`
- Test: `src/core/normalizer/run-builder.test.ts`

- [ ] **Step 1: Write the failing test**

Append the following to `src/core/normalizer/run-builder.test.ts`:

```ts
describe('createRunBuilder — tool calls, state and steps', () => {
  function rec(seq: number, tMs: number, connId: string, event: AguiEvent): CaptureRecord {
    return { seq, tMs, connId, raw: event, event, issues: [] };
  }

  it('accumulates TOOL_CALL_ARGS across deltas and parses them at TOOL_CALL_END', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(
      rec(2, 10, 'c1', {
        type: 'TOOL_CALL_START',
        toolCallId: 'tc1',
        toolCallName: 'search',
        parentMessageId: 'm1',
      }),
    );
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '"cats"' }));
    builder.addRecord(rec(5, 35, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '}' }));
    builder.addRecord(rec(6, 40, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));
    builder.addRecord(
      rec(7, 60, 'c1', { type: 'TOOL_CALL_RESULT', messageId: 'm2', toolCallId: 'tc1', content: '12 results' }),
    );
    builder.addRecord(rec(8, 70, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));

    const run = builder.getRun('r1')!;
    const call = run.toolCalls.get('tc1')!;

    expect(call.argsText).toBe('{"q":"cats"}');
    expect(call.args).toEqual({ q: 'cats' });
    expect(call.argsParseError).toBeUndefined();
    expect(call.toolCallName).toBe('search');
    expect(call.parentMessageId).toBe('m1');
    expect(call.startedAtMs).toBe(10);
    expect(call.endedAtMs).toBe(40);
    expect(call.resultAtMs).toBe(60);
    expect(call.result).toBe('12 results');
    expect(call.closed).toBe(true);
    expect(run.metrics.toolLatencyMs).toEqual({ tc1: 50 });
    expect(run.issues.some((issue) => issue.code === 'tool-args-not-json')).toBe(false);
  });

  it('records argsParseError and raises tool-args-not-json when the accumulated args are invalid', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q":' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: 'cats' }));
    builder.addRecord(rec(5, 40, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));

    const run = builder.getRun('r1')!;
    const call = run.toolCalls.get('tc1')!;

    expect(call.argsText).toBe('{"q":cats');
    expect(call.args).toBeUndefined();
    expect(typeof call.argsParseError).toBe('string');
    expect(call.argsParseError!.length).toBeGreaterThan(0);

    const issue = run.issues.find((candidate) => candidate.code === 'tool-args-not-json')!;
    expect(issue.severity).toBe('error');
    expect(issue.runId).toBe('r1');
  });

  it('leaves args and argsParseError unset for a tool call that carried no args at all', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'ping' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_END', toolCallId: 'tc1' }));

    const call = builder.getRun('r1')!.toolCalls.get('tc1')!;
    expect(call.argsText).toBe('');
    expect(call.args).toBeUndefined();
    expect(call.argsParseError).toBeUndefined();
  });

  it('builds a state timeline of snapshot, applied delta, and failed delta', () => {
    const builder = createRunBuilder();
    const good = [{ op: 'replace', path: '/count', value: 2 }];
    const bad = [{ op: 'replace', path: '/nope', value: 9 }];

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'STATE_SNAPSHOT', snapshot: { count: 1, items: ['a'] } }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'STATE_DELTA', delta: good }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'STATE_DELTA', delta: bad }));

    const run = builder.getRun('r1')!;
    expect(run.stateTimeline).toHaveLength(3);
    expect(run.stateTimeline[0]!.kind).toBe('snapshot');
    expect(run.stateTimeline[0]!.value).toEqual({ count: 1, items: ['a'] });
    expect(run.stateTimeline[1]!.kind).toBe('delta');
    expect(run.stateTimeline[1]!.value).toEqual({ count: 2, items: ['a'] });
    expect(run.stateTimeline[1]!.failure).toBeUndefined();
    expect(run.stateTimeline[2]!.failure?.opIndex).toBe(0);
    expect(run.stateTimeline[2]!.failure?.reason).toBe('path-not-found');
    // a failed patch leaves the value at the previous frame
    expect(run.stateTimeline[2]!.value).toEqual({ count: 2, items: ['a'] });

    expect(run.issues.some((issue) => issue.code === 'state-patch-failed')).toBe(true);
    expect(run.metrics.statePatchCount).toBe(2);
    expect(run.metrics.statePatchBytes).toBe(JSON.stringify(good).length + JSON.stringify(bad).length);
  });

  it('tracks steps, closing the most recent open step of the same name', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'STEP_STARTED', stepName: 'plan' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'STEP_FINISHED', stepName: 'plan' }));
    builder.addRecord(rec(4, 30, 'c1', { type: 'STEP_STARTED', stepName: 'act' }));

    expect(builder.getRun('r1')!.steps).toEqual([
      { stepName: 'plan', startedAtMs: 10, endedAtMs: 20, closed: true },
      { stepName: 'act', startedAtMs: 30, closed: false },
    ]);
  });

  it('folds activity snapshots and patches them with activity deltas', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(
      rec(2, 10, 'c1', {
        type: 'ACTIVITY_SNAPSHOT',
        activityType: 'progress',
        messageId: 'm1',
        content: { pct: 10, label: 'starting' },
      }),
    );
    builder.addRecord(
      rec(3, 20, 'c1', {
        type: 'ACTIVITY_DELTA',
        activityType: 'progress',
        messageId: 'm1',
        patch: [{ op: 'replace', path: '/pct', value: 60 }],
      }),
    );

    const activity = builder.getRun('r1')!.activities.get('m1#progress')!;
    expect(activity.activityId).toBe('m1#progress');
    expect(activity.value).toEqual({ pct: 60, label: 'starting' });
    expect(activity.updatedAtMs).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/normalizer/run-builder.test.ts`
Expected: FAIL — the six new tests throw
`TypeError: Cannot read properties of undefined (reading 'argsText')`,
`expected [] to have a length of 3 but got +0`,
`expected [] to deeply equal [ { stepName: 'plan', … } ]`, and
`TypeError: Cannot read properties of undefined (reading 'activityId')`.
The eight Task 13a tests still pass.

- [ ] **Step 3: Write the implementation**

3.1 — Replace the import block at the top of `src/core/normalizer/run-builder.ts` with:

```ts
import {
  ORPHANED_RUN_ID,
  type AguiEvent,
  type CaptureRecord,
  type Issue,
  type PatchOp,
  type ReconstructedMessage,
  type Run,
  type RunMetrics,
  type ToolCallRecord,
} from '../model/types';
import { applyPatch } from '../state/json-patch';
import { createStateTimeline, type StateTimeline } from '../state/timeline';
import { runRules, type RunValidationState } from '../validator';
import { computeMetrics } from '../metrics/run-metrics';
```

3.2 — Add these two module-level helpers immediately after the `str` helper:

```ts
/**
 * An activity is identified by the message it belongs to plus its `activityType`; the
 * normalized model carries a single string id, so the two are joined with '#'.
 */
function activityIdOf(event: AguiEvent): string | undefined {
  const messageId = str(event.messageId);
  const activityType = str(event.activityType);
  if (messageId === undefined && activityType === undefined) return undefined;
  return `${messageId ?? ''}#${activityType ?? ''}`;
}

function asPatchOps(value: unknown): PatchOp[] {
  return Array.isArray(value) ? (value as PatchOp[]) : [];
}
```

3.3 — Add this helper inside `createRunBuilder`, immediately after `ensureMessage`:

```ts
  function ensureToolCall(entry: RunEntry, toolCallId: string, tMs: number): ToolCallRecord {
    let call = entry.run.toolCalls.get(toolCallId);
    if (!call) {
      // As with messages, a never-opened toolCallId is still materialized so its args are
      // visible; the validator has already flagged the missing TOOL_CALL_START.
      call = { toolCallId, argsText: '', startedAtMs: tMs, closed: false };
      entry.run.toolCalls.set(toolCallId, call);
      entry.validation.openToolCalls.add(toolCallId);
    }
    return call;
  }
```

3.4 — In `applyTransition`, replace the single `default:` clause at the end of the `switch`
with the following cases, keeping every existing case above them unchanged:

```ts
      case 'STEP_STARTED': {
        const stepName = str(event.stepName);
        if (stepName !== undefined) {
          run.steps.push({ stepName, startedAtMs: record.tMs, closed: false });
          validation.openSteps.push(stepName);
        }
        break;
      }
      case 'STEP_FINISHED': {
        const stepName = str(event.stepName);
        if (stepName !== undefined) {
          for (let i = run.steps.length - 1; i >= 0; i -= 1) {
            const step = run.steps[i]!;
            if (step.stepName === stepName && !step.closed) {
              step.closed = true;
              step.endedAtMs = record.tMs;
              break;
            }
          }
          const openIndex = validation.openSteps.lastIndexOf(stepName);
          if (openIndex >= 0) validation.openSteps.splice(openIndex, 1);
        }
        break;
      }
      case 'TOOL_CALL_START': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.toolCallName = str(event.toolCallName) ?? call.toolCallName;
          call.parentMessageId = str(event.parentMessageId) ?? call.parentMessageId;
        }
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.argsText += str(event.delta) ?? '';
        }
        break;
      }
      case 'TOOL_CALL_END': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.closed = true;
          call.endedAtMs = record.tMs;
          if (call.argsText.trim() === '') {
            // A tool call that streamed no args at all is not a parse failure.
            call.args = undefined;
            call.argsParseError = undefined;
          } else {
            try {
              call.args = JSON.parse(call.argsText) as unknown;
              call.argsParseError = undefined;
            } catch (error) {
              call.args = undefined;
              call.argsParseError = error instanceof Error ? error.message : String(error);
            }
          }
          validation.openToolCalls.delete(toolCallId);
          validation.endedToolCalls.add(toolCallId);
        }
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId !== undefined) {
          const call = ensureToolCall(entry, toolCallId, record.tMs);
          call.result = event.content;
          call.resultAtMs = record.tMs;
        }
        break;
      }
      case 'STATE_SNAPSHOT': {
        entry.timeline.applySnapshot(record.seq, record.tMs, event.snapshot);
        run.stateTimeline = entry.timeline.frames();
        validation.sawSnapshot = true;
        break;
      }
      case 'STATE_DELTA': {
        entry.timeline.applyDelta(record.seq, record.tMs, asPatchOps(event.delta));
        run.stateTimeline = entry.timeline.frames();
        break;
      }
      case 'ACTIVITY_SNAPSHOT': {
        const activityId = activityIdOf(event);
        if (activityId !== undefined) {
          run.activities.set(activityId, {
            activityId,
            value: event.content,
            updatedAtMs: record.tMs,
          });
        }
        break;
      }
      case 'ACTIVITY_DELTA': {
        const activityId = activityIdOf(event);
        if (activityId !== undefined) {
          const previous = run.activities.get(activityId);
          const result = applyPatch(previous?.value, asPatchOps(event.patch));
          run.activities.set(activityId, {
            activityId,
            // A failed activity patch keeps the last good value, mirroring the state timeline.
            value: result.ok ? result.value : previous?.value,
            updatedAtMs: record.tMs,
          });
        }
        break;
      }
      default:
        break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/normalizer/run-builder.test.ts`
Expected: 14 passing.

- [ ] **Step 5: Commit**

`git add src/core/normalizer/run-builder.ts src/core/normalizer/run-builder.test.ts && git commit -m "feat(core): fold tool calls, state timeline, steps and activities into runs"`

---

### Task 13c: Run builder — chunk expansion and connection close

**Files:**
- Modify: `src/core/normalizer/run-builder.ts`
- Test: `src/core/normalizer/run-builder.test.ts`

- [ ] **Step 1: Write the failing test**

Append the following to `src/core/normalizer/run-builder.test.ts`:

```ts
describe('createRunBuilder — chunk expansion and connection close', () => {
  function rec(seq: number, tMs: number, connId: string, event: AguiEvent): CaptureRecord {
    return { seq, tMs, connId, raw: event, event, issues: [] };
  }

  it('reconstructs the same message content from chunks as from an explicit triad', () => {
    const chunked = createRunBuilder({ expandChunks: true });
    chunked.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    chunked.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hel' }));
    chunked.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CHUNK', delta: 'lo ' }));
    chunked.addRecord(rec(4, 30, 'c1', { type: 'TEXT_MESSAGE_CHUNK', delta: 'world' }));

    const explicit = createRunBuilder({ expandChunks: false });
    explicit.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    explicit.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    explicit.addRecord(rec(3, 10, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' }));
    explicit.addRecord(rec(4, 20, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo ' }));
    explicit.addRecord(rec(5, 30, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'world' }));

    const fromChunks = chunked.getRun('r1')!.messages.get('m1')!;
    const fromTriad = explicit.getRun('r1')!.messages.get('m1')!;

    expect(fromChunks.content).toBe('Hello world');
    expect(fromChunks.content).toBe(fromTriad.content);
    expect(fromChunks.role).toBe(fromTriad.role);

    // expansion feeds metrics too: the chunk record at tMs 10 became the first content delta
    expect(chunked.getRun('r1')!.metrics.ttftMs).toBe(10);
    expect(chunked.getRun('r1')!.metrics.eventCountByType).toEqual({
      RUN_STARTED: 1,
      TEXT_MESSAGE_START: 1,
      TEXT_MESSAGE_CONTENT: 3,
    });
  });

  it('does not reconstruct chunked messages when expandChunks is false', () => {
    const builder = createRunBuilder({ expandChunks: false });

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hel' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CHUNK', delta: 'lo' }));

    const run = builder.getRun('r1')!;
    expect(run.messages.size).toBe(0);
    expect(run.recordSeqs).toEqual([1, 2, 3]);
    expect(run.metrics.eventCountByType).toEqual({ RUN_STARTED: 1, TEXT_MESSAGE_CHUNK: 2 });
  });

  it('expands TOOL_CALL_CHUNK into a start plus accumulated args', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(
      rec(2, 10, 'c1', { type: 'TOOL_CALL_CHUNK', toolCallId: 'tc1', toolCallName: 'search', delta: '{"q":' }),
    );
    builder.addRecord(rec(3, 20, 'c1', { type: 'TOOL_CALL_CHUNK', delta: '1}' }));

    const call = builder.getRun('r1')!.toolCalls.get('tc1')!;
    expect(call.toolCallName).toBe('search');
    expect(call.argsText).toBe('{"q":1}');
    expect(call.closed).toBe(false);
  });

  it('attaches chunk-expansion issues to the run even when nothing could be synthesized', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TOOL_CALL_CHUNK', delta: '{}' }));

    const run = builder.getRun('r1')!;
    expect(run.recordSeqs).toEqual([1, 2]);

    const issue = run.issues.find((candidate) => candidate.code === 'chunk-missing-tool-call-id')!;
    expect(issue.seq).toBe(2);
    expect(issue.runId).toBe('r1');
  });

  it('raises run-never-terminated and aborts the run when the connection closes mid-run', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }));
    builder.addRecord(rec(3, 20, 'c1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' }));
    builder.closeConnection('c1', 100);

    const run = builder.getRun('r1')!;
    const raised = run.issues.filter((issue) => issue.code === 'run-never-terminated');

    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('error');
    expect(raised[0]!.runId).toBe('r1');
    expect(raised[0]!.seq).toBe(3);
    expect(run.outcome).toBe('aborted');
    expect(run.endedAtMs).toBe(100);
    expect(run.metrics.durationMs).toBe(100);
  });

  it('does not raise run-never-terminated for a run that already finished, and closes once', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'c1', { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }));
    builder.addRecord(rec(2, 10, 'c1', { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }));
    builder.closeConnection('c1', 100);
    builder.closeConnection('c1', 200);

    const run = builder.getRun('r1')!;
    expect(run.issues.filter((issue) => issue.code === 'run-never-terminated')).toEqual([]);
    expect(run.outcome).toBe('finished');
    expect(run.endedAtMs).toBe(10);
  });

  it('closes only the runs belonging to the connection that closed', () => {
    const builder = createRunBuilder();

    builder.addRecord(rec(1, 0, 'cA', { type: 'RUN_STARTED', threadId: 'tA', runId: 'rA' }));
    builder.addRecord(rec(2, 1, 'cB', { type: 'RUN_STARTED', threadId: 'tB', runId: 'rB' }));
    builder.closeConnection('cA', 50);

    expect(builder.getRun('rA')!.outcome).toBe('aborted');
    expect(builder.getRun('rB')!.outcome).toBe('running');
    expect(builder.getRun('rB')!.issues.some((issue) => issue.code === 'run-never-terminated')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/normalizer/run-builder.test.ts`
Expected: FAIL — the new tests throw
`TypeError: Cannot read properties of undefined (reading 'content')` (chunk expansion never runs),
`TypeError: Cannot read properties of undefined (reading 'toolCallName')`,
`TypeError: Cannot read properties of undefined (reading 'seq')`, and
`expected [] to have a length of 1 but got +0` (no `run-never-terminated`).
The 14 tests from Tasks 13a and 13b still pass.

- [ ] **Step 3: Write the implementation**

3.1 — Replace the import block at the top of `src/core/normalizer/run-builder.ts` with:

```ts
import {
  ORPHANED_RUN_ID,
  type AguiEvent,
  type CaptureRecord,
  type Issue,
  type PatchOp,
  type ReconstructedMessage,
  type Run,
  type RunMetrics,
  type ToolCallRecord,
} from '../model/types';
import { applyPatch } from '../state/json-patch';
import { createStateTimeline, type StateTimeline } from '../state/timeline';
import { runRules, finalizeRules, type RunValidationState } from '../validator';
import { computeMetrics } from '../metrics/run-metrics';
import { createChunkExpanderState, expandChunk, type ChunkExpanderState } from './chunk-expander';
```

3.2 — Replace the `ConnEntry` interface with:

```ts
interface ConnEntry {
  connId: string;
  method?: string;
  url?: string;
  input?: unknown;
  openRunId?: string;
  runIds: string[];
  closedAtMs?: number;
  chunkState: ChunkExpanderState;
}
```

3.3 — Inside `createRunBuilder`, replace the single line
`const stallThresholdMs = options.stallThresholdMs ?? 2000;` with:

```ts
  const expandChunks = options.expandChunks ?? true;
  const stallThresholdMs = options.stallThresholdMs ?? 2000;
```

and replace the `ensureConn` function with:

```ts
  function ensureConn(connId: string): ConnEntry {
    let conn = conns.get(connId);
    if (!conn) {
      conn = { connId, runIds: [], chunkState: createChunkExpanderState() };
      conns.set(connId, conn);
    }
    return conn;
  }
```

3.4 — Replace the whole `addRecord` function with:

```ts
  function addRecord(record: CaptureRecord): void {
    const conn = ensureConn(record.connId);

    // 1. An unparseable frame carries no event to fold; it still belongs to the run's
    //    record list and its capture-time issues still surface on the run.
    if (record.event === null) {
      const open = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
      const entry = open ?? ensureOrphanEntry(conn.connId, record.tMs);
      noteRecord(entry, record, null, true);
      attachIssues(entry, record.issues);
      return;
    }

    // 2. Chunk expansion, when enabled, turns one *_CHUNK into its triad members.
    let events: AguiEvent[];
    let expansionIssues: Issue[];
    if (expandChunks) {
      const expansion = expandChunk(record.event, conn.chunkState, record.seq);
      events = expansion.events;
      expansionIssues = expansion.issues;
    } else {
      events = [record.event];
      expansionIssues = [];
    }

    // 3. Resolve, validate (pure), then mutate — the builder owns every state change.
    let first: RunEntry | undefined;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      const entry = resolveRun(conn, event, record);
      if (first === undefined) first = entry;
      const issues = runRules(event, record, entry.validation);
      applyTransition(entry, event, record);
      // Only the first expanded event carries the raw frame, so its bytes are counted once.
      noteRecord(entry, record, event, i === 0);
      attachIssues(entry, issues);
    }

    // 4. Record bookkeeping and issue attachment for the record as a whole.
    const openEntry = conn.openRunId === undefined ? undefined : entries.get(conn.openRunId);
    const target = first ?? openEntry ?? ensureOrphanEntry(conn.connId, record.tMs);
    if (events.length === 0) noteRecord(target, record, null, true);
    attachIssues(target, expansionIssues);
    attachIssues(target, record.issues);
  }
```

3.5 — Replace the `closeConnection` method in the returned object with:

```ts
    closeConnection(connId: string, tMs: number): void {
      const conn = conns.get(connId);
      if (conn === undefined || conn.closedAtMs !== undefined) return;
      conn.closedAtMs = tMs;
      for (const runId of conn.runIds) {
        const entry = entries.get(runId);
        if (entry === undefined) continue;
        // `finalizeRules` is the SOLE owner of every run-end issue, including
        // `run-never-terminated`. It derives `seq` from `run.recordSeqs` itself.
        // The builder must not emit that issue a second time here — doing so
        // double-counts it and breaks the Task 16 "exactly three issues" test.
        attachIssues(entry, finalizeRules(entry.validation, tMs));
        if (entry.run.outcome === 'running') {
          entry.run.outcome = 'aborted';
          entry.run.endedAtMs = tMs;
          entry.metricsDirty = true;
        }
        syncMetrics(entry);
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/normalizer/run-builder.test.ts`
Expected: 21 passing.

- [ ] **Step 5: Commit**

`git add src/core/normalizer/run-builder.ts src/core/normalizer/run-builder.test.ts && git commit -m "feat(core): chunk expansion and connection close in the run builder"`

---

## Contract gaps

1. **Task numbering.** The LOCKED CONTRACT lists `run-builder.ts` as Task 11, `validator/index.ts`
   as Task 12 and `metrics/run-metrics.ts` as Task 13. This section was assigned the opposite
   mapping (Task 12 = metrics, Task 13 = run-builder) and follows the assignment. Whoever
   assembles the plan should renumber consistently; the file paths and signatures are unambiguous.

2. **`finalizeRules` is not in the LOCKED CONTRACT.** `closeConnection` needs the
   `unclosed-message` / `unclosed-tool-call` / `unbalanced-steps` checks, which are pure
   functions of `RunValidationState` and have no triggering event. This section assumes
   `src/core/validator/index.ts` also exports:
   ```ts
   export function finalizeRules(state: RunValidationState, tMs: number): Issue[];
   ```
   **RESOLVED AT ASSEMBLY.** This section originally assumed a third `seq` parameter and that
   the builder owned `run-never-terminated`. Task 11 already derives `seq` from
   `state.run.recordSeqs` (falling back to `0` for a run with no records) and already emits
   `run-never-terminated` itself. Emitting it in both places double-counted the issue and would
   have broken Task 16's "exactly three issues" assertion. `finalizeRules` is now the **sole
   owner of every run-end issue**, and `closeConnection` only applies the resulting state
   transition.

3. **The builder still owns `outcome: 'aborted'` and `endedAtMs`.** The contract's `RunOutcome`
   includes `'aborted'` but nothing says what produces it. A run still `'running'` when its
   connection closes is exactly that case, and setting `endedAtMs = tMs` is what makes
   `durationMs` computable for a truncated run. This is a state mutation, not an issue, so it
   stays in the builder — `finalizeRules` remains pure and must not touch `outcome`.

4. **`computeMetrics` tolerates `record.raw === undefined`.** The contract says
   `totalStreamBytes` sums `JSON.stringify(record.raw).length`, which throws on `undefined`.
   The implementation treats a non-serializable `raw` as zero bytes. This is load-bearing: when
   chunk expansion turns one captured frame into three events, the run builder pushes one
   metrics record per expanded event and clears `raw` on all but the first, so the frame's bytes
   are counted exactly once while TTFT and inter-token gaps still see the expanded
   `TEXT_MESSAGE_CONTENT` events. Without it, chunked streams (the CopilotKit default) would
   report `ttftMs: undefined`. A consequence: `eventCountByType` counts *expanded* events when
   `expandChunks` is true and raw events when it is false — the two tests in Task 13c pin both.

5. **Percentile method.** `gapP50Ms` / `gapP95Ms` use nearest-rank
   (`ceil(p/100 * N)`, clamped, no interpolation). The requirements say only "p50/p95". The
   choice is documented in a code comment and pinned by a test whose expected values differ
   from the interpolated answer.

6. **`ActivityRecord.activityId`.** `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` are keyed by
   `messageId` *and* `activityType` in `@ag-ui/core@0.0.57`, but `ActivityRecord` carries a
   single `activityId: string`. This section composes it as `` `${messageId}#${activityType}` ``.
   If another section needs to look activities up, it must use the same composition.

7. **Post-terminal events stay on the connection's run.** `resolveRun` deliberately does not
   clear `conn.openRunId` at `RUN_FINISHED` / `RUN_ERROR`; otherwise a later event would land in
   the orphaned run and the validator's `event-after-terminal` rule could never fire. A new
   `RUN_STARTED` replaces the connection's current run.

8. **The orphaned run is excluded from `closeConnection`.** It is a single builder-wide bucket
   (`ORPHANED_RUN_ID` is one literal) and is not owned by any connection, so `finalizeRules`
   never runs against it and unclosed messages inside it are not reported. Its `outcome` is
   pinned to `'orphaned'` and `RUN_FINISHED` / `RUN_ERROR` routed there do not change it.

9. **Cross-section test coupling.** Three Task 13 assertions depend on rules owned by Section E
   emitting the exact contract codes: `event-before-run-started` for an event with no
   `RUN_STARTED` (13a), `tool-args-not-json` at `TOOL_CALL_END` when
   `state.run.toolCalls.get(id).argsText` does not parse (13b), and `state-patch-failed` for a
   `STATE_DELTA` that fails to apply (13b). Because the builder runs rules *before* applying the
   transition, the accumulated `argsText` and the previous state frame are both already
   available on `state.run` when those rules execute. Section E must read them from `state.run`
   rather than expecting the builder to pass them in.

10. **`applyPatch` failure reason.** Task 13b asserts `reason: 'path-not-found'` for
    `{ op: 'replace', path: '/nope' }` against `{ count: 2, items: ['a'] }` — i.e. a `replace`
    whose parent exists but whose final key does not. If Task 9 classifies that as
    `'parent-not-found'` instead, that single assertion needs updating.

---

### Task 14: JSONL codec (`encodeJsonl` / `decodeJsonl`)

**Files:**
- Create: `src/core/jsonl/codec.ts`
- Create: `src/core/jsonl/redact.ts` (type declaration only in this task — the functions land in Task 15)
- Test: `src/core/jsonl/codec.test.ts`

`codec.ts` needs the `RedactionGroup` union for `JsonlHeader.redacted`, and the LOCKED CONTRACT
declares that union in `redact.ts`. So Task 14 creates `redact.ts` containing nothing but the type
alias, and Task 15 adds the behaviour to the same file. The dependency is type-only in both
directions (`codec.ts` imports the type from `redact.ts`, `redact.ts` imports the line types from
`codec.ts`), which erases at compile time.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/jsonl/codec.test.ts
import { describe, it, expect } from 'vitest';
import {
  decodeJsonl,
  encodeJsonl,
  type JsonlEvent,
  type JsonlHeader,
  type JsonlLine,
  type JsonlRequest,
} from './codec';

const header: JsonlHeader = {
  kind: 'header',
  schemaVersion: 1,
  tool: 'ag-ui-devtools@0.1.0',
  capturedAt: '2026-08-13T10:00:00.000Z',
  url: 'http://localhost:3000/',
  framework: 'react/copilotkit',
  transport: 'sse',
  redacted: ['text', 'toolArgs'],
};

const request: JsonlRequest = {
  kind: 'request',
  connId: 'c1',
  tMs: 0,
  method: 'POST',
  url: '/api/copilotkit/agent/default/run',
  input: { threadId: 't_1', messages: [{ id: 'm_user_1', role: 'user', content: 'hi' }] },
};

const event: JsonlEvent = {
  kind: 'event',
  connId: 'c1',
  seq: 1,
  tMs: 12,
  event: { type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' },
};

describe('encodeJsonl', () => {
  it('emits one JSON object per line with a trailing newline', () => {
    const text = encodeJsonl([header, request, event]);

    expect(text.endsWith('\n')).toBe(true);
    const physical = text.split('\n');
    expect(physical).toHaveLength(4);
    expect(physical[3]).toBe('');
    expect(JSON.parse(physical[0])).toEqual(header);
    expect(JSON.parse(physical[1])).toEqual(request);
    expect(JSON.parse(physical[2])).toEqual(event);
  });

  it('encodes an empty list as the empty string', () => {
    expect(encodeJsonl([])).toBe('');
  });
});

describe('decodeJsonl', () => {
  it('round-trips a header, a request and an event', () => {
    const lines: JsonlLine[] = [header, request, event];

    const decoded = decodeJsonl(encodeJsonl(lines));

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual(lines);
  });

  it('survives a payload containing a newline inside a string', () => {
    const multiline: JsonlEvent = {
      kind: 'event',
      connId: 'c1',
      seq: 2,
      tMs: 20,
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm_1',
        delta: 'line one\nline two\r\nline three',
      },
    };

    const text = encodeJsonl([multiline]);

    // The physical file is still exactly one record line: the newline is escaped, not literal.
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(text).toContain('line one\\nline two\\r\\nline three');

    const decoded = decodeJsonl(text);
    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([multiline]);
    expect((decoded.lines[0] as JsonlEvent).event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: 'line one\nline two\r\nline three',
    });
  });

  it('skips blank and whitespace-only lines', () => {
    const text = ['', JSON.stringify(header), '', '   ', JSON.stringify(event), ''].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([header, event]);
  });

  it('decodes identically with and without a trailing newline', () => {
    const body = [JSON.stringify(header), JSON.stringify(event)].join('\n');

    const withNewline = decodeJsonl(`${body}\n`);
    const withoutNewline = decodeJsonl(body);

    expect(withNewline.lines).toEqual(withoutNewline.lines);
    expect(withNewline.errors).toEqual([]);
    expect(withoutNewline.errors).toEqual([]);
  });

  it('handles CRLF line terminators', () => {
    const text = `${JSON.stringify(header)}\r\n${JSON.stringify(event)}\r\n`;

    const decoded = decodeJsonl(text);

    expect(decoded.errors).toEqual([]);
    expect(decoded.lines).toEqual([header, event]);
  });

  it('collects an error for a malformed JSON line and continues', () => {
    const text = [JSON.stringify(header), '{"kind":"event",', JSON.stringify(event)].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.lines).toEqual([header, event]);
    expect(decoded.errors).toHaveLength(1);
    expect(decoded.errors[0]).toContain('line 2');
    expect(decoded.errors[0]).toContain('invalid JSON');
  });

  it('collects an error for a valid JSON line with an unrecognized kind and continues', () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify({ kind: 'summary', total: 3 }),
      JSON.stringify({ seq: 9 }),
      JSON.stringify(event),
    ].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.lines).toEqual([header, event]);
    expect(decoded.errors).toHaveLength(2);
    expect(decoded.errors[0]).toContain('line 2');
    expect(decoded.errors[0]).toContain('unrecognized kind');
    expect(decoded.errors[0]).toContain('"summary"');
    expect(decoded.errors[1]).toContain('line 3');
    expect(decoded.errors[1]).toContain('unrecognized kind');
  });

  it('collects an error for a JSON line that is not an object', () => {
    const text = ['42', '[1,2,3]', 'null', JSON.stringify(event)].join('\n');

    const decoded = decodeJsonl(text);

    expect(decoded.lines).toEqual([event]);
    expect(decoded.errors).toHaveLength(3);
    expect(decoded.errors[0]).toContain('line 1');
    expect(decoded.errors[0]).toContain('not a JSONL record object');
    expect(decoded.errors[1]).toContain('line 2');
    expect(decoded.errors[2]).toContain('line 3');
  });

  it('returns empty results for empty input', () => {
    expect(decodeJsonl('')).toEqual({ lines: [], errors: [] });
    expect(decodeJsonl('\n\n')).toEqual({ lines: [], errors: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/jsonl/codec.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./codec" from "src/core/jsonl/codec.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/jsonl/redact.ts
// Task 14 creates this file with the shared union only; Task 15 adds the redaction functions.
export type RedactionGroup = 'text' | 'reasoning' | 'toolArgs' | 'toolResults' | 'state';
```

```ts
// src/core/jsonl/codec.ts
import type { RedactionGroup } from './redact';

export interface JsonlHeader {
  kind: 'header';
  schemaVersion: 1;
  tool: string;
  capturedAt: string;
  url: string;
  framework?: string;
  transport: 'sse' | 'binary';
  redacted: RedactionGroup[];
}

export interface JsonlRequest {
  kind: 'request';
  connId: string;
  tMs: number;
  method: string;
  url: string;
  input: unknown;
}

export interface JsonlEvent {
  kind: 'event';
  connId: string;
  seq: number;
  tMs: number;
  event: unknown;
}

export type JsonlLine = JsonlHeader | JsonlRequest | JsonlEvent;

const KNOWN_KINDS: ReadonlySet<string> = new Set(['header', 'request', 'event']);

/**
 * One JSON object per line, trailing newline included. `JSON.stringify` escapes every
 * newline inside a string payload, so a record can never span two physical lines — that
 * is the property that makes JSONL safe for streams carrying multi-line model output.
 */
export function encodeJsonl(lines: JsonlLine[]): string {
  if (lines.length === 0) return '';
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/**
 * Blank lines are skipped. Every unparseable or unrecognized line contributes one message
 * to `errors` and decoding continues, so a truncated or corrupted capture still loads.
 */
export function decodeJsonl(text: string): { lines: JsonlLine[]; errors: string[] } {
  const lines: JsonlLine[] = [];
  const errors: string[] = [];

  const physical = text.split(/\r?\n/);
  for (let i = 0; i < physical.length; i += 1) {
    const lineNo = i + 1;
    const raw = physical[i];
    if (raw.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errors.push(`line ${lineNo}: invalid JSON: ${detail}`);
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`line ${lineNo}: not a JSONL record object`);
      continue;
    }

    const kind = (parsed as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
      errors.push(`line ${lineNo}: unrecognized kind ${JSON.stringify(kind)}`);
      continue;
    }

    lines.push(parsed as JsonlLine);
  }

  return { lines, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/jsonl/codec.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

`git commit -m "feat(devtools): jsonl codec with lossless line round-trip"`

---

### Task 15: Redaction (`redactLine` / `redactString`)

**Files:**
- Modify: `src/core/jsonl/redact.ts` (created in Task 14 holding only the `RedactionGroup` union)
- Test: `src/core/jsonl/redact.test.ts`

Group → field mapping implemented here:

| group | redacted |
| --- | --- |
| `text` | `TEXT_MESSAGE_CONTENT.delta`, `TEXT_MESSAGE_CHUNK.delta` |
| `reasoning` | `REASONING_MESSAGE_CONTENT.delta`, `REASONING_MESSAGE_CHUNK.delta`, `REASONING_ENCRYPTED_VALUE.encryptedValue` |
| `toolArgs` | `TOOL_CALL_ARGS.delta`, `TOOL_CALL_CHUNK.delta` |
| `toolResults` | `TOOL_CALL_RESULT.content` |
| `state` | `STATE_SNAPSHOT.snapshot` leaves, `STATE_DELTA` op `value` leaves (`op`/`path`/`from` preserved), `JsonlRequest.input.messages[].content` |

`null` and `undefined` are structure, not payload: they survive untouched. Object keys are
structure too. Numbers and booleans are payload and are replaced using their decimal/`true|false`
text length, so `7` becomes `«redacted: 1 chars»` and `false` becomes `«redacted: 5 chars»`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/jsonl/redact.test.ts
import { describe, it, expect } from 'vitest';
import type { JsonlEvent, JsonlHeader, JsonlRequest } from './codec';
import { ALL_REDACTION_GROUPS, redactLine, redactString } from './redact';

function ev(event: Record<string, unknown>, seq = 1): JsonlEvent {
  return { kind: 'event', connId: 'c1', seq, tMs: seq * 10, event };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('redactString', () => {
  it('uses the exact template with the real character count', () => {
    expect(redactString('Hello, world!')).toBe('«redacted: 13 chars»');
    expect(redactString('')).toBe('«redacted: 0 chars»');
    expect(redactString('a'.repeat(412))).toBe('«redacted: 412 chars»');
  });
});

describe('ALL_REDACTION_GROUPS', () => {
  it('lists every group', () => {
    expect([...ALL_REDACTION_GROUPS]).toEqual([
      'text',
      'reasoning',
      'toolArgs',
      'toolResults',
      'state',
    ]);
  });
});

describe('redactLine — text group', () => {
  it('replaces TEXT_MESSAGE_CONTENT delta and preserves every structural field', () => {
    const line = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello, world!' }, 3);

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out).toEqual({
      kind: 'event',
      connId: 'c1',
      seq: 3,
      tMs: 30,
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm_1',
        delta: '«redacted: 13 chars»',
      },
    });
  });

  it('replaces TEXT_MESSAGE_CHUNK delta and keeps messageId and role', () => {
    const line = ev({
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm_1',
      role: 'assistant',
      delta: 'abc',
    });

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm_1',
      role: 'assistant',
      delta: '«redacted: 3 chars»',
    });
  });

  it('does not mutate its argument', () => {
    const line = deepFreeze(
      ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello, world!' }),
    );

    const out = redactLine(line, ['text']) as JsonlEvent;

    expect(out).not.toBe(line);
    expect(line.event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: 'Hello, world!',
    });
  });

  it('leaves other groups alone', () => {
    const args = ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"a":1}' });
    const result = ev({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      content: 'sunny',
    });

    expect((redactLine(args, ['text']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'tc_1',
      delta: '{"a":1}',
    });
    expect((redactLine(result, ['text']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      content: 'sunny',
    });
  });
});

describe('redactLine — reasoning group', () => {
  it('replaces reasoning content, chunk delta and encrypted value', () => {
    const content = ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'm_r', delta: 'because' });
    const chunk = ev({ type: 'REASONING_MESSAGE_CHUNK', messageId: 'm_r', delta: 'abc' });
    const encrypted = ev({
      type: 'REASONING_ENCRYPTED_VALUE',
      entityId: 'e_1',
      subtype: 'thinking',
      encryptedValue: 'ZW5jcnlwdGVk',
    });

    expect((redactLine(content, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'REASONING_MESSAGE_CONTENT',
      messageId: 'm_r',
      delta: '«redacted: 7 chars»',
    });
    expect((redactLine(chunk, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'REASONING_MESSAGE_CHUNK',
      messageId: 'm_r',
      delta: '«redacted: 3 chars»',
    });
    expect((redactLine(encrypted, ['reasoning']) as JsonlEvent).event).toEqual({
      type: 'REASONING_ENCRYPTED_VALUE',
      entityId: 'e_1',
      subtype: 'thinking',
      encryptedValue: '«redacted: 12 chars»',
    });
  });
});

describe('redactLine — toolArgs and toolResults groups', () => {
  it('replaces TOOL_CALL_ARGS and TOOL_CALL_CHUNK deltas, keeping ids and names', () => {
    const args = ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc_1', delta: '{"city":"Paris",' });
    const chunk = ev({
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'tc_1',
      toolCallName: 'get_weather',
      parentMessageId: 'm_1',
      delta: '{"a":1}',
    });

    expect((redactLine(args, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'tc_1',
      delta: '«redacted: 16 chars»',
    });
    expect((redactLine(chunk, ['toolArgs']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'tc_1',
      toolCallName: 'get_weather',
      parentMessageId: 'm_1',
      delta: '«redacted: 7 chars»',
    });
  });

  it('replaces TOOL_CALL_RESULT content, keeping ids and role', () => {
    const line = ev({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      role: 'tool',
      content: '{"tempC":24}',
    });

    expect((redactLine(line, ['toolResults']) as JsonlEvent).event).toEqual({
      type: 'TOOL_CALL_RESULT',
      messageId: 'm_2',
      toolCallId: 'tc_1',
      role: 'tool',
      content: '«redacted: 12 chars»',
    });
  });
});

describe('redactLine — state group', () => {
  it('replaces every snapshot leaf, keeping keys, nulls and array shape', () => {
    const line = deepFreeze(
      ev({
        type: 'STATE_SNAPSHOT',
        snapshot: {
          counter: 7,
          ok: true,
          name: 'Ada',
          missing: null,
          notes: ['one', 2, false, null],
          nested: { deep: { s: 'x' } },
          empty: [],
        },
      }),
    );

    const out = redactLine(line, ['state']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'STATE_SNAPSHOT',
      snapshot: {
        counter: '«redacted: 1 chars»',
        ok: '«redacted: 4 chars»',
        name: '«redacted: 3 chars»',
        missing: null,
        notes: ['«redacted: 3 chars»', '«redacted: 1 chars»', '«redacted: 5 chars»', null],
        nested: { deep: { s: '«redacted: 1 chars»' } },
        empty: [],
      },
    });
    expect((line.event as { snapshot: { name: string } }).snapshot.name).toBe('Ada');
  });

  it('preserves op and path on a STATE_DELTA and redacts only the value leaves', () => {
    const line = ev({
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/counter', value: 2 },
        { op: 'add', path: '/notes/-', value: 'second note' },
        { op: 'add', path: '/profile', value: { name: 'Ada', tags: ['x', null] } },
        { op: 'remove', path: '/stale' },
        { op: 'move', path: '/b', from: '/a' },
      ],
    });

    const out = redactLine(line, ['state']) as JsonlEvent;

    expect(out.event).toEqual({
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/counter', value: '«redacted: 1 chars»' },
        { op: 'add', path: '/notes/-', value: '«redacted: 11 chars»' },
        {
          op: 'add',
          path: '/profile',
          value: { name: '«redacted: 3 chars»', tags: ['«redacted: 1 chars»', null] },
        },
        { op: 'remove', path: '/stale' },
        { op: 'move', path: '/b', from: '/a' },
      ],
    });
  });

  it('replaces request input message contents without touching ids, roles or ordering', () => {
    const request: JsonlRequest = deepFreeze({
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/api/copilotkit/agent/default/run',
      input: {
        threadId: 't_1',
        runId: 'r_1',
        messages: [
          { id: 'm_user_1', role: 'user', content: 'What is the weather in Paris?' },
          { id: 'm_a_1', role: 'assistant', content: 'Checking.' },
        ],
        tools: [],
      },
    });

    const out = redactLine(request, ['state']) as JsonlRequest;

    expect(out).toEqual({
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/api/copilotkit/agent/default/run',
      input: {
        threadId: 't_1',
        runId: 'r_1',
        messages: [
          { id: 'm_user_1', role: 'user', content: '«redacted: 29 chars»' },
          { id: 'm_a_1', role: 'assistant', content: '«redacted: 9 chars»' },
        ],
        tools: [],
      },
    });
  });

  it('leaves the request alone when the state group is not selected', () => {
    const request: JsonlRequest = {
      kind: 'request',
      connId: 'c1',
      tMs: 0,
      method: 'POST',
      url: '/run',
      input: { messages: [{ id: 'm_user_1', role: 'user', content: 'secret' }] },
    };

    expect(redactLine(request, ['text', 'toolArgs'])).toEqual(request);
  });
});

describe('redactLine — passthrough cases', () => {
  it('is a no-op for an empty group list', () => {
    const line = ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm_1', delta: 'Hello, world!' });

    const out = redactLine(line, []);

    expect(out).toEqual(line);
    expect((out as JsonlEvent).event).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: 'Hello, world!',
    });
  });

  it('leaves the header untouched', () => {
    const header: JsonlHeader = {
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@0.1.0',
      capturedAt: '2026-08-13T10:00:00.000Z',
      url: 'http://localhost:3000/',
      transport: 'sse',
      redacted: [],
    };

    expect(redactLine(header, [...ALL_REDACTION_GROUPS])).toEqual(header);
  });

  it('leaves lifecycle events untouched under every group', () => {
    const line = ev({ type: 'RUN_STARTED', threadId: 't_1', runId: 'r_1' });

    expect((redactLine(line, [...ALL_REDACTION_GROUPS]) as JsonlEvent).event).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_1',
      runId: 'r_1',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/jsonl/redact.test.ts`
Expected: FAIL with `SyntaxError: The requested module './redact' does not provide an export named 'redactLine'`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/jsonl/redact.ts
import type { JsonlLine } from './codec';

export type RedactionGroup = 'text' | 'reasoning' | 'toolArgs' | 'toolResults' | 'state';

export const ALL_REDACTION_GROUPS: readonly RedactionGroup[] = [
  'text',
  'reasoning',
  'toolArgs',
  'toolResults',
  'state',
];

/** The one and only placeholder shape. Size survives; content does not. */
export function redactString(value: string): string {
  return `«redacted: ${value.length} chars»`;
}

/** Leaves carry payload; `null`/`undefined` are structure and survive. */
function redactLeaf(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return redactString(String(value));
  return value;
}

/** Walks containers, replacing every leaf. Keys, array positions and nulls are preserved. */
function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(child);
    }
    return out;
  }
  return redactLeaf(value);
}

/** Single-field replacements: event type -> the group that owns it and the field it names. */
const SINGLE_FIELD: Record<string, { group: RedactionGroup; field: string }> = {
  TEXT_MESSAGE_CONTENT: { group: 'text', field: 'delta' },
  TEXT_MESSAGE_CHUNK: { group: 'text', field: 'delta' },
  REASONING_MESSAGE_CONTENT: { group: 'reasoning', field: 'delta' },
  REASONING_MESSAGE_CHUNK: { group: 'reasoning', field: 'delta' },
  // Field is `encryptedValue`, verified against @ag-ui/core@0.0.57's
  // ReasoningEncryptedValueEventSchema shape (type, timestamp, rawEvent,
  // subtype, entityId, encryptedValue). There is no `value` field.
  REASONING_ENCRYPTED_VALUE: { group: 'reasoning', field: 'encryptedValue' },
  TOOL_CALL_ARGS: { group: 'toolArgs', field: 'delta' },
  TOOL_CALL_CHUNK: { group: 'toolArgs', field: 'delta' },
  TOOL_CALL_RESULT: { group: 'toolResults', field: 'content' },
};

function redactPatchOp(op: unknown): unknown {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return op;
  const src = op as Record<string, unknown>;
  if (!('value' in src)) return { ...src };
  return { ...src, value: redactDeep(src.value) };
}

function redactEvent(event: unknown, groups: ReadonlySet<RedactionGroup>): unknown {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return event;
  const src = event as Record<string, unknown>;
  const type = typeof src.type === 'string' ? src.type : '';

  const single = SINGLE_FIELD[type];
  if (single && groups.has(single.group) && single.field in src) {
    return { ...src, [single.field]: redactLeaf(src[single.field]) };
  }

  if (groups.has('state')) {
    if (type === 'STATE_SNAPSHOT' && 'snapshot' in src) {
      return { ...src, snapshot: redactDeep(src.snapshot) };
    }
    if (type === 'STATE_DELTA' && Array.isArray(src.delta)) {
      return { ...src, delta: src.delta.map((op) => redactPatchOp(op)) };
    }
  }

  return event;
}

function redactInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const src = input as Record<string, unknown>;
  if (!Array.isArray(src.messages)) return { ...src };

  const messages = src.messages.map((message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return message;
    const msg = message as Record<string, unknown>;
    if (!('content' in msg)) return { ...msg };
    return { ...msg, content: redactDeep(msg.content) };
  });

  return { ...src, messages };
}

/**
 * Returns a redacted copy. Never mutates its argument. Structure — `type`, ids, ordering,
 * timings, JSON Pointer paths, patch ops — always survives; only the value payloads named
 * by `groups` are replaced.
 */
export function redactLine(line: JsonlLine, groups: RedactionGroup[]): JsonlLine {
  if (groups.length === 0) return line;
  const set = new Set(groups);

  if (line.kind === 'event') {
    return { ...line, event: redactEvent(line.event, set) };
  }
  if (line.kind === 'request') {
    if (!set.has('state')) return line;
    return { ...line, input: redactInput(line.input) };
  }
  return line;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/jsonl/redact.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

`git commit -m "feat(devtools): redaction profile preserving structure, ids and timings"`

---

### Task 16: Golden fixtures and end-to-end tests (Done-when 5, 6, 7)

**Files:**
- Create: `src/test/fixtures/happy-run.agui.jsonl`
- Create: `src/test/fixtures/malformed.agui.jsonl`
- Create: `src/test/fixtures/chunked-run.agui.jsonl`
- Test: `src/test/integration.test.ts`

The fixtures are the specification of the wire format, so they are written first, in full. Each
subsequent integration test then goes through a falsification cycle: write it, break one input on
purpose, confirm it fails for the stated reason, restore, confirm it passes. An integration test
that has never been observed failing is not evidence of anything.

`malformed.agui.jsonl` carries exactly three defects — no terminal event, one empty
`TEXT_MESSAGE_CONTENT` delta (seq 5), one `STATE_DELTA` whose op targets a missing parent (seq 9).
Everything else is deliberately clean: the message is closed, the steps are balanced, the snapshot
precedes the delta, the request supplies `input`, and no gap exceeds the keepalive threshold — so
any fourth issue means a real regression.

- [ ] **Step 1: Write the fixture files**

`src/test/fixtures/happy-run.agui.jsonl`:

```
{"kind":"header","schemaVersion":1,"tool":"ag-ui-devtools@0.1.0","capturedAt":"2026-08-13T10:00:00.000Z","url":"http://localhost:3000/","framework":"react/copilotkit","transport":"sse","redacted":[]}
{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/api/copilotkit/agent/default/run","input":{"threadId":"t_happy","runId":"r_happy","state":{"counter":0},"messages":[{"id":"m_user_1","role":"user","content":"What is the weather in Paris?"}],"tools":[],"context":[],"forwardedProps":{}}}
{"kind":"event","connId":"c1","seq":1,"tMs":12,"event":{"type":"RUN_STARTED","threadId":"t_happy","runId":"r_happy"}}
{"kind":"event","connId":"c1","seq":2,"tMs":40,"event":{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}}
{"kind":"event","connId":"c1","seq":3,"tMs":55,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"The weather in Paris"}}
{"kind":"event","connId":"c1","seq":4,"tMs":70,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":" is sunny and 24"}}
{"kind":"event","connId":"c1","seq":5,"tMs":85,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":" degrees.\nEnjoy!"}}
{"kind":"event","connId":"c1","seq":6,"tMs":95,"event":{"type":"TEXT_MESSAGE_END","messageId":"m_1"}}
{"kind":"event","connId":"c1","seq":7,"tMs":110,"event":{"type":"TOOL_CALL_START","toolCallId":"tc_1","toolCallName":"get_weather","parentMessageId":"m_1"}}
{"kind":"event","connId":"c1","seq":8,"tMs":125,"event":{"type":"TOOL_CALL_ARGS","toolCallId":"tc_1","delta":"{\"city\":\"Paris\","}}
{"kind":"event","connId":"c1","seq":9,"tMs":140,"event":{"type":"TOOL_CALL_ARGS","toolCallId":"tc_1","delta":"\"units\":\"metric\"}"}}
{"kind":"event","connId":"c1","seq":10,"tMs":150,"event":{"type":"TOOL_CALL_END","toolCallId":"tc_1"}}
{"kind":"event","connId":"c1","seq":11,"tMs":320,"event":{"type":"TOOL_CALL_RESULT","messageId":"m_2","toolCallId":"tc_1","role":"tool","content":"{\"tempC\":24,\"summary\":\"Sunny\"}"}}
{"kind":"event","connId":"c1","seq":12,"tMs":340,"event":{"type":"STATE_SNAPSHOT","snapshot":{"counter":1,"lastCity":"Paris","notes":["first note"]}}}
{"kind":"event","connId":"c1","seq":13,"tMs":360,"event":{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/counter","value":2},{"op":"add","path":"/notes/-","value":"second note"}]}}
{"kind":"event","connId":"c1","seq":14,"tMs":380,"event":{"type":"RUN_FINISHED","threadId":"t_happy","runId":"r_happy"}}
```

`src/test/fixtures/malformed.agui.jsonl`:

```
{"kind":"header","schemaVersion":1,"tool":"ag-ui-devtools@0.1.0","capturedAt":"2026-08-13T10:05:00.000Z","url":"http://localhost:3000/","framework":"react/copilotkit","transport":"sse","redacted":[]}
{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/api/copilotkit/agent/default/run","input":{"threadId":"t_bad","runId":"r_bad","state":{"counter":0},"messages":[{"id":"m_user_1","role":"user","content":"Check my profile."}],"tools":[],"context":[],"forwardedProps":{}}}
{"kind":"event","connId":"c1","seq":1,"tMs":10,"event":{"type":"RUN_STARTED","threadId":"t_bad","runId":"r_bad"}}
{"kind":"event","connId":"c1","seq":2,"tMs":20,"event":{"type":"STEP_STARTED","stepName":"analyze"}}
{"kind":"event","connId":"c1","seq":3,"tMs":30,"event":{"type":"TEXT_MESSAGE_START","messageId":"m_1","role":"assistant"}}
{"kind":"event","connId":"c1","seq":4,"tMs":45,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":"Let me check that"}}
{"kind":"event","connId":"c1","seq":5,"tMs":60,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":""}}
{"kind":"event","connId":"c1","seq":6,"tMs":75,"event":{"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1","delta":" for you."}}
{"kind":"event","connId":"c1","seq":7,"tMs":90,"event":{"type":"TEXT_MESSAGE_END","messageId":"m_1"}}
{"kind":"event","connId":"c1","seq":8,"tMs":100,"event":{"type":"STATE_SNAPSHOT","snapshot":{"counter":1,"profile":{"name":"Ada"}}}}
{"kind":"event","connId":"c1","seq":9,"tMs":115,"event":{"type":"STATE_DELTA","delta":[{"op":"add","path":"/missing/child","value":42}]}}
{"kind":"event","connId":"c1","seq":10,"tMs":130,"event":{"type":"STEP_FINISHED","stepName":"analyze"}}
```

`src/test/fixtures/chunked-run.agui.jsonl`:

```
{"kind":"header","schemaVersion":1,"tool":"ag-ui-devtools@0.1.0","capturedAt":"2026-08-13T10:10:00.000Z","url":"http://localhost:3000/","framework":"react/copilotkit","transport":"sse","redacted":[]}
{"kind":"request","connId":"c1","tMs":0,"method":"POST","url":"/api/copilotkit/agent/default/run","input":{"threadId":"t_chunk","runId":"r_chunk","state":{},"messages":[{"id":"m_user_1","role":"user","content":"Search the docs."}],"tools":[],"context":[],"forwardedProps":{}}}
{"kind":"event","connId":"c1","seq":1,"tMs":10,"event":{"type":"RUN_STARTED","threadId":"t_chunk","runId":"r_chunk"}}
{"kind":"event","connId":"c1","seq":2,"tMs":25,"event":{"type":"TEXT_MESSAGE_CHUNK","messageId":"m_1","role":"assistant","delta":"Hello"}}
{"kind":"event","connId":"c1","seq":3,"tMs":40,"event":{"type":"TEXT_MESSAGE_CHUNK","delta":", world"}}
{"kind":"event","connId":"c1","seq":4,"tMs":55,"event":{"type":"TEXT_MESSAGE_CHUNK","delta":"!"}}
{"kind":"event","connId":"c1","seq":5,"tMs":70,"event":{"type":"TOOL_CALL_CHUNK","toolCallId":"tc_1","toolCallName":"search_docs","parentMessageId":"m_1","delta":"{\"q\":\"ag-ui\","}}
{"kind":"event","connId":"c1","seq":6,"tMs":85,"event":{"type":"TOOL_CALL_CHUNK","delta":"\"limit\":5}"}}
{"kind":"event","connId":"c1","seq":7,"tMs":100,"event":{"type":"RUN_FINISHED","threadId":"t_chunk","runId":"r_chunk"}}
```

- [ ] **Step 2: Write the failing test — Done-when #5 (three validator entries)**

```ts
// src/test/integration.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  decodeJsonl,
  encodeJsonl,
  type JsonlEvent,
  type JsonlLine,
} from '../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, redactLine } from '../core/jsonl/redact';
import { createRunBuilder, type RunBuilder } from '../core/normalizer/run-builder';
import type { AguiEvent, CaptureRecord, Run } from '../core/model/types';

function loadFixture(name: string): JsonlLine[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const { lines, errors } = decodeJsonl(text);
  expect(errors).toEqual([]);
  return lines;
}

function toRecord(line: JsonlEvent): CaptureRecord {
  return {
    seq: line.seq,
    tMs: line.tMs,
    connId: line.connId,
    raw: line.event,
    event: line.event as AguiEvent,
    issues: [],
  };
}

/** Replays a decoded stream exactly as the panel does, closing every connection at the end. */
function buildFrom(lines: JsonlLine[]): RunBuilder {
  const builder = createRunBuilder();
  const lastTMsByConn = new Map<string, number>();

  for (const line of lines) {
    if (line.kind === 'request') {
      builder.addRequest(line.connId, line.method, line.url, line.input);
      lastTMsByConn.set(line.connId, line.tMs);
    } else if (line.kind === 'event') {
      builder.addRecord(toRecord(line));
      lastTMsByConn.set(line.connId, line.tMs);
    }
  }

  for (const [connId, tMs] of lastTMsByConn) builder.closeConnection(connId, tMs);
  return builder;
}

describe('Done-when #5: a malformed stream produces exactly three validator entries', () => {
  it('flags the empty delta, the failed patch and the missing terminal event', () => {
    const builder = buildFrom(loadFixture('malformed.agui.jsonl'));

    const issues = builder.allIssues();

    expect(issues).toHaveLength(3);
    expect(
      [...issues].sort((a, b) => a.seq - b.seq).map((issue) => [issue.code, issue.seq]),
    ).toEqual([
      ['empty-text-delta', 5],
      ['state-patch-failed', 9],
      ['run-never-terminated', 10],
    ]);

    const runs = builder.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('r_bad');
    expect(runs[0].outcome).toBe('running');
    // The two clean sub-structures stay clean: the message closed, the steps balanced.
    expect(runs[0].messages.get('m_1')?.closed).toBe(true);
    expect(runs[0].steps).toEqual([
      { stepName: 'analyze', startedAtMs: 20, endedAtMs: 130, closed: true },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Falsify the fixture first, so the assertion is proven to have teeth. In
`src/test/fixtures/malformed.agui.jsonl`, temporarily change the seq-5 line's `"delta":""` to
`"delta":"x"`.

Run: `pnpm vitest run src/test/integration.test.ts`
Expected: FAIL with `AssertionError: expected [ …(2) ] to have a length of 3 but got 2`

- [ ] **Step 4: Restore the fixture and run test to verify it passes**

Restore `"delta":""` on the seq-5 line.

Run: `pnpm vitest run src/test/integration.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the failing test — Done-when #6 (export, re-import, identical)**

Append to `src/test/integration.test.ts`:

```ts
/**
 * `Run.messages` / `toolCalls` / `activities` are Maps, which `toEqual` compares by
 * identity of insertion order rather than by content in a readable way. This flattens a
 * Run into a plain, order-stable object so a mismatch prints as a readable diff.
 */
function runToPlain(run: Run): Record<string, unknown> {
  const entries = <T>(map: Map<string, T>): Array<[string, T]> =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    runId: run.runId,
    threadId: run.threadId,
    parentRunId: run.parentRunId,
    agentId: run.agentId,
    connId: run.connId,
    input: run.input,
    startedAtMs: run.startedAtMs,
    endedAtMs: run.endedAtMs,
    outcome: run.outcome,
    messages: entries(run.messages).map(([id, message]) => [
      id,
      { ...message, chunkSeqs: [...message.chunkSeqs] },
    ]),
    toolCalls: entries(run.toolCalls).map(([id, toolCall]) => [id, { ...toolCall }]),
    activities: entries(run.activities).map(([id, activity]) => [id, { ...activity }]),
    steps: run.steps.map((step) => ({ ...step })),
    stateTimeline: run.stateTimeline.map((frame) => ({
      ...frame,
      patch: frame.patch?.map((op) => ({ ...op })),
      failure: frame.failure ? { ...frame.failure } : undefined,
    })),
    metrics: {
      ...run.metrics,
      stalls: run.metrics.stalls.map((stall) => ({ ...stall })),
      toolLatencyMs: { ...run.metrics.toolLatencyMs },
      eventCountByType: { ...run.metrics.eventCountByType },
    },
    issues: run.issues.map((issue) => ({ ...issue })),
    recordSeqs: [...run.recordSeqs],
  };
}

describe('Done-when #6: export a run, re-import it, tabs are identical', () => {
  it('rebuilds an identical run model from an encode/decode round trip', () => {
    const lines = loadFixture('happy-run.agui.jsonl');
    const original = buildFrom(lines).runs();

    const roundTripped = decodeJsonl(encodeJsonl(lines));
    expect(roundTripped.errors).toEqual([]);
    expect(roundTripped.lines).toEqual(lines);
    const reimported = buildFrom(roundTripped.lines).runs();

    expect(original).toHaveLength(1);
    expect(original[0].outcome).toBe('finished');
    expect(original[0].messages.get('m_1')?.content).toBe(
      'The weather in Paris is sunny and 24 degrees.\nEnjoy!',
    );
    expect(original[0].toolCalls.get('tc_1')?.args).toEqual({ city: 'Paris', units: 'metric' });

    expect(reimported.map(runToPlain)).toEqual(original.map(runToPlain));
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Falsify the round trip: temporarily change the re-import line to
`const roundTripped = decodeJsonl(encodeJsonl(lines.slice(0, -1)));` so the `RUN_FINISHED` record
is dropped before re-decoding. Also comment out the `expect(roundTripped.lines).toEqual(lines);`
line so the failure lands on the model comparison being verified here.

Run: `pnpm vitest run src/test/integration.test.ts`
Expected: FAIL with `AssertionError: expected [ { …, outcome: 'running', … } ] to deeply equal [ { …, outcome: 'finished', … } ]`

- [ ] **Step 7: Restore and run test to verify it passes**

Restore `encodeJsonl(lines)` and the un-commented `toEqual(lines)` assertion.

Run: `pnpm vitest run src/test/integration.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Write the failing test — Done-when #7 (redacted export still validates and renders)**

Append to `src/test/integration.test.ts`:

```ts
describe('Done-when #7: a redacted export leaks no text and still builds', () => {
  const SECRETS = [
    'What is the weather',
    'The weather in Paris',
    ' is sunny and 24',
    'Enjoy!',
    'Paris',
    'metric',
    'tempC',
    'Sunny',
    'first note',
    'second note',
  ];

  it('contains no original message text anywhere in the serialized output', () => {
    const lines = loadFixture('happy-run.agui.jsonl');

    const redacted = lines.map((line) => redactLine(line, [...ALL_REDACTION_GROUPS]));
    const out = encodeJsonl(redacted);

    for (const secret of SECRETS) {
      expect(out).not.toContain(secret);
    }
    // Sizes survive: "The weather in Paris" is 20 characters.
    expect(out).toContain('«redacted: 20 chars»');
    // Structure survives: types, ids, ordering and timings are untouched.
    expect(out).toContain('"type":"TEXT_MESSAGE_CONTENT","messageId":"m_1"');
    expect(out).toContain('"seq":13,"tMs":360');
    expect(out).toContain('"op":"replace","path":"/counter"');
    expect(out).toContain('"toolCallName":"get_weather"');
    // The originals are untouched — redactLine copies.
    expect(encodeJsonl(lines)).toContain('The weather in Paris');
  });

  it('still builds the same run structure from the redacted stream', () => {
    const lines = loadFixture('happy-run.agui.jsonl');
    const redacted = lines.map((line) => redactLine(line, [...ALL_REDACTION_GROUPS]));

    const originalRuns = buildFrom(lines).runs();
    const originalIssues = buildFrom(lines).allIssues();
    const redactedBuilder = buildFrom(redacted);
    const redactedRuns = redactedBuilder.runs();
    const redactedIssues = redactedBuilder.allIssues();

    expect(redactedRuns).toHaveLength(originalRuns.length);
    expect(redactedRuns[0].runId).toBe(originalRuns[0].runId);
    expect(redactedRuns[0].threadId).toBe(originalRuns[0].threadId);
    expect(redactedRuns[0].outcome).toBe(originalRuns[0].outcome);
    expect([...redactedRuns[0].messages.keys()]).toEqual([...originalRuns[0].messages.keys()]);
    expect([...redactedRuns[0].toolCalls.keys()]).toEqual([...originalRuns[0].toolCalls.keys()]);
    expect(redactedRuns[0].recordSeqs).toEqual(originalRuns[0].recordSeqs);
    expect(redactedRuns[0].steps).toEqual(originalRuns[0].steps);
    expect(redactedRuns[0].stateTimeline.map((frame) => [frame.seq, frame.kind, frame.failure]))
      .toEqual(originalRuns[0].stateTimeline.map((frame) => [frame.seq, frame.kind, frame.failure]));

    // The redacted stream is still valid, with exactly one unavoidable extra finding:
    // redacted tool-call args are by construction no longer parseable JSON.
    const key = (issues: typeof originalIssues) =>
      issues.map((issue) => `${issue.code}@${issue.seq}`).sort();
    expect(key(redactedIssues).filter((k) => !k.startsWith('tool-args-not-json@'))).toEqual(
      key(originalIssues),
    );
    expect(key(redactedIssues).filter((k) => k.startsWith('tool-args-not-json@'))).toEqual([
      'tool-args-not-json@10',
    ]);
  });
});
```

- [ ] **Step 9: Run test to verify it fails**

Falsify the redaction: temporarily change the first test's groups to `['reasoning']` (a group the
happy-run fixture does not exercise).

Run: `pnpm vitest run src/test/integration.test.ts`
Expected: FAIL with `AssertionError: expected '{"kind":"header"…The weather in Paris…' not to contain 'What is the weather'`

- [ ] **Step 10: Restore and run test to verify it passes**

Restore `[...ALL_REDACTION_GROUPS]`.

Run: `pnpm vitest run src/test/integration.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 11: Commit**

`git commit -m "test(devtools): golden fixtures and end-to-end coverage for done-when 5-7"`

---

### Task 17: Non-core surface stubs — build a loadable unpacked extension

The capture layer (requirements §5) is deliberately **out of scope** for this pass. Every file below
is a real, type-checking module with the correct entry-point shape and a comment naming the
requirements section it will eventually implement. Nothing patches a page API, and nothing buffers
events yet.

**Files:**
- Create: `packages/devtools/src/inject/index.ts`
- Create: `packages/devtools/src/relay/relay.ts`
- Create: `packages/devtools/src/sw/index.ts`
- Create: `packages/devtools/src/panel/devtools.ts`
- Create: `packages/devtools/src/panel/panel.tsx`
- Reference only (created in Task 2): `packages/devtools/src/panel/devtools.html`,
  `packages/devtools/src/panel/panel.html`, `packages/devtools/manifest.config.ts`,
  `packages/devtools/vite.config.ts`

All `src/` paths in this task are relative to `packages/devtools/`. Commands are run from the repo
root unless the command itself begins with `cd packages/devtools`.

---

- [ ] **Step 1: Preflight — confirm Task 2 delivered the prerequisites these stubs depend on**

Run:

```bash
cd packages/devtools && \
  node -e "const p=require('./package.json'); const d={...p.dependencies,...p.devDependencies}; for (const k of ['preact','@types/chrome']) { if(!d[k]) { console.error('MISSING dependency: '+k); process.exit(1);} } console.log('deps ok');" && \
  grep -n 'jsxImportSource' tsconfig.json && \
  ls src/panel/devtools.html src/panel/panel.html
```

Expected:

```
deps ok
    "jsxImportSource": "preact",
src/panel/devtools.html
src/panel/panel.html
```

(The `jsxImportSource` line number will vary; the value must be `"preact"`. If any of these is
missing, fix Task 2 before continuing — these stubs will not typecheck otherwise.)

---

- [ ] **Step 2: Create the MAIN-world entry stub**

Create `packages/devtools/src/inject/index.ts`:

```ts
/**
 * MAIN-world entry point, injected at `document_start` (requirements §12 manifest).
 *
 * STUB. The capture layer — requirements §5 (`inject.js`): §5.1 fetch `tee()`, §5.2
 * XMLHttpRequest `readyState === 3` slicing, §5.3 EventSource, §5.4 SSE framing via
 * `core/sse/parser`, §5.5 `performance.now()` frame timestamps — is NOT implemented in this
 * milestone. No page API is patched here, so on this build the extension cannot alter page
 * behaviour on any code path.
 *
 * When §5 lands, this module must hold original references to `fetch`, `XMLHttpRequest`, and
 * `EventSource` before patching, preserve original behaviour on every path including errors,
 * never evaluate page data, and post only tagged, same-origin messages to the relay
 * (requirements §11).
 */

export interface AguiDevtoolsMarker {
  /** Extension version, so a page-side hook can reason about capability. */
  version: string;
}

declare global {
  interface Window {
    __AGUI_DEVTOOLS__?: AguiDevtoolsMarker;
  }
}

const MARKER_VERSION = '0.1.0';

/**
 * Install the presence marker. Guarded because the manifest injects into all frames and a
 * page can be re-injected (bfcache restore, `chrome.scripting.registerContentScripts` after
 * an origin is granted at runtime per requirements §12).
 */
function installMarker(): void {
  if (window.__AGUI_DEVTOOLS__) {
    return;
  }
  window.__AGUI_DEVTOOLS__ = { version: MARKER_VERSION };
}

installMarker();
```

---

- [ ] **Step 3: Create the ISOLATED-world relay stub**

Create `packages/devtools/src/relay/relay.ts`:

```ts
/**
 * ISOLATED-world content script — the `window.postMessage` → `chrome.runtime` relay leg of
 * requirements §3 (Architecture).
 *
 * STUB. The tag check, the same-origin check, and the `event.source === window` check are live
 * now, so this stub is never a wider surface than the finished relay (requirements §11:
 * "Messages crossing the postMessage boundary are tagged, origin-checked, and shape-validated
 * on the receiving side"). Everything that passes those checks is currently dropped: there is
 * no `chrome.runtime.connect` port to the service worker until the capture layer lands.
 */

const MESSAGE_SOURCE = 'agui-dt';

interface TaggedMessage {
  source: typeof MESSAGE_SOURCE;
  [key: string]: unknown;
}

function isTaggedMessage(data: unknown): data is TaggedMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === MESSAGE_SOURCE
  );
}

window.addEventListener('message', (event: MessageEvent): void => {
  // Only accept messages this frame posted to itself — not from an embedded iframe or opener.
  if (event.source !== window) {
    return;
  }
  // Requirements §11: origin-checked. `window.location.origin` is the injected page's own
  // origin; a MAIN-world post from this frame always matches it.
  if (event.origin !== window.location.origin) {
    return;
  }
  if (!isTaggedMessage(event.data)) {
    return;
  }
  // Dropped. Forwarding over a `chrome.runtime` port arrives with the capture layer.
});

export {};
```

---

- [ ] **Step 4: Create the MV3 service worker stub**

Create `packages/devtools/src/sw/index.ts`:

```ts
/**
 * MV3 service worker — the port hub of requirements §3 (Architecture).
 *
 * STUB. The per-tab ring buffer (default 5k events / 8 MB, oldest dropped), the replay for a
 * panel opened late, and the `chrome.storage.session` mirror are NOT implemented here yet.
 *
 * That mirror is the mitigation for requirements §15 risk row 1 — "MV3 service worker
 * terminates at ~30 s idle, losing the buffer" — whose other half is exactly what this stub
 * does do: accept the panel's port and hold it open, because an open port keeps the worker
 * alive and is what a restored buffer would be replayed over.
 */

/** Port name the DevTools panel connects with. Must match the panel side verbatim. */
const PANEL_PORT_NAME = 'agui-devtools-panel';

/** Open panel ports, held so the worker stays alive while a panel is watching. */
const panelPorts = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port): void => {
  if (port.name !== PANEL_PORT_NAME) {
    return;
  }
  panelPorts.add(port);
  port.onDisconnect.addListener((): void => {
    panelPorts.delete(port);
  });
  // No buffered records to replay in this milestone.
});

export {};
```

---

- [ ] **Step 5: Create the DevTools page entry**

Create `packages/devtools/src/panel/devtools.ts`:

```ts
/**
 * DevTools page script. Registers the single panel surface (decision D5: DevTools panel only).
 * Loaded by `devtools.html`, which the manifest names as `devtools_page` (requirements §12).
 */

const PANEL_TITLE = 'AG-UI';
const PANEL_ICON = '';
const PANEL_PAGE = 'panel.html';

/**
 * `chrome.devtools.panels.create` resolves its page argument against the extension root, while
 * the bundler may emit these two HTML files under a subdirectory. Resolving `panel.html` as a
 * sibling of this page yields the correct extension-root-relative path either way.
 */
const panelPagePath = new URL(PANEL_PAGE, location.href).pathname.replace(/^\//, '');

chrome.devtools.panels.create(PANEL_TITLE, PANEL_ICON, panelPagePath);

export {};
```

---

- [ ] **Step 6: Create the Preact panel root**

Create `packages/devtools/src/panel/panel.tsx`:

```tsx
/**
 * Panel UI root.
 *
 * STUB. The five tabs of requirements §9 (Timeline, Session, Messages, State, Issues) and the
 * normalizer → run model → validator pipeline they render arrive with the capture layer. This
 * milestone renders the empty state only, which is Done-when #2 of the design doc §7: "a
 * `dist/` that loads unpacked in Chrome and opens an (empty) AG-UI DevTools panel without
 * console errors".
 */
import { render } from 'preact';

const PANEL_NAME = 'AG-UI DevTools';
const EMPTY_STATE = 'No capture yet — the capture layer lands in the next milestone.';

function App() {
  const version = chrome.runtime.getManifest().version;
  return (
    <main class="agui-panel agui-panel--empty">
      <h1 class="agui-panel__title">{PANEL_NAME}</h1>
      <p class="agui-panel__version">v{version}</p>
      <p class="agui-panel__empty-state">{EMPTY_STATE}</p>
    </main>
  );
}

const mountPoint = document.getElementById('root') ?? document.body;
render(<App />, mountPoint);
```

---

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`

Expected: exit status 0. `tsc --noEmit` prints no diagnostics; the only output is pnpm's script
banner lines. Confirm with `echo $?` → `0`.

---

- [ ] **Step 8: Lint**

Run: `pnpm lint`

Expected: exit status 0, no ESLint errors or warnings printed. In particular the
`no-restricted-globals` rule scoped to `src/core/**` does not fire, because none of the files added
in this task live under `src/core/`.

---

- [ ] **Step 9: Build**

Run: `pnpm build`

Expected: exit status 0; Vite prints a `dist/` asset list ending in `✓ built in <n>ms`. Confirm the
five expected outputs exist:

Run: `ls packages/devtools/dist/manifest.json packages/devtools/dist/service-worker-loader.js 2>/dev/null; find packages/devtools/dist -name '*.html' | sort`

Expected: `dist/manifest.json` exists, and the `find` prints exactly two HTML files — the emitted
`devtools.html` and `panel.html` (path prefix depends on the bundler's output layout; both must be
siblings of each other, which is what Step 5 relies on).

---

- [ ] **Step 10: Prove the `core/` boundary held — source level**

Run: `! grep -rn --include='*.ts' --include='*.tsx' -e 'chrome\.' packages/devtools/src/core`

Expected: no output, exit status 0. (`grep` finds nothing and exits 1; the leading `!` inverts that
to 0. If any match prints, the boundary is broken and the build must not ship.)

---

- [ ] **Step 11: Prove the `core/` boundary held — built output**

Compile `core/` on its own and grep the emitted JavaScript. This is the "no `chrome.` reference
survives into `core/`'s build output" assertion from design doc §3, run against real emitted code
rather than sources.

Run:

```bash
cd packages/devtools && \
  rm -rf .core-build && \
  pnpm exec tsc $(find src/core -name '*.ts' ! -name '*.test.ts') \
    --target es2022 --module esnext --moduleResolution bundler \
    --skipLibCheck --outDir .core-build && \
  ! grep -rn 'chrome\.' .core-build && \
  echo "core boundary OK" && \
  rm -rf .core-build
```

Expected:

```
core boundary OK
```

Exit status 0, and no `.core-build` directory left behind.

---

- [ ] **Step 12: Prove the requirements §11 privacy guarantees in the emitted manifest**

Run:

```bash
cd packages/devtools && node -e "
const m = require('./dist/manifest.json');
const perms = m.permissions || [];
const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
if (perms.includes('debugger')) fail('debugger permission present');
if (perms.includes('webRequest')) fail('webRequest permission present');
if (perms.includes('webRequestBlocking')) fail('webRequestBlocking permission present');
if ('host_permissions' in m) fail('static host_permissions present: ' + JSON.stringify(m.host_permissions));
const matches = (m.content_scripts || []).flatMap((cs) => cs.matches || []);
if (matches.length === 0) fail('no content_scripts declared');
const allowed = ['http://localhost/*', 'http://127.0.0.1/*', 'http://0.0.0.0/*'];
const stray = matches.filter((p) => !allowed.includes(p));
if (stray.length) fail('content script matches beyond the localhost family: ' + stray.join(', '));
if (!Array.isArray(m.optional_host_permissions)) fail('optional_host_permissions missing');
console.log('manifest privacy invariants OK');
"
```

Expected:

```
manifest privacy invariants OK
```

Exit status 0. This is requirements §11 ("No egress. No `host_permissions` for any remote origin")
and §12 ("No `debugger`, no `webRequest`, no broad static host permissions") made testable —
non-localhost origins may only be added at runtime through
`chrome.scripting.registerContentScripts` after the user grants them (D3).

---

- [ ] **Step 13: Manual — load unpacked and confirm the panel**

Run: (manual, in Chrome)

1. Open `chrome://extensions`.
2. Turn **Developer mode** on (top-right toggle).
3. Click **Load unpacked** and select `packages/devtools/dist` (the absolute path printed by
   `cd packages/devtools && pwd` plus `/dist`).
4. Confirm the extension card reads **AG-UI DevTools 0.1.0** with **no** "Errors" button.
5. Click **service worker** on the card to open the worker's console.
6. Open any page (e.g. `http://localhost:3000`, or any `http://localhost` page you have), then
   open Chrome DevTools (⌥⌘I on macOS).
7. Look at the DevTools tab strip; click the overflow (`»`) if needed.

Expected:

- A DevTools tab titled **AG-UI** is present.
- Selecting it shows: the heading `AG-UI DevTools`, the line `v0.1.0`, and the line
  `No capture yet — the capture layer lands in the next milestone.`
- The extension card shows no "Errors" button.
- The service worker console is empty of errors.
- Right-click the panel → **Inspect** (DevTools-on-DevTools): its Console is empty of errors.
- The page's own Console is empty of extension-originated errors, and `window.__AGUI_DEVTOOLS__`
  evaluated in the page console returns `{version: '0.1.0'}`.

---

- [ ] **Step 14: Commit**

```bash
git add packages/devtools/src/inject/index.ts \
        packages/devtools/src/relay/relay.ts \
        packages/devtools/src/sw/index.ts \
        packages/devtools/src/panel/devtools.ts \
        packages/devtools/src/panel/panel.tsx
git commit -m "feat(devtools): stub inject, relay, service worker, and panel surfaces

Minimal but real entry points so \`pnpm build\` produces a dist/ that loads
unpacked and opens an empty AG-UI panel. No page APIs are patched and no
events are buffered: the capture layer (requirements §5) lands next.

Verified: no \`chrome.\` reference in core/ sources or core/ build output, and
the emitted manifest carries no debugger permission, no webRequest, and no
static host_permissions (requirements §11)."
```

---

### Task 18: Release plumbing and documentation

**Files:**
- Create: `.github/workflows/ci.yml` (repo root)
- Create: `packages/devtools/scripts/package.ts`
- Create: `README.md` (repo root)
- Modify: `package.json` (repo root — add the `package` script)
- Modify: `packages/devtools/package.json` (add the `package` script)

Action versions below were checked against their repositories on 2026-08-13:
`actions/checkout@v7` (v7.0.1), `actions/setup-node@v7` (v7.0.0), `pnpm/action-setup@v6` (v6.0.10),
`softprops/action-gh-release@v3` (v3.0.2).

---

- [ ] **Step 1: Create the CI workflow**

Create `.github/workflows/ci.yml` (repo root):

```yaml
name: CI

on:
  push:
    branches: ['**']
    tags: ['v*']
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    name: typecheck, lint, test, build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      # No `version:` input on purpose. pnpm/action-setup reads the pnpm version from the
      # root package.json `packageManager` field (pinned to pnpm 10 by Task 2), and it fails
      # with "Multiple versions of pnpm specified" if a `version:` input disagrees with it.
      - name: Install pnpm
        uses: pnpm/action-setup@v6

      - name: Install Node
        uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Lint
        run: pnpm lint

      - name: Test
        run: pnpm test

      - name: Build
        run: pnpm build

  release:
    name: package and attach to release
    needs: verify
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Install pnpm
        uses: pnpm/action-setup@v6

      - name: Install Node
        uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Package
        run: pnpm package

      # Chrome Web Store upload stays manual (decision D8): the first submission has to be
      # manual anyway, and it keeps CWS API credentials out of the repo.
      - name: Attach zip to the GitHub release
        uses: softprops/action-gh-release@v3
        with:
          files: packages/devtools/ag-ui-devtools-*.zip
          fail_on_unmatched_files: true
          generate_release_notes: true
```

---

- [ ] **Step 2: Create the packaging script**

Create `packages/devtools/scripts/package.ts`:

```ts
/**
 * Build the Chrome Web Store upload archive from `dist/`.
 *
 * Dependency choice: this shells out to the platform `zip` CLI instead of adding `archiver`
 * as a devDependency, because the whole script is forty lines, `zip` is preinstalled on
 * macOS, on Debian/Ubuntu, and on GitHub's `ubuntu-latest` runner image, and this repo's
 * posture (design doc §1 D9) is to add zero packages for a chore this small — the one cost,
 * a missing `zip` on bare Windows, is handled with an explicit error below.
 *
 * The version is read from package.json at run time, so the archive name tracks the manifest
 * version automatically and never has to be edited here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name: string;
  version: string;
}

const packageRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir: string = join(packageRoot, 'dist');

function readManifest(): PackageManifest {
  const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as Partial<PackageManifest>;
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('packages/devtools/package.json needs a string "name" and "version".');
  }
  return { name: parsed.name, version: parsed.version };
}

function assertZipAvailable(): void {
  const probe = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(
      'The `zip` CLI is required to build the extension archive and was not found on PATH.\n' +
        '  macOS: preinstalled — check your PATH.\n' +
        '  Debian/Ubuntu: sudo apt-get install -y zip\n' +
        '  Windows: run this from WSL or Git Bash.\n' +
        'Then re-run `pnpm package`.',
    );
  }
}

function main(): void {
  if (!existsSync(distDir)) {
    throw new Error(`No build output at ${distDir}. Run \`pnpm build\` first.`);
  }
  assertZipAvailable();

  const { name, version } = readManifest();
  const zipPath = join(packageRoot, `${name}-${version}.zip`);
  // `zip` updates an existing archive in place rather than replacing it, which would leave
  // files from a previous build inside. Start clean.
  rmSync(zipPath, { force: true });

  // -r recurse, -q quiet, -X drop platform extra-attribute blocks so the archive is stable
  // across machines. cwd is dist/ and the target is '.', so manifest.json lands at the zip
  // root — Chrome rejects an archive with the manifest nested in a directory.
  const result = spawnSync('zip', ['-r', '-q', '-X', zipPath, '.'], {
    cwd: distDir,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`zip exited with status ${String(result.status)}`);
  }

  console.log(`Packaged ${zipPath}`);
}

main();
```

---

- [ ] **Step 3: Wire the `package` script in both package.json files**

The script is run through Node's type stripping rather than a TS runner, so it needs no extra
dependency. **RESOLVED AT ASSEMBLY:** this section originally invoked the script through Node 22's
`--experimental-strip-types`. The plan standardizes every `.ts` script entry point on `tsx`
(a devDependency added in Task 2), so no build-critical command depends on an experimental flag.

Run:

```bash
cd packages/devtools && npm pkg set scripts.package="tsx scripts/package.ts"
```

Then, from the repo root:

Run:

```bash
npm pkg set scripts.package="pnpm --filter ag-ui-devtools package"
```

Expected: both commands print nothing and exit 0. Verify:

Run: `node -e "console.log(require('./package.json').scripts.package)" && node -e "console.log(require('./packages/devtools/package.json').scripts.package)"`

Expected:

```
pnpm --filter ag-ui-devtools package
tsx scripts/package.ts
```

---

- [ ] **Step 4: Create the README**

Create `README.md` (repo root):

````markdown
# AG-UI DevTools

A Chrome DevTools extension that captures, decodes, validates, and replays
[AG-UI](https://github.com/ag-ui-protocol/ag-ui) event streams from any page — no SDK, no code
change, no license key.

AG-UI is an event protocol over SSE. When a run misbehaves, the network tab shows you an opaque
`text/event-stream` and `console.log` shows you what the app *thinks* happened. This tool shows you
the wire: every event in order, grouped into runs, with the protocol violations named and located.

## Status

**Pre-release.** The `core/` layer — event table, SSE parser, AG-UI detection, chunk expansion, run
model, validator rules, metrics, JSON Patch state timeline, and the `.agui.jsonl` codec with
redaction — is implemented and unit-tested. The capture layer (`inject/`, `relay/`, `sw/`) and the
panel tabs are stubs: the extension builds, loads unpacked, and opens an empty **AG-UI** panel. It
does not capture anything yet. That lands in the next milestone.

## Privacy

The tool sits on the wire where prompts and completions flow, so its posture is non-negotiable:

- **No egress.** No `host_permissions` for any remote origin, no fetch from the service worker or
  the panel, no telemetry, no update pings, no crash reporting. Verifiable by reading
  `dist/manifest.json`: no `debugger` permission, no `webRequest`, no static host permissions —
  only `optional_host_permissions`, which the user grants per origin.
- **Opt-in per origin.** The extension ships inert. `localhost`, `127.0.0.1`, and `0.0.0.0` are
  auto-enabled; any other origin takes one click and a reload, and is registered at runtime via
  `chrome.scripting.registerContentScripts`.
- **No persistence by default.** Capture lives in memory with a `chrome.storage.session` mirror
  that Chrome clears on browser close. Nothing touches disk unless you export.
- **Headers are never captured** except `content-type`. `Authorization` and cookies are never read,
  never stored, never exported.
- **Redaction on export**, on by default for bug-report bundles: text deltas, reasoning content,
  tool arguments, tool results, and state values become `«redacted: 412 chars»`. Structure, types,
  ordering, sizes, and timings survive — which is what a protocol bug report actually needs. The
  export header records exactly what was redacted.
- **Bounded memory.** Ring buffer caps at a configurable default of 5k events / 8 MB, oldest
  dropped.

## Development

Requires Node 22+ and pnpm 10.

```bash
pnpm install          # install workspace dependencies
pnpm dev              # watch build for load-unpacked development
pnpm build            # production build → packages/devtools/dist/
pnpm test             # Vitest, node environment
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
pnpm package          # → packages/devtools/ag-ui-devtools-<version>.zip
pnpm gen:events       # regenerate the AG-UI event table from @ag-ui/core
```

### Load unpacked

1. `pnpm build`
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → select `packages/devtools/dist`.
4. Open DevTools on any `http://localhost` page; the **AG-UI** panel is in the tab strip (behind
   the `»` overflow if the strip is full).

### Tests

```bash
pnpm test             # run once
pnpm test --watch     # watch mode
```

Tests live next to their sources as `*.test.ts` and run under Node — `src/core/` contains no Chrome
APIs, which is enforced by an ESLint rule and by a check that no `chrome.` reference survives into
`core/`'s build output. That boundary is also what lets `core/` be lifted into a CLI or a VS Code
panel later.

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

CI runs typecheck, lint, test, and build on every push and pull request. Pushing a `v*` tag runs the
same checks and attaches `ag-ui-devtools-<version>.zip` to a GitHub release. Chrome Web Store upload
is manual.

## License

MIT. See [LICENSE](./LICENSE).

## Credits

Built and maintained by the [Threadplane](https://threadplane.com) team. The tool is deliberately
framework-neutral: it works against any AG-UI stream — CopilotKit, the AG-UI Dojo, a hand-rolled
server — and requires nothing from Threadplane.
````

---

- [ ] **Step 5: Verify the pnpm pin the workflow depends on**

Run: `node -e "const v=require('./package.json').packageManager||''; if(!/^pnpm@10\./.test(v)){console.error('FAIL: root packageManager is '+JSON.stringify(v)+', expected pnpm@10.x');process.exit(1);} console.log('pinned: '+v);"`

Expected:

```
pinned: pnpm@10.34.5
```

(Any `pnpm@10.x.y` passes. `pnpm/action-setup@v6` reads this field; if it is absent or not a pnpm 10
pin, fix it in the root `package.json` before merging, or CI will install the wrong pnpm.)

---

- [ ] **Step 6: Verify the workflow file parses**

Run: `node -e "const {readFileSync}=require('fs'); const t=readFileSync('.github/workflows/ci.yml','utf8'); if(!/actions\/checkout@v7/.test(t)||!/pnpm\/action-setup@v6/.test(t)||!/actions\/setup-node@v7/.test(t)||!/softprops\/action-gh-release@v3/.test(t)){console.error('FAIL: pinned action versions changed');process.exit(1);} console.log('workflow action pins ok');"`

Expected:

```
workflow action pins ok
```

If `actionlint` is installed locally, also run `actionlint .github/workflows/ci.yml` and expect no
output.

---

- [ ] **Step 7: Verify packaging end to end**

Run:

```bash
pnpm build && pnpm package && ls -l packages/devtools/ag-ui-devtools-*.zip
```

Expected: `Packaged /…/packages/devtools/ag-ui-devtools-0.1.0.zip` followed by an `ls` line showing
that file with a non-zero size.

---

- [ ] **Step 8: Verify the archive layout Chrome requires**

Run: `unzip -l packages/devtools/ag-ui-devtools-0.1.0.zip | head -20`

Expected: the listing contains a top-level `manifest.json` (no directory prefix before it) plus the
built assets. If `manifest.json` appears as `dist/manifest.json`, the archive is wrong and Chrome
will reject it.

---

- [ ] **Step 9: Verify the missing-`zip` error path is a clear message, not a stack-trace surprise**

Run: `cd packages/devtools && PATH=/nonexistent tsx scripts/package.ts; echo "exit=$?"`

Expected: the run fails with a message containing
`The \`zip\` CLI is required to build the extension archive and was not found on PATH.` and
`exit=1`.

---

- [ ] **Step 10: Confirm the full clean-checkout gate still passes**

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: exit status 0 at every stage — this is design doc §7 Done-when #1, and it is exactly what
the `verify` job in CI runs.

---

- [ ] **Step 11: Commit**

```bash
git add .github/workflows/ci.yml README.md package.json \
        packages/devtools/package.json packages/devtools/scripts/package.ts
git commit -m "chore: CI workflow, packaging script, and README

CI runs typecheck, lint, test, and build on push and pull request; a v* tag
additionally packages dist/ and attaches the zip to a GitHub release
(decision D8 — Chrome Web Store upload stays manual).

\`pnpm package\` reads the version from package.json and shells out to the
platform zip CLI, so the archive name tracks the version and no dependency is
added. README states the requirements §11 privacy posture, current status, dev
commands, and the \`pnpm gen:events\` chore for tracking AG-UI protocol drift."
```

---
---

# Appendix A — Cross-section resolutions

Each task section above was authored against a fixed type contract, then reconciled. Where two
sections disagreed, the conflict is resolved here and the winning decision is already applied in
the task text. The individual `## Contract gaps` notes at the end of each section are preserved
as authored, except where a note is marked **RESOLVED AT ASSEMBLY**.

| # | Conflict | Resolution |
|---|---|---|
| R1 | `run-never-terminated` was emitted by **both** Task 11's `finalizeRules` and Task 13's `closeConnection` | `finalizeRules` is the sole owner of every run-end issue and derives `seq` from `run.recordSeqs`. Signature stays `finalizeRules(state, tMs)`. Task 13 keeps only the `outcome: 'aborted'` / `endedAtMs` state transition. **Left unresolved this would have produced four issues where Task 16 asserts exactly three.** |
| R2 | `REASONING_ENCRYPTED_VALUE.value` does not exist | The real field is `encryptedValue` (verified against `ReasoningEncryptedValueEventSchema`: `type`, `timestamp`, `rawEvent`, `subtype`, `entityId`, `encryptedValue`). The locked contract was wrong; Task 15's mapping, tests, and fixtures now use `encryptedValue`. Unfixed, encrypted reasoning payloads would have exported **unredacted**. |
| R3 | TypeScript runner differed across Tasks 2, 4, 18 (`--experimental-strip-types` vs `tsx`) | Standardized on `tsx` (devDependency) for every `.ts` script entry point. No build-critical command depends on an experimental Node flag. |
| R4 | Task 2's `panel.html` loaded `./main.tsx`; Task 17 creates `panel.tsx` | Standardized on `src/panel/panel.tsx`. |
| R5 | Task 2's `package` script hardcoded `0.1.0` | Placeholder in Task 2, replaced in Task 18 by `tsx scripts/package.ts`, which reads the version from `package.json`. |
| R6 | `applyPatch` reason for `replace` on a missing final key with an existing parent | `'path-not-found'`. Task 8 and Task 13 agree. |
| R7 | Task 11's rules run before or after the builder's state transition? | **Before.** Otherwise `event-after-terminal` swallows the terminal event, `unopened-message-id` never fires on `TEXT_MESSAGE_END`, and `concurrent-text-messages` fires on every START. |
| R8 | `validator/types.ts` is not in the locked contract | Added, holding `RunValidationState` + `ValidatorRule`, re-exported from `index.ts`. Avoids a rules↔index cycle and lets rule tests run before `index.ts` exists. |

## Amendments made during execution

Applied to the plan text above after a code review of the landed work, so later tasks inherit
them. Each was verified empirically before being adopted.

| # | Amendment | Why |
|---|---|---|
| A1 | Root `test` script delegates to `test:ci`, not `test`; Task 2's package defines both | `pnpm -r test` exits **0 with no output** when no package defines `test` — pnpm special-cases lifecycle script names. Task 18's CI runs `pnpm test`, so the lifecycle form could report success having run zero tests across a 16-task TDD plan. Every non-lifecycle name fails loudly with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. |
| A2 | `.gitignore` gains `*.crx`, `*.pem`, `.idea/`, `*.swp` | Chrome's "Pack extension" emits a `.pem` **private signing key** beside the source tree. Committing it lets anyone forge a CRX under this extension's ID. `*.zip` was already ignored; the two security-relevant artifacts were not. |
| A3 | `tsconfig.base.json` `lib` raised to `ES2023` (`target` stays `ES2022`) | Chrome MV3 and Node 22 both support ES2023 built-ins. Task 9 and Task 12 use `findLast` and `toSorted`, which are hard `TS2550` errors under an ES2022 lib. A higher `lib` than `target` is the intended pattern. |
| A4 | Root `package.json` gains `pnpm.onlyBuiltDependencies: ["esbuild"]` | pnpm 10 blocks dependency postinstall scripts by default; without this every install and CI run prints an "Ignored build scripts: esbuild" warning, training people to scroll past a supply-chain notice. |
| A5 | Task 2's `no-restricted-globals` on `src/core/**` also bans `document`, `window`, `localStorage` — not just `chrome` | `lib` must include DOM for the Preact panel, and TypeScript cannot scope `lib` per directory, so DOM globals typecheck inside `core/` despite `core/` being required to run under Node in Vitest. ESLint is the only enforcement point. `localStorage` additionally violates requirements §11's no-persistence guarantee. |
| A6 | The relay content script is `src/relay/relay.ts`, **not** `src/relay/index.ts` | **Build blocker.** CRXJS 2.7.1 keys emitted content scripts by `basename(file)` in build mode, so `src/inject/index.ts` and `src/relay/index.ts` both become `index.ts`, collide, and `pnpm build` dies with `Content script fileName is undefined`. Reproduced in isolation: same basenames fail on Vite 8, distinct basenames succeed, Vite 7 works either way. `pnpm dev` is unaffected, so this would only have surfaced at Task 17. The two content-script basenames must stay distinct. |
| A7 | `vite.config.ts` names `src/panel/panel.html` as an explicit `rollupOptions.input` | **Build blocker.** CRXJS only collects HTML reachable from manifest keys (`devtools_page`, `action.default_popup`, `options_page`, …). `panel.html` is opened at runtime by `chrome.devtools.panels.create`, so nothing referenced it as an input and it was never emitted into `dist/` — the panel would have 404'd. Task 17's `devtools.ts` resolves it as a sibling of `devtools.html`, which is correct under the resulting layout. |
| A8 | `vite.config.ts` sourcemaps are mode-conditional (`sourcemap: mode !== 'production'`) | Task 18 zips all of `dist/`, so an unconditional `sourcemap: true` would publish full TypeScript source to the Chrome Web Store and roughly double the archive. |
| A9 | Task 2's core boundary also bans `self`, `navigator`, `fetch`, `sessionStorage`, `location`; adds `no-restricted-imports` against `sw`/`relay`/`inject`/`panel`; adds `no-restricted-syntax` against `globalThis.*`; and widens `files` to `*.{ts,tsx}` | `no-restricted-globals` only matches bare identifiers. Verified holes: `globalThis.chrome.runtime.id`, `(self as any).chrome`, a type-only `chrome.runtime.Port`, bare `fetch`, and — most likely in practice — a plain `import` from a Chrome-facing sibling directory. Closing these before `core/` code lands is far cheaper than after. |
| A10 | The generated event table gets a targeted rule override instead of a global `ignores` entry | A global ignore disabled *every* rule on the file. The override exempts it only from the boundary rules. |
| A11 | Vitest `include` is `src/**/*.test.{ts,tsx}` | A `.tsx` component test would otherwise be silently skipped rather than failing. |
| A12 | The `globalThis` ban is `Identifier[name='globalThis']`, not `MemberExpression[object.name='globalThis']` | The member-expression form catches `globalThis.chrome` and `globalThis['chrome']` but **not** `(globalThis as SomeType).chrome` — the cast wraps the identifier in a `TSAsExpression` and the selector stops matching. Verified all four forms; only the identifier-level ban catches every one. `core/` has no legitimate use for `globalThis`. |

> **Authoritative source note.** Amendments A5–A12 changed Task 2's config files after that task
> was committed. The inline code blocks in Task 2 above were **not** all retro-edited to match.
> Where the plan text and the committed files under `packages/devtools/` disagree, **the committed
> files are authoritative** and this amendment table explains why. Anyone replaying this plan from
> scratch should apply the amendments as they go.

Considered and deliberately **not** adopted: a `packageManager` integrity hash (pnpm/action-setup
reads the version without it), and an upper bound on the `engines.node` range.

**Further notes for Task 18**, surfaced by the Task 2 review:

- `scripts/package.ts` must `rm -f` the target archive before writing it. The `zip` CLI *updates*
  an existing archive rather than replacing it, so files deleted from `dist/` between builds
  would silently persist in the zip.
- Build the release with `mode=production` so A8's conditional sourcemaps are actually off, or
  have `scripts/package.ts` exclude `*.map` explicitly. Verify no `.map` file is in the archive.
- The built `dist/manifest.json` will contain a `web_accessible_resources` key that is **absent**
  from `manifest.config.ts` — CRXJS injects it for the MAIN-world script. Task 18's "no
  `debugger`, no `webRequest`, no static remote host permissions" audit must expect that key and
  not treat it as an unexpected addition.

**Residual caveat for Task 18.** `pnpm -r run test:ci` still exits 0 when *zero* packages match
the workspace glob (pnpm prints `No projects matched the filters`). A1 closes the
"package exists but defines no test script" hole, not the "no packages at all" one. That state
disappears once Task 2 lands `packages/devtools`, but Task 18's CI should assert the test run
actually reported a scope rather than trusting a bare exit 0. Relatedly, `pnpm -r run test:ci`
errors only when *no* selected package has the script — packages lacking it alongside one that
has it are skipped silently. Harmless at one package; worth remembering if a second is added.

## Spec corrections found while planning

- **Requirements §6 says "26 types"; the real count is 33.** Verified against `@ag-ui/core@0.0.57`: 34 exports match `/(.+)EventSchema$/`, minus `BaseEventSchema`, whose `type` is a `ZodNativeEnum` rather than a `ZodLiteral`. The spec's own prose list also omits `TOOL_CALL_RESULT` and `TEXT_MESSAGE_CHUNK`. Task 4's test pins the count at 33, so a protocol bump fails loudly.
- **Four event fields are `z.any()`** — `STATE_SNAPSHOT.snapshot`, `CUSTOM.value`, `RAW.event`, `RUN_FINISHED.result` — which Zod reports as optional. `checkShape({type:'STATE_SNAPSHOT'})` therefore returns `[]`. If a snapshot with no payload should be an error, it belongs in a validator rule, not shape-check.
- **Three event fields fall through to `kind: 'unknown'`** because they are `ZodUnion`/`ZodEffects`: `role` on `TEXT_MESSAGE_START`/`TEXT_MESSAGE_CHUNK`, `subtype` on `REASONING_ENCRYPTED_VALUE`, `outcome` on `RUN_FINISHED`. They are presence-checked but not type-checked.

# Appendix B — Open items carried forward

These are known, deliberate, and **not** blockers for this pass. They need a decision before the
capture layer or the export bundle ships.

1. **Redacting `toolArgs` necessarily raises `tool-args-not-json`.** `«redacted: N chars»` is not
   valid JSON, so accumulated `TOOL_CALL_ARGS` deltas cannot parse at `TOOL_CALL_END`. Requirements
   Done-when #7 says a redacted export "still validates"; strictly identical issue counts are
   unachievable with `ALL_REDACTION_GROUPS`. Task 16 asserts the truthful form — the redacted
   stream's issue set is identical **except** for exactly one added `tool-args-not-json`. Options
   for later: exclude `toolArgs` from the bug-report profile, or have the validator read
   `JsonlHeader.redacted` and suppress that one rule on redacted imports.
2. **Nothing populates `JsonlHeader.redacted` on export.** `redactLine` deliberately leaves the
   header alone. Requirements §11's "the header records what was redacted" belongs to the export
   bundle builder, which is not in this pass.
3. **`JsonlRequest.input.state` is not redacted.** The `state` group covers snapshot and delta
   values plus input message contents, not the initial state object. A real capture would leak it.
4. **`routeHint` does not cover single-route mode** (`POST {base}` with a `{method, params, body}`
   envelope, requirements §4.2 last row) — the `RouteHint` union has no member for it. Envelope
   unwrapping belongs to the capture layer.
5. **`createConnClassifier` ignores payloads on non-SSE content types.** A server sending AG-UI JSON
   under the wrong content type is never detected. Follows the contract literally.
6. **A trailing lone `\r` at the end of a `push()` is held back** by the SSE parser, since it may be
   the first half of a CRLF split across chunks. The capture layer must always call `flush()` at
   stream end or a lone-CR-terminated final frame is lost.
7. **The `core/` boundary check in Task 17 is source-level, not bundle-level.** A grep over shipped
   `dist/` chunks cannot identify core-derived code (hashed names, minified identifiers), and in
   this stub pass nothing imports `core/` at all, so a bundle grep would be vacuous. Task 17
   instead greps `src/core/` and compiles `src/core/**` standalone with `tsc`, then greps the
   emitted JS. Revisit once the panel actually imports `core/`.

# Appendix C — Definition of done for this pass

From the design doc §7. Items 1–5 are provable here; the rest need the capture layer.

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes from a clean checkout
- [ ] `pnpm build` produces a `dist/` that loads unpacked and opens an empty "AG-UI" DevTools panel with no console errors
- [ ] `pnpm package` produces `ag-ui-devtools-0.1.0.zip`
- [ ] The `core/` suite covers every requirements §7 rule, chunk expansion, positioned state-patch failure, metrics, and JSONL round-trip including redaction
- [ ] `pnpm gen:events` regenerates `event-table.generated.ts` byte-identically against the committed file
- [ ] `dist/manifest.json` contains no `debugger`, no `webRequest`, and no static remote `host_permissions`

**Deferred to the next milestone:** requirements Done-when #1–4 and #8 (Dojo capture, CopilotKit
`/info` metadata, live text reconstruction, live tool/state inspection, non-localhost opt-in) — all
require `inject/`, `relay/`, `sw/`, and the panel tabs.
