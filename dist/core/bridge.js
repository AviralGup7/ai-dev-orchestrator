/**
 * FROM ENGINE EVENTS TO LOG ENTRIES.
 *
 * The orchestrator emits terse internal events (`planned`, `executed`). The
 * Activity Log needs the specification's vocabulary, with a source, a status,
 * a duration and a human description.
 *
 * WHY A TRANSLATION LAYER RATHER THAN CHANGING THE ENGINE'S EVENTS
 * ---------------------------------------------------------------
 * Two reasons, and the second is the real one.
 *
 * 1. The engine's events are an API the tests depend on. Renaming them to suit
 *    a UI couples the state machine to a panel.
 * 2. More importantly: the log needs events the engine does not have and
 *    should not have. "Prompt pasted" and "Waiting for AI response" happen
 *    inside an ADAPTER, not in the loop. If the engine emitted them it would
 *    have to know that a prompt is a thing that gets pasted -- which is
 *    knowledge about browsers, in the one module that is contractually
 *    forbidden from having any.
 *
 * So the engine reports what it decided; the adapters report what they did;
 * both funnel into one Logger and one ordered stream.
 *
 * PURE.
 */

/**
 * Engine event -> log event type. `null` means "not user-facing".
 *
 * `iteration-started` and `iteration-finished` pass through because the log's
 * vocabulary has them too; the rest are renamed to the specification's words.
 */
const MAP = {
  'run-started': 'workflow-started',
  'run-stopped': 'workflow-completed',
  'run-paused': 'workflow-paused',
  'run-blocked': 'workflow-blocked',
  'iteration-started': 'iteration-started',
  'iteration-finished': 'iteration-finished',
  'iteration-failed': 'iteration-failed',
  'iteration-blocked': null,        // covered by run-blocked; would duplicate
  planned: 'planning-complete',
  executed: 'task-complete',
  evaluated: 'evaluation-complete',
  reviewed: 'review-complete',
  'strategy-changed': 'strategy-changed',
  'stagnation-detected': 'stagnation-detected',
  'environment-drift': 'environment-drift',
  'environment-unblocked': 'workflow-resumed',
  'workflow-paused': 'workflow-paused',
  'workflow-resumed': 'workflow-resumed',
  'step-skipped': 'step-skipped',
  'step-retried': 'step-retried',
  'step-skip-requested': 'user-action',
  'step-retry-requested': 'user-action',
};

/** Which engine events are failures. Everything else defaults to success. */
const ERRORS = new Set(['iteration-failed', 'environment-drift', 'run-blocked']);
const WARNINGS = new Set(['stagnation-detected', 'step-skipped', 'step-retried']);

/**
* Human descriptions. Named `describeLogEvent`, not `describe`: `environment.js`
 * already exports a `describe`, and the demo bundler concatenates modules into
 * one scope, where two `describe` declarations are a hard SyntaxError. Caught
 * by `node --check` on the bundle, not by the test suite -- ES modules scope
 * per file, so both names coexist happily until they do not. Written as sentences a non-author can act on, because
 * "the user should understand why it happened" is the actual requirement --
 * `executed files=4` satisfies a logger, not a person.
 */
function describeLogEvent(type, e) {
  switch (type) {
    case 'workflow-started':
      return `Run started${e.scope ? ` — scope: ${e.scope}` : ''}`;
    case 'workflow-completed':
      return e.why || e.reason || 'Run ended';
    case 'workflow-blocked':
      return e.detail || 'The prepared environment changed; waiting for you';
    case 'iteration-started':
      return `Iteration ${e.n} began`;
    case 'iteration-finished':
      return `Iteration ${e.n} finished at ${e.overall ?? '—'}% overall`;
    case 'iteration-failed':
      return `Iteration ${e.n} failed: ${e.error}`;
    case 'planning-complete':
      return e.objective ? `Objective: ${e.objective}` : 'Objective decided';
    case 'task-complete':
      return `${e.files ?? 0} file(s) changed; evidence: ${(e.evidence || []).join(', ') || 'none'}`;
    case 'evaluation-complete':
      return `Scored ${e.overall}% overall (${e.confidence} confidence)`;
    case 'review-complete':
      return `Recommendation: ${e.recommendation ?? 'none'}`;
    case 'strategy-changed':
      return `New direction: ${e.direction}`;
    case 'stagnation-detected':
      return `Loop signals: ${(e.signals || []).map((s) => s.kind ?? s).join(', ')}`;
    case 'environment-drift':
      return e.detail || 'The environment no longer matches what was bound';
    case 'step-skipped':
      return `You skipped the ${e.phase} phase of iteration ${e.n} — its scores cannot end the run`;
    case 'step-retried':
      return `Retried the ${e.phase} phase after: ${e.after}`;
    case 'user-action':
      return e.type === 'step-skip-requested'
        ? 'Skip requested — the next step will be skipped'
        : 'Retry requested — the next failure will be retried once';
    default:
      return '';
  }
}

/**
 * Wire an Orchestrator's `onEvent` into a Logger.
 *
 * @param {object} logger
 * @returns {(e:object)=>void} pass as `onEvent`
 */
export function bridgeToLogger(logger) {
  return (e) => {
    const type = MAP[e.type];
    /*
     * AN UNMAPPED EVENT IS LOGGED, NOT DROPPED.
     *
     * "The log must never silently discard events." A future engine event with
     * no mapping would otherwise vanish -- and it would vanish quietly, during
     * the exact refactor that introduced it. Logging it as a generic
     * `user-action`-shaped entry is ugly on screen and correct in substance:
     * the gap is visible and someone fixes the mapping.
     */
    if (type === undefined) {
      logger.log('error', {
        status: 'warning',
        description: `Unmapped engine event "${e.type}" — the log vocabulary is out of date`,
        iteration: e.iteration ?? null,
        data: e,
      });
      return;
    }
    if (type === null) return; // deliberately not surfaced; documented above

    logger.log(type, {
      at: e.at,
      iteration: e.iteration ?? null,
      status: ERRORS.has(e.type) ? 'error' : WARNINGS.has(e.type) ? 'warning' : 'success',
      description: describeLogEvent(type, e),
      data: strip(e),
    });
  };
}

/** Drop fields already represented as columns, so `data` is the extras only. */
function strip(e) {
  const { type, at, iteration, ...rest } = e;
  return rest;
}
