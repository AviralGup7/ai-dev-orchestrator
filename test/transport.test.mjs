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

/* ---------------------------------------------------------------------------
 * PASTE VERIFICATION (run 202608081932)
 *
 * The log said "Pasted 2029 characters into the manager composer" and the very
 * next call failed with "could not submit on manager: no send control".
 *
 * Both facts are explained by one cause: ChatGPT's composer is React-
 * controlled and did not accept the programmatic write, so React never
 * re-rendered, so the send button was never mounted. `pageType` had asserted
 * success having only assigned to a property — it never read the value back.
 *
 * These drive the real injected functions, which had no tests at all because
 * they were not exported.
 * ------------------------------------------------------------------------ */

function stubEl({ editable = false, text = '', accepts = true } = {}) {
  const el = {
    isContentEditable: editable,
    value: editable ? undefined : text,
    textContent: editable ? text : undefined,
    disabled: false,
    focus() {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    dispatchEvent() { return true; },
    click() { el.clicked = true; },
    clicked: false,
    // A DOM write that ProseMirror ignores: the node lands, the model does not.
    appendChild(child) { el.textContent = (el.textContent || '') + (child.textContent || ''); },
  };
  // A React-controlled composer that REJECTS the write reverts to empty.
  if (!accepts) {
    Object.defineProperty(el, editable ? 'textContent' : 'value', {
      get: () => '', set: () => {}, configurable: true,
    });
  }
  return el;
}

/**
 * @param {object} map                 selector -> element
 * @param {object} [opts]
 * @param {boolean} [opts.execCommandWorks]  does execCommand('insertText') land?
 *   This models the real distinction: ProseMirror accepts execCommand and
 *   ignores a raw DOM write, so `false` reproduces ChatGPT with a stale
 *   implementation and `true` reproduces the fix working.
 */
function withDoc(map, fn, { execCommandWorks = false } = {}) {
  const g = globalThis;
  const saved = {
    d: g.document, k: g.KeyboardEvent, i: g.InputEvent, e: g.Event,
    cs: g.getComputedStyle, w: g.window,
  };
  const calls = { execCommand: 0 };
  g.document = {
    querySelector: (s) => map[s] ?? null,
    body: { innerText: '' },
    createElement: () => ({ textContent: '' }),
    createRange: () => ({ selectNodeContents(el) { calls.selected = el; } }),
    execCommand: (cmd, _ui, value) => {
      if (cmd !== 'insertText') return false;
      calls.execCommand++;
      if (!execCommandWorks) return false;
      /*
       * Faithful to the real behaviour: insertText replaces the SELECTION.
       * With nothing selected it inserts at the caret, i.e. APPENDS — which is
       * how a retry sends the prompt twice. The stub must model that or the
       * "replaces rather than appends" test proves nothing.
       */
      const target = Object.values(map).find((el) => el && el.isContentEditable);
      if (target) {
        target.textContent = calls.selected === target ? value : (target.textContent || '') + value;
        target.accepted = true;
      }
      return true;
    },
  };
  g.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  g.KeyboardEvent = class { constructor(t, o) { Object.assign(this, { type: t }, o); } };
  g.InputEvent = class { constructor(t, o) { Object.assign(this, { type: t }, o); } };
  g.Event = class { constructor(t, o) { Object.assign(this, { type: t }, o); } };
  g.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  return Promise.resolve(fn(calls)).finally(() => {
    g.document = saved.d; g.KeyboardEvent = saved.k; g.InputEvent = saved.i;
    g.Event = saved.e; g.getComputedStyle = saved.cs; g.window = saved.w;
  });
}

test('A COMPOSER THAT SILENTLY REJECTS THE TEXT IS A FAILED PASTE, NOT A SUCCESS', async () => {
  const { pageType } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, accepts: false });

  await withDoc({ '#prompt-textarea': composer }, () => {
    const r = pageType({ composer: ['#prompt-textarea'] }, 'x'.repeat(2029));
    assert.equal(r.ok, false,
      'reporting a successful paste that did not happen is what hid this for a whole run');
    assert.match(r.why, /did not accept/);
    assert.equal(r.wrote, 2029);
    assert.equal(r.readBack, 0, 'the read-back is the evidence');
  });
});

