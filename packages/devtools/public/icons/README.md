# Extension icons

Vite copies everything under `public/` into `dist/` verbatim, so files placed here land at
`dist/icons/*` and can be referenced from `manifest.config.ts` as `icons/<file>`.

Requirements §12's manifest has no `icons` key, so nothing here is wired up yet. Adding
icons is a Chrome Web Store submission requirement, not a load-unpacked one; drop
`icon-16.png`, `icon-32.png`, `icon-48.png`, and `icon-128.png` here and add the matching
`icons` block to `manifest.config.ts` before the first CWS upload (design §6, D8).
