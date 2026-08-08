# AI Development Orchestrator — Specification

**One sentence:** a browser extension that acts as an autonomous *project
manager* for a software project, coordinating three AI systems with separate
responsibilities and driving the project toward a measurable quality target
with minimal human supervision.

Not a coding assistant. Not a prompt-copier. The distinguishing claim is
**judgement**: it decides what to work on next, notices when it is going in
circles, and stops when it is done.

---

## 1 · The decision that shapes everything

**MVP is Extension + Arena. The local companion comes second, and the
architecture must not have to change when it does.**

| Architecture | Verdict |
|---|---|
| Extension + Arena | Excellent MVP — ships now, validates the loop |
| Extension + Companion | Missing the AI execution loop entirely |
| Extension + Arena + Companion | Best long term |

The trap is building the MVP in a way that makes the third row a rewrite. So
the single most important structural rule in this document:

> **The orchestration engine never talks to a browser tab, a DOM node, or an
> HTTP endpoint. It talks to adapters.**

If that holds, adding the companion is *registering a new evidence source*, not
a redesign. If it leaks even once — one `document.querySelector` inside the
scoring logic, one `chrome.tabs` call inside the state machine — the boundary
is gone and nobody notices until it is expensive.

There is a test that enforces this. It is not a style rule.

---

## 2 · Roles

The value of role separation is that each AI does the thing it is *good* at,
and is structurally prevented from doing the thing it is bad at.

### ChatGPT — project manager

Decides the next objective, evaluates progress, generates prompts, plans.

**Structurally prevented from:** emitting code. Its adapter's response schema
has no field for a patch. If it returns code, the response fails validation and
is rejected — the constraint is mechanical, not a polite instruction in a
prompt.

### Arena — engineer

Reads the repo, writes code, runs builds and tests, reports what happened.

**Structurally prevented from:** deciding direction. It receives an objective;
it does not produce one. Its response schema has no `nextObjective` field.

### DeepSeek — strategic reviewer

Every N iterations (default 5): is this project going somewhere? Looping?
Neglecting something? Should the plan change?

**Structurally prevented from:** touching the project. It emits a
recommendation the *user* or the manager acts on.

### Why this is enforced by schema rather than by prompt

A prompt saying "do not write code" is a request. A response validator that
rejects a `patch` field is a guarantee. Prompts drift, models change, and the
one thing you cannot debug later is an AI that quietly took over another AI's
job three weeks ago.

---

## 3 · Architecture

```
┌──────────────────────────────────────────────────────────┐
│  UI (extension popup / dashboard)                        │
│  start · pause · resume · approve · override · inspect   │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│  ORCHESTRATOR CORE          ← pure. no chrome.*, no DOM   │
│                                                          │
│  state machine · memory · prompt pipeline · scoring      │
│  loop detection · stop conditions · context compaction   │
└───────────────────────────┬──────────────────────────────┘
                            │  adapter interface
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼──────┐   ┌────────▼───────┐   ┌───────▼────────┐
│ ManagerAdapter│   │ EngineerAdapter│   │ ReviewerAdapter│
│  (ChatGPT)    │   │    (Arena)     │   │  (DeepSeek)    │
└───────┬──────┘   └────────┬───────┘   └───────┬────────┘
        │                   │                   │
┌───────▼───────────────────▼───────────────────▼────────┐
│  TRANSPORTS — the only layer that knows about browsers  │
│  DomTransport (MVP) · ApiTransport · CompanionTransport │
└─────────────────────────────────────────────────────────┘
```

**The core is a pure ES module graph with no `chrome.*` import anywhere.** It
runs in Node, which means the entire decision-making system — the part that is
actually hard — is testable without a browser.

---

## 4 · The iteration loop

```
        ┌──────────────────────────────────────┐
        │  PLAN    manager → next objective     │
        └──────────────┬───────────────────────┘
                       ▼
        ┌──────────────────────────────────────┐
        │  EXECUTE engineer → changes + evidence│
        └──────────────┬───────────────────────┘
                       ▼
        ┌──────────────────────────────────────┐
        │  EVALUATE manager → scores, evidence-  │
        │           backed, + confidence         │
        └──────────────┬───────────────────────┘
                       ▼
        ┌──────────────────────────────────────┐
        │  DETECT  loop? stagnation? drift?      │
        └──────────────┬───────────────────────┘
                       ▼
              every Nth ──► REVIEW (DeepSeek)
                       ▼
        ┌──────────────────────────────────────┐
        │  STOP?   satisfied → halt              │
        │          else → PLAN                   │
        └──────────────────────────────────────┘
```

Every transition is persisted before the next begins. A browser restart mid-run
resumes from the last completed phase, not from the beginning — which matters
because an iteration can take minutes and losing one is losing real work.

---

## 5 · Evidence, and the honesty problem

