/**
 * SURFACE SCANS — what a page looked like when something went wrong.
 *
 * An error in the log says *that* something failed. It rarely says *why*, and
 * the why is almost always on the page: the composer moved, a rate-limit
 * banner appeared, the conversation was regenerating, the send button was
 * disabled. By the time a human reads the log that page is gone.
 *
 * So: when an error is logged, capture the page in detail and attach it to the
 * log. The next agent to work on this — human or AI — inherits the scene
 * rather than a one-line symptom.
 *
 * THIS FILE IS THE MODEL, NOT THE SCANNER.
 * It decides what is worth keeping, how much, when a scan is allowed, and how
 * to render it. `extension/scan.js` does the DOM reading. That split is the
 * same one as `environment.js` / `probe.js`, for the same reason: the policy
 * is the part with the judgement in it, and it must be testable without a
 * browser.
 *
 * PURE.
 */

import { redact } from './journal.js';

/* ========================================================================== *
 * WHEN IS A SCAN ALLOWED?
 * ========================================================================== */

export const SCAN_DEFAULTS = {
  /** Never scan the same surface more often than this. */
  cooldownMs: 30_000,
  /** Hard ceiling per session. */
  maxPerSession: 20,
  /** Bytes of rendered scan retained per capture. */
  maxBytes: 24_000,
  /** Deepest DOM level walked. */
  maxDepth: 12,
  /** Most elements recorded. */
  maxNodes: 400,
  /** Longest single text run kept. */
  maxText: 400,
};

/**
 * Error types that are worth a scan.
 *
 * NOT "every error". A storage quota failure has nothing to do with the DOM,
 * and scanning for it costs a page capture that tells the reader nothing while
 * consuming the budget that a real UI failure will need later.
 */
export const SCAN_WORTHY = new Set([
  'response-timeout',
  'environment-drift',
  'error',
  'build-failed',
  'iteration-failed',
  'awaiting-user',
]);

/**
 * Error types that must NEVER trigger a scan.
 *
 * THE INFINITE LOOP THIS PREVENTS IS NOT HYPOTHETICAL.
 *
 * The trigger is "an error was logged". A scan that fails logs an error. That
 * error triggers a scan. Which fails. The extension would sit there filling
 * IndexedDB with failure reports about its own failure reports, and because
 * the log "must never silently discard events", it would do so faithfully
 * until the quota died.
 *
 * Three defences, because one is not enough for a loop that writes to disk:
 * this list, the reentrancy latch in `ScanBudget`, and the cooldown.
 */
export const NEVER_SCAN = new Set([
  'surface-scan',
  'surface-scan-failed',
  'state-saved',
  'log-exported',
]);

/**
 * Tracks whether a scan may proceed.
 *
 * Deliberately a small stateful object rather than module-level variables:
 * the service worker is evicted and restarted constantly, and a module-level
 * counter would silently reset to zero on every wake — turning "20 per
 * session" into "20 per 30 seconds of activity", which is not a budget.
 * Owning it explicitly means it can be persisted later without redesign.
 */
export class ScanBudget {
  constructor(config = {}) {
    this.config = { ...SCAN_DEFAULTS, ...config };
    this.used = 0;
    this.lastBySurface = new Map();
    /** True while a scan is in flight. The reentrancy latch. */
    this.busy = false;
    this.declined = [];
  }

  /**
   * @returns {{allowed: boolean, why: string}}
   */
  may(event, now = Date.now()) {
    const decline = (why) => {
      this.declined.push({ at: now, type: event?.type, why });
      return { allowed: false, why };
    };

    if (!event || event.status !== 'error') return decline('not an error');
    if (NEVER_SCAN.has(event.type)) return decline(`"${event.type}" must never trigger a scan`);
    if (!SCAN_WORTHY.has(event.type)) return decline(`"${event.type}" is not a page-level failure`);
    if (this.busy) return decline('a scan is already running');
    if (this.used >= this.config.maxPerSession) {
      return decline(`session budget of ${this.config.maxPerSession} scans is spent`);
    }

    const surface = event.surface || event.data?.surface || event.source;
    const last = this.lastBySurface.get(surface);
    if (last && now - last < this.config.cooldownMs) {
      return decline(`${surface} was scanned ${Math.round((now - last) / 1000)}s ago`);
    }

    return { allowed: true, why: 'first failure on this surface' };
  }

  begin(surface, now = Date.now()) {
    this.busy = true;
    this.used++;
    this.lastBySurface.set(surface, now);
  }

  end() {
    this.busy = false;
  }

