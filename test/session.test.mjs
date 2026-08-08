/**
 * Project / Session / Run / Iteration, persistence, migration, recovery.
 *
 * The §4 questions must be answerable from storage alone, after a crash, with
 * no live object graph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeProject, makeRun, makeIteration, phaseComplete, markPhaseComplete,
  nextPhase, resumability, HEARTBEAT_STALE_MS, toMemory, fromMemory, describeState,
  beginActive, endActive, activeMs, SCHEMA_VERSION,
} from '../src/core/session.js';
import { migrate, detectVersion, checkIntegrity, MIGRATIONS } from '../src/core/migrate.js';
import { ProjectStore, ProjectMemoryStore, MemoryKeyValue, FlakyKeyValue } from '../src/core/projectstore.js';

/* --------------------------------------------------------- the four nouns */

test('a session ending does NOT end the run', () => {
  /*
   * The distinction the whole model exists for. An MV3 worker is evicted every
   * ~30s of idle, and this orchestrator spends most of its life waiting. If
   * session and run were one object, every eviction would look like the run
   * ending — and "why did it stop?" would have no answer, because nothing did.
   */
  const p = makeProject({ scope: 'x' });
  const run = makeRun({ projectId: p.id });
  run.state = 'running';
  run.sessionIds = ['ses-1', 'ses-2', 'ses-3'];
  assert.equal(run.state, 'running');
  assert.equal(run.stopReason, null);
  assert.ok(run.sessionIds.length > 1, 'one run spans many sessions');
});

test('phases are idempotent within an iteration', () => {
  /*
   * §17: never execute a phase twice because the UI restarted. The concrete
   * cost is Arena doing the work again — possibly committing twice — and the
   * second response overwriting the first iteration's evidence.
   */
  const run = makeRun({ projectId: 'p' });
  run.currentIteration = 3;
  assert.equal(phaseComplete(run, 3, 'execute'), false);
  markPhaseComplete(run, 3, 'plan');
  markPhaseComplete(run, 3, 'execute');
  assert.equal(phaseComplete(run, 3, 'execute'), true);
  assert.equal(nextPhase(run, 3), 'evaluate', 'resumes at the right place');

  // A new iteration clears the record.
  markPhaseComplete(run, 4, 'plan');
  assert.equal(phaseComplete(run, 3, 'execute'), false);
  assert.equal(nextPhase(run, 4), 'execute');
});

test('active time excludes pauses, so durations mean something', () => {
  /*
   * Wall clock would report "37 hours" for two hours of work across days of
   * pauses, making every duration analytic meaningless.
   */
  const run = makeRun({ projectId: 'p' }, 0);
  beginActive(run, 1000);
  endActive(run, 4000);
  assert.equal(run.activeMs, 3000);
  beginActive(run, 100000);
  assert.equal(activeMs(run, 101000), 4000, 'in-flight time counts, the gap does not');
});

/* -------------------------------------------------------- resumability */

test('resumability distinguishes "yes" from "yes but ask the user"', () => {
  const clean = makeRun({ projectId: 'p' });
  clean.state = 'paused';
  clean.updatedAt = Date.now();
  assert.equal(resumability(clean).requiresUser, false);

  const stopped = makeRun({ projectId: 'p' });
  stopped.state = 'stopped';
  stopped.stopReason = 'user-stopped';
  const r = resumability(stopped);
  assert.equal(r.resumable, true);
  assert.equal(r.requiresUser, true, 'the user pressed stop; nothing may restart it automatically');

  const target = makeRun({ projectId: 'p' });
  target.state = 'stopped';
  target.stopReason = 'target-reached';
  target.stopDetail = 'overall 91%';
  assert.equal(resumability(target).resumable, false);
});

test('a run that has not moved for hours warns that the conversations moved on', () => {
  const stale = makeRun({ projectId: 'p' });
  stale.state = 'paused';
  stale.updatedAt = Date.now() - 12 * 3600_000;
  const r = resumability(stale);
  assert.equal(r.stale, true);
  assert.match(r.why, /12h ago/);
});

