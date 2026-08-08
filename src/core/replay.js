/**
 * REPLAY — reconstruct a past run from its event log.
 *
 * §24 asks that a previous run stay inspectable after the browser session ends,
 * and that replay be deterministic and contact no AI service.
 *
 * WHY REPLAY IS MORE THAN A LOG VIEWER
 * ------------------------------------
 * The Activity Log shows what happened in order. Replay answers a different
 * question: what did the SYSTEM BELIEVE at each point? "Why did it stop at
 * iteration 12?" is usually answered by state that existed at iteration 9 --
 * a score that plateaued, a signal that fired -- and reading that off a flat
 * event stream means holding the whole model in your head.
 *
 * So replay folds the events back into successive states, and you can step.
 *
 * IT IS ALSO THE VERIFICATION THAT THE LOG IS COMPLETE. If a state
 * reconstructed from events disagrees with the state that was persisted, then
 * something happened that was never logged -- which is a bug in the logging,
 * and one that is otherwise invisible.
 *
 * PURE.
 */

/** Fold one event into a state. Returns a NEW state; never mutates. */
export function apply(state, event) {
  const s = {
    ...state,
    iterations: state.iterations.map((i) => ({ ...i })),
    events: state.events + 1,
    at: event.at ?? state.at,
  };

  const current = () => s.iterations.find((i) => i.n === s.iteration) ?? null;
  const ensure = (n) => {
    let it = s.iterations.find((i) => i.n === n);
    if (!it) { it = { n, objective: null, evidence: [], scores: [], overall: null, signals: [], phases: [] }; s.iterations.push(it); }
    return it;
  };

  switch (event.type) {
    case 'run-started':
    case 'workflow-started':
      s.status = 'running';
      s.startedAt = event.at;
      break;

    case 'iteration-started':
      s.iteration = event.n ?? event.iteration ?? s.iteration + 1;
      ensure(s.iteration);
      break;

    case 'phase-started':
      s.phase = event.phase;
      if (event.iteration) ensure(event.iteration).phases.push(event.phase);
      break;

    case 'planned':
    case 'planning-complete': {
      const it = ensure(event.iteration ?? s.iteration);
      it.objective = event.objective ?? event.data?.objective ?? it.objective;
      break;
    }

    case 'evidence-captured': {
      const it = ensure(event.iteration ?? s.iteration);
      it.evidence = (event.kinds ?? []).map((kind) => ({ kind }));
      break;
    }

    case 'evaluated':
    case 'evaluation-complete': {
      const it = ensure(event.iteration ?? s.iteration);
      const prev = s.overall;
      it.overall = event.overall ?? it.overall;
      s.overall = it.overall ?? s.overall;
      s.confidence = event.confidence ?? s.confidence;
      /*
       * Score CHANGES are recorded as their own fact, not left to be derived
       * by the reader. "78 → 82" is the single most-asked question of a log,
       * and computing it at read time means every consumer reimplements it.
       */
      if (Number.isFinite(prev) && Number.isFinite(s.overall) && prev !== s.overall) {
        s.scoreChanges.push({ at: event.at, iteration: it.n, from: prev, to: s.overall });
      }
      break;
    }

    case 'stagnation-detected': {
      const it = ensure(event.iteration ?? s.iteration);
      it.signals = event.signals ?? [];
      s.stagnating = true;
      break;
    }

    case 'strategy-changed':
      s.strategyChanges.push({ at: event.at, iteration: event.iteration, direction: event.direction });
      s.stagnating = false;
      break;

    case 'iteration-finished': {
      const n = event.n ?? event.iteration ?? s.iteration;
      const it = ensure(n);
      it.finished = true;
      s.completed++;
      /*
       * Advance the cursor here too, not only on `iteration-started`.
       *
       * A run that spans several sessions loses events to eviction -- a worker
       * killed mid-iteration never writes its `iteration-started`. Replaying
       * such a log left `iteration` at 0 while `completed` climbed, so the
       * reconstructed state disagreed with itself. Taking the maximum means a
       * missing start event costs a little detail rather than the whole
       * cursor.
       */
      s.iteration = Math.max(s.iteration, n);
      break;
    }

    case 'run-blocked':
    case 'workflow-blocked':
      s.status = 'blocked';
      s.blockedBecause = event.detail ?? null;
      break;

    case 'workflow-paused':
      s.status = 'paused';
      break;

    case 'run-stopped':
    case 'workflow-completed':
      s.status = 'stopped';
      s.stopReason = event.reason ?? s.stopReason;
      s.stopDetail = event.why ?? event.detail ?? s.stopDetail;
      break;

    case 'run-failed':
    case 'iteration-failed':
      s.status = 'failed';
      s.errors.push({ at: event.at, error: event.error });
      break;

    default:
      if (event.status === 'error') s.errors.push({ at: event.at, type: event.type, error: event.description });
      break;
  }

  if (current()) s.lastObjective = current().objective ?? s.lastObjective;
  return s;
}

