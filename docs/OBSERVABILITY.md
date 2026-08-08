# User Control & Observability

> The orchestrator must never operate as a hidden background process.

This records how the five questions are answered, the contradiction this
objective created with an earlier decision, the four decisions taken, and the
bugs found along the way.

---

## 1. The five questions, and where each is answered

| Question | Answered by | Surface |
|---|---|---|
| What is it doing right now? | `status.currentStep()` | Live Status Panel |
| Why is it doing it? | the current objective, carried on every step | the `why` line under the step |
| What happened previously? | `Logger` + durable sink | Activity Log |
| What will happen next? | `status.whatNext()` | "Next" row |
| Can I stop or change it? | `controls.availableControls()` | always-visible button row |

All five are **derived**, never stored. A `currentStep` field written by each
phase is a second source of truth, and its failure mode is specific: the field
is set when a phase begins and not cleared when the phase throws, so after a
crash the panel cheerfully reports *"Waiting for Arena response"* forever.
Deriving from the log means the panel cannot claim something the record does
not show.

---

## 2. The contradiction, and how it resolved

> "The log must never silently discard events."

Last session's `journal.js` caps at 2000 events and **drops the middle**. That
was right for what the journal is — a markdown document pasted into a chat
window, where exceeding the context window is a real failure. It is wrong as a
system of record: a fifty-iteration run logging every tab switch, copy, paste
and wait is plausibly tens of thousands of events.

Resolved as **two tiers** (your decision):

| Tier | What | May it drop? |
|---|---|---|
| 1 — record | `Logger` → `IdbLogSink` (IndexedDB + `unlimitedStorage`) | **Never** |
| 2 — view | `logger.live` ring, and the markdown journal | Yes, and it says so |

**A view may forget; a record may not.** The live panel renders a banner —
*"25 earlier events not shown in this view — all of them are in the export"* —
so the boundedness is stated rather than hidden. Sabotage-verified: removing
that banner fails a named test.

`chrome.storage.local` was rejected for the log: a 10 MB cap (5 MB before
Chrome 114), and it is a key/value store that must be rewritten wholesale, so a
60k-event log means re-serialising megabytes on every flush. `unlimitedStorage`
lifts the quota but the implementation slows past ~50 MB. IndexedDB appends.
*Verified against developer.chrome.com, August 2026.* `chrome.storage`
is still right for the *memory* object, which is small and rewritten at every
phase boundary.

### The failure path is the whole guarantee

A sink that always works cannot demonstrate "never discard". `FlakyLogSink`
exists to fail on demand. When `append` rejects, the batch stays in `pending`
and is retried on the next flush, and the failure is recorded in
`sinkFailures` and surfaced in the session summary. Dropping there would be
the exact silent discard — and it would happen at the worst possible moment,
since the likeliest cause of a storage failure is a quota exhausted by a very
long run, i.e. the run with the most to lose.

A throwing UI subscriber also cannot lose an event: `onEvent` is called inside
a `try`, because the log is the system of record and the panel drawing it is
not.

---

## 3. Event ids: a counter, not a timestamp or a UUID

The requirement is that a workflow can be **replayed or audited**. That needs a
*total order*.

* `Date.now()` does not provide one — last session's sample log had nineteen
  events sharing a millisecond.
* A UUID is unique but unordered, so a replay would have to trust array
  position, which is what gets lost when a log is exported, filtered and
  re-imported.

So: `evt-<session>-<000123>` — unique, lexically sortable, readable in a bug
report, and rendered on every log row for quoting.

**This design note was written and then immediately not used**, which produced
a real bug — see §7.

---

## 4. `pending` is a status, and `begin()` is why

"Waiting for AI response" is an event that has *started* and has no outcome
yet. Without a pending status it must either be logged at the start (and lie
about being a success) or at the end — in which case the Activity Log sits
motionless for the several minutes an AI takes, which is exactly when the user
suspects a hang.

`logger.begin(type, …)` emits the pending entry immediately and returns a
closer that stamps the duration. Unclosed events are visible via
`openEvents()` and reported in the session summary as *"N steps never reported
an outcome"* — because "0 errors" while three steps hang is the kind of quiet
lie this project treats as a bug.

---

## 5. Skip: permitted, and it poisons the record

`Skip Current Step` can break the evidence guarantee. Skip `execute` and the
manager evaluates work that never happened; skip `evaluate` and the iteration
produces no scores.

Your decision, implemented: **you may skip, but you may not skip your way to
"done".** The iteration is permanently marked `skipped: ['execute']`, and
`stop.js` refuses to declare victory when the *deciding* iteration skipped an
evidence phase.

Two details that matter:

* **Only the deciding iteration is checked.** Failing the whole run for a skip
  twenty iterations ago would make Skip useless — and users route around
  useless controls by stopping, editing state and restarting, at which point
  the record does not show the skip at all. Permitting-with-consequence keeps
  it visible.
* **Skipping `review` poisons nothing.** Reviews produce no evidence.

The skip is logged as a **warning** whose description states the consequence:
*"you skipped the execute phase of iteration 7 — its scores cannot end the
run"*. The consequence is visible at the moment it happens, not buried here.