/* ---------------------------------------------------------- projection */

test('the session model projects to the memory the engine already understands', () => {
  /*
   * §35: preserve existing work. The engine and its 247 tests are built on
   * `memory`; rewriting them to consume the session model would risk
   * guarantees paid for with sabotage verification, for no gain.
   */
  const p = makeProject({ scope: 'a CSV exporter', mode: 'existing' });
  const run = makeRun({ projectId: p.id, mode: 'existing' });
  run.baselineDone = true;
  const it = makeIteration({ runId: run.id, projectId: p.id, n: 1 });
  Object.assign(it, {
    objective: { text: 'add streaming' }, summary: 'done', overall: 62,
    scores: [{ dimension: 'testing', score: 90, confidence: 'measured', basis: [{ kind: 'test' }] }],
    finishedAt: Date.now(),
  });

  const mem = toMemory(p, run, [it]);
  assert.equal(mem.scope, 'a CSV exporter');
  assert.equal(mem.mode, 'existing');
  assert.equal(mem.baselineDone, true);
  assert.equal(mem.iteration, 1);
  assert.equal(mem.history[0].overall, 62);
  assert.equal(mem.scores[0].scores[0].dimension, 'testing');
});

test('engine state folds back into the record', () => {
  const p = makeProject({ scope: 's' });
  const run = makeRun({ projectId: p.id });
  const it = makeIteration({ runId: run.id, projectId: p.id, n: 1 });
  const mem = toMemory(p, run, [it]);
  mem.openIssues = ['a bug'];
  mem.status = 'paused';
  mem.history = [{ n: 1, objective: { text: 'o' }, summary: 'did it', overall: 55 }];

  fromMemory(mem, { project: p, run, iteration: it });
  assert.deepEqual(p.knownIssues, ['a bug']);
  assert.equal(run.state, 'paused');
  assert.equal(it.summary, 'did it');
  assert.equal(it.overall, 55);
});

test('describeState answers every question the spec asks after a crash', () => {
  const p = makeProject({ scope: 'the project', name: 'Reporting' });
  const run = makeRun({ projectId: p.id });
  run.currentIteration = 7;
  run.lastCompletedPhase = 'execute';
  run.state = 'blocked';
  const it = makeIteration({ runId: run.id, projectId: p.id, n: 7 });
  it.objective = { text: 'fix the exporter' };
  it.evidence = [{ kind: 'test' }, { kind: 'build' }];
  it.overall = 61;

  const s = describeState({ project: p, run, iterations: [it] });
  assert.match(s.project, /Reporting/);
  assert.equal(s.iteration, 7);
  assert.equal(s.lastCompletedPhase, 'execute');
  assert.equal(s.lastObjective, 'fix the exporter');
  assert.deepEqual(s.evidenceCaptured, ['test', 'build']);
  assert.equal(s.lastScore, 61);
  assert.equal(s.resumable, true);
});

/* ---------------------------------------------------------- migrations */

test('the walking skeleton\'s unversioned memory migrates all the way forward', () => {
  const v0 = {
    scope: 'an old project', status: 'stopped', iteration: 2,
    history: [
      { n: 1, objective: { text: 'a' }, overall: 40, startedAt: 1000, finishedAt: 2000 },
      { n: 2, objective: { text: 'b' }, overall: 55, startedAt: 3000, finishedAt: 4000 },
    ],
    scores: [{ n: 2, scores: [{ dimension: 'testing', score: 80, confidence: 'measured' }] }],
    openIssues: ['old bug'], decisions: [], resolvedIssues: [],
  };
  assert.equal(detectVersion(v0), 0);

  const m = migrate(v0);
  assert.equal(m.ok, true, m.problems.join('; '));
  assert.deepEqual(m.steps, ['0→1', '1→2', '2→3']);
  assert.equal(m.data.project.scope, 'an old project');
  assert.equal(m.data.iterations.length, 2, 'history became iterations');
  assert.equal(m.data.iterations[1].scores[0].dimension, 'testing');
  assert.deepEqual(m.data.project.knownIssues, ['old bug']);
});