export function initialState() {
  return {
    status: 'idle', phase: null, iteration: 0, completed: 0,
    overall: null, confidence: null, lastObjective: null,
    iterations: [], scoreChanges: [], strategyChanges: [], errors: [],
    stagnating: false, blockedBecause: null, stopReason: null, stopDetail: null,
    startedAt: null, at: null, events: 0,
  };
}

/**
 * Replay a whole log.
 *
 * @returns {{final, frames, checkpoints}} `frames` is one state per event.
 */
export function replay(events, { keepFrames = true } = {}) {
  const sorted = [...events].sort(byId);
  let state = initialState();
  const frames = [];
  const checkpoints = [];

  for (const e of sorted) {
    state = apply(state, e);
    if (keepFrames) frames.push({ event: e, state });
    if (e.type === 'iteration-finished') checkpoints.push({ iteration: state.iteration, state });
  }

  return { final: state, frames, checkpoints, count: sorted.length };
}

/**
 * Order by event id, falling back to timestamp.
 *
 * Ids are `evt-<session>-<seq>` and sort correctly WITHIN a session. Across
 * sessions the timestamp decides -- a run spans many sessions, and each starts
 * its sequence at 1, so ids alone would interleave a long run wrongly. This
 * exact class of bug (timestamps not being a total order) was already found
 * once in the error center, in the other direction.
 */
function byId(a, b) {
  const sa = String(a.id ?? '').split('-').slice(0, -1).join('-');
  const sb = String(b.id ?? '').split('-').slice(0, -1).join('-');
  if (sa === sb) return String(a.id).localeCompare(String(b.id));
  return (a.at ?? 0) - (b.at ?? 0);
}

/**
 * Does the replayed state agree with what was persisted?
 *
 * A disagreement means something changed the record without logging it, which
 * is a hole in the audit trail and invisible by any other means.
 */
export function verifyAgainst(record, events) {
  const { final } = replay(events, { keepFrames: false });
  const problems = [];

  const persistedCompleted = (record.iterations ?? []).filter((i) => i.finishedAt).length;
  if (final.completed !== persistedCompleted) {
    problems.push(`the log shows ${final.completed} completed iterations; storage has ${persistedCompleted}`);
  }
  if (record.run?.stopReason && final.stopReason && record.run.stopReason !== final.stopReason) {
    problems.push(`the log says the run stopped for "${final.stopReason}"; storage says "${record.run.stopReason}"`);
  }
  const lastPersisted = (record.iterations ?? []).filter((i) => Number.isFinite(i.overall)).at(-1);
  if (lastPersisted && final.overall != null && lastPersisted.overall !== final.overall) {
    problems.push(`the log ends at ${final.overall}%; storage says ${lastPersisted.overall}%`);
  }

  return { ok: problems.length === 0, problems, replayed: final };
}

/** A human timeline of the decisions, for the iteration-history view. */
export function narrate(events) {
  const { frames } = replay(events);
  const out = [];
  for (const { event, state } of frames) {
    switch (event.type) {
      case 'iteration-started':
        out.push({ at: event.at, iteration: state.iteration, text: `Iteration ${state.iteration} began` });
        break;
      case 'planned':
      case 'planning-complete':
        out.push({ at: event.at, iteration: state.iteration, text: `Objective: ${event.objective ?? '—'}` });
        break;
      case 'evidence-captured':
        out.push({ at: event.at, iteration: state.iteration, text: `Evidence: ${(event.kinds || []).join(', ') || 'none'}` });
        break;
      case 'evaluated':
      case 'evaluation-complete': {
        const change = state.scoreChanges.at(-1);
        out.push({
          at: event.at, iteration: state.iteration,
          text: change && change.at === event.at
            ? `Score ${change.from}% → ${change.to}%`
            : `Scored ${event.overall}%`,
        });
        break;
      }
      case 'stagnation-detected':
        out.push({ at: event.at, iteration: state.iteration, text: `Loop detected: ${(event.signals || []).map((s) => s.kind ?? s).join(', ')}` });
        break;
      case 'strategy-changed':
        out.push({ at: event.at, iteration: state.iteration, text: `Strategy changed: ${event.direction}` });
        break;
      case 'run-stopped':
        out.push({ at: event.at, iteration: state.iteration, text: `Stopped: ${event.why ?? event.reason}` });
        break;
      default:
        break;
    }
  }
  return out;
}
