/**
 * The logging subsystem.
 *
 * The requirement that drives most of this file is "the log must never
 * silently discard events" — which is a claim about the FAILURE paths, not the
 * happy path. A sink that always works cannot demonstrate it, so several tests
 * here use a sink that refuses to write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Logger, summarise, formatDuration } from '../src/core/logger.js';
import { MemoryLogSink, FlakyLogSink, toNdjson, toCsv } from '../src/core/logsink.js';
import { makeEvent, makeSequencer, makeSessionId, EVENT_TYPES, WORKFLOW_STAGES } from '../src/core/events.js';

/* ------------------------------------------------------------- vocabulary */

test('every event type declares a channel, a source and a label', () => {
  for (const [type, spec] of Object.entries(EVENT_TYPES)) {
    assert.ok(spec.channel, `${type} has no channel`);
    assert.ok(spec.source, `${type} has no source`);
    assert.ok(spec.label, `${type} has no label`);
  }
});

test('an unknown event type is rejected, not quietly accepted', () => {
  /*
   * A typo'd event name that is accepted becomes an entry no filter can find.
   * The log still looks full, so nobody notices the "show all prompts" view is
   * missing a third of them.
   */
  assert.throws(() => makeEvent('prompt-sent'), /unknown event type/);
  assert.throws(() => makeEvent('prompt-submitted', { source: 'gemini' }), /unknown source/);
  assert.throws(() => makeEvent('prompt-submitted', { status: 'ok' }), /unknown status/);
});

test('every event carries the fields the specification lists', () => {
  const e = makeEvent('prompt-submitted', {
    iteration: 3, description: 'sent the plan', durationMs: 120,
  });
  for (const k of ['at', 'type', 'source', 'status', 'label', 'description', 'durationMs', 'iteration']) {
    assert.ok(k in e, `missing ${k}`);
  }
  // null, not undefined: undefined vanishes through JSON.stringify, and an
  // exported log missing the key is indistinguishable from one never measured.
  const bare = makeEvent('state-saved');
  assert.equal(bare.durationMs, null);
  assert.equal(bare.iteration, null);
  assert.equal(JSON.parse(JSON.stringify(bare)).durationMs, null);
});

test('event ids are unique AND sortable, because a replay needs a total order', () => {
  /*
   * Date.now() is not a total order — last session's sample log had nineteen
   * events sharing one millisecond. A UUID is unique but unordered.
   */
  const next = makeSequencer('sess');
  const ids = Array.from({ length: 1500 }, next);
  assert.equal(new Set(ids).size, 1500, 'ids must be unique');
  assert.deepEqual([...ids].sort(), ids, 'lexical sort must equal emission order');
});

test('session ids do not collide for runs started in the same minute', () => {
  const a = makeSessionId(Date.now(), () => 0.1);
  const b = makeSessionId(Date.now(), () => 0.9);
  assert.notEqual(a, b);
});

/* ----------------------------------------------------------------- logger */

test('the durable sink receives every event, even past the live limit', async () => {
  /*
   * THE TWO-TIER GUARANTEE. The view is bounded; the record is not.
   */
  const sink = new MemoryLogSink();
  const log = new Logger({ sink, liveLimit: 50, flushEvery: 10 });

  for (let i = 0; i < 1000; i++) log.log('scrolled', { description: `scroll ${i}` });
  await log.flush();

  assert.equal(sink.size, 1000, 'the record keeps everything');
  assert.equal(log.live.length, 50, 'the view stays bounded');
  const all = await log.all();
  assert.equal(all.length, 1000);
  assert.equal(all[0].description, 'scroll 0', 'the first event survives in the record');
});

test('the live VIEW reports what it is not showing — dropping is never silent', () => {
  const log = new Logger({ liveLimit: 10 });
  for (let i = 0; i < 100; i++) log.log('scrolled');
  assert.equal(log.live.length, 10);
  assert.equal(log.notShown, 90, 'the UI must be able to say "90 earlier events"');
});

test('a FAILING sink retains events for retry instead of dropping them', async () => {
  /*
   * The likeliest cause of a storage failure is a quota exhausted by a very
   * long run — i.e. the run with the most to lose. Dropping here would be the
   * exact silent discard the requirement forbids.
   */
  const sink = new FlakyLogSink({ failFor: 2 });
  const log = new Logger({ sink, flushEvery: 1000 });

  log.log('state-saved');
  log.log('state-saved');
  const first = await log.flush();
  assert.equal(first.written, 0);
  assert.equal(log.pending.length, 2, 'events are kept, not discarded');
  assert.equal(log.sinkFailures.length, 1, 'and the failure is recorded');

  await log.flush();               // second failure
  const third = await log.flush(); // now succeeds
  assert.equal(third.written, 2);
  assert.equal(sink.size, 2, 'nothing was lost across two failures');
});

test('a throwing UI subscriber cannot lose an event', () => {
  const sink = new MemoryLogSink();
  const log = new Logger({ sink, flushEvery: 1, onEvent: () => { throw new Error('panel exploded'); } });
  const e = log.log('state-saved');
  assert.ok(e.id);
  assert.equal(log.counts['state-saved'], 1);
  assert.equal(log.sinkFailures[0].where, 'onEvent');
});

