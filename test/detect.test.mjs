/**
 * Loop-detection tests.
 *
 * Two failure modes matter equally here:
 *
 *   MISSING stagnation  the run circles for forty iterations
 *   CRYING stagnation   the detector fires constantly, gets ignored, and
 *                       burns a strategic review each time
 *
 * The second is the reason for the two-signal threshold, and roughly half of
 * these tests exist to prove the detector stays quiet when it should.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { detect, similarity, STAGNATION_THRESHOLD } = await import('../src/core/detect.js');
const { emptyMemory } = await import('../src/core/types.js');

const mem = (over = {}) => ({ ...emptyMemory('a project'), ...over });
const iter = (n, over = {}) => ({ n, objective: { text: `objective ${n}` }, ...over });

/* ----------------------------------------------------------- similarity -- */

test('reworded objectives are recognised as the same work', () => {
  /*
   * This test set the threshold rather than confirming it. 0.85 was my guess;
   * this pair scores 0.667, so the detector would have missed the precise case
   * it exists to catch. The corpus below is what 0.6 was derived from.
   */
  const SAME = [
    ['add tests for the parser', 'write parser tests'],
    ['refactor the sync module', 'refactor sync module'],
    ['improve error handling in sync', 'better error handling for sync'],
  ];
  for (const [a, b] of SAME) {
    assert.ok(similarity(a, b) >= 0.6, `${a} / ${b} = ${similarity(a, b)}`);
  }
});

test('the similarity threshold sits in a real gap, not on top of the data', () => {
  // If these ever overlap, the threshold is arbitrary again and the detector
  // will either miss loops or cry wolf.
  const same = [
    similarity('add tests for the parser', 'write parser tests'),
    similarity('refactor the sync module', 'refactor sync module'),
  ];
  const different = [
    similarity('add tests for the parser', 'add tests for the lexer'),
    similarity('fix the sync bug', 'fix the render bug'),
    similarity('build the export pipeline', 'wire up the sidebar'),
  ];
  assert.ok(Math.min(...same) > Math.max(...different),
    `no gap: same=${JSON.stringify(same)} different=${JSON.stringify(different)}`);
});

test('GENUINE SEQUENCE IS NOT MISTAKEN FOR REPETITION', () => {
  // "parser" then "lexer" is progress, not a loop. This is the calibration
  // case for the 0.85 threshold.
  const s = similarity('add tests for the parser', 'add tests for the lexer');
  assert.ok(s < 0.85, `too similar: ${s}`);
});

test('stopwords do not inflate similarity', () => {
  // Both are almost entirely filler; without stripping, these would look alike.
  const s = similarity('improve the error handling', 'add more documentation');
  assert.ok(s < 0.3, String(s));
});

test('similarity is safe on empty and nullish input', () => {
  assert.equal(similarity('', 'x'), 0);
  assert.equal(similarity(null, undefined), 0);
});

/* -------------------------------------------------------------- signals -- */

test('a repeated objective raises a signal', () => {
  const m = mem({
    objective: { text: 'refactor the sync module' },
    history: [iter(1, { objective: { text: 'refactor sync module' } })],
  });
  const r = detect(m);
  assert.ok(r.signals.some((s) => s.id === 'objective-repeat'));
});

test('editing the same files three times running raises a signal', () => {
  const m = mem({
    history: [
      iter(1, { filesChanged: ['a.js', 'b.js'] }),
      iter(2, { filesChanged: ['b.js', 'a.js'] }),
      iter(3, { filesChanged: ['a.js', 'b.js'] }),
    ],
  });
  assert.ok(detect(m).signals.some((s) => s.id === 'file-churn'));
});

test('identical evidence three times running raises a signal', () => {
  const ev = [{ kind: 'test', passed: 10, failed: 0, skipped: 0 }];
  const m = mem({ history: [iter(1, { evidence: ev }), iter(2, { evidence: ev }), iter(3, { evidence: ev })] });
  assert.ok(detect(m).signals.some((s) => s.id === 'evidence-stasis'));
});

test('a resolved issue reappearing raises a signal', () => {
  const m = mem({
    resolvedIssues: ['sync drops the last page'],
    openIssues: ['Sync drops the last page'],
  });
  assert.ok(detect(m).signals.some((s) => s.id === 'bug-recurrence'));
});

