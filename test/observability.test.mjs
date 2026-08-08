/**
 * The five questions, and the controls that can undermine them.
 *
 *   What is it doing right now?  What happened before?  Why?
 *   What will happen next?       Can I stop or change it?
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveStatus, workflowState, currentAI, whatNext, errorCenter } from '../src/core/status.js';
import { availableControls, iterationIsTrustworthy, recordSkip, describeSkips } from '../src/core/controls.js';
import { shouldStop } from '../src/core/stop.js';
import { Logger } from '../src/core/logger.js';
import { bridgeToLogger } from '../src/core/bridge.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { MemoryStore } from '../src/core/store.js';
import { MemoryLogSink } from '../src/core/logsink.js';
import { fakeManager, fakeEngineer, fakeReviewer, flatScores, passing } from './helpers/fakes.mjs';

const running = (over = {}) => ({
  status: 'running', phase: 'execute', iteration: 11,
  objective: { text: 'harden the retry budget' },
  history: [{ n: 11, overall: 82, confidence: 'inferred' }],
  scores: [{ scores: flatScores(82) }],
  flags: { stagnation: false, signals: [] },
  ...over,
});

/* ------------------------------------------------- what is it doing now?  */

test('the live status answers all five questions at once', () => {
  const s = liveStatus(running(), { config: { maxIterations: 50, reviewEvery: 5 }, startedAt: Date.now() - 522000 });
  assert.equal(s.step, 'Arena Coding');       // what
  assert.equal(s.why, 'harden the retry budget'); // why
  assert.equal(s.ai, 'arena');
  assert.equal(s.iterationLabel, '12 / 50');
  assert.equal(s.elapsed, '08:42');
  assert.equal(s.health, 82);
  assert.ok(s.next.length > 0);               // what next
});

test('a pending event outranks the phase — "no unexplained waiting"', () => {
  /*
   * memory.phase says 'execute' for the whole several minutes Arena is
   * thinking. The panel must say "Waiting for Arena response", with a clock.
   */
  const s = liveStatus(running(), {
    lastEvent: {
      status: 'pending', label: 'Waiting for AI response', source: 'arena',
      description: 'running the test suite', at: Date.now() - 90000,
    },
    startedAt: Date.now() - 500000,
  });
  assert.equal(s.step, 'Waiting for AI response');
  assert.equal(s.why, 'running the test suite');
  assert.equal(s.stepElapsed, '01:30', 'the user can see how long the wait has run');
});

test('health is never reported without how much of it was measured', () => {
  const s = liveStatus(running({
    scores: [{ scores: [
      { dimension: 'testing', score: 95, confidence: 'measured' },
      { dimension: 'uiux', score: 70, confidence: 'asserted' },
      { dimension: 'security', score: 80, confidence: 'asserted' },
    ] }],
  }), {});
  assert.equal(s.measuredDimensions, 1);
  assert.equal(s.totalDimensions, 3);
});

test('a blocked run says so, and says why, instead of showing a stale step', () => {
  const s = liveStatus({
    status: 'blocked', phase: 'execute', iteration: 3, history: [], scores: [],
    block: { detail: 'ChatGPT: conversation-changed — bound to "a", now on "b"' },
  }, {});
  assert.match(s.step, /Blocked/);
  assert.match(s.why, /conversation-changed/);
  assert.match(s.next, /Resume/);
  assert.ok(s.blocked);
});

test('currentAI is null when nobody has the floor', () => {
  assert.equal(currentAI({ status: 'paused', phase: 'execute' }), null);
  assert.equal(currentAI(running({ phase: 'detect' })), null, 'detect is local analysis');
  assert.equal(currentAI(running({ phase: 'review' })), 'deepseek');
});

/* -------------------------------------------------- what happens next?    */

test('whatNext is honest about the review schedule rather than guessing', () => {
  const at9 = whatNext(running({ phase: 'evaluate', iteration: 9 }), { reviewEvery: 5 });
  assert.match(at9, /DeepSeek will review/, 'iteration 10 is due for review');

  const at6 = whatNext(running({ phase: 'evaluate', iteration: 6 }), { reviewEvery: 5 });
  assert.match(at6, /iteration 10/, 'and it says when the next review is');

  const stuck = whatNext(running({ phase: 'evaluate', iteration: 6, flags: { stagnation: true } }), { reviewEvery: 5 });
  assert.match(stuck, /pulled forward/, 'a detected loop changes the answer');
});

test('whatNext refuses to promise work after a run has ended', () => {
  assert.match(whatNext({ status: 'stopped' }), /ended/);
  assert.match(whatNext({ status: 'blocked' }), /restore the environment/);
});

