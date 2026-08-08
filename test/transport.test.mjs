/**
 * The DOM transport, tested without a browser.
 *
 * Completion detection is the hard part and every naive version is wrong in a
 * way that costs real damage — truncated reports, stale replies parsed as
 * fresh, or a run that hangs. The clock is injected so eight-second quiet
 * periods cost nothing to test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomTransport, TransportError, SELECTORS, DEFAULTS } from '../src/transports/dom.js';

/**
 * A scripted page. `frames` are returned one per read; the last repeats.
 * Time is virtual: `wait` advances the clock instead of sleeping.
 */
function fakePage(frames, { onType = () => {}, onClick = () => {} } = {}) {
  let i = 0;
  let clock = 0;
  const typed = [];
  const clicked = [];
  const page = {
    read: async () => frames[Math.min(i++, frames.length - 1)],
    type: async (surface, text) => { typed.push({ surface, text }); onType(text); },
    click: async (surface, which) => { clicked.push({ surface, which }); onClick(which); },
  };
  return {
    page, typed, clicked,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    advance: (ms) => { clock += ms; },
  };
}

const frame = (over = {}) => ({ composer: true, busy: false, turns: 1, lastText: 'previous answer', ...over });

test('a normal exchange types, submits and returns the reply', async () => {
  const f = fakePage([
    frame(),                                                    // before
    frame({ busy: true, turns: 2, lastText: 'thinking' }),      // new turn
    frame({ busy: true, turns: 2, lastText: 'partial ans' }),
    frame({ busy: false, turns: 2, lastText: 'the full answer' }),
    frame({ busy: false, turns: 2, lastText: 'the full answer' }),
    frame({ busy: false, turns: 2, lastText: 'the full answer' }),
    frame({ busy: false, turns: 2, lastText: 'the full answer' }),
    frame({ busy: false, turns: 2, lastText: 'the full answer' }),
  ]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });
  const out = await t.send({ prompt: 'hello', surface: 'manager' });

  assert.equal(out.text, 'the full answer');
  assert.equal(f.typed[0].text, 'hello');
  assert.deepEqual(f.clicked[0], { surface: 'manager', which: 'send' });
});

test('IT DOES NOT RETURN THE PREVIOUS ANSWER AS THE NEW ONE', async () => {
  /*
   * The stale-reply trap. If the page has not rendered the new turn yet, "the
   * last assistant message" is the PREVIOUS answer — and the adapter would
   * parse it as the response to a prompt it just sent. Anchoring on the turn
   * count is what prevents it.
   */
  const stale = Array.from({ length: 40 }, () => frame({ turns: 1, lastText: 'previous answer' }));
  const f = fakePage(stale);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });

  await assert.rejects(
    () => t.send({ prompt: 'x', surface: 'manager', timeoutMs: 10_000 }),
    (err) => {
      assert.equal(err.outcome, 'timed-out');
      assert.equal(err.detail.phase, 'no-turn', 'it must wait for a NEW turn, not accept the old one');
      return true;
    },
  );
});

test('a pause mid-answer is not mistaken for completion', async () => {
  /*
   * Models pause, especially while emitting code blocks. Stability alone would
   * fire during the pause and truncate the reply — and a truncated report that
   * parses is worse than one that fails, because the truncation is invisible
   * downstream.
   */
  const f = fakePage([
    frame(),
    frame({ busy: true, turns: 2, lastText: 'part one' }),
    frame({ busy: true, turns: 2, lastText: 'part one' }),   // pause, still busy
    frame({ busy: true, turns: 2, lastText: 'part one' }),
    frame({ busy: true, turns: 2, lastText: 'part one and two' }),
    frame({ busy: false, turns: 2, lastText: 'part one and two, complete' }),
    frame({ busy: false, turns: 2, lastText: 'part one and two, complete' }),
    frame({ busy: false, turns: 2, lastText: 'part one and two, complete' }),
    frame({ busy: false, turns: 2, lastText: 'part one and two, complete' }),
    frame({ busy: false, turns: 2, lastText: 'part one and two, complete' }),
  ]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });
  const out = await t.send({ prompt: 'x', surface: 'manager' });
  assert.equal(out.text, 'part one and two, complete', 'the pause must not truncate');
});

