/**
 * Turning evidence into scores, and refusing to invent the rest.
 *
 * THE PROBLEM THIS MODULE EXISTS TO SOLVE
 * ---------------------------------------
 * Ask a language model "how complete is this project, 0-100?" and it will
 * answer. It will answer confidently, it will answer instantly, and on the
 * next iteration it will answer with a slightly higher number -- because the
 * conversation is about improvement and a higher number is the shape of the
 * expected reply.
 *
 * Left alone, the dashboard fills with a chart that rises smoothly to 100 and
 * carries no information whatsoever. The user then stops the run believing the
 * project is finished.
 *
 * Three mechanisms here, in decreasing order of strength:
 *
 *   1. COMPUTE what can be computed. `testing` is arithmetic over test counts.
 *      No opinion is solicited, so none can drift.
 *
 *   2. DEMAND A BASIS for anything claiming to be measured. `makeScore` throws
 *      if a `measured` score arrives with an empty `basis`.
 *
 *   3. QUARANTINE the rest. Subjective dimensions are marked `asserted` and
 *      are excluded from stop conditions, so the run cannot end on an opinion.
 *
 * The third is the one that matters most, and it is the reason `overall()`
 * returns a confidence alongside its number.
 */

import { DIMENSION_KEYS, DIMENSIONS, makeScore, clamp, CONFIDENCE_RANK } from './types.js';

/**
 * Score `testing` from evidence alone.
 *
 * WHY THIS IS ARITHMETIC AND NOT A QUESTION
 *
 * Test health is the one dimension with an unambiguous numeric basis, and it
 * is also the dimension a model is most tempted to be generous about ("tests
 * are in good shape"). Computing it removes the temptation entirely.
 *
 * THE FORMULA, AND WHY IT IS SHAPED THIS WAY
 *
 *   pass rate       is the floor -- a failing suite caps everything
 *   coverage        lifts it, when coverage evidence exists
 *   no tests at all scores 0, not 100
 *
 * That last clause is not pedantry. A project with zero tests has a 100% pass
 * rate under a naive `passed / (passed + failed)`, which would hand a
 * brand-new empty repo a perfect testing score. It is the single most likely
 * way this function could flatter a project, so it is handled first.
 *
 * @param {Array<object>} evidence
 * @returns {object|null} a score, or null when there is nothing to go on
 */
export function scoreTesting(evidence) {
  const tests = evidence.filter((e) => e.kind === 'test');
  if (tests.length === 0) return null;

  const passed = sum(tests, 'passed');
  const failed = sum(tests, 'failed');
  const skipped = sum(tests, 'skipped');
  const total = passed + failed + skipped;

  // No tests is not a perfect score. See above.
  if (total === 0) {
    return makeScore('testing', 0, 'measured', tests);
  }

  const passRate = passed / total;

  /*
   * Skipped tests are counted against the score but not as failures.
   *
   * A skipped test is a test someone wrote and then turned off, which is
   * weaker evidence than a passing one and stronger than nothing. Treating it
   * as a pass would let a suite be silently disabled without the score moving
   * -- which is exactly how a green dashboard hides a rotting suite.
   */
  let value = passRate * 100;

  const cov = evidence.filter((e) => e.kind === 'coverage');
  if (cov.length > 0) {
    const lines = avg(cov, 'linesPct');
    /*
     * Coverage MODULATES the pass rate rather than averaging with it.
     *
     * Averaging would let 100% coverage of a failing suite score 50, which is
     * far too kind: a failing build is a failing build. Weighting keeps the
     * pass rate dominant while letting coverage distinguish "12 tests, all
     * passing" from "1,200 tests, all passing".
     */
    value = value * (0.7 + 0.3 * (lines / 100));
  }

  return makeScore('testing', value, 'measured', [...tests, ...cov]);
}