test('begin() logs the wait immediately, so nothing waits unexplained', () => {
  /*
   * If "waiting for AI response" were logged only on completion, the Activity
   * Log would sit motionless for the several minutes an AI takes — exactly
   * when the user suspects a hang.
   */
  const log = new Logger();
  const done = log.begin('awaiting-response', { source: 'arena', iteration: 4, description: 'running the suite' });

  assert.equal(log.live.length, 1);
  assert.equal(log.live[0].status, 'pending');
  assert.equal(log.openEvents().length, 1);

  const closed = done('response-received', { source: 'arena', data: { length: 900 } });
  assert.equal(closed.status, 'success');
  assert.ok(Number.isFinite(closed.durationMs), 'the close event is stamped with a duration');
  assert.equal(closed.correlationId, log.live[0].id, 'closed events point back at the wait');
  assert.equal(log.openEvents().length, 0);
});

test('filters work on channel, source, status and free text', () => {
  const log = new Logger();
  log.log('prompt-submitted', { source: 'extension', description: 'plan for the CSV exporter' });
  log.log('build-failed', { source: 'arena', status: 'error', description: 'tsc exited 2' });
  log.log('review-complete', { source: 'deepseek' });

  assert.equal(log.view({ channels: ['error'] }).length, 1);
  assert.equal(log.view({ sources: ['deepseek'] }).length, 1);
  assert.equal(log.view({ statuses: ['error'] })[0].type, 'build-failed');
  assert.equal(log.view({ search: 'CSV' }).length, 1);
  assert.equal(log.view({ search: 'nothing here' }).length, 0);
});

/* ---------------------------------------------------------------- exports */

test('NDJSON export survives truncation; CSV escapes commas and quotes', async () => {
  const log = new Logger({ sink: new MemoryLogSink(), flushEvery: 1 });
  log.log('error', { status: 'error', description: 'boom, with a comma and a "quote"' });
  log.log('state-saved');
  const all = await log.all();

  const nd = toNdjson(all);
  assert.equal(nd.trim().split('\n').length, 2);
  // A truncated NDJSON still yields every complete line.
  const truncated = nd.slice(0, nd.length - 12).split('\n').filter((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  });
  assert.ok(truncated.length >= 1, 'a partial NDJSON is still partially readable');

  const csv = toCsv(all);
  const header = csv.split('\n')[0];
  assert.match(header, /^id,at,iso,type/);
  assert.match(csv, /"boom, with a comma and a ""quote"""/);
});

/* ---------------------------------------------------------------- summary */

test('the session summary is DERIVED from events, so it cannot drift', () => {
  /*
   * Counters incremented as things happen are a second source of truth, and
   * the summary is the one the user reads and believes. Deriving means the
   * summary can only be wrong if the log is.
   */
  const log = new Logger();
  log.log('iteration-started', { iteration: 1 });
  log.log('prompt-submitted', { iteration: 1 });
  log.log('prompt-submitted', { iteration: 1 });
  log.log('response-received', { iteration: 1, durationMs: 4000, data: { length: 1200 } });
  log.log('file-downloaded', { iteration: 1 });
  log.log('file-uploaded', { iteration: 1 });
  log.log('build-failed', { iteration: 1, status: 'error', source: 'arena' });
  log.log('strategy-changed', { iteration: 1 });
  log.log('step-skipped', { iteration: 1, status: 'warning' });
  log.log('iteration-finished', { iteration: 1 });

  const s = summarise(log.live, {
    status: 'stopped',
    stopReason: 'target-reached',
    history: [{ n: 1, overall: 82 }],
    scores: [{ scores: [
      { dimension: 'testing', score: 95, confidence: 'measured' },
      { dimension: 'uiux', score: 60, confidence: 'asserted' },
    ] }],
  });

  assert.equal(s.iterations, 1);
  assert.equal(s.promptsSent, 2);
  assert.equal(s.responsesReceived, 1);
  assert.equal(s.responseChars, 1200);
  assert.equal(s.filesDownloaded, 1);
  assert.equal(s.filesUploaded, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.errorsByComponent.arena, 1);
  assert.equal(s.strategyChanges, 1);
  assert.equal(s.stepsSkipped, 1);
  assert.equal(s.completion, 82);
  assert.equal(s.totalWaitMs, 4000);
  assert.equal(s.stopReason, 'target-reached');
});

test('the summary reports health WITH how much of it was measured', () => {
  /*
   * "82%" alone, with six of nine dimensions being the model's opinion, is the
   * flattery scoring.js exists to prevent. The caveat travels with the number.
   */
  const s = summarise([], {
    history: [{ overall: 82 }],
    scores: [{ scores: [
      { dimension: 'testing', confidence: 'measured' },
      { dimension: 'uiux', confidence: 'asserted' },
      { dimension: 'security', confidence: 'asserted' },
    ] }],
  });
  assert.equal(s.completion, 82);
  assert.equal(s.measuredDimensions, 1);
  assert.equal(s.totalDimensions, 3);
});

test('the summary counts events the view dropped and steps still in flight', () => {
  const log = new Logger({ liveLimit: 5 });
  for (let i = 0; i < 20; i++) log.log('scrolled');
  log.begin('awaiting-response', { source: 'arena' });

  const s = summarise(log.live, null, {
    notShown: log.notShown,
    openEvents: log.openEvents().length,
    sinkFailures: log.sinkFailures,
  });
  assert.ok(s.droppedFromView > 0, 'the summary admits the view was truncated');
  assert.equal(s.openEvents, 1, 'a step that never closed is visible, not hidden');
});

test('formatDuration matches the spec example format', () => {
  assert.equal(formatDuration(522000), '08:42');
  assert.equal(formatDuration(4122000), '1:08:42');
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(NaN), '--:--');
});

/* -------------------------------------------------------------- workflow  */

test('the workflow stages match the diagram in the specification', () => {
  assert.deepEqual(
    WORKFLOW_STAGES.map((s) => s.key),
    ['scope', 'plan', 'execute', 'evidence', 'evaluate', 'review', 'next'],
  );
});
