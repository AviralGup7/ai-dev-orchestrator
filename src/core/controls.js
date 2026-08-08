/**
 * USER CONTROLS, AND THE ONE THAT CAN BREAK THE EVIDENCE GUARANTEE.
 *
 * Start / Pause / Resume / Stop / Skip / Retry / Export. Six of those are
 * bookkeeping. `Skip` is not, and this file exists mostly for it.
 *
 * WHY SKIP IS DANGEROUS
 * ---------------------
 * The whole project rests on one claim: a score is only trusted if evidence
 * was produced for it. Skip lets a user step over `execute` (so the manager
 * evaluates work that never happened) or over `evaluate` (so an iteration
 * produces no scores at all). Do that a few times near the end of a run and
 * the system can reach its target on an evidence base with holes in it -- and
 * nothing in `stop.js` would notice, because stop.js inspects the LATEST
 * scorecard and a skipped iteration simply does not add one.
 *
 * THE RESOLUTION (user's decision, recorded): skipping is allowed and it
 * POISONS THE RECORD. The iteration is permanently marked with what was
 * skipped, and an iteration with skipped evidence phases can never satisfy a
 * stop condition. You may skip. You may not skip your way to "done".
 *
 * That is better than refusing outright. A refusal gets worked around -- the
 * user stops the run, edits state, restarts -- and then the record does not
 * show the skip at all. Permitting it with a consequence keeps it visible.
 */

/** Phases whose absence means the iteration produced no evidence. */
export const EVIDENCE_PHASES = /** @type {const} */ (['execute', 'evaluate']);

/** Every control the UI offers. */
export const CONTROLS = /** @type {const} */ ([
  { key: 'start', label: 'Start', needs: ['idle', 'stopped'] },
  { key: 'pause', label: 'Pause', needs: ['running'] },
  { key: 'resume', label: 'Resume', needs: ['paused', 'blocked'] },
  { key: 'stop', label: 'Stop', needs: ['running', 'paused', 'blocked'] },
  { key: 'skip', label: 'Skip Current Step', needs: ['running', 'paused'] },
  { key: 'retry', label: 'Retry Current Step', needs: ['running', 'paused', 'failed'] },
  { key: 'export', label: 'Export Logs', needs: '*' },
  { key: 'report', label: 'View Latest Report', needs: '*' },
]);

/**
 * Which controls are available right now.
 *
 * Returned as a map rather than filtered, because a UI that HIDES unavailable
 * buttons makes the interface jump around and leaves the user hunting for Stop
 * at the moment they most want it. Disabled-with-a-reason is calmer and more
 * honest.
 */
export function availableControls(memory) {
  const status = memory?.status ?? 'idle';
  const out = {};
  for (const c of CONTROLS) {
    const ok = c.needs === '*' || c.needs.includes(status);
    out[c.key] = {
      label: c.label,
      enabled: ok,
      reason: ok ? null : `not available while ${status}`,
    };
  }
  /*
   * Resume from `blocked` is enabled, and it means something different: it
   * clears the environment block after the user has fixed the tab. The guard
   * re-verifies on the next action, so pressing it optimistically is safe --
   * if the environment is still wrong, it blocks again immediately with the
   * current problem rather than the stale one.
   */
  if (status === 'blocked') {
    out.resume.label = 'Resume (I fixed the environment)';
  }
  return out;
}

/**
 * Record a skip against an iteration.
 *
 * @returns {object} the mutated record, for chaining
 */
export function recordSkip(record, phase) {
  record.skipped = [...new Set([...(record.skipped || []), phase])];
  return record;
}

/**
 * Can this iteration's scores satisfy a stop condition?
 *
 * Consulted by `stop.js`. An iteration that skipped `execute` or `evaluate`
 * carries no honest evidence for the scores attached to it.
 */
export function iterationIsTrustworthy(record) {
  if (!record) return false;
  const skipped = record.skipped || [];
  return !EVIDENCE_PHASES.some((p) => skipped.includes(p));
}

/**
 * Human explanation of why a skipped iteration cannot end the run.
 * Shown in the UI next to the stop condition, so the consequence of pressing
 * Skip is visible at the moment it matters rather than buried in a doc.
 */
export function describeSkips(record) {
  const skipped = (record?.skipped || []).filter((p) => EVIDENCE_PHASES.includes(p));
  if (skipped.length === 0) return null;
  return `iteration ${record.n} skipped ${skipped.join(' and ')}, so its scores rest on incomplete evidence`;
}
