# Surface scans

> When an error is logged, capture the page in detail and attach it to the log,
> so whoever works on it next inherits the scene rather than a one-line symptom.

An error says *that* something failed. The *why* is almost always on the page —
the composer moved, the send button went disabled, a rate-limit banner
appeared, the tab was backgrounded — and by the time anyone reads the log, that
page is gone.

## What it produces

```
**Captured because:** `response-timeout`

**Changed since the last capture:**
- page now says: You have reached your usage limit for today. Your limit resets at 18:00 UTC.
- textarea[composer] @ main > form > div[composer] > textarea: became disabled
- button[send-button] @ main > form > button[send-button]: became disabled
- appeared: div[rate-limit-banner] @ main > div[rate-limit-banner]
- vanished: button[stop] @ main > button[stop]

### Surface scan — engineer @ 2026-08-08T12:45:00.000Z
- readyState: `complete` · visibility: `visible`
- DOM: 6210 elements, 3 inputs, 22 buttons, 0 iframes

**Page is saying:**
- You have reached your usage limit for today. Your limit resets at 18:00 UTC.

| element | state | label / text |
|---|---|---|
| `textarea [data-testid=composer]` | disabled, editable | Message Arena… |
| `button [data-testid=send-button]` | disabled | Send |
```

That is a diagnosis, not a dump. Full worked example:
[`sample-surface-scan.md`](sample-surface-scan.md).

---

## It is a summary, not `outerHTML`

The obvious implementation is to grab the whole page. It is also useless: a
chat page is tens of thousands of nodes of minified class soup, it would
exhaust the log's storage within a handful of errors, and pasting it into a
model burns thousands of tokens to convey almost nothing.

The question a scan must answer is *"why did the automation get stuck"*, and
the answer is nearly always one of five things. So the scanner collects exactly
those:

| Captured | Because |
|---|---|
| `role="alert"`, `aria-live`, banner/error classes | this is where "You've reached your usage limit" lives — it often explains the failure outright |
| interactive elements + `disabled` / `hidden` | a disabled send button *is* the bug |
| bounding boxes | "the button is at y=-400" explains a click that silently did nothing |
| `readyState`, `visibilityState` | a backgrounded tab throttles timers and defers layout |
| `iframes` count | a silent cause of "the selector matched nothing" |

Signals are rendered **first**. A reader who sees the rate-limit sentence does
not need the element table at all.

---

## The loop this could have been

The trigger is *"an error was logged"*. A scan that fails **logs an error**.
That error triggers a scan. Because the log "must never silently discard
events", the extension would faithfully fill IndexedDB with failure reports
about its own failure reports until the quota died.

Three defences, because one is not enough for a loop that writes to disk:

1. **`NEVER_SCAN`** — `surface-scan` and `surface-scan-failed` can never
   trigger a scan.
2. **A reentrancy latch** — `busy` blocks a scan while one is in flight.
3. **A per-surface cooldown** (30s) — a stuck automation retries, and five
   retries in ten seconds would produce five near-identical captures that bury
   the first.

Plus a session budget of 20. Tested by making `executeScript` throw and
asserting the log grows by exactly two entries, not without bound.

**Not every error is scanned.** A storage-quota failure has nothing to do with
the DOM; scanning for it spends budget a real UI failure will need later.
`SCAN_WORTHY` is an allow-list.

---

## The leak this could have been

A scan copies whatever is on screen into a log the user is *encouraged to paste
into a chat window*. Whatever is on screen includes the AI's output — and an
engineer asked to fix CI will happily echo back the `.env` file it just read.

`boundCapture()` runs every string through the same `redact()` the journal
uses: GitHub PATs, `GOCSPX-` secrets, `sk-` keys, Slack tokens, bearer headers,
JWTs, and credentials embedded in URLs. The journal then redacts **again** on
the way out, so a capture that reached the log by some future path that forgets
still cannot leak through the export.

---

## Bounding

400 nodes, 24 KB rendered, 400 chars per text run, depth 12. When the size cap
bites it **drops nodes and keeps the signals** — truncating the document from
the end would cut off the sentence that explains the failure, which is the
opposite of useful. Whatever was dropped is stated.

---

## The `scripting` permission is back

I removed it one session ago on the grounds that nothing called it and an
unused permission inflates the install prompt for no benefit. Surface scanning
calls it — `chrome.scripting.executeScript` is how a page is read.

The reasoning has not changed, only the facts. So the build no longer strips it
*unconditionally*; it greps the source for `chrome.scripting` and keeps the
permission only if something actually uses it. The manifest cannot drift from
the truth in either direction, and the justification is checked rather than
commented.

**The scanner never writes to the page.** No click, focus, scroll,
`dispatchEvent`, or style mutation — asserted by a test that greps for each. A
diagnostic that perturbs the thing it is diagnosing is worse than no
diagnostic, and this one runs precisely when something is already wrong.

---

## Diffs

The second failure on a surface is far more informative as a diff. "The send
button became disabled and a rate-limit banner appeared" is a diagnosis; two
full captures are two haystacks compared by eye.

An **identical** capture is itself the finding, and says so: *"Identical to the
previous capture of this surface — the page is stuck."*

---

## Verification

```
247 tests, 0 failures
71/71 sabotages caught
purity ok (21 core modules) · env-safety ok
dist/ loadable — 37 files, worker evaluates and answers
```

End-to-end in the real worker: an error logged → one `executeScript` call → a
`surface-scan` event on the `evidence` channel, correlated back to the error,
carrying the page's own words.

### A sabotage that found a weak test

Removing the `SCAN_WORTHY` allow-list left the suite green. The test's example
was `state-saved` — which is *also* in `NEVER_SCAN`, so the earlier guard
rejected it and the branch under test was never reached. Changed to
`crash-recovered`, an error type that is merely not-page-level and not
separately banned. That is the fourth session running where sabotage found
something reading the code did not.

---

## Still open

- **Same-origin frames are not scanned.** The iframe *count* is reported, which
  is enough to explain "the selector matched nothing", but the frame's contents
  are not walked.
- **No screenshot.** `captureVisibleTab` would need the `<all_urls>` permission
  and produces something no model can grep. The structured summary is more
  useful per byte; this may be worth revisiting for genuinely visual failures.
- **The budget resets on service-worker eviction** — it lives in memory, so
  "20 per session" is really "20 per worker lifetime". `ScanBudget` is an
  explicit object so it can be persisted without redesign.
