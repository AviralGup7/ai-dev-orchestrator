/**
 * THE RUNNER — where the engine, the adapters and the record meet.
 *
 * `Orchestrator` owns the state machine. `ProjectStore` owns the record. The
 * adapters own the conversations. Something has to hold the three together,
 * decide what happens when an adapter throws, and make sure a phase that
 * already ran is not run again. That is this file, and keeping it separate is
 * what stops any of the three growing knowledge of the others.
 *
 * WHY NOT PUT THIS IN THE ORCHESTRATOR
 * ------------------------------------
 * The orchestrator is pure state machine and is covered by 247 tests written
 * against fake adapters. Teaching it about retries, storage checkpoints and
 * adapter outcomes would couple the state machine to the failure model, and
 * §35 asks that existing guarantees not be disturbed to add new capability.
 *
 * The runner adapts: it presents `plan/execute/evaluate/review` objects that
 * look exactly like the fakes, and absorbs everything messy behind them.
 *
 * PURE. It receives adapters and a store; it has never heard of a tab.
 */

import { Orchestrator } from './orchestrator.js';
import { ProjectMemoryStore } from './projectstore.js';
import { markPhaseComplete, phaseComplete, beginActive, endActive } from './session.js';

/**
 * How a failure should be handled. §17's recovery contract, as data.
 *
 * Expressed as a table rather than scattered `if` statements so the policy can
 * be read in one place and tested exhaustively -- the alternative is recovery
 * behaviour that only exists as an emergent property of five call sites.
 */
export const RECOVERY = {
  'timed-out': { action: 'pause', why: 'the AI did not respond in time', retryable: true },
  malformed: { action: 'pause', why: 'the AI returned an unusable response twice', retryable: true },
  failed: { action: 'pause', why: 'the browser environment is not usable', retryable: false },
  environment: { action: 'block', why: 'the prepared environment changed', retryable: false },
  unknown: { action: 'pause', why: 'an unexpected error occurred', retryable: false },
};

