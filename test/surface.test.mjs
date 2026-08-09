/**
 * Surface scans.
 *
 * Two hazards dominate this file, and both would be quiet:
 *
 *   1. THE LOOP. The trigger is "an error was logged", and a failed scan logs
 *      an error. Left alone the extension fills IndexedDB with failure reports
 *      about its own failure reports.
 *   2. THE LEAK. A scan copies whatever is on screen into a log the user is
 *      encouraged to paste into a chat window. Whatever is on screen includes
 *      the AI's output, and an AI asked to fix a build will happily echo back
 *      an .env file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ScanBudget, boundCapture, renderCapture, diffCaptures, describeCapture,
  SCAN_WORTHY, NEVER_SCAN, SCAN_DEFAULTS, classifySignals } from '../src/core/surface.js';
import { Journal } from '../src/core/journal.js';
import { makeEvent } from '../src/core/events.js';

const err = (type, extra = {}) => ({ ...makeEvent(type, { status: 'error', ...extra }), id: 'evt-1' });

const rawCapture = (over = {}) => ({
  at: 1700000000000,
  surface: 'engineer',
  url: 'https://arena.ai/w/ws-7',
  title: 'reporting-service',
  readyState: 'complete',
  visibility: 'visible',
  scroll: { x: 0, y: 320 },
  viewport: { w: 1440, h: 900 },
  counts: { elements: 4821, inputs: 2, buttons: 14, iframes: 0 },
  signals: ['You have reached your usage limit for today.'],
  nodes: [
    { path: 'form > textarea[composer]', tag: 'TEXTAREA', testid: 'composer', label: 'Send a message', editable: true, box: { x: 20, y: 700, w: 900, h: 60 } },
    { path: 'form > button[send]', tag: 'BUTTON', testid: 'send', label: 'Send', disabled: true, box: { x: 940, y: 700, w: 40, h: 40 } },
  ],
  ...over,
});

/* ========================================================================== *
 * WHEN A SCAN IS ALLOWED
 * ========================================================================== */

test('a page-level error triggers a scan; a success never does', () => {
  const b = new ScanBudget();
  assert.equal(b.may(err('response-timeout')).allowed, true);
  assert.equal(b.may(makeEvent('response-received')).allowed, false);
});

test('only page-level failures are scanned, not every error', () => {
  /*
   * A storage quota failure has nothing to do with the DOM. Scanning for it
   * spends budget a real UI failure will need later and tells the reader
   * nothing.
   */
  const b = new ScanBudget();

  /*
   * `crash-recovered` is the right example, and picking it took a sabotage to
   * discover. The first version used `state-saved` -- which is ALSO in
   * NEVER_SCAN, so the earlier guard rejected it and the allow-list under test
   * was never reached. Removing the allow-list check entirely left the suite
   * green. An error type that is merely not-page-level, and not separately
   * banned, is the only thing that exercises this branch.
   */
  const notPageLevel = b.may(err('crash-recovered'));
  assert.equal(notPageLevel.allowed, false);
  assert.match(notPageLevel.why, /not a page-level failure/);

  for (const t of SCAN_WORTHY) {
    assert.equal(new ScanBudget().may(err(t)).allowed, true, `${t} should be scannable`);
  }
});

test('A SCAN FAILURE CANNOT TRIGGER ANOTHER SCAN', () => {
  /*
   * THE INFINITE LOOP. The trigger is an error; a failed scan logs an error.
   * Because the log "must never silently discard events", the extension would
   * faithfully fill the disk with reports about its own reports.
   */
  const b = new ScanBudget();
  const v = b.may(err('surface-scan-failed'));
  assert.equal(v.allowed, false);
  assert.match(v.why, /must never trigger/);
  assert.ok(NEVER_SCAN.has('surface-scan'));
  assert.ok(NEVER_SCAN.has('surface-scan-failed'));
});