test('a migrated run that claimed to be running is PAUSED, never running', () => {
  /*
   * The worker that believed it was running died in a previous version of the
   * extension. Restoring it as running shows a live spinner over a run with no
   * future, and the user waits for it.
   */
  const m = migrate({ scope: 'x', status: 'running', iteration: 1, history: [] });
  assert.equal(m.data.run.state, 'paused');
  assert.match(m.data.run.stopDetail, /migrated from an older version/);
});

test('DATA FROM A NEWER BUILD IS REFUSED, NOT DOWNGRADED', () => {
  /*
   * Writing it back with this build would silently discard fields it does not
   * know about. Refusing is recoverable; destroying is not.
   */
  const m = migrate({ schemaVersion: SCHEMA_VERSION + 5, project: {}, run: {} });
  assert.equal(m.ok, false);
  assert.match(m.problems[0], /newer version/);
  assert.ok(m.original, 'the original is handed back, not dropped');
});

test('a throwing migration is contained, not propagated', () => {
  /*
   * Migration runs at extension startup. An uncaught error there is a worker
   * that never registers — a dead extension rather than a data problem.
   */
  const original = MIGRATIONS[1];
  MIGRATIONS[1] = () => { throw new Error('bad data'); };
  try {
    const m = migrate({ schemaVersion: 1, iteration: 0 });
    assert.equal(m.ok, false);
    assert.match(m.problems[0], /migration 1→2 failed/);
  } finally {
    MIGRATIONS[1] = original;
  }
});

test('unrecognisable data is refused and preserved, never guessed at', () => {
  const m = migrate({ hello: 'world' });
  assert.equal(m.ok, false);
  assert.deepEqual(m.original, { hello: 'world' });
});

test('integrity checks catch duplicates, gaps and truncated writes', () => {
  const dup = checkIntegrity({
    project: { id: 'p' }, run: { id: 'r', projectId: 'p', currentIteration: 2 },
    iterations: [{ id: 'a', runId: 'r', n: 1 }, { id: 'b', runId: 'r', n: 1 }],
  });
  assert.match(dup.problems.join(' '), /duplicate iteration number 1/);

  const gap = checkIntegrity({
    project: { id: 'p' }, run: { id: 'r', projectId: 'p', currentIteration: 3 },
    iterations: [{ id: 'a', runId: 'r', n: 1 }, { id: 'c', runId: 'r', n: 3 }],
  });
  assert.match(gap.repairs.join(' '), /iteration 2 is missing/);

  const orphan = checkIntegrity({
    project: { id: 'p' }, run: { id: 'r', projectId: 'OTHER' }, iterations: [],
  });
  assert.match(orphan.problems.join(' '), /belongs to project OTHER/);
});

/* --------------------------------------------------------------- store */

test('a project survives a full reload with its history', async () => {
  const kv = new MemoryKeyValue();
  const a = new ProjectStore({ kv });
  await a.createProject({ scope: 'a CSV exporter', mode: 'new' });
  await a.startRun({ config: { target: 90 } });
  const it = await a.beginIteration(1);
  it.objective = { text: 'add streaming' };
  it.overall = 55;
  it.finishedAt = Date.now();
  await a.checkpoint(it);

  // A completely new store, as after a browser restart.
  const b = new ProjectStore({ kv });
  const loaded = await b.load();
  assert.equal(loaded.ok, true);
  assert.equal(b.project.scope, 'a CSV exporter');
  assert.equal(b.iterations.length, 1);
  assert.equal(b.iterations[0].objective.text, 'add streaming');
});

