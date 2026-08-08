/**
 * THE PRE-INITIATED ENVIRONMENT CONTRACT.
 *
 * The premise, in the user's words: a fully prepared working environment
 * already exists before execution begins. ChatGPT is open on the right
 * conversation, Arena is open on the right workspace, DeepSeek is open if it
 * is enabled, authentication is done, permissions are granted.
 *
 * The orchestrator's job is therefore NOT to reach a good state. It is to
 * notice the instant it is no longer in one, and stop.
 *
 * TWO OPERATIONS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE DESIGN
 * -------------------------------------------------------------------
 *   bind()    once, at startup. Takes a snapshot of what is open and records
 *             an IDENTITY for each surface: which tab, which conversation.
 *   verify()  before every single interaction. Compares a fresh snapshot
 *             against that identity.
 *
 * Without bind(), verify() has nothing to compare against and degenerates into
 * "is a ChatGPT tab open somewhere?" -- which is true even if the user has
 * since switched to a different conversation, and pasting iteration 14 of a
 * project plan into the wrong chat is precisely the accident this file exists
 * to prevent. The binding is what makes "the same conversation" checkable.
 *
 * WHY IT IS PURE
 * Nothing here touches `chrome.tabs`. It consumes SNAPSHOTS -- plain objects a
 * transport produced -- and returns findings. That keeps the rule testable
 * without a browser, and keeps the engine honest per docs/SPEC.md.
 */

/**
 * The surfaces a run can depend on.
 *
 * `optional` is real: the specification makes DeepSeek an every-Nth-iteration
 * reviewer, and a user who has not enabled it must not be blocked by a missing
 * tab for a role they never asked for. But an OPTIONAL surface that IS bound
 * is held to exactly the same standard afterwards -- half a reviewer is worse
 * than none, because its advice would be silently dropped mid-run.
 */
export const SURFACES = /** @type {const} */ ([
  { key: 'manager', label: 'ChatGPT (project manager)', optional: false },
  { key: 'engineer', label: 'Arena AI (execution workspace)', optional: false },
  { key: 'reviewer', label: 'DeepSeek (strategic reviewer)', optional: true },
]);

/**
 * Every way a prepared environment can stop being the prepared environment.
 *
 * Enumerated rather than free text so the UI can explain each one with a
 * specific remedy, and so the log is groupable: "this run died three times on
 * `conversation-changed`" is an actionable pattern; three prose sentences are
 * not.
 */
export const DRIFT_KINDS = /** @type {const} */ ([
  'tab-missing',           // the tab is gone: closed, or crashed
  'tab-replaced',          // same role, different tab id
  'navigated-away',        // the tab is now on a different site
  'conversation-changed',  // right site, wrong conversation
  'signed-out',            // authentication lapsed
  'not-ready',             // page still loading, or composer absent
  'ambiguous',             // two surfaces resolved to the same tab
]);

/** Human-facing remedies. The user is the recovery mechanism, so tell them. */
const REMEDY = {
  'tab-missing': 'reopen the tab and rebind, or stop the run',
  'tab-replaced': 'the original tab was closed and another took its place — rebind if intended',
  'navigated-away': 'navigate that tab back to the project conversation, then resume',
  'conversation-changed': 'switch that tab back to the bound conversation, then resume',
  'signed-out': 'sign in again in that tab, then resume',
  'not-ready': 'wait for the page to finish loading, then resume',
  'ambiguous': 'two roles are pointing at the same tab — separate them before resuming',
};

export class EnvironmentError extends Error {
  constructor(problems) {
    super(describe(problems));
    this.name = 'EnvironmentError';
    this.problems = problems;
  }
}

/** One-line-per-problem rendering, used for the message and the log. */
export function describe(problems) {
  if (!problems?.length) return 'environment ok';
  return problems
    .map((p) => `${p.label || p.surface}: ${p.kind} — ${p.detail} (${p.remedy})`)
    .join('; ');
}

function problem(surface, label, kind, detail) {
  return { surface, label, kind, detail, remedy: REMEDY[kind] || 'user intervention required' };
}

