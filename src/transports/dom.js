/**
 * THE DOM TRANSPORT — driving a chat page in a tab.
 *
 * Implements `send({prompt, surface, timeoutMs}) -> {text}`, the same contract
 * the simulator implements. The adapters cannot tell them apart, which is what
 * makes an official-API transport a later drop-in rather than a rewrite (§29).
 *
 * THE HARD PART IS NOT TYPING, IT IS KNOWING WHEN THE ANSWER IS FINISHED
 * ---------------------------------------------------------------------
 * Every naive approach to completion detection is wrong in a way that costs
 * real damage:
 *
 *   "wait N seconds"        truncates long answers and wastes time on short
 *                           ones. A build log takes four minutes; a plan takes
 *                           eight seconds.
 *   "wait for text"         fires on the first streamed token.
 *   "wait for text to stop
 *    changing"              fires during any pause in streaming -- and models
 *                           pause, especially while emitting code blocks.
 *
 * What actually works is a composite: the send control returns to its idle
 * state AND the text has been stable for a quiet period AND the reply is not
 * empty. The send control is the strongest signal because the page itself
 * knows when it is done; stability is the fallback for when the selector
 * breaks, which it will.
 *
 * SELECTORS WILL ROT. That is stated in the README as a known risk and it is
 * unavoidable when driving someone else's markup. The design contains the
 * damage: every selector is a LIST tried in order, a failure to find one is a
 * loud typed error rather than a silent no-op, and the failure names which
 * selector missed so the fix is a one-line change rather than an
 * investigation.
 *
 * THIS FILE IS PURE. It receives a `page` object -- the thing that can
 * actually run code in a tab -- and never touches `chrome.*` itself. That is
 * what lets the whole completion-detection state machine be tested in Node.
 */

/**
 * Per-surface selectors.
 *
 * Ordered most-specific first. `data-testid` attributes survive redesigns
 * better than class names, which are usually generated; text-matching is last
 * because it breaks on localisation.
 */
export const SELECTORS = {
  manager: {
    composer: ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'textarea[data-id]', 'form textarea'],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'form button[type="submit"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    turns: ['[data-message-author-role="assistant"]', 'div[data-testid^="conversation-turn"]'],
  },
  engineer: {
    composer: ['[data-testid="composer"]', 'textarea[placeholder]', 'div[contenteditable="true"]', 'form textarea'],
    send: ['[data-testid="send-button"]', 'button[type="submit"]', 'button[aria-label*="Send" i]'],
    stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    /*
     * UNVALIDATED against live Arena markup -- see the run of 2026-08-08
     * 17:10, where the reply was visibly on screen and none of these matched,
     * so the transport reported "produced no reply". The list is widened with
     * the conventional patterns, but widening a guess is not the fix: the fix
     * is that a total miss is now DIAGNOSED in ~90s by name (`selector-miss`)
     * instead of being waited out for four hours as if the page were slow.
     * Run a surface scan and read `selectorCheck` to close this properly.
     */
    turns: [
      '[data-role="assistant"]', '[data-message-role="assistant"]', '[data-message-author-role="assistant"]',
      '[data-testid*="assistant" i]', '[data-testid*="message" i]',
      '.assistant-message', '[class*="assistant" i]', '[class*="markdown" i]',
    ],
  },
  reviewer: {
    composer: ['#chat-input', 'textarea#chat-input', 'div[contenteditable="true"]', 'form textarea'],
    send: ['div[role="button"][aria-disabled]', 'button[type="submit"]', 'button[aria-label*="Send" i]'],
    stop: ['div[role="button"][aria-label*="Stop" i]'],
    turns: ['[class*="markdown"]', '[data-message-role="assistant"]'],
  },
};

