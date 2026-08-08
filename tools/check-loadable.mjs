#!/usr/bin/env node
/**
 * CAN CHROME ACTUALLY LOAD THIS?
 *
 * Written after `dist/` did not exist and `extension/` was loaded directly,
 * producing:
 *
 *     Service worker registration failed. Status code: 3
 *
 * Nothing was syntactically wrong. 200 tests passed, the purity checker
 * passed, the demo bundle ran. The problem was structural — `background.js`
 * imported `../src/core/orchestrator.js`, above the extension root — and no
 * check covered it because Node, the test runner and the demo bundler all
 * resolve `../` happily. Chrome does not.
 *
 * So this verifies the two things only a browser previously verified:
 *
 *   1. STRUCTURE — every import, script src and manifest path resolves inside
 *      the package root.
 *   2. EVALUATION — the service worker actually runs. Registration failing is
 *      not only a fetch problem; a throw at module top level fails it too, and
 *      the reported message is just as unhelpful.
 *
 * Run: node tools/check-loadable.mjs   (after tools/build-extension.mjs)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = 'dist';
const problems = [];
const notes = [];

if (!existsSync(ROOT)) {
  console.error('dist/ does not exist — run `npm run build` first.');
  process.exit(1);
}

/* ============================================================= structure = */

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const files = [...walk(ROOT)];

/**
 * Comments are stripped before scanning.
 *
 * The first version of this checker reported `dist/core/scoring.js imports
 * bare specifier "1,200 tests, all passing"` -- it had matched the word
 * `from` inside a sentence in a doc comment. This project's modules carry a
 * lot of prose, so a checker that reads prose as code produces confident
 * nonsense, and a checker people learn to disbelieve is worse than none.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

for (const file of files.filter((f) => f.endsWith('.js'))) {
  const code = stripComments(readFileSync(file, 'utf8'));

  for (const m of code.matchAll(/^\s*(?:import|export)[^;\n]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1] || m[2];
    if (!spec.startsWith('.')) {
      /*
       * A bare specifier is a hard failure in an extension. There is no import
       * map and no bundler at runtime, so `import x from "lodash"` is simply a
       * 404 at registration time — the same status-3 error, from a different
       * cause.
       */
      problems.push(`${file} imports bare specifier "${spec}" — extensions have no module resolver`);
      continue;
    }
    const resolved = join(dirname(file), spec);
    if (!existsSync(resolved)) {
      problems.push(`${file} imports "${spec}" → ${resolved} which does not exist`);
    } else if (!resolved.startsWith(ROOT)) {
      problems.push(`${file} imports "${spec}" — resolves OUTSIDE ${ROOT}/; Chrome cannot fetch it`);
    }
  }

  /*
   * Top-level await in the service worker.
   *
   * Legal in a module worker, and still a bad idea in this one: the listeners
   * must be registered synchronously during evaluation, or Chrome may deliver
   * the wake-up event before they exist and the worker looks dead. Reported as
   * a note for entry points, an error for the worker itself.
   */
  /*
   * TOP-LEVEL await is at COLUMN ZERO. Anything indented is inside a function.
   *
   * The first version matched `^\s*` and therefore flagged every `await` in
   * every method of every module -- nine files, all wrong. `await` inside an
   * async function is not top-level and never was.
   */
  const topLevelAwait = /^(?:const|let|var)\s[^\n=]*=\s*await\s|^await\s/m.test(code);
  if (topLevelAwait) {
    const rel = file.slice(ROOT.length + 1);
    if (rel === 'background.js') {
      problems.push(`${file} uses top-level await — listeners must register synchronously in a service worker`);
    } else {
      notes.push(`${rel} uses top-level await (fine for a document, not for the worker)`);
    }
  }
}

for (const file of files.filter((f) => f.endsWith('.html'))) {
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#)/.test(ref)) {
      problems.push(`${file} references remote resource "${ref}" — MV3 forbids remotely hosted code`);
      continue;
    }
    if (!existsSync(join(dirname(file), ref))) {
      problems.push(`${file} references "${ref}" which is missing`);
    }
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(code)) {
    problems.push(`${file} contains an inline <script> — blocked by the MV3 content security policy`);
  }
  if (/\son[a-z]+=["']/.test(code)) {
    problems.push(`${file} has an inline event handler attribute — blocked by the MV3 CSP`);
  }
}

/* ============================================================== manifest = */

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

for (const [what, rel] of [
  ['background.service_worker', manifest.background?.service_worker],
  ['action.default_popup', manifest.action?.default_popup],
  ['side_panel.default_path', manifest.side_panel?.default_path],
  ...Object.entries(manifest.icons || {}).map(([k, v]) => [`icons.${k}`, v]),
  ...Object.entries(manifest.action?.default_icon || {}).map(([k, v]) => [`action.default_icon.${k}`, v]),
]) {
  if (rel && !existsSync(join(ROOT, rel))) problems.push(`manifest ${what} → "${rel}" is missing`);
}

if (manifest.background && manifest.background.type !== 'module') {
  problems.push('background.type must be "module" — the worker uses import statements');
}

/* Icons must be real PNGs. A zero-byte or text placeholder makes
   notifications.create throw at the moment it is reporting a failure. */