test('an UNKNOWN busy state waits longer before trusting stability', async () => {
  /*
   * `busy: undefined` means the stop-button selector broke. Collapsing that to
   * `busy: false` would make a broken selector look like an instantly-finished
   * response, returning the first streamed token as the whole answer.
   */
  const blind = { composer: true, turns: 2, lastText: 'settled text' }; // no `busy` key
  const f = fakePage([frame(), blind, blind, blind, blind, blind, blind, blind, blind, blind, blind, blind, blind, blind, blind]);
  const events = [];
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait, onEvent: (e) => events.push(e) });

  const out = await t.send({ prompt: 'x', surface: 'manager' });
  assert.equal(out.text, 'settled text');
  const settled = events.find((e) => e.type === 'response-settled');
  assert.equal(settled.blind, true);
  assert.equal(settled.quietMs, DEFAULTS.blindQuietMs, 'a blind transport must wait the longer period');
  assert.ok(DEFAULTS.blindQuietMs > DEFAULTS.quietMs);
});

test('a missing composer is a named failure, not a silent no-op', async () => {
  const f = fakePage([frame({ composer: false })]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });
  await assert.rejects(() => t.send({ prompt: 'x', surface: 'engineer' }), (err) => {
    assert.ok(err instanceof TransportError);
    assert.equal(err.outcome, 'failed');
    assert.match(err.message, /no composer found on the engineer page/);
    assert.ok(Array.isArray(err.detail.tried), 'it names the selectors it tried');
    return true;
  });
});

test('IT REFUSES TO TYPE INTO A PAGE THAT IS ALREADY GENERATING', async () => {
  /*
   * A busy page means the previous exchange never finished, or a human is
   * using the tab. Typing now interleaves two conversations.
   */
  const busy = Array.from({ length: 40 }, () => frame({ busy: true }));
  const f = fakePage(busy);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });

  await assert.rejects(() => t.send({ prompt: 'x', surface: 'manager', timeoutMs: 5_000 }));
  assert.equal(f.typed.length, 0, 'nothing may be typed into a busy page');
});

test('it waits for a busy page to finish, then proceeds', async () => {
  const f = fakePage([
    frame({ busy: true }),
    frame({ busy: true }),
    frame({ busy: false }),                                    // now idle
    frame({ busy: true, turns: 2, lastText: 'new' }),
    frame({ busy: false, turns: 2, lastText: 'new answer' }),
    frame({ busy: false, turns: 2, lastText: 'new answer' }),
    frame({ busy: false, turns: 2, lastText: 'new answer' }),
    frame({ busy: false, turns: 2, lastText: 'new answer' }),
    frame({ busy: false, turns: 2, lastText: 'new answer' }),
  ]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });
  const out = await t.send({ prompt: 'x', surface: 'manager' });
  assert.equal(out.text, 'new answer');
  assert.equal(f.typed.length, 1);
});

test('a reply that never settles times out rather than returning partial text', async () => {
  const streaming = Array.from({ length: 200 }, (_, i) =>
    frame({ busy: true, turns: 2, lastText: `token ${i}` }));
  const f = fakePage([frame(), ...streaming]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait });

  await assert.rejects(() => t.send({ prompt: 'x', surface: 'manager', timeoutMs: 20_000 }), (err) => {
    assert.equal(err.outcome, 'timed-out');
    assert.equal(err.detail.phase, 'never-settled');
    assert.equal(err.recoverable, true, 'a timeout is worth retrying');
    return true;
  });
});

test('an empty reply is a failure, not an empty success', async () => {
  const f = fakePage([
    frame({ lastText: 'old' }),
    frame({ busy: false, turns: 2, lastText: '' }),
    frame({ busy: false, turns: 2, lastText: '' }),
    frame({ busy: false, turns: 2, lastText: '' }),
    frame({ busy: false, turns: 2, lastText: '' }),
    frame({ busy: false, turns: 2, lastText: '' }),
  ]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait, config: { quietMs: 1 } });
  await assert.rejects(() => t.send({ prompt: 'x', surface: 'manager', timeoutMs: 10_000 }));
});

test('a transport failure is NOT marked recoverable', () => {
  /*
   * The runner reads `recoverable` to decide whether retrying makes sense. A
   * closed tab fails identically on the second attempt.
   */
  assert.equal(new TransportError('failed', 'tab closed').recoverable, false);
  assert.equal(new TransportError('timed-out', 'slow').recoverable, true);
});

