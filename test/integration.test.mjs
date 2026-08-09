/**
 * End-to-end integration against the simulator.
 *
 * §41 lists the scenarios the finished system must survive. Each one is here,
 * driven through the REAL engine, adapters, schemas, parsers and store — only
 * the transport is simulated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManagerAdapter } from '../src/adapters/manager.js';
import { EngineerAdapter } from '../src/adapters/engineer.js';
import { ReviewerAdapter } from '../src/adapters/reviewer.js';
import { SimTransport } from '../src/sim/transport.js';
import { ProjectStore, MemoryKeyValue } from '../src/core/projectstore.js';
import { Runner } from '../src/core/runner.js';

async function build({ faults = {}, config = {}, kv = new MemoryKeyValue(), scope = 'A CSV export feature', mode = 'new', reviewer = true } = {}) {
  const events = [];
  const onEvent = (e) => events.push(e);
  const transport = new SimTransport({ seed: 7, faults });
  const store = new ProjectStore({ kv });
  if (!store.project) {
    await store.createProject({ scope, mode, name: 'Reporting' });
    await store.startRun({ config: { maxIterations: 6, reviewEvery: 3, target: 90, ...config } });
  }
  const runner = new Runner({
    manager: new ManagerAdapter({ transport, onEvent, policy: { backoffMs: 1 } }),
    engineer: new EngineerAdapter({ transport, onEvent, policy: { backoffMs: 1 } }),
    reviewer: reviewer ? new ReviewerAdapter({ transport, onEvent, policy: { backoffMs: 1 } }) : null,
    store, onEvent,
    config: { maxIterations: 6, reviewEvery: 3, target: 90, ...config },
  });
  return { runner, store, transport, events, kv, types: () => new Set(events.map((e) => e.type)) };
}

/* ================================================== the happy path ====== */

test('a full run produces evidence-backed scores and a legitimate stop', async () => {
  const { runner, store, types } = await build();
  const verdict = await runner.start();

  assert.equal(verdict.reason, 'budget-exhausted');
  assert.equal(store.iterations.length, 6);
  assert.equal(store.run.state, 'stopped');

  for (const it of store.iterations) {
    assert.ok(it.evidence.length >= 2, `iteration ${it.n} captured no evidence`);
    assert.ok(it.evidence.some((e) => e.kind === 'test'), `iteration ${it.n} has no test evidence`);
    assert.equal(it.scores.length, 9, 'every dimension is scored');
    assert.ok(Number.isFinite(it.overall));
  }

  // The whole pipeline fired.
  for (const t of ['run-started', 'phase-started', 'prompt-sent', 'response-received',
    'evidence-captured', 'phase-completed', 'run-finished']) {
    assert.ok(types().has(t), `missing event: ${t}`);
  }
});

test('testing is MEASURED while opinion dimensions stay asserted', async () => {
  /*
   * The central claim of the product. If everything came back `measured` the
   * confidence model would be decoration.
   */
  const { runner, store } = await build();
  await runner.start();
  const last = store.iterations.at(-1).scores;

  assert.equal(last.find((s) => s.dimension === 'testing').confidence, 'measured');
  assert.equal(last.find((s) => s.dimension === 'uiux').confidence, 'asserted');
  assert.ok(last.filter((s) => s.confidence === 'asserted').length >= 5);
});

test('evidence is traceable back to the text it was read from', async () => {
  const { runner, store } = await build();
  await runner.start();
  const testEv = store.iterations[0].evidence.find((e) => e.kind === 'test');
  assert.ok(testEv.provenance, 'evidence must carry provenance');
  assert.equal(testEv.provenance.iteration, 1);
  assert.ok(testEv.provenance.parser);
  assert.match(testEv.provenance.rawReference, /passed|Tests/);
});

test('a stalled trajectory is detected and pulls a strategy change', async () => {
  const { runner, store, types } = await build();
  await runner.start();
  assert.ok(types().has('strategy-changed'), 'the reviewer\'s change was not applied');
  assert.ok(store.project.decisions.some((d) => d.kind === 'strategy'));
});

