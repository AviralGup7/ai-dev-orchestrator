/**
 * Tests for the pre-initiated environment contract.
 *
 * The behaviour under test is mostly REFUSAL, which is the hardest kind to
 * test convincingly: a function that always throws passes every "it throws"
 * test. So each refusal test is paired with a positive case proving the same
 * code path accepts a healthy environment, and every test in this file was
 * sabotage-verified (see docs/ENVIRONMENT.md for the log).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bind,
  verify,
  hostOf,
  EnvironmentError,
  SURFACES,
} from '../src/core/environment.js';
import {
  assertAllowed,
  isAllowed,
  ALLOWED_ACTIONS,
  FORBIDDEN_ACTIONS,
  ForbiddenActionError,
} from '../src/core/actions.js';
import { createGuard } from '../src/core/guard.js';

/* -------------------------------------------------------------- fixtures - */

const HOSTS = {
  manager: ['chatgpt.com', 'chat.openai.com'],
  engineer: ['arena.ai'],
  reviewer: ['deepseek.com', 'chat.deepseek.com'],
};

function healthy(overrides = {}) {
  const base = {
    manager: {
      tabId: 11, windowId: 1, url: 'https://chatgpt.com/c/conv-manager',
      conversationId: 'conv-manager', title: 'Orchestrator project', ready: true, signedIn: true,
    },
    engineer: {
      tabId: 22, windowId: 1, url: 'https://arena.ai/w/ws-7',
      conversationId: 'ws-7', title: 'ai-dev-orchestrator', ready: true, signedIn: true,
    },
    reviewer: {
      tabId: 33, windowId: 1, url: 'https://chat.deepseek.com/a/chat/s/conv-review',
      conversationId: 'conv-review', title: 'strategy', ready: true, signedIn: true,
    },
  };
  const surfaces = {};
  for (const [k, v] of Object.entries(base)) {
    if (overrides[k] === null) continue; // explicitly absent
    surfaces[k] = { ...v, ...(overrides[k] || {}) };
  }
  return { surfaces };
}

/* ------------------------------------------------------------------ hosts */

test('hostOf strips www and ports, and survives junk', () => {
  assert.equal(hostOf('https://www.chatgpt.com/c/x'), 'chatgpt.com');
  assert.equal(hostOf('https://arena.ai:443/w/1'), 'arena.ai');
  assert.equal(hostOf('chrome://extensions'), 'extensions');
  assert.equal(hostOf(undefined), '');
  assert.equal(hostOf('not a url'), '');
});

/* ------------------------------------------------------------------- bind */

test('binds a healthy pre-opened environment and records identities', () => {
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  assert.equal(b.surfaces.manager.tabId, 11);
  assert.equal(b.surfaces.manager.conversationId, 'conv-manager');
  assert.equal(b.surfaces.engineer.host, 'arena.ai');
  // The optional reviewer was present, so it is bound and thereafter enforced.
  assert.equal(b.surfaces.reviewer.tabId, 33);
});

test('a missing REQUIRED surface refuses to bind — it does not open a tab', () => {
  assert.throws(
    () => bind(healthy({ engineer: null }), { require: ['manager', 'engineer'], hosts: HOSTS }),
    (err) => {
      assert.ok(err instanceof EnvironmentError);
      assert.equal(err.problems.length, 1);
      assert.equal(err.problems[0].surface, 'engineer');
      assert.equal(err.problems[0].kind, 'tab-missing');
      assert.match(err.problems[0].remedy, /reopen|stop/);
      return true;
    },
  );
});

test('a missing OPTIONAL surface is fine — DeepSeek may simply be disabled', () => {
  const b = bind(healthy({ reviewer: null }), { require: ['manager', 'engineer'], hosts: HOSTS });
  assert.equal(b.surfaces.reviewer, undefined);
  assert.equal(b.surfaces.manager.tabId, 11);
  // and the optional surface is genuinely optional in the declaration
  assert.equal(SURFACES.find((s) => s.key === 'reviewer').optional, true);
});

