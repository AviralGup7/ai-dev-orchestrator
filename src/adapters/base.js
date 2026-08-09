/**
 * THE ADAPTER CONTRACT.
 *
 * An adapter turns a role's intent ("plan the next objective") into a
 * conversation with an AI, and the reply back into validated data. It owns the
 * prompt, the schema, the retry policy, and nothing else.
 *
 * WHAT AN ADAPTER MUST NOT KNOW
 * -----------------------------
 * Which tab, which DOM node, which URL. It calls a TRANSPORT:
 *
 *     transport.send({ prompt, surface, timeoutMs, signal }) -> { text }
 *
 * That one interface is what makes the simulation adapters and the DOM
 * transport interchangeable, and it is what will make an official-API
 * transport a drop-in later (§29). The adapter cannot tell which it is talking
 * to, which is the point -- if it could, the browser would have leaked into
 * the layer above it.
 *
 * WHY THE RETRY POLICY LIVES HERE AND NOT IN THE ENGINE
 * ----------------------------------------------------
 * `orchestrator.js` deliberately does not retry: "if the manager is returning
 * malformed responses, retrying produces the same malformed response and burns
 * the budget. Transport-level retries belong in the adapters, where the
 * failure is actually understood."
 *
 * An adapter understands the difference between a timeout (worth retrying --
 * the AI was slow) and a schema violation (worth ONE reprompt that includes
 * the error -- the AI misunderstood) and a transport failure (worth nothing --
 * the tab is gone; pausing is the only honest move). The engine cannot tell
 * those apart from an exception.
 *
 * This file is under src/adapters/, not src/core/, and imports only from core.
 */

import { describeProblems } from '../core/schema.js';

/** How an attempt ended. Distinct from a plain throw, per §8. */
export const OUTCOMES = /** @type {const} */ ([
  'requested',   // prompt composed, not yet sent
  'started',     // sent, awaiting a reply
  'completed',   // a reply arrived and validated
  'failed',      // the transport could not deliver or read
  'timed-out',   // no reply within the budget
  'malformed',   // a reply arrived and did not validate
]);

export class AdapterError extends Error {
  constructor(outcome, message, detail = {}) {
    super(message);
    this.name = 'AdapterError';
    this.outcome = outcome;
    this.detail = detail;
    /*
     * `recoverable` distinguishes "try again" from "stop and tell someone".
     * The recovery layer reads this rather than pattern-matching on messages,
     * which would break the first time an error string is reworded.
     */
    /*
     * A REPEATED REPLY IS NOT RECOVERABLE, WHATEVER ITS OUTCOME SAYS.
     *
     * `malformed` normally IS worth another attempt: the model may well fix
     * itself when told what was wrong. But once it has returned a
     * byte-identical answer to a prompt carrying the schema error, the fault
     * is deterministic and every further attempt is a paid round trip that
     * cannot succeed.
     *
     * Run 202608091410 shows the cost of missing this. The schema retry
     * correctly stopped after one repeat -- and then the RUN-LEVEL ladder,
     * reading `recoverable: true`, restarted the whole run three times. Six
     * ChatGPT calls, three identical failures, ~2 minutes, one outcome.
     *
     * Set from the detail rather than pattern-matching the message, for the
     * reason given above: messages get reworded, flags do not.
     */
    this.recoverable = detail?.repeated === true
      ? false
      : outcome === 'timed-out' || outcome === 'malformed';
  }
}

