/**
 * Response schemas: the boundary where model output stops being trusted.
 *
 * The tests that matter here are the ones proving a model CANNOT do something
 * by saying it, no matter how plausibly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlan, validateEvaluation, validateReview, validateScores,
  stripForbidden, describeProblems, FORBIDDEN,
} from '../src/core/schema.js';

/* ------------------------------------------------------- forbidden fields */

test('THE MANAGER CANNOT WRITE CODE, however it phrases it', () => {
  /*
   * The architectural claim in docs/SPEC.md, enforced. A prompt saying "do not
   * write code" is a request; dropping the field is the guarantee.
   */
  const r = validatePlan({
    objective: 'fix the CSV exporter quoting',
    patch: 'diff --git a/src/csv.js ...',
    code: 'function fix() {}',
    command: 'rm -rf /',
  });
  assert.equal(r.ok, true, 'the plan is still usable');
  assert.equal(r.value.text, 'fix the CSV exporter quoting');
  assert.deepEqual(r.dropped.sort(), ['code', 'command', 'patch']);
  assert.match(r.warnings.join(' '), /may plan, not implement/);
});

test('a forbidden field one level deep is also dropped', () => {
  /*
   * `{result: {patch: "..."}}` is the same capability wearing a hat.
   */
  const obj = { objective: 'x', result: { patch: 'sneaky', summary: 'kept' } };
  const dropped = stripForbidden(obj, 'manager');
  assert.deepEqual(dropped, ['result.patch']);
  assert.equal(obj.result.summary, 'kept', 'innocent sibling fields survive');
});

test('THE ENGINEER CANNOT CHOOSE DIRECTION', () => {
  const obj = { summary: 'did it', nextObjective: 'rewrite in Rust', projectComplete: true };
  const dropped = stripForbidden(obj, 'engineer');
  assert.ok(dropped.includes('nextObjective'));
  assert.ok(dropped.includes('projectComplete'));
});

test('THE REVIEWER CANNOT ACT, SCORE, OR DECLARE VICTORY', () => {
  const r = validateReview({
    assessment: 'the exporter is churning',
    strategy: 'move to the sync module',
    patch: 'diff ...',
    scores: [{ dimension: 'testing', score: 99 }],
    projectComplete: true,
  });
  assert.equal(r.value.recommendation, 'change-strategy');
  assert.ok(r.dropped.includes('patch'));
  assert.ok(r.dropped.includes('scores'), 'scoring is the manager\'s job');
  assert.ok(r.dropped.includes('projectComplete'));
});

test('the three role bans do not overlap into nonsense', () => {
  // The engineer MAY report files; the manager may not send them.
  assert.ok(FORBIDDEN.manager.includes('files'));
  assert.equal(FORBIDDEN.engineer.includes('files'), false);
});

/* ---------------------------------------------------------------- scores */

test('a measured score with no basis is DOWNGRADED, not accepted or rejected', () => {
  /*
   * Rejecting would lose a possibly-sensible number over a labelling error.
   * Accepting would let an opinion satisfy a stop condition. Downgrading keeps
   * the number and removes the authority.
   */
  const r = validateScores([{ dimension: 'testing', score: 95, confidence: 'measured' }], { evidence: [] });
  assert.equal(r.value[0].score, 95);
  assert.equal(r.value[0].confidence, 'asserted');
  assert.match(r.warnings.join(' '), /downgraded/);
});

test('a basis naming evidence that was never produced does not count', () => {
  /*
   * "measured, basis: test results" when no tests ran. The classic.
   */
  const r = validateScores(
    [{ dimension: 'testing', score: 95, confidence: 'measured', basis: ['test results'] }],
    { evidence: [{ kind: 'build', ok: true }] },
  );
  assert.equal(r.value[0].confidence, 'asserted');
});

test('a basis matching real evidence is honoured', () => {
  const r = validateScores(
    [{ dimension: 'testing', score: 95, confidence: 'measured', basis: ['test run: 1276 passed'] }],
    { evidence: [{ kind: 'test', passed: 1276 }] },
  );
  assert.equal(r.value[0].confidence, 'measured');
  assert.equal(r.value[0].basis[0].kind, 'test');
});