test('a composer that accepts the text still reports success', async () => {
  const { pageType } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, accepts: true });
  await withDoc({ '#prompt-textarea': composer }, () => {
    const r = pageType({ composer: ['#prompt-textarea'] }, 'hello there, this is the prompt');
    assert.equal(r.ok, true);
    assert.ok(r.readBack > 0);
  });
});

test('A SEND BUTTON THAT IS NOT MOUNTED YET FALLS BACK TO ENTER', async () => {
  /*
   * ChatGPT does not keep a disabled send button in the DOM; it MOUNTS one
   * when React re-renders. Looking in the same tick finds nothing, which read
   * as "no send control" — a message that sounds like a rotted selector and is
   * not. Enter is how a human submits, and it goes through the page's own
   * handler.
   */
  const { pageClick } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'the prompt' });
  const sent = [];
  // A composer that ACCEPTS Enter clears itself, exactly as the real one does.
  composer.dispatchEvent = (e) => {
    sent.push(e.key);
    if (e.key === 'Enter' && e.type === 'keydown') composer.textContent = '';
    return true;
  };

  await withDoc({ '#prompt-textarea': composer }, async () => {
    const r = await pageClick(
      { composer: ['#prompt-textarea'], send: ['button[data-testid="send-button"]'] }, 'send');
    assert.equal(r.ok, true, 'a missing button must not end the iteration');
    assert.equal(r.via, 'enter');
    assert.ok(sent.includes('Enter'), 'Enter must actually reach the composer');
  });
});

test('the send button is preferred when it IS present', async () => {
  const { pageClick } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'x' });
  const button = stubEl();
  await withDoc({ '#prompt-textarea': composer, 'button#send': button }, async () => {
    const r = await pageClick({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'send');
    assert.equal(r.via, 'click', 'the real control beats the keyboard fallback');
    assert.equal(button.clicked, true);
  });
});

test('a missing STOP control does NOT fall back to Enter', async () => {
  /*
   * The counterweight, and it matters: synthesising Enter to try to stop a
   * running generation would SUBMIT the composer instead — the exact opposite
   * of the intent.
   */
  const { pageClick } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'x' });
  const seen = [];
  composer.dispatchEvent = (e) => { seen.push(e.key); return true; };

  await withDoc({ '#prompt-textarea': composer }, async () => {
    const r = await pageClick({ composer: ['#prompt-textarea'], stop: ['button#stop'] }, 'stop');
    assert.equal(r.ok, false, 'a missing stop control is an honest failure');
    assert.ok(!seen.includes('Enter'), 'pressing Enter here would submit, not stop');
  });
});

/* ---------------------------------------------------------------------------
 * PROSEMIRROR (run 202608090550)
 *
 * ChatGPT's composer is a ProseMirror editor. It keeps an immutable document
 * model SEPARATE from the visible DOM and updates it only through its own
 * transaction system — driven by beforeinput/input with a real `inputType`, or
 * by document.execCommand('insertText').
 *
 * Assigning `textContent` therefore makes text VISIBLE while the editor still
 * believes it is empty. The send button never enables, Enter does nothing, and
 * the run waits four minutes for a reply to a message still sitting in the box.
 * The log shows it precisely: chars frozen at 26,506, busy:false, for 3m.
 * ------------------------------------------------------------------------ */

test('THE COMPOSER IS FILLED VIA execCommand, WHICH IS WHAT PROSEMIRROR LISTENS TO', async () => {
  const { pageType } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true });

  await withDoc({ '#prompt-textarea': composer }, (calls) => {
    const r = pageType({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'evaluate this please');
    assert.equal(calls.execCommand, 1,
      'a raw DOM write does not reach ProseMirror; execCommand is the documented route');
    assert.equal(r.via, 'execCommand');
    assert.equal(composer.accepted, true, 'the editor model must have received it');
  }, { execCommandWorks: true });
});

