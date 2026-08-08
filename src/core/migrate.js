/**
 * SCHEMA VERSIONING AND MIGRATION.
 *
 * The extension will be updated while a project is stored. Without migration
 * the choices are: crash on old data, or silently misread it. Both are worse
 * than the third option, which is to state the shape's version and transform
 * it forward.
 *
 * WHY THIS IS NOT OVER-ENGINEERING FOR AN UNRELEASED PRODUCT
 * ----------------------------------------------------------
 * The shape has ALREADY changed three times in this repository's short life:
 * `mode` and `baselineDone` were added in the first-run work, `block` in the
 * environment work, and `session/run/iteration` now. Each of those would have
 * broken a stored project. Two of them were handled with ad-hoc defaults
 * scattered in `load()` -- which works until the fourth change, when nobody
 * remembers which defaults exist and why.
 *
 * THE RULES
 *
 *   1. MIGRATIONS ARE PURE FUNCTIONS, v -> v+1. No side effects, no storage
 *      access, so each is testable in isolation and the chain is composable.
 *   2. THEY NEVER THROW ON BAD DATA. A migration that crashes on a corrupt
 *      record takes the whole extension down at startup, which is the worst
 *      possible moment. They repair what they can and report what they could
 *      not.
 *   3. THE ORIGINAL IS PRESERVED when a migration gives up, under
 *      `__unmigrated`. Deleting a user's project because we could not read it
 *      is not an acceptable failure mode.
 *   4. FUTURE VERSIONS ARE REFUSED, NOT DOWNGRADED. Data written by a newer
 *      extension may contain fields this build would drop on write-back --
 *      silently destroying them. Better to refuse and say so.
 *
 * PURE.
 */

import { SCHEMA_VERSION } from './session.js';

/**
 * The migration chain.
 *
 * Each entry migrates FROM its index TO index+1. Written as a sparse object so
 * a gap is a loud `undefined` rather than a silently skipped step.
 */
export const MIGRATIONS = {
  /**
   * v0 -> v1: the walking skeleton's unversioned memory.
   *
   * Everything before versioning existed. Identified by the absence of
   * `schemaVersion` and the presence of `iteration`.
   */
  0: (data) => ({
    ...data,
    schemaVersion: 1,
    mode: data.mode ?? (data.history?.length ? 'existing' : 'new'),
    baselineDone: data.baselineDone ?? (data.history?.length ?? 0) > 0,
    baseline: data.baseline ?? null,
  }),

  /** v1 -> v2: the environment contract added `block`. */
  1: (data) => ({
    ...data,
    schemaVersion: 2,
    block: data.block ?? null,
    flags: data.flags ?? { stagnation: false, signals: [] },
  }),

  /**
   * v2 -> v3: the session/run/iteration split.
   *
   * The interesting one. A flat `memory` becomes a project, one run, and one
   * iteration per history entry -- so a project stored by the old build opens
   * in the new UI with its history intact rather than as a fresh start.
   */
  2: (data) => {
    if (data.project && data.run) return { ...data, schemaVersion: 3 };

    const now = Date.now();
    const history = Array.isArray(data.history) ? data.history : [];
    const scoresByN = new Map((data.scores || []).map((s) => [s.n, s.scores]));

    const project = {
      schemaVersion: 3,
      id: `prj-migrated-${now}`,
      name: '',
      scope: data.scope ?? '',
      mode: data.mode ?? 'existing',
      createdAt: history[0]?.startedAt ?? now,
      updatedAt: now,
      activeRunId: `run-migrated-${now}`,
      runIds: [`run-migrated-${now}`],
      decisions: data.decisions ?? [],
      knownIssues: data.openIssues ?? [],
      technicalDebt: [],
      resolvedIssues: data.resolvedIssues ?? [],
    };

    const run = {
      schemaVersion: 3,
      id: `run-migrated-${now}`,
      projectId: project.id,
      mode: project.mode,
      config: {},
      /*
       * A migrated run is `paused`, never `running`.
       *
       * The old record may say running, but nothing is: the worker that
       * believed it died in a previous version of the extension. Restoring it
       * as running would show a live spinner over a run with no future, and
       * the user would wait for it.
       */
      state: data.status === 'running' ? 'paused' : (data.status ?? 'idle'),
      startedAt: history[0]?.startedAt ?? now,
      endedAt: null,
      activeMs: 0,
      _resumedAt: null,
      currentIteration: data.iteration ?? 0,
      lastCompletedPhase: null,
      completedPhases: [],
      stopReason: data.stopReason ?? null,
      stopDetail: data.status === 'running' ? 'migrated from an older version while running' : null,
      baselineDone: data.baselineDone ?? history.length > 0,
      baseline: data.baseline ?? null,
      sessionIds: [],
      iterationIds: [],
      updatedAt: now,
    };

    const iterations = history.map((h, i) => ({
      schemaVersion: 3,
      id: `itr-migrated-${now}-${i}`,
      runId: run.id,
      projectId: project.id,
      n: h.n ?? i + 1,
      startedAt: h.startedAt ?? now,
      finishedAt: h.finishedAt ?? null,
      phases: {},
      objective: h.objective ?? null,
      plan: null,
      summary: h.summary ?? '',
      filesChanged: h.filesChanged ?? [],
      evidence: h.evidence ?? [],
      scores: scoresByN.get(h.n) ?? [],
      overall: h.overall ?? null,
      confidence: h.confidence ?? null,
      signals: h.signals ?? [],
      review: h.review ?? null,
      decision: null,
      artifacts: [],
      skipped: h.skipped ?? [],
      retried: h.retried ?? [],
      error: h.error ?? null,
    }));
    run.iterationIds = iterations.map((i) => i.id);

    return { schemaVersion: 3, project, run, iterations, __migratedFrom: 2 };
  },
};

