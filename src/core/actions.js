/**
 * WHAT THE ORCHESTRATOR IS PERMITTED TO DO TO THE USER'S BROWSER.
 *
 * WHY THIS IS A MODULE AND NOT A PARAGRAPH IN THE README
 * -----------------------------------------------------
 * The user's constraint is absolute: the environment is prepared BEFORE the
 * run starts. Tabs are open, conversations are chosen, authentication is done.
 * The orchestrator inherits that environment; it does not build one.
 *
 * The tempting way to honour that is to write "never open a new tab" in the
 * design doc and rely on nobody doing it. That fails the same way "do not
 * write code" fails as an instruction to a language model: it is a REQUEST.
 * The same reasoning that made role separation a response schema rather than a
 * prompt applies here -- a capability that is never exposed cannot be used by
 * accident at 2am.
 *
 * So the allowed verbs are an enumeration, every transport call is checked
 * against it, and `tools/check-env-safety.mjs` greps the source for the
 * forbidden Chrome APIs so a future author cannot quietly add one.
 *
 * PURE. No imports, no browser. The list is knowledge, not behaviour.
 */

/**
 * The complete set of things the orchestrator may do.
 *
 * Read this as the answer to "what is the worst this extension can do to my
 * browser?" -- it can move your focus between tabs you already had open, type
 * into them, and move files. It cannot change what those tabs are.
 */
export const ALLOWED_ACTIONS = /** @type {const} */ ([
  'focus-existing-tab', // switch focus between PRE-OPENED, bound tabs
  'read-conversation',  // scrape what is already on screen
  'paste-prompt',       // put text into the composer
  'submit-prompt',      // press send
  'await-response',     // wait, poll, detect completion
  'copy-response',      // read the reply back out
  'download-artifact',  // save a file the AI produced
  'upload-file',        // attach a project file to the composer
  'persist-state',      // write to extension storage
]);

/**
 * Things that would change the environment the user prepared.
 *
 * Each of these has an obvious "helpful" justification, which is exactly why
 * they are listed by name. The dangerous one is not `tabs.remove` -- nobody
 * adds that by accident. It is `tabs.reload` and `tabs.update({url})`, both of
 * which look like recovery steps. A tab that stopped responding "just needs a
 * refresh", and a refresh destroys an in-flight AI response, sometimes the
 * user's unsent draft, and occasionally the conversation scroll position that
 * the scraper was anchored to. Recovery is the user's decision, not ours.
 */
export const FORBIDDEN_ACTIONS = /** @type {const} */ ([
  'create-tab',
  'close-tab',
  'duplicate-tab',
  'navigate',
  'reload',
  'create-conversation',
  'sign-in',
  'sign-out',
  'switch-account',
  'switch-workspace',
  'open-window',
  'change-browser-settings',
  'change-extension-settings',
]);

const ALLOWED = new Set(ALLOWED_ACTIONS);
const FORBIDDEN = new Set(FORBIDDEN_ACTIONS);

/** Raised when something tries to act outside the permitted set. */
export class ForbiddenActionError extends Error {
  constructor(action, why) {
    super(
      `refused "${action}": ${why}. The run environment is prepared by the ` +
        `user and is read-only to the orchestrator.`,
    );
    this.name = 'ForbiddenActionError';
    this.action = action;
  }
}

/**
 * Gate for every environment-touching call.
 *
 * DEFAULT DENY, and that ordering matters. An earlier sketch checked the
 * forbidden list and allowed anything not on it, which means the day someone
 * invents a new capability -- `tabs.group`, `sidePanel.open` -- it is
 * permitted by omission. The forbidden list exists only to produce a better
 * error message; the ALLOWED set is the authority.
 *
 * @param {string} action
 */
export function assertAllowed(action) {
  if (ALLOWED.has(action)) return action;
  if (FORBIDDEN.has(action)) {
    throw new ForbiddenActionError(action, 'this would change the prepared environment');
  }
  throw new ForbiddenActionError(action, 'unknown action, and the policy is default-deny');
}

/** Non-throwing form, for UI that wants to grey a button out. */
export function isAllowed(action) {
  return ALLOWED.has(action);
}
