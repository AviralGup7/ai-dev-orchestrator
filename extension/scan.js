/**
 * THE DOM SCANNER.
 *
 * Runs inside the page via `chrome.scripting.executeScript` and returns a
 * plain object. All the judgement — what to keep, when scanning is allowed,
 * how to render it — lives in `src/core/surface.js`, which is testable without
 * a browser. This file only reads.
 *
 * WHY IT IS A SUMMARY AND NOT `document.documentElement.outerHTML`
 * ---------------------------------------------------------------
 * The obvious implementation is to grab the whole page. It is also useless:
 * a chat page is tens of thousands of nodes of minified class soup, it would
 * exhaust the log's storage in a handful of errors, and pasting it to a model
 * burns thousands of tokens to convey almost nothing.
 *
 * The question a scan must answer is "why did the automation get stuck", and
 * the answer is nearly always one of: the composer moved, the send button is
 * disabled, a banner appeared, the page is still loading, or the tab was
 * backgrounded. So the scanner collects exactly those things.
 *
 * READ-ONLY, AND STRUCTURALLY SO. No click, no focus, no scroll, no
 * dispatchEvent, no style mutation. A diagnostic that perturbs the thing it is
 * diagnosing is worse than no diagnostic — and this one runs precisely when
 * something is already wrong.
 */

import { SELECTORS } from '../src/transports/dom.js';

/**
 * The function injected into the page.
 *
 * Self-contained on purpose: `executeScript` serialises it, so it may not
 * close over anything from this module.
 */
export function scanPage(selectors = { composer: [], send: [], stop: [], turns: [] }, { maxNodes = 400, maxDepth = 40, maxText = 400 } = {}) {
  const out = {
    at: Date.now(),
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    viewport: { w: innerWidth, h: innerHeight },
    counts: {},
    signals: [],
    nodes: [],
    depthCapped: false,
  };

  const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, maxText);

  /* ---- what the page is saying ---------------------------------------- */

  /*
   * Live regions and alerts first: this is where a site puts "You've reached
   * your usage limit" or "Something went wrong". These sentences frequently
   * explain the failure outright, making the rest of the scan unnecessary.
   */
  for (const el of document.querySelectorAll('[role="alert"], [role="status"], [aria-live], .error, .warning, [class*="error" i], [class*="limit" i], [class*="banner" i]')) {
    const t = clip(el.innerText || el.textContent);
    if (t && t.length > 2 && t.length < 400) out.signals.push(t);
  }

  /*
   * Phrases worth finding even when they are not in a marked-up region.
   * Deliberately short and generic: matching a site's exact wording would rot
   * the moment they reword it, and these are the concepts, not the strings.
   */
  const NEEDLES = [
    'rate limit', 'usage limit', 'too many requests', 'try again later',
    'something went wrong', 'unable to', 'failed to', 'network error',
    'sign in', 'log in', 'session expired', 'verify you are human',
    'upgrade to', 'out of credits', 'quota',
  ];
  const body = clip(document.body?.innerText || '').toLowerCase();
  for (const n of NEEDLES) {
    const i = body.indexOf(n);
    if (i !== -1) out.signals.push(`…${body.slice(Math.max(0, i - 60), i + 90)}…`);
  }
  out.signals = [...new Set(out.signals)].slice(0, 40);

  /* ---- interactive elements ------------------------------------------- */

  const INTERESTING = 'textarea, input, button, [contenteditable="true"], [role="textbox"], [role="button"], form, [data-testid], [aria-disabled]';

  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { seg += `#${cur.id}`; parts.unshift(seg); break; }
      const testid = cur.getAttribute?.('data-testid');
      if (testid) seg += `[${testid}]`;
      parts.unshift(seg);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };

  const depthOf = (el) => {
    let d = 0;
    let cur = el;
    while (cur.parentElement && d <= maxDepth + 1) { cur = cur.parentElement; d++; }
    return d;
  };

  /*
   * RANK BEFORE TRUNCATING.
   *
   * The first version walked the document in order and stopped at 400 nodes.
   * On a real Arena page -- 113,671 elements, 5,245 buttons -- that budget was
   * entirely consumed by sidebar chrome ("Toggle Sidebar", eleven hidden "More
   * options") before reaching the composer. The capture was technically
   * correct and diagnostically worthless: it could not answer the one question
   * a scan exists to answer, which is "where is the composer and can it be
   * typed into".
   *
   * Depth 12 made it worse: the composer in a React app of that size sits far
   * deeper, so it was not merely out-budget, it was excluded outright.
   *
   * So: score every candidate by how likely it is to matter, sort, then take
   * the top N. A composer, a send button and a visible error beat a hidden
   * sidebar toggle regardless of where they appear in the DOM.
   */
  const score = (el, box, hidden) => {
    let n = 0;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') n += 100;
    if (el.getAttribute('data-testid')) n += 40;
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
    if (/send|submit|message|prompt|ask|chat|run/.test(label)) n += 60;
    if (/stop|cancel|abort/.test(label)) n += 50;
    if (el.tagName === 'FORM') n += 30;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') n += 25;
    if (el.id) n += 15;
    if (hidden) n -= 40;
    /* Controls near the bottom of the viewport are usually the composer. */
    if (!hidden && box.top > innerHeight * 0.5) n += 20;
    if (box.width > 200 && box.height > 20) n += 10;
    return n;
  };

  const candidates = [];
  for (const el of document.querySelectorAll(INTERESTING)) {
    if (depthOf(el) > maxDepth) { out.depthCapped = true; continue; }
    const box = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const hidden = st.display === 'none' || st.visibility === 'hidden' ||
      Number(st.opacity) === 0 || (box.width === 0 && box.height === 0);
    candidates.push({ el, box, st, hidden, rank: score(el, box, hidden) });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  out.considered = candidates.length;

  for (const c of candidates) {
    if (out.nodes.length >= maxNodes) break;
    const el = c.el;

    const { box, hidden } = c;

    out.nodes.push({
      path: pathOf(el),
      tag: el.tagName,
      role: el.getAttribute('role') || undefined,
      id: el.id || undefined,
      testid: el.getAttribute('data-testid') || undefined,
      /*
       * `placeholder` and `aria-label` before text: a composer is usually an
       * empty box whose only identity is its placeholder, and that is the one
       * element an automation most needs to find.
       */
      label: clip(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || ''),
      text: clip((el.innerText || el.value || '').slice(0, maxText)),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
      hidden: hidden || undefined,
      editable: el.isContentEditable || el.tagName === 'TEXTAREA' || undefined,
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      rank: c.rank,
    });
  }

  out.counts = {
    elements: document.querySelectorAll('*').length,
    inputs: document.querySelectorAll('input, textarea, [contenteditable="true"]').length,
    buttons: document.querySelectorAll('button, [role="button"]').length,
    /*
     * iframes are called out because they are a silent cause of "the selector
     * matched nothing": the composer is in a frame and the scan (and the
     * automation) was looking at the top document.
     */
    iframes: document.querySelectorAll('iframe').length,
  };

  /*
   * Whether the transport's own selectors resolve, reported directly.
   *
   * The scan is read by a human trying to fix a broken selector, and "is the
   * selector I ship actually matching anything on this page" is the question
   * they have. Answering it from a node dump is guesswork; answering it here
   * is one line.
   */
  out.selectorCheck = {
    composer: selectors.composer.map((sel) => ({ sel, found: Boolean(document.querySelector(sel)) })),
    send: selectors.send.map((sel) => ({ sel, found: Boolean(document.querySelector(sel)) })),
    stop: selectors.stop.map((sel) => ({ sel, found: Boolean(document.querySelector(sel)) })),
    turns: selectors.turns.map((sel) => ({ sel, count: document.querySelectorAll(sel).length })),
  };

  return out;
}

