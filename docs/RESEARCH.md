# What the field has learned, and where this project stands

Research conducted August 2026 against published benchmarks, failure taxonomies,
post-mortems and comparable projects. Every claim about *this* codebase below
was checked by running it, not by reading it.

The uncomfortable summary: **the architecture holds up well against the
literature, and the two most serious problems the field reports are ones this
project has only partially addressed.**

---

## 1. The failure taxonomy — measured against us

SWE-Bench Pro, SWE-EVO and DeepSeek's failure audits converge on a consistent
list of how coding agents fail. Scoring honestly:

| Documented failure | Frequency reported | Our defence | Verdict |
|---|---|---|---|
| **Stuck in loop** / endless file reading | Sonnet 4: 17% of failures | six-signal detector, threshold 2 | ✅ covered |
| **Context overflow** | Sonnet 4: **35.6%** — its top failure | `recentHistory()` keeps 3 full + one-line summaries | ⚠️ **weak — see §3** |
| **Instruction following** — solving the wrong task | GPT-5: **>60%** of failures | acceptance criteria in the plan, never checked afterwards | 🔴 **gap — see §2** |
| **Wrong solution** (semantic) | Opus 4.1: 35.9% | evidence-based scoring | ✅ partly — tests catch it |
| **Syntax error** | Opus 4.1: 24.2% | build evidence caps all scores at 50 | ✅ covered |
| **Regression** — breaks working code | a named DeepSWE verdict tag | none — see §4 | 🔴 **gap** |
| **Gave up prematurely** | named in SWE-EVO | `taskStatus: partial` recorded | ✅ visible |
| **Over-optimism / "numerical duct tape"** | Bubeck et al., "p-hacking and eureka-ing" | the entire confidence model | ✅ **our strongest area** |

Two rows are red. Both are fixable and neither is architectural.

---

## 2. 🔴 The largest gap: acceptance criteria are collected and never used

Instruction-following is **the top failure mode for the strongest models** —
over 60% of GPT-5's failures on SWE-EVO. The agent does excellent work on the
wrong task.

`schema.js` already extracts `acceptance: string[]` from every plan. Nothing
ever compares the result against it. The loop is:

```
plan (with acceptance criteria) → execute → score the RESULT
                                             ↑
                            never asked "did it do what was asked?"
```

An engineer that fixes a different bug than the one requested, well, scores
well. Testing rises, the build is green, the scores go up — and the objective
was not met.

**Proposed fix.** A tenth pseudo-dimension, `objective-met`, computed at
evaluation: the manager is asked *specifically* whether each stated acceptance
criterion is satisfied, given the evidence. Cheap (it is already in the same
call), and it makes the most common failure of frontier models visible.

Stronger version, worth considering: make it a **mandatory** dimension in
`stop.js`. A run cannot complete while the last iteration failed its own
acceptance criteria.

---

## 3. ⚠️ Context management is the #1 failure of a frontier model, and ours is naive

Sonnet 4's single largest failure category is context overflow (35.6%).
Lilian Weng's harness survey names the pattern that works:

> The entire execution history is accessible via a **file system**, and the
> coding agent uses `grep` or `cat` to read through it instead of shovelling
> everything into a single prompt context.

Ours is `recentHistory(full = 3)` — the last three iterations verbatim, older
ones as one line each. That is better than nothing and it is **fixed-size in
iterations, not in tokens**. Three iterations with large diffs and long
engineering reports can be enormous; twenty trivial ones are tiny.

**Proposed fix, in order of value:**

1. **Budget by characters, not by count.** Trim to a token budget, dropping
   oldest-first, and *say in the prompt how much was dropped*. Currently a
   silently truncated context looks identical to a short history.
2. **Let the engineer retrieve.** The full history already lives in IndexedDB.
   A `history(n)` affordance in the protocol — "ask for iteration 7's report if
   you need it" — is the file-system pattern adapted to a chat transport.
3. **Summarise on a schedule.** DeepSeek already reviews every N iterations and
   already sees the trajectory. Have it emit a running project summary that
   replaces the one-line list.

---

## 4. 🔴 Regression is invisible, and a score crash is mislabelled

DeepSWE lists `FAIL_REGRESSION` — *"agent breaks functionality that already
worked"* — as a distinct verdict, and my own analytics module computes a
regression rate. **The loop does not act on it.**

Worse, I ran the case:

```
overall 82 → 60 → 41    reported as: "no-progress: only -41.0 points"
```

A catastrophic regression is reported as *insufficient improvement*. The number
is right and the label is actively misleading — the operator reads "it stalled"
when the truth is "it destroyed the project".