test('every surface has a full selector set', () => {
  for (const surface of ['manager', 'engineer', 'reviewer']) {
    const s = SELECTORS[surface];
    for (const key of ['composer', 'send', 'stop', 'turns']) {
      assert.ok(Array.isArray(s[key]) && s[key].length > 0, `${surface}.${key} is empty`);
    }
    /*
     * Selectors will rot — that is unavoidable when driving someone else's
     * markup. Having several per role is what turns a redesign from an outage
     * into a degraded run.
     */
    assert.ok(s.composer.length >= 2, `${surface} needs fallback composer selectors`);
  }
});

test('the transport satisfies the same contract as the simulator', async () => {
  /*
   * The architectural claim: adapters cannot tell them apart, which is what
   * makes an official-API transport a later drop-in rather than a rewrite.
   */
  const { SimTransport } = await import('../src/sim/transport.js');
  const sim = new SimTransport();
  const f = fakePage([frame(), frame({ turns: 2, lastText: 'x' }), frame({ turns: 2, lastText: 'x' }),
    frame({ turns: 2, lastText: 'x' }), frame({ turns: 2, lastText: 'x' }), frame({ turns: 2, lastText: 'x' })]);
  const dom = new DomTransport({ page: f.page, now: f.now, wait: f.wait });

  for (const t of [sim, dom]) {
    assert.equal(typeof t.send, 'function');
    assert.equal(t.send.length <= 1, true, 'both take one options object');
  }
  const out = await dom.send({ prompt: 'p', surface: 'manager' });
  assert.equal(typeof out.text, 'string');
});

/* ================================ long-running tasks (session 12) ======= */

test('A MULTI-HOUR ENGINEERING TASK IS NOT KILLED AT FOUR MINUTES', async () => {
  /*
   * THE REPORTED BUG. A real Arena exploration task was cut off with
   * "engineer produced no reply within 240000ms". The log shows the prompt
   * pasted and submitted correctly — the transport worked perfectly and the
   * deadline was a fiction.
   *
   * Asking ChatGPT for a plan is one inference. Asking Arena to explore a
   * repository, build it and run its suite is real work that the user reports
   * can take hours. One flat budget for both was never defensible.
   */
  const { DEFAULT_POLICY } = await import('../src/adapters/base.js');
  assert.ok(DEFAULT_POLICY.timeouts.engineer >= 2 * 3600_000,
    `engineer budget is ${DEFAULT_POLICY.timeouts.engineer}ms — a build and a test suite need hours`);
  assert.ok(DEFAULT_POLICY.timeouts.manager <= 600_000,
    'a conversational role must NOT inherit the hours-long budget');
  assert.ok(DEFAULT_POLICY.timeouts.engineer > DEFAULT_POLICY.timeouts.manager * 10,
    'the roles are not comparable and their budgets must reflect that');
});

test('the adapter sends its own per-surface budget, not the default', async () => {
  const { Adapter } = await import('../src/adapters/base.js');
  const seen = [];
  class Engineer extends Adapter {
    get role() { return 'engineer'; }
    get surface() { return 'engineer'; }
  }
  const a = new Engineer({
    transport: { send: async (args) => { seen.push(args.timeoutMs); return { text: 'ok' }; } },
  });
  await a.sendWithRetries('p', { what: 'x', iteration: 1 });
  assert.ok(seen[0] >= 2 * 3600_000, `engineer was sent ${seen[0]}ms`);
});

test('a SILENT page fails promptly instead of waiting out the whole budget', async () => {
  /*
   * The counterpart to a long budget. Four hours with no liveness check means
   * a genuinely crashed page is waited on for four hours. "Wait as long as the
   * work takes, but give up once nothing is moving at all" is the only version
   * of a long budget that is safe rather than reckless.
   */
  const frozen = Array.from({ length: 500 }, () =>
    ({ composer: true, busy: false, turns: 2, lastText: 'started and then froze' }));
  const f = fakePage([frame(), ...frozen]);
  const t = new DomTransport({
    page: f.page, now: f.now, wait: f.wait,
    config: { silenceMs: 60_000, quietMs: 999_999_999 },
  });

  await assert.rejects(
    () => t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 }),
    (err) => {
      assert.equal(err.outcome, 'timed-out');
      assert.equal(err.detail.phase, 'silent', 'the reason must say "frozen", not "still generating"');
      assert.match(err.message, /no sign of life/);
      return true;
    },
  );
  assert.ok(f.now() < 4 * 3600_000, 'it must not burn the full four-hour budget on a dead page');
});

