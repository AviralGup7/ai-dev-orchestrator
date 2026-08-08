/**
 * VALIDATION BEFORE THE FIRST PROMPT.
 *
 * "Before sending the first prompt, verify: ChatGPT tab exists, Arena AI tab
 * exists, DeepSeek tab exists (if enabled), Arena workspace is open, required
 * conversations are available, logger is running, state storage initialised.
 * If validation fails, stop and notify the user. Never create new tabs or new
 * chats automatically."
 *
 * WHY THIS IS NOT JUST `environment.bind()`
 * -----------------------------------------
 * `bind()` already answers the tab questions, and re-implementing them here
 * would produce two checklists that drift apart — with the user seeing
 * whichever one happened to run. So preflight DELEGATES the environment half
 * and adds only what bind() cannot know: is the logger writing, is storage
 * readable and writable, does the chosen mode have what it needs.
 *
 * The storage checks are the interesting additions. A run that starts with a
 * broken store looks completely healthy for one iteration and then loses
 * everything on the first service-worker eviction — and the log, which is the
 * thing that would explain it, is the other thing that failed.
 *
 * PURE. Probes are injected.
 */

import { bind, EnvironmentError, describe as describeDrift } from './environment.js';
import { getMode, validateSetup } from './modes.js';

/**
 * One row of the checklist the UI renders.
 *
 * `blocking` separates "this must be fixed before starting" from "you should
 * know this". The distinction was implied by the wording of the remedies and
 * not implemented: the durable-log check told the user "the run can proceed"
 * and then set `ok:false`, which stopped the run. A checklist that contradicts
 * its own advice trains people to ignore it.
 *
 * Blocking by default -- a new check that forgot to say should stop the run
 * rather than be quietly waved through.
 */
function check(key, label, ok, detail = '', remedy = '', blocking = true) {
  return { key, label, ok, detail, remedy, blocking };
}

/**
 * Run every pre-start check.
 *
 * @param {object} args
 * @param {object} args.setup        `{ mode, projectName, prompt }`
 * @param {object} args.snapshot     environment snapshot from a transport
 * @param {object} [args.hosts]      expected hosts per surface
 * @param {boolean} [args.reviewerEnabled]
 * @param {object} [args.logger]
 * @param {object} [args.store]
 * @returns {Promise<{ok, checks, binding, problems}>}
 */
