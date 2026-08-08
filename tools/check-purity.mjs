#!/usr/bin/env node
/**
 * THE ARCHITECTURAL BET, ENFORCED.
 *
 * docs/SPEC.md makes one structural promise: the orchestration engine never
 * touches a browser. That is what makes the roadmap's third step -- adding a
 * local companion for real builds and coverage -- a new adapter rather than a
 * rewrite.
 *
 * A promise like that decays silently. One `chrome.storage` call inside a
 * scoring path, added at 2am because it was convenient, and the property is
 * gone. Nobody notices until the companion work starts and the engine turns
 * out to be welded to the extension.
 *
 * So it is a build check, not a convention.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE = 'src/core';

/** Globals that only exist in a browser, or that reach the network directly. */
const FORBIDDEN = [
  { re: /(?<![.\w$])chrome\s*\./, why: 'extension API' },
  { re: /(?<![.\w$])browser\s*\./, why: 'extension API' },
  /*
   * `(?<![.\w$])` -- not preceded by a dot or an identifier character.
   *
   * The first version matched any `window.`, which flagged a local
   * `const window = reviews.slice(...)` in stop.js. That was a false positive
   * AND a real code smell, so both were fixed: the variable was renamed, and
   * the pattern now ignores property access like `foo.window`.
   */
  { re: /(?<![.\w$])document\s*\./, why: 'DOM' },
  { re: /(?<![.\w$])window\s*\./, why: 'DOM' },
  { re: /\blocalStorage\b/, why: 'browser storage' },
  /*
   * `fetch(` only when it is a GLOBAL call, not a method.
   *
   * The first version flagged `this.fetch(artifact)` in artifacts.js -- a
   * registry method that downloads a file through an injected downloader and
   * touches no network itself. The name is the right name for what it does,
   * and renaming a method to appease a checker is how checkers start being
   * worked around instead of fixed (§32).
   *
   * `(?<![.\w$])` -- not preceded by a dot or identifier character -- is the
   * same guard already used for `window.` and `document.`, applied here.
   */
  { re: /(?<![.\w$])(?<!async\s)(?<!function\s)fetch\s*\(/, why: 'network — belongs in a transport' },
  { re: /\bXMLHttpRequest\b/, why: 'network — belongs in a transport' },
];

/**
 * store.js is the documented seam.
 *
 * Persistence has to reach chrome.storage SOMEWHERE, and putting it behind the
 * same adapter treatment as the AIs would be ceremony for one call. It is
 * exempt by name, so the exemption is visible rather than implicit.
 */
const EXEMPT = new Set(['store.js']);

const problems = [];

for (const file of readdirSync(CORE).filter((f) => f.endsWith('.js'))) {
  if (EXEMPT.has(file)) continue;
  const src = readFileSync(join(CORE, file), 'utf8');

  // Strip comments: this file's own prose mentions `chrome.` while explaining
  // why chrome is banned, and a checker that flags its own documentation is a
  // checker people disable.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const { re, why } of FORBIDDEN) {
    const m = code.match(re);
    if (m) {
      const line = code.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line} uses ${m[0].trim()} (${why})`);
    }
  }

  // The core may only import from within the core.
  for (const im of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = im[1];
    if (spec.startsWith('./')) continue;
    problems.push(`${file} imports "${spec}" — the core must depend on nothing outside itself`);
  }
}

if (problems.length) {
  console.error('the engine has leaked into the browser:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ok: ${readdirSync(CORE).filter((f) => f.endsWith('.js')).length} core modules, no browser dependencies`);
