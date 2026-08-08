/**
 * THE LOGGING SUBSYSTEM.
 *
 * "Logging is a first-class subsystem" and "the log must never silently
 * discard events" are the two requirements that shape this file, and the
 * second one broke a decision made last session.
 *
 * THE CONTRADICTION, AND HOW IT RESOLVED
 * --------------------------------------
 * `journal.js` caps at 2000 events and drops the middle. That was correct for
 * what the journal is -- a markdown document pasted into a chat window, where
 * exceeding the context window is a real failure. It is wrong as a system of
 * record: a fifty-iteration run logging every tab switch, copy, paste and wait
 * is plausibly tens of thousands of events, and dropping any of them makes
 * "replay the workflow" impossible.
 *
 * So the log is TWO TIERS, and they have different jobs:
 *
 *   TIER 1  this Logger -> a durable append-only sink. Never discards.
 *           Unbounded in principle; the sink decides how to store it.
 *   TIER 2  a bounded in-memory ring the UI renders, plus the markdown
 *           journal for pasting. Both are VIEWS. Both may drop, loudly.
 *
 * The distinction that makes this safe: a view may forget, a record may not.
 * The UI's ring buffer explicitly reports how many events it is not showing,
 * and the full log is one export away.
 *
 * PURE. The sink is injected. This file has never heard of IndexedDB.
 */

import {
  makeEvent,
  makeSequencer,
  makeSessionId,
  EVENT_TYPES,
  CHANNELS,
} from './events.js';

/**
 * @param {object} [options]
 * @param {object} [options.sink]      durable store: `{ append(events), all() }`
 * @param {number} [options.liveLimit] how many events the in-memory view holds
 * @param {(e:object)=>void} [options.onEvent]  live subscriber (the UI)
 * @param {string} [options.sessionId]
 * @param {number} [options.flushEvery] batch size before touching the sink
 */
export class Logger {
  constructor({
    sink = null,
    liveLimit = 500,
    onEvent = () => {},
    sessionId = makeSessionId(),
    flushEvery = 25,
  } = {}) {
    this.sessionId = sessionId;
    this.nextId = makeSequencer(sessionId);
    this.sink = sink;
    this.liveLimit = liveLimit;
    this.onEvent = onEvent;
    this.flushEvery = flushEvery;

    /** The bounded VIEW. Not the record. */
    this.live = [];
    /** How many the view is not showing. Surfaced in the UI, never hidden. */
    this.notShown = 0;
    /** Written but not yet handed to the sink. */
    this.pending = [];
    /** Every event this session, counted by type -- the session summary. */
    this.counts = Object.create(null);
    this.errors = [];
    this.startedAt = Date.now();

    /** Open `pending` events, keyed by correlation id, for duration stamping. */
    this._open = new Map();
    /** Set if the sink ever fails. Reported; never swallowed. */
    this.sinkFailures = [];
  }

  /**
   * Record an event.
   *
   * Synchronous on purpose. Logging must not be awaited at the call site: an
   * `await log(...)` inside a phase means a slow disk write can reorder events
   * relative to the actions they describe, and a log whose order is
   * approximately right is not auditable. The durable write is batched and
   * happens behind the scenes via `flush()`.
   *
   * @returns {object} the stored event, with its id
   */
  log(type, fields = {}) {
    const event = makeEvent(type, fields);
    event.id = this.nextId();

    this.counts[type] = (this.counts[type] || 0) + 1;
    if (event.status === 'error') this.errors.push(event);

    this.pending.push(event);
    this._pushLive(event);

    /*
     * The subscriber is called inside a try. A throwing UI listener must not
     * lose the event -- the log is the system of record and the panel drawing
     * it is not. This is the "no silent failures" rule applied to the logger
     * itself: a broken listener produces a logged error rather than a gap.
     */
    try {
      this.onEvent(event);
    } catch (err) {
      this.sinkFailures.push({ at: Date.now(), where: 'onEvent', error: String(err?.message || err) });
    }

    if (this.pending.length >= this.flushEvery) void this.flush();
    return event;
  }

  /**
   * Start a long-running event: emits `pending`, returns a closer.
   *
   * This is how "no unexplained waiting" is enforced. `awaiting-response` is
   * logged the moment the wait BEGINS, visible immediately, and stamped with
   * its duration when it ends. Logging only on completion would leave the
   * Activity Log motionless for the several minutes an AI takes to answer,
   * which is precisely when the user is most likely to think it has hung.
   *
   * @returns {(closeType:string, closeFields?:object) => object}
   */
  begin(type, fields = {}) {
    const startedAt = Date.now();
    const open = this.log(type, { ...fields, status: 'pending', at: startedAt });
    this._open.set(open.id, open);

    return (closeType, closeFields = {}) => {
      this._open.delete(open.id);
      return this.log(closeType, {
        iteration: open.iteration,
        phase: open.phase,
        ...closeFields,
        durationMs: Date.now() - startedAt,
        correlationId: open.id,
      });
    };
  }

  _pushLive(event) {
    this.live.push(event);
    if (this.live.length > this.liveLimit) {
      const removed = this.live.length - this.liveLimit;
      this.live.splice(0, removed);
      /*
       * The VIEW drops the oldest, and says so. Opposite of the journal, which
       * drops the middle -- because these are different artefacts. The live
       * panel is a window onto a durable log the user can scroll or export;
       * the journal is a standalone document with no backing store, so losing
       * its beginning loses it permanently.
       */
      this.notShown += removed;
    }
  }

