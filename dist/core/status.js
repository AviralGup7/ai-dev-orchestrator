/**
 * "WHAT IS IT DOING RIGHT NOW, AND WHY?"
 *
 * The five questions the user must always be able to answer are a data
 * problem before they are a UI problem. This module turns memory + the event
 * log into the answers. The side panel renders it; it does not compute it.
 *
 * WHY DERIVED RATHER THAN STORED
 * ------------------------------
 * A `currentStep` field written by each phase is a second source of truth, and
 * the failure mode is specific and nasty: the field is written at the start of
 * a phase and not cleared if the phase throws, so after a crash the panel
 * cheerfully reports "Waiting for Arena response" forever. Deriving it from
 * the last event means the panel cannot claim something the log does not show.
 *
 * PURE.
 */

import { WORKFLOW_STAGES } from './events.js';
import { formatDuration } from './logger.js';

/**
 * Map an in-flight phase onto the visual workflow.
 *
 * `evidence` has no engine phase of its own -- the engineer returns evidence
 * as part of `execute`. It is surfaced separately because the specification
 * draws it separately and because it is the step users most want to watch.
 * The mapping is explicit so the divergence is visible rather than implied.
 */
const PHASE_TO_STAGE = {
  plan: 'plan',
  execute: 'execute',
  evidence: 'evidence',
  evaluate: 'evaluate',
  detect: 'evaluate',   // local analysis; shown as part of review, not its own box
  review: 'review',
  decide: 'next',
};

/**
 * Phases where no AI has the floor.
 *
 * `detect` maps onto the `evaluate` BOX in the diagram (it has no box of its
 * own) but it is pure local arithmetic — no prompt is in flight. Reading the
 * AI off the stage made the panel display "ChatGPT" while the extension was
 * doing loop detection on its own, which is a small lie with a real cost: the
 * user sees ChatGPT named, goes to that tab to see what it is thinking, and
 * finds nothing happening.
 */
const LOCAL_PHASES = new Set(['detect', 'decide']);

/**
 * A human sentence for what is happening, and why.
 *
 * "Why" is not decoration. A user watching "Waiting for Arena response" for
 * four minutes needs to know it is running the test suite for objective 12,
 * not that the extension is stuck. The `why` string is the current objective,
 * because that is the actual answer.
 */
export function currentStep(memory, lastEvent = null) {
  if (!memory) return { text: 'Idle', why: 'no project loaded', source: 'extension' };

  if (memory.status === 'blocked') {
    return {
      text: 'Blocked — waiting for you',
      why: memory.block?.detail || 'the prepared environment changed',
      source: 'extension',
    };
  }
  if (memory.status === 'paused') {
    return { text: 'Paused', why: 'you paused the workflow', source: 'user' };
  }
  if (memory.status === 'stopped') {
    return { text: 'Stopped', why: memory.stopReason || 'a stop condition was met', source: 'extension' };
  }
  if (memory.status === 'failed') {
    return { text: 'Failed', why: 'an unrecoverable error occurred', source: 'extension' };
  }
  if (memory.status === 'idle') {
    return { text: 'Ready', why: 'press Start to begin', source: 'extension' };
  }

  /*
   * A pending event outranks the phase.
   *
   * `memory.phase` says 'execute'; the pending event says "waiting for Arena
   * response, 4m12s". The second is what the user asked to see, and it is the
   * difference between "no unexplained waiting" and a panel that says
   * `execute` for six minutes.
   */
  if (lastEvent?.status === 'pending') {
    return {
      text: lastEvent.label,
      why: lastEvent.description || memory.objective?.text || '',
      source: lastEvent.source,
      since: lastEvent.at,
    };
  }

  const stage = WORKFLOW_STAGES.find((s) => s.key === PHASE_TO_STAGE[memory.phase]);
  return {
    text: stage ? stage.label : memory.phase,
    why: memory.objective?.text || 'deciding the next objective',
    source: stage?.source || 'extension',
  };
}

/** Which AI currently has the floor. `null` when nobody does. */
export function currentAI(memory, lastEvent = null) {
  if (memory?.status !== 'running') return null;
  if (lastEvent?.status === 'pending' && ['chatgpt', 'arena', 'deepseek'].includes(lastEvent.source)) {
    return lastEvent.source;
  }
  if (LOCAL_PHASES.has(memory?.phase)) return null;
  const stage = WORKFLOW_STAGES.find((s) => s.key === PHASE_TO_STAGE[memory?.phase]);
  return ['chatgpt', 'arena', 'deepseek'].includes(stage?.source) ? stage.source : null;
}

/**
 * "What will happen next?" -- the fourth question, and the one most systems
 * never answer.
 *
 * Honest about uncertainty. The next stage after `review` depends on whether a
 * stop condition fires, so it says so rather than promising another iteration
 * the run may never reach.
 */
export function whatNext(memory, config = {}) {
  if (!memory || memory.status === 'idle') return 'Press Start to plan the first objective.';
  if (memory.status === 'blocked') return 'Nothing, until you restore the environment and press Resume.';
  if (memory.status === 'paused') return 'Nothing, until you press Resume.';
  if (memory.status === 'stopped' || memory.status === 'failed') return 'Nothing — this run has ended.';

  const stage = PHASE_TO_STAGE[memory.phase];
  const n = memory.iteration + 1;
  const reviewEvery = config.reviewEvery ?? 5;

  switch (stage) {
    case 'plan':
      return 'Arena will be given the objective and will change code.';
    case 'execute':
      return 'Evidence from the run (tests, build, diff) will be collected.';
    case 'evidence':
      return 'ChatGPT will score the result against that evidence.';
    case 'evaluate': {
      const due = n % reviewEvery === 0;
      const stagnating = memory.flags?.stagnation;
      if (due) return `DeepSeek will review strategy (every ${reviewEvery} iterations).`;
      if (stagnating) return 'DeepSeek review pulled forward — a loop was detected.';
      return `Iteration ${n + 1} will be planned. DeepSeek reviews at iteration ${Math.ceil(n / reviewEvery) * reviewEvery}.`;
    }
    case 'review':
      return 'Stop conditions are checked, then the next iteration is planned.';
    default:
      return `Iteration ${n + 1} will be planned.`;
  }
}

