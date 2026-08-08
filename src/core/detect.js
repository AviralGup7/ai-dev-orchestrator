/**
 * Noticing that the project is going in circles.
 *
 * WHY THIS IS HARD, AND WHY IT IS THE INTERESTING PART
 * ---------------------------------------------------
 * An autonomous loop with no stagnation detection does not stop. It keeps
 * producing plausible objectives -- "improve error handling", "add more
 * tests", "refactor the utility module" -- each of which reads as sensible in
 * isolation. The user comes back in an hour to forty iterations, a rising
 * score chart and a project that is materially unchanged.
 *
 * The failure is not that the AI is stupid. It is that "what should I do next"
 * always has an answer, and nothing in the loop ever asks "is any of this
 * getting anywhere".
 *
 * SIX SIGNALS, DELIBERATELY INDEPENDENT
 *
 * Any single one has a legitimate explanation. Two together rarely do. The
 * combination rule is what makes this useful rather than noisy -- a detector
 * that fires constantly gets ignored, which is worse than no detector because
 * it costs strategic reviews as well as attention.
 */

/** Two signals is the threshold. See the note on `plateau` for why. */
export const STAGNATION_THRESHOLD = 2;

/**
 * How similar two objectives must be to count as "the same work".
 *
 * MEASURED, NOT GUESSED. I first wrote 0.85 from intuition and a test caught
 * it immediately: "add tests for the parser" vs "write parser tests" scores
 * 0.667, so the threshold would have missed the exact case it was written for.
 *
 * Running the calibration corpus gives a clean gap:
 *
 *   SAME      0.667  add tests for the parser  /  write parser tests
 *             1.000  refactor the sync module  /  refactor sync module
 *             1.000  improve error handling in sync / better error handling for sync
 *
 *   DIFFERENT 0.333  add tests for the parser  /  add tests for the lexer
 *             0.333  fix the sync bug          /  fix the render bug
 *             0.000  build the export pipeline /  wire up the sidebar
 *
 * Everything meaning the same thing lands at or above 0.667; everything
 * genuinely different lands at or below 0.333. 0.6 sits in the empty middle
 * with room on both sides -- the two 0.333 pairs are the ones that matter,
 * because "parser then lexer" is progress and must not read as a loop.
 */
export const SIMILARITY_THRESHOLD = 0.6;

/**
 * Normalised token overlap -- the Jaccard index.
 *
 * WHY NOT AN EMBEDDING
 *
 * An embedding would be more accurate and would cost a network round trip per
 * comparison, inside a loop that already makes three AI calls per iteration.
 * Objectives are short, mechanical, and usually reuse each other's nouns, so
 * token overlap catches the case that actually occurs -- the model restating
 * its own last objective.
 *
 * Stopwords are stripped because "add", "the", "improve" and "for" appear in
 * nearly every objective and would inflate every comparison toward similar.
 */
const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with',
  'add', 'improve', 'update', 'make', 'fix', 'ensure', 'better', 'more',
  'implement', 'create', 'build', 'refactor', 'some', 'that', 'this', 'it',
]);

export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/**
 * Run every signal over the run's history.
 *
 * @param {object} memory
 * @returns {{stagnating: boolean, signals: Array<{id: string, why: string}>}}
 */
export function detect(memory, { historyOffset = 0 } = {}) {
  const h = memory.history || [];
  const signals = [];

  /* -- 1. The same objective, reworded ---------------------------------- */
  const current = memory.objective?.text;
  if (current) {
    /*
     * `historyOffset` excludes the in-flight iteration from the comparison.
     *
     * The orchestrator appends the current record before calling this, because
     * file-churn and diff-size need it. But comparing the current objective
     * against a history containing the current objective scores 1.0 every
     * time, so this signal would fire permanently. The caller says how many
     * trailing entries to ignore.
     */
    const prior = historyOffset > 0 ? h.slice(0, -historyOffset) : h;
    const recent = prior.slice(-5).map((r) => r.objective?.text).filter(Boolean);
    const match = recent.find((prev) => similarity(current, prev) >= SIMILARITY_THRESHOLD);
    if (match) {
      signals.push({
        id: 'objective-repeat',
        why: `this objective closely matches a recent one: "${truncate(match)}"`,
      });
    }
  }

  /* -- 2. The same files, over and over --------------------------------- */
  const fileSets = h.slice(-3).map((r) => new Set(r.filesChanged || []));
  if (fileSets.length === 3 && fileSets.every((s) => s.size > 0)) {
    const [a, b, c] = fileSets;
    if (sameSet(a, b) && sameSet(b, c)) {
      signals.push({
        id: 'file-churn',
        why: `the same ${a.size} file(s) have been edited three iterations running`,
      });
    }
  }

  /* -- 3. The score has stopped moving ---------------------------------- */
  const recentScores = h.slice(-3).map((r) => r.overall).filter(Number.isFinite);
  if (recentScores.length === 3) {
    const delta = Math.abs(recentScores[2] - recentScores[0]);
    if (delta < 2) {
      /*
       * PLATEAU ALONE IS DELIBERATELY NOT ENOUGH, and this is the most
       * important judgement in the file.
       *
       * A project genuinely approaching completion plateaus -- that is what
       * finishing LOOKS like. Treating it as stagnation would trigger a
       * strategy change at exactly the moment the strategy is working, and
       * send a nearly-done project off to rewrite its architecture.
       *
       * So plateau contributes a signal but the threshold is two. It has to be
       * corroborated by something that indicates the work is not landing.
       */
      signals.push({
        id: 'score-plateau',
        why: `overall has moved ${delta.toFixed(1)} points across three iterations`,
      });
    }
  }

  /* -- 4. The evidence is identical -------------------------------------- */
  const fingerprints = h.slice(-3).map(evidenceFingerprint).filter(Boolean);
  if (fingerprints.length === 3 && new Set(fingerprints).size === 1) {
    signals.push({
      id: 'evidence-stasis',
      why: 'test and build numbers are unchanged across three iterations',
    });
  }

  /* -- 5. A resolved issue came back ------------------------------------- */
  const resolved = new Set((memory.resolvedIssues || []).map(norm));
  const reopened = (memory.openIssues || []).filter((i) => resolved.has(norm(i)));
  if (reopened.length > 0) {
    signals.push({
      id: 'bug-recurrence',
      why: `${reopened.length} issue(s) previously marked resolved are open again`,
    });
  }

  /* -- 6. Nothing is actually changing ----------------------------------- */
  const diffs = h.slice(-2).map((r) => r.linesChanged).filter(Number.isFinite);
  if (diffs.length === 2 && diffs.every((d) => d < 10)) {
    signals.push({
      id: 'trivial-diffs',
      why: 'the last two iterations changed fewer than ten lines each',
    });
  }

  return {
    stagnating: signals.length >= STAGNATION_THRESHOLD,
    signals,
  };
}

/**
 * A comparable summary of an iteration's hard numbers.
 *
 * Only the countable kinds. A `log` entry's text differs every run even when
 * nothing has changed, so including it would guarantee the fingerprints never
 * match and quietly disable this signal.
 */
function evidenceFingerprint(record) {
  const ev = record.evidence || [];
  const parts = [];
  for (const e of ev) {
    if (e.kind === 'test') parts.push(`t:${e.passed}/${e.failed}/${e.skipped}`);
    if (e.kind === 'build') parts.push(`b:${e.ok}`);
    if (e.kind === 'lint') parts.push(`l:${e.errors}/${e.warnings}`);
  }
  return parts.length ? parts.sort().join('|') : null;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const truncate = (s) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
