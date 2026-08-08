/**
 * The service worker, as Chrome runs it.
 *
 * These tests exist because `Service worker registration failed. Status
 * code: 3` was reported against a build where every unit test passed, the
 * purity checker passed and the demo ran. Unit tests import modules directly;
 * Chrome fetches them over a package root and evaluates the worker in a
 * hostile environment. Nothing covered that gap.
 *
 * `tools/check-loadable.mjs` covers the STRUCTURE. This file covers the
 * RUNTIME behaviour the structure check cannot express: what the worker does
 * when the browser refuses it something.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * A DOM stub with just enough behaviour for createPanel and a synthetic click.
 *
 * Not jsdom: this project has zero dependencies, and adding one for a handful
 * of element stubs would also drag in the memory ceiling problems recorded in
 * the notes. Twenty lines is cheaper than a dependency.
 */
function makeRoot() {
  const handlers = { click: [], keydown: [] };
  const node = (tag = 'div', attrs = {}) => {
    const el = {
      tag, dataset: { ...attrs }, hidden: false, textContent: '', value: '',
      _html: '', attrs: {},
      get innerHTML() { return el._html; },
      set innerHTML(v) { el._html = v; },
      setAttribute: (k, v) => { el.attrs[k] = v; },
      getAttribute: (k) => el.attrs[k],
      addEventListener: () => {},
      querySelector: () => node(),
      querySelectorAll: () => [],
      closest: (sel) => {
        const m = /\[data-([a-z]+)(?:="([^"]*)")?\]/.exec(sel);
        if (m && el.dataset[m[1]] !== undefined) return el;
        return null;
      },
      matches: () => false,
    };
    return el;
  };

  const cache = new Map();
  const root = node();
  root.addEventListener = (type, fn) => handlers[type]?.push(fn);
  root.querySelector = (sel) => {
    if (!cache.has(sel)) cache.set(sel, node());
    return cache.get(sel);
  };
  root.querySelectorAll = () => [];
  root.ownerDocument = { addEventListener: (type, fn) => handlers[type]?.push(fn) };
  root.fire = async (type, dataset) => {
    const target = node('button', dataset);
    for (const fn of handlers[type]) await fn({ target, preventDefault() {}, key: '' });
  };
  return root;
}

/** A chrome shim. `idb` decides whether IndexedDB works. */
function shim({ idb = 'ok', noReceiver = false } = {}) {
  const registered = {};
  const storage = {};
  const sent = [];

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: (f) => (registered.installed = f) },
      onMessage: { addListener: (f) => (registered.message = f) },
      onSuspend: { addListener: (f) => (registered.suspend = f) },
      sendMessage: (msg) => {
        sent.push(msg);
        if (noReceiver === 'throw') throw new Error('Could not establish connection.');
        if (noReceiver) return Promise.reject(new Error('Receiving end does not exist.'));
        return Promise.resolve();
      },
      lastError: null,
    },
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: storage[k] } : {}),
        set: async (o) => Object.assign(storage, o),
        remove: async (k) => { delete storage[k]; },
      },
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    notifications: { create: () => {} },
    downloads: { download: async () => 1 },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };

  globalThis.indexedDB = {
    open: () => {
      const req = {};
      setTimeout(() => {
        if (idb === 'null-error') { req.error = null; req.onerror?.(); }
        else if (idb === 'fail') { req.error = new Error('quota exceeded'); req.onerror?.(); }
        else if (idb === 'plain') {
          // A working-enough IndexedDB: the log flushes, so the command
          // proceeds to the download call this test is actually about.
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: () => ({
              objectStore: () => ({ put() {}, getAll() { const r = {}; setTimeout(() => { r.result = []; r.onsuccess?.(); }, 0); return r; } }),
              set oncomplete(f) { setTimeout(f, 0); },
              set onerror(_) {}, set onabort(_) {},
            }),
          };
          req.onsuccess?.();
        }
        else { req.onerror?.(); }
      }, 0);
      return req;
    },
  };

  return { registered, sent };
}

/** Load a fresh copy of the worker. Node caches by URL, so bust it. */
async function loadWorker() {
  const path = new URL('../extension/background.js', import.meta.url);
  path.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  await import(path.href);
}

const ask = (registered, msg) =>
  new Promise((res) => {
    const async_ = registered.message(msg, {}, res);
    if (async_ !== true) res({ __sync: true });
  });