/* ---------------------------------------------------------- the workflow  */

test('the workflow diagram marks exactly one stage active', () => {
  const w = workflowState(running({ phase: 'evaluate' }));
  const active = w.filter((s) => s.state === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].key, 'evaluate');
  assert.equal(w[0].state, 'done', 'earlier stages are done');
  assert.equal(w.at(-1).state, 'pending');
});

test('nothing is active before the first run', () => {
  const w = workflowState({ status: 'idle', iteration: 0 });
  assert.equal(w.filter((s) => s.state === 'active').length, 0);
});

/* ----------------------------------------------------------- can I stop?  */

test('controls are disabled with a reason, never hidden', () => {
  /*
   * A UI that hides unavailable buttons makes the layout jump and leaves the
   * user hunting for Stop at the moment they most want it.
   */
  const c = availableControls(running());
  assert.equal(c.pause.enabled, true);
  assert.equal(c.start.enabled, false);
  assert.match(c.start.reason, /while running/);
  assert.equal(c.export.enabled, true, 'export always works');
  assert.ok('label' in c.stop);
});

test('a blocked run offers Resume, relabelled to say what it means', () => {
  const c = availableControls({ status: 'blocked' });
  assert.equal(c.resume.enabled, true);
  assert.match(c.resume.label, /fixed the environment/);
  assert.equal(c.stop.enabled, true, 'the user can always abandon a blocked run');
});

/* ------------------------------------------ skip cannot fake completion   */

test('skipping an evidence phase poisons the iteration permanently', () => {
  const r = recordSkip({ n: 7 }, 'execute');
  assert.deepEqual(r.skipped, ['execute']);
  assert.equal(iterationIsTrustworthy(r), false);
  assert.match(describeSkips(r), /iteration 7 skipped execute/);
});

test('skipping a REVIEW does not poison anything — reviews produce no evidence', () => {
  const r = recordSkip({ n: 7 }, 'review');
  assert.equal(iterationIsTrustworthy(r), true);
  assert.equal(describeSkips(r), null);
});

test('you may skip, but you may NOT skip your way to "done"', () => {
  /*
   * THE LOAD-BEARING TEST FOR THE SKIP BUTTON.
   *
   * Target reached, everything measured — and the deciding iteration skipped
   * the phase that produced the work. The run must continue.
   */
  const scores = flatScores(95);
  const memory = {
    status: 'running', iteration: 12,
    scores: [{ scores }],
    history: [{ n: 12, overall: 95, reviewed: false, skipped: ['execute'] }],
  };
  const verdict = shouldStop(memory, { target: 90 });
  assert.equal(verdict.stop, false);
  assert.match(verdict.why, /skipped execute/);

  // Same scores, honest iteration -> the run may end.
  memory.history = [{ n: 12, overall: 95, reviewed: false }];
  assert.equal(shouldStop(memory, { target: 90 }).stop, true);
});

test('a skip in an OLD iteration does not block a later honest one', () => {
  /*
   * Failing the whole run for a skip twenty iterations ago would make Skip
   * useless — and users route around useless controls by editing state.
   */
  const memory = {
    status: 'running', iteration: 20,
    scores: [{ scores: flatScores(95) }],
    history: [
      { n: 3, overall: 40, skipped: ['execute'] },
      { n: 20, overall: 95 },
    ],
  };
  assert.equal(shouldStop(memory, { target: 90 }).stop, true);
});

test('the orchestrator honours Skip and records it on the iteration', async () => {
  const engineer = fakeEngineer({ results: [{ evidence: [passing(10)], filesChanged: ['a.js'], summary: 'did work' }] });
  const orch = new Orchestrator({
    manager: fakeManager({
      objectives: [{ text: 'implement the CSV export pipeline' }, { text: 'wire up keyboard navigation' }],
      evaluations: [{ scores: flatScores(50) }],
    }),
    engineer,
    reviewer: fakeReviewer(),
    store: new MemoryStore(),
    config: { maxIterations: 1 },
  });
  await orch.load();
  orch.skipStep();          // skip the very next phase: plan
  await orch.run();

  const rec = orch.memory.history[0];
  assert.deepEqual(rec.skipped, ['plan']);
  assert.equal(engineer.calls(), 1, 'later phases still ran');
});

/* -------------------------------------------------------- error center    */

