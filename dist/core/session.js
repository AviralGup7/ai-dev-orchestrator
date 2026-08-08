/**
 * PROJECT / SESSION / RUN / ITERATION / PHASE.
 *
 * Until now `memory` conflated all of these: one object with a scope, an
 * iteration counter and a history. That is enough for a walking skeleton and
 * wrong for a product, because the four concepts have genuinely different
 * lifetimes and the difference is exactly what a user asks about after a
 * crash.
 *
 *   PROJECT    the thing being improved. Survives everything. One scope, one
 *              repository, many runs over days.
 *   SESSION    one lifetime of the extension's worker. Ends on eviction,
 *              browser restart, or reload. A run spans MANY sessions.
 *   RUN        one press of Start to one stop condition. Has a target, a
 *              budget, and exactly one stop reason.
 *   ITERATION  one plan/execute/evaluate/detect/review cycle within a run.
 *   PHASE      one step within an iteration.
 *
 * WHY THIS DISTINCTION IS LOAD-BEARING AND NOT BOOKKEEPING
 * --------------------------------------------------------
 * An MV3 service worker is evicted after ~30 seconds idle, and this
 * orchestrator spends most of its life waiting for an AI. So sessions end
 * constantly, mid-run, as normal operation. If session and run were the same
 * object, every eviction would look like a run ending -- and "why did it
 * stop?" would have no answer, because nothing stopped; the browser just went
 * to sleep.
 *
 * The §4 questions each map to a field here, and the mapping is the design:
 *
 *   What project was running?          project.id / project.scope
 *   What run was active?               project.activeRunId
 *   Which iteration was active?        run.currentIteration
 *   Which phase completed last?        run.lastCompletedPhase
 *   What was the last objective?       iteration.objective
 *   What evidence was captured?        iteration.evidence
 *   What score was produced?           iteration.scores
 *   Why did the run stop?              run.stopReason + run.stopDetail
 *   What happened before failure?      run.lastEvents (a ring, persisted)
 *   Can the run safely resume?         resumability(run)
 *
 * PURE.
 */

import { PHASES, emptyMemory } from './types.js';

/** Bumped whenever a persisted shape changes. See migrate.js. */
export const SCHEMA_VERSION = 3;

export const RUN_STATES = /** @type {const} */ ([
  'idle', 'running', 'paused', 'blocked', 'stopped', 'failed',
]);

/* ========================================================================== *
 * CONSTRUCTORS
 * ========================================================================== */

let counter = 0;
/** Ids are readable and sortable. Not security tokens. */
export function makeId(prefix, now = Date.now()) {
  const t = new Date(now).toISOString().slice(2, 19).replace(/[-:T]/g, '');
  return `${prefix}-${t}-${String(++counter % 46656).toString(36).padStart(3, '0')}`;
}

export function makeProject({ scope = '', mode = 'new', name = '' } = {}, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId('prj', now),
    name: String(name || '').slice(0, 200),
    scope: String(scope || '').slice(0, 4000),
    mode,
    createdAt: now,
    updatedAt: now,
    activeRunId: null,
    runIds: [],
    /*
     * Knowledge that outlives a run. A second run on the same project must not
     * relitigate design decisions or rediscover the same bugs -- that is
     * `objective-repeat` across runs, which the detector cannot see because it
     * only looks within one.
     */
    decisions: [],
    knownIssues: [],
    technicalDebt: [],
    resolvedIssues: [],
  };
}

export function makeRun({ projectId, config = {}, mode = 'new' } = {}, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId('run', now),
    projectId,
    mode,
    config,
    state: 'idle',
    startedAt: now,
    endedAt: null,
    /** Total wall time actually running, excluding pauses and evictions. */
    activeMs: 0,
    _resumedAt: null,
    currentIteration: 0,
    lastCompletedPhase: null,
    /** Which phases of the CURRENT iteration are done. Idempotency, §17. */
    completedPhases: [],
    stopReason: null,
    stopDetail: null,
    baselineDone: false,
    baseline: null,
    /** Sessions this run has lived through. A long run has many. */
    sessionIds: [],
    iterationIds: [],
  };
}

export function makeSession({ runId = null, projectId = null } = {}, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId('ses', now),
    runId,
    projectId,
    startedAt: now,
    endedAt: null,
    /*
     * How the previous session ended, decided on the NEXT startup. A session
     * that was evicted never gets to write anything -- so "ended cleanly" is
     * something only its successor can observe, by finding no `endedAt`.
     */
    endedBy: null, // 'clean' | 'evicted' | 'unknown'
    events: 0,
  };
}

