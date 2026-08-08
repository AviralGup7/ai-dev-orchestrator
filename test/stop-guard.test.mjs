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