export const DEFAULTS = {
  /**
   * How long the whole exchange may take. Overridden per surface by the
   * adapter -- the engineer gets hours, because it is doing real work.
   */
  timeoutMs: 240_000,
  /**
   * How long a reply may show NO SIGN OF LIFE before it is called dead.
   *
   * This is the number that actually matters for a long task, and the reason
   * a multi-hour budget is safe rather than reckless. A four-hour deadline
   * with no liveness check means a genuinely crashed page is waited on for
   * four hours. A liveness window means: wait as long as the work takes, but
   * give up promptly once the page stops changing entirely.
   *
   * 15 minutes is deliberately generous. A build with no streamed output can
   * be silent for a long time, and killing real work is far more expensive
   * than waiting too long for dead work.
   */
  silenceMs: 15 * 60_000,
  /** How often to look. */
  pollMs: 750,
  /** Text must be unchanged this long before the reply counts as finished. */
  quietMs: 2_500,
  /** Longer quiet period when the send control cannot be read. */
  blindQuietMs: 8_000,
  /** Wait for the composer to appear before giving up. */
  composerMs: 15_000,
  /**
   * How long to wait for the FIRST sign that a reply exists before concluding
   * that the fault is ours, not the model's.
   *
   * This is not a completion budget -- it is a diagnosis budget. If, this long
   * after submitting, the page reports no turns, no text and no busy state,
   * then we are not watching a slow answer; we are not watching anything. The
   * reply may well be on screen. Waiting out a four-hour budget to say "no
   * reply" in that situation is the transport blaming the model for its own
   * blindness, which is exactly what happened on Arena on 2026-08-08.
   *
   * 90s is above any plausible time-to-first-token and far below the point
   * where a human gives up and presses retry (they pressed it at 6.5 minutes).
   */
  firstTurnMs: 90_000,
};

