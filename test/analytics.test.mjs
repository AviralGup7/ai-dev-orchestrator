/**
 * Analytics, replay and artifacts.
 *
 * The recurring theme: refuse to produce a number that is not backed by data,
 * because a fabricated metric ends a question that an empty one would prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, formatMetric } from '../src/core/analytics.js';
import { replay, apply, initialState, narrate, verifyAgainst } from '../src/core/replay.js';
import { ArtifactRegistry, classify, safeName } from '../src/core/artifacts.js';

const iter = (n, over = {}) => ({
  n, startedAt: n * 1000, finishedAt: n * 1000 + 500,
  evidence: [], scores: [], signals: [], knownIssues: [], ...over,
});
const testEv = (passed, failed = 0, skipped = 0) =>
  ({ kind: 'test', passed, failed, skipped, total: passed + failed + skipped });

/* ============================================================= analytics */

test('metrics with no data are UNKNOWN, never zero', () => {
  /*
   * A fabricated regression rate is worse than an empty one: the empty one
   * prompts a question, the fabricated one ends it.
   */
  const a = analyse([]);
  for (const k of ['improvement', 'trend', 'iterationMs', 'testGrowth', 'coverageGrowth', 'regressionRate']) {
    assert.equal(a[k].basis, 'unknown', `${k} invented a value`);
    assert.equal(a[k].value, null);
    assert.ok(a[k].note, `${k} must say why it is unknown`);
  }
});

test('token efficiency and cost are permanently unknown through a browser tab', () => {
  /*
   * The spec asks for both. Inferring them from character counts would be a
   * guess wearing a unit — exactly what this module refuses to do.
   */
  const a = analyse([iter(1, { overall: 50 })]);
  assert.equal(a.tokenEfficiency.basis, 'unknown');
  assert.match(a.tokenEfficiency.note, /cannot observe token counts/);
  assert.equal(a.cost.basis, 'unknown');
});

test('improvement per iteration is the mean delta, measured', () => {
  const a = analyse([iter(1, { overall: 40 }), iter(2, { overall: 50 }), iter(3, { overall: 56 })]);
  assert.equal(a.improvement.basis, 'measured');
  assert.equal(a.improvement.value, 8);
  assert.equal(a.improvement.n, 2);
});

test('the trend uses least squares, not first-versus-last', () => {
  /*
   * A single anomalous iteration at either end would otherwise define the
   * whole trajectory — and the anomalous one is usually the first, where the
   * baseline scores everything low.
   */
  const spiky = [iter(1, { overall: 10 }), iter(2, { overall: 50 }), iter(3, { overall: 52 }), iter(4, { overall: 54 })];
  const a = analyse(spiky);
  assert.equal(a.trend.basis, 'measured');
  assert.ok(a.trend.value > 0 && a.trend.value < 20, `slope ${a.trend.value} looks like first-vs-last`);
});

test('a regression is only counted between iterations that BOTH ran tests', () => {
  /*
   * Comparing an iteration that ran tests against one that did not would
   * report a regression every time somebody skipped the suite, drowning the
   * real signal.
   */
  const withGap = [
    iter(1, { overall: 50, evidence: [testEv(100, 0)] }),
    iter(2, { overall: 52, evidence: [] }),                    // no tests run
    iter(3, { overall: 54, evidence: [testEv(100, 0)] }),
  ];
  assert.equal(analyse(withGap).regressionRate.value, 0);

  const real = [
    iter(1, { overall: 50, evidence: [testEv(100, 0)] }),
    iter(2, { overall: 52, evidence: [testEv(98, 4)] }),        // genuine regression
  ];
  assert.equal(analyse(real).regressionRate.value, 100);
  assert.equal(analyse(real).regressionRate.n, 1);
});

test('bug discovery is ESTIMATED, because it is a report of a report', () => {
  const a = analyse([
    iter(1, { overall: 40, knownIssues: ['a'] }),
    iter(2, { overall: 45, knownIssues: ['a', 'b'] }),
  ]);
  assert.equal(a.bugDiscoveryRate.basis, 'estimated');
  assert.match(a.bugDiscoveryRate.note, /report of a report/);
});

test('the evidenced share reports how much of the score is opinion', () => {
  const a = analyse([iter(1, {
    overall: 80,
    scores: [
      { dimension: 'testing', score: 90, confidence: 'measured' },
      { dimension: 'uiux', score: 70, confidence: 'asserted' },
      { dimension: 'security', score: 80, confidence: 'asserted' },
      { dimension: 'quality', score: 80, confidence: 'inferred' },
    ],
  })]);
  assert.equal(a.evidencedShare.value, 50);
  assert.equal(a.evidencedShare.basis, 'measured');
});

test('formatMetric renders an unknown as a dash with a reason', () => {
  const f = formatMetric(analyse([]).cost);
  assert.equal(f.text, '—');
  assert.equal(f.basis, 'unknown');
  assert.ok(f.title.length > 0);
});

/* ================================================================ replay */