/**
 * Evidence that contradicts a claim.
 *
 * The manager proposes scores; this checks them against what was actually
 * observed and downgrades the ones that do not survive contact.
 *
 * WHY DOWNGRADE RATHER THAN REJECT
 *
 * A rejected score leaves a gap, and a gap in a scorecard reads as zero, which
 * is its own kind of lie. Downgrading keeps the number visible while making
 * clear that nothing supports it -- and an `asserted` score cannot satisfy a
 * stop condition, so the consequence is applied where it matters.
 *
 * @param {Array<object>} proposed  scores from the manager
 * @param {Array<object>} evidence
 */
export function reconcile(proposed, evidence) {
  const hasKind = (k) => evidence.some((e) => e.kind === k);

  return proposed.map((s) => {
    // A claim of `measured` with no basis attached is not measured.
    if (s.confidence === 'measured' && (!s.basis || s.basis.length === 0)) {
      return { ...s, confidence: 'asserted', downgraded: 'no evidence attached' };
    }

    /*
     * A build that failed caps everything.
     *
     * Not just the build-related dimensions -- ALL of them. If the project
     * does not build, no claim about its architecture or completeness means
     * anything, and letting `completion: 90` stand next to a red build is how
     * a dashboard becomes decorative.
     */
    const build = evidence.find((e) => e.kind === 'build');
    if (build && build.ok === false && s.score > 50) {
      return {
        ...s,
        score: 50,
        confidence: 'inferred',
        downgraded: 'the build is failing',
      };
    }

    // A computable dimension asserted without the evidence that would compute
    // it is the model guessing at something checkable.
    const dim = DIMENSIONS.find((d) => d.key === s.dimension);
    if (dim?.computable && s.confidence === 'measured' && !hasKind('test')) {
      return { ...s, confidence: 'inferred', downgraded: 'no test evidence' };
    }

    return s;
  });
}

/**
 * Merge computed scores over proposed ones.
 *
 * Computed wins. Always. The manager's opinion about test health is not
 * consulted when the test output is right there.
 */
export function merge(proposed, computed) {
  const out = new Map(proposed.map((s) => [s.dimension, s]));
  for (const c of computed) {
    if (c) out.set(c.dimension, c);
  }
  return [...out.values()];
}

/**
 * The headline number.
 *
 * RETURNS A CONFIDENCE ALONGSIDE IT, which is the point. A single percentage
 * with no qualifier is exactly the thing this module exists to prevent -- the
 * caller has to receive, and therefore has to handle, the fact that the number
 * may rest on nothing.
 *
 * The overall confidence is the WEAKEST of its parts, not the average. One
 * asserted dimension makes the whole picture uncertain, and averaging
 * confidences would let eight measured dimensions launder one invented one.
 */
export function overall(scores) {
  if (!scores || scores.length === 0) {
    return { score: 0, confidence: 'asserted', missing: DIMENSION_KEYS };
  }

  const present = scores.filter((s) => DIMENSION_KEYS.includes(s.dimension));
  const missing = DIMENSION_KEYS.filter(
    (k) => !present.some((s) => s.dimension === k)
  );

  /*
   * A missing dimension counts as zero rather than being skipped.
   *
   * Averaging only what was reported means a manager that scores one dimension
   * and ignores eight gets a perfect overall. The denominator is the number of
   * dimensions that EXIST, not the number that were answered.
   */
  const total = present.reduce((n, s) => n + s.score, 0);
  const value = clamp(total / DIMENSION_KEYS.length);

  const weakest = present.reduce(
    (w, s) => (CONFIDENCE_RANK[s.confidence] < CONFIDENCE_RANK[w] ? s.confidence : w),
    'measured'
  );

  return {
    score: value,
    confidence: missing.length > 0 ? 'asserted' : weakest,
    missing,
  };
}

/** Dimensions that rest on nothing. The stop condition consults this. */
export function unmeasured(scores) {
  return (scores || [])
    .filter((s) => s.confidence === 'asserted')
    .map((s) => s.dimension);
}

function sum(rows, key) {
  return rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
}

function avg(rows, key) {
  const vals = rows.map((r) => Number(r[key])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
