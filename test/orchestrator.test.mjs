/**
 * The loop, end to end.
 *
 * This is the walking skeleton's proof: a real state machine, real
 * persistence, real scoring and real stop conditions, driven against fake
 * adapters. If this passes, swapping in a browser transport is a detail --
 * which is the whole architectural claim of the project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { Orchestrator } = await import('../src/core/orchestrator.js');
const { MemoryStore } = await import('../src/core/store.js');
const { makeEvidence } = await import('../src/core/types.js');
const { fakeManager, fakeEngineer, fakeReviewer, flatScores, passing } =
  await import('./helpers/fakes.mjs');

/**
 * A run wired for one purpose, with sensible defaults.
 *
 * `baselineDone` defaults to TRUE here, and that is a deliberate choice about
 * what this file tests. Iteration 1 of every workflow mode is a fixed baseline
 * that does not consult the manager -- covered in test/firstrun.test.mjs.
 * These tests are about the steady-state loop, so they start past it.
 * Defaulting the other way would make every test in this file secretly
 * exercise the baseline and then disagree with its own name.
 */
function build({ objectives, evaluations, results, responses, config, baselineDone = true } = {}) {
  const store = new MemoryStore();
  const events = [];
  const o = new Orchestrator({
    manager: fakeManager({ objectives, evaluations }),
    engineer: fakeEngineer({ results }),
    reviewer: fakeReviewer({ responses }),
    store,
    config: { maxIterations: 10, target: 90, ...config },
    onEvent: (e) => events.push(e),
  });
  const load = o.load.bind(o);
  o.load = async (...args) => {
    const m = await load(...args);
    m.baselineDone = baselineDone;
    return m;
  };
  return { o, store, events };
}

/* ------------------------------------------------------------ one loop -- */

test('a single iteration runs every phase in order', async () => {
  const { o, events } = build({
    objectives: [{ text: 'build the thing' }],
    results: [{ evidence: [passing(10)], filesChanged: ['a.js'], linesChanged: 100, summary: 'built it' }],
    evaluations: [{ scores: flatScores(50) }],
  });
  await o.load('a project');
  await o.iterate();

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['iteration-started', 'planned', 'executed', 'evaluated', 'iteration-finished']);
  assert.equal(o.memory.iteration, 1);
  assert.equal(o.memory.history.length, 1);
});

test('EVERY PHASE PERSISTS BEFORE THE NEXT BEGINS', async () => {
  /*
   * An iteration is minutes of real AI time. A browser restart mid-run must
   * resume from the last completed phase -- not redo the iteration, and above
   * all not half-redo it.
   */
  const { o, store } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [passing(1)], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(10) }],
  });
  await o.load('p');
  const before = store.writes;
  await o.iterate();
  assert.ok(store.writes - before >= 5, `only ${store.writes - before} writes across five phases`);
});

test('a run resumes from the persisted state after a restart', async () => {
  const store = new MemoryStore();
  const mk = () => new Orchestrator({
    manager: fakeManager({ objectives: [{ text: 'x' }], evaluations: [{ scores: flatScores(20) }] }),
    engineer: fakeEngineer({ results: [{ evidence: [passing(5)], filesChanged: [], summary: '' }] }),
    reviewer: fakeReviewer(),
    store,
    config: { maxIterations: 10 },
  });

  const first = mk();
  await first.load('a project');
  await first.iterate();

  // A different instance, as after an extension reload.
  const second = mk();
  const restored = await second.load();
  assert.equal(restored.iteration, 1, 'progress survived');
  assert.equal(restored.scope, 'a project', 'and so did the scope');
});

/* ------------------------------------------------------- score integrity -- */

test('COMPUTED TEST SCORES OVERRIDE WHAT THE MANAGER CLAIMS', async () => {
  // The manager insists testing is perfect; the suite is half red.
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [makeEvidence('test', { passed: 5, failed: 5, skipped: 0 })], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(100, 'asserted') }],
  });
  await o.load('p');
  await o.iterate();

  const scores = o.memory.scores[0].scores;
  const testing = scores.find((s) => s.dimension === 'testing');
  assert.equal(testing.score, 50, 'the measurement wins');
  assert.equal(testing.confidence, 'measured');
});

test('a failing build caps the whole scorecard', async () => {
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [makeEvidence('build', { ok: false })], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(95, 'inferred') }],
  });
  await o.load('p');
  await o.iterate();
  assert.ok(o.memory.scores[0].scores.every((s) => s.score <= 50));
});

/* ----------------------------------------------------------- stopping --- */