const ev = (type, extra = {}, i = 0) =>
  ({ id: `evt-s1-${String(i).padStart(6, '0')}`, at: 1000 + i, type, ...extra });

test('a run is reconstructed from its events alone', () => {
  const events = [
    ev('run-started', {}, 1),
    ev('iteration-started', { n: 1 }, 2),
    ev('planned', { objective: 'add CSV export', iteration: 1 }, 3),
    ev('evidence-captured', { kinds: ['test', 'build'], iteration: 1 }, 4),
    ev('evaluated', { overall: 55, confidence: 'inferred', iteration: 1 }, 5),
    ev('iteration-finished', { n: 1 }, 6),
    ev('iteration-started', { n: 2 }, 7),
    ev('evaluated', { overall: 62, iteration: 2 }, 8),
    ev('iteration-finished', { n: 2 }, 9),
    ev('run-stopped', { reason: 'target-reached', why: 'overall 62%' }, 10),
  ];
  const { final } = replay(events);

  assert.equal(final.status, 'stopped');
  assert.equal(final.stopReason, 'target-reached');
  assert.equal(final.completed, 2);
  assert.equal(final.overall, 62);
  assert.equal(final.iterations[0].objective, 'add CSV export');
  assert.deepEqual(final.iterations[0].evidence.map((e) => e.kind), ['test', 'build']);
});

test('score CHANGES are recorded as facts, not left to be derived', () => {
  /*
   * "78 → 82" is the most-asked question of a log. Computing it at read time
   * means every consumer reimplements it.
   */
  const events = [
    ev('evaluated', { overall: 78, iteration: 1 }, 1),
    ev('evaluated', { overall: 82, iteration: 2 }, 2),
  ];
  const { final } = replay(events);
  assert.equal(final.scoreChanges.length, 1);
  assert.deepEqual(
    [final.scoreChanges[0].from, final.scoreChanges[0].to],
    [78, 82],
  );
});

test('replay is deterministic and contacts nothing', () => {
  const events = [ev('run-started', {}, 1), ev('evaluated', { overall: 40 }, 2)];
  const a = replay(events).final;
  const b = replay(events).final;
  assert.deepEqual(a, b);
});

test('every frame is inspectable — you can step through the run', () => {
  const events = [
    ev('run-started', {}, 1),
    ev('iteration-started', { n: 1 }, 2),
    ev('evaluated', { overall: 30, iteration: 1 }, 3),
  ];
  const { frames } = replay(events);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].state.overall, null, 'state before the evaluation');
  assert.equal(frames[2].state.overall, 30, 'state after it');
});

test('events from several sessions of one run order correctly', () => {
  /*
   * Ids restart at 1 each session, so ids alone would interleave a long run
   * wrongly. This exact class of bug (timestamps not being a total order) was
   * already found once in the error center, in the other direction.
   */
  const s1 = { id: 'evt-s1-000009', at: 100, type: 'iteration-finished', n: 1 };
  const s2 = { id: 'evt-s2-000001', at: 200, type: 'iteration-finished', n: 2 };
  const { final } = replay([s2, s1]);
  assert.equal(final.completed, 2);
  assert.equal(final.iteration, 2, 'the later session must come last');
});

test('replay catches a record that changed without being logged', () => {
  /*
   * A disagreement means something modified the record with no event, which is
   * a hole in the audit trail and invisible by any other means.
   */
  const events = [ev('iteration-finished', { n: 1 }, 1)];
  const honest = verifyAgainst({ iterations: [{ n: 1, finishedAt: 1 }], run: {} }, events);
  assert.equal(honest.ok, true);

  const tampered = verifyAgainst({
    iterations: [{ n: 1, finishedAt: 1 }, { n: 2, finishedAt: 2 }], run: {},
  }, events);
  assert.equal(tampered.ok, false);
  assert.match(tampered.problems[0], /log shows 1 completed.*storage has 2/);
});

test('narrate produces a readable decision trail', () => {
  const events = [
    ev('iteration-started', { n: 1 }, 1),
    ev('planned', { objective: 'add tests', iteration: 1 }, 2),
    ev('evaluated', { overall: 40, iteration: 1 }, 3),
    ev('evaluated', { overall: 55, iteration: 2 }, 4),
    ev('stagnation-detected', { signals: [{ kind: 'file-churn' }], iteration: 2 }, 5),
    ev('strategy-changed', { direction: 'move to the sync module', iteration: 2 }, 6),
  ];
  const lines = narrate(events).map((l) => l.text);
  assert.ok(lines.some((l) => /Objective: add tests/.test(l)));
  assert.ok(lines.some((l) => /40% → 55%/.test(l)));
  assert.ok(lines.some((l) => /Loop detected: file-churn/.test(l)));
  assert.ok(lines.some((l) => /Strategy changed/.test(l)));
});

/* ============================================================= artifacts */

test('A DOWNLOAD IS NOT COMPLETE BECAUSE THE BROWSER ACCEPTED IT', () => {
  /*
   * `chrome.downloads.download()` resolves when the request is ACCEPTED. A
   * network drop, a full disk or a cancel all happen afterwards. Recording
   * "downloaded" on that promise records an intention as a fact.
   */
  const r = new ArtifactRegistry();
  const a = r.register({ filename: 'report.md', url: 'blob:x', runId: 'run-1', iteration: 3 });
  assert.equal(a.state, 'requested', 'registration alone claims nothing');
});