test('a slow but LIVE task keeps its budget', async () => {
  /*
   * The distinction that makes the whole design work: silence resets whenever
   * anything moves. A task that emits a line every few minutes for an hour is
   * working, not frozen.
   */
  /*
   * The fixture must run LONGER than silenceMs, or it proves nothing: a task
   * that finishes inside the silence window survives whether or not the reset
   * works. Sabotaging the reset left the suite green until this was widened.
   *
   * 400 polls at 750ms is ~5 minutes of simulated work against a 60s silence
   * window — so only a working reset can carry it to the end.
   */
  const slow = [];
  for (let i = 0; i < 400; i++) {
    slow.push({ composer: true, busy: true, turns: 2, lastText: `building… step ${i}` });
  }
  slow.push(...Array.from({ length: 8 }, () =>
    ({ composer: true, busy: false, turns: 2, lastText: 'done, all tests pass' })));

  const f = fakePage([frame(), ...slow]);
  const t = new DomTransport({
    page: f.page, now: f.now, wait: f.wait,
    config: { silenceMs: 60_000 },
  });
  const out = await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 });
  assert.equal(out.text, 'done, all tests pass', 'steady progress must not be mistaken for silence');
});

test('progress is REPORTED during a long wait, not just endured', async () => {
  /*
   * The Activity Log previously showed nothing between "submitted" and either
   * a reply or a timeout — for hours. That is "no unexplained waiting" broken
   * by precisely the case the rule exists for.
   */
  const working = Array.from({ length: 300 }, (_, i) =>
    ({ composer: true, busy: true, turns: 2, lastText: `output ${i}` }));
  working.push(...Array.from({ length: 8 }, () =>
    ({ composer: true, busy: false, turns: 2, lastText: 'finished' })));

  const events = [];
  const f = fakePage([frame(), ...working]);
  const t = new DomTransport({
    page: f.page, now: f.now, wait: f.wait,
    onEvent: (e) => events.push(e),
    config: { silenceMs: 3600_000 },
  });
  await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 });

  /*
   * Filtered to the STREAMING phase specifically. Both waits emit
   * `response-progress`, so an unfiltered count let this test pass on
   * heartbeats from the first-turn wait -- it was catching a mutation of a
   * line it does not exercise. Caught by tools/sabotage.mjs, not by reading.
   */
  const progress = events.filter((e) => e.type === 'response-progress' && e.phase === 'streaming');
  assert.ok(progress.length >= 2, `expected periodic progress, got ${progress.length}`);
  assert.ok(progress[0].elapsedMs > 0);
  assert.equal(typeof progress[0].silentMs, 'number');
  assert.equal(progress[0].surface, 'engineer');
});

/* ---------------------------------------------------------------------------
 * THE BLIND-TRANSPORT BUG (run of 2026-08-08 17:10)
 *
 * The engineer's reply was on screen. The extension never saw it, because no
 * `turns` selector matched Arena's markup. The transport was in phase 3 —
 * "wait for a new turn to appear" — which had no diagnosis budget and emitted
 * no events, so the four-hour engineer budget turned a selector bug into four
 * silent hours and then the sentence "produced no reply".
 *
 * Two properties are asserted below and they pull in opposite directions,
 * which is the point: give up FAST when we can see nothing at all, and give up
 * NEVER while the page shows any sign of life.
 * ------------------------------------------------------------------------ */