test('a duplicate dimension is dropped, not merged', () => {
  /*
   * Keeping the last one lets a model "correct" a low score upward later in
   * the same list and have it stick.
   */
  const r = validateScores([
    { dimension: 'testing', score: 40, confidence: 'asserted' },
    { dimension: 'testing', score: 95, confidence: 'asserted' },
  ]);
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0].score, 40, 'the first stands');
  assert.match(r.warnings.join(' '), /duplicate/);
});

test('unknown dimensions and junk entries are ignored with a warning', () => {
  const r = validateScores([
    { dimension: 'vibes', score: 100 },
    'not an object',
    { dimension: 'testing', score: 'NaN' },
  ]);
  assert.deepEqual(r.value, []);
  assert.equal(r.warnings.length, 3);
});

/* ------------------------------------------------------------------ plan */

test('a plan with no objective is fatal; a plan with no expected evidence is not', () => {
  /*
   * Different severities on purpose. No objective means nothing to do. No
   * expected evidence means the result cannot be verified — worth saying,
   * not worth stalling a run over a field models omit constantly.
   */
  assert.equal(validatePlan({ tasks: ['a'] }).ok, false);

  const noEvidence = validatePlan({ objective: 'add CSV export with tests' });
  assert.equal(noEvidence.ok, true);
  assert.match(noEvidence.warnings.join(' '), /cannot be verified/);
});

test('a one-word objective is rejected as unactionable', () => {
  assert.equal(validatePlan({ objective: 'fix' }).ok, false);
});

test('a good plan keeps its constraints and acceptance criteria', () => {
  const r = validatePlan({
    objective: 'add streaming to the CSV exporter',
    tasks: ['add a stream writer', 'add tests'],
    priority: 'high',
    expectedEvidence: ['test results', 'build'],
    constraints: ['no new dependencies'],
    acceptance: ['exports 1M rows without OOM'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.priority, 'high');
  assert.deepEqual(r.value.expectedEvidence, ['test results', 'build']);
  assert.deepEqual(r.value.constraints, ['no new dependencies']);
});

/* ------------------------------------------------------------ evaluation */

test('an evaluation with no usable scores is FATAL', () => {
  /*
   * Unlike a plan missing optional fields: evaluation has exactly one job, and
   * accepting a response that did not do it advances the iteration with an
   * empty scorecard that later reads as "nothing improved".
   */
  assert.equal(validateEvaluation({ reasoning: 'looks good to me' }).ok, false);
  assert.equal(validateEvaluation({ scores: [{ dimension: 'nope', score: 1 }] }).ok, false);
});

test('an evaluation carries issues forward', () => {
  const r = validateEvaluation({
    scores: [{ dimension: 'testing', score: 80, confidence: 'inferred', basis: ['test output'] }],
    issues: ['comma quoting still fails on embedded newlines'],
    resolved: ['the old CSV bug'],
  }, { evidence: [{ kind: 'test', passed: 10 }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.openIssues.length, 1);
  assert.equal(r.value.resolved.length, 1);
});

/* ---------------------------------------------------------------- review */

test('change-strategy with no direction is incoherent and becomes continue', () => {
  /*
   * Honouring it would record a strategy change whose content is empty, and
   * the next plan would be told the strategy changed without being told to
   * what.
   */
  const r = validateReview({ recommendation: 'change-strategy' });
  assert.equal(r.value.recommendation, 'continue');
  assert.match(r.warnings.join(' '), /described no new direction/);
});

test('a direction with no explicit recommendation implies change-strategy', () => {
  const r = validateReview({ strategy: 'stop iterating on the exporter; fix sync' });
  assert.equal(r.value.recommendation, 'change-strategy');
  assert.match(r.value.newDirection, /fix sync/);
});

/* ------------------------------------------------------------- reprompts */

test('problems are described as instructions a model can act on', () => {
  const bad = validatePlan({});
  const msg = describeProblems(bad);
  assert.match(msg, /could not be used/);
  assert.match(msg, /no objective/);
  assert.match(msg, /Do not apologise/);
  assert.equal(describeProblems(validatePlan({ objective: 'a real objective here' })), '');
});

test('non-objects are refused rather than coerced', () => {
  for (const junk of [null, 'a string', 42, []]) {
    assert.equal(validatePlan(junk).ok, false);
    assert.equal(validateEvaluation(junk).ok, false);
    assert.equal(validateReview(junk).ok, false);
  }
});
