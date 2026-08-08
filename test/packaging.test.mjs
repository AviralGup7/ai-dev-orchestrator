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

test('Start refuses honestly while no AI adapters exist', async () => {
  /*
   * A Start button that silently does nothing is the hidden-background-process
   * failure in miniature: the user cannot tell whether it is working quietly
   * or broken.
   */
  const { registered } = shim();
  await loadWorker();
  const reply = await ask(registered, { kind: 'start' });
  assert.equal(reply.ok, false);
  assert.equal(reply.why, 'no adapters');

  const state = await ask(registered, { kind: 'state' });
  const err = state.events.find((e) => e.status === 'error');
  assert.match(err.description, /No AI adapters are registered/);
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
