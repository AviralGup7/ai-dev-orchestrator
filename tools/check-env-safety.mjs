#!/usr/bin/env node
/**
 * THE PRE-INITIATED ENVIRONMENT CONSTRAINT, ENFORCED BY GREP.
 *
 * The user's constraint is that the orchestrator inherits a prepared browser
 * and never changes it: no new tabs, no new conversations, no sign-in, no
 * navigation, no refresh, no closing, no duplicating, no settings changes.
 *
 * `src/core/actions.js` enforces that for anything routed through the guard.
 * This checker covers the other half -- code that bypasses the guard entirely
 * and calls `chrome.tabs.create` directly. That is the realistic failure: not
 * malice, but a recovery path written at speed, because "the tab died, just
 * reopen it" is a genuinely tempting thing to write.
 *
 * A CAPABILITY THAT IS NEVER CALLED CANNOT BE CALLED BY ACCIDENT. So the API
 * names are banned from the source tree outright, and the ban is checked in CI
 * rather than reviewed by eye.
 *
 * Run: node tools/check-env-safety.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'extension'];

/**
 * Each entry: the API, and why it is forbidden in the user's words.
 *
 * `tabs.update` is subtle -- it is legitimate for `{active: true}`, which is
 * how focus is switched, and forbidden for `{url}`, which is navigation. A
 * regex cannot reliably tell those apart across line breaks, so the rule is
 * narrower and honest: flag `url:` appearing inside a `tabs.update(` call on
 * the same statement, and let the guard handle the rest.
 */
const BANNED = [
  [/\btabs\s*\.\s*create\s*\(/, 'opens a new tab — the environment is pre-initiated'],
  [/\btabs\s*\.\s*remove\s*\(/, 'closes a tab the user opened'],
  [/\btabs\s*\.\s*duplicate\s*\(/, 'duplicates a tab'],
  [/\btabs\s*\.\s*reload\s*\(/, 'refreshes a page — destroys in-flight AI responses'],
  [/\btabs\s*\.\s*goBack\s*\(|\btabs\s*\.\s*goForward\s*\(/, 'navigates the user away'],
  [/\btabs\s*\.\s*update\s*\([^)]*\burl\s*:/, 'navigates an existing tab to a new URL'],
  [/\bwindows\s*\.\s*create\s*\(/, 'opens a new window'],
  [/\bwindows\s*\.\s*remove\s*\(/, 'closes a window'],
  [/\bchrome\s*\.\s*(?:browsingData|privacy|proxy|contentSettings)\b/, 'changes browser settings'],
  [/\bmanagement\s*\.\s*setEnabled\s*\(/, 'changes extension settings'],
  [/\bcookies\s*\.\s*remove\s*\(/, 'would sign the user out'],
  [/\blocation\s*\.\s*(?:replace|reload|assign)\s*\(/, 'navigates or refreshes the page'],
  [/\blocation\s*\.\s*href\s*=/, 'navigates the page'],
  [/\bwindow\s*\.\s*open\s*\(/, 'opens a new tab or window'],
];

/** Files whose JOB is to name these APIs in order to forbid them. */
const EXEMPT = new Set([
  'actions.js',        // the enumeration itself
  'check-env-safety.mjs',
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a root that does not exist yet is not a violation
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(m?js|ts)$/.test(e)) yield p;
  }
}

const problems = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const name = file.split('/').pop();
    if (EXEMPT.has(name)) continue;

    const src = readFileSync(file, 'utf8');
    // Comments are stripped: this project documents its bans in prose next to
    // the code that upholds them, and a checker that flags its own rationale
    // is a checker somebody deletes.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const [re, why] of BANNED) {
      const m = code.match(re);
      if (m) {
        const line = code.slice(0, m.index).split('\n').length;
        problems.push(`${file}:${line}  ${m[0].trim()} — ${why}`);
      }
    }
  }
}

if (problems.length) {
  console.error(
    'the orchestrator is trying to change the user\'s browser:\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n\nThe environment is prepared by the user before the run. If a surface is\n' +
      'missing, the correct behaviour is to pause, log, inform and wait.',
  );
  process.exit(1);
}

console.log('ok: no tab creation, navigation, refresh, sign-in or settings changes');
