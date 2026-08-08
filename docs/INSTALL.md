# Installing the extension

```bash
npm run build          # writes dist/ and verifies it is loadable
```

Then in Chrome:

1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the **`dist/`** folder

> Load `dist/`, **not** `extension/`. The reason is below.

---

## Why `extension/` alone does not work

Loading `extension/` produces:

```
Service worker registration failed. Status code: 3
An unknown error occurred when fetching the script.
```

`extension/background.js` contains:

```js
import { Orchestrator } from '../src/core/orchestrator.js';
```

That resolves **above** the folder Chrome was pointed at, and a service worker
may not fetch a module outside its package root. Chrome reports this as a
generic fetch failure with no filename, which is why the message is so
unhelpful — the request never got far enough to name what it wanted.

Nothing was syntactically wrong. Every file parsed, 200 tests passed, the
purity checker passed, and the demo bundle ran. Node, `node --test` and the
demo bundler all resolve `../` happily. **Chrome is the only consumer that
enforces a package root, and it was the only one not in the loop.**

### Why the fix is a build, not a moved folder

`src/core/` must stay outside `extension/`. That separation is exactly what
`tools/check-purity.mjs` enforces — the engine is browser-free and runs in
Node — and collapsing it to satisfy the packager would trade a real
architectural property for a path.

So `tools/build-extension.mjs` assembles a root Chrome accepts:

```
dist/
  manifest.json
  background.js  panel.js  ui.js  popup.html  sidepanel.html  …
  core/          orchestrator.js  logger.js  scoring.js  …   (20 modules)
  icon16.png  icon48.png  icon128.png
```

rewriting `'../src/core/x.js'` → `'./core/x.js'` on the way through. The
rewrite is narrow (a quoted specifier, nothing else) because a broad one would
silently mangle a string that merely looked like a path, and that failure would
surface at runtime inside a service worker with no console open.

---

## What the build also fixes

**Missing icons.** `manifest.json` had no `icons` key and `background.js`
passed `iconUrl: 'icon128.png'` to `notifications.create`. No such file
existed — so a notification would throw at the exact moment it was trying to
tell the user something had gone wrong. The build generates 16/48/128px PNGs in
code (a ~40-line encoder over `node:zlib`), so no binary is committed and the
mark is reproducible.

**Version drift.** `manifest.json` said `0.2.0` while `package.json` said
`0.3.0`. The build takes the version from `package.json` so they cannot
disagree — two versions is how a bug report ends up describing a build nobody
can identify.

**An unused permission.** `scripting` was declared and never called. It is
stripped. "Read and change your data on these sites" is a prompt the user
should be able to read honestly, and asking for it before anything needs it
inflates the install dialog for nothing.

---

## `npm run build` verifies before it claims success

`tools/check-loadable.mjs` runs automatically and checks the two things only a
browser previously checked:

**Structure** — every import, `<script src>`, and manifest path resolves
*inside* `dist/`; no bare specifiers (extensions have no module resolver); no
inline `<script>` or `onclick=` (blocked by the MV3 CSP); no remote resources;
icons are real PNGs.

**Evaluation** — it actually runs the worker against a `chrome` shim, with
**IndexedDB deliberately failing**. A structure check cannot catch a throw at
module top level, which fails registration with the same opaque message.

That evaluation immediately found a second bug (below).

---

## The second bug: an error about an error

With the paths fixed, the worker registered — and its first `state` request
came back:

```
{"ok":false,"error":"Cannot read properties of undefined (reading 'message')"}
```

`idbsink.js` did `reject(req.error)`, and **`IDBRequest.error` is `null`** when
the database cannot be opened at all (storage disabled by policy, a
partitioned context, a corrupt profile). Rejecting with `null` meant
`err.message` threw, so the log reported a failure *about the error handler*
while the real fact — storage is unavailable — never reached the user.

Two fixes, deliberately overlapping:

* every `reject` in `idbsink.js` carries a real `Error`;
* `background.js` uses `reason(err)` = `String(err?.message || err || 'unknown error')`,
  the idiom `src/core` has used throughout and the extension layer had not
  caught up to.

Now it degrades honestly:

```
note: worker started in a degraded state and said so:
      "Could not restore the log: IndexedDB could not be opened"
```

The run still works — the in-memory log is fine, the user just loses it on
eviction — and the panel says so instead of freezing.

Sabotaging `reason()` alone changed nothing, because `idbsink` had already made
it unreachable. Fine for the code, bad for the tests: the second guard could be
deleted unnoticed. There is now a test that drives `reason()` directly through
`downloads.download`, which Chrome rejects with a **bare string**.

---

## Verification

```
207 tests, 0 failures          (8 new, running the real worker)
53/53 sabotages caught
purity ok · env-safety ok
dist/ is loadable — 34 files, worker evaluates and answers
```

The loadable check was itself verified by reintroducing both original bugs:

| Reintroduced | Reported |
|---|---|
| `../src/core/…` import | `resolves OUTSIDE dist/; Chrome cannot fetch it` |
| `throw` at worker top level | `the service worker threw during evaluation: boom` |

### Two false positives in the checker, found and fixed

Its first run flagged `dist/core/scoring.js imports bare specifier "1,200
tests, all passing"` — it had matched the word `from` inside a sentence in a
doc comment. And it flagged nine files for "top-level await" by matching
`^\s*await`, which is any `await` inside any method. Comments are now stripped
and top-level means column zero.

A checker that reads prose as code produces confident nonsense, and a checker
people learn to disbelieve is worse than no checker.

---

## Still open

* **No AI adapters**, so `Start` refuses honestly rather than doing nothing.
* **`dist/` is gitignored** — it is a build output. Run `npm run build` after
  pulling.
* **Reloading in Chrome does not rebuild.** After editing `src/` or
  `extension/`, run `npm run build` again, then hit reload on the extension.