  /**
   * Why scans did not happen.
   *
   * Surfaced in the session summary. A feature that silently declines to run
   * is indistinguishable from one that is broken — and this project has now
   * shipped that exact failure once, with a button that did nothing.
   */
  summary() {
    const byReason = {};
    for (const d of this.declined) byReason[d.why] = (byReason[d.why] || 0) + 1;
    return { used: this.used, remaining: Math.max(0, this.config.maxPerSession - this.used), declined: byReason };
  }
}

/* ========================================================================== *
 * BOUNDING A CAPTURE
 * ========================================================================== */

/**
 * Trim a raw capture to something a log can hold and a human can read.
 *
 * A modern chat page is tens of thousands of DOM nodes. Storing it whole would
 * blow the storage quota inside a handful of errors, and — worse — would bury
 * the useful part. The interesting nodes are the ones that explain a stuck
 * automation: the composer, the send button, anything disabled, anything that
 * looks like an error or a rate limit.
 *
 * @param {object} raw   from extension/scan.js
 * @param {object} [config]
 */
export function boundCapture(raw, config = {}) {
  const cfg = { ...SCAN_DEFAULTS, ...config };
  if (!raw || typeof raw !== 'object') {
    return { ok: false, problem: 'the scan returned nothing' };
  }

  const clipText = (s) => {
    const t = redact(String(s ?? '')).replace(/\s+/g, ' ').trim();
    return t.length > cfg.maxText ? `${t.slice(0, cfg.maxText - 1)}…` : t;
  };

  const nodes = (raw.nodes || []).slice(0, cfg.maxNodes).map((n) => ({
    path: String(n.path || '').slice(0, 160),
    tag: String(n.tag || '').toLowerCase().slice(0, 24),
    role: n.role ? String(n.role).slice(0, 40) : undefined,
    id: n.id ? String(n.id).slice(0, 60) : undefined,
    testid: n.testid ? String(n.testid).slice(0, 60) : undefined,
    label: n.label ? clipText(n.label) : undefined,
    text: n.text ? clipText(n.text) : undefined,
    disabled: n.disabled || undefined,
    hidden: n.hidden || undefined,
    editable: n.editable || undefined,
    /* Geometry is kept because "the button is at y=-400" explains a click that
     * silently did nothing far better than any amount of markup. */
    box: n.box || undefined,
  }));

  const capture = {
    at: raw.at ?? Date.now(),
    surface: raw.surface || 'unknown',
    url: redact(String(raw.url || '')),
    title: clipText(raw.title),
    /*
     * `readyState` and `visibility` answer the two questions that make an
     * automation failure obvious in hindsight: was the page still loading, and
     * was the tab even rendered? A backgrounded tab throttles timers and
     * defers layout, which is a common cause of "the click did nothing".
     */
    readyState: raw.readyState,
    visibility: raw.visibility,
    scroll: raw.scroll,
    viewport: raw.viewport,
    counts: raw.counts,
    /*
     * THE SINGLE MOST USEFUL FIELD, AND IT WAS BEING THROWN AWAY.
     *
     * `scanPage` computes `selectorCheck` inside the page -- which shipped
     * selector matched, and how many nodes each `turns` selector found. It is
     * the direct answer to "is the selector I ship actually matching anything",
     * which is the question every remote debugging session has opened with.
     *
     * This function builds a NEW object rather than spreading `raw`, so the
     * field was silently dropped on the way out. Across eight exported logs and
     * three surface scans it was `null` every single time, and each of those
     * sessions was spent inferring from a node dump what this field states
     * outright. Dropping data is invisible; that is what made it survive.
     *
     * Rebuilt rather than spread, deliberately: an unbounded copy of page data
     * into a durable log is how the size limits get defeated.
     */
    selectorCheck: raw.selectorCheck ?? null,
    signals: (raw.signals || []).slice(0, 40).map(clipText),
    nodes,
    truncated: {
      nodes: Math.max(0, (raw.counts?.elements ?? 0) - nodes.length),
      depthCapped: Boolean(raw.depthCapped),
    },
  };

  const rendered = renderCapture(capture);
  if (rendered.length > cfg.maxBytes) {
    /*
     * Drop NODES, keep the summary and signals.
     *
     * The header and the signals are what a reader needs first; the node list
     * is the detail they drill into. Truncating from the end of the whole
     * document would cut the signals off — the opposite of useful.
     */
    const keep = Math.max(20, Math.floor(nodes.length / 2));
    capture.nodes = nodes.slice(0, keep);
    capture.truncated.nodes += nodes.length - keep;
    capture.truncated.bytes = true;
  }

  return { ok: true, capture };
}

/* ========================================================================== *
 * RENDERING
 * ========================================================================== */

