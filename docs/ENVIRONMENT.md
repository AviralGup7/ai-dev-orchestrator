# The Pre-Initiated Environment Contract

> The orchestrator must assume that a fully prepared working environment already
> exists before execution begins.

This document records how that constraint is enforced, what it cost, what was
disproved along the way, and the exact format of the run log.

---

## 1. Why this is code and not a policy paragraph

The obvious way to honour "never open a new tab" is to write it in the README
and trust future-you. That fails the same way telling a language model "do not
write code" fails: it is a **request**.

The project already made this decision once. `docs/SPEC.md` enforces role
separation with a response schema rather than a prompt —

> A prompt saying "do not write code" is a request. A response validator that
> rejects a `patch` field is a guarantee.

The same reasoning applies to the browser. So:

| Concern | Enforcement | Where |
|---|---|---|
| Only inherited-environment verbs exist | Default-deny allow-list, checked on every call | `src/core/actions.js` |
| Tabs/conversations are the *bound* ones | Identity snapshot + re-verify before each action | `src/core/environment.js` |
| No adapter can bypass the check | The guard is the only route to a transport | `src/core/guard.js` |
| No code calls a banned Chrome API at all | Source grep in CI | `tools/check-env-safety.mjs` |
| The engine halts at a phase boundary too | `checkEnvironment()` between phases | `src/core/orchestrator.js` |

The realistic failure here is **not malice**. It is a recovery path written at
speed, because *"the tab died, just reopen it"* is a genuinely tempting thing
to write at 2am. `tabs.create` is banned from the source tree outright so that
version can never be written by accident.

---

## 2. The allowed set, in full

```
focus-existing-tab   read-conversation   paste-prompt   submit-prompt
await-response       copy-response       download-artifact
upload-file          persist-state
```

Read that as the answer to *"what is the worst this extension can do to my
browser?"* — it can move focus between tabs you already had open, type into
them, and move files. It cannot change what those tabs **are**.

### Default-deny, and why the blacklist is only for error messages

An early sketch checked the forbidden list and allowed anything not on it. That
is permission-by-omission: the day Chrome ships `tabs.group` or
`sidePanel.open`, it is allowed because nobody thought to ban it. The
`ALLOWED_ACTIONS` set is the authority; `FORBIDDEN_ACTIONS` exists purely to
turn *"unknown action"* into *"this would change the prepared environment"*.

Sabotage-verified: replacing the final `throw` with `return action` fails
`'the policy is DEFAULT-DENY'`.

### The forbidden verb that is dangerous, and it is not the one you'd guess

`tabs.remove` is not the risk — nobody adds tab-closing by accident. The risks
are **`tabs.reload`** and **`tabs.update({url})`**, because both look like
recovery steps. A refresh destroys an in-flight AI response, sometimes an
unsent draft, and the scroll anchor the scraper was reading from. Recovery is
the user's decision.

`tabs.update({active: true})` *is* legitimate — that is how focus switches. The
CI grep is therefore narrow and honest: it flags `url:` inside a `tabs.update(`
call and leaves the rest to the guard, rather than pretending a regex can tell
navigation from focus across line breaks.

---

## 3. `bind()` and `verify()` — the distinction that carries the whole design

* **`bind()`** runs once, at startup. It snapshots what is open and records an
  **identity** for each surface: which tab id, which conversation id, which
  host.
* **`verify()`** runs before every single interaction, comparing a fresh
  snapshot against that identity.

Without `bind()`, `verify()` has nothing to compare against and collapses into
*"is a ChatGPT tab open somewhere?"* — which is **true even after the user
switched to a different conversation**. Pasting iteration 14 of a project plan
into the wrong chat is exactly the accident this module exists to prevent. The
binding is what makes "the same conversation" a checkable claim.

### Drift kinds, each with a remedy in the log

| Kind | Meaning | Remedy shown to the user |
|---|---|---|
| `tab-missing` | closed or crashed | reopen the tab and rebind, or stop the run |
| `tab-replaced` | same role, different tab id | rebind if intended |
| `navigated-away` | right tab, wrong site | navigate back, then resume |
| `conversation-changed` | right site, wrong chat | switch back, then resume |
| `signed-out` | session lapsed | sign in again in that tab |
| `not-ready` | still loading / no composer | wait, then resume |
| `ambiguous` | two roles on one tab | separate them before resuming |

### Three findings that came out of writing the checks