/** Detect the version of a record that may predate versioning. */
export function detectVersion(data) {
  if (!data || typeof data !== 'object') return null;
  if (Number.isFinite(data.schemaVersion)) return data.schemaVersion;
  if (data.project && data.run) return 3;
  if ('block' in data) return 2;
  if ('mode' in data || 'baselineDone' in data) return 1;
  if ('iteration' in data || 'history' in data) return 0;
  return null;
}

/**
 * Migrate a record to the current schema.
 *
 * @returns {{ok, data, from, to, steps, problems}}
 */
export function migrate(data, { target = SCHEMA_VERSION } = {}) {
  const problems = [];
  if (data == null) return { ok: true, data: null, from: null, to: target, steps: [], problems };

  const from = detectVersion(data);
  if (from === null) {
    /*
     * Unrecognisable data is NOT deleted and NOT guessed at. Returning it
     * untouched with a problem lets the caller decide -- and the caller (the
     * store) starts fresh while keeping the original for inspection.
     */
    return {
      ok: false,
      data: null,
      from: null,
      to: target,
      steps: [],
      problems: ['the stored record has no recognisable shape'],
      original: data,
    };
  }

  if (from > target) {
    return {
      ok: false,
      data: null,
      from,
      to: target,
      steps: [],
      problems: [
        `the stored data is version ${from}, but this build understands ${target}. ` +
        'It was written by a newer version of the extension. Update, or start a new project — ' +
        'writing it back with this build would discard fields it does not know about.',
      ],
      original: data,
    };
  }

  let current = data;
  const steps = [];
  for (let v = from; v < target; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      problems.push(`no migration from version ${v} to ${v + 1}`);
      return { ok: false, data: null, from, to: target, steps, problems, original: data };
    }
    try {
      current = step(structuredClone(current));
      steps.push(`${v}→${v + 1}`);
    } catch (err) {
      /*
       * A throwing migration is contained rather than propagated. It runs at
       * extension startup, and an uncaught error there is a worker that never
       * registers -- the user sees a dead extension, not a data problem.
       */
      problems.push(`migration ${v}→${v + 1} failed: ${String(err?.message || err)}`);
      return { ok: false, data: null, from, to: target, steps, problems, original: data };
    }
  }

  return { ok: true, data: current, from, to: target, steps, problems };
}

/* ========================================================================== *
 * CORRUPTION
 * ========================================================================== */

/**
 * Structural checks on a migrated record.
 *
 * §5 lists corruption, partial writes and duplicate writes. This catches the
 * shapes those produce: a run pointing at a project that is not there, an
 * iteration list with holes, a truncated write leaving a required field
 * missing.
 */
export function checkIntegrity(state) {
  const problems = [];
  const repairs = [];
  if (!state) return { ok: true, problems, repairs, state };

  const { project, run, iterations } = state;

  if (run && project && run.projectId !== project.id) {
    problems.push(`run ${run.id} belongs to project ${run.projectId}, not ${project.id}`);
  }

  if (Array.isArray(iterations)) {
    const ns = iterations.map((i) => i.n).sort((a, b) => a - b);
    for (let i = 1; i < ns.length; i++) {
      if (ns[i] === ns[i - 1]) {
        problems.push(`duplicate iteration number ${ns[i]} — a partial write may have been retried`);
      } else if (ns[i] !== ns[i - 1] + 1) {
        /*
         * A gap is a WARNING repaired by renumbering nothing: the iterations
         * that exist are real, and inventing the missing one would fabricate
         * history. The gap itself is the honest record of a lost write.
         */
        repairs.push(`iteration ${ns[i - 1] + 1} is missing (a write was lost); history has a gap`);
      }
    }

    for (const it of iterations) {
      if (!it.id || !it.runId) problems.push(`an iteration is missing its identity — write was truncated`);
      if (it.finishedAt && it.finishedAt < it.startedAt) {
        repairs.push(`iteration ${it.n} finished before it started; clock skew or a bad write`);
        it.finishedAt = it.startedAt;
      }
    }
  }

  if (run && run.currentIteration < 0) {
    repairs.push('negative iteration counter reset to 0');
    run.currentIteration = 0;
  }

  return { ok: problems.length === 0, problems, repairs, state };
}