test('a tab with no conversation id is refused: the first paste would CREATE a chat', () => {
  assert.throws(
    () => bind(
      healthy({ manager: { url: 'https://chatgpt.com/', conversationId: null } }),
      { require: ['manager', 'engineer'], hosts: HOSTS },
    ),
    (err) => {
      assert.equal(err.problems[0].kind, 'conversation-changed');
      assert.match(err.problems[0].detail, /not on an existing conversation/);
      return true;
    },
  );
});

test('a tab on the wrong site is refused rather than navigated', () => {
  assert.throws(
    () => bind(
      healthy({ engineer: { url: 'https://example.com/somewhere' } }),
      { require: ['manager', 'engineer'], hosts: HOSTS },
    ),
    (err) => {
      assert.equal(err.problems[0].kind, 'navigated-away');
      assert.match(err.problems[0].detail, /example\.com/);
      return true;
    },
  );
});

test('a signed-out tab is refused rather than logged in', () => {
  assert.throws(
    () => bind(healthy({ manager: { signedIn: false } }), { require: ['manager'], hosts: HOSTS }),
    (err) => {
      assert.equal(err.problems[0].kind, 'signed-out');
      assert.match(err.problems[0].remedy, /sign in again/);
      return true;
    },
  );
});

test('two roles resolving to the same tab is ambiguous, not clever', () => {
  /*
   * Without this check the run pastes the manager's plan into the engineer's
   * workspace and reads it straight back as if it were a reply. Both calls
   * succeed. Nothing in the scoring path can detect it.
   */
  assert.throws(
    () => bind(
      healthy({ engineer: { tabId: 11 } }),
      { require: ['manager', 'engineer'], hosts: HOSTS },
    ),
    (err) => {
      assert.ok(err.problems.some((p) => p.kind === 'ambiguous'));
      return true;
    },
  );
});

/* ----------------------------------------------------------------- verify */

test('verify passes when nothing has changed', () => {
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const r = verify(b, healthy());
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('verify catches a tab that was closed mid-run', () => {
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const r = verify(b, healthy({ manager: null }));
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, 'tab-missing');
});

test('verify catches the tab being replaced by a different one on the same site', () => {
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const r = verify(b, healthy({ manager: { tabId: 99 } }));
  assert.equal(r.problems[0].kind, 'tab-replaced');
});

test('verify catches a switch to a DIFFERENT conversation on the right site', () => {
  /*
   * The single most damaging drift, and the one a naive "is ChatGPT open?"
   * check misses entirely: right host, right tab, wrong chat.
   */
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const r = verify(b, healthy({ manager: { conversationId: 'some-other-chat' } }));
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, 'conversation-changed');
  assert.match(r.problems[0].detail, /conv-manager/);
  assert.match(r.problems[0].detail, /some-other-chat/);
});

test('a conversation switch is reported as such even while the page is still loading', () => {
  /*
   * Ordering test. A tab that just switched chats usually reports ready:false
   * too. If readiness won, the log would say "still loading", the user would
   * wait and resume, and the run would continue in the wrong conversation.
   */
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const r = verify(b, healthy({ manager: { conversationId: 'other', ready: false } }));
  assert.equal(r.problems[0].kind, 'conversation-changed');
});

test('verify can be scoped to the one surface an action targets', () => {
  const b = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const broken = healthy({ reviewer: null });
  assert.equal(verify(b, broken, { surfaces: ['manager'] }).ok, true);
  assert.equal(verify(b, broken, { surfaces: ['reviewer'] }).ok, false);
});

/* ---------------------------------------------------------------- actions */

test('the allowed action list contains only inherited-environment verbs', () => {
  for (const a of ALLOWED_ACTIONS) assert.equal(isAllowed(a), true);
  for (const f of FORBIDDEN_ACTIONS) {
    assert.equal(isAllowed(f), false, `${f} must not be allowed`);
    assert.throws(() => assertAllowed(f), ForbiddenActionError);
  }
  // and the two sets do not overlap
  const overlap = ALLOWED_ACTIONS.filter((a) => FORBIDDEN_ACTIONS.includes(a));
  assert.deepEqual(overlap, []);
});

test('the policy is DEFAULT-DENY: an unknown action is refused, not permitted', () => {
  /*
   * The forbidden list can never be complete -- `tabs.group` and
   * `sidePanel.open` did not exist when it was written. Anything not
   * explicitly allowed has to fail closed.
   */
  assert.throws(() => assertAllowed('tabs.group'), (err) => {
    assert.ok(err instanceof ForbiddenActionError);
    assert.match(err.message, /default-deny/);
    return true;
  });
});