test('the worker evaluates and registers its listeners synchronously', async () => {
  /*
   * Registration fails if the worker throws during evaluation — reported by
   * Chrome with the same opaque "status code 3" as a missing file. And a
   * listener registered after an await may miss the wake-up event that
   * started the worker.
   */
  const { registered } = shim();
  await loadWorker();
  assert.equal(typeof registered.message, 'function', 'onMessage must exist immediately');
  assert.equal(typeof registered.installed, 'function');
});

test('the worker DEGRADES HONESTLY when storage is unavailable', async () => {
  /*
   * THE BUG THIS FILE WAS WRITTEN FOR.
   *
   * IndexedDB rejects with `req.error`, which is null when the database
   * cannot be opened at all. `reject(req.error)` then produced
   * "Cannot read properties of undefined (reading 'message')" — an error
   * about the error — while the real fact never reached the log.
   */
  const { registered } = shim({ idb: 'null-error' });
  await loadWorker();
  const state = await ask(registered, { kind: 'state' });

  assert.ok('events' in state, `expected a snapshot, got ${JSON.stringify(state).slice(0, 120)}`);
  const err = state.events.find((e) => e.status === 'error');
  assert.ok(err, 'the failure must be logged, not swallowed');
  assert.match(err.description, /IndexedDB could not be opened/);
  assert.equal(/Cannot read properties/.test(err.description), false,
    'the log must name the real problem, not an error about the error');
});