**A tab with no conversation id is a hard failure, not a detail.** On ChatGPT
and DeepSeek a tab sitting on the "new chat" screen has no conversation id. If
you bind to it, the first paste **creates a conversation** — the forbidden
action happens without any code ever calling something named "create". The
absence of an id is the only signal available before the damage is done.

**Ordering bug: conversation identity must be checked *before* readiness.** A
tab that just switched conversations usually reports `ready: false` as well. If
readiness won, the log would say *"page not finished loading"* — the user
waits, it loads, they resume, and **the run continues in the wrong
conversation**. The more specific finding has to win or the message actively
misleads. There is a dedicated test for the ordering, and sabotaging the order
fails it.

**Two roles on one tab is ambiguous, not clever.** If manager and engineer
resolve to the same tab, the run pastes the plan into the workspace and reads
it straight back as if it were a reply. Both calls succeed. Nothing in the
scoring path can detect it — the evidence is simply the manager's own text.

---

## 4. `blocked` is a distinct status, and that is load-bearing

Environment drift is **not** an iteration failure.

`shouldStop()` treats `status: 'failed'` as *terminal*. If a closed tab were
recorded as a failure, then fixing the tab and pressing Resume would be refused
with *"unrecoverable failure"* — punishing the user for performing exactly the
recovery the failure policy asks of them. It would also read in the log as
"the orchestrator crashed" when nothing broke and no work was lost.

So `RUN_STATUS` gained `blocked`, and `emptyMemory()` gained `block`.

**`block` is persisted, not held in a variable.** The blocking event is usually
"the user closed a tab", and the very next thing they do is often reload the
extension. A reason living only in memory would vanish precisely when it is
needed, leaving a stopped run with no explanation.

### The latch

Once drift is seen, the guard refuses everything until a human calls `clear()`
/ `unblock()`. It does **not** re-check and continue if things look fine again.

The scenario: the user switches conversation on purpose, the run halts, and
later they switch back for an unrelated reason. Auto-resuming would restart an
autonomous run they believe is paused. The stated failure policy is *wait for
user intervention*, and "the tab happens to be back" is not consent.

A blocked run does not even **re-probe** on restart — there is a test asserting
the probe count is unchanged, because probing first and finding it healthy is
an auto-resume wearing a disguise.

### A check that throws is a failed check

`chrome.tabs.get` **rejects** when the tab is gone — which is precisely the
condition being probed. An earlier shape let that exception escape into
`iterate()`'s generic catch, where it became `status: 'failed'`: terminal,
unresumable, and logged as a crash rather than *"you closed the ChatGPT tab"*.
Now the probe's own exception is converted into a drift problem.

### Verified between phases, not once per iteration

An iteration is minutes of real AI time. Any gap between check and act is a
window in which a tab closes and the orchestrator types into whatever replaced
it. There are two independent enforcement points:

* the **guard**, before each individual action, so nothing reaches a wrong tab;
* the **engine**, at each phase boundary, so the halt happens with state saved
  rather than halfway through a paste.

`detect` is deliberately **not** gated: it is pure local arithmetic over
memory, touches no tab, and gating it would skip stagnation analysis for the
partial iteration a drift produced. Tested.

---

## 5. The run log

`src/core/journal.js`. The user's requirement:

> make sure to keep a very detailed log of everything in md file i can copy
> paste to improve extension.

That last clause is a design constraint, not a formatting preference. The log
is **input to the next development session**, pasted into a chat window. Two
consequences are correctness concerns:

**It must never contain a secret.** Anything pasted into a chat is published.
The realistic leak is not our own token — it is the engineer echoing an `.env`
file back inside a summary. So `redact()` runs over the **rendered output**,
not over a hand-picked list of fields, and covers GitHub PATs, `github_pat_`,
Google OAuth secrets, `sk-` keys, Slack tokens, bearer headers, JWTs, and
credentials embedded in URLs.

**It must not lose the beginning of the run.** Chat clients truncate long
pastes silently, from the top — and the top is where the binding and the first
symptom live. So the journal is capped and **drops the middle**, marking how
much it dropped. A conventional ring buffer keeps the newest N, which throws
away exactly the part a reader needs. Sabotage-verified: setting
`keepHead = 0` fails the test.

### Structure

```
# AI Development Orchestrator — Run Log
## Environment (pre-initiated — not created by the orchestrator)   role/tab/host/conversation
## Run state                                                       scope, status, iteration, scorecard
## ⛔ Environment problems (run halted, awaiting the user)          each drift + its remedy
## Timeline                                                        +seconds, iteration, event
## Decisions and strategy changes
## Iterations                                                      objective, evidence, score, signals
```

