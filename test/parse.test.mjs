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
import { extractBlock, parseReport } from '../src/core/report.js';

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

/* ---------------------------------------------------------------------------
 * THE RENDERED-PAGE FENCE (run 202608081932)
 *
 * The engineer worked for 378 seconds and returned 60,433 characters. All of
 * it was discarded as `response-malformed` — "the engineer either ignored the
 * protocol or the response was truncated" — when it had done neither.
 *
 * Cause: both extraction branches required literal ``` characters, but the
 * transport reads `element.innerText`, and a RENDERED code block has no
 * backticks in its text. The parser was written for markdown source and fed
 * rendered output for the whole life of the project.
 * ------------------------------------------------------------------------ */

const FULL = {
  taskStatus: 'complete', summary: 's', filesModified: [],
  build: { ran: true, ok: true, command: 'npm run build', output: 'ok' },
  tests: { ran: true, passed: 431, failed: 0, skipped: 0, command: 'node --test' },
  commit: { made: true, sha: 'abc1234', message: 'm' },
  knownIssues: [], risks: [], engineeringReport: 'r',
};

test('A REPORT READ FROM A RENDERED PAGE IS FOUND WITHOUT ANY BACKTICKS', () => {
  // Exactly what innerText yields for a rendered ```ORCHESTRATOR-REPORT block.
  const rendered = `Here is what I did.\n\nORCHESTRATOR-REPORT\n${JSON.stringify(FULL, null, 2)}\n`;

  const block = extractBlock(rendered);
  assert.ok(block, 'a rendered report must be findable — 60,433 characters were lost to this');

  const p = parseReport(rendered);
  assert.equal(p.ok, true, `expected a clean parse, got: ${p.problems.join('; ')}`);
  assert.equal(p.report.tests.passed, 431);
  assert.equal(p.report.commit.sha, 'abc1234');
});

test('the rendered fallback survives the copy-button chrome sites inject', () => {
  /*
   * ChatGPT and Arena render a language label and a "Copy" affordance inside
   * the code block; both come back as plain text between the fence name and
   * the JSON.
   */
  const withChrome = `ORCHESTRATOR-REPORT\njson\nCopy\nEdit\n${JSON.stringify(FULL)}`;
  assert.equal(parseReport(withChrome).ok, true, 'page chrome must not defeat extraction');
});

test('BRACES INSIDE PROSE DO NOT TRUNCATE THE REPORT', () => {
  /*
   * `engineeringReport` is free prose and routinely contains braces and
   * escaped quotes. A regex-based grab ends the object at the first `}` and
   * silently produces a SHORT report — worse than failing, because it parses.
   */
  const tricky = { ...FULL, engineeringReport: 'I fixed the } brace and the "quote" and {nested} too' };
  const rendered = `ORCHESTRATOR-REPORT\n${JSON.stringify(tricky)}\ntrailing prose after the block`;

  const p = parseReport(rendered);
  assert.equal(p.ok, true, 'brace-matching must be string-aware');
  assert.equal(p.report.engineeringReport, tricky.engineeringReport,
    'the prose must survive intact, braces and all');
  assert.equal(p.report.build.ok, true, 'nested objects must not end the match early');
});

test('the fenced form still wins when both are present', () => {
  /*
   * The backtick branch is more precise: it is bounded on both sides. The new
   * fallback must not override it, or a correction the model fenced properly
   * could lose to an earlier mention.
   */
  const both = '```ORCHESTRATOR-REPORT\n' + JSON.stringify({ ...FULL, summary: 'FENCED' })
    + '\n```\n\nORCHESTRATOR-REPORT\n' + JSON.stringify({ ...FULL, summary: 'BARE' });
  assert.equal(parseReport(both).report.summary, 'FENCED');
});

test('prose that merely MENTIONS the fence is not mistaken for a report', () => {
  /*
   * The counterweight. The fallback keys on a name that also appears in the
   * instructions we send, so an engineer discussing the protocol must not
   * produce a phantom report.
   */
  const chat = 'I could not find the ORCHESTRATOR-REPORT format documented anywhere, so I am asking.';
  assert.equal(extractBlock(chat), null, 'a mention with no JSON object is not a report');
  assert.equal(parseReport(chat).ok, false);
});

test('a TRUNCATED report is still reported as truncated, not silently half-parsed', () => {
  /*
   * The genuine truncation case the old message claimed. An object that never
   * closes must not yield a partial report — a wrong report that parses is far
   * more dangerous than one that fails.
   */
  const cut = 'ORCHESTRATOR-REPORT\n{ "taskStatus": "complete", "summary": "it was going so we';
  assert.equal(extractBlock(cut), null, 'an unclosed object must not be returned');
});

