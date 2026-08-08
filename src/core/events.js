/**
 * THE EVENT TAXONOMY.
 *
 * WHY AN ENUMERATION AND NOT FREE-FORM STRINGS
 * --------------------------------------------
 * The requirement is that the user can always answer "what is it doing, why,
 * what happened before, what happens next". Free-form event names answer the
 * first question and quietly destroy the other three: `'prompt sent'` and
 * `'prompt-sent'` and `'Prompt submitted'` are three different events to a
 * filter, so the Activity Log's "show me every prompt" checkbox misses two
 * thirds of them and nobody notices, because the log still looks full.
 *
 * A closed vocabulary also makes the log REPLAYABLE, which is the stated goal
 * of the unique event id. You cannot replay a workflow whose steps are prose.
 *
 * Unknown types are rejected at construction (see `makeEvent`), for the same
 * reason `makeEvidence` rejects unknown evidence kinds: a typo that silently
 * becomes an unfilterable event is exactly the class of bug this project
 * spends its effort preventing.
 *
 * NO IMPORTS. Bottom of the graph, like types.js.
 */

/* ========================================================================== *
 * WHO DID IT
 * ========================================================================== */

/**
 * The source of an event.
 *
 * `user` is separate from `extension` deliberately. "The user pressed Pause"
 * and "the orchestrator paused itself" are the same state change with
 * completely different meanings, and a log that conflates them cannot answer
 * "why is it doing this?" -- which is one of the five questions.
 */
export const SOURCES = /** @type {const} */ ([
  'user',       // a human pressed something
  'extension',  // the orchestrator itself
  'chatgpt',    // the manager
  'arena',      // the engineer
  'deepseek',   // the reviewer
  'system',     // storage, crash recovery, configuration
]);

export const STATUSES = /** @type {const} */ (['success', 'warning', 'error', 'pending']);

/**
 * `pending` is not in the specification's list and is load-bearing anyway.
 *
 * "Waiting for AI response" is an event that has STARTED and has no outcome
 * yet. Without a pending status it must either be logged when it begins (and
 * then lie about being a success) or logged when it ends (in which case the
 * log shows nothing at all during the five minutes the user is staring at it
 * wondering if the thing has crashed). "No unexplained waiting" requires a
 * status that means "in flight".
 */

/* ========================================================================== *
 * WHAT HAPPENED
 * ========================================================================== */

/**
 * Every event type the system can emit, grouped by the requirement that asked
 * for it. `channel` drives the Activity Log's filters; `phase` marks the ones
 * that advance the visual workflow.
 */
