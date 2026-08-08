/**
 * The failure policy, end to end.
 *
 * User's requirement: if any required tab, conversation or workspace is
 * missing or no longer matches, the orchestrator must pause immediately,
 * record the failure, inform the user, and wait. Never recover by creating
 * chats, opening tabs, signing in, or changing browser state.
 *
 * These tests assert that at the ENGINE level, where "wait" means the run
 * loop returns rather than spinning, and "record" means it survives a reload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Orchestrator } from '../src/core/orchestrator.js';
import { MemoryStore } from '../src/core/store.js';
import { Journal } from '../src/core/journal.js';
import { fakeManager, fakeEngineer, fakeReviewer, flatScores, passing } from './helpers/fakes.mjs';

/** An environment that is healthy for `n` checks and then drifts. */
function driftingEnvironment(healthyChecks) {
  let checks = 0;
  return {
    binding: { surfaces: { manager: { tabId: 11, label: 'ChatGPT' } } },
    calls: () => checks,
    async check() {
      checks++;
      if (checks <= healthyChecks) return { ok: true, problems: [] };
      return {
        ok: false,
        problems: [{
          surface: 'manager',
          label: 'ChatGPT (project manager)',
          kind: 'conversation-changed',
          detail: 'bound to "conv-a", tab is now on "conv-b"',
          remedy: 'switch that tab back to the bound conversation, then resume',
        }],
      };
    },
  };
}

function build(environment, { objectives, results, evaluations } = {}) {
  const store = new MemoryStore();
  const journal = new Journal();
  const orch = new Orchestrator({
    manager: fakeManager({
      objectives: objectives || [
        { text: 'implement the CSV export pipeline' },
        { text: 'wire up keyboard navigation in the sidebar' },
        { text: 'add a retry budget to the network layer' },
        { text: 'document the public plugin interface' },
      ],
      evaluations: evaluations || [{ scores: flatScores(40) }],
    }),
    engineer: fakeEngineer({ results: results || [{ evidence: [passing(10)], filesChanged: ['a.js'], summary: 'ok' }] }),
    reviewer: fakeReviewer(),
    store,
    environment,
    onEvent: journal.record,
    config: { maxIterations: 4 },
  });
  return { orch, store, journal };
}

test('a run does not START if the environment is already wrong', async () => {
  const env = driftingEnvironment(0);
  const { orch, journal } = build(env);
  const verdict = await orch.run();

  assert.equal(verdict.reason, 'environment-blocked');
  assert.equal(orch.memory.status, 'blocked');
  assert.equal(orch.memory.iteration, 0, 'no work may be attempted');
  assert.ok(journal.events.some((e) => e.type === 'environment-drift'));
  assert.ok(journal.events.some((e) => e.type === 'run-blocked'));
  assert.equal(
    journal.events.some((e) => e.type === 'run-started'),
    false,
    'the UI must never show a run as live when it never began',
  );
});

test('drift MID-ITERATION halts at the next phase boundary, not at the end', async () => {
  // healthy for run-start + plan, drifts at execute
  const env = driftingEnvironment(2);
  const { orch, journal } = build(env);
  const verdict = await orch.run();

  assert.equal(verdict.reason, 'environment-blocked');
  assert.equal(orch.memory.status, 'blocked');
  assert.equal(orch.memory.iteration, 0, 'the iteration did not complete');

  const rec = orch.memory.history.at(-1);
  assert.equal(rec.partial, true);
  assert.equal(rec.blockedAt, 'plan', 'blocked entering execute, so the last saved phase is plan');
  assert.ok(journal.events.some((e) => e.type === 'iteration-blocked'));
});

test('a block is NOT a failure — the run stays resumable', async () => {
  /*
   * `shouldStop` treats `status: 'failed'` as terminal. If a closed tab were
   * recorded as a failure, fixing the tab and pressing Resume would be refused
   * with "unrecoverable failure" — punishing the user for the recovery the
   * failure policy asks them to perform.
   */
  const env = driftingEnvironment(0);
  const { orch } = build(env);
  await orch.run();
  assert.equal(orch.memory.status, 'blocked');
  assert.notEqual(orch.memory.status, 'failed');
  assert.equal(orch.memory.stopReason, null);
});

test('the block reason is PERSISTED, so it survives an extension reload', async () => {
  const env = driftingEnvironment(0);
  const { orch, store } = build(env);
  await orch.run();

  const saved = await store.load();
  assert.ok(saved.block, 'the reason must be in the store, not just in memory');
  assert.match(saved.block.detail, /conversation-changed/);
  assert.equal(saved.block.problems[0].remedy.length > 0, true);
  assert.equal(saved.status, 'blocked');
});