test('the DOM fallback fires a spec-shaped beforeinput, not a bare Event', async () => {
  /*
   * When execCommand is unavailable the fallback must still speak the language
   * these editors listen for. A `new Event('input')` with no `inputType` is
   * ignored by both ProseMirror and Lexical — that is the whole bug.
   */
  const { pageType } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true });
  const events = [];
  composer.dispatchEvent = (e) => { events.push(e); return true; };

  await withDoc({ '#prompt-textarea': composer }, () => {
    pageType({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'hello there friend');
  }, { execCommandWorks: false });

  assert.deepEqual(events.map((e) => e.type), ['beforeinput', 'input'],
    'beforeinput must come first — it is the event the editor keys on');
  for (const e of events) {
    assert.equal(e.inputType, 'insertText', 'an event without inputType is discarded');
    assert.equal(e.composed, true, 'must cross a shadow boundary if the editor is encapsulated');
  }
});

test('the insert REPLACES existing content rather than appending', async () => {
  /*
   * Without selecting the existing content first, a retry appends and the
   * prompt is sent twice over.
   */
  const { pageType } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'a previous draft' });

  await withDoc({ '#prompt-textarea': composer }, () => {
    pageType({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'the new prompt');
    assert.equal(composer.textContent, 'the new prompt',
      'the old draft must be gone, not prefixed');
  }, { execCommandWorks: true });
});

test('the paste reports whether the FRAMEWORK enabled the send control', async () => {
  /*
   * Reading back textContent is near-tautological on the DOM path: it reads
   * the property we just wrote. It passed for the whole of run 202608090550
   * while the message was never sent. An enabled send button is independent
   * evidence, because the editor enables it as a consequence of its own model
   * becoming non-empty.
   */
  const { pageType } = await import('../extension/dom-page.js');

  const withButton = stubEl({ editable: true });
  await withDoc({ '#prompt-textarea': withButton, 'button#send': stubEl() }, () => {
    const r = pageType({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'x'.repeat(64));
    assert.equal(r.enabledSend, true, 'a mounted, enabled send control is the good case');
  }, { execCommandWorks: true });

  const noButton = stubEl({ editable: true });
  await withDoc({ '#prompt-textarea': noButton }, () => {
    const r = pageType({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'x'.repeat(64));
    assert.equal(r.enabledSend, false,
      'no send control after a paste is the signature of a rejected input');
  }, { execCommandWorks: true });
});

test('A CLICK THE PAGE IGNORES IS A FAILED SUBMIT, NOT A SUCCESS', async () => {
  /*
   * el.click() dispatches isTrusted:false and some handlers reject exactly
   * that. Returning ok:true was the same mistake the paste used to make —
   * reporting the action instead of the outcome. A composer still holding the
   * prompt is the page saying it did not take it.
   */
  const { pageClick } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'still here' });
  const button = stubEl();

  await withDoc({ '#prompt-textarea': composer, 'button#send': button }, async () => {
    const r = await pageClick({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'send');
    assert.equal(button.clicked, true, 'it must genuinely try the button first');
    assert.equal(r.ok, false, 'four minutes were spent waiting for a reply to an unsent message');
    assert.match(r.why, /still holds the prompt/);
    assert.match(r.why, /isTrusted/, 'the message should name the actual mechanism');
  });
});

test('a click the page ACCEPTS reports success', async () => {
  const { pageClick } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'the prompt' });
  const button = stubEl();
  button.click = () => { button.clicked = true; composer.textContent = ''; };

  await withDoc({ '#prompt-textarea': composer, 'button#send': button }, async () => {
    const r = await pageClick({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'send');
    assert.equal(r.ok, true);
    assert.equal(r.via, 'click');
  });
});

test('an ignored click falls back to Enter before giving up', async () => {
  const { pageClick } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true, text: 'the prompt' });
  const button = stubEl();   // click does nothing at all
  composer.dispatchEvent = (e) => {
    if (e.key === 'Enter' && e.type === 'keydown') composer.textContent = '';
    return true;
  };

  await withDoc({ '#prompt-textarea': composer, 'button#send': button }, async () => {
    const r = await pageClick({ composer: ['#prompt-textarea'], send: ['button#send'] }, 'send');
    assert.equal(r.ok, true, 'the keyboard route must be tried before failing the iteration');
    assert.equal(r.via, 'click+enter');
  });
});

test('an unreadable composer does not become a false submit failure', async () => {
  /*
   * The counterweight. Some surfaces clear differently or hide the composer
   * after sending. Absence of evidence must not be reported as failure, or
   * this breaks the sites that work today.
   */
  const { pageClick } = await import('../extension/dom-page.js');
  const button = stubEl();
  await withDoc({ 'button#send': button }, async () => {
    const r = await pageClick({ composer: ['#nope'], send: ['button#send'] }, 'send');
    assert.equal(r.ok, true, 'no composer to read is not evidence of failure');
  });
});

