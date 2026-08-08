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