Environment problems are rendered **above** the timeline: they are the reason
the file was opened. The section ends with the explicit statement that the
orchestrator did not attempt to recover, so a reader debugging a stalled run
does not go looking for a retry that never happened.

---

## 6. Sabotage verification

`tools/sabotage.mjs` breaks the code fifteen ways and asserts a **named** test
notices each one. A test that has never failed is a rumour.

```
15/15 sabotages caught
```

| # | Sabotage | Caught by |
|---|---|---|
| 1 | Guard verifies once, then trusts the environment | verifies before EVERY action |
| 2 | Guard un-latches when the tab looks fine again | LATCHES |
| 3 | Forbidden action checked *after* the transport call | WITHOUT touching the transport |
| 4 | Policy becomes default-**allow** | DEFAULT-DENY |
| 5 | Readiness reported before a conversation switch | even while the page is still loading |
| 6 | Binding accepts a "new chat" tab with no id | would CREATE a chat |
| 7 | Two roles allowed to share one tab | ambiguous, not clever |
| 8 | Missing required tab tolerated | refuses to bind |
| 9 | Drift recorded as a terminal failure | NOT a failure |
| 10 | Block reason kept in a variable, not the store | PERSISTED |
| 11 | Blocked run silently re-probes and resumes | refuses to restart until a human |
| 12 | Environment checked once per run, not per phase | halts at the next phase boundary |
| 13 | A throwing probe counts as a pass | THROWS is a failed check |
| 14 | Journal keeps newest, drops the start | drops the MIDDLE |
| 15 | Journal renders scraped text unredacted | RENDERED log |

Run it: `npm run sabotage`.

---

## 7. Suspicions that were disproved, kept on the record

* **"The purity checker will reject `environment.js` because it is about
  tabs."** It did not, and the reason is the point: the module consumes plain
  **snapshot objects** a transport produced. It never touches `chrome.*`. The
  rule about tabs is testable without a browser, which is why all 22
  environment tests run in plain Node.
* **"`blocked` can just reuse `paused`."** It cannot. `paused` is a user
  decision with a healthy environment; `blocked` is an unhealthy environment
  the user has not yet acknowledged. Collapsing them would let Resume restart a
  run into a tab that is still wrong.
* **"Checking before every action is wasteful."** Measured shape: a check is a
  URL and conversation-id read. The thing it prevents — a prompt pasted into
  the wrong conversation — is unbounded. Kept.

---

## 8. Still open

* No `manifest.json` / transport yet, so `snapshot()` has no real
  implementation — the contract is enforced and tested, but nothing drives a
  browser yet. That is deliberate: the boundary was built before the thing that
  will use it, so the thing that uses it has no choice.
* `bind()` is called by the extension shell, which does not exist. When it
  does, the surface hosts belong in configuration, not in code.
* Rebinding after a legitimate change (the user *meant* to switch workspace)
  needs an explicit UI affordance. Today the only path is stop and start again.

---

## 9. Two bugs the sample log found that the tests did not

`tools/sample-log.mjs` drives the real orchestrator against fakes, drifts the
environment on purpose, and writes `docs/SAMPLE-RUN-LOG.md`. It was written to
review the *format*. It found two behavioural bugs instead, both invisible to a
green suite.

**The same drift was logged twice.** Both the phase gate and `iterate()`'s
catch block handled the same exception, and both called `block()`. In the
rendered log that reads as two separate incidents — so the reader concludes the
orchestrator *retried*, which is the single behaviour this subsystem promises
never happens. The log was actively arguing against the design it documents.
Fixed by making the catch block re-block only if the gate had not already;
`'a single drift is logged ONCE'` now counts the events.

**A drift in iteration 3 was filed under iteration 2.** Same root cause as the
three mid-iteration events fixed during the walking skeleton:
`memory.iteration` is the *completed* count and lags until an iteration ends.
The timeline printed `i2` on the same line as `where=iteration 3 / execute` —
contradicting itself within one line of text. `iteration` is now threaded
explicitly through `block()`, and `iteration-started` labels itself too.

Neither was caught by a test because no test counted events or checked their
labels. Both are now asserted. The general lesson, consistent with everything
else in this project: **render the artefact and read it.** A log is a
deliverable, and deliverables need looking at, not just asserting on.
