/**
 * Deciding when to stop.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * "When is it done?" is the question the whole system exists to answer, and it
 * is the one an autonomous loop gets wrong in the most expensive way. Two
 * failure modes, opposite and equally bad:
 *
 *   STOPPING TOO EARLY  the model declares victory on an opinion, the user
 *                       believes it, and ships something unfinished.
 *
 *   NEVER STOPPING      the loop runs all night producing plausible objectives
 *                       against a project that stopped improving at iteration
 *                       six, burning tokens and the user's trust.
 *
 * The defence against the first is `unmeasured`: a run cannot end on scores
 * that rest on nothing. The defence against the second is that three separate
 * conditions can halt a run, and none of them requires the AI to agree.
 */

import { overall, unmeasured } from './scoring.js';
import { iterationIsTrustworthy, describeSkips } from './controls.js';

export const DEFAULTS = {
  /** Overall score the user is aiming at. */
  target: 90,
  /** Hard ceiling on iterations, so a runaway loop is bounded by arithmetic. */
  maxIterations: 50,
  /** Strategic reviews with < this much movement before giving up. */
  noProgressReviews: 3,
  /** Minimum overall movement that counts as progress. */
  progressEpsilon: 2,
  /**
   * A drop of this many points across the review window is a REGRESSION, not
   * a plateau, and is reported as such.
   *
   * Deliberately not derived from `progressEpsilon`. That answers "is this
   * progress?"; this answers "is this damage?". Sharing one number would mean
   * every run too flat to continue was also announced as broken, and a
   * warning that fires on ordinary stagnation stops being read.
   *
   * 5 points is above scoring noise -- a single dimension moving one bucket
   * shifts the overall by roughly a point -- and well below the collapses
   * this exists to catch (the demonstrated case was 41 points).
   */
  regressionDrop: 5,
  /**
   * Dimensions that MUST be measured or inferred -- never asserted -- before
   * a run may stop as complete.
   *
   * Testing is here because it is the one dimension that is genuinely
   * computable, so an asserted testing score means the engineer never ran the
   * suite. That is not a project that is finished; it is a project nobody
   * checked.
   */
  mandatory: ['testing'],

  /*
   * How many of the nine dimensions must rest on real evidence before the
   * target can be declared reached.
   *
   * ADDED AFTER AN ADVERSARIAL TEST BROKE THE CENTRAL GUARANTEE.
   *
   * The old rule only required the MANDATORY dimensions to be evidenced. A
   * manager returning 95% `asserted` on all nine still cleared the bar,
   * because `testing` was computed honestly from real evidence and the other
   * eight -- pure opinion -- carried the average over 90. The run stopped as
   * `target-reached` on a scorecard that was one measured number and eight
   * guesses.
   *
   * That is precisely the failure docs/SPEC.md claims to prevent, and it
   * survived until an integration test made the manager flatter deliberately.
   *
   * Four is the defensible floor: from terminal output one can realistically
   * measure testing, and infer completion, quality and documentation from
   * diffs, lint and file changes. Architecture, UI/UX and accessibility
   * genuinely cannot be measured this way -- the spec says so -- and demanding
   * them would make completion unreachable rather than honest.
   */
  minEvidencedDimensions: 4,
};

/**
 * Should this run stop?
 *
 * @param {object} memory
 * @param {object} [config]
 * @returns {{stop: boolean, reason: string|null, why: string}}
 */