export const EVENT_TYPES = /** @type {const} */ ({
  /* -- lifecycle ------------------------------------------------------- */
  'extension-started': { channel: 'lifecycle', source: 'extension', label: 'Extension started' },
  'project-loaded': { channel: 'lifecycle', source: 'extension', label: 'Project loaded' },
  'config-loaded': { channel: 'system', source: 'system', label: 'Configuration loaded' },
  'workflow-started': { channel: 'lifecycle', source: 'extension', label: 'Workflow started' },
  'workflow-paused': { channel: 'lifecycle', source: 'user', label: 'Workflow paused' },
  'workflow-resumed': { channel: 'lifecycle', source: 'user', label: 'Workflow resumed' },
  'workflow-stopped': { channel: 'lifecycle', source: 'user', label: 'Workflow stopped' },
  'workflow-completed': { channel: 'lifecycle', source: 'extension', label: 'Workflow completed' },
  'workflow-blocked': { channel: 'lifecycle', source: 'extension', label: 'Workflow blocked' },
  'session-ended': { channel: 'system', source: 'system', label: 'Session ended' },

  /* -- user control ---------------------------------------------------- */
  'user-action': { channel: 'user', source: 'user', label: 'User action' },
  'button-clicked': { channel: 'user', source: 'user', label: 'Button clicked' },
  'shortcut-pressed': { channel: 'user', source: 'user', label: 'Keyboard shortcut' },
  'settings-changed': { channel: 'user', source: 'user', label: 'Settings changed' },
  'step-skipped': { channel: 'user', source: 'user', label: 'Step skipped' },
  'step-retried': { channel: 'user', source: 'user', label: 'Step retried' },

  /* -- browser automation ---------------------------------------------- */
  'tab-focused': { channel: 'automation', source: 'extension', label: 'Switched tab' },
  'prompt-copied': { channel: 'automation', source: 'extension', label: 'Prompt copied' },
  'prompt-pasted': { channel: 'automation', source: 'extension', label: 'Prompt pasted' },
  'prompt-submitted': { channel: 'automation', source: 'extension', label: 'Prompt submitted' },
  'awaiting-response': { channel: 'automation', source: 'extension', label: 'Waiting for AI response' },
  'response-received': { channel: 'automation', source: 'extension', label: 'Response received' },
  'file-downloaded': { channel: 'automation', source: 'extension', label: 'File downloaded' },
  'file-uploaded': { channel: 'automation', source: 'extension', label: 'File uploaded' },
  'scrolled': { channel: 'automation', source: 'extension', label: 'Scrolled' },

  /* -- AI interaction --------------------------------------------------- */
  'planning-started': { channel: 'ai', source: 'chatgpt', label: 'ChatGPT planning started', phase: 'plan' },
  'planning-complete': { channel: 'ai', source: 'chatgpt', label: 'Objective decided', phase: 'plan' },
  'task-started': { channel: 'ai', source: 'arena', label: 'Arena task started', phase: 'execute' },
  'task-complete': { channel: 'ai', source: 'arena', label: 'Arena task completed', phase: 'execute' },
  'evidence-collected': { channel: 'ai', source: 'extension', label: 'Evidence collected', phase: 'evidence' },
  'evaluation-started': { channel: 'ai', source: 'chatgpt', label: 'ChatGPT evaluation started', phase: 'evaluate' },
  'evaluation-complete': { channel: 'ai', source: 'chatgpt', label: 'ChatGPT evaluation complete', phase: 'evaluate' },
  'review-started': { channel: 'ai', source: 'deepseek', label: 'DeepSeek strategy review started', phase: 'review' },
  'review-complete': { channel: 'ai', source: 'deepseek', label: 'DeepSeek recommendation received', phase: 'review' },
  'strategy-changed': { channel: 'ai', source: 'deepseek', label: 'Strategy changed' },
  'stagnation-detected': { channel: 'ai', source: 'extension', label: 'Loop detected' },

  /* -- iteration -------------------------------------------------------- */
  'iteration-started': { channel: 'lifecycle', source: 'extension', label: 'Iteration started' },
  'iteration-finished': { channel: 'lifecycle', source: 'extension', label: 'Iteration finished' },
  'iteration-failed': { channel: 'error', source: 'extension', label: 'Iteration failed' },
  'git-commit-detected': { channel: 'evidence', source: 'arena', label: 'Git commit detected' },
  'build-failed': { channel: 'error', source: 'arena', label: 'Build failed' },

  /* -- system ----------------------------------------------------------- */
  'state-saved': { channel: 'system', source: 'system', label: 'State saved' },
  'state-restored': { channel: 'system', source: 'system', label: 'State restored' },
  'crash-recovered': { channel: 'system', source: 'system', label: 'Recovered from crash' },
  'log-exported': { channel: 'system', source: 'user', label: 'Logs exported' },

  /* -- trouble ---------------------------------------------------------- */
  'error': { channel: 'error', source: 'extension', label: 'Error detected' },
  /*
   * A scan is `evidence`, not `error`. It is not itself a failure -- it is the
   * page state captured because one happened, and filing it under `error`
   * would double every failure in the Errors tab and in the error count.
   */
  'surface-scan': { channel: 'evidence', source: 'extension', label: 'Page captured' },
  'surface-scan-failed': { channel: 'evidence', source: 'extension', label: 'Page capture failed' },
  'response-timeout': { channel: 'error', source: 'extension', label: 'AI response timed out' },
  'environment-drift': { channel: 'error', source: 'extension', label: 'Environment changed' },
  'awaiting-user': { channel: 'error', source: 'extension', label: 'Waiting for you' },
});

