/**
 * THE GATE EVERY BROWSER INTERACTION PASSES THROUGH.
 *
 * `actions.js` says what is permitted. `environment.js` says whether the
 * prepared environment is still intact. This module is the only place those
 * two facts are enforced together, and it is deliberately the ONLY route from
 * the engine to a transport.
 *
 * WHY A WRAPPER RATHER THAN A RULE
 * --------------------------------
 * The alternative is "every adapter should call verify() first". That works
 * until the fourth adapter, written in a hurry, does not -- and the failure is
 * invisible, because an unverified paste into a tab that happens to still be
 * correct succeeds. The bug only appears on the day the user switched tabs,
 * which is the day it matters. A wrapper cannot be forgotten: the adapter has
 * no other way to reach the page.
 *
 * WHY IT VERIFIES BEFORE *EVERY* ACTION AND NOT ONCE PER ITERATION
 * An iteration is minutes of real AI time. Any gap between the check and the
 * act is a window in which the user closes a tab and the orchestrator types
 * into whatever replaced it. Verification is cheap -- reading a tab's url and
 * conversation id -- and the thing it prevents is unbounded.
 *
 * PURE: it receives a transport object and a snapshot function. It has no idea
 * that `chrome` exists.
 */

import { assertAllowed, ForbiddenActionError } from './actions.js';
import { verify, EnvironmentError, describe } from './environment.js';

/**
 * @param {object} deps
 * @param {object} deps.transport   the thing that can actually touch a tab
 * @param {object} deps.binding     from environment.bind()
 * @param {() => Promise<object>} deps.snapshot   fresh view of the environment
 * @param {(e:object)=>void} [deps.onEvent]
 * @param {(p:object[])=>void|Promise<void>} [deps.onDrift]  called ONCE per halt
 */
export function createGuard({ transport, binding, snapshot, onEvent = () => {}, onDrift }) {
  let halted = null; // truthy once drift is seen; latches until cleared

  async function ensure(surface) {
    /*
     * A LATCH, NOT A FLAG.
     *
     * Once the environment has drifted the guard refuses everything until a
     * human clears it. Re-checking and continuing "if it looks fine now" is
     * how an orchestrator quietly recovers from a state change the user made
     * on purpose -- they switched conversation, we paused, they switched back
     * for an unrelated reason, and the run resumes without them asking. The
     * user's failure policy is explicit: wait for intervention.
     */
    if (halted) throw new EnvironmentError(halted);

    const snap = await snapshot();
    const result = verify(binding, snap, { surfaces: [surface] });
    if (!result.ok) {
      halted = result.problems;
      onEvent({
        type: 'environment-drift',
        at: Date.now(),
        surface,
        problems: result.problems,
        detail: describe(result.problems),
      });
      if (onDrift) await onDrift(result.problems);
      throw new EnvironmentError(result.problems);
    }
  }

  /**
   * @param {string} action   must be in ALLOWED_ACTIONS
   * @param {string} surface  which bound surface it targets
   * @param {object} [args]
   */
  async function act(action, surface, args = {}) {
    assertAllowed(action); // throws ForbiddenActionError; default-deny
    await ensure(surface);

    const fn = transport[action];
    if (typeof fn !== 'function') {
      throw new TypeError(`transport cannot perform "${action}"`);
    }

    const bound = binding.surfaces[surface];
    const startedAt = Date.now();
    onEvent({ type: 'action-started', at: startedAt, action, surface, tabId: bound.tabId });

    try {
      const out = await fn.call(transport, { ...args, tab: bound, surface });
      onEvent({
        type: 'action-finished',
        at: Date.now(),
        action,
        surface,
        tabId: bound.tabId,
        ms: Date.now() - startedAt,
      });
      return out;
    } catch (err) {
      onEvent({
        type: 'action-failed',
        at: Date.now(),
        action,
        surface,
        tabId: bound.tabId,
        error: String(err?.message || err),
      });
      throw err;
    }
  }

  return {
    act,
    isHalted: () => Boolean(halted),
    problems: () => halted || [],
    /** Only a human path should call this — see docs/ENVIRONMENT.md. */
    clear() {
      halted = null;
    },
  };
}

export { ForbiddenActionError, EnvironmentError };
