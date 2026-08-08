/**
 * Scoring tests.
 *
 * The thing under test is not arithmetic -- it is RESISTANCE TO FLATTERY. Most
 * of these describe a model trying to report good news it cannot support, and
 * assert that the system declines to believe it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { scoreTesting, reconcile, merge, overall, unmeasured } =
  await import('../src/core/scoring.js');
const { makeScore, makeEvidence } = await import('../src/core/types.js');

/* ------------------------------------------------------- computed scores -- */

test('a project with no tests scores 0 for testing, not 100', () => {
  /*
   * The single most likely way this function could flatter a project: a naive
   * `passed / (passed + failed)` gives an empty repo a perfect score, because
   * 0/0 has no failures in it.
   */
  const s = scoreTesting([makeEvidence('test', { passed: 0, failed: 0, skipped: 0 })]);
  assert.equal(s.score, 0);
  assert.equal(s.confidence, 'measured');
});

test('no test evidence at all yields no score rather than a guess', () => {
  assert.equal(scoreTesting([]), null);
  assert.equal(scoreTesting([makeEvidence('build', { ok: true })]), null);
});

test('a fully passing suite scores 100', () => {
  assert.equal(scoreTesting([makeEvidence('test', { passed: 50, failed: 0, skipped: 0 })]).score, 100);
});

test('failures pull the score down proportionally', () => {
  const s = scoreTesting([makeEvidence('test', { passed: 75, failed: 25, skipped: 0 })]);
  assert.equal(s.score, 75);
});

test('SKIPPED TESTS COUNT AGAINST THE SCORE', () => {
  /*
   * A skipped test is one someone wrote and turned off. Treating it as a pass
   * would let a suite be quietly disabled without the number moving, which is
   * how a green dashboard hides a rotting suite.
   */
  const s = scoreTesting([makeEvidence('test', { passed: 50, failed: 0, skipped: 50 })]);
  assert.equal(s.score, 50, 'half the suite is switched off');
});

test('coverage modulates the pass rate rather than averaging with it', () => {
  const ev = [
    makeEvidence('test', { passed: 100, failed: 0, skipped: 0 }),
    makeEvidence('coverage', { linesPct: 50 }),
  ];
  const s = scoreTesting(ev);
  // 100 * (0.7 + 0.3*0.5) = 85. Averaging would give 75, which undersells a
  // fully passing suite; ignoring coverage would give 100, which oversells it.
  assert.equal(s.score, 85);
});

test('a failing suite is not rescued by perfect coverage', () => {
  const ev = [
    makeEvidence('test', { passed: 0, failed: 100, skipped: 0 }),
    makeEvidence('coverage', { linesPct: 100 }),
  ];
  assert.equal(scoreTesting(ev).score, 0);
});

/* ---------------------------------------------------------- reconciling -- */

test('a score claiming to be measured with no basis is downgraded', () => {
  const proposed = [{ dimension: 'quality', score: 90, confidence: 'measured', basis: [] }];
  const [out] = reconcile(proposed, []);
  assert.equal(out.confidence, 'asserted');
  assert.match(out.downgraded, /no evidence/);
});

test('A FAILING BUILD CAPS EVERY DIMENSION', () => {
  /*
   * Not just build-related ones. If the project does not compile, no claim
   * about its architecture or completeness means anything, and letting
   * `completion: 95` stand next to a red build is how a dashboard becomes
   * decorative.
   */
  const proposed = [
    makeScore('completion', 95, 'inferred'),
    makeScore('architecture', 88, 'inferred'),
  ];
  const out = reconcile(proposed, [makeEvidence('build', { ok: false })]);
  assert.ok(out.every((s) => s.score <= 50), JSON.stringify(out));
  assert.ok(out.every((s) => /build is failing/.test(s.downgraded)));
});