/* ------------------------------------------------------------------ guard */

function makeGuard({ snapshots, transport, onEvent = () => {} }) {
  let i = 0;
  const binding = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const guard = createGuard({
    transport,
    binding,
    snapshot: async () => snapshots[Math.min(i++, snapshots.length - 1)],
    onEvent,
  });
  return { guard, binding };
}

test('the guard performs an allowed action against a healthy environment', async () => {
  const calls = [];
  const { guard } = makeGuard({
    snapshots: [healthy()],
    transport: {
      'paste-prompt': async (a) => { calls.push(a); return 'pasted'; },
    },
  });
  const out = await guard.act('paste-prompt', 'manager', { text: 'hello' });
  assert.equal(out, 'pasted');
  assert.equal(calls[0].text, 'hello');
  assert.equal(calls[0].tab.tabId, 11);
});

test('the guard refuses a forbidden action WITHOUT touching the transport', async () => {
  let touched = false;
  const { guard } = makeGuard({
    snapshots: [healthy()],
    transport: { 'create-tab': async () => { touched = true; } },
  });
  await assert.rejects(() => guard.act('create-tab', 'manager'), ForbiddenActionError);
  assert.equal(touched, false, 'the transport must never be reached for a banned verb');
});

test('the guard verifies before EVERY action, not once per run', async () => {
  let performed = 0;
  const { guard } = makeGuard({
    // healthy first, drifted second
    snapshots: [healthy(), healthy({ manager: { conversationId: 'elsewhere' } })],
    transport: { 'paste-prompt': async () => { performed++; } },
  });
  await guard.act('paste-prompt', 'manager');
  await assert.rejects(() => guard.act('paste-prompt', 'manager'), EnvironmentError);
  assert.equal(performed, 1, 'the second action must not reach the tab');
});

test('the guard LATCHES: it does not silently resume when the tab comes back', async () => {
  /*
   * The user switched conversation on purpose. They switch back for an
   * unrelated reason. Auto-resuming would restart an autonomous run they
   * believe is paused. The failure policy says wait for intervention.
   */
  let performed = 0;
  const { guard } = makeGuard({
    snapshots: [healthy({ manager: { conversationId: 'elsewhere' } }), healthy(), healthy()],
    transport: { 'paste-prompt': async () => { performed++; } },
  });
  await assert.rejects(() => guard.act('paste-prompt', 'manager'), EnvironmentError);
  await assert.rejects(() => guard.act('paste-prompt', 'manager'), EnvironmentError);
  assert.equal(performed, 0);
  assert.equal(guard.isHalted(), true);

  guard.clear(); // only a human path calls this
  await guard.act('paste-prompt', 'manager');
  assert.equal(performed, 1);
});

test('drift is reported once, with a remedy, through onEvent', async () => {
  const events = [];
  const { guard } = makeGuard({
    snapshots: [healthy({ engineer: null })],
    transport: { 'submit-prompt': async () => {} },
    onEvent: (e) => events.push(e),
  });
  await assert.rejects(() => guard.act('submit-prompt', 'engineer'), EnvironmentError);
  const drift = events.find((e) => e.type === 'environment-drift');
  assert.ok(drift, 'a drift event must be emitted for the log');
  assert.equal(drift.surface, 'engineer');
  assert.match(drift.detail, /tab-missing/);
});

test('onDrift fires exactly once, so the user is not spammed while halted', async () => {
  let drifts = 0;
  const binding = bind(healthy(), { require: ['manager', 'engineer'], hosts: HOSTS });
  const guard = createGuard({
    transport: { 'paste-prompt': async () => {} },
    binding,
    snapshot: async () => healthy({ manager: null }),
    onDrift: async () => { drifts++; },
  });
  await assert.rejects(() => guard.act('paste-prompt', 'manager'));
  await assert.rejects(() => guard.act('paste-prompt', 'manager'));
  await assert.rejects(() => guard.act('paste-prompt', 'manager'));
  assert.equal(drifts, 1);
});
