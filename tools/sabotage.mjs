#!/usr/bin/env node
/**
 * SABOTAGE VERIFICATION.
 *
 * A test that has never failed is a rumour. This harness breaks the code on
 * purpose, one edit at a time, and asserts that a NAMED test notices. If the
 * suite still passes, the test was decorative and gets rewritten.
 *
 * Across the previous project this exposed 16 worthless tests. It is not
 * optional here either.
 *
 * Usage: node tools/sabotage.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CASES = [
  {
    name: 'guard verifies only once, then trusts the environment',
    file: 'src/core/guard.js',
    from: '    if (halted) throw new EnvironmentError(halted);\n\n    const snap = await snapshot();',
    to: '    if (halted) throw new EnvironmentError(halted);\n    if (globalThis.__seen) return;\n    globalThis.__seen = true;\n    const snap = await snapshot();',
    expect: 'verifies before EVERY action',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'guard un-latches as soon as the tab looks fine again',
    file: 'src/core/guard.js',
    from: '    if (halted) throw new EnvironmentError(halted);',
    to: '    if (halted) { const s = await snapshot(); if (verify(binding, s, { surfaces: [surface] }).ok) halted = null; }\n    if (halted) throw new EnvironmentError(halted);',
    expect: 'LATCHES',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'a forbidden action is checked AFTER the transport is called',
    file: 'src/core/guard.js',
    from: "    assertAllowed(action); // throws ForbiddenActionError; default-deny\n    await ensure(surface);",
    to: '    await ensure(surface);',
    expect: 'WITHOUT touching the transport',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'action policy becomes default-ALLOW (only the blacklist is checked)',
    file: 'src/core/actions.js',
    from: "  throw new ForbiddenActionError(action, 'unknown action, and the policy is default-deny');",
    to: '  return action;',
    expect: 'DEFAULT-DENY',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'readiness is reported before a conversation switch',
    file: 'src/core/environment.js',
    from: '    if (s.conversationId !== b.conversationId) {',
    to: '    if (s.ready === false) {\n      problems.push(problem(key, b.label, \'not-ready\', \'the page is not currently interactive\'));\n      continue;\n    }\n    if (s.conversationId !== b.conversationId) {',
    expect: 'even while the page is still loading',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'binding accepts a tab with no conversation id (a fresh "new chat")',
    file: 'src/core/environment.js',
    from: '    if (!s.conversationId) {',
    to: '    if (false && !s.conversationId) {',
    expect: 'would CREATE a chat',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'two roles are allowed to share one tab',
    file: 'src/core/environment.js',
    from: '      problems.push(\n        problem(key, b.label, \'ambiguous\', `shares tab ${b.tabId} with "${byTab.get(b.tabId)}"`),\n      );',
    to: '      byTab.set(b.tabId, key);',
    expect: 'ambiguous, not clever',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'a missing REQUIRED tab is tolerated',
    file: 'src/core/environment.js',
    from: "        problems.push(problem(spec.key, spec.label, 'tab-missing', 'no pre-opened tab was reported'));",
    to: '        void 0;',
    expect: 'refuses to bind',
    test: 'test/environment.test.mjs',
  },
  {
    name: 'environment drift is recorded as a terminal failure',
    file: 'src/core/orchestrator.js',
    from: "    this.memory.status = 'blocked';\n    this.memory.phase = this.memory.phase || 'plan';",
    to: "    this.memory.status = 'failed';\n    this.memory.phase = this.memory.phase || 'plan';",
    expect: 'NOT a failure',
    test: 'test/blocking.test.mjs',
  },
  {
    name: 'the block reason lives in a variable instead of the store',
    file: 'src/core/orchestrator.js',
    from: '    this.memory.block = { at: Date.now(), where, problems, detail };\n    await this.save();',
    to: '    this._block = { at: Date.now(), where, problems, detail };\n    await this.save();',
    expect: 'PERSISTED',
    test: 'test/blocking.test.mjs',
  },
  {
    name: 'a blocked run silently re-probes and resumes itself',
    file: 'src/core/orchestrator.js',
    from: '    if (this.memory.block) {\n      const held = {',
    to: '    if (false && this.memory.block) {\n      const held = {',
    expect: 'refuses to restart until a human',
    test: 'test/blocking.test.mjs',
  },
  {
    name: 'the environment is checked once per run instead of per phase',
    file: 'src/core/orchestrator.js',
    from: '      await this.gate(\'execute\', record, () => this.phaseExecute(record));',
    to: '      await this.phaseExecute(record);',
    expect: 'halts at the next phase boundary',
    test: 'test/blocking.test.mjs',
  },
  {
    name: 'a throwing environment probe counts as a pass',
    file: 'src/core/orchestrator.js',
    from: '    } catch (err) {\n      /*\n       * A CHECK THAT THROWS IS A FAILED CHECK, NOT A PASSED ONE.',
    to: '    } catch (err) {\n      return true;\n      /*\n       * A CHECK THAT THROWS IS A FAILED CHECK, NOT A PASSED ONE.',
    expect: 'THROWS is a failed check',
    test: 'test/blocking.test.mjs',
  },
  {
    name: 'the journal keeps the newest events and drops the start of the run',
    file: 'src/core/journal.js',
    from: '      const keepHead = Math.floor(this.limit * 0.25);',
    to: '      const keepHead = 0;',
    expect: 'drops the MIDDLE',
    test: 'test/journal.test.mjs',
  },
  {
    name: 'the journal renders scraped text without redacting it',
    file: 'src/core/journal.js',
    from: '  for (const [re, with_] of SECRETS) out = out.replace(re, with_);',
    to: '  /* redaction removed */',
    expect: 'RENDERED log',
    test: 'test/journal.test.mjs',
  },
];

let caught = 0;
const missed = [];

for (const [i, c] of CASES.entries()) {
  const original = readFileSync(c.file, 'utf8');
  if (!original.includes(c.from)) {
    missed.push(`${c.name} — PATCH DID NOT APPLY (the anchor text moved)`);
    console.log(`${i + 1}/${CASES.length}  SKIP  ${c.name}`);
    continue;
  }
  writeFileSync(c.file, original.replace(c.from, c.to));

  let output = '';
  try {
    output = execFileSync('node', ['--test', c.test], { encoding: 'utf8', timeout: 60000 });
  } catch (err) {
    output = String(err.stdout || '') + String(err.stderr || '');
  } finally {
    writeFileSync(c.file, original);
  }

  const failures = output
    .split('\n')
    .filter((l) => l.startsWith('not ok '))
    .join('\n');

  const noticed = failures.includes(c.expect);
  if (noticed) {
    caught++;
    console.log(`${i + 1}/${CASES.length}  CAUGHT  ${c.name}`);
  } else {
    missed.push(`${c.name} — expected a failure mentioning "${c.expect}"; got:\n${failures || '(suite still green)'}`);
    console.log(`${i + 1}/${CASES.length}  MISSED  ${c.name}`);
  }
}

console.log(`\n${caught}/${CASES.length} sabotages caught`);
if (missed.length) {
  console.error('\nUNCAUGHT — these tests do not test what they claim:\n' + missed.map((m) => `  - ${m}`).join('\n'));
  process.exit(1);
}
