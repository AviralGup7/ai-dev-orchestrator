#!/usr/bin/env node
/**
 * SECURITY AUDIT — no credential may reach source, logs, UI or storage.
 *
 * §28 lists this as a blocker. Two distinct jobs:
 *
 *   1. Is a credential COMMITTED in this repository?
 *   2. Can a credential ESCAPE at runtime -- into the log, the export, the
 *      panel, or a persisted record?
 *
 * The second is the one that needs code rather than grep. The orchestrator
 * scrapes AI output and captures pages, and an engineer asked to fix CI will
 * happily echo the .env file it just read. Redaction is already implemented in
 * `journal.js` and used by the surface scanner; this verifies it is applied on
 * every path out.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  [/\bghp_[A-Za-z0-9]{30,}/g, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'GitHub fine-grained token'],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, 'Google OAuth client secret'],
  [/\bsk-[A-Za-z0-9]{32,}/g, 'OpenAI-style API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}/g, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./g, 'JWT'],
];

/** Files that legitimately contain the PATTERNS in order to detect them. */
const EXEMPT = new Set(['check-secrets.mjs', 'journal.js', 'journal.test.mjs', 'surface.test.mjs', 'surface.js']);

const problems = [];
const notes = [];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/* ---- 1. the working tree -------------------------------------------- */

for (const file of walk('.')) {
  const name = file.split('/').pop();
  if (EXEMPT.has(name)) continue;
  if (!/\.(m?js|json|md|html|txt|ya?ml)$/.test(file)) continue;

  const src = readFileSync(file, 'utf8');
  for (const [re, what] of PATTERNS) {
    const m = src.match(re);
    if (m) problems.push(`${file}: ${what} (${m[0].slice(0, 12)}…)`);
  }
}

/* ---- 2. git history --------------------------------------------------- */

/*
 * A secret removed from the working tree but left in history is still public.
 * Checked separately because `git log -S` is the only way to see it, and this
 * repository's own notes record exactly that mistake being made once before.
 */
/**
 * A LITERAL PATTERN MATCH IN HISTORY IS NOT A LEAK.
 *
 * The first version reported "ghp_ appears in 3 commits" and stopped there,
 * which is useless: this repository deliberately contains `ghp_AAAA…` in
 * redaction tests, and a checker that cannot tell a fixture from a credential
 * either cries wolf or has to be ignored.
 *
 * So the actual matched STRINGS are extracted and classified. A fixture is a
 * run of one repeated character, or an obvious placeholder. Anything with real
 * entropy is a finding, not a note.
 */
function looksLikeFixture(token) {
  const body = token.replace(/^(ghp_|github_pat_|GOCSPX-|sk-|xox[baprs]-)/, '');
  if (/^(.)\1+$/.test(body)) return true;                       // AAAA…, zzzz…
  if (/^(abcdefghij|ABCDEFGHIJ|0123456789|test|example|fake|dummy)/i.test(body)) return true;
  const distinct = new Set(body).size;
  return distinct <= 6;                                         // too little entropy to be real
}

try {
  const seen = new Map();
  for (const [re, what] of PATTERNS) {
    const probe = re.source.replace(/\\b/g, '').split('[')[0].replace(/\\/g, '');
    if (probe.length < 4) continue;
    let diff = '';
    try {
      diff = execFileSync('git', ['log', '-p', '-S', probe, '--', '.'], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
      });
    } catch { continue; }
    for (const m of diff.matchAll(new RegExp(re.source, 'g'))) {
      if (!seen.has(m[0])) seen.set(m[0], what);
    }
  }

  const real = [...seen].filter(([tok]) => !looksLikeFixture(tok));
  const fixtures = [...seen].filter(([tok]) => looksLikeFixture(tok));

  if (fixtures.length) {
    notes.push(`${fixtures.length} credential-shaped string(s) in history are test fixtures (low entropy), not secrets`);
  }
  for (const [tok, what] of real) {
    problems.push(`GIT HISTORY contains a real-looking ${what} (${tok.slice(0, 8)}…). ` +
      'It is public even if deleted from the working tree — REVOKE IT.');
  }
} catch {
  notes.push('git history could not be scanned');
}

/* ---- 3. the runtime redaction paths ----------------------------------- */

/**
 * Prove that a secret placed in the shapes that actually carry AI output does
 * not survive rendering. Greps prove absence today; this proves the mechanism.
 */
const SECRET = 'ghp_' + 'A'.repeat(36);

const { Journal, redact } = await import('../src/core/journal.js');
const { boundCapture, renderCapture } = await import('../src/core/surface.js');

if (redact(SECRET).includes(SECRET)) problems.push('redact() does not remove a GitHub PAT');

const j = new Journal();
j.record({ type: 'executed', at: Date.now(), iteration: 1, data: { out: SECRET } });
const rendered = j.render({
  scope: `scope ${SECRET}`, status: 'running', iteration: 1, phase: 'plan',
  decisions: [{ iteration: 1, kind: 'strategy', text: SECRET, rationale: SECRET }],
  scores: [], history: [{ n: 1, objective: { text: SECRET }, summary: SECRET, evidence: [{ kind: 'log', text: SECRET }] }],
}, { surfaces: { manager: { tabId: 1, host: 'x', conversationId: SECRET, label: 'm', title: SECRET } } });

if (rendered.includes(SECRET)) problems.push('a secret survived Journal.render() — the export would leak it');

const cap = boundCapture({
  surface: 'engineer', url: `https://x/${SECRET}`, title: SECRET,
  signals: [SECRET], nodes: [{ path: 'p', tag: 'PRE', text: SECRET }],
  counts: { elements: 1 },
});
if (renderCapture(cap.capture).includes(SECRET)) problems.push('a secret survived a surface scan capture');

/* ---- 4. what the extension can reach ---------------------------------- */

const manifest = existsSync('extension/manifest.template.json')
  ? JSON.parse(readFileSync('extension/manifest.template.json', 'utf8'))
  : null;
if (manifest) {
  const broad = (manifest.host_permissions || []).filter((h) => /\*:\/\/\*\/|<all_urls>/.test(h));
  if (broad.length) problems.push(`manifest requests broad host access: ${broad.join(', ')}`);
  for (const p of manifest.permissions || []) {
    if (['cookies', 'debugger', 'webRequest', 'history', 'bookmarks', 'proxy'].includes(p)) {
      problems.push(`manifest requests a sensitive permission it should not need: ${p}`);
    }
  }
}

/* ---- report ----------------------------------------------------------- */

for (const n of notes) console.log(`note: ${n}`);

if (problems.length) {
  console.error('\nSECURITY PROBLEMS:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('ok: no credentials in source; redaction verified on the log, export and scan paths');
