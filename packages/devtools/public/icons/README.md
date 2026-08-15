# Extension icons

**Generated. Do not edit these PNGs by hand.**

    pnpm icons        # listing/icon.svg -> icon-{16,32,48,128}.png

Vite copies everything under `public/` into `dist/` verbatim, so these land at `dist/icons/*` and
are referenced from `manifest.config.ts` as `icons/<file>`. They are committed because they ship
in the bundle, and `scripts/verify-build.ts` fails the build if any of the four is missing from
`dist/` or unreferenced by the manifest.

`icon-128.png` doubles as the Chrome Web Store store icon.

The mark itself is designed in
[`docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md`](../../../../docs/superpowers/specs/2026-08-15-chrome-web-store-listing-design.md) §3.
