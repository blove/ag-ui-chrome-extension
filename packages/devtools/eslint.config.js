import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
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
    files: ['src/core/**/*.{ts,tsx}'],
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
        {
          name: 'self',
          message: 'core/ must run under Node. Keep host globals out of core/.',
        },
        {
          name: 'navigator',
          message: 'core/ must run under Node. Keep host globals out of core/.',
        },
        {
          name: 'fetch',
          message: 'core/ must be I/O-free; pass already-read bytes in. See requirements §11 (no egress).',
        },
        {
          name: 'sessionStorage',
          message: 'core/ must not persist anything. See requirements §11.',
        },
        {
          name: 'location',
          message: 'core/ must run under Node. Keep host globals out of core/.',
        },
        // Banning `fetch` alone leaves the egress door open; these are the other ways out.
        {
          name: 'XMLHttpRequest',
          message: 'core/ must be I/O-free; pass already-read bytes in. See requirements §11 (no egress).',
        },
        {
          name: 'WebSocket',
          message: 'core/ must be I/O-free; pass already-read bytes in. See requirements §11 (no egress).',
        },
        {
          name: 'EventSource',
          message: 'core/ must be I/O-free; pass already-read bytes in. See requirements §11 (no egress).',
        },
        // Likewise, banning localStorage/sessionStorage alone leaves these persistence paths.
        {
          name: 'indexedDB',
          message: 'core/ must not persist anything. See requirements §11.',
        },
        {
          name: 'caches',
          message: 'core/ must not persist anything. See requirements §11.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/sw/**', '**/relay/**', '**/inject/**', '**/panel/**'],
              message: 'core/ must not import from Chrome-facing surfaces. Pass plain data into core/ instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Ban the identifier outright rather than `MemberExpression[object.name=...]`.
          // The member-expression form catches `globalThis.chrome` and `globalThis['chrome']`
          // but NOT `(globalThis as SomeType).chrome`, because the cast wraps the identifier
          // in a TSAsExpression and the selector no longer matches. core/ has no legitimate
          // use for globalThis, so banning every reference is both simpler and airtight.
          selector: "Identifier[name='globalThis']",
          message: 'globalThis bypasses the core/ boundary. Reference nothing host-specific from core/.',
        },
        {
          // `no-restricted-imports` registers visitors for ImportDeclaration and the two export
          // forms only — there is no ImportExpression visitor — so `await import('../../relay/x')`
          // slips past the import ban entirely. This selector closes that path.
          selector: "ImportExpression > Literal[value=/(^|\\/)(sw|relay|inject|panel)\\//]",
          message: 'core/ must not import from Chrome-facing surfaces. Pass plain data into core/ instead.',
        },
        {
          // `no-restricted-globals` is a scope-analysis rule over *value* references, so a
          // type position like `p: chrome.runtime.Port` never fires. Emits no runtime code, but
          // it lets Chrome types leak into core/'s public signatures, which breaks the
          // "liftable into a CLI" property the boundary exists to protect.
          selector: "TSQualifiedName > Identifier[name='chrome']",
          message: 'core/ must stay Chrome-free, including in type positions.',
        },
        {
          selector: "TSTypeQuery > Identifier[name='chrome']",
          message: 'core/ must stay Chrome-free, including in type positions.',
        },
      ],
    },
  },
  {
    // Machine-generated; exempt from the core/ boundary rules but still linted otherwise.
    files: ['src/core/events/event-table.generated.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-syntax': 'off' },
  },
);
