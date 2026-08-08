# Event taxonomy

Every meaningful action produces a structured event. The log is the system of
record; the panel is a view of it.

## Schema

```js
{
  id,            // evt-<session>-<000123> — unique AND sortable
  at,            // epoch ms
  type,          // from the closed vocabulary in core/events.js
  channel,       // lifecycle · user · automation · ai · evidence · system · error
  source,        // user · extension · chatgpt · arena · deepseek · system
  status,        // success · warning · error · pending
  label,         // human name
  description,   // a sentence a non-author can act on
  durationMs,    // null when instantaneous or still running
  iteration,     // null outside an iteration
  phase,
  data,          // type-specific
  correlationId  // links a completion back to the pending event it closes
}
```

**Ids are counters, not timestamps or UUIDs.** Replay needs a total order.
`Date.now()` does not provide one — a sample log once had nineteen events in one
millisecond — and a UUID is unique but unordered. This exact hazard produced a
real bug: the error center used `x.at > e.at` to decide whether a failure was
resolved, and a failure plus its fix landed in the same millisecond, so every
error stayed red forever.

**`pending` is a real status.** "Waiting for AI response" has started and has no
outcome yet. Without it, a wait is either logged at the start (and lies about
succeeding) or at the end (and the panel sits motionless for the five minutes
the user most suspects a hang).

## Two tiers

| Tier | What | May it drop? |
|---|---|---|
| record | `Logger` → IndexedDB | **never** |
| view | `logger.live` ring, markdown journal | yes, and it says so |

A view may forget; a record may not. The panel renders *"25 earlier events not
shown — all of them are in the export."*

A failing sink **retains** the batch and retries; the likeliest cause is a quota
exhausted by a long run, i.e. the run with the most to lose.