The spec says percentages must never be guesses. That is the hardest
requirement in the document, and it deserves a precise answer rather than an
aspiration.

**An AI asked "how complete is this project?" will produce a plausible number
regardless of whether it has any basis for one.** It will also tend to report
improvement, because that is the shape of the expected answer. Left alone, the
score chart goes up and to the right and means nothing.

Three defences:

**1. Evidence is typed, not prose.**

```js
{ kind: 'test',  passed: 1276, failed: 0, skipped: 0 }
{ kind: 'build', ok: true, durationMs: 4210 }
{ kind: 'diff',  filesChanged: 4, insertions: 210, deletions: 18 }
{ kind: 'lint',  errors: 0, warnings: 3 }
```

Parsed from Arena's terminal output by the *engineer adapter*, not invented by
the manager.

**2. Every score carries its evidence and a confidence.**

```js
{ dimension: 'testing', score: 74, confidence: 'measured',
  basis: [{ kind: 'test', passed: 1276, failed: 0 }] }
```

`confidence` is one of `measured` (derived from typed evidence), `inferred`
(reasoned from partial evidence), `asserted` (the model's opinion, no
evidence). **An `asserted` score is displayed differently and is excluded from
stop conditions.** A project cannot reach its completion target on the model's
say-so.

**3. Some dimensions are computed, not asked.**

`testing` and `performance` are derived arithmetically from evidence where
evidence exists. The manager's opinion is only consulted for genuinely
subjective dimensions (UI/UX, architecture) — and those are marked `inferred`
at best.

> **Recorded honestly:** UI/UX and accessibility cannot be measured from
> scraped text. They will be `asserted` or `inferred` in the MVP. The system
> will say so rather than pretending otherwise. A number the user believes and
> shouldn't is worse than a number labelled uncertain.

---

## 6 · Loop detection

Six independent signals, each cheap:

| Signal | Trigger |
|---|---|
| Objective similarity | normalised text ≥ 0.85 vs any of the last 5 |
| File churn | same file set touched 3 iterations running |
| Score plateau | overall Δ < 2 points across 3 iterations |
| Evidence stasis | test/build numbers identical 3 iterations running |
| Bug recurrence | same issue text reappears after being marked resolved |
| Diff triviality | < 10 lines changed for 2 iterations running |

Two or more signals firing raises a `stagnation` flag, which pulls the
strategic review forward rather than waiting for iteration N.

**Score plateau alone is deliberately not sufficient.** A project genuinely near
completion plateaus, and treating "nearly finished" as "stuck" would trigger a
strategy change at exactly the wrong moment.

---

## 7 · Stop conditions

Evaluated after every iteration; the first to match halts the run.

| Condition | Default |
|---|---|
| Target reached | overall ≥ target **and** all mandatory gates pass **and** no dimension is `asserted` |
| No progress | < 2 points across 3 consecutive strategic reviews |
| Budget | iteration cap reached (default 50) |
| User stop | immediate, at the next phase boundary |
| Fatal | unrecoverable failure, state preserved for inspection |

The `no dimension is asserted` clause is what stops the system declaring
victory on vibes.

---

## 8 · Failure recovery

| Failure | Response |
|---|---|
| Adapter timeout | retry ×2 with backoff, then pause and ask |
| Malformed response | one reprompt with the schema error, then pause |
| Tab closed / navigated | re-open, restore context from memory |
| Network loss | pause, wait for `online`, resume from last completed phase |
| Extension reload | resume from persisted phase |
| Repeated failures | halt with state intact — never loop on a broken transport |

Every phase is idempotent and persisted before the next starts. The system is
allowed to be slow; it is not allowed to lose an iteration or silently do one
twice.

---

## 9 · Non-goals

Explicitly out of scope, and each for a reason worth stating:

- **Custom models.** Orchestration is the product.
- **CAPTCHA / anti-bot bypass.** Off the table permanently.
- **Autonomous production deployment.** Requires human approval, always.
- **Business decisions beyond the given scope.**
- **Open-ended internet research.**

> **A risk I am flagging rather than burying:** driving `chat.openai.com` and
> `deepseek.com` via DOM injection is likely contrary to their terms of
> service, and their markup can change without notice. The adapter boundary
> exists partly so that an API transport can replace a DOM transport without
> touching the engine. You should make that call knowingly.

---

## 10 · Build order

1. **Walking skeleton** — one full loop, fake adapters, real state machine,
   real persistence, real scoring, real stop conditions. Proves the engine.
2. **Arena engineer adapter** — real execution, real evidence parsing.
3. **ChatGPT manager adapter** — real planning and evaluation.
4. **DeepSeek reviewer adapter** — strategic review.
5. **Extension shell** — dashboard, controls, tab management.
6. **Companion** — real builds, real coverage, real git. Slots in as an
   evidence source; the engine does not change.

Step 1 is what the user asked for, and it is also the step that de-risks every
later one.