`Skip` skips the **next** phase, not the current one. By the time a user can
press the button the current phase is already awaiting an AI that will answer
regardless; claiming to cancel it would be a lie in the log while its result is
visibly being used.

---

## 6. Popup *and* side panel

You chose both, and the reasoning is Chrome's lifecycle: **a popup is destroyed
the instant it loses focus**, and this orchestrator's normal operation is
switching between the ChatGPT, Arena and DeepSeek tabs. A popup-hosted Activity
Log would be visible only while nothing was happening.

* **Popup** (`popup.html`) — live status + controls + "Open Activity Log →".
* **Side panel** (`sidepanel.html`) — the real surface, opens on the Activity
  Log tab, stays open during the run.

Neither owns the run. The **service worker** does, so closing a panel cannot
abort a multi-hour job. MV3 evicts idle workers after ~30s, which is not an
edge case here — the orchestrator spends most of its life waiting. Hence:
memory persists at every phase boundary, the log is durable, and on wake the
live view is **rehydrated from the sink**, because a panel showing an empty log
for a two-hour-old run looks exactly like total data loss.

---

## 7. Bugs found by tests and by rendering, not by reading

**`currentAI` named ChatGPT during local loop detection.** `detect` maps onto
the *evaluate box* in the diagram (it has no box of its own), and the AI was
read off the stage. So the panel said "ChatGPT" while the extension was doing
arithmetic on its own — a small lie with a real cost: the user goes to that tab
to see what it is thinking and finds nothing happening.

**Error resolution compared timestamps, so nothing was ever resolved.** A
failure and the retry that fixes it routinely land in the same millisecond, so
`x.at > e.at` found nothing and every resolved error stayed red forever — a
six-hour run becomes a wall of red the user learns to ignore, which is how a
real failure gets missed. Fixed by comparing **event ids**.

This is the interesting one: the sortable-id design note in `events.js`
describes this exact hazard, and the bug shipped anyway, because the ordering
problem was solved in one module and then not used in another. A written
rationale does not enforce itself.

**The demo bundle was a hard `SyntaxError`.** `environment.js` exports
`describe`; `bridge.js` declared its own. Both are legal in ES modules, which
scope per file — and a hard error once concatenated into one scope. The full
149-test suite stayed green because tests import modules properly.
`tools/build-demo.mjs` now runs `node --check` on the bundle and fails the
build. A build that writes a broken file and prints "wrote demo.html" is worse
than one that fails.

**The demo claimed to show an imperfect run and didn't.** `stagnation-detected`
and `strategy-changed` never fired — the scripted objectives were too dissimilar
to trip the loop detector. A green demo exercises the parts of the UI that
matter least. The script now stalls deliberately in the middle, and
`tools/smoke-demo.mjs` asserts all nineteen interesting event types appear, so
it cannot silently regress again.

---

## 8. Verification

```
149 tests, 0 failures
34/34 sabotages caught        npm run sabotage
purity ok                     16 core modules, no browser dependencies
env-safety ok                 no tab creation, navigation, refresh, sign-in
demo ran 6 iterations, 188 events, 24 distinct types, all 4 tabs rendered
```

New sabotages in this batch include: the sink writing only part of a batch, a
failed write dropping the batch, the view dropping events uncounted, event ids
becoming timestamps, an unmapped engine event vanishing, a skipped phase no
longer blocking completion, an *old* skip poisoning later iterations, controls
being hidden instead of disabled, log entries rendered unescaped, and the
health percentage shown without its evidence fraction.

Two of the first drafts did **not** fire, and both were faults in the sabotage
rather than the test: one patched an anchor whose indentation had moved, and
one capped a buffer that `flushEvery` drained before the cap could bite. Worth
recording — a sabotage harness needs the same scepticism as the tests it
checks.

---

## 9. Rendering is tested, because the UI can undo the safeguards

Two of the project's guarantees live or die in the view layer:

* **Escaping.** The Activity Log renders objectives, filenames, error text and
  raw model output. An AI asked to fix a bug will happily echo back whatever
  was in the file it read.
* **The health number.** A bare "82%" in a large font re-introduces exactly the
  flattery `scoring.js` is built to prevent. `renderStatus` always prints the
  measured fraction beside it, and marks a wholly-asserted score in amber.

Both are asserted by tests and both sabotages are caught.

---

## 10. Still open

* **No AI adapters.** `background.js` Start refuses honestly — it logs an error
  saying no adapters are registered — rather than doing nothing. A Start button
  that silently no-ops is the hidden-background-process failure in miniature.
* **Notifications are wired but unexercised**, since nothing long-running runs
  yet.
* **"Open Project Folder"** is marked future in the spec and is absent.
* **"View Latest Report"** logs a warning that it is not implemented rather
  than failing silently.
* **The side panel has no icon asset** — `manifest.json` references
  `icon128.png` for notifications only; add before loading unpacked.
* **Replay is possible but not built.** The log has ordered ids and typed
  events, which is the hard part; a replay driver is not written.
