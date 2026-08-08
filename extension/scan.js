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

/**
 * The function injected into the page.
 *
 * Self-contained on purpose: `executeScript` serialises it, so it may not
 * close over anything from this module.
 */
export function scanPage({ maxNodes = 400, maxDepth = 12, maxText = 400 } = {}) {
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

  const all = document.querySelectorAll(INTERESTING);
  for (const el of all) {
    if (out.nodes.length >= maxNodes) break;
    if (depthOf(el) > maxDepth) { out.depthCapped = true; continue; }

    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hidden = style.display === 'none' || style.visibility === 'hidden' ||
      Number(style.opacity) === 0 || (box.width === 0 && box.height === 0);

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
 * @param {object} [options]
 */
export async function scanTab(tabId, options = {}) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanPage,
    args: [options],
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