test('a scan already in flight blocks another — the reentrancy latch', () => {
  const b = new ScanBudget();
  b.begin('engineer');
  assert.match(b.may(err('response-timeout', { source: 'chatgpt' })).why, /already running/);
  b.end();
  assert.equal(b.may(err('response-timeout', { source: 'chatgpt' })).allowed, true);
});

test('the same surface is not rescanned within the cooldown', () => {
  /*
   * A stuck automation retries. Without a cooldown, five retries in ten
   * seconds produce five near-identical captures and bury the first one.
   */
  const b = new ScanBudget({ cooldownMs: 30_000 });
  const t0 = 1_000_000;
  b.begin('engineer', t0);
  b.end();

  const e = err('response-timeout', { source: 'arena' });
  e.surface = 'engineer';
  assert.equal(b.may(e, t0 + 5_000).allowed, false);
  assert.equal(b.may(e, t0 + 31_000).allowed, true);

  // A DIFFERENT surface is unaffected.
  const other = err('response-timeout');
  other.surface = 'manager';
  assert.equal(b.may(other, t0 + 5_000).allowed, true);
});

test('the session budget is finite', () => {
  const b = new ScanBudget({ maxPerSession: 3, cooldownMs: 0 });
  for (let i = 0; i < 3; i++) { b.begin(`s${i}`); b.end(); }
  const v = b.may(err('response-timeout'));
  assert.equal(v.allowed, false);
  assert.match(v.why, /budget of 3/);
});

test('declined scans are counted, so the feature cannot look broken silently', () => {
  /*
   * This project has already shipped a control that did nothing. A feature
   * that quietly declines to run is indistinguishable from one that is
   * broken, so the reasons are reported in the session summary.
   */
  const b = new ScanBudget();
  b.may(err('state-saved'));
  b.may(makeEvent('response-received'));
  const s = b.summary();
  assert.equal(s.used, 0);
  assert.ok(Object.keys(s.declined).length >= 1);
});

/* ========================================================================== *
 * BOUNDING AND REDACTION
 * ========================================================================== */

test('A CAPTURE IS REDACTED — it is going into a log meant for pasting', () => {
  /*
   * THE LEAK. The scan copies what is on screen, and what is on screen is the
   * AI's output. An engineer asked to fix CI will echo back the .env file it
   * read.
   */
  const { capture } = boundCapture(rawCapture({
    signals: ['export GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    title: 'key sk-abcdefghijklmnopqrstuvwx',
    url: 'https://user:ghp_zzzzzzzzzzzzzzzz@arena.ai/w/7',
    nodes: [{ path: 'p', tag: 'PRE', text: 'GOCSPX-abcdefghijklmnop' }],
  }));

  const rendered = renderCapture(capture);
  assert.equal(/ghp_A/.test(rendered), false);
  assert.equal(/sk-abcdefghijklmnop/.test(rendered), false);
  assert.equal(rendered.includes('GOCSPX-abcdefghijklmnop'), false);
  assert.equal(/ghp_z/.test(rendered), false);
  assert.match(rendered, /REDACTED/);
});

test('a capture is bounded in nodes and in bytes', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    path: `div > button#b${i}`, tag: 'BUTTON', text: 'x'.repeat(600),
  }));
  const { capture } = boundCapture(rawCapture({ nodes: many, counts: { elements: 90000 } }));

  assert.ok(capture.nodes.length <= SCAN_DEFAULTS.maxNodes);
  assert.ok(capture.truncated.nodes > 0, 'and it says how much it dropped');
  assert.ok(renderCapture(capture).length <= SCAN_DEFAULTS.maxBytes * 1.1);
  for (const n of capture.nodes) {
    assert.ok((n.text || '').length <= SCAN_DEFAULTS.maxText + 1);
  }
});

test('when trimming for size, the SIGNALS survive and nodes are dropped', () => {
  /*
   * The header and the page's own messages are what a reader needs first;
   * the node list is the detail they drill into. Truncating the document from
   * the end would cut the signals off — the opposite of useful.
   */
  const { capture } = boundCapture(rawCapture({
    signals: ['You have reached your usage limit for today.'],
    nodes: Array.from({ length: 400 }, (_, i) => ({ path: `b${i}`, tag: 'BUTTON', text: 'y'.repeat(390) })),
  }), { maxBytes: 4000 });

  const out = renderCapture(capture);
  assert.match(out, /usage limit/, 'the explanation must survive trimming');
  assert.ok(capture.truncated.bytes);
});