export const DEFAULT_POLICY = {
  /** Transport-level attempts for a timeout. */
  timeoutRetries: 1,
  /**
   * Schema-aware reprompts. ONE, per §9.
   *
   * A second reprompt is almost never productive: a model that ignored an
   * explicit schema error twice is not going to comply on the third ask, and
   * each attempt costs a full round trip against the user's rate limit. Two
   * failures is enough evidence to stop and involve a human.
   */
  schemaRetries: 1,
  /*
   * PER-ROLE BUDGETS, BECAUSE THE ROLES ARE NOT COMPARABLE.
   *
   * A single flat timeout was wrong in a way that only showed against a real
   * Arena. Asking ChatGPT for a plan is one inference -- seconds. Asking Arena
   * to explore a repository, run a build and run a test suite is REAL WORK,
   * and the user reports it can take HOURS.
   *
   * The 240s budget killed exactly that: the log shows the prompt pasted and
   * submitted correctly, then "engineer produced no reply within 240000ms"
   * after four minutes of an engineering task that had barely started. The
   * transport was working perfectly; the deadline was a fiction.
   *
   * Note this is NOT the Chrome 5-minute limit -- that applies to a single
   * event, and the run is already detached (see extension/background.js), so
   * a long wait is not one event. The only thing keeping the worker alive is
   * the heartbeat, which is why waiting hours is now safe where it was not
   * before.
   */
  timeoutMs: 240_000,          // default for conversational roles
  /** Per-surface overrides. The engineer does work; the others answer. */
  timeouts: {
    manager: 240_000,          // 4 minutes: a plan or an evaluation
    reviewer: 240_000,         // 4 minutes: a strategic opinion
    engineer: 4 * 3600_000,    // 4 HOURS: a build, a suite, a repository
  },
  /** Backoff between transport retries. Bounded; never a fixed long sleep. */
  backoffMs: 2_000,
};

/**
 * Base class: send, validate, retry, report.
 *
 * Subclasses supply `role`, `surface`, a prompt builder and a validator. The
 * conversation mechanics are identical for all three roles, and duplicating
 * them three times is how the reviewer ends up with subtly different timeout
 * handling that nobody notices for months.
 */
export class Adapter {
  /**
   * @param {object} deps
   * @param {object} deps.transport   `{ send({prompt, surface, timeoutMs}) }`
   * @param {object} [deps.policy]
   * @param {(e:object)=>void} [deps.onEvent]
   * @param {() => boolean} [deps.isCancelled]
   */
  constructor({ transport, policy = {}, onEvent = () => {}, isCancelled = () => false } = {}) {
    if (!transport?.send) throw new TypeError('an adapter requires a transport with send()');
    this.transport = transport;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.onEvent = onEvent;
    this.isCancelled = isCancelled;
  }

  /** @abstract */
  get role() { throw new Error('role not set'); }
  /** @abstract */
  get surface() { throw new Error('surface not set'); }

  emit(type, data = {}) {
    this.onEvent({ type, at: Date.now(), actor: this.role, surface: this.surface, ...data });
  }

  /**
   * One full exchange: compose, send, validate, retry once on a schema error.
   *
   * @param {object} args
   * @param {string} args.prompt
   * @param {(text:string) => object} args.validate  returns a schema result
   * @param {string} args.what   for logs, e.g. 'plan'
   */
  async exchange({ prompt, validate, what, iteration = null }) {
    let currentPrompt = prompt;
    let lastValidation = null;
    let previousText = null;

    for (let schemaAttempt = 0; schemaAttempt <= this.policy.schemaRetries; schemaAttempt++) {
      const text = await this.sendWithRetries(currentPrompt, { what, iteration });

      /*
       * AN IDENTICAL REPLY MEANS THE RETRY CANNOT HELP.
       *
       * The reprompt attaches the schema error and asks again. That is worth
       * one attempt when the model can correct itself -- and worth nothing
       * when the fault is deterministic formatting on the model's side.
       *
       * Run 202608091336: the manager returned 1717 characters, failed to
       * parse, was re-asked with the error attached, and returned 1717
       * characters again -- byte for byte the same reply. The second round
       * trip cost ~47 seconds and produced the identical failure, then ended
       * the run.
       *
       * Comparing the reply to the previous one turns a guaranteed-useless
       * round trip into an immediate, accurately-named failure. `repeated` is
       * reported so the log distinguishes "the model could not fix it" from
       * "the model did not even try differently".
       */
      if (previousText !== null && text === previousText) {
        this.emit('response-repeated', {
          what, iteration, chars: text.length,
          problems: lastValidation?.problems ?? [],
        });
        throw new AdapterError('malformed',
          `${this.role} returned a byte-identical ${what} after being told what was wrong `
          + '— re-asking cannot fix this',
          {
            problems: lastValidation?.problems ?? [],
            warnings: lastValidation?.warnings ?? [],
            repeated: true,
            chars: text.length,
          });
      }
      previousText = text;

      const validation = validate(text);
      lastValidation = validation;

      this.emit('response-validated', {
        what,
        iteration,
        ok: validation.ok,
        problems: validation.problems,
        warnings: validation.warnings,
        dropped: validation.dropped,
      });

      if (validation.ok) {
        /*
         * Warnings are emitted even on success. "The manager tried to send a
         * patch" is not an error -- the plan is fine -- but it is exactly the
         * kind of drift a user should be able to see accumulating.
         */
        return { value: validation.value, raw: text, warnings: validation.warnings, dropped: validation.dropped };
      }

      if (schemaAttempt < this.policy.schemaRetries) {
        this.emit('schema-reprompt', { what, iteration, problems: validation.problems });
        /*
         * The reprompt carries the ERROR, not just the original request.
         * Re-sending the same prompt asks the model to guess what was wrong;
         * telling it produces a corrected reply often enough to be worth one
         * attempt.
         */
        currentPrompt = `${describeProblems(validation)}\n\n---\n\n${prompt}`;
      }
    }

    throw new AdapterError('malformed', `${this.role} returned an unusable ${what} twice`, {
      problems: lastValidation?.problems ?? [],
      warnings: lastValidation?.warnings ?? [],
    });
  }