/* ================================================== role boundaries ===== */

test('THE MANAGER CANNOT WRITE CODE even when it tries every iteration', async () => {
  const { runner, store, events } = await build({
    faults: { manager: Object.fromEntries([...Array(12)].map((_, i) => [i + 1, 'forbidden'])) },
  });
  await runner.start();

  const dropped = events.filter((e) => e.type === 'response-validated' && e.dropped?.length);
  assert.ok(dropped.length > 0, 'the attempt must be recorded');
  assert.ok(dropped.some((e) => e.dropped.includes('patch')));

  for (const it of store.iterations) {
    assert.equal('patch' in (it.objective ?? {}), false);
    assert.equal('command' in (it.objective ?? {}), false);
  }
});

test('THE ENGINEER CANNOT DECLARE THE PROJECT COMPLETE', async () => {
  const { runner, store } = await build({
    faults: { engineer: Object.fromEntries([...Array(8)].map((_, i) => [i + 1, 'forbidden'])) },
  });
  const verdict = await runner.start();
  assert.notEqual(verdict.reason, 'target-reached');
  assert.equal(store.run.state, 'stopped');
  assert.equal(store.iterations.some((i) => i.projectComplete), false);
});

test('FLATTERY CANNOT REACH THE TARGET', async () => {
  /*
   * THE MOST IMPORTANT TEST IN THE SUITE.
   *
   * The manager claims every dimension at 95% `measured` with a basis naming
   * evidence that was never produced. If the run stopped as `target-reached`,
   * every guarantee in this project would be theatre.
   */
  const { runner, store } = await build({
    faults: { manager: Object.fromEntries([...Array(12)].map((_, i) => [i + 1, 'flattery'])) },
    config: { target: 90, maxIterations: 4 },
  });
  const verdict = await runner.start();

  assert.notEqual(verdict.reason, 'target-reached');
  const scores = store.iterations.at(-1).scores;
  for (const s of scores) {
    if (s.dimension === 'testing') continue; // computed from real evidence
    assert.notEqual(s.confidence, 'measured', `${s.dimension} claimed measured with no basis`);
  }
});

test('a contradiction between prose and numbers is recorded, not believed', async () => {
  const { runner, store, events } = await build({
    faults: { engineer: { 1: 'contradiction' } },
    config: { maxIterations: 2 },
  });
  await runner.start();
  assert.ok(events.some((e) => e.type === 'report-contradiction'));
  assert.ok(store.iterations[0].contradictions?.length > 0);
});

/* ================================================== failure recovery ==== */

test('an AI timeout retries at the transport, then at the run, then gives up', async () => {
  /*
   * Two layers of retry, deliberately:
   *   - the adapter retries the SEND once (the AI may just have been slow);
   *   - the runner retries the RUN, up to MAX_CONSECUTIVE_FAILURES.
   * A permanently timing-out AI therefore ends the run rather than pausing
   * forever, and the reason names the pattern rather than the last symptom.
   */
  const { runner, store, transport, events } = await build({
    faults: { manager: Object.fromEntries([...Array(20)].map((_, i) => [i + 1, 'timeout'])) },
    config: { maxIterations: 3 },
  });
  const verdict = await runner.start();

  assert.equal(verdict.reason, 'fatal-error');
  assert.match(String(store.run.stopDetail), /3 consecutive failures/);
  assert.ok(transport.calls.manager >= 2, 'the transport-level retry happened');
  assert.ok(events.some((e) => e.type === 'recovery-attempt'));
  assert.ok(events.some((e) => e.type === 'recovery-failed'));
});

test('a SINGLE timeout recovers and the run continues', async () => {
  /*
   * The other half, and the one that matters more: a transient failure must
   * not end a healthy run.
   */
  const { runner, store } = await build({
    faults: { manager: { 1: 'timeout' } },
    config: { maxIterations: 3 },
  });
  const verdict = await runner.start();
  assert.equal(verdict.reason, 'budget-exhausted', 'a single blip must not be fatal');
  assert.equal(store.iterations.length, 3);
});