test('A REPLY WE CANNOT SEE IS DIAGNOSED AS OUR BUG, NOT REPORTED AS NO REPLY', async () => {
  // A page that accepted the prompt but whose assistant turns match nothing.
  // pageChars is what makes this "blind", not "blank" — the Arena page had
  // 113,671 elements on it while we read zero turns.
  const blind = fakePage([{ composer: true, busy: undefined, turns: 0, lastText: '', pageChars: 45_000 }]);
  const t = new DomTransport({ page: blind.page, now: blind.now, wait: blind.wait });

  const err = await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 })
    .then(() => null, (e) => e);

  assert.ok(err instanceof TransportError, 'a blind read must fail loudly');
  assert.equal(err.detail.phase, 'selector-miss',
    'the phase must name OUR fault, not the model\'s silence');
  assert.match(err.message, /do not match this page/,
    'the message must point at the selectors, since that is what a human has to fix');
  assert.deepEqual(err.detail.tried, SELECTORS.engineer.turns,
    'it must report which selectors were tried, so the fix is one line');

  // The load-bearing number: this is what made it unusable.
  assert.ok(blind.now() <= DEFAULTS.firstTurnMs + 5_000,
    `must fail in ~${DEFAULTS.firstTurnMs}ms, not four hours; took ${blind.now()}ms`);
  assert.ok(blind.now() < 4 * 3600_000 / 100, 'it must not burn a meaningful slice of the budget');
});

test('a page that is merely SLOW to first token is still given its full budget', async () => {
  /*
   * The counterweight. If the diagnosis budget were applied to any page that
   * has not produced a TURN yet, a model that thinks for two minutes before
   * emitting a token would be killed at 90s — trading one false negative for
   * another. Any sign of life (here: busy) must suspend the diagnosis.
   */
  const thinking = Array.from({ length: 400 }, () =>
    ({ composer: true, busy: true, turns: 1, lastText: 'previous answer' }));
  const f = fakePage([
    frame(),
    ...thinking,                                                  // ~5 min busy, no new turn
    frame({ busy: true, turns: 2, lastText: 'here it comes' }),
    ...Array.from({ length: 8 }, () => frame({ busy: false, turns: 2, lastText: 'the answer' })),
  ]);
  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait, config: { silenceMs: 3600_000 } });

  const out = await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 });
  assert.equal(out.text, 'the answer', 'a busy page must not be cut off by the diagnosis budget');
  assert.ok(f.now() > DEFAULTS.firstTurnMs, 'this fixture must actually outlast the diagnosis budget');
});

test('the wait for a FIRST turn reports progress, not just the wait for completion', async () => {
  /*
   * The previous fix put heartbeats in `awaitCompletion` only. The run that
   * went silent for 6.5 minutes never reached that function — it died in the
   * phase before it. A heartbeat that is absent from the phase where runs
   * actually hang is not a heartbeat.
   */
  const events = [];
  const thinking = Array.from({ length: 400 }, () =>
    ({ composer: true, busy: true, turns: 1, lastText: 'previous answer' }));
  const f = fakePage([
    frame(),
    ...thinking,
    frame({ busy: true, turns: 2, lastText: 'x' }),
    ...Array.from({ length: 8 }, () => frame({ busy: false, turns: 2, lastText: 'done' })),
  ]);
  const t = new DomTransport({
    page: f.page, now: f.now, wait: f.wait,
    onEvent: (e) => events.push(e),
    config: { silenceMs: 3600_000 },
  });
  await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 });

  const early = events.filter((e) => e.type === 'response-progress' && e.phase === 'awaiting-first-turn');
  assert.ok(early.length >= 2,
    `expected heartbeats while waiting for the first turn, got ${early.length}`);
  assert.ok(early[0].elapsedMs >= 60_000, 'the first heartbeat should land at about a minute');
});

/* ---------------------------------------------------------------------------
 * pageProbe — the function that runs INSIDE the page.
 *
 * It had no direct test at all, which is why the Arena blindness could only be
 * found by a user watching a real run. These drive it against a DOM stub.
 * ------------------------------------------------------------------------ */

/** Minimal document stub: only what pageProbe touches. */
function fakeDom({ html = {}, bodyText = '' } = {}) {
  const el = (text) => ({
    innerText: text,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  });
  return {
    body: { innerText: bodyText },
    title: 'Arena',
    querySelector: (sel) => (html[sel]?.length ? el(html[sel][0]) : null),
    querySelectorAll: (sel) => (html[sel] || []).map(el),
  };
}

function withDom(dom, fn) {
  const g = globalThis;
  const savedDoc = g.document, savedLoc = g.location, savedCs = g.getComputedStyle;
  g.document = dom;
  g.location = { href: 'https://arena.ai/agent/019fa9f8' };
  g.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try { return fn(); } finally {
    g.document = savedDoc; g.location = savedLoc; g.getComputedStyle = savedCs;
  }
}