/**
 * Render a capture as markdown, for the log export and for pasting to an AI.
 *
 * Markdown rather than raw HTML, deliberately. The consumer is "an agent
 * working on it" — a person or a model reading the exported log. Raw outerHTML
 * of a chat page is mostly minified class soup, and pasting it into a model
 * burns thousands of tokens to convey almost nothing. A structured summary of
 * the interactive elements is what actually answers "why did the click fail".
 */
export function renderCapture(c) {
  if (!c) return '';
  const L = [];

  L.push(`### Surface scan — ${c.surface} @ ${new Date(c.at).toISOString()}`);
  L.push('');
  L.push(`- URL: ${c.url}`);
  L.push(`- Title: ${c.title}`);
  L.push(`- readyState: \`${c.readyState}\` · visibility: \`${c.visibility}\``);
  if (c.viewport) L.push(`- Viewport: ${c.viewport.w}×${c.viewport.h}, scrolled to ${c.scroll?.y ?? 0}`);
  if (c.counts) {
    L.push(`- DOM: ${c.counts.elements} elements, ${c.counts.inputs} inputs, ${c.counts.buttons} buttons, ${c.counts.iframes} iframes`);
  }
  L.push('');

  if (c.signals?.length) {
    /*
     * SIGNALS GO FIRST. They are the sentences on the page that most often
     * explain the failure outright — "You've reached your usage limit",
     * "Something went wrong", "Verifying you are human". A reader who sees
     * that line does not need the node list at all.
     */
    L.push('**Page is saying:**');
    for (const s of c.signals) L.push(`- ${s}`);
    L.push('');
  }

  /*
   * SELECTOR CHECK BEFORE THE NODE DUMP.
   *
   * A reader debugging a stuck run wants "did my selectors match" before they
   * want a table of 400 elements. Rendered as a table with an explicit verdict
   * per selector, and the miss case called out in words, because "found:
   * false" repeated four times is easy to skim past.
   */
  if (c.selectorCheck) {
    const sc = c.selectorCheck;
    L.push('**Shipped selectors, checked against this page:**');
    L.push('');
    L.push('| role | selector | result |');
    L.push('|---|---|---|');
    for (const role of ['composer', 'send', 'stop']) {
      for (const r of sc[role] || []) {
        L.push(`| ${role} | \`${r.sel}\` | ${r.found ? 'found' : '**no match**'} |`);
      }
      if (!(sc[role] || []).length) L.push(`| ${role} | _none configured_ | — |`);
    }
    for (const r of sc.turns || []) {
      L.push(`| turns | \`${r.sel}\` | ${r.count > 0 ? `${r.count} node(s)` : '**no match**'} |`);
    }
    L.push('');

    const dead = (role) => (sc[role] || []).length && (sc[role] || []).every((r) => !r.found);
    const noTurns = (sc.turns || []).length && (sc.turns || []).every((r) => !r.count);
    const broken = ['composer', 'send', 'stop'].filter(dead);
    if (noTurns) broken.push('turns');
    if (broken.length) {
      L.push(`> **No selector matched for: ${broken.join(', ')}.** That is an extension fault, `
        + 'not a fault of the page or the model — these selector lists need updating.');
      L.push('');
    }
  }

  if (c.nodes?.length) {
    L.push('**Interactive elements:**');
    L.push('');
    L.push('| element | state | label / text |');
    L.push('|---|---|---|');
    for (const n of c.nodes) {
      const id = [n.tag, n.testid && `[data-testid=${n.testid}]`, n.id && `#${n.id}`, n.role && `(${n.role})`]
        .filter(Boolean).join(' ');
      const state = [
        n.disabled && 'disabled',
        n.hidden && 'hidden',
        n.editable && 'editable',
        n.box && n.box.h === 0 && 'zero-height',
        n.box && n.box.y < 0 && 'above viewport',
      ].filter(Boolean).join(', ') || '—';
      L.push(`| \`${id}\` | ${state} | ${(n.label || n.text || '').slice(0, 90)} |`);
    }
    L.push('');
  }

  if (c.truncated?.nodes) {
    L.push(`_${c.truncated.nodes} further element(s) not recorded${c.truncated.bytes ? ' (size limit)' : ''}._`);
    L.push('');
  }

  return L.join('\n');
}

/**
 * What changed between two scans of the same surface.
 *
 * The second failure on a surface is far more informative as a DIFF: "the send
 * button became disabled and a rate-limit banner appeared" is a diagnosis,
 * whereas two full captures are two haystacks the reader must compare by eye.
 */
/**
 * Phrases that mean "the account is throttled", not "the extension is broken".
 *
 * Concepts, not exact wording -- matching a provider's precise sentence would
 * rot the moment they reword it.
 */
