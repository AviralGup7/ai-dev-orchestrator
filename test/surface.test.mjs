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

import {
  ScanBudget, boundCapture, renderCapture, diffCaptures, describeCapture,
  SCAN_WORTHY, NEVER_SCAN, SCAN_DEFAULTS,
} from '../src/core/surface.js';
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