test('a run interrupted mid-flight loads as paused and says so', async () => {
  const kv = new MemoryKeyValue();
  const a = new ProjectStore({ kv });
  await a.createProject({ scope: 's' });
  await a.startRun();               // state: running
  assert.equal(a.run.state, 'running');

  const b = new ProjectStore({ kv });
  await b.load();
  assert.equal(b.run.state, 'paused');
  assert.match(b.run.stopDetail, /interrupted/);
  assert.ok(b.diagnostics.some((d) => /mid-run/.test(d.message)));
});

test('an evicted session is detected by its successor', async () => {
  /*
   * A session that was evicted never wrote endedAt — it had no chance. The
   * only observer is the next session finding the gap.
   */
  const kv = new MemoryKeyValue();
  const a = new ProjectStore({ kv });
  await a.createProject({ scope: 's' });
  await a.startRun();
  await a.startSession();           // never ended: evicted

  const b = new ProjectStore({ kv });
  await b.load();
  await b.startSession();
  assert.ok(b.diagnostics.some((d) => /evicted/.test(d.message)));
});

test('beginIteration is idempotent, so resuming does not duplicate history', async () => {
  /*
   * Otherwise the history grows a duplicate on every eviction, and detect.js
   * sees repeated objectives that never happened.
   */
  const kv = new MemoryKeyValue();
  const s = new ProjectStore({ kv });
  await s.createProject({ scope: 's' });
  await s.startRun();
  const a = await s.beginIteration(1);
  const b = await s.beginIteration(1);
  assert.equal(a.id, b.id);
  assert.equal(s.iterations.length, 1);
});

test('a checkpoint writes the run and ONE iteration, not the whole history', async () => {
  /*
   * §5: do not put an ever-growing log in one blob. The cost per phase must be
   * bounded by one iteration, not by the length of the run.
   */
  const kv = new MemoryKeyValue();
  const s = new ProjectStore({ kv });
  await s.createProject({ scope: 's' });
  await s.startRun();
  for (let n = 1; n <= 20; n++) {
    const it = await s.beginIteration(n);
    it.finishedAt = Date.now();
  }
  const before = kv.writes;
  await s.checkpoint(s.iterations[19]);
  assert.equal(kv.writes - before, 2, 'one run write, one iteration write');
});

test('unreadable storage reports rather than throwing', async () => {
  const kv = new FlakyKeyValue({ failReads: 1 });
  const s = new ProjectStore({ kv });
  const r = await s.load();
  assert.equal(r.ok, false);
  assert.match(r.diagnostics[0].message, /storage unreadable/);
});

test('a corrupt project is QUARANTINED, not deleted', async () => {
  /*
   * Deleting a user's history to simplify our code path is not an acceptable
   * failure mode, and the likeliest cause (newer build) is fully recoverable.
   */
  const kv = new MemoryKeyValue();
  await kv.set('idx', { projects: ['p1'], activeProjectId: 'p1' });
  await kv.set('prj:p1', { totally: 'unrecognisable' });

  const s = new ProjectStore({ kv });
  const r = await s.load();
  assert.equal(r.ok, false);
  const quarantined = (await kv.keys('quarantine:')).length;
  assert.equal(quarantined, 1, 'the original is kept');
  assert.match(r.diagnostics[0].message, /kept, not deleted/);
});

test('the ProjectMemoryStore satisfies the engine\'s store interface', async () => {
  const kv = new MemoryKeyValue();
  const ps = new ProjectStore({ kv });
  await ps.createProject({ scope: 'a project', mode: 'new' });
  await ps.startRun();
  await ps.beginIteration(1);

  const store = new ProjectMemoryStore(ps);
  const mem = await store.load();
  assert.equal(mem.scope, 'a project');

  mem.openIssues = ['found a bug'];
  mem.history = [{ n: 1, objective: { text: 'o' }, summary: 's', overall: 42 }];
  await store.save(mem);

  assert.deepEqual(ps.project.knownIssues, ['found a bug']);
  assert.equal(ps.iterations[0].overall, 42);
});

