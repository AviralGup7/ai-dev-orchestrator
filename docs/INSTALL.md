# Installing the extension

## Load `dist/`

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
**`dist/`**.

`dist/` is committed, so a fresh clone already has it. To rebuild after editing
`src/` or `extension/`:

```bash
npm run build     # rebuilds dist/ and verifies Chrome can load it
```

### If you see "Service worker registration failed. Status code: 3"

You have loaded **`extension/`**, not `dist/`. Check the version Chrome shows:
if it says **0.2.0** you are on the source folder; the built one is **0.3.0**.

This is no longer possible on a current checkout — `extension/` has no
`manifest.json` any more, so Chrome refuses it with *"Manifest file is missing
or unreadable"*, which at least names the problem. If you are looking at an
older checkout, `git pull` and load `dist/`.

---

## Why `extension/` cannot work, and why it was easy to get wrong

This was reported twice. The first time the instruction "load `dist/`" was
given; the second report pasted a manifest showing version `0.2.0`, a
`scripting` permission and no `icons` — unmistakably the **source** manifest.

The instruction was right and the packaging was still wrong: `dist/` was
gitignored, so a fresh clone contained exactly one folder with a
`manifest.json` in it, and it was the folder that does not work. Telling
someone to avoid the obvious path is not a fix. Three changes make the working
path the discoverable one:

| Change | Effect |
|---|---|
| `extension/manifest.json` → `manifest.template.json` | Chrome refuses the folder with *"Manifest file is missing or unreadable"* instead of the opaque status-3 error |
| `dist/` is committed | a clone has the loadable folder already |
| `check-loadable.mjs` compares `dist/` to source | a committed build cannot silently go stale |



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
209 tests, 0 failures          (10 running the real worker)
53/53 sabotages caught
purity ok · env-safety ok
dist/ is loadable — 34 files, worker evaluates and answers
```

The staleness guard was verified by appending a line to `dist/core/logger.js`:

```
core/logger.js differs from src/core/logger.js — dist/ is stale; run `npm run build`
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

---

# The silent button

*Reported by exporting a log — which is exactly what the log is for.*

Seventeen events. Two of them mattered:

```
000002  user  settings-changed  Workflow mode set to "explore"
000003  user  button-clicked    Pressed preflight
000004  user  button-clicked    Pressed preflight
   … eleven more …
```

Thirteen presses of **Check environment & start**, and nothing after any of
them. Not an error, not a warning — nothing. The log was working perfectly and
faithfully recording that the orchestrator did nothing at all.

## Cause

`panel.js` calls `engine.preflight(setup)`. **`client.js` never defined it.**
The call returned `undefined`, invoking it threw a `TypeError` inside a click
handler, and the rejection went nowhere.

It survived because there are **two implementations of the `engine`
interface**: the demo builds its own, the extension uses `client.js`. Only the
demo's was exercised — so `demo.html` worked flawlessly the entire time while
the real extension had an inert button. Two implementations of one interface,
one of them tested.

`open-report` was broken the same way, unimplemented in `background.js`. It
had simply not been pressed yet.

## Fixes

**The missing methods.** `preflight` added to `client.js`; `preflight` and
`open-report` implemented in `background.js`.

**`extension/probe.js`** — the missing half of the environment contract.
`src/core/environment.js` judges snapshots and has never heard of a tab; this
produces the snapshots from `chrome.tabs.query`. Reads only: nothing is
created, closed or navigated. It requests **no `tabs` permission** —
`tabs.query` works without it and returns blank URLs for hosts the extension
has no permission for, which given the four host permissions is exactly the
right amount of blindness.

**A silent click is now impossible.** Every handler runs inside `guarded()`,
which turns a throw into a logged, visible error. And `engine[action]?.()`
became an explicit check: optional chaining is right for an optional thing, and
a control the UI is *rendering* is not optional.

## A contradiction the log exposed

With the button working, preflight reported:

```
1 of 9 checks failed: Durable log storage
```

and disabled Start — while that check's own remedy read *"The run can proceed,
but the log will not survive a restart."* The checklist contradicted its own
advice, and a checklist that does that trains people to ignore it.

Checks now carry `blocking`, defaulting to **true** so a new check cannot be
waved through by forgetting. `ok` means *may the run start*, not *is everything
perfect*. Degraded is not broken: losing the durable log costs history after a
restart, refusing to start costs the run.

```
all 9 checks passed, with 1 warning(s): Durable log storage
prompt composed: 4,980 chars
```

## A test that tested its own text

The first version of the "controls are checked" test grepped `panel.js` for the
guard. Sabotage changed `if (typeof engine[action] !== 'function')` to
`if (false)` — the phrase was still in the file, so the test passed while the
guard was gone.

Replaced with one that drives the real panel through a small DOM stub, using an
engine deliberately missing a method, and asserts on the logged error. That
immediately found something the grep version could not: the `preflight` branch
calls `engine.preflight` **directly** and bypassed the generic guard entirely —
so the guard covered every control except the one that had actually broken.

## Verification

```
221 tests, 0 failures
60/60 sabotages caught
dist/ loadable — 35 files, worker evaluates and answers
```

Simulated against realistic tabs: three surfaces found among ordinary browsing,
a new-chat tab correctly yielding no conversation id, duplicate tabs preferring
the active one and recording the ambiguity.