export function shouldStop(memory, config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  /* -- the user's word beats everything --------------------------------- */
  if (memory.status === 'stopped' && memory.stopReason === 'user-stopped') {
    return { stop: true, reason: 'user-stopped', why: 'stopped by the user' };
  }

  /* -- a fatal error halts, with state intact for inspection ------------- */
  if (memory.status === 'failed') {
    return { stop: true, reason: 'fatal-error', why: 'unrecoverable failure' };
  }

  /* -- budget ------------------------------------------------------------ */
  if (memory.iteration >= cfg.maxIterations) {
    return {
      stop: true,
      reason: 'budget-exhausted',
      why: `reached the ${cfg.maxIterations}-iteration limit`,
    };
  }

  const latest = memory.scores?.[memory.scores.length - 1];

  /* -- target reached, and actually demonstrated ------------------------- */
  if (latest) {
    const o = overall(latest.scores || []);
    if (o.score >= cfg.target) {
      /*
       * THE CLAUSE THAT STOPS THE SYSTEM DECLARING VICTORY ON VIBES.
       *
       * Hitting the target is necessary and not sufficient. If the mandatory
       * dimensions rest on nothing, the number is an opinion wearing a
       * percentage sign -- and this is the exact moment where believing it
       * costs the user the most, because they will stop and ship.
       *
       * So the run CONTINUES, with an explicit reason. That is deliberate: the
       * next objective becomes "produce the missing evidence", which is
       * genuinely the most valuable thing left to do.
       */
      const scores = latest.scores || [];
      const weak = unmeasured(scores);
      const blocking = cfg.mandatory.filter((d) => weak.includes(d));

      /*
       * ASSERTED SCORES MAY NOT CARRY A RUN OVER THE LINE.
       *
       * Two independent checks, because either alone is insufficient:
       *
       *   1. ENOUGH dimensions must be evidenced. Otherwise one honest number
       *      plus eight opinions clears the bar.
       *   2. The evidenced dimensions must reach the target BY THEMSELVES.
       *      Otherwise a 40% measured reality is lifted over 90% by confident
       *      guesses elsewhere -- which is the same failure arriving by
       *      arithmetic instead of by count.
       *
       * Opinions can decline to help. They cannot promote.
       */
      const evidenced = scores.filter((x) => x.confidence !== 'asserted');
      if (evidenced.length < cfg.minEvidencedDimensions) {
        return {
          stop: false,
          reason: null,
          why: `${o.score}% reached, but only ${evidenced.length} of ${scores.length} dimensions rest on evidence ` +
            `(at least ${cfg.minEvidencedDimensions} must). The next objective should produce that evidence.`,
        };
      }

      const evidencedScore = Math.round(
        evidenced.reduce((sum, x) => sum + x.score, 0) / evidenced.length,
      );
      if (evidencedScore < cfg.target) {
        return {
          stop: false,
          reason: null,
          why: `${o.score}% overall, but only ${evidencedScore}% across the dimensions backed by evidence ` +
            '— the rest is opinion and cannot carry the run over the target',
        };
      }

      if (blocking.length > 0) {
        return {
          stop: false,
          reason: null,
          why: `${o.score}% reached, but ${blocking.join(', ')} rests on no evidence`,
        };
      }

      if (o.missing.length > 0) {
        return {
          stop: false,
          reason: null,
          why: `${o.score}% reached, but ${o.missing.length} dimension(s) were never scored`,
        };
      }

      /*
       * YOU MAY SKIP. YOU MAY NOT SKIP YOUR WAY TO "DONE".
       *
       * The user can step over `execute` or `evaluate` from the UI. That is
       * permitted -- refusing outright just gets worked around by stopping and
       * restarting, which hides the skip entirely. But the iteration that
       * produced the winning scorecard must have actually done the work behind
       * it, or the target has been reached on a record with holes in it.
       *
       * Only the iteration whose scores are being trusted is checked. Skipping
       * a review in iteration 3 has no bearing on evidence gathered in
       * iteration 20; failing the run for it would make Skip useless.
       */
      const deciding = memory.history?.[memory.history.length - 1];
      if (!iterationIsTrustworthy(deciding)) {
        return {
          stop: false,
          reason: null,
          why: `${o.score}% reached, but ${describeSkips(deciding)}`,
        };
      }

      return {
        stop: true,
        reason: 'target-reached',
        why: `overall ${o.score}% (target ${cfg.target}%), all dimensions evidenced`,
      };
    }
  }

  /* -- no meaningful progress across several reviews --------------------- */
  const reviews = memory.history?.filter((r) => r.reviewed) || [];
  if (reviews.length >= cfg.noProgressReviews) {
    // Named `span`, not `window`: shadowing a browser global inside a module
    // that is contractually browser-free is confusing to read and, as it
    // turned out, trips the purity checker that enforces the contract.
    const span = reviews.slice(-cfg.noProgressReviews);
    const first = span[0].overall;
    const last = span[span.length - 1].overall;
    if (Number.isFinite(first) && Number.isFinite(last)) {
      const delta = last - first;

      /*
       * A COLLAPSE IS NOT A PLATEAU. CHECKED FIRST, DELIBERATELY.
       *
       * This compared `delta < epsilon` unsigned, so a project that fell from
       * 82% to 41% produced:
       *
       *   reason: 'no-progress'
       *   why:    "only -41.0 points across 3 strategic reviews"
       *
       * -- the same verdict as a run that had not moved at all, distinguished
       * only by a minus sign buried after the word "only". The two demand
       * opposite responses from the user: a plateau means try a different
       * objective, a collapse means revert. Giving the wrong one at the exact
       * moment the run ends is worse than giving none, because they act on it.
       *
       * `regressionDrop` is a separate threshold from `progressEpsilon`. They
       * answer different questions -- "is this progress?" and "is this
       * damage?" -- and tying them together would mean any run too flat to
       * continue was also reported as broken.
       */
      if (delta <= -cfg.regressionDrop) {
        return {
          stop: true,
          reason: 'regression',
          why: `the project got measurably worse: ${first.toFixed(0)}% → ${last.toFixed(0)}% `
            + `(${delta.toFixed(1)} points) across ${cfg.noProgressReviews} strategic reviews. `
            + 'Consider reverting to the last good commit rather than continuing.',
        };
      }

      if (delta < cfg.progressEpsilon) {
        return {
          stop: true,
          reason: 'no-progress',
          why: `only ${delta.toFixed(1)} points across ${cfg.noProgressReviews} strategic reviews`,
        };
      }
    }
  }

  return { stop: false, reason: null, why: 'continuing' };
}