**Proposed fix.** A `regression` stop reason, checked before `no-progress`:
if the overall score has fallen by more than the epsilon, stop with
*"the project got measurably worse: 82% → 41%"*. Cheap, and it turns the most
alarming possible outcome from a shrug into an alarm.

Related and larger: **there is no revert.** Arena commits, so `git revert` is
available in principle. A stop condition that says "you are worse than five
iterations ago and here is the SHA that was good" would be genuinely valuable
and is not implemented.

---

## 5. ⚠️ Self-preference bias — partially avoided by luck

The literature is emphatic and quantified:

> GPT-4 favoured itself with a **10%** higher win rate; Claude with **25%**.
> *Mitigation: use a judge from a different model family than the generator.*

Our structure is accidentally good here: **ChatGPT evaluates work that Arena
wrote.** Different provider, so no self-preference on the code itself.

But two problems remain:

- **ChatGPT evaluates its own plan's success.** It set the objective, then
  judges whether the objective was met. That is self-enhancement bias at the
  planning level, and the fix in §2 makes it *more* acute, not less.
- **Score compression / mean reversion.** Judges cluster scores in a narrow
  band (typically 7–8 of 10). Our nine dimensions on a 0–100 scale are wide
  open to this, and the simulator shows exactly that pattern: asserted
  dimensions sitting at 55–70 forever.

**Proposed fix.** Have **DeepSeek** — already a different family, already
reviewing every N iterations — audit the manager's scorecard rather than only
the trajectory. It cannot set scores (`schema.js` drops `scores` from reviewer
responses, correctly), but it can flag *"testing is measured at 90 while three
tests have failed for four iterations"*. A cross-family check on the evaluator
is the single highest-value use of the third model.

---

## 6. ⚠️ No cost control — the AutoGPT lesson, unlearned

Every retrospective names this:

> Costs spiralled (recursive LLM calls compound fast) … production systems need
> **per-operation cost controls**, not hope that costs stay reasonable.

We bound **iterations** (`maxIterations`) and nothing else. One iteration is
3–4 AI calls, and a stalled run can burn a rate limit before the iteration
counter moves — the reprompt path alone can double manager calls.

`analytics.js` honestly reports cost as `unknown`, which is correct for a
browser transport. But *unmeasurable* is not the same as *unbounded*.

**Proposed fix.** Count what we *can* count, which is calls:

- `maxCallsPerRun` and `maxCallsPerIteration` in `stop.js` DEFAULTS;
- a visible per-run call counter in Mission Control;
- treat a rate-limit page signal (the surface scanner already detects
  "You have reached your usage limit") as a **pause**, not an error — the
  scanner sees it and nothing acts on it.

That last one is nearly free: the detection already exists.

---

## 7. 🔴 `failedAttempts` is a dead field

`emptyMemory()` declares it, `phasePlan` passes it to the manager, and
**nothing ever writes to it.** The manager receives an empty array forever.

This is precisely the mechanism the "accumulated behavioural rules" literature
identifies as the difference between an agent that learns and one that does
not:

> Every accepted review comment is codified as a persistent behavioural rule …
> the agent will reproduce the same mistake in the next session because it has
> no mechanism to retain that correction.

We have the field, the plumbing and the prompt slot. We just never fill it.

**Proposed fix.** On a failed or contradicted iteration, append
`{iteration, objective, whatFailed, evidence}`. The plan prompt already
receives it. This is perhaps two hours of work for the single largest
qualitative improvement available.

---

## 8. Where we are genuinely ahead

Worth stating plainly, because the gaps above are the interesting part but not
the whole picture.

**Evidence over claims is better here than in most published work.** The
"over-optimism" failure — Bubeck's *"numerical duct tape … declare victory when
signals are still noise"* — is the one this project attacks hardest, and the
`measured/inferred/asserted` model with two independent gates on
`target-reached` is a stronger answer than anything in the surveyed
literature. Most self-improving-agent frameworks score themselves and believe
the result.