test('a malformed response is reprompted once, then the run pauses', async () => {
  const { runner, store, events } = await build({
    faults: { manager: Object.fromEntries([...Array(20)].map((_, i) => [i + 1, 'malformed'])) },
    config: { maxIterations: 2 },
  });
  await runner.start();

  const reprompts = events.filter((e) => e.type === 'schema-reprompt');
  assert.ok(reprompts.length > 0, 'a schema-aware reprompt must be attempted');
  /*
   * ONE reprompt per exchange, not a loop. A model that ignored an explicit
   * schema error will not comply on the third ask, and each attempt costs a
   * round trip against the user's rate limit.
   */
  const perExchange = events.filter((e) => e.type === 'prompt-sent' && e.what === 'plan').length;
  assert.ok(perExchange <= reprompts.length + 4, 'reprompting must not loop');
  assert.match(String(store.run.stopDetail), /unusable|malformed|consecutive failures/i);
  assert.notEqual(store.run.state, 'running');
});

test('A MALFORMED ENGINEER REPLY STILL YIELDS ITS REAL NUMBERS', async () => {
  /*
   * Arena often does the work correctly and formats the report badly. Refusing
   * to look would discard a measured fact because of a formatting error — and
   * re-asking would cost another full build and test run.
   */
  const { runner, store } = await build({
    faults: { engineer: { 1: 'malformed' } },
    config: { maxIterations: 1 },
  });
  await runner.start();
  const ev = store.iterations[0].evidence;
  const t = ev.find((e) => e.kind === 'test');
  assert.ok(t, 'the terminal output inside the prose must still be parsed');
  assert.equal(t.passed, 1276);
  assert.equal(t.failed, 3);
});

test('a closed tab does NOT retry — it stops immediately', async () => {
  const { runner, transport } = await build({
    faults: { engineer: { 1: 'transport', 2: 'transport' } },
    config: { maxIterations: 2 },
  });
  await runner.start();
  assert.equal(transport.calls.engineer, 1, 'a dead tab must not be retried');
});

test('repeated failure STOPS the run rather than looping forever', async () => {
  const { runner, store, events } = await build({
    faults: { manager: Object.fromEntries([...Array(20)].map((_, i) => [i + 1, 'timeout'])) },
    config: { maxIterations: 20 },
  });
  await runner.start();
  /*
   * The run must END, and say it was a fatal failure rather than a normal
   * stop. `state` is asserted as a terminal value rather than exactly
   * 'failed', because a run that fails fatally is also, correctly, stopped —
   * pinning the intermediate label would test an implementation detail.
   */
  assert.ok(['failed', 'stopped'].includes(store.run.state));
  assert.equal(store.run.stopReason, 'fatal-error');
  assert.match(String(store.run.stopDetail), /consecutive failures/);
  assert.ok(events.some((e) => e.type === 'recovery-failed'));
});

test('an empty response is a failure, not an empty success', async () => {
  const { runner, store } = await build({
    faults: { manager: { 1: 'empty', 2: 'empty', 3: 'empty', 4: 'empty' } },
    config: { maxIterations: 2 },
  });
  await runner.start();
  assert.notEqual(store.run.state, 'running');
  /*
   * Iteration 1 legitimately HAS an objective even when the manager is silent:
   * the baseline is fixed by the engine, by design, so a run can start before
   * any AI has spoken. What must never happen is an EVALUATION appearing from
   * silence — that is the manager's own output, and it produced none.
   */
  assert.equal(store.iterations[0]?.scores?.length ?? 0, 0, 'no scores may be invented from silence');

  /*
   * `unusable` was in this alternation and made the assertion too loose.
   *
   * With the empty-reply guard removed, an empty string is now caught one
   * layer later by the identical-reply check ("returned a byte-identical
   * evaluation"), whose message routes through the same "unusable" wording.
   * The test therefore passed with the guard sabotaged — it asserted that the
   * run stopped, not that it stopped FOR THE RIGHT REASON. Reported by
   * tools/sabotage.mjs, not by reading.
   *
   * An empty reply must be named as empty: "the model said nothing" and "the
   * model said the same wrong thing twice" are different faults with
   * different fixes.
   */
  assert.match(String(store.run.stopDetail), /empty response|did not respond/i,
    'an empty reply must be diagnosed as empty, not folded into a generic "unusable"');
});

