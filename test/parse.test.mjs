/**
 * Evidence parsing: where prose must never become a measured fact.
 *
 * The dangerous direction of error is always the optimistic one. A missing
 * number leaves a dimension unmeasured and visible; a wrong number is
 * authoritative and invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTests, parseBuild, parseLint, parseCoverage, parseDiff, parseCommit,
  parseAll, explainEvidence, clean,
} from '../src/core/parse.js';

const ctx = { source: 'arena-terminal', sourceType: 'terminal', iteration: 7, phase: 'execute' };

/* ----------------------------------------------------------------- tests */

test('the common test formats are read correctly', () => {
  const cases = [
    ['Tests:       3 failed, 2 skipped, 1276 passed, 1281 total', 1276, 3, 2],
    ['  1276 passing (41s)\n  3 failing\n  2 pending', 1276, 3, 2],
    ['# tests 250\n# pass 247\n# fail 3\n# skipped 2', 247, 3, 2],
    ['===== 3 failed, 1276 passed, 2 skipped in 41.20s =====', 1276, 3, 2],
    ['1276 passed, 0 failed', 1276, 0, 0],
  ];
  for (const [text, p, f, s] of cases) {
    const e = parseTests(text, ctx);
    assert.ok(e, `no evidence from: ${text.slice(0, 40)}`);
    assert.deepEqual([e.passed, e.failed, e.skipped], [p, f, s], text.slice(0, 40));
  }
});

test('A JEST SUMMARY WITH FAILURES IS NOT READ AS CLEAN', () => {
  /*
   * THE MOST DANGEROUS MISPARSE IN THE FILE.
   *
   * `Tests: 3 failed, 2 skipped, 1276 passed` — a naive /(\d+) passed/ matches
   * 1276 and reports zero failures, turning a failing suite into a perfect
   * testing score. The composite patterns must be tried before the simple
   * ones, and this test pins that ordering.
   */
  const e = parseTests('Tests:       3 failed, 2 skipped, 1276 passed, 1281 total', ctx);
  assert.equal(e.failed, 3, 'the failures must not be lost');
  assert.notEqual(e.failed, 0);
});

test('PROSE NEVER BECOMES MEASURED TEST EVIDENCE', () => {
  /*
   * A model narrating its work writes a number and the word "passing". That is
   * enough to fool a pattern, and the observation is imagined — nothing ran.
   */
  const hedged = [
    'The tests seem to be passing.',
    'I believe all 1276 tests should pass now.',
    'Expected: 1276 passed, 0 failed once you run it.',
    'This would pass 1276 tests.',
    'It looks like 1276 passing.',
  ];
  for (const t of hedged) {
    assert.equal(parseTests(t, ctx), null, `hedged prose accepted: "${t}"`);
  }
});

test('a hedge elsewhere in the output does not discard a real summary', () => {
  /*
   * The check is per-line. A clean summary line should not be thrown away
   * because the model wrote "this should fix it" three paragraphs earlier.
   */
  const text = 'I think this should fix the exporter.\n\nRunning tests...\n1276 passed, 0 failed\n';
  assert.equal(parseTests(text, ctx).passed, 1276);
});

test('no test output produces NULL, never a zero', () => {
  /*
   * A zero would look like a flawless empty suite to scoreTesting. Null means
   * unmeasured, which is the truth.
   */
  assert.equal(parseTests('', ctx), null);
  assert.equal(parseTests('Building...\nDone.', ctx), null);
});

/* ----------------------------------------------------------------- build */

test('build failure beats build success in the same output', () => {
  /*
   * Real output frequently contains both — a successful compile step then a
   * failing bundle. If success won, a partially failing build would be
   * recorded green, and reconcile() caps every dimension at 50 on a failing
   * build precisely because that state matters.
   */
  const e = parseBuild('webpack compiled successfully\nnpm ERR! code ELIFECYCLE\nnpm ERR! exit code 2', ctx);
  assert.equal(e.ok, false);
});

test('build success and duration are read', () => {
  const e = parseBuild('webpack 5.89.0 compiled successfully in 4123 ms', ctx);
  assert.equal(e.ok, true);
  assert.equal(e.durationMs, 4123);
});

test('tsc error counts are read as a failing build', () => {
  assert.equal(parseBuild('Found 3 errors in 2 files.', ctx).ok, false);
  assert.equal(parseBuild('Found 0 errors.', ctx).ok, true);
});

/* ------------------------------------------------------- lint / coverage */