test('an empty scan result is a reported problem, not a silent empty capture', () => {
  assert.equal(boundCapture(null).ok, false);
  assert.match(boundCapture(null).problem, /returned nothing/);
});

/* ========================================================================== *
 * RENDERING
 * ========================================================================== */

test('the rendered capture leads with what the page is saying', () => {
  const { capture } = boundCapture(rawCapture());
  const out = renderCapture(capture);
  const saying = out.indexOf('Page is saying');
  const elements = out.indexOf('Interactive elements');
  assert.ok(saying > -1 && saying < elements, 'the explanation goes above the detail');
  assert.match(out, /usage limit/);
});

test('the rendered capture shows WHY a control could not be used', () => {
  const { capture } = boundCapture(rawCapture());
  const out = renderCapture(capture);
  assert.match(out, /\[data-testid=send\]/);
  assert.match(out, /disabled/);
  assert.match(out, /readyState/);
});

test('geometry problems are named, because they explain a click that did nothing', () => {
  const { capture } = boundCapture(rawCapture({
    nodes: [
      { path: 'a', tag: 'BUTTON', testid: 'send', box: { x: 10, y: -400, w: 40, h: 40 } },
      { path: 'b', tag: 'BUTTON', testid: 'stop', box: { x: 10, y: 10, w: 40, h: 0 } },
    ],
  }));
  const out = renderCapture(capture);
  assert.match(out, /above viewport/);
  assert.match(out, /zero-height/);
});

test('the one-line description summarises without needing the detail', () => {
  const { capture } = boundCapture(rawCapture({ readyState: 'loading', visibility: 'hidden' }));
  const d = describeCapture(capture);
  assert.match(d, /engineer/);
  assert.match(d, /disabled control/);
  assert.match(d, /readyState=loading/);
  assert.match(d, /tab hidden/);
});

/* ========================================================================== *
 * DIFFS
 * ========================================================================== */

test('a repeat failure is reported as what CHANGED', () => {
  /*
   * "The send button became disabled and a rate-limit banner appeared" is a
   * diagnosis. Two full captures are two haystacks the reader compares by eye.
   */
  const before = boundCapture(rawCapture({ signals: [], nodes: [
    { path: 'form > button[send]', tag: 'BUTTON', testid: 'send', label: 'Send' },
  ] })).capture;
  const after = boundCapture(rawCapture({ signals: ['You have reached your usage limit for today.'], nodes: [
    { path: 'form > button[send]', tag: 'BUTTON', testid: 'send', label: 'Send', disabled: true },
    { path: 'div[banner]', tag: 'DIV', testid: 'banner', text: 'Upgrade for more' },
  ] })).capture;

  const d = diffCaptures(before, after);
  assert.equal(d.unchanged, false);
  assert.ok(d.changed.some((c) => /became disabled/.test(c)));
  assert.equal(d.appeared.length, 1);
  assert.equal(d.newSignals.length, 1);
});

test('an identical page is reported as STUCK, which is itself the finding', () => {
  const c = boundCapture(rawCapture()).capture;
  const d = diffCaptures(c, boundCapture(rawCapture()).capture);
  assert.equal(d.unchanged, true);
});

/* ========================================================================== *
 * THE JOURNAL
 * ========================================================================== */

test('captures appear in the exported markdown, above the timeline', () => {
  const j = new Journal();
  const { capture } = boundCapture(rawCapture());
  j.record({
    type: 'surface-scan', at: Date.now(), status: 'warning',
    data: { capture, markdown: renderCapture(capture), becauseOf: 'response-timeout', diff: null },
  });
  const md = j.render(null, null);

  const captures = md.indexOf('## Page captures');
  const timeline = md.indexOf('## Timeline');
  assert.ok(captures > -1, 'the capture must reach the export');
  assert.ok(captures < timeline);
  assert.match(md, /Captured because/);
  assert.match(md, /usage limit/);
});