/* ================================================== persistence ========= */

test('A BROWSER RELOAD MID-RUN RESUMES WITHOUT REDOING WORK', async () => {
  /*
   * The §41 scenario. The worker dies after the first iteration; a fresh store
   * loads from disk and continues.
   */
  const kv = new MemoryKeyValue();
  const first = await build({ kv, config: { maxIterations: 2 } });
  await first.runner.start();
  const afterFirst = first.store.iterations.length;
  const firstObjective = first.store.iterations[0].objective.text;

  // Everything in memory is discarded, as on an extension reload.
  const store2 = new ProjectStore({ kv });
  const loaded = await store2.load();
  assert.equal(loaded.ok, true);
  assert.equal(store2.iterations.length, afterFirst, 'history survived');
  assert.equal(store2.iterations[0].objective.text, firstObjective);
  assert.equal(store2.iterations[0].evidence.length > 0, true, 'evidence survived');
  assert.equal(store2.run.state, 'stopped');
});

test('a phase already completed is not executed twice on resume', async () => {
  /*
   * §17. The concrete cost of getting this wrong is Arena doing the work
   * again — another build, another commit — and overwriting the evidence.
   */
  const kv = new MemoryKeyValue();
  const { runner, store, transport, events } = await build({ kv, config: { maxIterations: 1 } });
  await runner.start();
  const engineerCalls = transport.calls.engineer;

  /*
   * Reload from storage exactly as the extension would. The persisted
   * `completedPhases` is what must suppress re-execution — not anything held
   * in memory by the previous runner.
   */
  const reloaded = new ProjectStore({ kv });
  const load = await reloaded.load();
  assert.equal(load.ok, true);
  assert.ok(reloaded.run.completedPhases.includes('execute'), 'the completion was persisted');

  const seen = [];
  const resumed = new Runner({
    manager: { plan: async () => { throw new Error('must not plan'); } },
    engineer: { execute: async () => { throw new Error('the execute phase must not run again'); } },
    reviewer: null,
    store: reloaded,
    onEvent: (e) => seen.push(e),
    config: { maxIterations: 1 },
  });

  const cached = await resumed.once('execute', reloaded.run.currentIteration, async () => {
    throw new Error('the execute phase must not run again');
  }, () => ({ summary: 'cached' }));

  assert.equal(cached.summary, 'cached');
  assert.equal(transport.calls.engineer, engineerCalls, 'no new engineer call');
  assert.ok(seen.some((e) => e.type === 'phase-skipped'));
});

test('the record answers every §4 question after a crash', async () => {
  const kv = new MemoryKeyValue();
  const { runner } = await build({ kv, config: { maxIterations: 2 } });
  await runner.start();

  const fresh = new ProjectStore({ kv });
  await fresh.load();
  const s = fresh.state();

  assert.match(s.project, /Reporting/);
  assert.ok(s.run.startsWith('run-'));
  assert.ok(s.iteration >= 1);
  assert.ok(s.lastCompletedPhase);
  assert.ok(s.lastObjective);
  assert.ok(s.evidenceCaptured.length > 0);
  assert.ok(Number.isFinite(s.lastScore));
  assert.ok(s.stopReason);
  assert.equal(typeof s.resumable, 'boolean');
});

/* ================================================== human control ======= */

test('user stop is honoured and never auto-restarts', async () => {
  const { runner, store } = await build({ config: { maxIterations: 6 } });
  await runner.stop();
  const verdict = await runner.start();
  assert.equal(verdict.reason, 'user-stopped');
  assert.equal(store.run.stopReason, 'user-stopped');
  assert.equal(store.iterations.length, 0, 'no work may happen after a stop');
});