export const EVENT_TYPE_KEYS = Object.keys(EVENT_TYPES);

export const CHANNELS = /** @type {const} */ ([
  'lifecycle', 'user', 'automation', 'ai', 'evidence', 'system', 'error',
]);

/* ========================================================================== *
 * THE VISUAL WORKFLOW
 * ========================================================================== */

/**
 * The stages shown in the workflow diagram, in order.
 *
 * `evidence` is a stage of its own even though the engine folds it into
 * `execute`. That is a deliberate divergence: the specification draws it as a
 * separate box, and it is genuinely the step users most want to watch --
 * "Evidence Collection" is where the scores stop being opinions. Collapsing it
 * into "Arena Coding" would hide the moment that matters.
 */
export const WORKFLOW_STAGES = /** @type {const} */ ([
  { key: 'scope', label: 'Project Scope', source: 'user' },
  { key: 'plan', label: 'ChatGPT Planning', source: 'chatgpt' },
  { key: 'execute', label: 'Arena Coding', source: 'arena' },
  { key: 'evidence', label: 'Evidence Collection', source: 'extension' },
  { key: 'evaluate', label: 'ChatGPT Review', source: 'chatgpt' },
  { key: 'review', label: 'DeepSeek Strategy Review', source: 'deepseek' },
  { key: 'next', label: 'Next Iteration', source: 'extension' },
]);

/* ========================================================================== *
 * CONSTRUCTION
 * ========================================================================== */

/**
 * Monotonic sequence, per session.
 *
 * WHY A COUNTER AND NOT A TIMESTAMP OR A UUID.
 *
 * The requirement is that an entire workflow can be replayed or audited. That
 * needs a TOTAL ORDER. `Date.now()` does not provide one -- events inside a
 * synchronous phase routinely share a millisecond, and the sample log from
 * last session showed nineteen events all at `+0.0s`. A UUID is unique but
 * unordered, so a replay would have to trust array position, which is exactly
 * what gets lost when a log is exported, filtered and re-imported.
 *
 * `evt-<session>-<seq>` is unique, sortable, and readable in a bug report.
 */
export function makeSequencer(sessionId) {
  let seq = 0;
  return () => `evt-${sessionId}-${String(++seq).padStart(6, '0')}`;
}

/** A short, human-typable session id. Not a security token. */
export function makeSessionId(now = Date.now(), rand = Math.random) {
  const t = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${t}-${Math.floor(rand() * 46656).toString(36).padStart(3, '0')}`;
}

/**
 * Build a validated log entry.
 *
 * Every field the specification lists is present or explicitly null. `null` is
 * chosen over `undefined` because `undefined` disappears through
 * `JSON.stringify`, and an exported log that is missing the `duration` key
 * entirely is indistinguishable from one where the duration was never
 * measured.
 */
export function makeEvent(type, fields = {}) {
  const spec = EVENT_TYPES[type];
  if (!spec) throw new TypeError(`unknown event type: ${type}`);

  const source = fields.source ?? spec.source;
  if (!SOURCES.includes(source)) throw new TypeError(`unknown source: ${source}`);

  const status = fields.status ?? 'success';
  if (!STATUSES.includes(status)) throw new TypeError(`unknown status: ${status}`);

  return {
    id: fields.id ?? null,          // filled by the Logger, which owns the sequence
    at: fields.at ?? Date.now(),
    type,
    channel: spec.channel,
    source,
    status,
    label: spec.label,
    description: fields.description ?? '',
    /** ms. Null when the event is instantaneous or still running. */
    durationMs: fields.durationMs ?? null,
    iteration: fields.iteration ?? null,
    phase: fields.phase ?? spec.phase ?? null,
    /** Anything type-specific. Rendered as key=value in the log. */
    data: fields.data ?? {},
    /** Set for `pending` events that a later event closes. */
    correlationId: fields.correlationId ?? null,
  };
}
