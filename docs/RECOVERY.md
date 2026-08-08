# Failure recovery

## The contract

| Failure | Action | Why |
|---|---|---|
| AI timeout | retry send once, then retry the run | may be transient |
| Malformed response | one schema-aware reprompt, then pause | a third ask will not help |
| Network loss | pause, persist, wait | resuming into a dead network re-fails |
| Browser reload | resume from the last completed phase | phases are idempotent |
| Tab closed | **pause and tell the user** | never replace the environment |
| Unexpected navigation | detect, pause | the conversation is no longer the bound one |
| Repeated failure | **stop** after 3 consecutive | pausing invites a fourth failed resume |
| Partial phase | never re-execute | Arena would redo the build and re-commit |

## Why "consecutive" means consecutive failures

An early version reset the counter on any successful phase. With the manager
timing out, the **baseline** execute phase still succeeds — its objective is
fixed by the engine and needs no manager — so the count went 1, reset, 1, reset.
The run failed after one failure while advertising a policy of three.

Only a **completed iteration** clears the counter now.

## Blocked is not failed

`shouldStop` treats `failed` as terminal. Recording a closed tab that way would
refuse the Resume the failure policy asks the user to perform. `blocked` is its
own state, persisted with its reason — because the next thing a user does after
closing a tab is often reload the extension.

## User stop is absolute

Recorded, persisted, and never overwritten. This has been broken **twice** and
caught by tests both times: once in `Orchestrator.run()` and once, identically,
in `Runner.start()`. A wrapper that re-implements a lifecycle needs the guards
the thing it wraps already has.

## Environment drift

Verified before **every** action and at every phase boundary. The guard
**latches**: it does not resume when the tab comes back, because the user
switching away was a decision and "the tab happens to be back" is not consent.