/**
 * Run the scan in a tab.
 *
 * `chrome.scripting.executeScript` requires the `scripting` permission, which
 * was removed from the manifest last session because nothing used it. It is
 * back, and the build no longer strips it — with the justification recorded in
 * docs/SURFACE-SCAN.md rather than left implicit. Injecting into a page is a
 * real capability and the install prompt should reflect it honestly.
 *
 * @param {number} tabId
 * @param {object} [options]  may carry `surface` so the right selectors are checked
 */
export async function scanTab(tabId, options = {}) {
  const { surface, ...opts } = options;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanPage,
    /*
     * `selectors` is passed explicitly. The selectorCheck block inside
     * scanPage reads it, and the injected function is SERIALISED — it closes
     * over nothing, so anything it needs must arrive as an argument.
     *
     * Omitting it threw `selectors is not defined` inside the page, which
     * surfaces as a failed scan at the exact moment a scan is being taken
     * because something else already went wrong. Caught by a test that drives
     * the real injected function rather than asserting on its source.
     */
    args: [SELECTORS[surface] ?? { composer: [], send: [], stop: [], turns: [] }, opts],
    /*
     * MAIN world, not the isolated one.
     *
     * The isolated world sees the same DOM, so for reading markup either
     * works — but computed styles of elements inside open shadow roots and
     * some framework-managed attributes are more faithfully observed from the
     * main world. It also matches what an eventual automation adapter will
     * have to use, so what the scan sees is what the driver would see.
     */
    world: 'MAIN',
  });

  if (!result) throw new Error('the page returned no scan result');
  if (result.error) throw new Error(String(result.error));
  return result.result;
}
