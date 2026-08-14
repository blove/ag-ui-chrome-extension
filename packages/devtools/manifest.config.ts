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
      js: ['src/relay/index.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
      all_frames: true,
    },
  ],
});