  /**
   * Hand pending events to the durable sink.
   *
   * A FAILING SINK IS AN ERROR, NOT A SHRUG.
   *
   * If the write fails the events stay in `pending` and are retried on the
   * next flush, and the failure is recorded. Dropping them here would be the
   * exact "silent discard" the requirement forbids -- and it would happen at
   * the worst time, since the most likely cause of a storage failure is a
   * quota exhausted by a very long run, i.e. the run with the most to lose.
   */
  async flush() {
    if (!this.sink || this.pending.length === 0) return { written: 0 };
    const batch = this.pending;
    this.pending = [];
    try {
      await this.sink.append(batch);
      return { written: batch.length };
    } catch (err) {
      this.pending = [...batch, ...this.pending];
      this.sinkFailures.push({ at: Date.now(), where: 'sink.append', error: String(err?.message || err) });
      return { written: 0, error: String(err?.message || err) };
    }
  }

  /** Live view, newest last, optionally filtered. */
  view({ channels = null, sources = null, statuses = null, search = '' } = {}) {
    const q = search.trim().toLowerCase();
    return this.live.filter((e) => {
      if (channels && !channels.includes(e.channel)) return false;
      if (sources && !sources.includes(e.source)) return false;
      if (statuses && !statuses.includes(e.status)) return false;
      if (q) {
        const hay = `${e.label} ${e.description} ${e.type} ${JSON.stringify(e.data)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /** Everything durable, for export and replay. Falls back to the view. */
  async all() {
    await this.flush();
    if (!this.sink) return [...this.live];
    return this.sink.all();
  }

  /**
   * Unclosed `pending` events.
   *
   * A begin() with no matching close means either the orchestrator is still
   * waiting (fine, and the UI shows a spinner) or it crashed mid-step and the
   * log has a dangling promise in it (not fine, and the session summary should
   * say so). Either way it is visible.
   */
  openEvents() {
    return [...this._open.values()];
  }
}

/* ========================================================================== *
 * SESSION SUMMARY
 * ========================================================================== */

/**
 * Build the end-of-session summary from the log alone.
 *
 * DERIVED, NOT ACCUMULATED, and that is a deliberate anti-drift choice.
 *
 * The tempting design is a set of counters incremented as things happen. Those
 * counters are a SECOND source of truth, and the moment a code path forgets to
 * increment one, the summary and the log disagree -- with the summary being
 * the one the user reads and believes. Deriving everything from the events
 * means the summary cannot be wrong unless the log is, in which case the log
 * is wrong and that is a bigger problem, visibly.
 *
 * It is the same reasoning as `scoring.js`: compute what can be computed
 * rather than asking for a number.
 */
export function summarise(events, memory = null, extra = {}) {
  const count = (t) => events.filter((e) => e.type === t).length;

  const first = events[0];
  const last = events[events.length - 1];
  const elapsedMs = first && last ? last.at - first.at : 0;

  const responses = events.filter((e) => e.type === 'response-received');
  const responseChars = responses.reduce((n, e) => n + (e.data?.length || 0), 0);

  const errors = events.filter((e) => e.status === 'error');
  const byComponent = {};
  for (const e of errors) byComponent[e.source] = (byComponent[e.source] || 0) + 1;

  const durations = events.filter((e) => Number.isFinite(e.durationMs));
  const waitMs = events
    .filter((e) => e.type === 'response-received' && Number.isFinite(e.durationMs))
    .reduce((n, e) => n + e.durationMs, 0);

  const scores = memory?.scores?.[memory.scores.length - 1]?.scores || [];
  const measured = scores.filter((s) => s.confidence === 'measured');

  return {
    sessionId: extra.sessionId ?? null,
    startedAt: first?.at ?? null,
    endedAt: last?.at ?? null,
    elapsedMs,

    iterations: count('iteration-finished'),
    iterationsAttempted: count('iteration-started'),
    promptsSent: count('prompt-submitted'),
    responsesReceived: responses.length,
    responseChars,

    filesUploaded: count('file-uploaded'),
    filesDownloaded: count('file-downloaded'),

    errors: errors.length,
    errorsByComponent: byComponent,
    strategyChanges: count('strategy-changed'),
    stagnationEvents: count('stagnation-detected'),
    stepsSkipped: count('step-skipped'),
    stepsRetried: count('step-retried'),

    /*
     * Reported as a fraction, not a percentage, and next to the total.
     *
     * "82% health" with no indication that six of nine dimensions are the
     * model's opinion is the flattery this project exists to prevent. The
     * summary carries the caveat with the number so they cannot be separated
     * by a screenshot.
     */
    completion: memory?.history?.[memory.history.length - 1]?.overall ?? null,
    measuredDimensions: measured.length,
    totalDimensions: scores.length,

    totalEvents: events.length,
    eventsWithDuration: durations.length,
    totalWaitMs: waitMs,
    openEvents: extra.openEvents ?? 0,
    droppedFromView: extra.notShown ?? 0,
    sinkFailures: extra.sinkFailures ?? [],

    status: memory?.status ?? null,
    stopReason: memory?.stopReason ?? null,
  };
}

/** Human-readable duration. `08:42`, or `1:08:42` past an hour. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export { EVENT_TYPES, CHANNELS };
