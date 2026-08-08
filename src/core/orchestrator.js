/**
 * The loop.
 *
 * WHAT THIS MODULE IS AND IS NOT
 * ------------------------------
 * It is the state machine: plan, execute, evaluate, detect, review, decide.
 *
 * It is NOT anything to do with browsers. There is no `chrome.*` here, no DOM,
 * no `fetch`, no knowledge that ChatGPT is a website. It receives three
 * adapters and a store, and it would run identically against real AI systems,
 * against HTTP APIs, or against the fakes in the test suite.
 *
 * That constraint is the entire architectural bet of the project, stated in
 * docs/SPEC.md: the MVP drives Arena through the browser, and the roadmap adds
 * a local companion that runs real builds. If the engine knew about tabs, that
 * second step would be a rewrite. Because it does not, the companion is a new
 * adapter and this file does not change.
 *
 * `tools/check-purity.mjs` enforces it, and the enforcement is not decorative
 * -- one `chrome.tabs` call in a scoring path would end the property silently.
 *
 * WHY EVERY PHASE PERSISTS BEFORE THE NEXT BEGINS
 *
 * An iteration is minutes of real AI time. A browser restart, an extension
 * reload, or a closed tab mid-run must resume from the last completed phase --
 * not redo the whole iteration, and above all not half-redo it. So the store
 * is written at every boundary, and each phase is idempotent.
 */

import { PHASES, emptyMemory } from './types.js';
import { scoreTesting, reconcile, merge, overall } from './scoring.js';
import { detect } from './detect.js';
import { shouldStop, DEFAULTS } from './stop.js';
import { EnvironmentError, describe as describeDrift } from './environment.js';
import { recordSkip } from './controls.js';
import { getMode } from './modes.js';

/**
 * The fixed objective for iteration 1, by mode.
 *
 * Written here rather than asked of the manager: the answer is known, and
 * spending a ChatGPT round trip to be told "explore the project" in explore
 * mode is pure latency. It also removes the possibility of the manager
 * deciding to skip the baseline, which it would occasionally do when the
 * conversation already looked productive.
 */
function baselineObjective(memory) {
  const kind = getMode(memory.mode).baseline;
  if (kind === 'explore') {
    return {
      text: 'Explore and understand the existing project, then produce an understanding report, a prioritised roadmap and evidence-based initial scores',
      constraints: ['do not modify any code', 'do not commit'],
      acceptance: ['a comprehensive understanding report', 'a prioritised roadmap', 'initial scores with a stated basis for each'],
      baseline: true,
    };
  }
  if (kind === 'synchronise') {
    return {
      text: 'Synchronise with the current state of the repository: report the real build and test results as a baseline, then continue the stated objective',
      constraints: ['do not re-scaffold', 'do not start over'],
      acceptance: ['current branch and commit reported', 'build and test output reported as they actually are'],
      baseline: true,
    };
  }
  return {
    text: 'Initialise the project: establish engineering standards, set up the test suite, make the initial commit, and begin implementation',
    constraints: ['do not delete anything already in the workspace'],
    acceptance: ['standards written into the repository', 'a test that can genuinely fail', 'an initial commit'],
    baseline: true,
  };
}