export class TransportError extends Error {
  constructor(outcome, message, detail = {}) {
    super(message);
    this.name = 'TransportError';
    /*
     * The same `outcome` vocabulary the adapters and the runner use. Set as a
     * plain string rather than by sharing a class, so the core can classify a
     * failure without importing anything from a transport -- the dependency
     * inversion the purity checker already forced once.
     */
    this.outcome = outcome;
    this.recoverable = outcome === 'timed-out';
    this.detail = detail;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.page   `{ read(surface), type(surface,text), click(surface,which) }`
 * @param {object} [deps.config]
 * @param {(e:object)=>void} [deps.onEvent]
 * @param {() => number} [deps.now]
 * @param {(ms:number)=>Promise<void>} [deps.wait]
 */
export class DomTransport {
  constructor({ page, config = {}, onEvent = () => {}, now = () => Date.now(), wait = null } = {}) {
    if (!page?.read) throw new TypeError('a DOM transport needs a page reader');
    this.page = page;
    this.config = { ...DEFAULTS, ...config };
    this.onEvent = onEvent;
    this.now = now;
    /*
     * The clock is injectable so completion detection can be tested without
     * actually waiting. §38 forbids long fixed sleeps, and a test that waits
     * eight real seconds to prove a quiet period is a test nobody runs.
     */
    this.wait = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  emit(type, data = {}) {
    this.onEvent({ type, at: this.now(), ...data });
  }

  async send({ prompt, surface, timeoutMs = this.config.timeoutMs }) {
    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;

    /* -- 1. is the page usable? ----------------------------------------- */
    const before = await this.readState(surface);
    if (!before.composer) {
      throw new TransportError('failed', `no composer found on the ${surface} page`, {
        tried: SELECTORS[surface]?.composer,
      });
    }
    if (before.busy) {
      /*
       * A page already generating means the previous exchange never finished,
       * or a human is using the tab. Typing into it now would interleave two
       * conversations. Waiting is the only safe move, and giving up is better
       * than typing over someone.
       */
      this.emit('waiting-for-idle', { surface });
      const idle = await this.until(() => this.readState(surface).then((s) => !s.busy), deadline, this.config.pollMs);
      if (!idle) throw new TransportError('failed', `the ${surface} page was already generating a response`);
    }

    /*
     * The turn count BEFORE sending is the anchor.
     *
     * Reading "the last assistant message" after sending is ambiguous -- if
     * the page has not rendered the new turn yet, the last message is the
     * PREVIOUS answer, and the adapter would happily parse a stale reply as
     * the response to a prompt it just sent. Anchoring on a count makes "a new
     * turn appeared" the condition.
     */
    const baseTurns = before.turns;
    const baseText = before.lastText;

    /* -- 2. paste and submit -------------------------------------------- */
    this.emit('prompt-pasted', { surface, chars: prompt.length });
    await this.page.type(surface, prompt);
    this.emit('prompt-submitted', { surface });
    await this.page.click(surface, 'send');

    /* -- 3. wait for a new turn to appear ------------------------------- */
    /*
     * TWO DIFFERENT FAILURES LIVE HERE, AND THEY NEED DIFFERENT ANSWERS.
     *
     *   the model is slow          -> wait. That is what the long budget is for.
     *   our selectors do not match -> waiting cannot help. Say so, fast.
     *
     * This phase used to be a single `until()` against the full deadline, and
     * it emitted nothing at all while it ran. With the engineer's four-hour
     * budget that combination produced the worst possible behaviour: a reply
     * that WAS on screen was declared absent, four hours later, with a silent
     * Activity Log in between. The heartbeat added in the previous fix lived
     * only in `awaitCompletion`, which this phase never reached.
     *
     * The distinguishing evidence is whether the page shows ANY sign of life:
     * a turn, any text, or a busy indicator. If nothing at all is observable
     * after `firstTurnMs`, the honest diagnosis is that we cannot see the
     * page, not that the page is empty.
     */
    const firstTurnBy = Math.min(startedAt + this.config.firstTurnMs, deadline);
    let sawAnything = false;
    let progressAt = 0;

    const appeared = await this.until(async () => {
      const s = await this.readState(surface);
      if (s.busy || s.turns > 0 || s.lastText) sawAnything = true;

      /*
       * Named `waited`, not `elapsed`, purely so it is not textually identical
       * to the streaming phase's line. Two identical statements in one file
       * make line-oriented mutation testing ambiguous -- the harness patched
       * the first occurrence and the wrong test failed, which is how a real
       * defect could hide behind a green run.
       */
      const waited = this.now() - startedAt;
      if (waited - progressAt >= 60_000) {
        progressAt = waited;
        this.emit('response-progress', {
          surface, elapsedMs: waited, chars: s.lastText.length, busy: s.busy, silentMs: waited, phase: 'awaiting-first-turn',
        });
      }

      /*
       * Blind, not patient. Thrown from inside the predicate so it beats the
       * outer deadline rather than being masked by it.
       */
      if (!sawAnything && this.now() >= firstTurnBy) {
        throw new TransportError('failed',
          `${surface} showed no turns, no text and no activity ${Math.round(this.config.firstTurnMs / 1000)}s after submitting — ` +
          `the reply may be on screen but unreadable: none of the ${surface} "turns" selectors matched`,
          { phase: 'selector-miss', tried: SELECTORS[surface]?.turns, sawBusy: false });
      }

      return s.turns > baseTurns || (s.lastText && s.lastText !== baseText);
    }, deadline, this.config.pollMs);

    if (!appeared) {
      throw new TransportError('timed-out', `${surface} produced no reply within ${timeoutMs}ms`, {
        phase: 'no-turn', sawAnything,
      });
    }
    this.emit('response-started', { surface });

    /* -- 4. wait for it to finish --------------------------------------- */
    const text = await this.awaitCompletion(surface, deadline, startedAt);
    if (!text?.trim()) {
      throw new TransportError('failed', `${surface} produced an empty reply`);
    }

    this.emit('response-complete', { surface, chars: text.length });
    return { text };
  }

  /**
   * The composite completion detector.
   *
   * Returns when the page says it is idle AND the text has settled, or throws
   * on the deadline. Never returns partial text silently: a truncated reply
   * that parses is far worse than one that fails, because the truncation is
   * invisible downstream.
   */
  async awaitCompletion(surface, deadline, startedAt = this.now()) {
    let lastText = '';
    let stableSince = null;
    let sawBusy = false;
    /*
     * LIVENESS, TRACKED SEPARATELY FROM COMPLETION.
     *
     * `lastChange` is the last moment ANYTHING moved -- text grew, or the page
     * reported itself busy. A long task is expected to be slow; it is not
     * expected to be frozen. Distinguishing the two is what makes a four-hour
     * budget defensible instead of reckless.
     */
    let lastChange = this.now();
    let reportedProgress = 0;

    while (this.now() < deadline) {
      const s = await this.readState(surface);

      /*
       * PROGRESS IS EMITTED, NOT JUST OBSERVED.
       *
       * A user watching a four-hour task needs to see that it is alive. The
       * Activity Log previously showed nothing between "submitted" and either
       * a reply or a timeout -- for hours. That is the "no unexplained
       * waiting" rule broken by the very case it was written for.
       */
      /*
       * Elapsed comes from the ACTUAL start, passed in.
       *
       * It was reconstructed as `deadline - config.timeoutMs`, which silently
       * assumes the caller used the default budget. With the engineer's
       * four-hour budget that arithmetic produced a large negative number, so
       * the progress threshold was never crossed and not one heartbeat was
       * emitted during exactly the wait they exist for. Caught by a test, not
       * by reading.
       */
      const elapsed = this.now() - startedAt;
      if (elapsed - reportedProgress >= 60_000) {
        reportedProgress = elapsed;
        this.emit('response-progress', {
          surface,
          elapsedMs: elapsed,
          chars: s.lastText.length,
          busy: s.busy,
          silentMs: this.now() - lastChange,
          /*
           * Tagged so the two waits are distinguishable. Both phases emit the
           * same event type, and without a tag a test asserting "the streaming
           * wait reports progress" is satisfied by a heartbeat from the
           * first-turn wait -- which let a mutation of THIS line be caught by
           * the wrong test. The sabotage harness reported that overlap; the
           * tag restores a one-to-one mapping between defect and test.
           */
          phase: 'streaming',
        });
      }

      if (s.busy || s.lastText !== lastText) lastChange = this.now();

      /*
       * Dead, not slow. Checked before the completion logic so a frozen page
       * fails with an accurate reason rather than eventually hitting the
       * outer deadline and reporting "still generating".
       */
      if (this.now() - lastChange > this.config.silenceMs) {
        throw new TransportError('timed-out',
          `${surface} showed no sign of life for ${Math.round(this.config.silenceMs / 60_000)} minutes`,
          { phase: 'silent', chars: lastText.length, sawBusy });
      }

      if (s.busy) {
        sawBusy = true;
        stableSince = null;
      } else if (s.lastText === lastText && s.lastText) {
        stableSince ??= this.now();
        /*
         * A longer quiet period when the send control could not be read.
         *
         * Without a busy signal, stability is the only evidence -- and a model
         * pausing mid-code-block looks exactly like a finished answer for a
         * couple of seconds. The longer window trades latency for not
         * truncating, which is the right trade: a truncated report costs an
         * iteration, a slow one costs seconds.
         */
        const need = s.busyKnown ? this.config.quietMs : this.config.blindQuietMs;
        if (this.now() - stableSince >= need) {
          this.emit('response-settled', { surface, quietMs: need, sawBusy, blind: !s.busyKnown });
          return s.lastText;
        }
      } else {
        stableSince = null;
      }

      lastText = s.lastText;
      await this.wait(this.config.pollMs);
    }

    throw new TransportError('timed-out', `${surface} was still generating when the budget ran out`, {
      phase: 'never-settled', chars: lastText.length, sawBusy,
    });
  }

  /** Read the page through the injected reader, normalising the result. */
  async readState(surface) {
    const raw = await this.page.read(surface);
    return {
      composer: Boolean(raw?.composer),
      /*
       * `busyKnown` distinguishes "the page is idle" from "I could not tell".
       * Collapsing them to `busy: false` would make a broken stop-button
       * selector look like an instantly-finished response, and the transport
       * would return the first streamed token as the whole answer.
       */
      busy: raw?.busy === true,
      busyKnown: typeof raw?.busy === 'boolean',
      turns: Number(raw?.turns ?? 0),
      lastText: String(raw?.lastText ?? ''),
    };
  }

  /** Bounded polling. Never a fixed sleep; always against a deadline. */
  async until(predicate, deadline, intervalMs) {
    while (this.now() < deadline) {
      if (await predicate()) return true;
      await this.wait(intervalMs);
    }
    return false;
  }
}

/**
 * The code that runs inside the page.
 *
 * Injected by `extension/dom-page.js`. Kept here, next to the selectors it
 * uses, so a selector change is a single-file edit -- the alternative is a
 * selector list in one file and the code that consumes it in another, which
 * drift.
 *
 * READ-ONLY except for the composer, and even then only through the two
 * documented mutations (setting the value and dispatching input). Everything
 * else observes.
 */
export function pageProbe(selectors) {
  const pick = (list) => {
    for (const sel of list || []) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const composer = pick(selectors.composer);
  const stop = pick(selectors.stop);
  const send = pick(selectors.send);
  const turns = selectors.turns.reduce((n, sel) => Math.max(n, document.querySelectorAll(sel).length), 0);

  let lastText = '';
  for (const sel of selectors.turns) {
    const all = document.querySelectorAll(sel);
    if (all.length) {
      lastText = (all[all.length - 1].innerText || '').trim();
      break;
    }
  }

  /*
   * Busy is inferred from the STOP control, not the send control.
   *
   * A disabled send button means "nothing to send" when the composer is empty,
   * which is also true immediately after submitting -- so send-disabled cannot
   * distinguish "generating" from "idle with an empty box". A visible stop
   * button means one thing only.
   */
  const busy = stop ? isVisible(stop) : (send ? undefined : undefined);

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
  }

  return {
    composer: Boolean(composer),
    send: Boolean(send),
    busy,
    turns,
    lastText,
    url: location.href,
    title: document.title,
  };
}
