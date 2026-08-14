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