test('a blocked run refuses to restart until a human unblocks it', async () => {
  const env = driftingEnvironment(0);
  const { orch } = build(env);
  await orch.run();
  const before = env.calls();

  const again = await orch.run();
  assert.equal(again.reason, 'environment-blocked');
  assert.equal(
    env.calls(),
    before,
    'it must not even re-probe: a tab that happens to be back is not consent to resume',
  );

  // The human path.
  await orch.unblock();
  assert.equal(orch.memory.block, null);
  assert.equal(orch.memory.status, 'paused');
});

test('after unblocking, a healthy environment lets the run continue normally', async () => {
  let healthy = false;
  const env = {
    async check() {
      return healthy
        ? { ok: true, problems: [] }
        : { ok: false, problems: [{ surface: 'manager', label: 'ChatGPT', kind: 'tab-missing', detail: 'gone', remedy: 'reopen' }] };
    },
  };
  const { orch } = build(env);

  assert.equal((await orch.run()).reason, 'environment-blocked');

  healthy = true;             // the user reopened the tab
  await orch.unblock();       // and said so
  const verdict = await orch.run();

  assert.notEqual(verdict.reason, 'environment-blocked');
  assert.ok(orch.memory.iteration > 0, 'real work happened after recovery');
});

test('an environment probe that THROWS is a failed check, not a passed one', async () => {
  /*
   * chrome.tabs.get rejects when the tab is gone — exactly the condition being
   * probed for. An escaping exception used to land in iterate()'s generic
   * catch and be recorded as a terminal crash.
   */
  const env = { async check() { throw new Error('No tab with id: 11.'); } };
  const { orch } = build(env);
  const verdict = await orch.run();

  assert.equal(verdict.reason, 'environment-blocked');
  assert.equal(orch.memory.status, 'blocked');
  assert.match(orch.memory.block.detail, /No tab with id/);
});

test('with no environment configured the engine runs unchanged (fakes, dry runs)', async () => {
  const { orch } = build(null);
  const verdict = await orch.run();
  assert.notEqual(verdict.reason, 'environment-blocked');
  assert.ok(orch.memory.iteration > 0);
});

test('the environment is checked at every phase, not once per iteration', async () => {
  const env = driftingEnvironment(1000);
  const { orch } = build(env);
  await orch.run(); // 4 iterations, then budget-exhausted

  // 1 at run-start, then per iteration: plan, execute, evaluate, review-gate.
  // The point is only that it is MORE than one per iteration; pin the shape.
  assert.ok(
    env.calls() >= 1 + orch.memory.iteration * 4,
    `expected >= ${1 + orch.memory.iteration * 4} checks, got ${env.calls()}`,
  );
});

test('a single drift is logged ONCE, not once per handler that saw it', async () => {
  /*
   * Both the phase gate and iterate()'s catch handle the same exception. When
   * both called block(), the log showed the identical problem twice — which a
   * reader interprets as "it tried again", the one thing this subsystem
   * promises never happens. Found by reading a generated sample log; the suite
   * was green because nothing counted events.
   */
  const env = driftingEnvironment(2);
  const { orch, journal } = build(env);
  await orch.run();

  const drifts = journal.events.filter((e) => e.type === 'environment-drift');
  const blocks = journal.events.filter((e) => e.type === 'run-blocked');
  assert.equal(drifts.length, 1, 'one drift, one log line');
  assert.equal(blocks.length, 1);
});

test('a drift is labelled with the iteration it actually happened in', async () => {
  /*
   * `memory.iteration` is the COMPLETED count and lags mid-iteration, so a
   * drift during iteration 3 was filed under iteration 2 — a timeline that
   * contradicted its own detail string on the same line.
   */
  const env = driftingEnvironment(6); // survives iteration 1, drifts in 2
  const { orch, journal } = build(env);
  await orch.run();

  const drift = journal.events.find((e) => e.type === 'environment-drift');
  const n = Number(String(drift.where).match(/iteration (\d+)/)[1]);
  assert.equal(drift.iteration, n, `where says iteration ${n}, label says ${drift.iteration}`);
  assert.equal(drift.iteration, orch.memory.iteration + 1, 'a drift belongs to the in-flight iteration');
});

test('detect is NOT gated — pure local arithmetic cannot be broken by a tab', async () => {
  /*
   * Blocking the detector would refuse the one phase that touches nothing, and
   * worse, would skip stagnation analysis for the partial iteration that a
   * drift produced.
   */
  const { orch } = build({ async check() { return { ok: true, problems: [] }; } });
  const spy = [];
  const original = orch.checkEnvironment.bind(orch);
  orch.checkEnvironment = async (where) => { spy.push(where); return original(where); };

  await orch.run();
  assert.equal(spy.some((w) => /detect/.test(String(w))), false);
  assert.equal(spy.some((w) => /plan/.test(String(w))), true);
});
