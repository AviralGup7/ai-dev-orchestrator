# First-Run Workflow

> The user should never need to manually prepare prompts beyond the initial
> project description.

Three modes, one injected protocol, a preflight checklist, and a fixed baseline
iteration. This records what was built, two places where the specification
conflicts with rules already enforced in the codebase, and the bugs found.

---

## 1. Two conflicts with existing guarantees, and how they were resolved

### a. "Suggested Next Task" versus role separation

The required output structure asks Arena for a **Suggested Next Task**.
`docs/SPEC.md` says Arena "should NOT decide project direction", and enforces
that *by response schema rather than by prompt* — the whole point being that a
prompt saying "do not decide" is a request, not a guarantee.

**Resolved as: suggestion survives, decision is dropped.** The parser deletes
`nextObjective`, `plan`, `strategy`, `recommendation`, `projectComplete`,
`overallScore` and friends before the report is used, and records what it
dropped. `suggestedNextTask` is kept and passed to ChatGPT as *input*.

The distinction is that advice reaches the manager, who may ignore it; a
decision would reach the loop, which would act on it. Both directions are
tested, and the sabotage that disables the field-stripping is caught.

### b. "Estimate scores" versus "percentages are never guesses"

Self Exploration asks Arena to *estimate* completion, quality, testing,
architecture, UI/UX, security and performance — before any measurement exists.
Taken literally that is the flattery `scoring.js` is built to prevent, arriving
in iteration 1.

**Resolved as: estimates are allowed, but must declare what they rest on.** The
exploration brief teaches the confidence model explicitly and says:

> Marking an impression as `measured` is worse than not scoring it at all …
> If you did not run the tests, `testing` is not measured.

Exploration scores therefore arrive mostly `asserted` or `inferred`, which is
honest and — critically — means they cannot satisfy a stop condition. The
project can be *understood* at iteration 1 without being *scored* at iteration
1, and the difference is visible in the UI rather than hidden.

---

## 2. The three modes

| Mode | Prompt required | Baseline iteration does |
|---|---|---|
| **New Project** | yes | standards, test infrastructure, initial commit, then implementation |
| **Existing Project** | optional | report real build/test state as a baseline, then continue |
| **Self Exploration** | none | read everything, report, roadmap, initial scores — change nothing |

`mode` is **persisted in memory**, not held in the UI. An MV3 service worker is
evicted constantly, and the mode changes how a continuation prompt is written
forty iterations later — "as established in the exploration report" is a lie if
the run started as a new project. A value living only in the popup would be
lost on the first eviction and the loop would silently change dialect.

A stored memory with history but no `mode` is treated as **`existing`**, not
`new`. Defaulting the other way would make a resumed run start re-scaffolding a
real project.

### Explore mode never gets an empty objective heading

`composeFirstPrompt` deliberately appends no `## OBJECTIVE` section in explore
mode. An empty heading invites the model to fill the silence with an objective
the user never wrote — then pursue it autonomously for fifty iterations, which
is precisely what the project's non-goals forbid. Tested, and the sabotage that
adds the heading back is caught.

### The placeholder scope

Explore mode has no user description, so `initialScope()` writes
`"… (pending exploration)"`. When the exploration report lands, the scope is
replaced by the engineer's own first sentence and the placeholder is **kept**
in `scopePlaceholder`. This is the only point where the "scope is never edited"
rule is relaxed, it happens exactly once, and it is relaxed from a value that
says out loud that it is temporary.

---

## 3. The injected protocol

`protocolBlock()` is prepended to **every** Arena prompt, not just the first.

A contract stated in message one is outside the context window by message
forty, and the decay is gradual rather than sudden: the model keeps the shape
for a while, then starts omitting fields it judges uninteresting. Re-stating it
costs tokens and buys a parser that keeps working.

### `ran: false` is the most important line in it

> `ran: false` is the honest answer when a build or suite was not executed.
> Do not report zeros as if they were a passing run — a suite that did not run
> and a suite with no failures are completely different facts.

`{passed: 0, failed: 0}` from a suite that never executed would otherwise
become a flawless testing score. `reportToEvidence()` emits **nothing** for a
suite that did not run, so `scoreTesting` sees no evidence and returns `null`
rather than a number. Sabotage-verified.

### Project metadata is assembled, never asked for

`metadataBlock()` reads iteration, previous summary, scores, health, open
issues, strategy changes and loop signals straight out of memory. Scores are
always sent **with their confidence** — `testing: 90% (measured)` versus
`uiux: 55% (asserted)` — because a bare number invites the model to reason from
it as established fact, and the asserted ones are exactly the ones it should be
trying to replace with evidence.

It is bounded (8 issues, 3 strategy changes, truncated strings). The failure
mode of unbounded context is not an error — it is the model silently losing the
earliest part of the message, which is where the protocol lives.

---

## 4. The parser is the trust boundary

`src/core/report.js` is where prose becomes evidence. Everything downstream
trusts it, so a forgiving parser turns a model's optimism into a `measured`
score.

**Tolerant about format, strict about content:**

* Finds the fenced block inside conversational padding.
* The **last** block wins — a model that corrects itself puts the correction
  last.
