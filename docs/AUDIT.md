# Repository audit — production build

The brief's §0 describes the repository as it was at commit `6743b9c` (55
tests, empty `src/adapters/`). Seven commits have landed since. This records
what actually exists, so the remaining work is the *real* remaining work.

## Already built (do not rebuild)

| Brief § | Subsystem | Where | State |
|---|---|---|---|
| 3 | Durable logging, event taxonomy | `core/events.js`, `core/logger.js`, `core/logsink.js`, `extension/idbsink.js` | done — two-tier, IndexedDB, never discards |
| 5 | Persistence behind an interface | `core/store.js`, `extension/idbsink.js` | partial — **no versioning/migration** |
| 7 | Pre-opened environment contract | `core/environment.js`, `core/preflight.js`, `extension/probe.js` | done — bind/verify, 8-point checklist |
| 11 | Response schemas (engineer only) | `core/report.js` | partial — parses, strips forbidden fields |
| 15 | Loop detection, 6 signals | `core/detect.js` | done — calibrated threshold |
| 16 | Stop conditions | `core/stop.js` | done — incl. skip-poisoning |
| 18 | Human override | `core/controls.js` | partial — no approve/reject |
| 20/21 | Mission Control, live feed | `extension/panel.js`, `ui.js` | done — 4 tabs, filters |
| 26 | MV3 shell | `extension/manifest.template.json`, `background.js` | done — loadable, verified |
| 32 | Purity check | `tools/check-purity.mjs` | done — 21 modules |
| — | Surface scanner | `core/surface.js`, `extension/scan.js` | done |

**247 tests, 71 sabotages, purity + env-safety + loadable checks green.**

## Genuinely missing

| Brief § | Missing | New module |
|---|---|---|
| 4 | Project/Session/Run/Iteration model | `core/session.js` |
| 5 | Schema version + migrations | `core/migrate.js` |
| 11 | Manager/reviewer schemas | `core/schema.js` |
| 12 | Evidence parsers (test/build/lint/coverage/diff) | `core/parse.js` |
| 13 | Evidence provenance | in `parse.js` + `types.js` |
| 17 | Failure recovery policy | `core/recovery.js` |
| 19 | File/artifact management | `core/artifacts.js` |
| 23 | Analytics | `core/analytics.js` |
| 24 | Replay | `core/replay.js` |
| 25 | Simulation adapters | `src/sim/` |
| 8/9/10 | The three AI adapters | `src/adapters/` |
| 6 | Browser transport | `src/transports/` + `extension/dom-transport.js` |

## Build order (dependency-driven, differs from §36)

§36 puts simulation at phase 4 and adapters at 11–13. But a simulation adapter
*is* an adapter — it must implement the same interface — so the interface has
to exist first. Schemas and parsers are the interface's vocabulary. Therefore:

1. `schema.js` — validation vocabulary (needed by every adapter)
2. `parse.js` — evidence parsers + provenance (needed by the engineer)
3. `session.js` + `migrate.js` — the run model and storage versioning
4. `src/adapters/` — manager, engineer, reviewer over an injected transport
5. `src/sim/` — simulated transport + fault injection
6. `recovery.js`, `artifacts.js`, `analytics.js`, `replay.js`
7. `src/transports/` + DOM transport
8. UI, docs, verification

This is the same set of work in an order that compiles.