test('a stuck page is called out in the export in one line', () => {
  const j = new Journal();
  const c = boundCapture(rawCapture()).capture;
  j.record({
    type: 'surface-scan', at: Date.now(), status: 'warning',
    data: { capture: c, markdown: renderCapture(c), diff: diffCaptures(c, c) },
  });
  assert.match(j.render(null, null), /the page is stuck/);
});

test('the journal redacts a capture again on the way out', () => {
  /*
   * Belt and braces: boundCapture redacts, and the journal redacts everything
   * it renders. A capture that reached the log by some other path — a future
   * caller that forgets — still cannot leak through the export.
   */
  const j = new Journal();
  j.record({
    type: 'surface-scan', at: Date.now(), status: 'warning',
    data: { capture: { surface: 'x' }, markdown: 'token ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
  });
  assert.equal(/ghp_B/.test(j.render(null, null)), false);
});

/* ============================ ranking on a real page (session 12) ======= */

test('THE COMPOSER SURVIVES TRUNCATION ON A HUGE PAGE', async () => {
  /*
   * THE REPORTED FAILURE. A real Arena page reported 113,671 elements and
   * 5,245 buttons. The scan captured 22 nodes — all sidebar chrome: "Toggle
   * Sidebar" and eleven hidden "More options". The composer never appeared.
   *
   * The capture was technically correct and diagnostically worthless: it could
   * not answer the only question a scan exists to answer, which is "where is
   * the composer and can it be typed into". Document order filled the budget
   * with noise before reaching anything that mattered.
   *
   * Ranking must put the composer in the capture even when it is element
   * 90,000 of 113,671.
   */
  const noise = Array.from({ length: 5000 }, (_, i) => ({
    path: `div > button#sidebar-${i}`, tag: 'BUTTON',
    label: i % 2 ? 'More options' : 'Toggle Sidebar',
    hidden: i % 2 === 1,
    box: { x: 0, y: 10, w: 24, h: 24 },
    rank: -30,
  }));
  const composer = {
    path: 'main > form > div > textarea', tag: 'TEXTAREA', testid: 'composer',
    label: 'Message Arena…', editable: true,
    box: { x: 280, y: 820, w: 940, h: 56 },
    rank: 210,
  };
  const send = {
    path: 'main > form > button', tag: 'BUTTON', testid: 'send-button', label: 'Send',
    box: { x: 1240, y: 826, w: 44, h: 44 }, rank: 130,
  };

  /*
   * The scanner sorts before truncating, so the bounded capture is fed
   * already-ranked nodes. This asserts the BOUNDING step keeps what matters
   * rather than the first N.
   */
  const { capture } = boundCapture({
    ...rawCapture(),
    counts: { elements: 113671, inputs: 3, buttons: 5245, iframes: 5 },
    nodes: [composer, send, ...noise].sort((a, b) => b.rank - a.rank),
  });

  const rendered = renderCapture(capture);
  assert.match(rendered, /composer/, 'the composer must survive truncation');
  assert.match(rendered, /send-button/, 'and so must the send control');
  assert.ok(capture.truncated.nodes > 4000, 'the noise is dropped and the drop is reported');
});

test('the scanner ranks a composer above sidebar chrome', async () => {
  /*
   * The ranking itself, run against the shape of the real page. Exercised
   * through the injected function with a minimal DOM rather than asserted
   * from the source, because the source is a string until it runs.
   */
  const { scanPage } = await import('../extension/scan.js');

  const el = (tag, attrs = {}, depth = 20) => ({
    tagName: tag,
    id: attrs.id || '',
    disabled: attrs.disabled || false,
    isContentEditable: attrs.editable || false,
    innerText: attrs.text || '',
    value: '',
    parentElement: depth > 0 ? el('DIV', {}, depth - 1) : null,
    getAttribute: (k) => attrs[k] ?? null,
    getBoundingClientRect: () => attrs.box || { x: 0, y: 0, width: 24, height: 24, top: 10, left: 0 },
  });

  const composer = el('TEXTAREA', {
    'data-testid': 'composer', placeholder: 'Message Arena…', editable: true,
    box: { x: 280, y: 820, width: 940, height: 56, top: 820, left: 280 },
  }, 25);
  const sidebar = el('BUTTON', { 'aria-label': 'Toggle Sidebar' }, 4);

  const nodes = [sidebar, composer];
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('textarea') || sel.includes('data-testid') ? nodes : []),
    title: 'Arena',
    body: { innerText: '' },
    documentElement: {},
    visibilityState: 'visible',
    readyState: 'complete',
  };
  globalThis.location = { href: 'https://arena.ai/agent/019fa9f8' };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  globalThis.innerWidth = 1512;
  globalThis.innerHeight = 944;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;

  /*
   * `scanPage(selectors, options)` — the selectors argument is required; the
   * injected function reads it for both the probe and the selectorCheck.
   */
  const { SELECTORS } = await import('../src/transports/dom.js');
  const out = scanPage(SELECTORS.engineer, { maxNodes: 1, maxDepth: 40 });
  assert.equal(out.nodes.length, 1, 'budget of one node');
  assert.equal(out.nodes[0].testid, 'composer',
    'with room for exactly one element it must keep the composer, not the sidebar toggle');
});

