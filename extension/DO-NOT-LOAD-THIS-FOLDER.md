# Do not load this folder in Chrome

Load **`dist/`** instead.

There is deliberately no `manifest.json` here, only
`manifest.template.json`. Chrome will refuse this folder with
*"Manifest file is missing or unreadable"* — which is unambiguous — rather than
the cryptic *"Service worker registration failed. Status code: 3"* it produced
when a manifest was present.

## Why this folder cannot work

`background.js` imports `../src/core/orchestrator.js`. That resolves **above**
this directory, and a service worker may not fetch a module outside its package
root. The engine lives in `src/core/` on purpose — `tools/check-purity.mjs`
enforces that it stays browser-free and runnable in Node — so the fix is a
build, not a moved folder.

## What to do

```bash
npm run build     # assembles dist/ and verifies Chrome can load it
```

`chrome://extensions` → Developer mode → **Load unpacked** → select **`dist/`**.

See `docs/INSTALL.md`.