/** `https://www.chatgpt.com/c/abc` -> `chatgpt.com`. Tolerates junk input. */
export function hostOf(url) {
  if (typeof url !== 'string') return '';
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (!m) return '';
  return m[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
}

/**
 * Establish the identity of each required surface.
 *
 * @param {object} snapshot   `{ surfaces: { manager: {...}, ... } }` from a transport
 * @param {object} [options]
 * @param {string[]} [options.require]  surface keys this run needs
 * @param {Record<string,string[]>} [options.hosts]  expected hosts per surface
 * @returns {{boundAt:number, surfaces:object}}
 * @throws {EnvironmentError} if the environment is not usable as-is
 *
 * THIS FUNCTION NEVER FIXES ANYTHING. It reports and refuses. That asymmetry
 * is the point of the whole module: the failure policy the user specified is
 * pause / log / inform / wait, and a bind() that "helpfully" fell back to
 * another open ChatGPT tab would violate it while appearing to work.
 */
export function bind(snapshot, options = {}) {
  const required = options.require || SURFACES.filter((s) => !s.optional).map((s) => s.key);
  const hosts = options.hosts || {};
  const seen = snapshot?.surfaces || {};
  const problems = [];
  const notes = [];
  const bound = {};

  for (const spec of SURFACES) {
    const isRequired = required.includes(spec.key);
    const s = seen[spec.key];

    if (!s) {
      if (isRequired) {
        problems.push(problem(spec.key, spec.label, 'tab-missing', 'no pre-opened tab was reported'));
      }
      continue; // an optional surface that is absent is simply not bound
    }

    /*
     * AN UNREQUIRED SURFACE CANNOT BLOCK THE BIND.
     *
     * This validated every surface it could SEE, not every surface the run
     * NEEDS. So a DeepSeek tab sitting on the home page -- with the reviewer
     * disabled and therefore irrelevant -- threw
     * "conversation-changed: not on an existing conversation" and refused to
     * start the run.
     *
     * Worse, it disagreed with preflight, which correctly only checked the
     * required surfaces: the user saw "all 9 checks passed", pressed Start,
     * and got a hard refusal naming a tab that did not matter. Two checks
     * answering the same question differently is worse than either being
     * wrong, because there is no way to tell which to believe.
     *
     * An unrequired surface that is present but unusable is now simply not
     * bound. Nothing will drive it -- which is exactly right, because nothing
     * was going to.
     */
    const problemsBefore = problems.length;
    const skipIfBroken = !isRequired;

    const expected = hosts[spec.key];
    const host = hostOf(s.url);

    /*
     * Each check below records a problem and stops evaluating THIS surface.
     * `fail()` exists so the unrequired-surface discard above is reached
     * rather than jumped over -- an early `continue` skipped it, which is how
     * the original bug survived.
     */
    let failed = false;
    const fail = (kind, detail) => {
      problems.push(problem(spec.key, spec.label, kind, detail));
      failed = true;
    };

    if (s.tabId === undefined || s.tabId === null) {
      fail('tab-missing', 'reported without a tab id');
    }
    if (!failed && expected?.length && !expected.includes(host)) {
      fail('navigated-away', `tab is on "${host || 'unknown'}", expected ${expected.join(' or ')}`);
    }
    if (!failed && s.signedIn === false) {
      fail('signed-out', 'the tab reports no active session');
    }
    if (!failed && s.ready === false) {
      fail('not-ready', 'the page has not finished loading');
    }
    /*
     * A MISSING CONVERSATION ID IS A HARD FAILURE, NOT A DETAIL.
     *
     * On ChatGPT and DeepSeek, a tab sitting on the "new chat" screen has no
     * conversation id yet. Binding to it would mean the first paste CREATES a
     * conversation -- which is explicitly forbidden, and would do it without
     * any code ever calling something that looks like "create". The absence of
     * an id is the only signal available before the damage is done.
     */
    if (!failed && !s.conversationId) {
      fail('conversation-changed', 'the tab is not on an existing conversation (no id)');
    }

    if (failed && !skipIfBroken) continue;

    /*
     * If an unrequired surface produced problems, discard them and leave it
     * unbound rather than failing the whole environment.
     */
    if (skipIfBroken && problems.length > problemsBefore) {
      problems.length = problemsBefore;
      notes.push(`${spec.label} was found but is not usable, and is not required — it will not be driven`);
      continue;
    }

    bound[spec.key] = {
      tabId: s.tabId,
      windowId: s.windowId ?? null,
      host,
      url: s.url,
      conversationId: s.conversationId,
      title: s.title || '',
      label: spec.label,
    };
  }

  // Two roles on one tab: the run would paste the manager's plan into the
  // engineer's workspace and never notice, because both reads would succeed.
  const byTab = new Map();
  for (const [key, b] of Object.entries(bound)) {
    if (byTab.has(b.tabId)) {
      problems.push(
        problem(key, b.label, 'ambiguous', `shares tab ${b.tabId} with "${byTab.get(b.tabId)}"`),
      );
    } else {
      byTab.set(b.tabId, key);
    }
  }

  if (problems.length) throw new EnvironmentError(problems);
  return { boundAt: Date.now(), surfaces: bound, notes };
}

/**
 * Is the environment still the one we bound?
 *
 * Called before EVERY interaction, not once per iteration. An iteration is
 * minutes long; a user can close a tab in the middle of one, and the interval
 * between checks is exactly the window in which the orchestrator can type into
 * the wrong place.
 *
 * @returns {{ok:boolean, problems:object[]}}
 */
export function verify(binding, snapshot, options = {}) {
  const only = options.surfaces || Object.keys(binding?.surfaces || {});
  const seen = snapshot?.surfaces || {};
  const problems = [];

  for (const key of only) {
    const b = binding?.surfaces?.[key];
    if (!b) {
      problems.push(problem(key, key, 'tab-missing', 'this surface was never bound'));
      continue;
    }
    const s = seen[key];
    if (!s) {
      problems.push(problem(key, b.label, 'tab-missing', `tab ${b.tabId} is no longer open`));
      continue;
    }
    if (s.tabId !== b.tabId) {
      problems.push(
        problem(key, b.label, 'tab-replaced', `bound to tab ${b.tabId}, found tab ${s.tabId}`),
      );
      continue;
    }
    if (s.signedIn === false) {
      problems.push(problem(key, b.label, 'signed-out', 'the session ended during the run'));
      continue;
    }
    const host = hostOf(s.url);
    if (host !== b.host) {
      problems.push(problem(key, b.label, 'navigated-away', `now on "${host || 'unknown'}", was "${b.host}"`));
      continue;
    }
    /*
     * Conversation identity is checked BEFORE readiness on purpose.
     *
     * A tab that switched conversations is often mid-load, so it reports
     * `ready: false` too. If readiness were checked first the log would say
     * "page not finished loading" -- the user waits, it loads, they resume,
     * and the run continues in the wrong conversation. The more specific
     * finding has to win, or the message actively misleads.
     */
    if (s.conversationId !== b.conversationId) {
      problems.push(
        problem(key, b.label, 'conversation-changed',
          `bound to "${b.conversationId}", tab is now on "${s.conversationId || 'a new chat'}"`),
      );
      continue;
    }
    if (s.ready === false) {
      problems.push(problem(key, b.label, 'not-ready', 'the page is not currently interactive'));
    }
  }

  return { ok: problems.length === 0, problems };
}