test('a deep composer is not excluded by the depth cap', async () => {
  /*
   * Depth 12 excluded the composer outright on a real React app of that size —
   * it was not merely out of budget, it was never a candidate.
   */
  const scanSrc = readFileSync(new URL('../extension/scan.js', import.meta.url), 'utf8');
  const m = /maxDepth = (\d+)/.exec(scanSrc);
  assert.ok(m, 'maxDepth must be declared');
  assert.ok(Number(m[1]) >= 30,
    `maxDepth is ${m[1]} — a composer in a real React tree sits deeper than that`);
});

test('the capture reports whether the shipped selectors matched', async () => {
  /*
   * The scan is read by a human fixing a broken selector, and their question
   * is "does the selector I ship match anything on this page". Answering that
   * from a node dump is guesswork.
   */
  const scanSrc = readFileSync(new URL('../extension/scan.js', import.meta.url), 'utf8');
  assert.match(scanSrc, /selectorCheck/);
  assert.match(scanSrc, /composer: selectors\.composer\.map/);
});

/* ---------------------------------------------------------------------------
 * ACTING ON WHAT THE PAGE SAYS
 *
 * The scanner has always collected "You've reached your usage limit" and
 * nothing consumed it. The failure was classified as generic, so the recovery
 * ladder retried — spending the little quota that remained — and the user was
 * told the extension had failed when their account was simply throttled.
 * ------------------------------------------------------------------------ */

test('A USAGE LIMIT IS CLASSIFIED AS A REASON TO WAIT, NOT TO RETRY', () => {
  const v = classifySignals({ signals: ["…you've reached your usage limit for GPT-5. Try again after 3pm…"] });

  assert.equal(v.kind, 'rate-limited');
  assert.equal(v.retry, false,
    'retrying a rate limit spends the quota that just ran out — the opposite of helping');
  assert.match(v.why, /not an extension fault/,
    'the user must not be sent to debug the extension over an account limit');
  assert.ok(v.evidence, 'the page text that triggered this must be quoted back');
});

test('a healthy page produces no verdict and stays retryable', () => {
  const v = classifySignals({ signals: ['New chat', 'Send a message'] });
  assert.equal(v.kind, null, 'ordinary page furniture must not be read as a fault');
  assert.equal(v.retry, true);
});

