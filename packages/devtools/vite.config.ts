import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig(({ mode }) => ({
  plugins: [preact(), crx({ manifest })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode !== 'production',
    rollupOptions: {
      // panel.html is opened at runtime by chrome.devtools.panels.create, so no
      // manifest key points at it and CRXJS will not discover it. Name it as an
      // explicit input or it never reaches dist/.
      input: { panel: 'src/panel/panel.html' },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