test('explore mode runs an exploration baseline before improvement', async () => {
  const { runner, store } = await build({ mode: 'explore', config: { maxIterations: 2 } });
  await runner.start();
  assert.match(store.iterations[0].objective.text, /Explore and understand/);
  assert.deepEqual(store.iterations[0].objective.constraints, ['do not modify any code', 'do not commit']);
  assert.equal(store.run.baselineDone, true);
});

test('a run works with no reviewer configured', async () => {
  const { runner, store } = await build({ reviewer: false, config: { maxIterations: 3 } });
  const verdict = await runner.start();
  assert.equal(verdict.reason, 'budget-exhausted');
  assert.equal(store.iterations.length, 3);
});

/* ---------------------------------------------------------------------------
 * A MALFORMED REPLY MUST SHIP A SAMPLE OF ITSELF.
 *
 * This event recorded `chars: 60433` and `chars: 104042` in two real runs and
 * not one character of the reply. Both times the parser was at fault, and both
 * diagnoses had to be reasoned out from the character count alone — with the
 * text sitting right there, being discarded.
 * ------------------------------------------------------------------------ */

test('A MALFORMED REPLY IS LOGGED WITH THE TEXT THAT FAILED TO PARSE', async () => {
  const { EngineerAdapter } = await import('../src/adapters/engineer.js');
  const events = [];
  const body = 'I did the work.\n' + 'x'.repeat(5000) + '\nTHE VERY END';
  const adapter = new EngineerAdapter({
    transport: { async send() { return { text: body }; } },
    onEvent: (e) => events.push(e),
    policy: { backoffMs: 1, schemaRetries: 0 },
  });

  await adapter.execute({ objective: { text: 'do a thing' }, scope: 's', iteration: 1 }).catch(() => {});
  const bad = events.find((e) => e.type === 'response-malformed');

  assert.ok(bad, 'the malformed reply must be reported at all');
  assert.ok(bad.head?.length, 'the HEAD must be present — a fence problem shows up at the top');
  assert.ok(bad.tail?.length, 'the TAIL must be present — truncation shows up at the bottom');
  assert.match(bad.head, /I did the work/);
  assert.match(bad.tail, /THE VERY END/);
  assert.equal(bad.fenceSeen, false,
    'whether the model emitted the marker at all is the question the old message conflated');
  assert.equal(bad.chars, body.length);
});

test('the sample is BOUNDED so a 100k reply cannot overrun the log', async () => {
  const { EngineerAdapter } = await import('../src/adapters/engineer.js');
  const events = [];
  const huge = 'y'.repeat(104_042);   // the size of a real reply
  const adapter = new EngineerAdapter({
    transport: { async send() { return { text: huge }; } },
    onEvent: (e) => events.push(e),
    policy: { backoffMs: 1, schemaRetries: 0 },
  });

  await adapter.execute({ objective: { text: 'x' }, scope: 's', iteration: 1 }).catch(() => {});
  const bad = events.find((e) => e.type === 'response-malformed');

  assert.ok(bad.head.length <= 2000, `head must be capped, got ${bad.head.length}`);
  assert.ok(bad.tail.length <= 2000, `tail must be capped, got ${bad.tail.length}`);
  assert.equal(bad.chars, 104_042, 'the TRUE size must still be reported exactly');
});

test('the logged sample is REDACTED like every other captured text', async () => {
  /*
   * This ships raw model output into a durable log that users are asked to
   * send to someone else. A reply that echoes a token must not leak it.
   */
  const { EngineerAdapter } = await import('../src/adapters/engineer.js');
  const events = [];
  const leaky = 'I used the token ghp_' + 'A'.repeat(36) + ' to push the branch.';
  const adapter = new EngineerAdapter({
    transport: { async send() { return { text: leaky }; } },
    onEvent: (e) => events.push(e),
    policy: { backoffMs: 1, schemaRetries: 0 },
  });

  await adapter.execute({ objective: { text: 'x' }, scope: 's', iteration: 1 }).catch(() => {});
  const bad = events.find((e) => e.type === 'response-malformed');

  assert.ok(!bad.head.includes('ghp_' + 'A'.repeat(36)),
    'a credential echoed by the model must not reach the exported log');
});