test('THE RUN DOES NOT STOP ON UNEVIDENCED SCORES', async () => {
  /*
   * The clause that prevents declaring victory on vibes. Every dimension is
   * asserted at 100 -- the target is met on paper and the run must continue,
   * because stopping here is precisely where the user gets hurt: they believe
   * it and ship.
   */
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(100, 'asserted') }],
    config: { target: 90, maxIterations: 3 },
  });
  await o.load('p');
  const verdict = await o.run();
  assert.equal(verdict.reason, 'budget-exhausted', 'ran out of budget rather than claiming success');
  assert.notEqual(verdict.reason, 'target-reached');
});

test('the run stops when the target is met WITH evidence', async () => {
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [passing(100)], filesChanged: ['a.js'], linesChanged: 50, summary: '' }],
    evaluations: [{ scores: flatScores(95, 'measured', [{ kind: 'test' }]) }],
    config: { target: 90, maxIterations: 10 },
  });
  await o.load('p');
  const verdict = await o.run();
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, 'target-reached');
});

test('the iteration budget is a hard ceiling', async () => {
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [passing(1)], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(10) }],
    config: { maxIterations: 4 },
  });
  await o.load('p');
  const verdict = await o.run();
  assert.equal(verdict.reason, 'budget-exhausted');
  assert.equal(o.memory.iteration, 4);
});

/* ------------------------------------------------------------- review --- */

test('the reviewer runs every Nth iteration, not every one', async () => {
  const store = new MemoryStore();
  const reviewer = fakeReviewer();
  const o = new Orchestrator({
    manager: fakeManager({
      /*
       * GENUINELY different objectives, not "task 1 / task 2".
       *
       * My first fixture was `distinct task abab 1`, `distinct task ababab 2`
       * -- which share "distinct task" and score 0.667 similarity, tripping
       * the detector and pulling the review forward. The test failed and the
       * DETECTOR WAS RIGHT: those objectives really are near-identical. The
       * fixture was the lazy part.
       */
      objectives: [
        { text: 'implement the CSV export pipeline' },
        { text: 'wire up keyboard navigation in the sidebar' },
        { text: 'harden the authentication token refresh' },
        { text: 'add pagination to the results table' },
        { text: 'write documentation for the plugin API' },
        { text: 'reduce bundle size by code splitting' },
        { text: 'migrate storage to IndexedDB' },
        { text: 'add telemetry for slow queries' },
      ],
      evaluations: [{ scores: flatScores(30) }],
    }),
    engineer: fakeEngineer({
      results: Array.from({ length: 8 }, (_, i) => ({
        evidence: [passing(10 + i * 5)],
        filesChanged: [`file${i}.js`],
        linesChanged: 100 + i * 10,
        summary: '',
      })),
    }),
    reviewer,
    store,
    config: { maxIterations: 6, reviewEvery: 3, target: 200 },
  });
  await o.load('p');
  o.memory.baselineDone = true; // review cadence is a steady-state behaviour
  await o.run();
  assert.equal(reviewer.calls(), 2, 'iterations 3 and 6');
});

test('STAGNATION PULLS THE REVIEW FORWARD', async () => {
  /*
   * Waiting for iteration 10 while the detector has been shouting since 3 is
   * seven wasted iterations, and the review is exactly the tool for the
   * condition the detector found.
   */
  const reviewer = fakeReviewer();
  const store = new MemoryStore();
  const o = new Orchestrator({
    manager: fakeManager({
      objectives: [{ text: 'refactor the sync module' }],   // identical every time
      evaluations: [{ scores: flatScores(40) }],
    }),
    engineer: fakeEngineer({
      results: [{ evidence: [passing(10)], filesChanged: ['a.js'], linesChanged: 3, summary: '' }],
    }),
    reviewer,
    store,
    config: { maxIterations: 4, reviewEvery: 99, target: 200 },
  });
  await o.load('p');
  await o.run();
  assert.ok(reviewer.calls() > 0, 'the review must not wait for iteration 99');
  assert.equal(o.memory.flags.stagnation, true);
});

test('a strategy change is recorded as a decision, not applied silently', async () => {
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [passing(1)], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(20) }],
    responses: [{ recommendation: 'change-strategy', newDirection: 'focus on tests', rationale: 'coverage is thin' }],
    config: { maxIterations: 1, reviewEvery: 1, target: 200 },
  });
  await o.load('p');
  await o.run();
  const d = o.memory.decisions.find((x) => x.kind === 'strategy');
  assert.ok(d, 'the change must be on the record');
  assert.equal(d.text, 'focus on tests');
  assert.equal(d.rationale, 'coverage is thin');
});