test('the error center gives a summary, component, suggestion and details', () => {
  const log = new Logger();
  log.log('build-failed', {
    source: 'arena', status: 'error', iteration: 4, phase: 'execute',
    description: 'tsc exited with code 2', data: { stderr: 'TS2304' },
  });
  const [e] = errorCenter(log.live);

  assert.equal(e.summary, 'tsc exited with code 2');
  assert.equal(e.component, 'arena');
  assert.ok(e.suggestion.length > 10, 'a real suggestion, not "try again"');
  assert.equal(e.details.stderr, 'TS2304');
  assert.equal(e.retryable, true);
  assert.equal(e.resolved, false);
  assert.ok(e.id && e.at);
});

test('an error resolved by a later success stops shouting', () => {
  /*
   * Otherwise a six-hour run accumulates every transient hiccup into a wall of
   * red the user learns to ignore — which is how a real failure gets missed.
   */
  const log = new Logger();
  log.log('build-failed', { source: 'arena', status: 'error', phase: 'execute', description: 'flaky' });
  log.log('task-complete', { source: 'arena', status: 'success', phase: 'execute' });
  const [e] = errorCenter(log.live);
  assert.equal(e.resolved, true);
  assert.ok(e.resolvedAt);
});

test('environment drift carries its own remedy rather than a generic one', () => {
  const log = new Logger();
  log.log('environment-drift', {
    status: 'error', description: 'ChatGPT tab switched conversation',
    data: { remedy: 'switch that tab back to the bound conversation, then resume' },
  });
  assert.match(errorCenter(log.live)[0].suggestion, /switch that tab back/);
});

/* ------------------------------------------------------------- the bridge */

test('a real run produces a complete, ordered Activity Log', async () => {
  const sink = new MemoryLogSink();
  const logger = new Logger({ sink, flushEvery: 5 });
  const orch = new Orchestrator({
    manager: fakeManager({
      objectives: [
        { text: 'implement the CSV export pipeline' },
        { text: 'wire up keyboard navigation in the sidebar' },
      ],
      evaluations: [{ scores: flatScores(55) }],
    }),
    engineer: fakeEngineer({ results: [{ evidence: [passing(20)], filesChanged: ['a.js'], summary: 'ok' }] }),
    reviewer: fakeReviewer(),
    store: new MemoryStore(),
    onEvent: bridgeToLogger(logger),
    config: { maxIterations: 2, reviewEvery: 2 },
  });
  await orch.run();

  const types = logger.live.map((e) => e.type);
  assert.ok(types.includes('workflow-started'));
  assert.ok(types.includes('planning-complete'));
  assert.ok(types.includes('task-complete'));
  assert.ok(types.includes('evaluation-complete'));
  assert.ok(types.includes('review-complete'));
  assert.ok(types.includes('workflow-completed'));

  // every entry is fully formed
  for (const e of logger.live) {
    assert.ok(e.id, 'every entry has a unique id');
    assert.ok(e.label, 'and a human label');
    assert.ok(['user', 'extension', 'chatgpt', 'arena', 'deepseek', 'system'].includes(e.source));
  }
  const ids = logger.live.map((e) => e.id);
  assert.deepEqual([...ids].sort(), ids, 'the log is totally ordered');
});

test('an engine event with no mapping is logged as a gap, never dropped', async () => {
  /*
   * "The log must never silently discard events." A future engine event with
   * no bridge entry would otherwise vanish during the refactor that added it.
   */
  const logger = new Logger();
  const bridge = bridgeToLogger(logger);
  bridge({ type: 'some-future-event', at: Date.now(), detail: 'x' });

  assert.equal(logger.live.length, 1);
  assert.equal(logger.live[0].status, 'warning');
  assert.match(logger.live[0].description, /Unmapped engine event "some-future-event"/);
  assert.equal(logger.live[0].data.detail, 'x', 'the original payload is preserved');
});

test('a skip is logged as a warning that explains its consequence', async () => {
  const logger = new Logger();
  const orch = new Orchestrator({
    manager: fakeManager({ objectives: [{ text: 'implement the CSV export pipeline' }], evaluations: [{ scores: flatScores(50) }] }),
    engineer: fakeEngineer({ results: [{ evidence: [passing(5)], filesChanged: [], summary: '' }] }),
    reviewer: fakeReviewer(),
    store: new MemoryStore(),
    onEvent: bridgeToLogger(logger),
    config: { maxIterations: 1 },
  });
  await orch.load();
  orch.skipStep();
  await orch.run();

  const skip = logger.live.find((e) => e.type === 'step-skipped');
  assert.ok(skip, 'the skip is in the Activity Log');
  assert.equal(skip.status, 'warning');
  assert.match(skip.description, /cannot end the run/, 'the consequence is stated, not implied');
});