/* ---------------------------------------------------------------------------
 * AN IDENTICAL REPLY MEANS THE RETRY CANNOT HELP (run 202608091336)
 *
 * The manager returned 1717 characters, failed to parse, was re-asked with the
 * schema error attached, and returned 1717 characters again — byte for byte
 * the same reply. The second round trip cost ~47 seconds, produced the
 * identical failure, and ended the run.
 * ------------------------------------------------------------------------ */

test('A BYTE-IDENTICAL REPLY SHORT-CIRCUITS THE SCHEMA RETRY', async () => {
  const { ManagerAdapter } = await import('../src/adapters/manager.js');
  const events = [];
  let calls = 0;
  const stubborn = 'here is my evaluation, unparseable and unchanging';

  const adapter = new ManagerAdapter({
    transport: { async send() { calls++; return { text: stubborn }; } },
    onEvent: (e) => events.push(e),
    policy: { backoffMs: 1 },
  });

  const err = await adapter.evaluate({ objective: { text: 'x' }, summary: 's', evidence: [], scope: 'p' })
    .then(() => null, (e) => e);

  assert.ok(err, 'an unparseable evaluation must still fail');
  assert.equal(calls, 2, `expected the retry to stop after one repeat, got ${calls} calls`);
  assert.match(err.message, /byte-identical/,
    'the message must say WHY retrying stopped, not just that it failed');
  assert.equal(err.detail?.repeated, true);
  assert.ok(events.some((e) => e.type === 'response-repeated'),
    'the log must record that the model repeated itself');
});

test('a model that CORRECTS itself on retry still succeeds', async () => {
  /*
   * The counterweight, and the reason the retry exists at all. Short-circuiting
   * on any second attempt would throw away the case this feature was built
   * for: the model reads the schema error and fixes its output.
   */
  const { ManagerAdapter } = await import('../src/adapters/manager.js');
  const good = JSON.stringify({
    scores: [{ dimension: 'testing', score: 80, confidence: 'measured', basis: 'ran the suite' }],
    issues: [], resolved: [],
  });
  let calls = 0;
  const adapter = new ManagerAdapter({
    transport: {
      async send() {
        calls++;
        return { text: calls === 1 ? 'sorry, not JSON' : '```ORCHESTRATOR-EVALUATION\n' + good + '\n```' };
      },
    },
    onEvent: () => {},
    policy: { backoffMs: 1 },
  });

  const out = await adapter.evaluate({ objective: { text: 'x' }, summary: 's', evidence: [], scope: 'p' });
  assert.equal(calls, 2, 'the retry must actually be attempted');
  assert.ok(out, 'a corrected reply must be accepted');
});

/* ---------------------------------------------------------------------------
 * THE MANAGER PATH HAD ITS OWN, WEAKER PARSER (run 202608091410)
 *
 * `manager.js:extractJson` is a second copy of `report.js`'s extractor. Every
 * repair made there had to be made here too, and was not:
 *
 *   per-line backticks       fixed in report.js at 25a94a1 — missing here
 *   bare fence, no backticks fixed in report.js at 217121a — missing here
 *
 * ChatGPT returned its evaluation with every line in inline code. The
 * last-resort branch sliced first-{ to last-} and produced
 * `{`\n`  "scores"…`, failing at "position 2 (line 1 column 3)" — precisely
 * what the log records. The run died on a formatting detail the engineer path
 * had already learned to handle.
 * ------------------------------------------------------------------------ */

const EVAL_JSON = '{"scores":[{"dimension":"testing","score":80,"confidence":"measured","basis":"ran the suite"}],'
  + '"issues":[],"resolved":[]}';

test('THE MANAGER PARSES AN EVALUATION WRAPPED IN PER-LINE BACKTICKS', async () => {
  const { extractJson } = await import('../src/adapters/manager.js');
  const backticked = ['`{`', '`  "scores": [],`', '`  "issues": []`', '`}`'].join('\n');

  const raw = extractJson('Here is my evaluation.\n\n' + backticked, 'ORCHESTRATOR-EVALUATION');
  assert.ok(raw, 'a block must be found');
  assert.doesNotThrow(() => JSON.parse(raw),
    'this exact shape ended three runs with "position 2 (line 1 column 3)"');
  assert.deepEqual(JSON.parse(raw), { scores: [], issues: [] });
});