test('the worker names the real problem even when a rejection carries nothing', async () => {
  /*
   * DEFENCE IN DEPTH, and this test exists because sabotage proved it was
   * untested.
   *
   * Two independent things stop "Cannot read properties of undefined" from
   * reaching the log: idbsink always rejects with a real Error, and the
   * worker's `reason()` tolerates a null one. Sabotaging `reason()` alone
   * changed nothing, because idbsink had already made it unreachable.
   *
   * That is a fine state for the code and a bad state for the tests: the
   * second guard could be deleted and no test would notice, right up until
   * some future rejection path forgets the first. So `reason()` is exercised
   * directly, through a command handler that throws a bare value.
   */
  const { registered } = shim({ idb: 'plain' });
  await loadWorker();

  /*
   * Chrome's own APIs reject with bare strings in places -- `downloads.download`
   * is one, and `chrome.runtime.lastError` is another. A handler that assumes
   * every rejection is an Error turns "Download canceled" into a TypeError.
   */
  chrome.downloads.download = () => Promise.reject('Invalid filename');
  const reply = await ask(registered, { kind: 'download-log' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'Invalid filename', 'the real reason must survive');
  assert.equal(/Cannot read properties/.test(reply.error), false);

  const state = await ask(registered, { kind: 'state' });
  assert.ok('events' in state, 'and the worker survives it');
});

test('the worker still answers after a storage failure', async () => {
  /*
   * Degraded is not dead. The in-memory log still works, so the panel can
   * show the run — the user just loses it on eviction. A worker that stopped
   * answering would present as a frozen UI with no explanation.
   */
  const { registered } = shim({ idb: 'null-error' });
  await loadWorker();
  const state = await ask(registered, { kind: 'state' });
  assert.equal(state.ok, undefined, 'not an error envelope');
  assert.ok(Array.isArray(state.events));
  assert.equal(state.memory, null, 'no project loaded yet, reported as null rather than crashing');
});

test('the worker survives a browser with no panel open', async () => {
  /*
   * With nothing listening, sendMessage either rejects or throws
   * synchronously depending on Chrome version. An unhandled synchronous throw
   * inside broadcast() would break the extension precisely when nobody is
   * watching it — the hardest state to debug.
   */
  for (const mode of [true, 'throw']) {
    const { registered } = shim({ noReceiver: mode });
    await loadWorker();
    const state = await ask(registered, { kind: 'state' });
    assert.ok('events' in state, `no-receiver mode ${mode} broke the worker`);
  }
});

test('an unknown command is refused without killing the worker', async () => {
  const { registered } = shim();
  await loadWorker();
  const reply = await ask(registered, { kind: 'not-a-command' });
  assert.ok(reply.__sync, 'unknown commands are declined, not answered');
  const after = await ask(registered, { kind: 'state' });
  assert.ok('events' in after, 'the worker still works afterwards');
});

test('Start refuses honestly when there is no project yet', async () => {
  /*
   * The adapters now exist, so the old "no adapters" refusal is gone —
   * replaced by the one that is now true. The principle is unchanged and is
   * the point of the test: a Start button that silently does nothing is the
   * hidden-background-process failure in miniature. The refusal must be
   * SPECIFIC and it must be logged.
   */
  const { registered } = shim();
  await loadWorker();
  const reply = await ask(registered, { kind: 'start' });

  assert.equal(reply.ok, false);
  assert.equal(reply.why, 'no project');

  const state = await ask(registered, { kind: 'state' });
  const err = state.events.find((e) => e.status === 'error');
  assert.match(err.description, /No project has been set up/);
});

test('Start refuses when the environment cannot be bound', async () => {
  /*
   * With a project but no usable tabs, the environment contract must refuse
   * rather than improvise — and say which surface is missing.
   */
  const { registered } = shim();
  globalThis.chrome.tabs = { query: async () => [] };
  await loadWorker();

  const reply = await ask(registered, {
    kind: 'start',
    setup: { mode: 'new', prompt: 'A CSV export feature for the reporting dashboard' },
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.why, 'environment');

  const state = await ask(registered, { kind: 'state' });
  assert.ok(state.events.some((e) => e.type === 'environment-drift'));
});

test('the worker exposes analytics, history and replay', async () => {
  const { registered } = shim();
  await loadWorker();
  for (const kind of ['analytics', 'history', 'replay']) {
    const out = await ask(registered, { kind });
    assert.ok(out && typeof out === 'object', `${kind} returned nothing`);
    assert.equal(out.ok, undefined, `${kind} returned an error envelope: ${JSON.stringify(out).slice(0, 120)}`);
  }
});

/* ------------------------------------------------------------ packaging - */

test('extension/ has NO manifest.json, so Chrome cannot be pointed at it', () => {
  /*
   * THE SAME BUG WAS REPORTED TWICE, and the second time the pasted manifest
   * was version 0.2.0 with a `scripting` permission and no `icons` -- i.e. the
   * SOURCE manifest, not the built one. The instruction to load dist/ was
   * correct and the packaging still made the mistake easy: extension/ was the
   * only folder in the repo containing a manifest.json, so it looked like the
   * extension.
   *
   * Documentation was not the fix. The fix is that the folder which cannot
   * work now fails with "Manifest file is missing or unreadable", which names
   * the problem, instead of "Service worker registration failed. Status code:
   * 3", which names nothing.
   */
  const dir = new URL('../extension/', import.meta.url);
  assert.equal(existsSync(new URL('manifest.json', dir)), false,
    'a manifest here makes the broken folder look loadable');
  assert.ok(existsSync(new URL('manifest.template.json', dir)),
    'the template is what the build reads');
});

test('dist/ IS committed — a fresh clone must contain the loadable folder', () => {
  /*
   * dist/ was gitignored, so cloning produced a repo whose only manifest was
   * the one that does not work. Build output in version control is normally
   * wrong; here it is the difference between the discoverable path and the
   * working path being the same path.
   */
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  const active = ignore.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.equal(active.includes('dist/'), false, 'dist/ must not be ignored');
  assert.equal(active.includes('dist'), false, 'dist must not be ignored');
});

test('no extension source imports above its own root', async () => {
  /*
   * The original failure. `background.js` imported `../src/core/…`, which
   * resolves above the directory Chrome was pointed at, and a service worker
   * may not fetch a module outside its package root. Node, the test runner
   * and the demo bundler all resolve `../` happily, which is why 200 passing
   * tests said nothing about it.
   *
   * The build rewrites these into `./core/…`. This asserts the rewrite is
   * still needed and still described, so nobody "tidies up" dist/ away.
   */
  const src = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /\.\.\/src\/core\//, 'source imports are relative to the repo, by design');

  if (existsSync('dist/background.js')) {
    const built = readFileSync('dist/background.js', 'utf8');
    assert.equal(/\.\.\/src\/core\//.test(built), false, 'the build must rewrite them');
    assert.match(built, /\.\/core\//);
  }
});

/* ====================================================== the engine contract */

/**
 * THE BUG THAT MADE THE EXTENSION LOOK DEAD.
 *
 * The panel calls `engine.preflight(setup)`. `client.js` never defined it, so
 * the call returned undefined, throwing inside a click handler where nothing
 * catches. The user pressed the button thirteen times; the exported log shows
 * thirteen "Pressed preflight" lines and no consequence whatsoever.
 *
 * It survived because there are TWO implementations of the `engine` interface
 * -- the demo builds its own, the extension uses `client.js` -- and only the
 * demo's was exercised. demo.html worked perfectly the whole time.
 */
test('client.js implements every method the panel calls on `engine`', () => {
  const panel = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../extension/client.js', import.meta.url), 'utf8');

  const called = new Set(
    [...panel.matchAll(/\bengine(?:\[['"]([a-zA-Z-]+)['"]\]|\.([a-zA-Z]+))\s*\(/g)]
      .map((m) => m[1] || m[2]),
  );
  // Dispatched dynamically from data-action attributes.
  for (const m of panel.matchAll(/data-action="([a-z-]+)"/g)) called.add(m[1]);
  for (const m of panel.matchAll(/const map = \{([^}]+)\}/g)) {
    for (const a of m[1].matchAll(/'([a-z-]+)'/g)) called.add(a[1]);
  }
  // UI-only actions the panel handles itself and never forwards.
  for (const local of ['recheck', 'back', 'confirm-start']) called.delete(local);

  const provided = new Set(
    [...client.matchAll(/^\s{4}'?([a-zA-Z-]+)'?:\s*(?:\(|async|\{)/gm)].map((m) => m[1]),
  );

  const missing = [...called].filter((m) => !provided.has(m));
  assert.deepEqual(missing, [], `panel calls engine.${missing.join('/')} which client.js does not provide`);
});

test('the background worker implements every command client.js sends', () => {
  /*
   * The other half of the same seam. `open-report` was sent and never
   * implemented, so that button was inert too -- it just had not been pressed
   * yet.
   */
  const client = readFileSync(new URL('../extension/client.js', import.meta.url), 'utf8');
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

  const sent = new Set([...client.matchAll(/send\('([a-z-]+)'/g)].map((m) => m[1]));
  for (const m of client.matchAll(/sendMessage\(\{\s*kind:\s*'([a-z-]+)'/g)) sent.add(m[1]);

  const implemented = new Set(
    [...bg.matchAll(/^\s{2}async\s+'?([a-zA-Z-]+)'?\s*\(/gm)].map((m) => m[1]),
  );

  const missing = [...sent].filter((c) => !implemented.has(c));
  assert.deepEqual(missing, [], `client sends "${missing.join('", "')}" which background.js does not handle`);
});

test('a missing control produces a visible error, not silence', async () => {
  /*
   * BEHAVIOUR, not text. The grep-based version of this test passed a
   * sabotage that changed `if (typeof engine[action] !== 'function')` to
   * `if (false)` -- the phrase was still in the file, so the assertion held
   * while the guard was gone. A test that reads source text tests the source
   * text.
   *
   * So this drives the real panel with an engine that is deliberately missing
   * a method, and asserts something the user would actually see.
   */
  const { createPanel } = await import('../extension/panel.js');
  const { Logger } = await import('../src/core/logger.js');

  const logger = new Logger();
  const root = makeRoot();
  const panel = createPanel({
    root,
    repaintMs: 100000, // no timer during the test
    engine: {
      memory: () => null,
      logger: () => logger,
      config: () => ({}),
      startedAt: () => null,
      // `preflight` is deliberately absent — the exact original bug.
    },
  });

  await root.fire('click', { action: 'preflight' });
  panel.destroy();

  const err = logger.live.find((e) => e.status === 'error');
  assert.ok(err, 'pressing a disconnected control must log an error');
  assert.match(err.description, /preflight/);
  assert.match(err.description, /not connected to the background worker/);
});

test('the panel never calls a control without checking it exists', () => {
  /*
   * `engine[action]?.()` silently did nothing for a missing method. Optional
   * chaining is right for an optional thing; a control the UI is rendering is
   * not optional, and treating it as one is how a button becomes inert
   * without a trace.
   */
  /*
   * Comments are stripped first. The panel EXPLAINS the old mistake in prose
   * right next to the fix, and a checker that reads its own rationale as code
   * is the false positive already fixed once in check-loadable.mjs.
   */
  const panel = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/engine\[action\]\?\.\(/.test(panel), false,
    'optional-call on a rendered control hides a missing command');
  assert.match(panel, /typeof engine\[action\] !== 'function'/);
});

test('every UI handler is wrapped so a throw cannot vanish', () => {
  /*
   * An unhandled exception in a side-panel event handler produces no dialog,
   * nothing in the panel, and no console anyone is watching. The log proved
   * the failure was SILENT rather than unlogged -- the button presses were
   * recorded perfectly, and nothing followed them.
   */
  const panel = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /async function guarded\(/);
  for (const [, , handler] of panel.matchAll(/addEventListener\('(click|keydown)',\s*([^\n]+)/g)) {
    assert.match(handler, /guarded\(/, `a ${handler} handler is not wrapped`);
  }
});

/* ============================================================ tab probing */

test('the probe finds the three surfaces among ordinary tabs', async () => {
  const { snapshotEnvironment } = await import('../extension/probe.js');
  const snap = await snapshotEnvironment({
    query: async () => [
      { id: 1, windowId: 1, url: 'https://news.ycombinator.com/', title: 'HN' },
      { id: 11, windowId: 1, url: 'https://chatgpt.com/c/68f21abc-1111', title: 'PM', active: true },
      { id: 22, windowId: 1, url: 'https://arena.ai/w/ws-reporting', title: 'repo' },
      { id: 33, windowId: 1, url: 'https://chat.deepseek.com/a/chat/s/9c04', title: 'strategy' },
      { id: 4, windowId: 1, url: '', title: '' }, // no host permission
    ],
  });
  assert.equal(snap.surfaces.manager.conversationId, '68f21abc-1111');
  assert.equal(snap.surfaces.engineer.conversationId, 'ws-reporting');
  assert.equal(snap.surfaces.reviewer.conversationId, '9c04');
  assert.equal(snap.scanned, 5);
});

test('a ChatGPT tab on the new-chat screen yields no conversation id', async () => {
  /*
   * This is the case that must NOT silently pass: binding to a "new chat"
   * screen means the first paste CREATES a conversation, which is forbidden.
   * The probe reports null and bind() refuses.
   */
  const { snapshotEnvironment } = await import('../extension/probe.js');
  const snap = await snapshotEnvironment({
    query: async () => [{ id: 11, windowId: 1, url: 'https://chatgpt.com/', title: 'ChatGPT' }],
  });
  assert.equal(snap.surfaces.manager.conversationId, null);
});

test('two tabs for one role prefer the active one and record the ambiguity', async () => {
  /*
   * Users keep several ChatGPT tabs open. Silently picking one could drive a
   * conversation they were not looking at, and the run would appear to work.
   */
  const { snapshotEnvironment } = await import('../extension/probe.js');
  const snap = await snapshotEnvironment({
    query: async () => [
      { id: 11, windowId: 1, url: 'https://chatgpt.com/c/aaa', title: 'old', active: false },
      { id: 12, windowId: 1, url: 'https://chatgpt.com/c/bbb', title: 'current', active: true },
    ],
  });
  assert.equal(snap.surfaces.manager.conversationId, 'bbb', 'the active tab wins');
  assert.equal(snap.ambiguous.manager, 2, 'and the ambiguity is reported, not hidden');
});

test('the probe requests no "tabs" permission it does not need', () => {
  /*
   * chrome.tabs.query works without it; url and title are simply blank for
   * tabs the extension has no host permission for. Since the manifest grants
   * exactly the four AI hosts, the extension can see what it must drive and
   * is blind to everything else.
   */
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.template.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('tabs'), false);
});

/* ========================================================== surface scans */

/** A chrome shim whose executeScript is controllable. */
function scanShim({ fail = false } = {}) {
  const base = shim();
  let injections = 0;
  globalThis.chrome.tabs = {
    query: async () => [
      { id: 11, windowId: 1, active: true, url: 'https://chatgpt.com/c/abc-111', title: 'PM' },
      { id: 22, windowId: 1, active: false, url: 'https://arena.ai/w/ws-report', title: 'repo' },
    ],
  };
  globalThis.chrome.scripting = {
    executeScript: async () => {
      injections++;
      if (fail) throw new Error('page closed');
      return [{ result: {
        at: Date.now(), url: 'https://arena.ai/w/ws-report', title: 'repo',
        readyState: 'complete', visibility: 'visible',
        scroll: { x: 0, y: 0 }, viewport: { w: 1440, h: 900 },
        counts: { elements: 5200, inputs: 2, buttons: 11, iframes: 0 },
        signals: ['You have reached your usage limit for today.'],
        nodes: [{ path: 'form > button[send]', tag: 'BUTTON', testid: 'send', label: 'Send', disabled: true, box: { x: 0, y: 0, w: 40, h: 40 } }],
      } }];
    },
  };
  return { ...base, injections: () => injections };
}

test('an error in the log automatically captures the page behind it', async () => {
  const s = scanShim();
  await loadWorker();

  await ask(s.registered, {
    kind: 'log', type: 'response-timeout',
    fields: { status: 'error', source: 'arena', description: 'no response in 300s', data: { surface: 'engineer' } },
  });
  await new Promise((r) => setTimeout(r, 150));

  const state = await ask(s.registered, { kind: 'state' });
  const scan = state.events.find((e) => e.type === 'surface-scan');

  assert.ok(scan, 'a page-level error must capture the page');
  assert.equal(s.injections(), 1);
  assert.equal(scan.channel, 'evidence', 'a capture is evidence, not a second error');
  assert.ok(scan.correlationId, 'the capture links back to the error that caused it');
  assert.match(scan.data.markdown, /usage limit/, 'and carries what the page said');
  assert.match(scan.data.markdown, /disabled/);
});

test('a FAILING scan logs once and does not feed itself', async () => {
  /*
   * The trigger is "an error was logged" and a failed scan logs an error.
   * Without the NEVER_SCAN list plus the reentrancy latch, this test would
   * not terminate — it would fill the log until the process died.
   */
  const s = scanShim({ fail: true });
  await loadWorker();

  await ask(s.registered, {
    kind: 'log', type: 'response-timeout',
    fields: { status: 'error', source: 'arena', description: 'boom', data: { surface: 'engineer' } },
  });
  await new Promise((r) => setTimeout(r, 300));

  const state = await ask(s.registered, { kind: 'state' });
  const failures = state.events.filter((e) => e.type === 'surface-scan-failed');
  assert.equal(failures.length, 1, `expected exactly one failure entry, got ${failures.length}`);
  assert.ok(state.events.length < 10, 'the log must not run away');
});

test('a success never triggers a scan', async () => {
  const s = scanShim();
  await loadWorker();
  await ask(s.registered, { kind: 'log', type: 'response-received', fields: { source: 'arena', data: { surface: 'engineer' } } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.injections(), 0);
});

test('the scan budget is reported in state, so it cannot look broken silently', async () => {
  const s = scanShim();
  await loadWorker();
  const state = await ask(s.registered, { kind: 'state' });
  assert.ok(state.scans, 'the panel can show how many scans were taken and why others were not');
  assert.equal(typeof state.scans.used, 'number');
});

test('the scripting permission is declared, because scanning uses it', () => {
  /*
   * It was stripped one session ago on the grounds that nothing called it.
   * Something does now. The build re-adds it only when `chrome.scripting`
   * actually appears in the source, so the manifest cannot drift from the
   * truth in either direction.
   */
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.template.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('scripting'));
  const scan = readFileSync(new URL('../extension/scan.js', import.meta.url), 'utf8');
  assert.match(scan, /chrome\.scripting\.executeScript/);
});

test('the scanner never writes to the page', () => {
  /*
   * A diagnostic that perturbs the thing it is diagnosing is worse than none,
   * and this one runs precisely when something is already wrong.
   */
  const scan = readFileSync(new URL('../extension/scan.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['.click(', '.focus(', 'dispatchEvent', '.scrollTo(', '.value =', 'innerHTML =', '.remove()', 'setAttribute(']) {
    assert.equal(scan.includes(forbidden), false, `the scanner must not call ${forbidden}`);
  }
});

/* ============================================ arena URL shapes (session 9) */

test('ARENA CONVERSATION URLS RESOLVE, whatever route they use', async () => {
  /*
   * THE REPORTED BUG. A user had the Arena tab open on the correct workspace
   * and preflight said "not on an existing conversation (no id)". The tab was
   * found; none of four hard-coded URL patterns matched, so the probe reported
   * no id and the run was refused.
   *
   * Hard-coding a fifth pattern would fix that URL and fail the next redesign,
   * so the probe now falls back to deriving an id from whatever path exists.
   */
  const { snapshotEnvironment } = await import('../extension/probe.js');
  const shapes = [
    ['https://arena.ai/w/ws-7', 'ws-7'],
    ['https://arena.ai/chats/abc123', 'abc123'],
    ['https://arena.ai/chat/abc123', 'abc123'],
    ['https://arena.ai/session/abc123', 'abc123'],
    ['https://arena.ai/threads/t-99', 't-99'],
    ['https://arena.ai/projects/my-proj', 'my-proj'],
    ['https://arena.ai/a/1f2e3d4c-5b6a', '1f2e3d4c-5b6a'],
    ['https://arena.ai/?conversation=abc123', 'abc123'],
    ['https://arena.ai/#/chat/abc1234', 'abc1234'],
    ['https://www.arena.ai/chats/zz99', 'zz99'],
  ];

  for (const [url, expected] of shapes) {
    const snap = await snapshotEnvironment({
      query: async () => [{ id: 22, windowId: 1, url, title: 'workspace' }],
    });
    assert.equal(
      snap.surfaces.engineer?.conversationId, expected,
      `${url} should yield "${expected}"`,
    );
  }
});

test('a NON-conversation Arena page still yields no id', async () => {
  /*
   * The generic fallback must not overreach. Treating /settings as a
   * conversation would be worse than finding nothing: the run would bind to a
   * settings page and start pasting into it.
   */
  const { snapshotEnvironment } = await import('../extension/probe.js');
  for (const url of ['https://arena.ai/', 'https://arena.ai/chat', 'https://arena.ai/login', 'https://arena.ai/settings']) {
    const snap = await snapshotEnvironment({
      query: async () => [{ id: 22, windowId: 1, url, title: 'Arena' }],
    });
    assert.equal(snap.surfaces.engineer?.conversationId, null, `${url} must not look like a conversation`);
  }
});

test('a failed tab check SHOWS THE URL IT FOUND', async () => {
  /*
   * "not on an existing conversation" is accurate and useless — it reports the
   * conclusion, not the input, so neither the user nor I could tell whether
   * the tab was wrong or the pattern was. A check that fails must show what it
   * saw.
   */
  const { preflight } = await import('../src/core/preflight.js');
  const { Logger } = await import('../src/core/logger.js');
  const { MemoryLogSink } = await import('../src/core/logsink.js');
  const { MemoryStore } = await import('../src/core/store.js');

  const result = await preflight({
    setup: { mode: 'existing', prompt: '' },
    snapshot: {
      surfaces: {
        manager: { tabId: 11, url: 'https://chatgpt.com/c/abc', conversationId: 'abc', ready: true, signedIn: true },
        engineer: { tabId: 22, url: 'https://arena.ai/some/unknown/route', conversationId: null, ready: true, signedIn: true },
      },
    },
    hosts: { manager: ['chatgpt.com'], engineer: ['arena.ai'] },
    logger: new Logger({ sink: new MemoryLogSink() }),
    store: new MemoryStore(),
  });

  assert.equal(result.ok, false);
  const tab = result.checks.find((c) => c.key === 'tab-engineer');
  assert.match(tab.detail, /arena\.ai\/some\/unknown\/route/, 'the URL must appear in the failure');

  const ws = result.checks.find((c) => c.key === 'workspace');
  assert.match(ws.detail, /arena\.ai\/some\/unknown\/route/);
  assert.match(ws.remedy, /report the URL/, 'and the user is told what would help');
});

test('the worker can report what it sees without changing anything', async () => {
  const s = shim();
  globalThis.chrome.tabs = {
    query: async () => [
      { id: 11, windowId: 1, url: 'https://chatgpt.com/c/abc', title: 'PM', active: true },
      { id: 22, windowId: 1, url: 'https://arena.ai/unknown-route', title: 'Arena' },
      { id: 44, windowId: 1, url: 'https://news.ycombinator.com/', title: 'HN' },
      { id: 55, windowId: 1, url: '', title: '' },
    ],
  };
  await loadWorker();
  const d = await ask(s.registered, { kind: 'diagnose' });

  assert.equal(d.tabsTotal, 4);
  assert.equal(d.candidates.length, 2, 'only AI hosts are listed');
  assert.equal(d.invisible, 1, 'unreadable tabs are counted separately from missing ones');
  assert.ok(d.candidates.some((c) => c.url.includes('arena.ai')));
  assert.ok(d.expectedHosts.engineer.includes('arena.ai'));
});

/* =================================== verified platform facts (session 10) */

test('ChatGPT conversation URLs resolve, including custom GPTs', async () => {
  /*
   * Verified against live URL shapes, August 2026. The custom-GPT form
   * (/g/<gpt>/c/<uuid>) was previously matched by the bare /c/ pattern only by
   * luck of ordering; it is now explicit and first.
   */
  const { snapshotEnvironment } = await import('../extension/probe.js');
  const cases = [
    ['https://chatgpt.com/c/68f21abc-1111', '68f21abc-1111'],
    ['https://chatgpt.com/g/g-abc123-helper/c/9f8e7d6c', '9f8e7d6c'],
    ['https://chat.openai.com/c/legacy-uuid-1', 'legacy-uuid-1'],
  ];
  for (const [url, expected] of cases) {
    const snap = await snapshotEnvironment({ query: async () => [{ id: 11, windowId: 1, url, title: 'c' }] });
    assert.equal(snap.surfaces.manager?.conversationId, expected, url);
  }
});

test('A SHARED ChatGPT conversation is NOT bindable', async () => {
  /*
   * /share/<id> is read-only. Binding to one would produce a run that pastes
   * prompts into a page that cannot accept them, and the failure would look
   * like a broken composer selector rather than the wrong tab.
   */
  const { snapshotEnvironment } = await import('../extension/probe.js');
  for (const url of ['https://chatgpt.com/share/abc-123', 'https://chatgpt.com/', 'https://chatgpt.com/?q=hello']) {
    const snap = await snapshotEnvironment({ query: async () => [{ id: 11, windowId: 1, url, title: 'c' }] });
    assert.equal(snap.surfaces.manager?.conversationId, null, `${url} must not be bindable`);
  }
});

test('THE RUN IS NOT AWAITED INSIDE ONE MESSAGE EVENT', async () => {
  /*
   * Chrome terminates a service worker when "a single request, such as an
   * event or API call, takes longer than 5 minutes to process"
   * (developer.chrome.com, verified August 2026).
   *
   * `Runner.start()` is a multi-hour loop. Awaiting it inside onMessage made
   * the whole run one event, so Chrome would have killed the worker at five
   * minutes — mid-iteration, on the first real run. The handler must return
   * promptly and let the run proceed detached.
   */
  const s = scanShim();
  globalThis.chrome.tabs = {
    query: async () => [
      { id: 11, windowId: 1, url: 'https://chatgpt.com/c/abc', title: 'PM', active: true },
      { id: 22, windowId: 1, url: 'https://arena.ai/w/ws-7', title: 'Arena' },
    ],
  };
  await loadWorker();

  const began = Date.now();
  const reply = await ask(s.registered, {
    kind: 'start',
    setup: { mode: 'new', prompt: 'A CSV export feature for the reporting dashboard' },
  });
  const took = Date.now() - began;

  assert.equal(reply.started, true, 'start must acknowledge immediately');
  assert.ok(took < 2000, `start() blocked for ${took}ms — it must not await the whole run`);
});

test('the per-response timeout sits UNDER Chrome\'s five-minute ceiling', async () => {
  /*
   * 300_000ms sat exactly on the platform limit: a single slow reply raced
   * Chrome's own kill timer, and which won depended on scheduling noise. A
   * timeout must be OUR timeout, with our error and our retry.
   */
  const { DEFAULT_POLICY } = await import('../src/adapters/base.js');
  const { DEFAULTS } = await import('../src/transports/dom.js');
  const CHROME_EVENT_CEILING_MS = 300_000;

  assert.ok(DEFAULT_POLICY.timeoutMs < CHROME_EVENT_CEILING_MS,
    `adapter timeout ${DEFAULT_POLICY.timeoutMs} must be under ${CHROME_EVENT_CEILING_MS}`);
  assert.ok(DEFAULTS.timeoutMs < CHROME_EVENT_CEILING_MS,
    `transport timeout ${DEFAULTS.timeoutMs} must be under ${CHROME_EVENT_CEILING_MS}`);
  assert.ok(DEFAULT_POLICY.timeoutMs >= 120_000, 'but long enough for a real build-and-test cycle');
});

test('the keep-alive runs only while a run is in flight', () => {
  /*
   * An unconditional keep-alive is the pattern Chrome's own docs warn against
   * and the Web Store rejects. The heartbeat exists because during a
   * multi-minute AI wait the orchestrator makes no API calls at all, so the
   * 30s idle timer is never reset.
   */
  const src = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /function startHeartbeat/);
  assert.match(src, /if \(!running\) \{ stopHeartbeat\(\); return; \}/,
    'the heartbeat must stop itself when no run is active');
  assert.match(src, /stopHeartbeat\(\);\n        await logger\.flush/,
    'and must be stopped when the run ends');
});

test('minimum_chrome_version matches the highest API actually used', () => {
  /*
   * chrome.sidePanel is Chrome 114, as is the 10 MB storage.local quota.
   * Claiming a lower minimum would install on browsers where the side panel
   * silently does not exist.
   */
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.template.json', import.meta.url), 'utf8'));
  assert.equal(manifest.minimum_chrome_version, '114');
  assert.ok(manifest.side_panel, 'the side panel is what sets that floor');
});
