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
  constructor({ manager, engineer, reviewer, store, config = {}, onEvent }) {
    this.manager = manager;
    this.engineer = engineer;
    this.reviewer = reviewer;
    this.store = store;
    this.config = { ...DEFAULTS, reviewEvery: 5, ...config };
    this.onEvent = onEvent || (() => {});
    this.memory = null;
    /** Set by pause(); checked at every phase boundary. */
    this._paused = false;
  }

  async load(scope = '') {
    this.memory = (await this.store.load()) || emptyMemory(scope);
    if (scope && !this.memory.scope) this.memory.scope = scope;
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

      await this.iterate();
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
    this.emit('iteration-started', { n });

    const record = { n, startedAt: Date.now() };

    try {
      await this.phasePlan(record);
      await this.phaseExecute(record);
      await this.phaseEvaluate(record);
      await this.phaseDetect(record);
      await this.phaseReview(record);
    } catch (err) {
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

  /* ---------------------------------------------------------------- plan -- */

  async phasePlan(record) {
    record.n = record.n ?? this.memory.iteration + 1;
    this.memory.phase = 'plan';
    await this.save();

    const objective = await this.manager.plan({
      scope: this.memory.scope,
      iteration: this.memory.iteration + 1,
      history: this.recentHistory(),
      openIssues: this.memory.openIssues,
      failedAttempts: this.memory.failedAttempts,
      lastScores: this.lastScores(),
      flags: this.memory.flags,
    });

    if (!objective?.text) throw new Error('manager returned no objective');

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
  }

  resume() {
    this._paused = false;
  }

  async stop() {
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
