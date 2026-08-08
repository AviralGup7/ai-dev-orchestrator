# AI Development Orchestrator

A browser extension that acts as an autonomous **project manager** for a
software project — coordinating three AI systems with separate
responsibilities and driving the project toward a measurable quality target
with minimal human supervision.

Not a coding assistant. Not a prompt-copier. The distinguishing claim is
**judgement**: it decides what to work on next, notices when it is going in
circles, and stops when it is actually done.

> **Status: walking skeleton.** The orchestration engine is complete and
> tested — state machine, memory, scoring, loop detection, stop conditions.
> The AI adapters are next. See [`docs/SPEC.md`](docs/SPEC.md).

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

## Layout

```
src/core/        the engine — pure, no browser, runs in Node
  types.js         vocabulary: evidence, confidence, dimensions, phases
  scoring.js       evidence → scores, and refusing to invent the rest
  detect.js        six signals for "this is going in circles"
  stop.js          when to halt, and why
  orchestrator.js  the loop
  store.js         persistence (the one documented browser seam)
src/adapters/    per-AI request/response shaping
src/transports/  the only layer that knows about tabs
docs/SPEC.md     the specification
```

## Commands

```
npm test        55 tests, no browser required
npm run purity  fails if the engine grows a browser dependency
```

## A risk worth stating

Driving `chat.openai.com` and `deepseek.com` via DOM injection is likely
contrary to their terms of service, and their markup can change without
notice. The adapter boundary exists partly so an API transport can replace a
DOM transport without touching the engine.