test('RATE LIMITING BEATS SIGN-IN when both appear', () => {
  /*
   * A throttled page very often also shows a "Log in" link in its chrome.
   * Diagnosing sign-in sends the user to re-authenticate, which cannot fix a
   * quota problem — so ordering here is load-bearing, not cosmetic.
   */
  const v = classifySignals({ signals: ['Log in', '…you have reached your usage limit…'] });
  assert.equal(v.kind, 'rate-limited',
    'the quota message is the actionable one; the sign-in link is furniture');
});

test('a real sign-out is still detected', () => {
  const v = classifySignals({ signals: ['Your session expired. Please sign in again.'] });
  assert.equal(v.kind, 'signed-out');
  assert.equal(v.retry, false);
});

test('classification survives missing and malformed input', () => {
  for (const input of [undefined, null, {}, { signals: null }, { signals: [] }]) {
    const v = classifySignals(input);
    assert.equal(v.kind, null, `${JSON.stringify(input)} must not throw or produce a verdict`);
  }
});

/* ---------------------------------------------------------------------------
 * THE LOG IS THE ONLY CHANNEL BACK FROM A REAL RUN.
 *
 * Whoever debugs an exported log cannot inspect the machine, re-run the
 * failure, or ask a question. Anything dropped on the way into the log is
 * simply unavailable — and dropping data is invisible, which is why it lasts.
 *
 * `selectorCheck` is computed inside the page by scanPage and was silently
 * discarded by boundCapture, which builds a new object rather than spreading
 * raw. It read `null` in all three surface scans across eight exported logs,
 * and each of those sessions was spent inferring from a node dump what this
 * field states outright.
 * ------------------------------------------------------------------------ */

const selCheck = {
  composer: [{ sel: '#prompt-textarea', found: true }],
  send: [{ sel: 'button[data-testid="send-button"]', found: false }],
  stop: [{ sel: 'button[data-testid="stop-button"]', found: false }],
  turns: [{ sel: '[data-message-author-role="assistant"]', count: 0 }],
};

test('SELECTOR CHECK SURVIVES INTO THE LOGGED CAPTURE', () => {
  const { capture } = boundCapture(rawCapture({ selectorCheck: selCheck }), {});
  assert.ok(capture.selectorCheck, 'it was null in every real log — the field must survive');
  assert.equal(capture.selectorCheck.composer[0].found, true);
  assert.equal(capture.selectorCheck.send[0].found, false);
  assert.equal(capture.selectorCheck.turns[0].count, 0);
});

test('the rendered scan states the selector verdict in words', () => {
  /*
   * The markdown is what gets pasted to whoever is debugging. "found: false"
   * repeated four times is easy to skim past; a sentence naming the roles that
   * matched nothing is not.
   */
  const { capture } = boundCapture(rawCapture({ selectorCheck: selCheck }), {});
  const md = renderCapture(capture);

  assert.match(md, /prompt-textarea/, 'the actual selector text must be present');
  assert.match(md, /no match/, 'a miss must be visible, not implied');
  assert.match(md, /send, stop, turns/, 'it must name exactly which roles matched nothing');
  assert.match(md, /extension fault/,
    'it must say whose bug this is — three sessions were spent blaming the model');
});

test('a scan with no selectorCheck still renders, and claims nothing', () => {
  /*
   * Older captures and failed injections have no selectorCheck. Absence must
   * not become a fabricated all-clear.
   */
  const { capture } = boundCapture(rawCapture({}), {});
  assert.equal(capture.selectorCheck, null);
  const md = renderCapture(capture);
  assert.doesNotMatch(md, /Shipped selectors/, 'no data means no section, not an empty verdict');
});

test('a fully matching selector set is NOT reported as a fault', () => {
  const good = {
    composer: [{ sel: '#prompt-textarea', found: true }],
    send: [{ sel: 'button#send', found: true }],
    stop: [{ sel: 'button#stop', found: true }],
    turns: [{ sel: '.assistant', count: 12 }],
  };
  const { capture } = boundCapture(rawCapture({ selectorCheck: good }), {});
  const md = renderCapture(capture);
  assert.doesNotMatch(md, /extension fault/, 'a healthy page must not be reported as broken');
  assert.match(md, /12 node\(s\)/);
});