/* ---------------------------------------------------------------------------
 * PROSE IS NOT A TEST RESULT (evaluation of 2026-08-09)
 *
 * The mocha pattern was a bare /(\d+)\s+passing/i, which matches English. It
 * fired on this sentence from a prose exploration report:
 *
 *   "Journal and its render() method exist and carry 7 passing tests,
 *    but grep finds no production import."
 *
 * and reported "7 passed, 0 failed — read by mocha from terminal". A reviewer
 * then scored `testing` as MEASURED on the strength of it.
 *
 * That is the exact failure this project exists to prevent: asserted scores
 * are excluded from the completion criteria so uncertainty stays visible, and
 * fabricating a `measured` defeats the whole mechanism. This project does not
 * even use mocha — package.json runs `node --test`.
 * ------------------------------------------------------------------------ */

test('A SENTENCE MENTIONING "PASSING" IS NOT SCRAPED AS A TEST RESULT', () => {
  const prose = 'src/core/journal.js:75 — Journal and its render() method exist and '
    + 'carry 7 passing tests, but grep finds no production import.';
  assert.equal(parseTests(prose, ctx), null,
    'this exact sentence produced a false `measured` testing score');
});

test('other prose shapes are rejected too', () => {
  for (const s of [
    'we now have 12 passing specs in the suite',
    'The suite went from 3 passing to 40 passing overall.',
    'it should end up passing 5 arguments to the callback',
  ]) {
    assert.equal(parseTests(s, ctx), null, `false positive on: ${s}`);
  }
});

test('REAL mocha output is still parsed — the guard must not break the true case', () => {
  /*
   * The counterweight. Tightening a parser until it rejects everything is not
   * a fix; the legitimate case has to keep working.
   */
  const real = '\n  Array\n    ✓ returns -1 when not present\n\n  1276 passing (41s)\n  3 failing\n  2 pending\n';
  const t = parseTests(real, ctx);
  assert.ok(t, 'genuine mocha output must still parse');
  assert.equal(t.passed, 1276);
  assert.equal(t.failed, 3);
  assert.equal(t.skipped, 2);
  assert.equal(t.provenance.parser, 'mocha');
});

test('a mocha count indented by its reporter still parses', () => {
  assert.equal(parseTests('        41 passing (2s)', ctx)?.passed, 41);
});

/* ---------------------------------------------------------------------------
 * PER-LINE BACKTICKS (run 202608091336)
 *
 * ChatGPT sometimes renders a JSON block as inline code LINE BY LINE, so every
 * line arrives wrapped in its own pair of backticks. The run failed twice with
 * "Expected property name or '}' in JSON at position 2" — position 2 being the
 * closing backtick where a property name should be — and then ended.
 * ------------------------------------------------------------------------ */

const REPORT = {
  taskStatus: 'complete', summary: 's', filesModified: [],
  build: { ran: true, ok: true, command: 'npm run build', output: 'ok' },
  tests: { ran: true, passed: 471, failed: 0, skipped: 0, command: 'node --test' },
  commit: { made: true, sha: 'abc1234', message: 'm' },
  knownIssues: [], risks: [], engineeringReport: 'r',
};

test('A REPORT WRAPPED IN PER-LINE BACKTICKS PARSES', () => {
  const lines = JSON.stringify(REPORT, null, 2).split('\n').map((l) => '`' + l + '`').join('\n');
  const p = parseReport('Here you go.\n\nORCHESTRATOR-REPORT\n' + lines);
  assert.equal(p.ok, true, `two round trips and a whole run were lost to this: ${p.problems?.join('; ')}`);
  assert.equal(p.report.tests.passed, 471);
});

test('a backtick INSIDE a string value survives', () => {
  /*
   * The unwrap must be conservative. `engineeringReport` is free prose and
   * routinely quotes shell commands; eating those backticks would corrupt the
   * report while appearing to succeed, which is worse than failing.
   */
  const withCode = { ...REPORT, engineeringReport: 'I ran `npm test` and then `git push`' };
  const lines = JSON.stringify(withCode, null, 2).split('\n').map((l) => '`' + l + '`').join('\n');
  const p = parseReport('ORCHESTRATOR-REPORT\n' + lines);
  assert.equal(p.ok, true);
  assert.equal(p.report.engineeringReport, 'I ran `npm test` and then `git push`',
    'inner backticks must be preserved exactly');
});

test('A MARKDOWN FENCE IS NOT MISTAKEN FOR INLINE CODE', () => {
  /*
   * ``` is itself a line that starts and ends with a backtick. A naive unwrap
   * shortens the closing fence to a single ` and destroys the block it was
   * meant to protect. Four existing tests caught this during development.
   */
  const fenced = '```ORCHESTRATOR-REPORT\n' + JSON.stringify(REPORT) + '\n```';
  const p = parseReport(fenced);
  assert.equal(p.ok, true, 'the ordinary fenced form must keep working');
  assert.equal(p.report.commit.sha, 'abc1234');
});

test('an empty inline-code line is left alone', () => {
  /* `` is two backticks with nothing between: not a wrapped line. */
  const p = parseReport('ORCHESTRATOR-REPORT\n``\n' + JSON.stringify(REPORT));
  assert.equal(p.ok, true);
});
