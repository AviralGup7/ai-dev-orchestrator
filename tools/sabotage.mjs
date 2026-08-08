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
  /* ---- logging & observability (session 3) ------------------------- */
  {
    name: 'the durable sink quietly writes only part of each batch',
    file: 'src/core/logger.js',
    from: '      await this.sink.append(batch);',
    to: '      await this.sink.append(batch.slice(0, 1));',
    expect: 'durable sink receives every event',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'a failed sink write drops the batch instead of retrying',
    file: 'src/core/logger.js',
    from: '      this.pending = [...batch, ...this.pending];',
    to: '      /* dropped */',
    expect: 'retains events for retry',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'the live view drops events without counting them',
    file: 'src/core/logger.js',
    from: '      this.notShown += removed;',
    to: '      /* silently */',
    expect: 'reports what it is not showing',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'a throwing UI subscriber kills the log entry',
    file: 'src/core/logger.js',
    from: '    try {\n      this.onEvent(event);\n    } catch (err) {',
    to: '    if (true) {\n      this.onEvent(event);\n    } else if (false) { const err = null;',
    expect: 'throwing UI subscriber cannot lose an event',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'begin() logs only on completion, so waits are invisible',
    file: 'src/core/logger.js',
    from: "    const open = this.log(type, { ...fields, status: 'pending', at: startedAt });",
    to: "    const open = makeEvent(type, { ...fields, status: 'pending', at: startedAt });\n    open.id = this.nextId();",
    expect: 'logs the wait immediately',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'event ids become timestamps, losing the total order',
    file: 'src/core/events.js',
    from: '  return () => `evt-${sessionId}-${String(++seq).padStart(6, \'0\')}`;',
    to: '  return () => `evt-${sessionId}-${Date.now()}`;',
    expect: 'unique AND sortable',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'unknown event types are accepted silently',
    file: 'src/core/events.js',
    from: '  if (!spec) throw new TypeError(`unknown event type: ${type}`);',
    to: '  if (!spec) return { type, at: Date.now() };',
    expect: 'unknown event type is rejected',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'the summary counts prompts from a counter that can drift',
    file: 'src/core/logger.js',
    from: "    promptsSent: count('prompt-submitted'),",
    to: '    promptsSent: 0,',
    expect: 'DERIVED from events',
    test: 'test/logging.test.mjs',
  },
  {
    name: 'an unmapped engine event is silently dropped',
    file: 'src/core/bridge.js',
    from: "    if (type === undefined) {\n      logger.log('error', {",
    to: "    if (type === undefined) return;\n    if (false) {\n      logger.log('error', {",
    expect: 'logged as a gap, never dropped',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'a skipped evidence phase no longer blocks completion',
    file: 'src/core/controls.js',
    from: '  return !EVIDENCE_PHASES.some((p) => skipped.includes(p));',
    to: '  return true;',
    expect: 'may NOT skip your way to',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'skip is recorded but stop.js ignores it',
    file: 'src/core/stop.js',
    from: '      if (!iterationIsTrustworthy(deciding)) {',
    to: '      if (false && !iterationIsTrustworthy(deciding)) {',
    expect: 'may NOT skip your way to',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'an OLD skip poisons every later iteration',
    file: 'src/core/stop.js',
    from: '      const deciding = memory.history?.[memory.history.length - 1];',
    to: '      const deciding = memory.history?.find((r) => (r.skipped || []).length) || memory.history?.[memory.history.length - 1];',
    expect: 'does not block a later honest one',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'the panel reports a phase while an AI response is pending',
    file: 'src/core/status.js',
    from: "  if (lastEvent?.status === 'pending') {\n    return {\n      text: lastEvent.label,",
    to: "  if (false) {\n    return {\n      text: lastEvent.label,",
    expect: 'outranks the phase',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'error resolution goes back to comparing timestamps',
    file: 'src/core/status.js',
    from: '        (x) => x.id > e.id && x.status === ',
    to: '        (x) => x.at > e.at && x.status === ',
    expect: 'resolved by a later success',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'currentAI names ChatGPT during local loop detection',
    file: 'src/core/status.js',
    from: '  if (LOCAL_PHASES.has(memory?.phase)) return null;',
    to: '  /* removed */',
    expect: 'null when nobody has the floor',
    test: 'test/observability.test.mjs',
  },
  {
    name: 'unavailable controls are hidden instead of disabled',
    file: 'src/core/controls.js',
    from: '    out[c.key] = {\n      label: c.label,\n      enabled: ok,',
    to: '    if (!ok) continue;\n    out[c.key] = {\n      label: c.label,\n      enabled: ok,',
    expect: 'disabled rather than omitted',
    test: 'test/ui.test.mjs',
  },
  {
    name: 'log entries are rendered without escaping',
    file: 'extension/ui.js',
    from: "    .replace(/</g, '&lt;')",
    to: '    .replace(/\\u0000/g, \'\')',
    expect: 'every interpolated value is escaped',
    test: 'test/ui.test.mjs',
  },
  {
    name: 'the health percentage is shown without its evidence fraction',
    file: 'extension/ui.js',
    from: '       <span class="muted small">${s.measuredDimensions}/${s.totalDimensions} dimensions measured</span>',
    to: '       ',
    expect: 'without its evidence fraction',
    test: 'test/ui.test.mjs',
  },
  {
    name: 'the truncation banner is removed from the log view',
    file: 'extension/ui.js',
    from: '  const banner = notShown > 0',
    to: '  const banner = false',
    expect: 'how many events the view is not showing',
    test: 'test/ui.test.mjs',
  },
  /* ---- first-run workflow (session 4) ------------------------------ */
  {
    name: 'the parser honours a nextObjective from the engineer',
    file: 'src/core/report.js',
    from: '  for (const key of FORBIDDEN_FIELDS) {\n    if (key in obj) {',
    to: '  for (const key of []) {\n    if (key in obj) {',
    expect: 'CANNOT SET DIRECTION',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'a test suite that never ran counts as a clean run',
    file: 'src/core/report.js',
    from: "  if (t && t.ran !== false && (num(t.passed) + num(t.failed) + num(t.skipped)) > 0) {",
    to: '  if (t) {',
    expect: 'produces NO evidence, not a zero',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'a missing report block is treated as an empty success',
    file: 'src/core/report.js',
    from: "  if (!raw) {\n    return {\n      ok: false,",
    to: "  if (!raw) {\n    return {\n      ok: true,",
    expect: 'loud failure, not an empty success',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'any JSON code block is accepted as the report',
    file: 'src/core/report.js',
    from: '      if (required.some((k) => k in obj)) fb = body;',
    to: '      fb = body;',
    expect: 'NOT mistaken for the report',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: '"complete" with failing tests is no longer contradicted',
    file: 'src/core/report.js',
    from: "  if (report.taskStatus === 'complete' && t.ran !== false && num(t.failed) > 0) {",
    to: '  if (false) {',
    expect: 'contradicted by its own numbers',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'the file list no longer yields a diff record',
    file: 'src/core/report.js',
    from: "  } else if (Array.isArray(report.filesModified) && report.filesModified.length) {",
    to: '  } else if (false) {',
    expect: 'diff record is derived from the file list',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'explore mode gets an empty objective heading to fill in',
    file: 'src/core/protocol.js',
    from: "    parts.push(explorationBrief());",
    to: "    parts.push(explorationBrief());\n    parts.push('## OBJECTIVE\\n\\n');",
    expect: 'NO objective section',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'scores are sent to the engineer without their confidence',
    file: 'src/core/protocol.js',
    from: '      lines.push(`  - ${s.dimension}: ${s.score}% (${s.confidence})`);',
    to: '      lines.push(`  - ${s.dimension}: ${s.score}%`);',
    expect: 'WITH their confidence',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'the metadata block grows without bound',
    file: 'src/core/protocol.js',
    from: '    for (const i of memory.openIssues.slice(0, maxIssues)) lines.push(`  - ${truncate(i, 160)}`);',
    to: '    for (const i of memory.openIssues) lines.push(`  - ${i}`);',
    expect: 'bounded so it cannot push the protocol',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'the manager plans the baseline iteration after all',
    file: 'src/core/orchestrator.js',
    from: '    const objective = this.memory.baselineDone\n      ? await this.manager.plan({',
    to: '    const objective = true\n      ? await this.manager.plan({',
    expect: 'does NOT consult the manager',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'an empty baseline is marked done anyway',
    file: 'src/core/orchestrator.js',
    from: '    if (!this.memory.baselineDone && record.baseline && record.summary) {',
    to: '    if (!this.memory.baselineDone && record.baseline) {',
    expect: 'produced nothing RUNS AGAIN',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'a stored project with history defaults to mode "new"',
    file: 'src/core/orchestrator.js',
    from: "    if (!this.memory.mode) this.memory.mode = this.memory.history?.length ? 'existing' : mode;",
    to: '    if (!this.memory.mode) this.memory.mode = mode;',
    expect: 'not mistaken for new',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'New Project accepts a two-word description',
    file: 'src/core/modes.js',
    from: '    } else if (text.length < 20) {',
    to: '    } else if (false) {',
    expect: 'refuses an empty or throwaway description',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'preflight trusts a flush that returned no error',
    file: 'src/core/preflight.js',
    from: '      const failed = flushed?.error || logger.sinkFailures.length > failuresBefore;',
    to: '      const failed = Boolean(flushed?.error);',
    expect: 'broken durable log is a WARNING',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'preflight leaves its probe in the stored project',
    file: 'src/core/preflight.js',
    from: '      await store.save(existing || null);',
    to: '      /* probe left in place */',
    expect: 'leaves an existing stored project intact',
    test: 'test/firstrun.test.mjs',
  },
  {
    name: 'the workspace check cannot tell "no tab" from "wrong page"',
    file: 'src/core/preflight.js',
    from: "        : tabPresent\n          ? 'the Arena tab is open but not inside a project workspace'",
    to: "          : tabPresent\n          ? 'no Arena tab was reported, so no workspace could be checked'",
    expect: 'outside a workspace fails the workspace check',
    test: 'test/firstrun.test.mjs',
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
