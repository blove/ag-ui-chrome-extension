import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `page/dist` holds the esbuild bundle of `@ag-ui/client` and its dependency tree. Linting
  // a third-party bundle reports thousands of violations in code nobody here can fix.
  { ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**', 'page/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // `page/main.ts` runs in the browser, and the e2e specs run in Node but carry closures
    // (`page.evaluate`, `waitForFunction`) that are serialised and executed in the page.
    files: ['page/main.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