test('two trivial diffs in a row raise a signal', () => {
  const m = mem({ history: [iter(1, { linesChanged: 4 }), iter(2, { linesChanged: 7 })] });
  assert.ok(detect(m).signals.some((s) => s.id === 'trivial-diffs'));
});

/* ---------------------------------------------- the plateau judgement --- */

test('A PLATEAU ALONE DOES NOT COUNT AS STAGNATION', () => {
  /*
   * The most important judgement in the module. A project approaching
   * completion plateaus -- that is what finishing looks like. Treating it as
   * stagnation would trigger a strategy change at exactly the moment the
   * strategy is working.
   */
  const m = mem({
    history: [
      iter(1, { overall: 88, filesChanged: ['a.js'], linesChanged: 200 }),
      iter(2, { overall: 89, filesChanged: ['b.js'], linesChanged: 180 }),
      iter(3, { overall: 89, filesChanged: ['c.js'], linesChanged: 210 }),
    ],
  });
  const r = detect(m);
  assert.ok(r.signals.some((s) => s.id === 'score-plateau'), 'the signal fires');
  assert.equal(r.stagnating, false, 'but one signal is not stagnation');
});

test('a plateau WITH corroboration is stagnation', () => {
  const ev = [{ kind: 'test', passed: 10, failed: 0, skipped: 0 }];
  const m = mem({
    history: [
      iter(1, { overall: 60, evidence: ev, filesChanged: ['a.js'] }),
      iter(2, { overall: 60, evidence: ev, filesChanged: ['a.js'] }),
      iter(3, { overall: 61, evidence: ev, filesChanged: ['a.js'] }),
    ],
  });
  const r = detect(m);
  assert.equal(r.stagnating, true);
  assert.ok(r.signals.length >= STAGNATION_THRESHOLD);
});

/* ------------------------------------------------ staying quiet --------- */

test('healthy progress raises nothing at all', () => {
  const m = mem({
    objective: { text: 'add the export pipeline' },
    history: [
      iter(1, { objective: { text: 'build the parser' }, overall: 30, filesChanged: ['p.js'], linesChanged: 300, evidence: [{ kind: 'test', passed: 10, failed: 0, skipped: 0 }] }),
      iter(2, { objective: { text: 'wire the sidebar' }, overall: 48, filesChanged: ['s.js'], linesChanged: 250, evidence: [{ kind: 'test', passed: 24, failed: 0, skipped: 0 }] }),
      iter(3, { objective: { text: 'harden the auth flow' }, overall: 66, filesChanged: ['a.js'], linesChanged: 190, evidence: [{ kind: 'test', passed: 41, failed: 0, skipped: 0 }] }),
    ],
  });
  const r = detect(m);
  assert.deepEqual(r.signals, [], JSON.stringify(r.signals));
  assert.equal(r.stagnating, false);
});

test('a fresh run with no history is not stagnating', () => {
  assert.equal(detect(mem()).stagnating, false);
});

test('LOG EVIDENCE IS EXCLUDED FROM THE FINGERPRINT', () => {
  /*
   * A log's text differs every run even when nothing changed. Including it
   * would guarantee the fingerprints never match, silently disabling the
   * evidence-stasis signal -- a detector that can never fire is worse than no
   * detector, because it looks like coverage.
   */
  const m = mem({
    history: [1, 2, 3].map((n) => iter(n, {
      evidence: [
        { kind: 'test', passed: 10, failed: 0, skipped: 0 },
        { kind: 'log', text: `run at ${n * 1000}` },
      ],
    })),
  });
  assert.ok(detect(m).signals.some((s) => s.id === 'evidence-stasis'),
    'differing log text must not mask identical test numbers');
});

test('every signal explains itself in English', () => {
  const ev = [{ kind: 'test', passed: 1, failed: 0, skipped: 0 }];
  const m = mem({
    objective: { text: 'refactor sync' },
    resolvedIssues: ['a bug'],
    openIssues: ['A bug'],
    history: [1, 2, 3].map((n) => iter(n, {
      objective: { text: 'refactor sync' },
      overall: 50, evidence: ev, filesChanged: ['a.js'], linesChanged: 2,
    })),
  });
  const r = detect(m);
  assert.ok(r.signals.length >= 4);
  for (const s of r.signals) {
    assert.match(s.why, /\S/, `${s.id} must say why`);
    assert.ok(s.why.length > 15, `${s.id}: "${s.why}" is too terse to act on`);
  }
});