test('eslint and generic lint summaries are read', () => {
  const a = parseLint('✖ 12 problems (3 errors, 9 warnings)', ctx);
  assert.deepEqual([a.errors, a.warnings], [3, 9]);
  const b = parseLint('0 errors, 0 warnings', ctx);
  assert.deepEqual([b.errors, b.warnings], [0, 0]);
});

test('istanbul, labelled and go coverage are read', () => {
  const i = parseCoverage('All files      |   81.42 |    68.1 |    74.2 |    80.9 |', ctx);
  assert.equal(i.statementsPct, 81.42);
  assert.equal(i.linesPct, 80.9);
  const l = parseCoverage('Lines: 81.4%  Branches: 68%', ctx);
  assert.equal(l.linesPct, 81.4);
  const g = parseCoverage('coverage: 81.4% of statements', ctx);
  assert.equal(g.statementsPct, 81.4);
});

/* ------------------------------------------------------------------ diff */

test('git diff --stat is read exactly', () => {
  const e = parseDiff('7 files changed, 210 insertions(+), 12 deletions(-)', ctx);
  assert.deepEqual([e.filesChanged, e.insertions, e.deletions], [7, 210, 12]);
});

test('a unified diff excludes +++/--- headers from the counts', () => {
  /*
   * Including them adds two phantom lines per file — a systematic overcount,
   * not noise, which would stop `trivial-diffs` firing for small changes.
   */
  const d = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,4 @@',
    '+added one',
    '-removed one',
  ].join('\n');
  const e = parseDiff(d, ctx);
  assert.equal(e.filesChanged, 1);
  assert.equal(e.insertions, 1, 'the +++ header must not count');
  assert.equal(e.deletions, 1, 'nor the --- header');
});

/* ------------------------------------------------------------ provenance */

test('every parsed record carries provenance back to the raw text', () => {
  /*
   * §13: a score must be traceable. 82% -> testing 94 -> "1276 passed" ->
   * iteration 7.
   */
  const e = parseTests('1276 passed, 0 failed', ctx);
  assert.equal(e.provenance.iteration, 7);
  assert.equal(e.provenance.phase, 'execute');
  assert.equal(e.provenance.sourceType, 'terminal');
  assert.equal(e.provenance.parser, 'generic-passed-failed');
  assert.match(e.provenance.rawReference, /1276 passed/);

  const explained = explainEvidence(e);
  assert.match(explained, /1276 passed/);
  assert.match(explained, /iteration 7/);
  assert.match(explained, /generic-passed-failed/);
});

/* --------------------------------------------------------------- parseAll */

test('parseAll extracts every kind present in one blob', () => {
  const out = parseAll([
    'Tests: 1276 passed, 0 failed',
    'webpack compiled successfully in 4.1s',
    '✖ 0 problems (0 errors, 0 warnings)',
    'All files      |   81.42 |    68.1 |    74.2 |    80.9 |',
    '7 files changed, 210 insertions(+), 12 deletions(-)',
    '[main a1b2c3d] feat: streaming export',
  ].join('\n'), ctx);

  const kinds = out.evidence.map((e) => e.kind);
  for (const k of ['test', 'build', 'lint', 'coverage', 'diff']) {
    assert.ok(kinds.includes(k), `missing ${k}`);
  }
  assert.equal(out.unparsed, false);
});

test('unstructured output is kept as weak log evidence, not discarded', () => {
  /*
   * It is the raw material a human needs when the scores look wrong. Keeping
   * it is safe because evidence-stasis deliberately excludes log evidence from
   * its fingerprint.
   */
  const out = parseAll('I refactored the module and everything looks fine now.', ctx);
  assert.equal(out.unparsed, true);
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].kind, 'log');
});

test('ANSI colour codes and progress rewrites do not defeat the parsers', () => {
  const coloured = '\u001B[32m1276 passing\u001B[0m\r  \u001B[31m3 failing\u001B[0m';
  const e = parseTests(coloured, ctx);
  assert.equal(e.passed, 1276);
  assert.equal(e.failed, 3);
  assert.equal(clean(coloured).includes('\u001B'), false);
});

test('a commit sha is captured as corroboration, not as a new evidence kind', () => {
  /*
   * EVIDENCE_KINDS is a closed set the scoring module reasons over. A commit
   * proves work was durable; it measures no dimension.
   */
  const e = parseCommit('[main a1b2c3d] feat: streaming export', ctx);
  assert.equal(e.kind, 'log');
  assert.equal(e.sha, 'a1b2c3d');
});