* Accepts a plain ```json fence, because models drop custom markers regularly.
  The fallback is narrow: the block must parse *and* contain a field we asked
  for, so an unrelated code sample in the reply is not mistaken for the report.
* Repairs trailing commas and a BOM. Nothing else. A parser that rewrites
  aggressively will eventually "fix" a malformed report into a plausible wrong
  one, and a wrong report that parses is far more dangerous than one that fails
  loudly.
* A missing block is a **loud failure**, never an empty success.

### Cross-checking: the numbers beat the prose

`crossCheck()` compares the engineer's narrative against its own numbers —
`taskStatus: "complete"` alongside `tests.failed: 3` is an **error**. Both come
from the same model in the same message, but the prose is generated to satisfy
the request while the numbers are copied from a terminal. When they disagree,
the numbers are right.

It returns findings rather than mutating the report. Silently rewriting would
hide the fact that the engineer is unreliable — which is itself information the
reviewer should have.

Also flagged: a commit claimed with no SHA, files changed with nothing
committed ("the work is not durable"), and a suite that was not run.

---

## 5. Preflight

Every item from the specification, plus what `bind()` cannot know.

```
✓ Project details are complete
✓ ChatGPT tab            tab 11 · chatgpt.com · demo-manager
✓ Arena AI tab           tab 22 · arena.ai · demo-workspace
✓ DeepSeek tab           (optional — not enabled)
✓ Arena workspace is open
✓ Logger is running      writing (session …)
✓ Durable log storage    accepting writes
✓ State storage initialised
```

It **delegates** the tab checks to `environment.bind()` rather than
re-implementing them — two checklists would drift apart and the user would see
whichever happened to run.

**Storage is verified by reading back what it wrote.** A store that accepts a
write and returns nothing presents as a run that resets to iteration 1 after
every eviction, which reads as an orchestrator bug rather than a storage one.
The probe restores the original record afterwards, and a test asserts an
existing project survives untouched.

**A broken durable log is a warning, not a refusal.** The in-memory log still
works, so the user can watch the run — they just lose it on eviction. Refusing
to start would turn a degraded-but-usable session into no session.

Problems on surfaces that are *not* required are still reported as warnings. A
DeepSeek tab on the wrong conversation while the reviewer is disabled is not
blocking, but it is exactly the misconfiguration the user hits the moment they
enable it, and finding it now is free.

---

## 6. The baseline iteration

Iteration 1 **does not consult the manager**. Its objective is fixed by mode.

Asking ChatGPT to invent an objective for a step whose job is already known
wastes a round trip — and lets the manager decide to skip the baseline
entirely, which it would do whenever the conversation already looked
productive.

`baselineDone` flips only when the baseline **produced something** (a record
with a summary). A baseline whose execute phase was skipped, or which returned
an unparseable report, runs again. Otherwise the run proceeds to "normal
improvement" on top of an understanding it never acquired — the exact failure
explore mode exists to prevent.

---

## 7. Bugs and dead code found

**A dead `delete` in preflight.** The probe cleanup did
`delete existing.__preflight` before saving — but `existing` came from `load()`,
which clones, so it never carried the probe key. Sabotaging the line changed
nothing and no test noticed, which is how it was found. The line that actually
protects a stored project is writing `existing` back, so that is what the test
now pins.

**The workspace check was untestable as written.** `bind()` already rejects a
tab with no conversation id, so "Arena tab open on the dashboard" failed either
way and the sabotage was a no-op. The honest conclusion: this check's value is
not its verdict but its **message** — "no Arena tab" and "Arena tab on the
dashboard" need different actions, and `bind()` calls the second
`conversation-changed`, which is right for ChatGPT and confusing here. It now
distinguishes the two explicitly and the test asserts the wording.

**Another bundle name collision.** `protocol.js` declared `truncate`;
`detect.js` already had one. Legal in ES modules, fatal once concatenated —
the same class of failure as `describe` last session. Caught by the bundle's
`node --check`, which exists *because* of the previous one. Renamed to `clip`.

**Six existing orchestrator tests broke**, correctly: they test the steady-state
loop, and iteration 1 no longer calls the manager. The helper now defaults
`baselineDone: true`, with a comment explaining that defaulting the other way
would make every test in that file secretly exercise the baseline and then
disagree with its own name.

**A preflight race.** `flushEvery` means `log()` can fire its own flush, so
preflight's flush found an empty queue and reported storage healthy while the
real write was failing. Now it reads `sinkFailures`, which is the durable
record of what actually happened.

---

## 8. Verification

```
200 tests, 0 failures
50/50 sabotages caught
purity ok (20 core modules) · env-safety ok
demo: landing → preflight → explore run, 6 iterations, 186 events, 25 types
```

Two sabotages missed on the first pass and **both were real findings**, not
faulty tests — the dead `delete` and the untestable workspace check. That is
the third session running in which sabotage verification found something
reading the code did not.

---

## 9. Still open

* **No AI adapters.** The protocol is composed and the parser is ready, but
  nothing sends the prompt to a tab yet. `background.js` Start still refuses
  honestly.
* **`PROTOCOL_VERSION` is not yet checked on parse.** When the contract
  changes, old logs should be interpretable; the version is recorded but
  nothing reads it back.
* **The prompt preview is truncated in the snapshot** but not in the panel —
  a very long first prompt will need a scroll cap.
* **Exploration scores are accepted into `report.scores` but not yet merged**
  into the scorecard by the orchestrator; that wiring lands with the manager
  adapter, which is what normally produces scores.