**Role separation by schema rather than prompt** matches the field's
conclusion (*"validation and retry loops, not trust that outputs are
correct"*) and goes further than most: we drop the capability rather than
asking politely.

**Sabotage verification (106 mutations)** has no equivalent in any project
found. The nearest analogue is mutation testing, which almost nobody applies
to agent scaffolding.

**Honest unknowns.** `analytics.js` returning `basis: 'unknown'` for cost and
token efficiency is unusual — the norm is a plausible number.

---

## 9. The uncomfortable strategic finding

From SWE-bench 2026 analysis:

> The bottleneck in coding agent performance is **not the scaffolding** but the
> underlying model's ability to reason about code and use a shell. Complex
> agent frameworks with rich tool ecosystems may be **overengineered** relative
> to what current models can actually leverage.

`mini-swe-agent` — a deliberately minimal harness — is competitive with
elaborate frameworks. Karpathy's autoresearch ran 700 experiments in two days
on **630 lines**.

And from a practitioner who built what we built:

> I realised I was spending more time maintaining the optimisation system than
> running the actual operation.

**This does not invalidate the project**, because our value proposition is not
"a better scaffold makes the model smarter". It is *judgement* — knowing when
to stop, refusing to believe unearned numbers, staying under human control.
Those are orthogonal to model capability and do not get cheaper as models
improve.

But it does argue against adding features. The right next moves are §2, §4,
§6 and §7 — all of which *remove* a way to be wrong rather than adding a
capability.

---

## 10. Platform and legal reality — worse than the README implies

The README says browser automation is "likely contrary to their terms of
service". Research shows this is understated.

**OpenAI's position is explicit and split.** From their own developer forum:

> You are permitted to automate or simplify interactions with the ChatGPT UI …
> **However, automatically extracting model outputs is not allowed.** In such
> cases, you should develop a solution using the API.

Typing and clicking is tolerated. **Reading the response back — which is the
entire point of this orchestrator — is the prohibited part.** Enforcement is
documented: account warnings, suspensions, permanent bans, IP blacklisting.

**The ecosystem context is actively hostile.** In 2026 alone: 16+ malicious
extensions stealing ChatGPT session tokens; two with 900k installs exfiltrating
conversations via DOM scraping every 30 minutes; Google removed 18 AI
extensions for overbroad permissions. **A legitimate extension that injects
scripts into `chatgpt.com` and reads conversations is behaviourally
indistinguishable from those**, both to automated Web Store review and to
enterprise security tooling.

**What this means concretely:**

1. **The Chrome Web Store is likely closed to this** in its current form.
   Distribution is unpacked/developer-mode, or an enterprise policy install.
2. **The user's ChatGPT account is at genuine risk**, not theoretical risk.
   The README should say so in those words.
3. **The adapter boundary is now the most valuable thing in the codebase.**
   An API transport for the manager and reviewer would be compliant, cheaper,
   more reliable, and would eliminate the DOM selectors — the one part I could
   never verify. Arena is the only role that genuinely needs a browser, because
   it needs *its* sandbox.

**Recommendation:** make the API transport the default path and the DOM
transport the fallback, not the reverse. The architecture already supports it;
this is a configuration and documentation change, not a rewrite.

---

## 11. Prioritised

| # | Change | Effort | Why |
|---|---|---|---|
| 1 | Write `failedAttempts` | ~2h | dead field; largest learning gain |
| 2 | `regression` stop reason | ~2h | a crash is currently labelled "no progress" |
| 3 | Act on the rate-limit signal | ~2h | the scanner already detects it |
| 4 | Check acceptance criteria | ~half day | the #1 frontier-model failure |
| 5 | Call budget, not just iterations | ~half day | the AutoGPT lesson |
| 6 | Token-budgeted context | ~1 day | the #1 Sonnet failure |
| 7 | Reviewer audits the scorecard | ~1 day | cross-family check on the evaluator |
| 8 | API transport for ChatGPT/DeepSeek | ~2 days | ToS, reliability, kills the selectors |
| 9 | Revert-to-good-SHA | ~2 days | nothing recovers from a bad run |

1–3 are small and each removes a way to be silently wrong. I would do those
first regardless of what else is chosen.

---

## Sources

Chrome/platform facts are in [`VERIFIED-FACTS.md`](VERIFIED-FACTS.md).

- SWE-Bench Pro (Scale AI, 2025) — failure taxonomy, context overflow 35.6%
- SWE-EVO (arXiv 2512.18470) — instruction-following >60% for GPT-5
- DeepSWE (arXiv 2607.07946) — verdict tags, cheating via `.git` history
- OpenAI, *Why we no longer evaluate SWE-bench Verified* — 59.4% flawed tests
- Lilian Weng, *Harness Engineering for Self-Improvement* (2026-07)
- JudgeBiasBench / RAND Judge Reliability Harness (2026) — >50% error rates
- Eugene Yan, *Evaluating LLM-Evaluators* — self-preference 10%/25%
- *What AutoGPT Taught Me About Production AI Agents*
- OpenAI Developer Forum — UI automation permitted, output extraction not
- CSA, *AI Browser Extensions: Shadow AI's Hidden Attack Surface* (2026-04)