/**
 * Consecutive failures before a run stops rather than pausing.
 *
 * §17: "Repeated adapter failure — stop rather than looping forever." Pausing
 * invites the user to resume; if resuming fails three times in a row, the
 * honest conclusion is that resuming is not the answer.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export class Runner {
  /**
   * @param {object} deps
   * @param {object} deps.manager   ManagerAdapter
   * @param {object} deps.engineer  EngineerAdapter
   * @param {object} deps.reviewer  ReviewerAdapter (optional)
   * @param {object} deps.store     ProjectStore
   * @param {object} [deps.environment] `{ check() }`
   * @param {(e:object)=>void} [deps.onEvent]
   * @param {object} [deps.config]
   */
  constructor({ manager, engineer, reviewer, store, environment = null, onEvent = () => {}, config = {} }) {
    this.adapters = { manager, engineer, reviewer };
    this.store = store;
    this.onEvent = onEvent;
    this.config = config;
    this.consecutiveFailures = 0;
    this.lastFailure = null;

    /*
     * A completed iteration is the only evidence that the system is working
     * again, so it is what clears the failure counter.
     */
    const clearOnProgress = (e) => {
      if (e?.type === 'iteration-finished') this.consecutiveFailures = 0;
      onEvent(e);
    };

    this.orchestrator = new Orchestrator({
      manager: this.managerFacade(),
      engineer: this.engineerFacade(),
      reviewer: this.reviewerFacade(),
      store: new ProjectMemoryStore(store),
      environment,
      config,
      onEvent: clearOnProgress,
    });
  }

  emit(type, data = {}) {
    this.onEvent({ type, at: Date.now(), ...data });
  }

  /**
   * Ensure the record for iteration `n` exists.
   *
   * CALLED FROM EVERY PHASE, not just plan.
   *
   * The first design created the record inside the plan facade, which is wrong
   * for exactly one case and that case is the first iteration of every run:
   * the baseline objective is fixed by the engine and `manager.plan()` is
   * never called, so no record was created and every subsequent phase wrote to
   * null. Found by the end-to-end simulation -- the unit tests never exercised
   * a baseline through the runner.
   *
   * Idempotent, so calling it from four places costs one record.
   */
  async ensureIteration(n) {
    if (!Number.isFinite(n) || n < 1) return this.iteration;
    return this.store.beginIteration(n);
  }

  /** The iteration record currently being written. */
  get iteration() {
    const run = this.store.run;
    return this.store.iterations.find((i) => i.n === run?.currentIteration && !i.finishedAt)
      ?? this.store.iterations[this.store.iterations.length - 1]
      ?? null;
  }

  /* --------------------------------------------------------- idempotency */

  /**
   * Run a phase unless it already ran for this iteration.
   *
   * §17: "Never execute a phase twice merely because the UI restarted."
   *
   * The cached value is returned from the ITERATION RECORD rather than
   * re-derived, because the point is not to skip the work but to reuse its
   * result -- a re-derived value would differ from what was persisted and the
   * two would disagree.
   */
  async once(phase, n, fn, cached) {
    if (phaseComplete(this.store.run, n, phase)) {
      this.emit('phase-skipped', { phase, iteration: n, why: 'already completed in this iteration' });
      return cached();
    }
    this.emit('phase-started', { phase, iteration: n });
    const startedAt = Date.now();
    const out = await fn();
    markPhaseComplete(this.store.run, n, phase);
    const it = this.iteration;
    if (it) it.phases[phase] = { startedAt, finishedAt: Date.now(), ok: true };
    await this.store.checkpoint(it);
    this.emit('phase-completed', { phase, iteration: n, durationMs: Date.now() - startedAt });
    return out;
  }

  /* ------------------------------------------------------------- facades */

  managerFacade() {
    return {
      plan: async (ctx) => {
        const n = ctx.iteration;
        const it = await this.ensureIteration(n);
        return this.guard('plan', () => this.once('plan', n, async () => {
          const plan = await this.adapters.manager.plan({
            ...ctx,
            memory: this.orchestrator.memory,
            baseline: this.store.run?.baseline,
          });
          it.plan = plan;
          it.objective = plan;
          return plan;
        }, () => it.objective));
      },

      evaluate: async (ctx) => {
        const n = this.orchestrator.memory.iteration + 1;
        const it = await this.ensureIteration(n);
        return this.guard('evaluate', () => this.once('evaluate', n, async () => {
          const out = await this.adapters.manager.evaluate({
            ...ctx,
            iteration: n,
            memory: this.orchestrator.memory,
          });
          it.scores = out.scores;
          return out;
        }, () => ({ scores: it?.scores ?? [], openIssues: [], resolved: [] })));
      },
    };
  }

  engineerFacade() {
    return {
      execute: async (ctx) => {
        const n = this.orchestrator.memory.iteration + 1;
        const it = await this.ensureIteration(n);
        return this.guard('execute', () => this.once('execute', n, async () => {
          const first = !this.store.run.baselineDone;
          const out = await this.adapters.engineer.execute({
            ...ctx,
            iteration: n,
            first,
            mode: this.store.run.mode,
            memory: this.orchestrator.memory,
            userPrompt: this.store.project?.scope,
            projectName: this.store.project?.name,
          });

          it.summary = out.summary;
          it.filesChanged = out.filesChanged;
          it.evidence = out.evidence;
          it.artifacts = out.artifacts ?? [];
          it.engineeringReport = out.engineeringReport;
          it.contradictions = out.contradictions ?? [];

          /*
           * Exploration scores arrive from the ENGINEER, uniquely. The
           * baseline's whole job in explore mode is to produce an initial
           * assessment, and there is no other source for it -- the manager has
           * not seen the repository. They are carried through, and
           * `validateScores` has already downgraded anything overclaimed.
           */
          if (first && out.scores?.length) {
            this.store.run.baseline = { ...(this.store.run.baseline ?? {}), scores: out.scores, roadmap: out.roadmap };
          }

          this.emit('evidence-captured', {
            iteration: n,
            kinds: out.evidence.map((e) => e.kind),
            outcome: out.outcome,
          });
          return out;
        }, () => ({
          summary: it?.summary ?? '', filesChanged: it?.filesChanged ?? [], evidence: it?.evidence ?? [],
        })));
      },
    };
  }

  reviewerFacade() {
    if (!this.adapters.reviewer) {
      /*
       * A missing reviewer is not an error. §7 makes DeepSeek optional, and
       * returning `continue` keeps the engine's review phase working without
       * it -- rather than making every caller check whether a reviewer exists.
       */
      return { review: async () => ({ recommendation: 'continue', rationale: 'no reviewer configured' }) };
    }
    return {
      review: async (ctx) => {
        const n = this.orchestrator.memory.iteration + 1;
        const it = await this.ensureIteration(n);
        return this.guard('review', () => this.once('review', n, async () => {
          const out = await this.adapters.reviewer.review({ ...ctx, iteration: n });
          if (it) it.review = out;
          return out;
        }, () => it?.review ?? { recommendation: 'continue' }));
      },
    };
  }

  /* ------------------------------------------------------------ recovery */

  /**
   * Classify a failure and decide what happens to the run.
   *
   * Rethrows so the orchestrator's own error path still records the iteration
   * -- but only after the run state, the failure counter and the reason have
   * been persisted, so a user looking at a paused run sees WHY.
   */
  async guard(phase, fn) {
    try {
      const out = await fn();
      /*
       * ONLY A COMPLETED ITERATION CLEARS THE COUNTER.
       *
       * Resetting on any successful phase made "three consecutive failures"
       * unreachable in the common case: with the manager timing out, the
       * BASELINE execute phase still succeeds (its objective is fixed by the
       * engine and needs no manager), so the count went 1, reset, 1, reset.
       * The run failed after one failure while reporting a policy of three.
       *
       * "Consecutive" has to mean consecutive failures — a phase succeeding in
       * between does not mean the underlying problem went away. The counter is
       * cleared in `start()` when a whole iteration completes.
       */
      return out;
    } catch (err) {
      /*
       * Classified by DUCK TYPING, not by `instanceof AdapterError`.
       *
       * The purity checker rejected importing from ../adapters -- correctly.
       * The core must not depend on the adapter layer, or the dependency
       * arrow points the wrong way and the engine can no longer be reasoned
       * about (or tested) without it.
       *
       * An `outcome` string is a SHAPE the core reacts to, not a class it
       * needs to own. Any adapter -- including one written years from now
       * against an official API -- can participate by setting it. That is the
       * same reasoning the whole adapter boundary rests on, applied to errors.
       */
      const outcome = typeof err?.outcome === 'string' && RECOVERY[err.outcome] ? err.outcome
        : err?.name === 'EnvironmentError' ? 'environment'
          : 'unknown';
      const policy = RECOVERY[outcome] ?? RECOVERY.unknown;

      this.consecutiveFailures++;
      this.lastFailure = { phase, outcome, message: String(err?.message || err), at: Date.now() };

      this.emit('recovery-attempt', {
        phase, outcome, action: policy.action,
        consecutive: this.consecutiveFailures,
        error: this.lastFailure.message,
      });

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        /*
         * STOP, not pause. Pausing invites a resume; if resuming has already
         * failed three times, inviting a fourth is how a run loops forever
         * while appearing to be under control.
         */
        this.store.run.state = 'failed';
        this.store.run.stopReason = 'fatal-error';
        this.store.run.stopDetail =
          `${this.consecutiveFailures} consecutive failures; last: ${this.lastFailure.message}`;
        this.fatal = true;
        await this.store.saveRun();
        this.emit('recovery-failed', {
          phase, outcome, consecutive: this.consecutiveFailures,
          detail: this.store.run.stopDetail,
        });
      } else {
        this.store.run.state = policy.action === 'block' ? 'blocked' : 'paused';
        this.store.run.stopDetail = `${policy.why}: ${this.lastFailure.message}`;
        await this.store.saveRun();
      }

      throw err;
    }
  }

  /* ----------------------------------------------------------------- run */

  async start() {
    if (!this.store.run) await this.store.startRun({ config: this.config });

    /*
     * PREFLIGHT BEFORE CLAIMING TO BE RUNNING.
     *
     * This reintroduced, at the runner level, the exact bug the walking
     * skeleton fixed inside the orchestrator: setting `state = 'running'`
     * unconditionally ERASES a recorded user stop. The user presses Stop, the
     * reason is persisted, and the next start() overwrites it and carries on —
     * the run does eventually halt for some other reason, so nothing looks
     * broken. Caught by an integration test expecting `user-stopped` and
     * getting `budget-exhausted`.
     *
     * The lesson generalises: a wrapper that re-implements a lifecycle needs
     * the guards the thing it wraps already has.
     */
    const run = this.store.run;
    if (run.state === 'stopped' && run.stopReason === 'user-stopped') {
      const verdict = { stop: true, reason: 'user-stopped', why: run.stopDetail || 'stopped by the user' };
      this.emit('run-stopped', verdict);
      return verdict;
    }
    if (run.state === 'failed') {
      const verdict = { stop: true, reason: run.stopReason ?? 'fatal-error', why: run.stopDetail ?? 'unrecoverable failure' };
      this.emit('run-stopped', verdict);
      return verdict;
    }
    if (run.state === 'blocked') {
      const verdict = { stop: false, reason: 'environment-blocked', why: run.stopDetail ?? 'the environment changed' };
      this.emit('run-blocked', verdict);
      return verdict;
    }

    beginActive(run);
    run.state = 'running';
    await this.store.saveRun();

    await this.orchestrator.load(this.store.project.scope, this.store.run.mode);
    this.orchestrator.memory.baselineDone = this.store.run.baselineDone;

    this.emit('run-started', { runId: this.store.run.id, projectId: this.store.project.id });

    try {
      /*
       * THE OUTER RETRY LOOP.
       *
       * `Orchestrator.run()` throws out of `iterate()` on any phase error —
       * correctly, since the engine cannot tell a transient timeout from a
       * broken adapter. So the runner attempts the loop again after a
       * RECOVERABLE failure, and `MAX_CONSECUTIVE_FAILURES` decides when
       * attempting again stops being reasonable.
       *
       * Without this the counter could never exceed 1: the first failure
       * unwound the whole run, so "three consecutive failures" was
       * unreachable and the policy was decorative. Found by an integration
       * test asserting the run stops after repeated failure and finding it
       * stopped after one.
       */
      let verdict = null;
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES; attempt++) {
        try {
          verdict = await this.orchestrator.run();
          break;
        } catch (err) {
          const recoverable = err?.recoverable === true;
          if (!recoverable || this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw err;
          this.emit('run-retrying', {
            attempt: attempt + 1,
            consecutive: this.consecutiveFailures,
            error: String(err?.message || err),
          });
          /*
           * The engine marked itself failed on the way out. Clear that so the
           * next attempt can run — the runner, not the engine, is the
           * authority on whether this failure is terminal.
           */
          this.orchestrator.memory.status = 'running';
          this.store.run.state = 'running';
        }
      }
      if (!verdict) throw new Error('the run made no progress after repeated attempts');

      /*
       * `baselineDone` is folded back explicitly.
       *
       * The engine sets it on `memory`, and `ProjectMemoryStore.save()`
       * projects most fields -- but the run record is the durable authority
       * for whether the baseline happened, and a resume reads it from there.
       * Losing it would re-run the exploration on every restart.
       */
      this.store.run.baselineDone = this.orchestrator.memory.baselineDone;
      this.store.run.baseline = this.orchestrator.memory.baseline ?? this.store.run.baseline;

      endActive(this.store.run);
      if (verdict.stop) {
        /*
         * A fatal failure recorded by `guard()` is not overwritten by the
         * orchestrator's verdict. The engine reports how the LOOP ended; the
         * runner already recorded why it could not continue, and that reason
         * is the more specific and more useful one.
         */
        if (this.store.run.stopReason === 'fatal-error') {
          this.store.run.endedAt = Date.now();
          await this.store.saveRun();
        } else {
          await this.store.stopRun(verdict.reason, verdict.why);
        }
      } else {
        this.store.run.state = this.orchestrator.memory.status === 'blocked' ? 'blocked' : 'paused';
        this.store.run.stopDetail = verdict.why ?? null;
        await this.store.saveRun();
      }
      this.emit('run-finished', { verdict, runId: this.store.run.id });
      return verdict;
    } catch (err) {
      endActive(this.store.run);
      /*
       * Preserve the specific reason `guard()` recorded. Overwriting it with
       * the generic exception message loses "3 consecutive failures" — the
       * fact that tells the user retrying will not help.
       */
      if (!this.store.run.stopReason) {
        this.store.run.state = 'failed';
        this.store.run.stopReason = 'fatal-error';
        this.store.run.stopDetail = this.store.run.stopDetail ?? String(err?.message || err);
      }
      await this.store.saveRun();
      this.emit('run-failed', { error: String(err?.message || err) });
      return {
        stop: true,
        reason: this.store.run.stopReason ?? 'fatal-error',
        why: this.store.run.stopDetail ?? String(err?.message || err),
      };
    } finally {
      for (const it of this.store.iterations) await this.store.saveIteration(it);
      await this.store.saveProject();
    }
  }

  pause() { this.orchestrator.pause(); }
  resume() { this.orchestrator.resume(); }
  async stop() { await this.orchestrator.stop(); await this.store.stopRun('user-stopped', 'stopped by the user'); }
  skipStep() { this.orchestrator.skipStep(); }
  retryStep() { this.orchestrator.retryStep(); }
}