export async function preflight({
  setup,
  snapshot,
  hosts = {},
  reviewerEnabled = false,
  logger = null,
  store = null,
}) {
  const checks = [];
  let binding = null;

  /* -- 1. the user's own input ------------------------------------------- */
  const setupResult = validateSetup(setup || {});
  checks.push(
    check(
      'setup',
      'Project details are complete',
      setupResult.ok,
      setupResult.problems.map((p) => p.message).join(' '),
      'Fill in the missing field on the landing screen.',
    ),
  );

  /* -- 2. tabs and conversations, via the existing contract --------------- */
  const required = reviewerEnabled ? ['manager', 'engineer', 'reviewer'] : ['manager', 'engineer'];
  try {
    binding = bind(snapshot, { require: required, hosts });
    for (const key of required) {
      const s = binding.surfaces[key];
      checks.push(check(`tab-${key}`, labelFor(key), true, `tab ${s.tabId} · ${s.host} · ${s.conversationId}`));
    }
    if (!reviewerEnabled) {
      checks.push(check('tab-reviewer', 'DeepSeek (optional)', true, 'not enabled — strategy review will be skipped'));
    }
  } catch (err) {
    if (!(err instanceof EnvironmentError)) throw err;
    const bySurface = new Map(err.problems.map((p) => [p.surface, p]));
    for (const key of required) {
      const p = bySurface.get(key);
      checks.push(check(`tab-${key}`, labelFor(key), !p, p?.detail || 'ok', p?.remedy || ''));
    }
    /*
     * Problems on surfaces we did not require are still reported. A DeepSeek
     * tab sitting on the wrong conversation while the reviewer is disabled is
     * not blocking — but it is exactly the misconfiguration the user will hit
     * the moment they enable the reviewer, and finding it now is free.
     */
    for (const p of err.problems) {
      if (!required.includes(p.surface)) {
        checks.push(check(`tab-${p.surface}`, `${labelFor(p.surface)} (not required)`, true, `warning: ${p.detail}`, p.remedy));
      }
    }
  }

  /* -- 3. the Arena workspace specifically -------------------------------- */
  /*
   * The specification lists "Arena workspace is open" separately from "Arena
   * tab exists", and they are genuinely different: an Arena tab on the account
   * dashboard has a URL on the right host and no workspace behind it. bind()
   * requires a conversation id, which for Arena IS the workspace id, so this
   * check reads that binding rather than probing again.
   */
  const engineer = binding?.surfaces?.engineer;
  const rawEngineer = snapshot?.surfaces?.engineer;
  /*
   * THIS CHECK IS ABOUT THE MESSAGE, NOT THE VERDICT.
   *
   * `bind()` already refuses a tab with no conversation id, so a missing
   * workspace fails preflight either way. Sabotaging this line changed
   * nothing, which is how that was discovered -- and the honest conclusion is
   * that its value is telling the user WHICH problem they have. "Arena tab
   * missing" and "Arena tab open on the dashboard" need different actions, and
   * bind() reports the second as `conversation-changed`, which is accurate
   * vocabulary for ChatGPT and confusing for a workspace.
   *
   * So it distinguishes the two cases explicitly rather than restating bind().
   */
  const tabPresent = Boolean(rawEngineer);
  const inWorkspace = Boolean(engineer?.conversationId || rawEngineer?.conversationId);
  checks.push(
    check(
      'workspace',
      'Arena workspace is open',
      inWorkspace,
      inWorkspace
        ? `workspace ${engineer?.conversationId || rawEngineer.conversationId}`
        : tabPresent
          ? 'the Arena tab is open but not inside a project workspace'
          : 'no Arena tab was reported, so no workspace could be checked',
      'Open the project workspace in the Arena tab.',
    ),
  );

  /* -- 4. the logger ------------------------------------------------------ */
  let loggerOk = false;
  let loggerDetail = 'no logger was provided';
  if (logger) {
    try {
      const before = logger.live.length;
      const failuresBefore = logger.sinkFailures.length;
      logger.log('config-loaded', { source: 'system', description: 'Preflight: logger check' });
      const flushed = await logger.flush();
      /*
       * A FLUSH THAT RETURNS CLEANLY IS NOT PROOF THE SINK WORKS.
       *
       * `log()` fires its own flush when the batch size is reached, so that
       * write can already be in flight — and failing — while this one finds an
       * empty queue and reports success. Caught by a test that injected a
       * throwing sink and watched preflight declare storage healthy.
       *
       * `sinkFailures` is the durable record of what actually happened, so it
       * is the thing to read.
       */
      const failed = flushed?.error || logger.sinkFailures.length > failuresBefore;
      const failure = flushed?.error || logger.sinkFailures[logger.sinkFailures.length - 1]?.error;
      loggerOk = logger.live.length > before;
      loggerDetail = loggerOk
        ? `writing (session ${logger.sessionId}${failed ? ', but the durable store rejected the write' : ''})`
        : 'the logger accepted an event but did not record it';
      /*
       * A durable-store failure is a WARNING, not a hard stop.
       *
       * The in-memory log still works, so the user can watch the run — they
       * just lose it on eviction. Refusing to start would be the wrong trade:
       * it makes a degraded-but-usable session into no session. It is surfaced
       * loudly instead, which is the same stance the Logger takes internally.
       */
      if (failed) {
        checks.push(
          check('log-durable', 'Durable log storage', false, `IndexedDB rejected the write: ${failure}`,
            'Free disk space or clear old logs. The run can proceed, but the log will not survive a restart.',
            false),
        );
      } else {
        checks.push(check('log-durable', 'Durable log storage', true, 'accepting writes'));
      }
    } catch (err) {
      loggerDetail = String(err?.message || err);
    }
  }
  checks.push(check('logger', 'Logger is running', loggerOk, loggerDetail, 'Reload the extension.'));

  /* -- 5. state storage --------------------------------------------------- */
  let storeOk = false;
  let storeDetail = 'no store was provided';
  if (store) {
    try {
      /*
       * READ, WRITE, READ BACK. A store that accepts a write and returns
       * nothing is the failure that matters — it presents as a run that resets
       * to iteration 1 after every eviction, which reads as an orchestrator
       * bug rather than a storage one.
       */
      const existing = await store.load();
      const probe = { ...(existing || {}), __preflight: Date.now() };
      await store.save(probe);
      const readBack = await store.load();
      storeOk = readBack?.__preflight === probe.__preflight;
      storeDetail = storeOk
        ? existing
          ? `initialised — an existing project is stored (iteration ${existing.iteration ?? 0})`
          : 'initialised — no previous project stored'
        : 'the store accepted a write but did not return it';
      /*
       * RESTORE THE ORIGINAL, rather than deleting the probe key.
       *
       * An earlier version did `delete existing.__preflight` before saving.
       * That line was dead: `existing` came from `load()`, which clones, so it
       * never carried the probe — the probe only ever existed on the separate
       * `probe` object. Sabotaging the delete changed nothing and no test
       * noticed, which is how the dead code was found.
       *
       * Writing `existing` back is the line that actually protects a stored
       * project, so that is what the test now pins.
       */
      await store.save(existing || null);
    } catch (err) {
      storeDetail = String(err?.message || err);
    }
  }
  checks.push(check('storage', 'State storage initialised', storeOk, storeDetail, 'Check the extension\'s storage permission.'));

  /* -- 6. mode-specific expectations -------------------------------------- */
  if (setupResult.ok) {
    const mode = getMode(setup.mode);
    if (mode.key === 'existing' || mode.key === 'explore') {
      /*
       * Both modes assert "the repository and prior context already exist",
       * and the orchestrator genuinely cannot verify that from a tab title —
       * only Arena can, by looking. Rather than fake a check, this states the
       * assumption so a wrong choice is visible BEFORE fifty iterations run
       * against an empty workspace.
       */
      checks.push(
        check(
          'assumption',
          `Mode "${mode.label}" assumes existing work`,
          true,
          mode.key === 'explore'
            ? 'Arena will read the repository before proposing anything. If the workspace is empty, the exploration report will say so.'
            : 'This conversation and repository are assumed to have prior context. Nothing will be re-scaffolded.',
        ),
      );
    }
  }

  const failed = checks.filter((c) => !c.ok);
  const blocking = failed.filter((c) => c.blocking);
  const warnings = failed.filter((c) => !c.blocking);

  return {
    /*
     * `ok` means "may the run start", not "is everything perfect".
     *
     * Degraded is not broken. Losing the durable log costs the user their
     * history after a restart; refusing to start costs them the run. Blocking
     * on it would turn a degraded-but-usable session into no session, which is
     * the trade this project consistently refuses to make.
     */
    ok: blocking.length === 0,
    checks,
    binding,
    problems: blocking,
    warnings,
    summary: blocking.length
      ? `${blocking.length} of ${checks.length} checks failed: ${blocking.map((c) => c.label).join(', ')}`
      : warnings.length
        ? `all ${checks.length} checks passed, with ${warnings.length} warning(s): ${warnings.map((c) => c.label).join(', ')}`
        : `all ${checks.length} checks passed`,
  };
}

function labelFor(key) {
  return {
    manager: 'ChatGPT tab',
    engineer: 'Arena AI tab',
    reviewer: 'DeepSeek tab',
  }[key] || key;
}

export { describeDrift };
