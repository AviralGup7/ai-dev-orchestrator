/**
 * THE THREE WORKFLOW MODES.
 *
 * The landing screen's whole job is to answer one question before any prompt
 * is composed: *what does Arena already know?* Everything downstream depends
 * on it — the shape of the first prompt, whether a baseline is needed, and
 * critically whether the first scores may be trusted.
 *
 * WHY MODE IS PERSISTED IN MEMORY RATHER THAN PASSED AROUND
 * --------------------------------------------------------
 * An MV3 service worker is evicted constantly, and the mode changes how a
 * continuation prompt is written forty iterations later ("as established in
 * the exploration report" is a lie if the run started as a new project). A
 * value that lives only in the UI would be lost on the first eviction and the
 * loop would silently switch dialects mid-run.
 *
 * PURE. No imports beyond the vocabulary.
 */

export const MODES = /** @type {const} */ ([
  {
    key: 'new',
    label: 'New Project',
    blurb: 'Start something new in the Arena workspace that is already open.',
    /** The user must supply a description. */
    needsPrompt: true,
    /** The first iteration establishes standards and begins implementation. */
    baseline: 'initialise',
  },
  {
    key: 'existing',
    label: 'Existing Project',
    blurb: 'Continue the project already open in Arena, with its existing history.',
    needsPrompt: false,
    baseline: 'synchronise',
  },
  {
    key: 'explore',
    label: 'Self Exploration',
    blurb: 'No prompt needed. Arena reads the project first, then proposes what to do.',
    needsPrompt: false,
    baseline: 'explore',
  },
]);

export const MODE_KEYS = MODES.map((m) => m.key);

export function getMode(key) {
  const m = MODES.find((x) => x.key === key);
  if (!m) throw new TypeError(`unknown workflow mode: ${key}`);
  return m;
}

/**
 * Validate what the user typed on the landing screen.
 *
 * Returns `{ok, problems}` rather than throwing: this drives inline field
 * errors on a form, and a thrown exception would have to be caught and
 * unpacked by the view to say which field is wrong.
 */
export function validateSetup({ mode, projectName = '', prompt = '' } = {}) {
  const problems = [];

  if (!MODE_KEYS.includes(mode)) {
    problems.push({ field: 'mode', message: 'Choose a workflow mode.' });
    return { ok: false, problems };
  }

  const spec = getMode(mode);
  const text = String(prompt || '').trim();

  if (spec.needsPrompt) {
    if (text.length === 0) {
      problems.push({ field: 'prompt', message: 'Describe what you want built.' });
    } else if (text.length < 20) {
      /*
       * A LOW BAR, AND IT IS STILL WORTH HAVING.
       *
       * "make an app" is a scope the orchestrator will happily chase for fifty
       * iterations in whatever direction the manager invents, and the user
       * will conclude the tool is broken rather than that the input was empty.
       * The threshold is deliberately not higher: judging the *quality* of a
       * description is exactly the kind of guess this project refuses to make.
       */
      problems.push({
        field: 'prompt',
        message: 'That is very short. A sentence or two about what this project is will keep the run on target.',
      });
    }
  }

  if (String(projectName).length > 120) {
    problems.push({ field: 'projectName', message: 'Keep the name under 120 characters.' });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The scope string stored in memory, which is never edited afterwards.
 *
 * In `explore` mode there is no user description by definition, so the scope
 * is a PLACEHOLDER until the exploration report replaces it. It is written in
 * a way that reads honestly in the log if exploration never completes —
 * "(pending exploration)" rather than a confident invented summary.
 */
export function initialScope({ mode, projectName = '', prompt = '' }) {
  const name = String(projectName || '').trim();
  const text = String(prompt || '').trim();

  if (mode === 'explore') {
    return name
      ? `${name} — scope to be determined by exploration (pending exploration)`
      : 'Existing project — scope to be determined by exploration (pending exploration)';
  }
  if (mode === 'existing') {
    return text
      ? `${name ? `${name}: ` : ''}${text}`
      : `${name || 'Existing Arena project'} — continuing prior work`;
  }
  return name ? `${name}: ${text}` : text;
}
