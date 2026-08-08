# Adapters

An adapter turns a role's intent into a conversation and the reply back into
validated data. It owns the prompt, the schema and the retry policy — and
nothing else. It never knows which tab it is talking to.

```js
transport.send({ prompt, surface, timeoutMs }) → { text }
```

The simulator and the DOM transport implement exactly this, which is what makes
an official-API transport a later drop-in rather than a rewrite.

## Why retries live here

`orchestrator.js` deliberately does not retry: *"if the manager is returning
malformed responses, retrying produces the same malformed response and burns the
budget."* An adapter can tell the cases apart; the engine cannot.

| Failure | Response | Why |
|---|---|---|
| timeout | retry the send once | the AI may just have been slow |
| schema violation | **one** reprompt carrying the error | a model that ignored an explicit schema error twice will not comply on the third ask |
| transport failure | propagate immediately | a closed tab fails identically next time |

## Role boundaries are structural

| Role | May | Cannot — fields dropped before the engine sees them |
|---|---|---|
| Manager | plan, evaluate | `patch`, `code`, `command`, `files`, `apply` |
| Engineer | execute, report | `nextObjective`, `strategy`, `projectComplete`, `overallScore` |
| Reviewer | advise | `patch`, `scores`, `stop`, `projectComplete` |

Dropped, not rejected: failing a whole response because ChatGPT attached a patch
would lose a good plan over one key, and the model will keep doing it. What was
dropped is recorded, because *"the manager keeps trying to write code"* is a
fact worth seeing.

## The engineer is different

It does **not** reprompt on a malformed report. Re-asking ChatGPT to reformat
costs one cheap round trip; re-asking Arena costs it **running the work again** —
another build, another suite, possibly another commit.

Instead it **salvages**: the terminal output is usually still in the reply, and
`1276 passed, 0 failed` is a real observation regardless of the JSON around it.

It also cross-checks. `taskStatus: "complete"` alongside three failing tests is
reported as `partial`, because the prose is generated to satisfy the request
while the numbers are copied from a terminal. When they disagree, the numbers
win, and the contradiction goes on the record.