/* ------------------------------------------------------------ failure --- */

test('a manager returning no objective fails loudly rather than looping', async () => {
  const { o } = build({ objectives: [{ text: '' }] });
  await o.load('p');
  await assert.rejects(() => o.iterate(), /no objective/);
  assert.equal(o.memory.status, 'failed');
  assert.equal(o.memory.history.length, 1, 'the failed attempt is on the record');
});

test('a failed iteration preserves state for inspection', async () => {
  const store = new MemoryStore();
  const o = new Orchestrator({
    manager: fakeManager({ objectives: [{ text: 'x' }] }),
    engineer: { async execute() { throw new Error('arena tab closed'); } },
    reviewer: fakeReviewer(),
    store,
  });
  await o.load('p');
  o.memory.baselineDone = true; // steady state: the baseline is covered elsewhere
  await assert.rejects(() => o.iterate(), /arena tab closed/);

  const saved = await store.load();
  assert.equal(saved.status, 'failed');
  assert.match(saved.history[0].error, /arena tab closed/);
  assert.equal(saved.history[0].objective.text, 'x', 'the objective it died on is recoverable');
});

/* ------------------------------------------------------------ control --- */

test('pause halts at a phase boundary and resume continues', async () => {
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [passing(1)], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(10) }],
    config: { maxIterations: 5 },
  });
  await o.load('p');
  o.pause();
  const verdict = await o.run();
  assert.equal(verdict.why, 'paused');
  assert.equal(o.memory.iteration, 0, 'nothing ran');
  assert.equal(o.memory.status, 'paused');

  o.resume();
  await o.run();
  assert.equal(o.memory.iteration, 5);
});

test('a user stop is honoured and recorded', async () => {
  const { o } = build({
    objectives: [{ text: 'x' }],
    results: [{ evidence: [passing(1)], filesChanged: [], summary: '' }],
    evaluations: [{ scores: flatScores(10) }],
  });
  await o.load('p');
  await o.stop();
  const verdict = await o.run();
  assert.equal(verdict.reason, 'user-stopped');
  assert.equal(o.memory.iteration, 0);
});

/* ------------------------------------------------------------ context --- */

test('CONTEXT IS COMPACTED SO OLD ITERATIONS CANNOT OVERFLOW THE WINDOW', async () => {
  /*
   * Forty iterations of full transcripts exceed any context window, and the
   * failure is silent: the model loses the earliest part of the conversation,
   * which is where the project scope lives. The run then drifts from what the
   * user asked for and nothing reports it.
   */
  const { o } = build({
    objectives: [
      'implement the CSV export pipeline', 'wire up keyboard navigation',
      'harden authentication token refresh', 'add pagination to results',
      'write documentation for the plugin API', 'reduce bundle size',
      'migrate storage to IndexedDB', 'add telemetry for slow queries',
      'introduce a caching layer', 'support offline reads',
      'add a settings screen', 'improve first paint',
    ].map((text) => ({ text })),
    results: Array.from({ length: 12 }, (_, i) => ({
      evidence: [passing(10 + i * 3)], filesChanged: [`f${i}.js`], linesChanged: 90 + i, summary: '',
    })),
    evaluations: [{ scores: flatScores(30) }],
    config: { maxIterations: 8, target: 200, reviewEvery: 99 },
  });
  await o.load('p');
  await o.run();

  const ctx = o.recentHistory();
  assert.equal(ctx.recent.length, 3, 'only the last three in full');
  assert.equal(ctx.summary.length, 5, 'the rest are one line each');
  assert.equal(ctx.totalIterations, 8);
  for (const s of ctx.summary) {
    assert.deepEqual(Object.keys(s).sort(), ['n', 'objective', 'overall'], 'summaries stay small');
  }
});

test('the manager receives the context it needs to plan', async () => {
  let seen = null;
  const store = new MemoryStore();
  const o = new Orchestrator({
    manager: {
      async plan(ctx) { seen = ctx; return { text: 'go' }; },
      async evaluate() { return { scores: flatScores(10) }; },
    },
    engineer: fakeEngineer({ results: [{ evidence: [passing(1)], filesChanged: [], summary: '' }] }),
    reviewer: fakeReviewer(),
    store,
  });
  await o.load('the scope');
  o.memory.baselineDone = true; // plan() is only consulted after the baseline
  await o.iterate();

  for (const key of ['scope', 'iteration', 'history', 'openIssues', 'failedAttempts', 'lastScores', 'flags']) {
    assert.ok(key in seen, `plan() must receive ${key}`);
  }
  assert.equal(seen.scope, 'the scope');
});