test('the manager accepts every reply shape the engineer path accepts', async () => {
  /*
   * The point of the fix is parity. Two extractors that disagree about what a
   * valid reply looks like is how the engineer path ends up hardened and the
   * manager path does not.
   */
  const { extractJson } = await import('../src/adapters/manager.js');
  const shapes = {
    'fenced with the marker': '```ORCHESTRATOR-EVALUATION\n' + EVAL_JSON + '\n```',
    'a plain ```json fence': '```json\n' + EVAL_JSON + '\n```',
    'the bare marker, no backticks': 'ORCHESTRATOR-EVALUATION\n' + EVAL_JSON,
    'naked JSON amid prose': 'Here you go:\n' + EVAL_JSON + '\nHope that helps.',
  };
  for (const [name, text] of Object.entries(shapes)) {
    const raw = extractJson(text, 'ORCHESTRATOR-EVALUATION');
    assert.doesNotThrow(() => JSON.parse(String(raw)), `failed on: ${name}`);
  }
});

test('a markdown fence is not eaten by the manager unwrap', async () => {
  /*
   * ``` is itself a line starting and ending with a backtick. The same naive
   * rule that broke four tests in report.js would break the block here too.
   */
  const { extractJson } = await import('../src/adapters/manager.js');

  /*
   * Asserting only that the result parses is too weak: a mangled closing
   * fence still gets rescued by the naked-JSON fallback, so the test passed
   * with the bug present and survived its own sabotage. Found by running the
   * sabotage, not by reading.
   *
   * The block must therefore contain PROSE AFTER the fence that a
   * first-{-to-last-} fallback would swallow. Only an intact fence excludes
   * it.
   */
  const text = '```ORCHESTRATOR-EVALUATION\n' + EVAL_JSON + '\n```\n\nLet me know if { anything } needs changing.';
  const raw = extractJson(text, 'ORCHESTRATOR-EVALUATION');

  assert.equal(JSON.parse(raw).scores[0].score, 80);
  assert.ok(!String(raw).includes('needs changing'),
    'the closing fence must still bound the block — a mangled fence lets trailing prose in');
});

test('a backtick inside a string value survives the manager unwrap', async () => {
  const { extractJson } = await import('../src/adapters/manager.js');
  const withCode = JSON.stringify({ scores: [], issues: ['run `npm test` first'], resolved: [] });
  const lines = JSON.stringify(JSON.parse(withCode), null, 2).split('\n').map((l) => '`' + l + '`').join('\n');
  const parsed = JSON.parse(extractJson('ORCHESTRATOR-EVALUATION\n' + lines, 'ORCHESTRATOR-EVALUATION'));
  assert.equal(parsed.issues[0], 'run `npm test` first',
    'prose fields quote shell commands; corrupting one silently is worse than failing');
});

/* ---------------------------------------------------------------------------
 * A REPEATED REPLY MUST NOT BE RETRIED AT THE RUN LEVEL EITHER.
 *
 * The schema retry stopped correctly after one repeat. The RUN-level recovery
 * ladder then read `recoverable: true` and restarted the whole run three
 * times: six ChatGPT calls, three identical failures, one outcome.
 * ------------------------------------------------------------------------ */

test('A BYTE-IDENTICAL REPLY IS NOT MARKED RECOVERABLE', async () => {
  const { AdapterError } = await import('../src/adapters/base.js');

  assert.equal(new AdapterError('malformed', 'x', { repeated: true }).recoverable, false,
    'the run-level ladder retried this three times against a deterministic fault');
  assert.equal(new AdapterError('malformed', 'x', {}).recoverable, true,
    'an ordinary malformed reply is still worth one more attempt — the model may self-correct');
  assert.equal(new AdapterError('timed-out', 'x', {}).recoverable, true,
    'a timeout is still recoverable');
});
