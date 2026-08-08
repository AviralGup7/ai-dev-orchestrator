/**
 * The vocabulary of the orchestrator.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Three AI systems, three transports and a persistence layer all exchange the
 * same handful of records. If each one defines its own shape, the seams
 * between them become the place bugs live -- and they will be quiet bugs,
 * because a missing field reads as `undefined` and `undefined` is falsy and
 * everything appears to work until a score is silently zero.
 *
 * So: one definition per concept, validated at every boundary.
 *
 * NO IMPORTS. This module is the bottom of the graph.
 */

/* ========================================================================== *
 * EVIDENCE
 * ========================================================================== */

/**
 * The kinds of evidence the system can reason about.
 *
 * TYPED, NOT PROSE, AND THAT IS THE WHOLE POINT.
 *
 * The specification's hardest requirement is that percentages are never
 * guesses. An AI asked "how complete is this project?" will always produce a
 * plausible number -- and will tend to report improvement, because that is the
 * shape of the expected answer. The only defence is to make the score a
 * FUNCTION of things that were actually observed.
 *
 * A test result is `{passed: 1276, failed: 0}`, not "tests are passing well".
 * The first can be compared against the previous iteration; the second cannot
 * be compared against anything.
 */
export const EVIDENCE_KINDS = /** @type {const} */ ([
  'test',      // { passed, failed, skipped }
  'build',     // { ok, durationMs }
  'lint',      // { errors, warnings }
  'diff',      // { filesChanged, insertions, deletions }
  'coverage',  // { linesPct, branchesPct }
  'log',       // { text } -- unstructured, weakest form
]);

/**
 * How much a score can be trusted.
 *
 * THIS IS THE MOST IMPORTANT ENUM IN THE PROJECT.
 *
 * Without it every dimension is a number between 0 and 100 and they all look
 * equally authoritative, including the ones the model invented. With it, the
 * system can refuse to stop on unmeasured dimensions -- which is the only
 * mechanism preventing "we hit 100%, we're done" from being a hallucination.
 *
 *   measured  derived arithmetically from typed evidence
 *   inferred  reasoned from partial or indirect evidence
 *   asserted  the model's opinion, with nothing behind it
 *
 * `asserted` scores are shown differently in the UI and are excluded from stop
 * conditions. They are not banned -- UI quality genuinely cannot be measured
 * from scraped terminal output, and pretending otherwise would be a worse lie
 * than admitting the uncertainty.
 */
export const CONFIDENCE = /** @type {const} */ (['measured', 'inferred', 'asserted']);

/** Ranked, so comparisons like "at least inferred" are expressible. */
export const CONFIDENCE_RANK = { asserted: 0, inferred: 1, measured: 2 };

/* ========================================================================== *
 * SCORING
 * ========================================================================== */

/**
 * The nine dimensions from the specification, plus how each can be known.
 *
 * `computable` marks the dimensions the orchestrator derives ARITHMETICALLY
 * from evidence rather than asking the manager for an opinion. Those are the
 * load-bearing ones: they cannot drift, cannot be flattered, and cannot go up
 * because the model is being encouraging.
 *
 * The rest are genuinely subjective from the orchestrator's vantage point. It
 * sees terminal output and diffs; it does not see the running interface. So
 * `uiux` is asked, and marked `asserted` unless the manager can point at
 * evidence -- and being `asserted` means it cannot satisfy a stop condition.
 */
export const DIMENSIONS = /** @type {const} */ ([
  { key: 'completion', label: 'Completion', computable: false },
  { key: 'quality', label: 'Quality', computable: false },
  { key: 'testing', label: 'Testing', computable: true },
  { key: 'architecture', label: 'Architecture', computable: false },
  { key: 'uiux', label: 'UI/UX', computable: false },
  { key: 'performance', label: 'Performance', computable: false },
  { key: 'security', label: 'Security', computable: false },
  { key: 'documentation', label: 'Documentation', computable: false },
  { key: 'accessibility', label: 'Accessibility', computable: false },
]);

export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key);

/* ========================================================================== *
 * THE ITERATION STATE MACHINE
 * ========================================================================== */

/**
 * Phases, in order.
 *
 * Persisted between each one. An iteration can take minutes of real AI time,
 * so a browser restart mid-run must resume from the last completed phase
 * rather than redoing work or -- worse -- half-redoing it.
 */
export const PHASES = /** @type {const} */ ([
  'plan',      // manager decides the next objective
  'execute',   // engineer does it, and reports evidence
  'evaluate',  // manager scores the result against that evidence
  'detect',    // loop / stagnation analysis (local, no AI)
  'review',    // reviewer's strategic take -- only every Nth iteration
  'decide',    // stop or continue
]);

/** Terminal states for a whole run. */
export const RUN_STATUS = /** @type {const} */ ([
  'idle',
  'running',
  'paused',        // by the user, or awaiting approval
  'stopped',       // a stop condition was satisfied
  'failed',        // unrecoverable; state preserved for inspection
]);

/** Why a run ended. Recorded so the UI can explain rather than just halt. */
export const STOP_REASONS = /** @type {const} */ ([
  'target-reached',
  'no-progress',
  'budget-exhausted',
  'user-stopped',
  'fatal-error',
]);

/* ========================================================================== *
 * CONSTRUCTORS
 * ========================================================================== */

/**
 * A fresh project memory.
 *
 * EVERYTHING THE SYSTEM KNOWS LIVES HERE, and it is a plain serialisable
 * object on purpose: it has to survive a browser restart, and the cheapest
 * durable thing is a value with no behaviour attached.
 */
export function emptyMemory(scope = '') {
  return {
    scope,                  // the user's original description. Never edited.
    phase: 'plan',
    iteration: 0,
    status: 'idle',
    stopReason: null,

    objective: null,        // what this iteration is trying to achieve
    history: [],            // one record per completed iteration
    scores: [],             // one scorecard per evaluation

    openIssues: [],         // known bugs and gaps, carried forward
    resolvedIssues: [],     // kept: recurrence is a loop signal
    decisions: [],          // design choices, so they are not relitigated
    failedAttempts: [],     // what did not work, so it is not retried blindly

    flags: {                // detector output; cleared each iteration
      stagnation: false,
      signals: [],
    },
  };
}

/**
 * One evidence record.
 *
 * `kind` is validated because an unknown kind silently scoring nothing is
 * exactly the class of bug this whole file exists to prevent.
 */
export function makeEvidence(kind, data = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw new TypeError(`unknown evidence kind: ${kind}`);
  }
  return { kind, at: Date.now(), ...data };
}

/**
 * One dimension's score.
 *
 * `basis` is required for anything claiming to be `measured`. A measured score
 * with no evidence behind it is a lie with a badge on, and it is the specific
 * failure this system is built to avoid -- so it is rejected at construction
 * rather than caught later.
 */
export function makeScore(dimension, score, confidence, basis = []) {
  if (!DIMENSION_KEYS.includes(dimension)) {
    throw new TypeError(`unknown dimension: ${dimension}`);
  }
  if (!CONFIDENCE.includes(confidence)) {
    throw new TypeError(`unknown confidence: ${confidence}`);
  }
  if (confidence === 'measured' && basis.length === 0) {
    throw new TypeError(`"${dimension}" claims to be measured with no evidence`);
  }
  return {
    dimension,
    score: clamp(score),
    confidence,
    basis,
  };
}

/** Scores are percentages. Anything else is a bug upstream; clamp and move on. */
export function clamp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}