export function makeIteration({ runId, n, projectId } = {}, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId('itr', now),
    runId,
    projectId,
    n,
    startedAt: now,
    finishedAt: null,
    phases: {},          // phase -> { startedAt, finishedAt, ok, error }
    objective: null,
    plan: null,
    summary: '',
    filesChanged: [],
    evidence: [],
    scores: [],
    overall: null,
    confidence: null,
    signals: [],
    review: null,
    decision: null,
    artifacts: [],
    skipped: [],
    retried: [],
    error: null,
  };
}

/* ========================================================================== *
 * PHASE BOOKKEEPING
 * ========================================================================== */

/**
 * Has this phase of this iteration already completed?
 *
 * §17: "Never execute a phase twice merely because the UI restarted."
 *
 * The scenario is concrete and expensive: the worker is evicted while waiting
 * for Arena, the run resumes, and without this check it re-sends the execute
 * prompt. Arena does the work AGAIN -- possibly committing the same change
 * twice -- and the second response overwrites evidence from the first.
 */
export function phaseComplete(run, iterationN, phase) {
  if (!run) return false;
  if (run.currentIteration !== iterationN) return false;
  return (run.completedPhases || []).includes(phase);
}

export function markPhaseComplete(run, iterationN, phase, now = Date.now()) {
  if (run.currentIteration !== iterationN) {
    // A new iteration: the previous iteration's completions no longer apply.
    run.currentIteration = iterationN;
    run.completedPhases = [];
  }
  if (!run.completedPhases.includes(phase)) run.completedPhases.push(phase);
  run.lastCompletedPhase = phase;
  run.updatedAt = now;
  return run;
}

/** The next phase to run, or null when the iteration is done. */
export function nextPhase(run, iterationN) {
  if (run.currentIteration !== iterationN) return PHASES[0];
  const done = new Set(run.completedPhases || []);
  return PHASES.find((p) => p !== 'decide' && !done.has(p)) ?? null;
}

/* ========================================================================== *
 * RESUMABILITY
 * ========================================================================== */

/**
 * May this run be resumed, and what would resuming mean?
 *
 * The answer is not a boolean in the UI's sense -- "yes but you will lose the
 * half-finished execute phase" is a different answer from "yes, cleanly", and
 * a user deciding whether to resume or start over needs to know which.
 */
export function resumability(run, { now = Date.now(), staleMs = 6 * 3600_000 } = {}) {
  if (!run) return { resumable: false, why: 'there is no run to resume' };

  if (run.state === 'stopped' && run.stopReason === 'user-stopped') {
    /*
     * §18: "If the user presses Stop: do not restart automatically."
     * Resumable in principle, never automatically -- the distinction the UI
     * needs to offer a button without a background task pressing it.
     */
    return { resumable: true, requiresUser: true, why: 'you stopped this run; it will not restart on its own' };
  }
  if (run.state === 'stopped') {
    return { resumable: false, why: `this run ended: ${run.stopDetail || run.stopReason}` };
  }
  if (run.state === 'failed') {
    return { resumable: true, requiresUser: true, why: 'this run failed; state is preserved for inspection' };
  }
  if (run.state === 'blocked') {
    return { resumable: true, requiresUser: true, why: 'the environment changed; restore it and resume' };
  }

  const age = now - (run.updatedAt || run.startedAt || now);
  if (age > staleMs) {
    return {
      resumable: true,
      requiresUser: true,
      stale: true,
      why: `this run last moved ${Math.round(age / 3600_000)}h ago; the AI conversations have probably moved on`,
    };
  }

  const phase = nextPhase(run, run.currentIteration);
  return {
    resumable: true,
    requiresUser: false,
    why: phase
      ? `resumes iteration ${run.currentIteration} at the ${phase} phase`
      : `resumes at iteration ${run.currentIteration + 1}`,
  };
}

/* ========================================================================== *
 * TIME
 * ========================================================================== */

/**
 * Accumulate active time.
 *
 * Elapsed wall-clock is the wrong number for a run that spans days of pauses
 * and evictions: it would report "37 hours" for two hours of work and make
 * every duration analytic meaningless. Time is counted only between resume and
 * pause.
 */
export function beginActive(run, now = Date.now()) {
  if (run._resumedAt == null) run._resumedAt = now;
  return run;
}

export function endActive(run, now = Date.now()) {
  if (run._resumedAt != null) {
    run.activeMs = (run.activeMs || 0) + (now - run._resumedAt);
    run._resumedAt = null;
  }
  return run;
}

export function activeMs(run, now = Date.now()) {
  if (!run) return 0;
  const live = run._resumedAt != null ? now - run._resumedAt : 0;
  return (run.activeMs || 0) + live;
}

/* ========================================================================== *
 * BRIDGE TO THE EXISTING ENGINE
 * ========================================================================== */