/* ---------------------------------------------------------------------------
 * THE ABANDONED RUN
 *
 * MV3 terminates the worker when a single request exceeds five minutes. The
 * run is a detached promise, so eviction destroys it silently while the
 * persisted record still says `state: 'running'`. The panel then shows a live
 * spinner and a counting clock over a run that no longer exists -- which is
 * exactly what a user reported as "stuck at 05:56".
 *
 * The heartbeat that proves this was already being written every 20s and read
 * by NOTHING. These tests are the reader.
 * ------------------------------------------------------------------------ */

test('A RUN THAT SAYS RUNNING WITH A DEAD WORKER IS REPORTED AS ABANDONED', () => {
  const now = Date.now();
  const run = { state: 'running', startedAt: now - 20 * 60_000, updatedAt: now - 20 * 60_000, currentIteration: 1 };

  // Worker last checked in 10 minutes ago: it is gone.
  const r = resumability(run, { now, heartbeatAt: now - 10 * 60_000 });

  assert.equal(r.abandoned, true, 'a missing worker must be named, not hidden');
  assert.equal(r.requiresUser, true,
    'nothing resumes on its own, so claiming a clean auto-resume is a lie');
  assert.match(r.why, /background worker was shut down/);
  assert.match(r.why, /Press Resume/, 'it must say what to actually do');
});

test('a LIVE run with a fresh heartbeat is not called abandoned', () => {
  /*
   * The counterweight. The engineer legitimately takes hours; the heartbeat
   * ticks throughout. If a long wait were flagged as abandoned, the warning
   * would fire constantly and stop being believed.
   */
  const now = Date.now();
  const run = { state: 'running', startedAt: now - 3 * 3600_000, updatedAt: now - 3 * 3600_000, currentIteration: 1 };

  const r = resumability(run, { now, heartbeatAt: now - 5_000 });
  assert.notEqual(r.abandoned, true, 'three hours of real work is not abandonment');
  assert.equal(r.requiresUser, false);
});

test('an unknown heartbeat never raises a false alarm', () => {
  /*
   * `heartbeatAt` is null when storage could not be read, or on an older
   * record written before the heartbeat existed. Absence of evidence must not
   * become evidence of death -- that would tell users their healthy run is
   * broken.
   */
  const now = Date.now();
  const run = { state: 'running', startedAt: now - 60_000, updatedAt: now - 60_000, currentIteration: 1 };

  for (const beat of [null, undefined, NaN]) {
    const r = resumability(run, { now, heartbeatAt: beat });
    assert.notEqual(r.abandoned, true, `heartbeatAt=${beat} must not be read as abandonment`);
  }
});

test('the abandonment window tolerates several missed beats', () => {
  /*
   * The worker writes every 20s. One missed beat is a slow storage write, not
   * a dead worker; the threshold must sit above that or a healthy run gets
   * flagged during a GC pause.
   */
  const now = Date.now();
  const run = { state: 'running', startedAt: now - 600_000, updatedAt: now - 600_000, currentIteration: 1 };

  assert.ok(HEARTBEAT_STALE_MS >= 60_000,
    'below three missed beats this will produce false alarms');
  assert.notEqual(resumability(run, { now, heartbeatAt: now - 40_000 }).abandoned, true,
    'two missed beats is not yet evidence');
  assert.equal(resumability(run, { now, heartbeatAt: now - 120_000 }).abandoned, true,
    'six missed beats is unambiguous');
});

test('a stopped run is never relabelled as abandoned', () => {
  /* State the user set beats an inference about the worker. */
  const now = Date.now();
  const stopped = { state: 'stopped', stopReason: 'user-stopped', updatedAt: now - 3600_000 };
  const r = resumability(stopped, { now, heartbeatAt: now - 3600_000 });
  assert.notEqual(r.abandoned, true);
  assert.match(r.why, /you stopped this run/);
});
