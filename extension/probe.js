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
    /*
     * Verified against live URL shapes, August 2026:
     *   https://chatgpt.com/c/<uuid>              a conversation
     *   https://chatgpt.com/g/<gpt-id>/c/<uuid>   inside a custom GPT
     *   https://chatgpt.com/share/<uuid>          a shared read-only view
     *   https://chatgpt.com/?q=...                a prefilled NEW chat
     *
     * `chat.openai.com` still resolves and redirects to `chatgpt.com`, so it
     * is kept: a tab opened from an old bookmark reports the old host until it
     * navigates.
     *
     * `/share/` is deliberately NOT matched. A shared conversation is
     * read-only -- binding to one would produce a run that pastes prompts into
     * a page that cannot accept them, and the failure would look like a broken
     * composer selector rather than the wrong tab.
     */
    id: [/\/g\/[^/]+\/c\/([0-9a-zA-Z-]+)/, /\/c\/([0-9a-zA-Z-]+)/],
  },
  {
    key: 'engineer',
    hosts: ['arena.ai', 'www.arena.ai'],
    /*
     * Known shapes first, then a GENERIC fallback.
     *
     * A user reported "Arena AI tab: not on an existing conversation" with the
     * tab open on the right workspace. The tab was found; none of the four
     * hard-coded patterns matched its URL, so the probe reported no id and
     * preflight refused to start.
     *
     * Hard-coding another pattern would fix that one URL and fail the next
     * redesign, so the list ends with `generic: true` -- see
     * `conversationIdFor`. Guessing someone else's routing scheme is a losing
     * game; deriving an id from whatever path is present is not.
     */
    id: [
      /\/w\/([0-9a-zA-Z_-]+)/,
      /\/workspace[s]?\/([0-9a-zA-Z_-]+)/,
      /\/chat[s]?\/([0-9a-zA-Z_-]+)/,
      /\/session[s]?\/([0-9a-zA-Z_-]+)/,
      /\/thread[s]?\/([0-9a-zA-Z_-]+)/,
      /\/project[s]?\/([0-9a-zA-Z_-]+)/,
      /*
       * CONFIRMED from a real session: an Arena workspace is
       * https://arena.ai/agent/019fa9f8-3335-7012-bd43-3b12dde5fe92
       *
       * It was already matched, but only by the GENERIC fallback added after
       * the four hard-coded patterns missed nine of ten plausible shapes. It
       * is promoted to a known pattern now that it is observed rather than
       * guessed -- the fallback should be the safety net, not the mechanism.
       */
      /\/agent[s]?\/([0-9a-zA-Z_-]+)/,
      /\/c\/([0-9a-zA-Z_-]+)/,
      /\/a\/([0-9a-zA-Z_-]+)/,
    ],
    generic: true,
  },
  {
    key: 'reviewer',
    hosts: ['chat.deepseek.com', 'deepseek.com', 'www.deepseek.com'],
    /*
     * https://chat.deepseek.com/a/chat/s/<id> is the observed shape. The
     * generic fallback is enabled here for the same reason as Arena: the four
     * hard-coded Arena patterns missed nine of ten plausible URLs and cost a
     * user four failed rechecks. Betting on someone else's routing scheme is a
     * bet that keeps losing.
     */
    id: [/\/chat\/s\/([0-9a-zA-Z-]+)/, /\/a\/chat\/([0-9a-zA-Z-]+)/],
    generic: true,
  },
];

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Reserved path segments that are pages, not conversations.
 *
 * A generic "take the last path segment" rule would happily treat
 * `/settings` or `/login` as a conversation id, which is worse than finding
 * nothing: the run would bind to a settings page and start pasting into it.
 */
const NOT_A_CONVERSATION = new Set([
  'chat', 'chats', 'new', 'home', 'index', 'login', 'signin', 'sign-in',
  'signup', 'settings', 'account', 'billing', 'pricing', 'docs', 'help',
  'dashboard', 'workspace', 'workspaces', 'projects', 'about', 'app',
]);

function conversationIdFor(spec, url) {
  for (const re of spec.id) {
    const m = re.exec(url);
    if (m) return m[1];
  }

  if (!spec.generic) return null;

  /*
   * GENERIC FALLBACK: the last meaningful path segment, or a query parameter
   * that names a conversation.
   *
   * This exists because hard-coded routes are a bet on someone else's URL
   * scheme, and the bet was already lost once. The safeguards are that a
   * reserved segment is refused (so `/settings` cannot become an id) and a
   * bare origin still yields null (so a tab on the front page is correctly
   * reported as "not in a conversation").
   */
  try {
    const u = new URL(url);
    for (const key of ['conversation', 'conversationId', 'chat', 'chatId', 'id', 'session', 'thread', 'workspace']) {
      const v = u.searchParams.get(key);
      if (v && v.length >= 2) return v;
    }

    // Hash routing: /#/chat/abc123
    const fromHash = /[#/]([0-9a-zA-Z_-]{4,})$/.exec(u.hash);
    if (fromHash && !NOT_A_CONVERSATION.has(fromHash[1].toLowerCase())) return fromHash[1];

    const segments = u.pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (NOT_A_CONVERSATION.has(seg.toLowerCase())) continue;
      /*
       * Require some substance: 4+ characters, and at least one digit or a
       * separator, or a length that reads like an id. A two-letter segment is
       * far more likely to be a locale or a route than a conversation.
       */
      if (seg.length >= 4 && /[0-9_-]/.test(seg)) return seg;
      if (seg.length >= 8) return seg;
    }
  } catch {
    /* not a parseable URL; fall through */
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