for (const rel of new Set(Object.values(manifest.icons || {}))) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const b = readFileSync(p);
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    problems.push(`${rel} is not a valid PNG`);
  } else if (statSync(p).size < 60) {
    problems.push(`${rel} is suspiciously small (${statSync(p).size} bytes)`);
  }
}

/* Permissions that are declared but never used inflate the install prompt. */
const allCode = files.filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
for (const perm of manifest.permissions || []) {
  const api = { storage: 'chrome.storage', sidePanel: 'sidePanel', downloads: 'chrome.downloads', notifications: 'notifications', scripting: 'chrome.scripting', tabs: 'chrome.tabs' }[perm];
  if (api && !allCode.includes(api)) {
    notes.push(`permission "${perm}" is declared but ${api} is never called`);
  }
}

/* ============================================================ evaluation = */

/**
 * Actually evaluate the service worker against a chrome shim.
 *
 * Structure checks catch a bad path. They do not catch a throw during module
 * evaluation, which fails registration with the same opaque message. The only
 * way to know the worker runs is to run it.
 */
const registered = {};
const storage = {};

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener: (f) => (registered.installed = f) },
    onMessage: { addListener: (f) => (registered.message = f) },
    onSuspend: { addListener: (f) => (registered.suspend = f) },
    sendMessage: async () => {},
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

/*
 * IndexedDB is deliberately made to FAIL here.
 *
 * The happy path is not the interesting one. A worker that only survives when
 * storage works will die on the machines where storage does not — and this
 * exact shim found a real bug: `reject(req.error)` with a null `error`
 * produced "Cannot read properties of undefined (reading 'message')", an error
 * about the error, while the real fact never reached the log.
 */
globalThis.indexedDB = {
  open: () => {
    const req = {};
    setTimeout(() => req.onerror && req.onerror(), 0);
    return req;
  },
};

try {
  /*
   * Cache-busted on purpose.
   *
   * Node caches ES modules by URL, so a bare import returns the previously
   * evaluated module -- and this checker's own sabotage test proved it:
   * injecting `throw new Error(...)` at the top of background.js was reported
   * as "loadable" because the module had already been imported in a prior run
   * within the same process. Chrome evaluates the worker fresh every time; so
   * must this.
   */
  const url = new URL(`../${ROOT}/background.js`, import.meta.url);
  url.searchParams.set('t', String(Date.now()));
  await import(url.href);
} catch (err) {
  problems.push(`the service worker threw during evaluation: ${String(err?.message || err)}`);
}

if (!problems.length) {
  if (typeof registered.message !== 'function') {
    problems.push('the worker registered no onMessage listener — the panel could never talk to it');
  } else {
    const reply = await new Promise((res) => {
      const ok = registered.message({ kind: 'state' }, {}, res);
      if (ok !== true) res({ __sync: true });
    });
    if (reply?.ok === false) {
      problems.push(`the worker failed its first "state" request: ${reply.error}`);
    } else if (!('events' in (reply || {}))) {
      problems.push(`the worker's "state" reply is not a snapshot: ${JSON.stringify(reply).slice(0, 120)}`);
    } else {
      const degraded = reply.events.find((e) => e.status === 'error');
      if (degraded) notes.push(`worker started in a degraded state and said so: "${degraded.description}"`);
    }
  }
}

/* ================================================================= stale = */

/**
 * IS dist/ CURRENT?
 *
 * dist/ is committed, which makes the working path discoverable but
 * introduces a new failure: a stale dist/ that no longer matches src/. The
 * symptom would be worse than the original bug -- code that looks right in the
 * editor and behaves like an older version in the browser.
 *
 * Rebuilding is cheap and deterministic, so the check is simply: does every
 * shipped file match its source byte-for-byte?
 */
{
  const stale = [];

  for (const f of readdirSync('src/core').filter((x) => x.endsWith('.js'))) {
    const shipped = join(ROOT, 'core', f);
    if (!existsSync(shipped)) { stale.push(`core/${f} is missing from dist/`); continue; }
    if (readFileSync(join('src/core', f), 'utf8') !== readFileSync(shipped, 'utf8')) {
      stale.push(`core/${f} differs from src/core/${f}`);
    }
  }

  const REWRITE = /(['"])\.\.\/src\/core\/([A-Za-z0-9_.-]+\.js)\1/g;
  for (const f of readdirSync('extension')) {
    if (f === 'manifest.template.json' || f.endsWith('.md')) continue;
    const shipped = join(ROOT, f);
    if (!existsSync(shipped)) { stale.push(`${f} is missing from dist/`); continue; }
    const expected = f.endsWith('.js')
      ? readFileSync(join('extension', f), 'utf8').replace(REWRITE, (_m, q, n) => `${q}./core/${n}${q}`)
      : readFileSync(join('extension', f), 'utf8');
    if (expected !== readFileSync(shipped, 'utf8')) stale.push(`${f} differs from extension/${f}`);
  }

  const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (manifest.version !== pkgVersion) {
    stale.push(`manifest version ${manifest.version} != package.json ${pkgVersion}`);
  }

  if (stale.length) {
    problems.push(...stale.map((s2) => `${s2} — dist/ is stale; run \`npm run build\``));
  }
}

/* ================================================================ report = */

for (const n of notes) console.log(`note: ${n}`);

if (problems.length) {
  console.error(`\n${ROOT}/ cannot be loaded by Chrome:\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

console.log(`ok: ${ROOT}/ is loadable — ${files.length} files, worker evaluates and answers`);