const RATE_LIMITED = [
  'rate limit', 'usage limit', 'too many requests', 'out of credits',
  'upgrade to', 'quota', 'you have reached', "you've reached",
  'limit reached', 'try again later',
];

/** Phrases that mean the session is gone -- a different remedy entirely. */
const SIGNED_OUT = ['sign in', 'log in', 'session expired', 'verify you are human'];

/**
 * CLASSIFY WHAT THE PAGE IS SAYING.
 *
 * The scanner has always collected these sentences and nothing ever acted on
 * them: a rate limit was reported as a generic failure, so the recovery ladder
 * retried -- burning the little quota that remained -- and the user was told
 * the extension had failed when in fact their account was throttled.
 *
 * The distinction that matters is WAITING vs FIXING. A rate limit resolves by
 * itself given time; a broken selector never does. Retrying the first is
 * harmful and retrying the second is pointless, so they must not share a
 * verdict.
 *
 * @param {{signals?: string[]}} capture
 * @returns {{kind: 'rate-limited'|'signed-out'|null, why: string, retry: boolean, evidence: string|null}}
 */
export function classifySignals(capture) {
  const signals = capture?.signals || [];
  const hay = signals.map((s) => String(s).toLowerCase());

  const hit = (needles) => {
    for (let i = 0; i < hay.length; i++) {
      for (const n of needles) if (hay[i].includes(n)) return signals[i];
    }
    return null;
  };

  /*
   * Rate limiting is checked FIRST. A throttled page very often also shows a
   * sign-in prompt in its chrome, and telling the user to re-authenticate when
   * the real problem is quota sends them somewhere that cannot help.
   */
  const limited = hit(RATE_LIMITED);
  if (limited) {
    return {
      kind: 'rate-limited',
      why: 'the page says the account has hit a usage limit — this is not an extension fault, '
        + 'and retrying now would spend what is left of the quota',
      retry: false,
      evidence: String(limited).slice(0, 200),
    };
  }

  const out = hit(SIGNED_OUT);
  if (out) {
    return {
      kind: 'signed-out',
      why: 'the page is asking you to sign in or prove you are human — the run cannot proceed until you do',
      retry: false,
      evidence: String(out).slice(0, 200),
    };
  }

  return { kind: null, why: '', retry: true, evidence: null };
}

export function diffCaptures(before, after) {
  if (!before || !after) return null;
  /*
   * The key must be unique for matching AND readable, because it is printed
   * verbatim in the diff. Concatenating the identifier onto the full path
   * produced lines like `textarea[composer]main > form > div > textarea`,
   * which is unique, correct, and unpleasant to read -- and the whole point of
   * the diff is that a human or a model reads it. Separated with a space.
   */
  const key = (n) => {
    const id = `${(n.tag || '').toLowerCase()}${n.testid ? `[${n.testid}]` : ''}${n.id ? `#${n.id}` : ''}`;
    return n.path && n.path !== id ? `${id} @ ${n.path}` : id;
  };
  const b = new Map((before.nodes || []).map((n) => [key(n), n]));
  const a = new Map((after.nodes || []).map((n) => [key(n), n]));

  const appeared = [...a.keys()].filter((k) => !b.has(k));
  const vanished = [...b.keys()].filter((k) => !a.has(k));
  const changed = [];
  for (const [k, n] of a) {
    const o = b.get(k);
    if (!o) continue;
    if (o.disabled !== n.disabled) changed.push(`${k}: ${o.disabled ? 'enabled' : 'became disabled'}`);
    else if (o.text !== n.text) changed.push(`${k}: text changed`);
  }

  const newSignals = (after.signals || []).filter((s) => !(before.signals || []).includes(s));

  return {
    appeared: appeared.slice(0, 20),
    vanished: vanished.slice(0, 20),
    changed: changed.slice(0, 20),
    newSignals,
    unchanged: appeared.length === 0 && vanished.length === 0 && changed.length === 0 && newSignals.length === 0,
  };
}

/** One-line description for the Activity Log entry itself. */
export function describeCapture(c) {
  if (!c) return 'scan failed';
  const bits = [`${c.counts?.elements ?? 0} elements`];
  if (c.signals?.length) bits.push(`${c.signals.length} page message(s)`);
  const blocked = (c.nodes || []).filter((n) => n.disabled).length;
  if (blocked) bits.push(`${blocked} disabled control(s)`);
  if (c.readyState && c.readyState !== 'complete') bits.push(`readyState=${c.readyState}`);
  if (c.visibility && c.visibility !== 'visible') bits.push(`tab ${c.visibility}`);
  return `Captured ${c.surface}: ${bits.join(', ')}`;
}
