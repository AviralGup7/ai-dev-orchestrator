/**
 * READING THE PRE-OPENED ENVIRONMENT.
 *
 * `src/core/environment.js` decides whether the environment is usable. It
 * consumes plain snapshot objects and has never heard of a tab. This file is
 * the other half: it produces those snapshots from the browser.
 *
 * That split is why the rule is testable in Node without a browser, and it is
 * the reason this file is tiny and dull. All the judgement lives in the core.
 *
 * WHAT IT MAY DO
 * `chrome.tabs.query` reads tabs that are already open. It creates nothing,
 * closes nothing, navigates nothing — see `src/core/actions.js`. Reading the
 * environment is the one thing the orchestrator must do before it can refuse
 * to change it.
 *
 * NO `tabs` PERMISSION IS REQUESTED.
 * `chrome.tabs.query` works without it; `url` and `title` are simply blank for
 * tabs the extension has no host permission for. Since the manifest already
 * grants exactly the four AI hosts, that is precisely the right amount of
 * access — the extension can see the tabs it is meant to drive and is blind to
 * everything else. Asking for `tabs` would grant visibility into every open
 * page for no additional capability.
 */

/**
 * How to recognise each surface, and where its conversation id lives.
 *
 * The id patterns are the fragile part of this file — they are somebody else's
 * URL scheme and can change without notice. That is stated in the README as a
 * known risk, and it is contained: a pattern that stops matching produces
 * `conversationId: null`, which `bind()` reports as "not on an existing
 * conversation" and the run refuses to start. Loud, and specific.
 */
export const SURFACE_PATTERNS = [
  {
    key: 'manager',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    // https://chatgpt.com/c/<uuid>   or  /g/<gpt>/c/<uuid>
    id: [/\/c\/([0-9a-zA-Z-]+)/],
  },
  {
    key: 'engineer',
    hosts: ['arena.ai'],
    // Arena's workspace/chat id. Several shapes have been observed, so the
    // patterns are tried in order and the first match wins.
    id: [/\/w\/([0-9a-zA-Z_-]+)/, /\/workspace\/([0-9a-zA-Z_-]+)/, /\/chat\/([0-9a-zA-Z_-]+)/, /\/c\/([0-9a-zA-Z_-]+)/],
  },
  {
    key: 'reviewer',
    hosts: ['chat.deepseek.com', 'deepseek.com'],
    // https://chat.deepseek.com/a/chat/s/<id>
    id: [/\/chat\/s\/([0-9a-zA-Z-]+)/, /\/a\/chat\/([0-9a-zA-Z-]+)/],
  },
];

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function conversationIdFor(spec, url) {
  for (const re of spec.id) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return null;
}

/**
 * Build an environment snapshot from the tabs that are already open.
 *
 * @param {object} [options]
 * @param {(q:object)=>Promise<object[]>} [options.query]  injectable for tests
 * @returns {Promise<{surfaces:object, scanned:number}>}
 */
export async function snapshotEnvironment({ query } = {}) {
  const q = query || ((arg) => chrome.tabs.query(arg));
  const tabs = await q({});
  const surfaces = {};
  const ambiguous = {};

  for (const tab of tabs) {
    const host = hostOf(tab.url || '');
    if (!host) continue; // no host permission for this tab, or an internal page

    const spec = SURFACE_PATTERNS.find((s) => s.hosts.includes(host));
    if (!spec) continue;

    const entry = {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      url: tab.url,
      title: tab.title || '',
      conversationId: conversationIdFor(spec, tab.url),
      /*
       * `ready` and `signedIn` are reported as `true` here rather than probed.
       *
       * Determining either honestly requires reading the page, which needs a
       * content script that does not exist yet. Reporting an unprobed value as
       * `false` would block every run on a check that is not implemented;
       * reporting it as `true` lets `bind()` judge on the facts that ARE
       * known — host and conversation id — which are the two that catch the
       * failures that actually happen.
       *
       * This is a deliberate, documented gap, not an oversight. When the
       * content script lands it fills these in and nothing else changes.
       */
      ready: true,
      signedIn: true,
      probed: false,
    };

    if (surfaces[spec.key]) {
      /*
       * TWO TABS FOR ONE ROLE IS A REAL SITUATION AND A REAL HAZARD.
       *
       * Users keep several ChatGPT tabs open. Silently picking one means the
       * orchestrator might drive a conversation the user was not looking at —
       * and the run would appear to work. Preferring the ACTIVE tab is the
       * least surprising rule, but the ambiguity is recorded either way so
       * preflight can say so rather than quietly choosing.
       */
      (ambiguous[spec.key] ||= [surfaces[spec.key]]).push(entry);
      if (tab.active && !surfaces[spec.key].active) surfaces[spec.key] = { ...entry, active: true };
      continue;
    }
    surfaces[spec.key] = { ...entry, active: Boolean(tab.active) };
  }

  return {
    surfaces,
    scanned: tabs.length,
    ambiguous: Object.fromEntries(
      Object.entries(ambiguous).map(([k, v]) => [k, v.length]),
    ),
  };
}

/** Hosts, in the shape `bind()` and `preflight()` expect. */
export const EXPECTED_HOSTS = Object.fromEntries(
  SURFACE_PATTERNS.map((s) => [s.key, s.hosts]),
);