  /**
   * Send, retrying only what is worth retrying.
   */
  async sendWithRetries(prompt, { what, iteration }) {
    let lastErr = null;

    for (let attempt = 0; attempt <= this.policy.timeoutRetries; attempt++) {
      if (this.isCancelled()) throw new AdapterError('failed', 'cancelled by the user');

      const startedAt = Date.now();
      this.emit('prompt-sent', { what, iteration, attempt, chars: prompt.length });

      try {
        const res = await this.transport.send({
          prompt,
          surface: this.surface,
          timeoutMs: this.policy.timeouts?.[this.surface] ?? this.policy.timeoutMs,
        });
        const text = typeof res === 'string' ? res : res?.text;

        if (typeof text !== 'string' || !text.trim()) {
          /*
           * An empty reply is a FAILURE, not an empty success.
           *
           * The scraper returning "" usually means it read the page before the
           * response rendered. Treating it as a valid empty answer would make
           * the manager appear to have planned nothing, and the iteration
           * would proceed on a blank objective.
           */
          throw new AdapterError('failed', `${this.role} returned an empty response`, { what });
        }

        this.emit('response-received', {
          what, iteration, attempt,
          durationMs: Date.now() - startedAt,
          chars: text.length,
        });
        return text;
      } catch (err) {
        lastErr = err;
        const outcome = err instanceof AdapterError ? err.outcome : classify(err);
        this.emit('prompt-failed', {
          what, iteration, attempt, outcome,
          durationMs: Date.now() - startedAt,
          error: String(err?.message || err),
        });

        /*
         * ONLY TIMEOUTS ARE RETRIED AT THE TRANSPORT LEVEL.
         *
         * A closed tab, a navigated page or a missing composer will fail
         * identically on the second attempt, and retrying wastes the user's
         * time while the log fills with duplicates. Those propagate
         * immediately so the recovery layer can pause and say what happened.
         */
        if (outcome !== 'timed-out' || attempt >= this.policy.timeoutRetries) {
          throw err instanceof AdapterError ? err : new AdapterError(outcome, String(err?.message || err), { what });
        }

        await sleep(this.policy.backoffMs * (attempt + 1));
      }
    }

    throw lastErr ?? new AdapterError('failed', 'the transport failed with no error');
  }
}

/** Map an unknown throw onto an outcome. Message-sniffing, but contained. */
function classify(err) {
  const m = String(err?.message || err).toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) return 'timed-out';
  if (m.includes('abort')) return 'timed-out';
  return 'failed';
}

/**
 * Bounded wait.
 *
 * §38 forbids long fixed sleeps. This is a short, bounded backoff between two
 * transport attempts -- not a poll interval and not a substitute for waiting
 * on a real condition, which is the transport's job.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10_000)));
}

export { sleep };