export class Orchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.manager   plans and evaluates  (ChatGPT)
   * @param {object} deps.engineer  executes             (Arena)
   * @param {object} deps.reviewer  strategic review     (DeepSeek)
   * @param {object} deps.store     persistence
   * @param {object} [deps.config]
   * @param {(e:object)=>void} [deps.onEvent]  UI + logging tap
   */
  constructor({ manager, engineer, reviewer, store, config = {}, onEvent, environment }) {
    this.manager = manager;
    this.engineer = engineer;
    this.reviewer = reviewer;
    this.store = store;
    this.config = { ...DEFAULTS, reviewEvery: 5, ...config };
    this.onEvent = onEvent || (() => {});
    this.memory = null;
    /** Set by pause(); checked at every phase boundary. */
    this._paused = false;
    /*
     * OPTIONAL, AND THAT IS NOT A LOOPHOLE.
     *
     * `environment` is `{ binding, check() }` -- the pre-initiated tab
     * contract. It is absent in tests and in a dry run against fakes, where
     * there is no browser to drift. It is present in the extension, where the
     * guard in `guard.js` is a second, independent enforcement point on the
     * transport side. The engine checking as well means a run halts at a PHASE
     * boundary with state saved, rather than only when an action is attempted
     * halfway through pasting a prompt.
     */
    this.environment = environment || null;
  }

  async load(scope = '', mode = 'new') {
    this.memory = (await this.store.load()) || emptyMemory(scope, mode);
    if (scope && !this.memory.scope) this.memory.scope = scope;
    /*
     * An older stored memory has no `mode`. Defaulting it to 'new' would be
     * wrong in the one case that matters -- a resumed run on an existing
     * project would start re-scaffolding -- so a memory with history is
     * treated as 'existing', which is what it factually is.
     */
    if (!this.memory.mode) this.memory.mode = this.memory.history?.length ? 'existing' : mode;
    if (this.memory.baselineDone === undefined) {
      this.memory.baselineDone = (this.memory.history?.length ?? 0) > 0;
    }
    return this.memory;
  }

  async save() {
    await this.store.save(this.memory);
  }

  /**
   * @param {string} type
   * @param {object} [data]
   *
   * `iteration` defaults to the COMPLETED count, which lags by one while an
   * iteration is in flight -- `memory.iteration` only advances at the end. Any
   * event emitted mid-iteration must pass `iteration: record.n` explicitly, or
   * the log will attribute it to the previous iteration. That is a quiet way
   * to make an audit trail lie, so the phases all pass it.
   */
  emit(type, data = {}) {
    this.onEvent({ type, at: Date.now(), iteration: this.memory?.iteration, ...data });
  }

  /* ------------------------------------------------- environment contract - */

  /**
   * Is the prepared environment still the prepared environment?
   *
   * Returns `true` when there is nothing to check (no environment configured)
   * or everything matches. Otherwise it BLOCKS the run and returns false.
   *
   * Called at every phase boundary rather than once per iteration: an
   * iteration is minutes long and the user can close a tab at any point in it.
   */
  async checkEnvironment(where = 'phase', iteration = undefined) {
    if (!this.environment?.check) return true;

    let result;
    try {
      result = await this.environment.check();
    } catch (err) {
      /*
       * A CHECK THAT THROWS IS A FAILED CHECK, NOT A PASSED ONE.
       *
       * `chrome.tabs.get` rejects when the tab is gone, which is precisely the
       * condition being tested for. An earlier shape of this let the exception
       * escape into iterate()'s catch block, where it was recorded as
       * `status: 'failed'` -- terminal, unresumable, and described in the log
       * as an orchestrator crash rather than "you closed the ChatGPT tab".
       */
      result = {
        ok: false,
        problems: [
          {
            surface: 'unknown',
            label: 'environment probe',
            kind: 'tab-missing',
            detail: String(err?.message || err),
            remedy: 'restore the tab, then resume',
          },
        ],
      };
    }

    if (result.ok) return true;
    await this.block(result.problems, where, iteration);
    return false;
  }

  /**
   * Halt because the environment drifted. Pause, log, inform, wait.
   *
   * This is the user's failure policy expressed as code. Note what is NOT
   * here: no retry, no re-bind, no "find another tab on the same site". The
   * orchestrator's entire recovery strategy is to explain itself and stop.
   */
  async block(problems, where = 'phase', iteration = undefined) {
    const detail = describeDrift(problems);
    this.memory.status = 'blocked';
    this.memory.phase = this.memory.phase || 'plan';
    this.memory.block = { at: Date.now(), where, problems, detail };
    await this.save();

    /*
     * `iteration` is threaded through explicitly for the same reason every
     * phase passes `iteration: record.n`: `memory.iteration` holds the
     * COMPLETED count and lags until an iteration finishes, so a drift during
     * iteration 3 was being logged against iteration 2. Found by reading
     * tools/sample-log.mjs output, not by a test — the timeline said `i2` next
     * to `where=iteration 3 / execute`, contradicting itself on one line.
     */
    const at = iteration != null ? { iteration } : {};
    this.emit('environment-drift', { where, problems, detail, ...at });
    this.emit('run-blocked', { detail, awaiting: 'user', ...at });
    return { stop: false, reason: 'environment-blocked', why: detail, problems };
  }

  /**
   * Clear a block after the user says the environment is back.
   *
   * Explicit and human-triggered on purpose -- see the latch note in guard.js.
   * An automatic clear would resume a run the user paused by switching tabs
   * for their own reasons.
   */
  async unblock() {
    this.memory.block = null;
    if (this.memory.status === 'blocked') this.memory.status = 'paused';
    await this.save();
    this.emit('environment-unblocked');
  }

  /**
   * Run until a stop condition fires.
   *
   * `maxIterations` in config is the hard ceiling; this also honours pause and
   * the user's stop request between phases.
   */
  async run() {
    if (!this.memory) await this.load();

    /*
     * CHECK THE STOP CONDITION BEFORE CLAIMING TO BE RUNNING.
     *
     * This used to set `status = 'running'` unconditionally, which silently
     * erased a user's stop: they press Stop, the status is recorded, and the
     * next run() call overwrites it and carries on. The stop request was
     * discarded by the very method that was supposed to honour it.
     *
     * Caught by a test asserting the run halted with reason 'user-stopped' and
     * getting 'no-progress' -- it had run to completion and stopped for an
     * unrelated reason, which is exactly how this would have hidden in
     * production: the run DOES eventually stop, so nothing looks broken.
     */
    const preflight = shouldStop(this.memory, this.config);
    if (preflight.stop) {
      this.emit('run-stopped', preflight);
      return preflight;
    }

    /*
     * A RUN THAT IS STILL BLOCKED DOES NOT START.
     *
     * Checked before the environment probe, not after: probing first would
     * mean a user who fixed the tab but never acknowledged the block gets an
     * automatic resume, which is the behaviour `unblock()` exists to require a
     * human for.
     */
    if (this.memory.block) {
      const held = {
        stop: false,
        reason: 'environment-blocked',
        why: this.memory.block.detail,
        problems: this.memory.block.problems,
      };
      this.emit('run-blocked', { detail: this.memory.block.detail, awaiting: 'user' });
      return held;
    }

    // The environment is verified BEFORE the run claims to be running, so a
    // missing tab never produces a run that looks live in the UI.
    if (!(await this.checkEnvironment('run-start'))) {
      return {
        stop: false,
        reason: 'environment-blocked',
        why: this.memory.block.detail,
        problems: this.memory.block.problems,
      };
    }

    this.memory.status = 'running';
    await this.save();
    this.emit('run-started', { scope: this.memory.scope });

    while (true) {
      const verdict = shouldStop(this.memory, this.config);
      if (verdict.stop) {
        this.memory.status = 'stopped';
        this.memory.stopReason = verdict.reason;
        await this.save();
        this.emit('run-stopped', verdict);
        return verdict;
      }

      if (this._paused) {
        this.memory.status = 'paused';
        await this.save();
        this.emit('run-paused');
        return { stop: false, reason: null, why: 'paused' };
      }

      try {
        await this.iterate();
      } catch (err) {
        /*
         * An environment drift surfaced from inside an iteration -- typically
         * the guard refusing an action mid-phase -- unwinds to here and ends
         * the loop cleanly as `blocked`. `iterate()` has already recorded the
         * partial record; re-throwing would present a browser tab change as a
         * crash to the caller.
         */
        if (err instanceof EnvironmentError) {
          return {
            stop: false,
            reason: 'environment-blocked',
            why: this.memory.block?.detail || err.message,
            problems: this.memory.block?.problems || err.problems,
          };
        }
        throw err;
      }
    }
  }

  /**
   * One full iteration.
   *
   * Split into named phase methods so a resume can re-enter at the right
   * point, and so each is independently testable.
   */
  async iterate() {
    const n = this.memory.iteration + 1;
    // `iteration: n`, not the default: the same one-behind labelling that bit
    // every other mid-iteration event. `iteration-started n=3` printed under
    // `i2` reads as a logging bug even though it is only a default.
    this.emit('iteration-started', { n, iteration: n });

    const record = { n, startedAt: Date.now() };

    try {
      /*
       * The environment is re-verified between phases, because the phases that
       * matter are minutes apart. `detect` is not gated -- it is pure local
       * arithmetic over memory and touches no tab, so blocking it would refuse
       * work that cannot possibly go wrong.
       */
      await this.gate('plan', record, () => this.phasePlan(record));
      await this.gate('execute', record, () => this.phaseExecute(record));
      await this.gate('evaluate', record, () => this.phaseEvaluate(record));
      await this.phaseDetect(record);
      await this.gate('review', record, () => this.phaseReview(record));
    } catch (err) {
      /*
       * ENVIRONMENT DRIFT IS NOT AN ITERATION FAILURE.
       *
       * Handled before the generic branch because the generic branch sets
       * `status: 'failed'`, which `shouldStop` treats as terminal and
       * unresumable. The user closing a tab must not permanently kill a run
       * that is otherwise healthy -- they fix the tab, acknowledge, resume.
       * The partial record is kept so the log shows exactly how far it got.
       */
      if (err instanceof EnvironmentError) {
        record.blockedAt = this.memory.phase;
        record.partial = true;
        this.memory.history.push(record);

        /*
         * DO NOT RE-BLOCK IF `gate()` ALREADY DID.
         *
         * Both paths lead here: a drift caught at a phase boundary (gate has
         * already called block()) and a drift thrown from inside a phase by
         * the transport guard (nothing has recorded it yet). Blocking
         * unconditionally logged the SAME problem twice, which in the run log
         * reads as two separate incidents — the reader concludes the
         * orchestrator retried, which is the one behaviour this whole
         * subsystem promises it never does.
         *
         * Caught by generating docs/SAMPLE-RUN-LOG.md and reading it. No test
         * asserted event counts, so the suite was perfectly green.
         */
        if (!this.memory.block) {
          await this.block(err.problems, `iteration ${n} / ${this.memory.phase}`, n);
        } else {
          await this.save();
        }
        this.emit('iteration-blocked', { n, phase: record.blockedAt, iteration: n });
        throw err;
      }

      /*
       * A FAILED ITERATION IS RECORDED, NOT SWALLOWED.
       *
       * The run halts with state intact so the user can see what happened.
       * Retrying automatically is the wrong default here: if the manager is
       * returning malformed responses, retrying produces the same malformed
       * response and burns the budget. Transport-level retries belong in the
       * adapters, where the failure is actually understood.
       */
      record.error = String(err?.message || err);
      this.memory.status = 'failed';
      this.memory.history.push(record);
      await this.save();
      this.emit('iteration-failed', { n, error: record.error });
      throw err;
    }

    record.finishedAt = Date.now();
    this.memory.iteration = n;
    this.memory.history.push(record);
    this.memory.phase = 'plan';
    await this.save();
    this.emit('iteration-finished', { n, overall: record.overall });
    return record;
  }

  /**
   * Verify the environment, then run one phase.
   *
   * A named helper rather than a line repeated four times: the failure mode of
   * the repeated version is that the fifth phase, added later, does not get
   * the check, and nothing tests for its absence.
   */
  async gate(phase, record, fn) {
    if (!(await this.checkEnvironment(`iteration ${record.n} / ${phase}`, record.n))) {
      throw new EnvironmentError(this.memory.block.problems);
    }

    /*
     * SKIP IS CONSUMED HERE, NOT INSIDE EACH PHASE.
     *
     * Putting the check in the phases would mean four copies of it, and the
     * fifth phase added later would silently not honour Skip. It is also the
     * right place semantically: skipping means the phase never runs, so the
     * decision belongs to the caller.
     *
     * The skip is recorded on the iteration permanently. `stop.js` refuses to
     * declare victory on an iteration that skipped an evidence phase -- see
     * controls.js for why permitting-with-consequence beats refusing.
     */
    if (this._skipNext) {
      this._skipNext = false;
      recordSkip(record, phase);
      this.emit('step-skipped', { phase, iteration: record.n, n: record.n });
      return undefined;
    }

    /*
     * RETRY RE-RUNS THE PHASE, ONCE, AND SAYS SO.
     *
     * Bounded deliberately: an unbounded retry against a manager that returns
     * malformed responses produces the same malformed response forever and
     * burns the user's budget while the Activity Log fills with identical
     * lines. One retry covers the transient case (a tab that was mid-render);
     * anything worse is a real failure the user should see.
     */
    try {
      return await fn();
    } catch (err) {
      if (!this._retryNext) throw err;
      this._retryNext = false;
      record.retried = [...new Set([...(record.retried || []), phase])];
      this.emit('step-retried', { phase, iteration: record.n, n: record.n, after: String(err?.message || err) });
      return fn();
    }
  }

  /* ---------------------------------------------------------------- plan -- */

  async phasePlan(record) {
    record.n = record.n ?? this.memory.iteration + 1;
    this.memory.phase = 'plan';
    await this.save();

    /*
     * THE BASELINE ITERATION IS NOT PLANNED BY THE MANAGER.
     *
     * Iteration 1 of every mode has a fixed job -- establish standards,
     * synchronise with reality, or explore -- and asking ChatGPT to invent an
     * objective for it would waste a round trip on a question with a known
     * answer, and would let the manager decide to skip the baseline entirely.
     *
     * `baselineDone` is checked rather than `iteration === 0` because a
     * baseline can fail and be retried; the flag only flips when it actually
     * produced its report.
     */
    const objective = this.memory.baselineDone
      ? await this.manager.plan({
        scope: this.memory.scope,
        mode: this.memory.mode,
        baseline: this.memory.baseline,
        iteration: this.memory.iteration + 1,
        history: this.recentHistory(),
        openIssues: this.memory.openIssues,
        failedAttempts: this.memory.failedAttempts,
        lastScores: this.lastScores(),
        flags: this.memory.flags,
      })
      : baselineObjective(this.memory);

    if (!objective?.text) throw new Error('manager returned no objective');
    record.baseline = !this.memory.baselineDone;

    this.memory.objective = objective;
    record.objective = objective;
    await this.save();
    this.emit('planned', { objective: objective.text, iteration: record.n });
  }

  /* ------------------------------------------------------------- execute -- */

  async phaseExecute(record) {
    this.memory.phase = 'execute';
    await this.save();

    const result = await this.engineer.execute({
      objective: this.memory.objective,
      scope: this.memory.scope,
      constraints: this.memory.objective?.constraints || [],
    });

    record.evidence = result.evidence || [];
    record.filesChanged = result.filesChanged || [];
    record.linesChanged = result.linesChanged ?? null;
    record.summary = result.summary || '';

    await this.save();
    this.emit('executed', {
      files: record.filesChanged.length,
      evidence: record.evidence.map((e) => e.kind),
      iteration: record.n,
    });
  }

  /* ------------------------------------------------------------ evaluate -- */

  async phaseEvaluate(record) {
    this.memory.phase = 'evaluate';
    await this.save();

    const proposed = await this.manager.evaluate({
      objective: this.memory.objective,
      summary: record.summary,
      evidence: record.evidence,
      scope: this.memory.scope,
    });

    /*
     * THE ORDER HERE IS THE WHOLE ANTI-FLATTERY MECHANISM.
     *
     *   1. reconcile  downgrade claims the evidence does not support
     *   2. compute    derive what can be derived, ignoring opinion entirely
     *   3. merge      computed beats proposed, always
     *
     * Doing it the other way round -- merging first -- would let a proposed
     * `testing: 95` survive because it was already in the map before the
     * computed value arrived.
     */
    const checked = reconcile(proposed.scores || [], record.evidence);
    const computed = [scoreTesting(record.evidence)].filter(Boolean);
    const scores = merge(checked, computed);

    const o = overall(scores);
    record.overall = o.score;
    record.confidence = o.confidence;

    this.memory.scores.push({ n: record.n, scores, at: Date.now() });

    // Issues carry forward; recurrence is a stagnation signal.
    if (Array.isArray(proposed.openIssues)) this.memory.openIssues = proposed.openIssues;
    if (Array.isArray(proposed.resolved)) {
      this.memory.resolvedIssues = [
        ...new Set([...this.memory.resolvedIssues, ...proposed.resolved]),
      ];
    }

    await this.save();
    /*
     * THE BASELINE IS ONLY DONE WHEN IT ACTUALLY PRODUCED SOMETHING.
     *
     * Flipped here rather than in phasePlan, and only on a record that carries
     * a summary. A baseline whose execute phase was skipped, or which returned
     * an unparseable report, must run again -- otherwise the run proceeds to
     * "normal improvement" on top of an understanding it never acquired, which
     * is the exact failure `explore` mode exists to prevent.
     */
    if (!this.memory.baselineDone && record.baseline && record.summary) {
      this.memory.baselineDone = true;
      this.memory.baseline = {
        at: Date.now(),
        iteration: record.n,
        mode: this.memory.mode,
        summary: record.summary,
        report: record.report ?? null,
        roadmap: record.report?.roadmap ?? null,
      };
      /*
       * In explore mode the scope was a placeholder. Replacing it with the
       * engineer's own one-line summary is the only point at which the
       * "never edited" rule on `scope` is relaxed -- and it is relaxed exactly
       * once, from a placeholder that says so, which is why the original text
       * is kept alongside rather than overwritten silently.
       */
      if (this.memory.mode === 'explore' && /pending exploration/.test(this.memory.scope || '')) {
        this.memory.scopePlaceholder = this.memory.scope;
        this.memory.scope = truncateScope(record.summary);
        this.emit('scope-established', { scope: this.memory.scope, iteration: record.n });
      }
      this.emit('baseline-complete', { mode: this.memory.mode, iteration: record.n });
    }

    this.emit('evaluated', { overall: o.score, confidence: o.confidence, iteration: record.n });
  }

  /* -------------------------------------------------------------- detect -- */

  async phaseDetect(record) {
    this.memory.phase = 'detect';

    /*
     * THE CURRENT ITERATION GOES IN THE HISTORY, BUT ITS OBJECTIVE MUST NOT BE
     * COMPARED AGAINST ITSELF.
     *
     * This originally appended `record` to the history and left
     * `memory.objective` set -- so `detect` compared the current objective
     * against a list that contained the current objective. Similarity 1.0,
     * every single iteration, forever.
     *
     * The symptom was subtle and would have been very hard to find later: the
     * `objective-repeat` signal fired on EVERY iteration, so combined with a
     * flat score it permanently reported stagnation and pulled a strategic
     * review forward every time. A detector that always fires is worse than no
     * detector -- it costs a review per iteration and trains the user to
     * ignore it.
     *
     * Caught by a test expecting two reviews and getting three, then confirmed
     * by instrumenting: at iteration 2 it reported a match against iteration
     * 3's objective, which had not been planned yet.
     *
     * So: history includes this iteration (file churn and diff size need it),
     * but the objective comparison sees only what came BEFORE.
     */
    const probe = {
      ...this.memory,
      history: [...this.memory.history, record],
    };
    const result = detect(probe, { historyOffset: 1 });

    this.memory.flags = { stagnation: result.stagnating, signals: result.signals };
    record.signals = result.signals;

    await this.save();
    if (result.stagnating) {
      this.emit('stagnation-detected', { signals: result.signals, iteration: record.n });
    }
  }

  /* -------------------------------------------------------------- review -- */

  async phaseReview(record) {
    const every = this.config.reviewEvery;
    const due = record.n % every === 0;

    /*
     * Stagnation PULLS THE REVIEW FORWARD.
     *
     * Waiting for iteration 10 while the detector has been shouting since 6 is
     * four wasted iterations, and the review is exactly the tool for the
     * condition the detector found.
     */
    if (!due && !this.memory.flags.stagnation) return;

    this.memory.phase = 'review';
    await this.save();

    const review = await this.reviewer.review({
      scope: this.memory.scope,
      history: this.recentHistory(),
      scores: this.lastScores(),
      signals: this.memory.flags.signals,
      openIssues: this.memory.openIssues,
    });

    record.reviewed = true;
    record.review = review;
    // `record.n` is the authority during an iteration -- `memory.iteration`
    // still holds the PREVIOUS number until the iteration completes, so any
    // event emitted mid-iteration is labelled one behind unless told otherwise.
    this.emit('reviewed', { recommendation: review?.recommendation, iteration: record.n });

    if (review?.recommendation === 'change-strategy' && review.newDirection) {
      /*
       * A strategy change is RECORDED, not applied silently.
       *
       * The reviewer's job is to advise; redirecting the project without
       * saying so is how an autonomous system becomes unpredictable. The next
       * plan() call receives it as context, and the UI surfaces it for
       * approval when the user has asked to approve strategy changes.
       */
      this.memory.decisions.push({
        at: Date.now(),
        iteration: record.n,
        kind: 'strategy',
        text: review.newDirection,
        rationale: review.rationale || '',
      });
      this.emit('strategy-changed', { direction: review.newDirection, iteration: record.n });
    }

    await this.save();
  }

  /* --------------------------------------------------------------- control */

  pause() {
    this._paused = true;
    this.emit('workflow-paused', { source: 'user' });
  }

  resume() {
    this._paused = false;
    this.emit('workflow-resumed', { source: 'user' });
  }

  /**
   * Skip the NEXT phase to run.
   *
   * "Next", not "current": by the time a user can press the button, the
   * current phase is already awaiting an AI that will answer regardless.
   * Pretending to cancel it would be a lie in the Activity Log -- the response
   * still arrives, and a log that claims a step was skipped while its result
   * is visibly being used is worse than no button at all.
   */
  skipStep() {
    this._skipNext = true;
    this.emit('step-skip-requested', { source: 'user' });
  }

  /** Retry the next phase that throws. One attempt; see `gate()`. */
  retryStep() {
    this._retryNext = true;
    this.emit('step-retry-requested', { source: 'user' });
  }

  async stop() {
    /*
     * Stop must work before a run has ever started.
     *
     * The UI offers Stop whenever a project exists, and a user can press it
     * before pressing Start -- or after a reload, before the engine has
     * loaded. `this.memory` is null then, and the unguarded version threw
     * "Cannot set properties of null", which the panel showed as a crash
     * instead of honouring the stop. Found by an integration test, not by
     * reading.
     */
    if (!this.memory) await this.load();
    this.memory.status = 'stopped';
    this.memory.stopReason = 'user-stopped';
    await this.save();
    this.emit('run-stopped', { reason: 'user-stopped', why: 'stopped by the user' });
  }

  /* ----------------------------------------------------------- context -- */

  /**
   * Recent history, compacted.
   *
   * CONTEXT MANAGEMENT IS A CORRECTNESS CONCERN, NOT AN OPTIMISATION.
   *
   * Forty iterations of full transcripts will exceed any context window, and
   * the failure mode is not an error -- it is the model silently losing the
   * earliest part of the conversation, which is where the project scope lives.
   * The run then drifts away from what the user asked for and nothing reports
   * it.
   *
   * So: the last few iterations in full, everything older as one line each.
   */
  recentHistory(full = 3) {
    const h = this.memory.history || [];
    const recent = h.slice(-full);
    const older = h.slice(0, -full);

    return {
      recent,
      summary: older.map((r) => ({
        n: r.n,
        objective: r.objective?.text,
        overall: r.overall,
      })),
      totalIterations: h.length,
    };
  }

  lastScores() {
    const s = this.memory.scores || [];
    return s.length ? s[s.length - 1].scores : [];
  }
}

export { PHASES };

/** First sentence of the exploration summary, bounded. */
function truncateScope(summary) {
  const first = String(summary).split(/(?<=[.!?])\s/)[0] || String(summary);
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}
