# Externally-verifiable facts

Everything in this project that depends on somebody else's platform, checked
against primary sources. **Verified August 2026.** Re-check when Chrome ships a
major version or an AI site redesigns.

---

## Chrome service worker lifetime — one real bug found

Source: [developer.chrome.com — extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

Chrome terminates a worker when **any** of these is true:

| Rule | Consequence here |
|---|---|
| 30s inactivity — any event **or extension API call** resets it (Chrome 110+) | a multi-minute AI wait makes no API calls, so the worker dies mid-wait |
| **a single event or API call exceeds 5 minutes** | 🔴 **this was broken** |
| a `fetch()` takes over 30s | not applicable — no `fetch` in the extension |

### 🔴 The bug

`start` did `await r.start()` **inside the `onMessage` handler**. A run is a
multi-hour loop, so the whole run was one event — and Chrome would have killed
the worker at the five-minute mark, mid-iteration, on the first real run.

It never showed in testing because the simulator completes in milliseconds.

**Fixed:** the handler returns `{started: true}` immediately and the run
proceeds as a detached task. Each adapter call is its own await. A test asserts
`start()` returns in under two seconds.

### 🔴 The timeout sat exactly on the ceiling

`timeoutMs: 300_000` is precisely Chrome's 5-minute limit. A single slow reply
raced the platform's own kill timer and which won depended on scheduling noise.
**Now 240 s** — a timeout should be ours, with our message and our retry, not a
silent worker death. Tested against the constant.

### The keep-alive

During a multi-minute wait the orchestrator makes no API calls, so the 30s idle
timer is never reset. A 20-second `chrome.storage` touch prevents eviction —
**only while a run is in flight**. An unconditional keep-alive is what Chrome's
docs warn against and the Web Store rejects.

---

## `chrome.storage.local` quota

Source: [developer.chrome.com — chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)

- **10 MB** (`QUOTA_BYTES = 10485760`), **5 MB before Chrome 114**, 1 MB before 112.
- Lifted by `unlimitedStorage`, but the implementation slows past ~50 MB.

My claim of "10 MB cap" was correct; the docs now note the version history, so
the comments say so. The architectural conclusion — an append-only log belongs
in IndexedDB — is unchanged and correct.

### Write rate: measured, not assumed

`storage.sync` documents `MAX_WRITE_OPERATIONS_PER_MINUTE = 120`. **`local`
publishes no such constant**, though third-party guidance claims a similar
practical throttle.

Rather than trust either, I measured: a six-iteration run performs **~27 writes
per iteration**, and a real iteration takes minutes because it waits on AI
round trips. That is ~27 writes per several minutes — far below any documented
or rumoured cap.

**No batching layer added.** It would be complexity guarding against a limit
this workload cannot approach. If iterations ever become sub-second (a local
companion running builds directly), re-measure first.

---

## `minimum_chrome_version: 114` — correct

| API used | Since |
|---|---|
| **`chrome.sidePanel`** | **114** ← the binding constraint |
| `storage.local` 10 MB | 114 |
| API calls reset the idle timer | 110 (the heartbeat depends on this) |
| `chrome.scripting` | 88 |
| `chrome.downloads`, `notifications` | ≤31 |

`chrome.alarms` is **not** used, so the Chrome 120 minimum-period change does
not apply.

---

## AI site URL shapes

The Arena patterns already cost a user four failed rechecks, so these were
widened rather than guessed again.

| Surface | Bindable | Deliberately **not** bindable |
|---|---|---|
| ChatGPT | `/c/<uuid>`, `/g/<gpt>/c/<uuid>`, `chat.openai.com/c/<uuid>` | `/`, `/?q=…`, **`/share/<id>`** |
| Arena | `/w/`, `/chats/`, `/session/`, `/threads/`, `/projects/`, `/a/`, `?conversation=`, `#/chat/`, **plus a generic fallback** | `/`, `/chat`, `/login`, `/settings` |
| DeepSeek | `/a/chat/s/<id>` **plus generic fallback** | `/` |

**`/share/` is refused deliberately.** A shared conversation is read-only —
binding to one produces a run that pastes into a page that cannot accept it,
and the failure looks like a broken composer selector rather than the wrong tab.

`chat.openai.com` is kept because it still resolves and redirects; a tab opened
from an old bookmark reports the old host until it navigates.

---

## Confirmed by a real run: Arena's reply selectors do NOT match

**Run `orchestrator-202608081710-9xm`, 2026-08-08.** The engineer reply was
visible on screen. The extension reported *"engineer produced no reply"*.

This upgrades a suspected risk to a **measured fact**: none of the `engineer`
`turns` selectors match Arena's rendered assistant messages. Paste and submit
DO work (events 000018/000019), so the composer and send selectors are good and
only the read path is broken.

The run also exposed a worse structural bug behind it. `send()` has two waits:
phase 3 waits for a first turn to appear, phase 4 waits for it to settle. The
four-hour engineer budget and the progress heartbeat had both been applied to
phase 4 only. So a selector miss — a bug that is *instantly* diagnosable — was
treated as a slow model and waited out for the entire four hours, emitting
nothing. The user pressed retry at 6.5 minutes, which is the correct response
to an interface that appears frozen.

Fixed by separating the two questions:

| Question | Budget | Failure |
|---|---|---|
| Can we see the page at all? | `firstTurnMs` = 90 s | `phase: 'selector-miss'`, names the selectors tried |
| Is the model still working? | `timeoutMs` = 4 h, `silenceMs` = 15 min | `phase: 'silent'` / `'never-settled'` |

Any sign of life — a turn, any text, or a busy indicator — suspends the 90 s
diagnosis budget, so a model that thinks for three minutes before its first
token still gets its full four hours. Both properties are asserted by tests
that were each verified to fail when the guard is removed.

Measured, with a virtual clock: the blind case now fails in **90 s instead of
4 hours**, with a message naming the selectors rather than blaming the model.

---

## Still unverifiable from here

- **DOM selectors** (`#prompt-textarea`, `[data-testid="send-button"]`…) —
  I have no browser, so these remain best-effort. Contained by design: several
  per role, a loud typed error naming which selector missed, completion
  detection that waits longer when it cannot read the busy state, and now a
  90-second blindness check that turns a silent multi-hour hang into a named
  fault. The Arena `turns` list has been widened with the conventional
  patterns, but **widening a guess is not a fix** — the real fix needs a
  surface scan of a live Arena reply and a read of its `selectorCheck` block.
- **Whether driving these sites breaches their ToS** — stated as a risk in the
  README. The adapter boundary exists so an official-API transport can replace
  the DOM one without touching the engine.