/* ---------------------------------------------------------------------------
 * THE LOG MUST RECORD OUTCOMES, NOT INTENTIONS.
 *
 * `prompt-pasted` and `prompt-submitted` fired BEFORE the operations they
 * describe, so they announced an intention and were read as an outcome. Run
 * 202608090550 logged both nine milliseconds apart and neither had happened.
 * ------------------------------------------------------------------------ */

test('THE PASTE EVENT CARRIES THE ROUTE AND THE FRAMEWORK VERDICT', async () => {
  const events = [];
  const f = fakePage([frame(), frame({ busy: true, turns: 2, lastText: 'x' }),
    ...Array.from({ length: 8 }, () => frame({ busy: false, turns: 2, lastText: 'done' }))]);
  // A page whose type() reports HOW it got the text in, as the real one does.
  f.page.type = async () => ({ ok: true, chars: 10, readBack: 10, enabledSend: false, via: 'dom' });

  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait, onEvent: (e) => events.push(e) });
  await t.send({ prompt: 'x', surface: 'manager', timeoutMs: 240_000 });

  const pasted = events.find((e) => e.type === 'prompt-pasted');
  assert.equal(pasted.via, 'dom', 'which insertion route worked is the first question asked');
  assert.equal(pasted.enabledSend, false,
    'the framework refusing to enable send is the signature of a rejected paste');
  assert.equal(pasted.readBack, 10);
});

test('the submit event records HOW the message went, or why it did not', async () => {
  const events = [];
  const f = fakePage([frame(), frame({ busy: true, turns: 2, lastText: 'x' }),
    ...Array.from({ length: 8 }, () => frame({ busy: false, turns: 2, lastText: 'done' }))]);
  f.page.click = async () => ({ ok: true, via: 'click+enter', why: 'the click was ignored' });

  const t = new DomTransport({ page: f.page, now: f.now, wait: f.wait, onEvent: (e) => events.push(e) });
  await t.send({ prompt: 'x', surface: 'manager', timeoutMs: 240_000 });

  const sub = events.find((e) => e.type === 'prompt-submitted');
  assert.equal(sub.via, 'click+enter',
    '"submitted" without a route cannot distinguish a working click from a silent no-op');
  assert.match(sub.why, /ignored/);
});

test('THE PASTE EVENT IS NOT EMITTED BEFORE THE PASTE IS ATTEMPTED', async () => {
  /*
   * The ordering bug itself. If the event precedes the call, a throwing
   * page still produces a cheerful "Pasted 2029 characters" in the log.
   */
  const order = [];
  const f = fakePage([frame()]);
  f.page.type = async () => { order.push('type'); throw new Error('composer rejected it'); };

  const t = new DomTransport({
    page: f.page, now: f.now, wait: f.wait,
    onEvent: (e) => { if (e.type === 'prompt-pasted') order.push('event'); },
  });
  await t.send({ prompt: 'x', surface: 'manager', timeoutMs: 10_000 }).catch(() => {});

  assert.deepEqual(order, ['type'],
    'a paste that threw must not have already announced success');
});

/* ---------------------------------------------------------------------------
 * "could not submit on engineer: undefined" (run 202608090835)
 *
 * Chrome does not implement InjectionResult.error (crbug 1271527; MDN states
 * it outright). An injected function that throws — or, being async, rejects —
 * comes back as `result: undefined`, with the real error written only to the
 * TARGET PAGE's console where a background worker can never read it.
 *
 * `undefined?.why` is `undefined`, so the one fact that mattered was destroyed
 * at the boundary and replaced with the literal word "undefined".
 * ------------------------------------------------------------------------ */

test('AN IN-PAGE THROW COMES BACK AS A REASON, NOT AS "undefined"', async () => {
  const { pageType } = await import('../extension/dom-page.js');
  const exploding = stubEl({ editable: true });
  Object.defineProperty(exploding, 'isContentEditable', {
    get() { throw new Error('the frame was detached mid-write'); },
  });

  await withDoc({ '#prompt-textarea': exploding }, () => {
    const r = pageType({ composer: ['#prompt-textarea'], send: [] }, 'x');
    assert.equal(r.__threw, true, 'the throw must be returned as data, not lost');
    assert.equal(r.ok, false);
    assert.match(r.error, /detached mid-write/,
      'the actual message is the whole point — "undefined" is what we had before');
    assert.ok(r.stack, 'a stack helps and costs nothing');
  });
});