/**
 * The whole Live Status Panel, in one object.
 *
 * @param {object} memory
 * @param {object} [opts] `{ lastEvent, config, startedAt, now, log }`
 */
export function liveStatus(memory, opts = {}) {
  const { lastEvent = null, config = {}, startedAt = null, now = Date.now() } = opts;
  const step = currentStep(memory, lastEvent);
  const max = config.maxIterations ?? 50;
  const last = memory?.history?.[memory.history.length - 1];

  /*
   * Health is reported WITH its confidence, always, as one value.
   *
   * A bare "82%" in a big font is exactly the flattery `scoring.js` spends its
   * effort preventing. If six of nine dimensions are the model's opinion, the
   * panel has to say so in the same glance, or the safeguard is undone by the
   * UI that displays it.
   */
  const scores = memory?.scores?.[memory.scores.length - 1]?.scores || [];
  const measured = scores.filter((s) => s.confidence === 'measured').length;

  return {
    step: step.text,
    why: step.why,
    source: step.source,
    ai: currentAI(memory, lastEvent),
    iteration: memory?.iteration ?? 0,
    maxIterations: max,
    iterationLabel: `${(memory?.iteration ?? 0) + (memory?.status === 'running' ? 1 : 0)} / ${max}`,
    elapsedMs: startedAt ? now - startedAt : 0,
    elapsed: formatDuration(startedAt ? now - startedAt : 0),
    stepElapsed: step.since ? formatDuration(now - step.since) : null,
    health: last?.overall ?? null,
    healthConfidence: last?.confidence ?? null,
    measuredDimensions: measured,
    totalDimensions: scores.length,
    status: memory?.status ?? 'idle',
    next: whatNext(memory, config),
    objective: memory?.objective?.text ?? null,
    stagnating: Boolean(memory?.flags?.stagnation),
    blocked: memory?.status === 'blocked' ? memory.block : null,
  };
}

/**
 * The workflow diagram's state: every stage, marked done / active / pending.
 */
export function workflowState(memory) {
  const activeKey = memory?.status === 'running' ? PHASE_TO_STAGE[memory.phase] : null;
  const order = WORKFLOW_STAGES.map((s) => s.key);
  const activeIndex = activeKey ? order.indexOf(activeKey) : -1;
  const started = (memory?.iteration ?? 0) > 0 || memory?.status === 'running';

  return WORKFLOW_STAGES.map((stage, i) => ({
    ...stage,
    state:
      !started ? 'pending'
        : activeIndex === -1 ? (memory?.status === 'stopped' ? 'done' : 'pending')
          : i < activeIndex ? 'done'
            : i === activeIndex ? 'active'
              : 'pending',
  }));
}

/* ========================================================================== *
 * ERROR CENTER
 * ========================================================================== */

/**
 * Suggested remedies, keyed by event type.
 *
 * "Suggested action" is a requirement, and a generic "try again" would satisfy
 * it in letter only. Each of these is the thing that actually helps, and
 * `environment-drift` deliberately defers to the per-problem remedy computed
 * in environment.js rather than duplicating it -- two copies of advice drift
 * apart and the user gets the stale one.
 */
const SUGGESTIONS = {
  'response-timeout': 'Check the AI tab — the response may still be streaming. Retry the step, or raise the timeout in settings.',
  'build-failed': 'Open the Arena tab and read the build output. The next objective will normally target the failure.',
  'iteration-failed': 'Inspect the technical details below. Retry the step if the cause was transient.',
  'environment-drift': null, // supplied per-problem; see environment.js
  'error': 'Check the technical details. If this repeats, stop the run and export the logs.',
};

/**
 * Everything the Error Center needs, newest first.
 *
 * `resolved` is computed: an error followed by a successful retry of the same
 * phase is no longer outstanding. Without that, the panel accumulates every
 * transient hiccup of a six-hour run and becomes a wall of red the user learns
 * to ignore -- which is how a real failure gets missed.
 */
export function errorCenter(events) {
  const errors = events.filter((e) => e.status === 'error');

  return errors
    .map((e) => {
      /*
       * "LATER" IS DECIDED BY EVENT ID, NOT BY TIMESTAMP.
       *
       * `x.at > e.at` looks obviously right and is wrong: a failure and the
       * retry that fixes it routinely land in the same millisecond, so the
       * strict `>` finds nothing and every resolved error stays red forever.
       *
       * This is the exact scenario the sortable-id design note in events.js
       * described — Date.now() is not a total order — and it still shipped as
       * a bug here, because the ordering problem was solved in one module and
       * then not used in another. Caught by a test, not by reading.
       */
      const laterSuccess = events.find(
        (x) => x.id > e.id && x.status === 'success' && x.phase && x.phase === e.phase,
      );
      return {
        id: e.id,
        at: e.at,
        summary: e.description || e.label,
        component: e.source,
        type: e.type,
        iteration: e.iteration,
        phase: e.phase,
        suggestion:
          e.data?.remedy ||
          SUGGESTIONS[e.type] ||
          'Check the technical details. If this repeats, stop the run and export the logs.',
        details: e.data ?? {},
        retryable: Boolean(e.phase),
        resolved: Boolean(laterSuccess),
        resolvedAt: laterSuccess?.at ?? null,
      };
    })
    .reverse();
}