test('an accepted download that never lands is interrupted, not complete', async () => {
  const r = new ArtifactRegistry({
    downloader: {
      download: async () => 42,
      probe: async () => ({ state: 'interrupted', error: 'NETWORK_FAILED' }),
    },
  });
  const a = r.register({ filename: 'report.md', url: 'blob:x', runId: 'r', iteration: 1 });
  await r.fetch(a);
  assert.equal(a.state, 'interrupted');
  assert.equal(a.error, 'NETWORK_FAILED');
  assert.equal(r.summary().complete, 0);
});

test('a zero-byte "complete" download is not complete', async () => {
  /*
   * That is the shape a cancelled or blocked download takes. Accepting it puts
   * an empty file in the record as though it were a report.
   */
  const r = new ArtifactRegistry({
    downloader: { download: async () => 1, probe: async () => ({ state: 'complete', bytes: 0 }) },
  });
  const a = r.register({ filename: 'report.md', url: 'blob:x', runId: 'r', iteration: 1 });
  await r.fetch(a);
  assert.equal(a.state, 'interrupted');
  assert.match(a.error, /zero bytes/);
});

test('a verified download is complete and counted', async () => {
  const r = new ArtifactRegistry({
    downloader: { download: async () => 7, probe: async () => ({ state: 'complete', bytes: 4096 }) },
  });
  const a = r.register({ filename: 'coverage.json', url: 'blob:x', runId: 'r', iteration: 2 });
  await r.fetch(a);
  assert.equal(a.state, 'complete');
  assert.equal(a.bytes, 4096);
  assert.equal(r.summary().complete, 1);
  assert.deepEqual(r.summary().unverified, []);
});

test('duplicates are suppressed per ITERATION, not globally', () => {
  /*
   * A run producing report.md every iteration produces forty different
   * reports. Global dedup would keep the first and discard thirty-nine.
   */
  const r = new ArtifactRegistry();
  const a1 = r.register({ filename: 'report.md', runId: 'r', iteration: 1 });
  const a2 = r.register({ filename: 'report.md', runId: 'r', iteration: 1 });
  assert.equal(a1.id, a2.id, 'the same file in one iteration is one artifact');

  const a3 = r.register({ filename: 'report.md', runId: 'r', iteration: 2 });
  assert.notEqual(a1.id, a3.id, 'the same name in a later iteration is a new artifact');
  assert.equal(r.items.length, 2);
});

test('filenames are namespaced so iterations cannot overwrite each other', () => {
  /*
   * Browsers resolve collisions by appending "(1)", which silently decouples
   * the file on disk from the name in the record.
   */
  const a = safeName('report.md', { runId: 'run-20260808-abc', iteration: 3 });
  const b = safeName('report.md', { runId: 'run-20260808-abc', iteration: 4 });
  assert.notEqual(a, b);
  assert.match(a, /i003-report\.md$/);
  assert.equal(safeName('../../etc/passwd', { runId: 'r', iteration: 1 }).includes('..'), false);
});

test('artifacts are classified and tied to project, run, iteration and phase', () => {
  assert.equal(classify('report.md'), 'report');
  assert.equal(classify('junit.xml'), 'test-report');
  assert.equal(classify('bundle.zip'), 'archive');
  assert.equal(classify('shot.png'), 'screenshot');

  const r = new ArtifactRegistry();
  const a = r.register({ filename: 'x.md', projectId: 'p', runId: 'r', iteration: 5, phase: 'evaluate' });
  assert.deepEqual(
    [a.projectId, a.runId, a.iteration, a.phase],
    ['p', 'r', 5, 'evaluate'],
  );
  assert.equal(r.forIteration(5).length, 1);
});

test('the summary names what did NOT arrive rather than implying it did', () => {
  const r = new ArtifactRegistry();
  r.register({ filename: 'a.md', runId: 'r', iteration: 1 });
  r.register({ filename: 'b.md', runId: 'r', iteration: 1 });
  const s = r.summary();
  assert.equal(s.total, 2);
  assert.equal(s.complete, 0);
  assert.deepEqual(s.unverified, ['a.md', 'b.md']);
});

test('retrying interrupted downloads is bounded', async () => {
  let calls = 0;
  const r = new ArtifactRegistry({
    downloader: {
      download: async () => { calls++; return 1; },
      probe: async () => ({ state: 'interrupted', error: 'flaky' }),
    },
  });
  const a = r.register({ filename: 'x.md', url: 'blob:x', runId: 'r', iteration: 1 });
  await r.fetch(a);
  await r.retryInterrupted({ maxAttempts: 3 });
  await r.retryInterrupted({ maxAttempts: 3 });
  await r.retryInterrupted({ maxAttempts: 3 });
  assert.equal(calls, 3, 'an unavailable file must stop being retried');
});
