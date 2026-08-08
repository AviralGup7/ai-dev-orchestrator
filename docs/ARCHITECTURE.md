# Architecture

## The one rule

```
src/core/  →  knows nothing about browsers, DOM, Chrome APIs, HTTP, or any
              specific AI website. Enforced by tools/check-purity.mjs.
```

Everything else follows from it. `npm run purity` fails the build on a
violation, and it has caught two real ones — `runner.js` importing from
`../adapters`, and a leaked `chrome.storage` call — plus two false positives
that were fixed in the checker rather than worked around.

## Layers

```
        ┌──────────────────────────────────────────────┐
        │  extension/     manifest, worker, panel, DOM │  browser only
        ├──────────────────────────────────────────────┤
        │  src/transports/  DOM transport (pure)       │  page mechanics
        │  src/sim/         simulated transport        │
        ├──────────────────────────────────────────────┤
        │  src/adapters/    manager · engineer ·        │  conversations
        │                   reviewer, over a transport  │
        ├──────────────────────────────────────────────┤
        │  src/core/        engine, schemas, parsers,   │  no browser
        │                   scoring, session, storage   │
        └──────────────────────────────────────────────┘
```

The arrows point **inward only**. `runner.js` classifies adapter failures by
duck-typing an `outcome` string rather than importing `AdapterError`, so a
future official-API adapter participates without the core knowing it exists.

## The loop

```
PLAN ─→ EXECUTE ─→ EVALUATE ─→ DETECT ─→ REVIEW ─→ DECIDE ─→ next / stop
 │         │           │          │         │
 ChatGPT   Arena       ChatGPT    local     DeepSeek
```

`DETECT` is deliberately local: it is arithmetic over memory, needs no AI, and
gating it on the environment would skip stagnation analysis for the very
iteration a failure produced.

Iteration 1 is a **baseline** whose objective is fixed by the engine, not the
manager — asking ChatGPT to invent an objective for a step whose job is already
known wastes a round trip and lets it skip the baseline entirely.

## Where each guarantee lives

| Guarantee | Mechanism | File |
|---|---|---|
| Roles cannot exceed their remit | forbidden fields dropped from responses | `core/schema.js` |
| Prose never becomes measurement | hedge detection, tool-shaped patterns only | `core/parse.js` |
| Opinion cannot end a run | two independent gates on `target-reached` | `core/stop.js` |
| A phase never runs twice | `completedPhases` on the persisted run | `core/session.js` |
| The environment is never altered | default-deny allow-list + CI grep | `core/actions.js` |
| Nothing happens invisibly | every event durable, two-tier log | `core/logger.js` |
| Numbers are traceable | provenance on every evidence record | `core/parse.js` |
| Metrics are never invented | `{value, basis}` with `unknown` first-class | `core/analytics.js` |

## The four nouns

`Project` outlives everything · `Run` is Start→stop · `Session` is one worker
lifetime · `Iteration` is one loop.

The distinction is load-bearing rather than tidy: an MV3 worker is evicted after
~30s idle and this orchestrator spends most of its life waiting, so **sessions
end constantly, mid-run, as normal operation**. Conflating session and run would
make every eviction look like the run ending.

## Storage, split by access pattern

| Data | Where | Why |
|---|---|---|
| project, run | `chrome.storage.local` | small, fixed size, written every phase |
| iterations | one record each | written while live, then frozen |
| events | IndexedDB | unbounded, append-only |

A checkpoint costs **two writes regardless of run length**. Putting the log in
one blob would mean re-serialising megabytes per phase.

Schema is versioned (`SCHEMA_VERSION = 3`) with pure `v → v+1` migrations that
never throw — they run at startup, where an uncaught error is a dead extension.
Data from a newer build is **refused, not downgraded**; a corrupt project is
**quarantined, not deleted**.

## Testing strategy

370+ tests, no runtime dependencies, no browser required. Adapters are tested
against the simulated transport; the DOM transport is tested with an injected
clock so eight-second quiet periods cost nothing; persistence uses isolated
stores; recovery uses deterministic fault injection.

`npm run sabotage` breaks the code 98 ways and requires a **named** test to fail
for each. It has found something in every session — including, this session, a
hole in the product's central claim.
