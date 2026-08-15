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
 *
 * BOTH content-script paths below are ALSO listed in `contentScripts.standaloneFiles` in
 * `vite.config.ts`, and the two lists must not drift. Without that listing CRXJS emits a content
 * script as an async loader that dynamic-imports its real chunk, and publishes that chunk in
 * `web_accessible_resources` scoped to the matches below — i.e. to localhost. A MAIN-world script
 * runs in the PAGE's world, so on an origin granted at runtime (D3) the import is denied and
 * capture silently never starts. `scripts/verify-build.ts` fails the build if the two files drift,
 * or if the emitted scripts stop being self-contained.
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
  // Static world: 'MAIN' content scripts require Chrome 111+. On older Chrome this key is
  // silently ignored and BOTH scripts below load into ISOLATED instead — a silent failure
  // of the world-isolation design, not a loud one. Pin the floor explicitly.
  minimum_chrome_version: '111',
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
      js: ['src/inject/inject.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: true,
    },
    // NO two script entries above may share a basename — and that includes the
    // service worker, not just the two content scripts. CRXJS 2.7.1 keys emitted
    // scripts by basename(file) in build mode.
    //
    // Two content scripts both named `index.ts` collide LOUDLY: the build fails with
    // "Content script fileName is undefined". That is why this file is `relay.ts`.
    //
    // A content script colliding with the service worker fails SILENTLY, which is
    // worse: the build succeeds, but the emitted manifest points the MAIN-world
    // content script at the service worker's chunk. `chrome.runtime` is undefined in
    // MAIN world, so every localhost page throws at document_start and the inject
    // marker never installs. That is why the inject entry is `inject.ts` and not
    // `index.ts`. Keep all three basenames distinct.
    {
      matches: LOCALHOST_MATCHES,
      js: ['src/relay/relay.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
      all_frames: true,
    },
  ],
});
