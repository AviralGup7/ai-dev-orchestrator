# AI Development Orchestrator

A browser extension that acts as an autonomous **project manager** for a
software project — coordinating three AI systems with separate
responsibilities and driving the project toward a measurable quality target
with minimal human supervision.

Not a coding assistant. Not a prompt-copier. The distinguishing claim is
**judgement**: it decides what to work on next, notices when it is going in
circles, and stops when it is actually done.

> **Status: engine + environment contract + observability UI + first-run
> workflow.** Everything except the three AI adapters, which are the remaining
> milestone. See [`docs/SPEC.md`](docs/SPEC.md),
> [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md),
> [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) and
> [`docs/FIRSTRUN.md`](docs/FIRSTRUN.md).
>
> **Try it without installing:** `npm run demo` writes `demo.html` — the real
> engine, logger and UI driven by fake adapters on a sped-up clock. Open it and
> press Start.

## Roles

| AI | Does | Structurally cannot |
|---|---|---|
| **ChatGPT** | plans, evaluates, generates prompts | emit code — its response schema has no patch field |
| **Arena** | reads the repo, writes code, runs builds and tests | choose direction — no `nextObjective` field |
| **DeepSeek** | strategic review every N iterations | touch the project |

Enforced by response schema, not by asking politely in a prompt. A prompt
saying "do not write code" is a request; a validator that rejects a `patch`
field is a guarantee.

## The two ideas that matter

**1 · Scores must be earned.**

Ask a model "how complete is this project?" and it will answer — confidently,
and slightly higher each time, because that is the shape of the expected reply.
Left alone the dashboard rises smoothly to 100% and means nothing.

So every score carries a confidence:

- `measured` — computed from typed evidence (test counts, build results)
- `inferred` — reasoned from partial evidence
- `asserted` — the model's opinion, with nothing behind it

**A run cannot stop on `asserted` scores.** Hitting the target is necessary and
not sufficient.

**2 · The engine never touches a browser.**

`src/core/` has no `chrome.*`, no DOM, no `fetch`. It talks to adapters. That
is what makes the roadmap's local companion a *new adapter* rather than a
rewrite — and it is enforced by `npm run purity`, not by convention.

**3 · Nothing happens invisibly.**

Every meaningful event is logged with a unique, sortable id, a source, a
status and a duration — then rendered in an Activity Log that opens first,
because during a run it is the source of truth. The log is two-tier: a durable
IndexedDB record that never discards, and a bounded live view that says how
many events it is not showing. You can always see what it is doing, why, what
happened before, what comes next, and stop it.

**4 · You write a description; the extension writes the prompt.**

Three workflow modes — New Project, Existing Project, and Self Exploration
(which needs no prompt at all). Whichever you pick, the extension prepends an
orchestration protocol defining the response format, the required engineering
report, and commit/test/logging expectations, then appends the project state
assembled from memory. Arena's reply is parsed into typed evidence, and any
field that would let it choose direction is dropped before the loop sees it.

**5 · The environment is inherited, never created.**

The tabs are already open, the conversations are already chosen, and the user
is already signed in. The orchestrator switches focus between those tabs, types
into them, and reads them back. It **cannot** open a tab, close one, start a
new chat, sign in, or navigate — those verbs are not in the allow-list, and
`npm run env-safety` fails the build if the underlying Chrome APIs appear in
the source at all.

When the environment stops matching what was bound — a tab closed, a
conversation switched, a session expired — the run **pauses, logs the exact
problem with a remedy, tells the user, and waits.** It never recovers by
changing the user's browser. Details and the reasoning:
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

## Layout

```
src/core/        the engine — pure, no browser, runs in Node
  types.js         vocabulary: evidence, confidence, dimensions, phases
  scoring.js       evidence → scores, and refusing to invent the rest
  detect.js        six signals for "this is going in circles"
  stop.js          when to halt, and why
  orchestrator.js  the loop
  store.js         persistence (the one documented browser seam)
  actions.js       the allow-list of things it may do to your browser
  environment.js   bind() / verify() — is this still the prepared environment?
  guard.js         the only route from the engine to a transport
  journal.js       the copy-pasteable markdown run log
  events.js        the closed event vocabulary + workflow stages
  logger.js        the logging subsystem + session summary
  logsink.js       durable sink interface, NDJSON/CSV export
  status.js        the five questions, derived from memory + log
  controls.js      start/pause/skip/retry, and what skip costs
  bridge.js        engine events -> Activity Log entries
  modes.js         the three first-run workflows
  protocol.js      the orchestration protocol injected before every prompt
  report.js        parses Arena's report into typed evidence
  preflight.js     the pre-start checklist
src/adapters/    per-AI request/response shaping (next milestone)
src/transports/  the only layer that knows about tabs
extension/       manifest, service worker, popup, side panel, renderers
  ui.js            pure render functions, unit-tested without a browser
  panel.js         side-panel controller
  background.js    owns the run; survives panel close and MV3 eviction
  idbsink.js       IndexedDB log store + chrome.storage memory store
docs/SPEC.md          the specification
docs/ENVIRONMENT.md   the pre-initiated environment contract
docs/OBSERVABILITY.md the logging subsystem and the UI
docs/FIRSTRUN.md      the three workflow modes and the injected protocol
docs/INSTALL.md       loading it in Chrome, and why dist/ exists
```

## Installing

```bash
npm run build   # writes dist/, then verifies Chrome can load it
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → select
**`dist/`**.

Load `dist/`, not `extension/`: the source imports `../src/core/…`, which is
above the package root and cannot be fetched by a service worker. The build
assembles a root Chrome accepts and rewrites those imports. Full explanation in
[`docs/INSTALL.md`](docs/INSTALL.md).

## Commands

```
npm test            207 tests, no browser required
npm run build       assemble dist/ and verify Chrome can load it
npm run purity      fails if the engine grows a browser dependency
npm run env-safety  fails if anything can open/close/navigate a tab
npm run sabotage    breaks the code 53 ways; every break must fail a named test
npm run demo        builds demo.html — the real UI, fake AIs, sped-up clock
npm run smoke       runs the demo headlessly and checks the log is coherent
npm run check       purity + env-safety + tests + extension build + demo
```

## A risk worth stating

Driving `chat.openai.com` and `deepseek.com` via DOM injection is likely
contrary to their terms of service, and their markup can change without
notice. The adapter boundary exists partly so an API transport can replace a
DOM transport without touching the engine.
