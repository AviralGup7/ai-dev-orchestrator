/**
 * The two independent gates that stop opinion ending a run.
 *
 * Kept apart from the integration suite because each needs a hand-built
 * scorecard: the simulator cannot easily produce "four evidenced dimensions,
 * all weak, five confident opinions" — and that is precisely the shape that
 * breaks the second gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStop, DEFAULTS } from '../src/core/stop.js';

const card = (specs) => specs.map(([dimension, score, confidence]) => ({ dimension, score, confidence }));
const memoryWith = (scores, overall) => ({
  status: 'running', iteration: 9,
  scores: [{ scores }],
  history: [{ n: 9, overall }],
});

test('a genuinely evidenced run reaches the target', () => {
  const scores = card([
    ['completion', 95, 'inferred'], ['quality', 93, 'inferred'], ['testing', 98, 'measured'],
    ['architecture', 92, 'inferred'], ['uiux', 88, 'asserted'], ['performance', 94, 'measured'],
    ['security', 93, 'inferred'], ['documentation', 95, 'measured'], ['accessibility', 86, 'asserted'],
  ]);
  const v = shouldStop(memoryWith(scores, 93), { target: 90 });
  assert.equal(v.stop, true);
  assert.equal(v.reason, 'target-reached');
});

test('an ALL-ASSERTED scorecard cannot end a run, however high', () => {
  const scores = card([
    ['completion', 99, 'asserted'], ['quality', 99, 'asserted'], ['testing', 99, 'asserted'],
    ['architecture', 99, 'asserted'], ['uiux', 99, 'asserted'], ['performance', 99, 'asserted'],
    ['security', 99, 'asserted'], ['documentation', 99, 'asserted'], ['accessibility', 99, 'asserted'],
  ]);
  const v = shouldStop(memoryWith(scores, 99), { target: 90 });
  assert.equal(v.stop, false);
  assert.match(v.why, /rest on evidence/);
});

test('OPINION CANNOT CARRY THE RUN over the target', () => {
  /*
   * THE SECOND GATE, and the subtler one. Four dimensions are evidenced —
   * enough to satisfy the count — but they average 41%. Five confident
   * opinions at 100% lift the overall to 74%. Without this check the run
   * would stop at a 70% target on a project that is measurably at 41%.
   */
  const scores = card([
    ['completion', 40, 'measured'], ['quality', 40, 'inferred'], ['testing', 45, 'measured'],
    ['architecture', 40, 'inferred'],
    ['uiux', 100, 'asserted'], ['performance', 100, 'asserted'], ['security', 100, 'asserted'],
    ['documentation', 100, 'asserted'], ['accessibility', 100, 'asserted'],
  ]);
  const v = shouldStop(memoryWith(scores, 74), { target: 70 });
  assert.equal(v.stop, false);
  assert.match(v.why, /only 41% across the dimensions backed by evidence/);
  assert.match(v.why, /opinion and cannot carry the run/);
});

test('the evidence floor is a stated number, not a hidden constant', () => {
  assert.equal(typeof DEFAULTS.minEvidencedDimensions, 'number');
  assert.ok(DEFAULTS.minEvidencedDimensions >= 3, 'too low a floor makes the gate meaningless');
  assert.ok(DEFAULTS.minEvidencedDimensions <= 6,
    'too high a floor makes completion unreachable — architecture, UI/UX and accessibility genuinely cannot be measured from a terminal');
});

test('the gates do not block a run that is legitimately below target', () => {
  const scores = card([
    ['completion', 50, 'inferred'], ['quality', 50, 'inferred'], ['testing', 60, 'measured'],
    ['architecture', 50, 'inferred'], ['uiux', 50, 'asserted'], ['performance', 50, 'asserted'],
    ['security', 50, 'asserted'], ['documentation', 50, 'asserted'], ['accessibility', 50, 'asserted'],
  ]);
  const v = shouldStop(memoryWith(scores, 51), { target: 90 });
  assert.equal(v.stop, false);
  assert.equal(v.why, 'continuing', 'a normal below-target run must not be given a confusing reason');
});

/* ---------------------------------------------------------------------------
 * REGRESSION vs PLATEAU
 *
 * `stop.js` compared `delta < epsilon` unsigned, so a project that collapsed
 * from 82% to 41% and one that had not moved at all produced the SAME reason
 * and nearly the same sentence — distinguished only by a minus sign after the
 * word "only". They demand opposite responses: a plateau means try a different
 * objective, a collapse means revert.
 * ------------------------------------------------------------------------ */

test('A COLLAPSE IS REPORTED AS A REGRESSION, NOT AS A PLATEAU', () => {
  const reviewed = (o) => ({ reviewed: true, overall: o });
  const v = shouldStop(
    { history: [reviewed(82), reviewed(60), reviewed(41)], iteration: 3, lastScores: {} },
    { target: 90 });

  assert.equal(v.stop, true);
  assert.equal(v.reason, 'regression', 'losing 41 points is not "no progress"');
  assert.match(v.why, /got measurably worse/);
  assert.match(v.why, /82% → 41%/, 'the numbers must be in the message');
  assert.match(v.why, /revert/i, 'it must name the action that actually helps');
});

test('a genuine plateau is still a plateau', () => {
  const reviewed = (o) => ({ reviewed: true, overall: o });
  const v = shouldStop(
    { history: [reviewed(70), reviewed(70), reviewed(70)], iteration: 3, lastScores: {} },
    { target: 90 });
  assert.equal(v.reason, 'no-progress', 'a flat run must not be called a regression');
});

test('ordinary scoring noise is NOT called a regression', () => {
  /*
   * The counterweight, and the reason `regressionDrop` is its own threshold.
   * A single dimension moving one bucket shifts the overall by about a point.
   * If that were reported as "the project got measurably worse", the warning
   * would fire on nearly every stalled run and stop being believed.
   */
  const reviewed = (o) => ({ reviewed: true, overall: o });
  const v = shouldStop(
    { history: [reviewed(70), reviewed(69), reviewed(67)], iteration: 3, lastScores: {} },
    { target: 90 });
  assert.equal(v.reason, 'no-progress', 'a 3-point drift is stagnation, not damage');
});

test('the regression check runs BEFORE the no-progress check', () => {
  /*
   * Order is the whole fix. A collapse also satisfies `delta < epsilon`, so
   * whichever test runs first wins — and for the life of the project that was
   * the wrong one.
   */
  const reviewed = (o) => ({ reviewed: true, overall: o });
  const v = shouldStop(
    { history: [reviewed(90), reviewed(50), reviewed(10)], iteration: 3, lastScores: {} },
    { target: 90 });
  assert.notEqual(v.reason, 'no-progress',
    'a collapse satisfies both conditions; the accurate one must win');
  assert.equal(v.reason, 'regression');
});