test('pageClick reports an in-page throw rather than swallowing it', async () => {
  const { pageClick } = await import('../extension/dom-page.js');
  const g = globalThis;
  const savedDoc = g.document;
  g.document = { querySelector() { throw new Error('CSP blocked the query'); } };
  try {
    const r = await pageClick({ composer: ['#c'], send: ['#s'] }, 'send');
    assert.equal(r.__threw, true);
    assert.match(r.error, /CSP blocked/);
  } finally {
    g.document = savedDoc;
  }
});

test('the injected functions still return plain results when nothing throws', async () => {
  /*
   * The counterweight: the try/catch wrapper must be invisible on the happy
   * path, or every caller has to learn about `__threw`.
   */
  const { pageType } = await import('../extension/dom-page.js');
  const composer = stubEl({ editable: true });
  await withDoc({ '#prompt-textarea': composer }, () => {
    const r = pageType({ composer: ['#prompt-textarea'], send: [] }, 'a normal prompt here');
    assert.equal(r.__threw, undefined, 'success must not carry the failure marker');
    assert.equal(r.ok, true);
  }, { execCommandWorks: true });
});

/* ---------------------------------------------------------------------------
 * THE PAGE-SIDE FENCE FALLBACK COULD NEVER FIRE.
 *
 * Measured on Arena in run 202608090835: all EIGHT `turns` selectors matched
 * zero nodes (the surface scan says so directly — Arena exposes no testids and
 * no semantic classes). The fence fallback was therefore the only remaining
 * route to the reply.
 *
 * It searched for '```' + fence. `innerText` of a RENDERED code block has no
 * backticks — the browser turned them into a <pre><code>. So it found nothing,
 * every time. The same bug fixed in report.js at 217121a, still live here two
 * modules away.
 * ------------------------------------------------------------------------ */

test('THE FENCE FALLBACK WORKS ON RENDERED TEXT, WHICH HAS NO BACKTICKS', async () => {
  const { pageProbe } = await import('../src/transports/dom.js');
  const report = 'ORCHESTRATOR-REPORT\n{ "taskStatus": "complete" }';
  const dom = fakeDom({
    html: { '[data-testid="composer"]': ['type here'] },   // composer only, as on Arena
    bodyText: `Arena sidebar\nToggle Sidebar\nAgent Mode\n\nHere is the work.\n${report}`,
  });

  const out = withDom(dom, () => pageProbe(SELECTORS.engineer, 'ORCHESTRATOR-REPORT'));

  assert.equal(out.turns, 0, 'the premise: no turn selector matches on Arena');
  assert.equal(out.via, 'fence', 'the fallback must actually fire');
  assert.match(out.lastText, /"taskStatus": "complete"/, 'the report must be recovered');
  assert.ok(!out.lastText.includes('Toggle Sidebar'),
    'it must start AT the fence, not hand the sidebar to the parser');
});

test('the backtick form is still preferred when the page shows markdown source', async () => {
  const { pageProbe } = await import('../src/transports/dom.js');
  const dom = fakeDom({
    html: { '[data-testid="composer"]': ['x'] },
    /*
     * The bare mention comes LAST, so `lastIndexOf(fence)` would find it and a
     * naive fallback would return the wrong text. The fenced block must win.
     * With the previous fixture the bare mention came first and lastIndexOf
     * picked the fenced one anyway — the test passed for the wrong reason and
     * survived sabotage. Found by running the sabotage, not by reading.
     */
    bodyText: '```ORCHESTRATOR-REPORT\n{ "taskStatus": "partial" }\n```\n\n'
      + 'PS: the ORCHESTRATOR-REPORT format is documented above.',
  });
  const out = withDom(dom, () => pageProbe(SELECTORS.engineer, 'ORCHESTRATOR-REPORT'));
  assert.match(out.lastText, /"taskStatus": "partial"/,
    'the fenced block is tighter and must win over a later bare mention');
});
