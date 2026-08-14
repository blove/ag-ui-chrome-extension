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
      js: ['src/inject/index.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: true,
    },
    // The two content scripts MUST NOT share a basename. CRXJS 2.7.1 keys emitted
    // content scripts by basename(file) in build mode, so two files both named
    // `index.ts` collide and the build fails with "Content script fileName is
    // undefined". Keep these basenames distinct.
    {
      matches: LOCALHOST_MATCHES,
      js: ['src/relay/relay.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
      all_frames: true,
    },
  ],
});