test('a passing build leaves scores alone', () => {
  const proposed = [makeScore('completion', 95, 'inferred')];
  const [out] = reconcile(proposed, [makeEvidence('build', { ok: true })]);
  assert.equal(out.score, 95);
  assert.equal(out.downgraded, undefined);
});

test('a computable dimension claimed as measured without test evidence is demoted', () => {
  const proposed = [{ dimension: 'testing', score: 99, confidence: 'measured', basis: [{ kind: 'log' }] }];
  const [out] = reconcile(proposed, [makeEvidence('log', { text: 'looks fine' })]);
  assert.equal(out.confidence, 'inferred');
});

/* -------------------------------------------------------------- merging -- */

test('COMPUTED SCORES BEAT PROPOSED ONES', () => {
  // The manager's opinion about test health is not consulted when the test
  // output is right there.
  const proposed = [{ dimension: 'testing', score: 95, confidence: 'asserted', basis: [] }];
  const computed = [scoreTesting([makeEvidence('test', { passed: 1, failed: 1, skipped: 0 })])];
  const [out] = merge(proposed, computed);
  assert.equal(out.score, 50, 'the measured value wins');
  assert.equal(out.confidence, 'measured');
});

/* -------------------------------------------------------------- overall -- */

test('a dimension that was never scored counts as zero', () => {
  /*
   * Averaging only what was reported would let a manager score one dimension,
   * ignore eight, and collect a perfect overall.
   */
  const o = overall([makeScore('completion', 90, 'inferred')]);
  assert.equal(o.score, 10, '90 across nine dimensions');
  assert.equal(o.missing.length, 8);
});

test('overall confidence is the WEAKEST part, not the average', () => {
  const scores = [
    ...['completion', 'quality', 'testing', 'architecture', 'uiux',
      'performance', 'security', 'documentation'].map((d) => makeScore(d, 90, 'measured', [{ kind: 'test' }])),
    makeScore('accessibility', 90, 'asserted'),
  ];
  const o = overall(scores);
  assert.equal(o.score, 90);
  assert.equal(o.confidence, 'asserted', 'one invented dimension taints the picture');
});

test('a complete measured scorecard reports measured', () => {
  const scores = ['completion', 'quality', 'testing', 'architecture', 'uiux',
    'performance', 'security', 'documentation', 'accessibility']
    .map((d) => makeScore(d, 80, 'measured', [{ kind: 'test' }]));
  const o = overall(scores);
  assert.equal(o.confidence, 'measured');
  assert.equal(o.missing.length, 0);
});

test('an empty scorecard is zero and asserted, never optimistic', () => {
  const o = overall([]);
  assert.equal(o.score, 0);
  assert.equal(o.confidence, 'asserted');
});

test('unmeasured lists exactly the dimensions resting on nothing', () => {
  const scores = [
    makeScore('completion', 50, 'asserted'),
    makeScore('testing', 90, 'measured', [{ kind: 'test' }]),
    makeScore('uiux', 70, 'inferred'),
  ];
  assert.deepEqual(unmeasured(scores), ['completion']);
});

/* ------------------------------------------------------------ guardrails -- */

test('makeScore refuses a measured claim with no evidence', () => {
  assert.throws(() => makeScore('testing', 90, 'measured', []), /no evidence/);
});

test('makeScore rejects unknown dimensions and confidences', () => {
  assert.throws(() => makeScore('vibes', 90, 'inferred'), /unknown dimension/);
  assert.throws(() => makeScore('testing', 90, 'certain'), /unknown confidence/);
});

test('scores are clamped to 0-100', () => {
  assert.equal(makeScore('quality', 150, 'inferred').score, 100);
  assert.equal(makeScore('quality', -20, 'inferred').score, 0);
  assert.equal(makeScore('quality', NaN, 'inferred').score, 0);
});

test('makeEvidence rejects an unknown kind', () => {
  assert.throws(() => makeEvidence('vibes', {}), /unknown evidence kind/);
});