/**
 * Build the `memory` shape the Orchestrator already understands.
 *
 * DELIBERATELY A PROJECTION, NOT A REPLACEMENT.
 *
 * The engine, its 247 tests and every guarantee they encode are built on
 * `memory`. Rewriting it to consume the session model would mean rewriting
 * `stop.js`, `detect.js` and every orchestrator test -- risking guarantees
 * that were paid for with sabotage verification, to gain nothing the engine
 * needs. §35 says preserve existing work; this is how.
 *
 * The session model is the PERSISTENCE and REPORTING structure. The engine
 * keeps its flat working state, and the two are reconciled at the boundary.
 */
export function toMemory(project, run, iterations = []) {
  const mem = emptyMemory(project?.scope ?? '', run?.mode ?? project?.mode ?? 'new');

  mem.status = run?.state === 'running' ? 'running' : run?.state ?? 'idle';
  mem.iteration = iterations.filter((i) => i.finishedAt).length;
  mem.phase = nextPhase(run, run?.currentIteration ?? 0) ?? 'plan';
  mem.stopReason = run?.stopReason ?? null;
  mem.baselineDone = run?.baselineDone ?? false;
  mem.baseline = run?.baseline ?? null;

  mem.history = iterations.map((i) => ({
    n: i.n,
    objective: i.objective,
    summary: i.summary,
    filesChanged: i.filesChanged,
    evidence: i.evidence,
    overall: i.overall,
    confidence: i.confidence,
    signals: i.signals,
    reviewed: Boolean(i.review),
    review: i.review,
    skipped: i.skipped,
    retried: i.retried,
    startedAt: i.startedAt,
    finishedAt: i.finishedAt,
    error: i.error,
  }));

  mem.scores = iterations
    .filter((i) => i.scores?.length)
    .map((i) => ({ n: i.n, scores: i.scores, at: i.finishedAt ?? i.startedAt }));

  mem.openIssues = project?.knownIssues ?? [];
  mem.resolvedIssues = project?.resolvedIssues ?? [];
  mem.decisions = project?.decisions ?? [];

  const last = iterations[iterations.length - 1];
  mem.objective = last?.objective ?? null;
  mem.flags = { stagnation: Boolean(last?.signals?.length >= 2), signals: last?.signals ?? [] };

  return mem;
}

/**
 * Fold engine state back into the session model.
 *
 * The inverse of `toMemory`. Called after each phase so the durable record
 * matches what the engine believes, which is the property that makes a
 * mid-iteration eviction recoverable.
 */
export function fromMemory(memory, { project, run, iteration }) {
  if (project) {
    project.knownIssues = memory.openIssues ?? project.knownIssues;
    project.resolvedIssues = memory.resolvedIssues ?? project.resolvedIssues;
    project.decisions = memory.decisions ?? project.decisions;
    project.updatedAt = Date.now();
    if (memory.scope && memory.scope !== project.scope) project.scope = memory.scope;
  }
  if (run) {
    run.state = memory.status === 'running' ? 'running' : memory.status;
    run.stopReason = memory.stopReason ?? run.stopReason;
    run.baselineDone = memory.baselineDone ?? run.baselineDone;
    run.baseline = memory.baseline ?? run.baseline;
    run.updatedAt = Date.now();
  }
  if (iteration) {
    const rec = memory.history?.[memory.history.length - 1];
    if (rec && rec.n === iteration.n) {
      Object.assign(iteration, {
        objective: rec.objective ?? iteration.objective,
        summary: rec.summary ?? iteration.summary,
        filesChanged: rec.filesChanged ?? iteration.filesChanged,
        evidence: rec.evidence ?? iteration.evidence,
        overall: rec.overall ?? iteration.overall,
        confidence: rec.confidence ?? iteration.confidence,
        signals: rec.signals ?? iteration.signals,
        review: rec.review ?? iteration.review,
        skipped: rec.skipped ?? iteration.skipped,
        retried: rec.retried ?? iteration.retried,
        finishedAt: rec.finishedAt ?? iteration.finishedAt,
        error: rec.error ?? iteration.error,
      });
    }
  }
  return { project, run, iteration };
}

/** The §4 questions, answered from persisted state. */
export function describeState({ project, run, iterations = [] }) {
  const current = iterations[iterations.length - 1];
  const r = resumability(run);
  return {
    project: project ? `${project.name || 'Untitled'} — ${project.scope.slice(0, 120)}` : 'none',
    run: run ? `${run.id} (${run.state})` : 'none',
    iteration: run?.currentIteration ?? 0,
    lastCompletedPhase: run?.lastCompletedPhase ?? 'none',
    lastObjective: current?.objective?.text ?? 'none',
    evidenceCaptured: (current?.evidence || []).map((e) => e.kind),
    lastScore: current?.overall ?? null,
    stopReason: run?.stopReason ?? null,
    stopDetail: run?.stopDetail ?? null,
    resumable: r.resumable,
    resumeNote: r.why,
  };
}