test('pageProbe FINDS THE REPORT BY ITS FENCE WHEN EVERY SELECTOR MISSES', async () => {
  /*
   * The exact Arena situation: composer present, reply rendered, and not one
   * `turns` selector matching. The fence is ours, so it is findable regardless
   * of how the page is marked up.
   */
  const { pageProbe } = await import('../src/transports/dom.js');
  const report = '```ORCHESTRATOR-REPORT\n{ "taskStatus": "complete" }\n```';
  const dom = fakeDom({
    html: { '[data-testid="composer"]': ['type here'] },   // composer only
    bodyText: `Arena sidebar\nNew Chat\nLeaderboard\n\nSure, here is the result.\n${report}`,
  });

  const out = withDom(dom, () => pageProbe(SELECTORS.engineer, 'ORCHESTRATOR-REPORT'));

  assert.equal(out.turns, 0, 'the premise: no turn selector matches');
  assert.equal(out.via, 'fence', 'it must report that it fell back');
  assert.ok(out.lastText.includes('"taskStatus": "complete"'),
    'the report must be recovered even though no selector matched');
  assert.ok(!out.lastText.includes('Leaderboard'),
    'it must start AT the fence, not hand the sidebar to the parser');
});

test('pageProbe prefers a real selector match over the fence fallback', async () => {
  const { pageProbe } = await import('../src/transports/dom.js');
  const dom = fakeDom({
    html: {
      '[data-testid="composer"]': ['type here'],
      '[data-role="assistant"]': ['the precise reply'],
    },
    bodyText: 'chrome\n```ORCHESTRATOR-REPORT\n{}\n```',
  });

  const out = withDom(dom, () => pageProbe(SELECTORS.engineer, 'ORCHESTRATOR-REPORT'));
  assert.equal(out.via, 'selector', 'selectors bound the reply to one turn; prefer them');
  assert.equal(out.lastText, 'the precise reply');
});

test('pageProbe reports page size so BLINDNESS is distinguishable from an EMPTY page', async () => {
  const { pageProbe } = await import('../src/transports/dom.js');

  const full = withDom(
    fakeDom({ html: { '[data-testid="composer"]': ['x'] }, bodyText: 'y'.repeat(40_000) }),
    () => pageProbe(SELECTORS.engineer, 'ORCHESTRATOR-REPORT'));
  const empty = withDom(
    fakeDom({ html: { '[data-testid="composer"]': ['x'] }, bodyText: '' }),
    () => pageProbe(SELECTORS.engineer, 'ORCHESTRATOR-REPORT'));

  assert.equal(full.pageChars, 40_000);
  assert.equal(empty.pageChars, 0);
  assert.equal(full.via, 'none', 'text we cannot parse is not a reply');
  assert.equal(full.lastText, '', 'raw page text must NEVER be returned as the reply');
});

test('A PAGE FULL OF UNREADABLE TEXT BLAMES OUR SELECTORS, NOT THE MODEL', async () => {
  /*
   * The user-facing half. The message a human reads must name the actual
   * fault. "produced no reply" sent the user looking at Arena; the page had
   * 113,671 elements on it.
   */
  const blind = fakePage([{ composer: true, busy: undefined, turns: 0, lastText: '', pageChars: 45_000 }]);
  const t = new DomTransport({ page: blind.page, now: blind.now, wait: blind.wait });
  const err = await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 })
    .then(() => null, (e) => e);

  assert.equal(err.detail.phase, 'selector-miss');
  assert.match(err.message, /45000 characters of text on screen/);
  assert.match(err.message, /do not match this page/);
  assert.equal(err.detail.pageChars, 45_000);
});

test('a genuinely BLANK page is reported as blank, not as a selector bug', async () => {
  /*
   * The counterweight: if everything were called a selector miss, the message
   * would be wrong half the time and would stop being believed.
   */
  const blank = fakePage([{ composer: true, busy: undefined, turns: 0, lastText: '', pageChars: 0 }]);
  const t = new DomTransport({ page: blank.page, now: blank.now, wait: blank.wait });
  const err = await t.send({ prompt: 'x', surface: 'engineer', timeoutMs: 4 * 3600_000 })
    .then(() => null, (e) => e);

  assert.equal(err.detail.phase, 'no-content', 'an empty page is a different fault');
  assert.doesNotMatch(err.message, /do not match this page/);
});
