/**
 * First-run workflow: modes, the injected protocol, the report parser, and
 * preflight validation.
 *
 * The parser tests carry most of the weight. It is the point where a model's
 * prose becomes typed evidence, and everything downstream trusts it — a
 * forgiving parser turns optimism into a `measured` score.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODES, MODE_KEYS, getMode, validateSetup, initialScope } from '../src/core/modes.js';
import {
  protocolBlock, metadataBlock, composeFirstPrompt, composeIterationPrompt,
  explorationBrief, REPORT_FENCE, PROTOCOL_VERSION,
} from '../src/core/protocol.js';
import { parseReport, extractBlock, reportToEvidence, crossCheck } from '../src/core/report.js';
import { preflight } from '../src/core/preflight.js';
import { scoreTesting } from '../src/core/scoring.js';
import { Logger } from '../src/core/logger.js';
import { MemoryLogSink } from '../src/core/logsink.js';
import { MemoryStore } from '../src/core/store.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { emptyMemory } from '../src/core/types.js';
import { fakeManager, fakeEngineer, fakeReviewer, flatScores, passing } from './helpers/fakes.mjs';

/* ========================================================================== *
 * MODES
 * ========================================================================== */

test('there are exactly three modes and only "new" requires a prompt', () => {
  assert.deepEqual(MODE_KEYS, ['new', 'existing', 'explore']);
  assert.equal(getMode('new').needsPrompt, true);
  assert.equal(getMode('existing').needsPrompt, false);
  assert.equal(getMode('explore').needsPrompt, false);
});

test('Self Exploration accepts an empty prompt — that is its entire premise', () => {
  assert.equal(validateSetup({ mode: 'explore', prompt: '' }).ok, true);
  assert.equal(validateSetup({ mode: 'existing', prompt: '' }).ok, true);
});

test('New Project refuses an empty or throwaway description', () => {
  /*
   * "make an app" is a scope the orchestrator will chase for fifty iterations
   * in whatever direction the manager invents, and the user will conclude the
   * tool is broken rather than that the input was empty.
   */
  const empty = validateSetup({ mode: 'new', prompt: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.problems[0].field, 'prompt');

  const tiny = validateSetup({ mode: 'new', prompt: 'make an app' });
  assert.equal(tiny.ok, false);
  assert.match(tiny.problems[0].message, /very short/);

  assert.equal(validateSetup({ mode: 'new', prompt: 'A CSV export feature for the reporting dashboard' }).ok, true);
});

test('an unknown mode is rejected before anything else is validated', () => {
  const r = validateSetup({ mode: 'freestyle', prompt: '' });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].field, 'mode');
});

test('explore mode records a scope that admits it is a placeholder', () => {
  /*
   * There is no user description by definition. Inventing a confident summary
   * would put a fabricated scope in the log and in every subsequent prompt.
   */
  const s = initialScope({ mode: 'explore', projectName: 'Reporting' });
  assert.match(s, /pending exploration/);
});

/* ========================================================================== *
 * THE INJECTED PROTOCOL
 * ========================================================================== */

test('the protocol names every required field and the fence', () => {
  const p = protocolBlock();
  for (const f of ['taskStatus', 'summary', 'filesModified', 'build', 'tests', 'commit', 'knownIssues', 'risks', 'engineeringReport']) {
    assert.ok(p.includes(f), `the protocol must document ${f}`);
  }
  assert.ok(p.includes(REPORT_FENCE));
  assert.match(p, new RegExp(`v${PROTOCOL_VERSION}`));
});

test('the protocol tells the engineer that direction is not its decision', () => {
  const p = protocolBlock();
  assert.match(p, /suggestedNextTask/);
  assert.match(p, /advice only/i);
  assert.match(p, /orchestrator decides direction/i);
});

test('the protocol distinguishes "did not run" from "ran clean"', () => {
  /*
   * The most valuable sentence in the whole block. `{passed:0, failed:0}` for
   * a suite that never executed would otherwise read as a flawless run.
   */
  assert.match(protocolBlock(), /ran: false/);
  assert.match(protocolBlock(), /completely different facts/);
});

test('the user writes only a description — the extension assembles the rest', () => {
  const prompt = composeFirstPrompt({
    mode: 'new',
    projectName: 'Reporting',
    prompt: 'A CSV export feature for the reporting dashboard',
    memory: null,
  });
  assert.match(prompt, /ORCHESTRATION PROTOCOL/);
  assert.match(prompt, /ESTABLISH THE BASELINE/);
  assert.match(prompt, /A CSV export feature/);
  assert.match(prompt, /Reporting/);
});

test('explore mode injects the full brief and NO objective section', () => {
  const prompt = composeFirstPrompt({ mode: 'explore', memory: null });
  assert.match(prompt, /EXPLORATION ONLY/);
  assert.match(prompt, /DO NOT CHANGE ANY CODE/);
  assert.match(prompt, /prioritised improvement roadmap/i);
  /*
   * An empty "## OBJECTIVE" heading invites the model to fill the silence with
   * an objective the user never wrote — then pursue it autonomously.
   */
  assert.equal(/## OBJECTIVE/.test(prompt), false, 'no objective section may appear in explore mode');
});

test('the exploration brief covers every item the specification lists', () => {
  const b = explorationBrief().toLowerCase();
  for (const topic of ['purpose', 'repository structure', 'documentation', 'technolog', 'dependenc',
    'architecture', 'implementation state', 'completed features', 'missing', 'technical debt',
    'bugs', 'testing', 'ui/ux', 'performance', 'security', 'roadmap']) {
    assert.ok(b.includes(topic), `exploration must cover "${topic}"`);
  }
});

test('the exploration brief teaches the confidence model rather than assuming it', () => {
  const b = explorationBrief();
  assert.match(b, /measured/);
  assert.match(b, /inferred/);
  assert.match(b, /asserted/);
  assert.match(b, /worse than not scoring it at all/);
});

test('existing mode continues rather than re-scaffolding, even with no new objective', () => {
  const prompt = composeFirstPrompt({ mode: 'existing', prompt: '', memory: null });
  assert.match(prompt, /SYNCHRONISE/);
  assert.match(prompt, /Do not start over/i);
  assert.match(prompt, /No new objective was given/);
});

test('metadata carries scores WITH their confidence, never bare numbers', () => {
  /*
   * "testing: 90" alone invites the model to reason from it as established
   * fact. "(asserted)" tells it which numbers are actually up for grabs.
   */
  const memory = {
    ...emptyMemory('a project', 'existing'),
    iteration: 4,
    history: [{ n: 4, objective: { text: 'prev' }, summary: 'did a thing', overall: 61, filesChanged: ['a.js'] }],
    scores: [{ scores: [
      { dimension: 'testing', score: 90, confidence: 'measured' },
      { dimension: 'uiux', score: 55, confidence: 'asserted' },
    ] }],
    openIssues: ['flaky login test'],
  };
  const meta = metadataBlock(memory);
  assert.match(meta, /testing: 90% \(measured\)/);
  assert.match(meta, /uiux: 55% \(asserted\)/);
  assert.match(meta, /1\/2 measured/);
  assert.match(meta, /flaky login test/);
  assert.match(meta, /Iteration: 5/);
  assert.match(meta, /Workflow mode: existing/);
});

test('metadata warns the engineer when the orchestrator has detected a loop', () => {
  const memory = { ...emptyMemory('p'), flags: { stagnation: true, signals: [{ kind: 'file-churn' }] } };
  assert.match(metadataBlock(memory), /detected a loop/);
  assert.match(metadataBlock(memory), /file-churn/);
});

test('metadata is bounded so it cannot push the protocol out of the window', () => {
  /*
   * The failure mode of unbounded context is not an error — it is the model
   * silently losing the earliest part of the message, which is the protocol.
   */
  const memory = {
    ...emptyMemory('p'),
    openIssues: Array.from({ length: 60 }, (_, i) => `issue number ${i} with a fairly long description attached`),
  };
  const meta = metadataBlock(memory);
  assert.match(meta, /and 52 more/);
  assert.ok(meta.length < 3000, `metadata grew to ${meta.length} characters`);
});

test('iteration prompts re-send the protocol every time', () => {
  /*
   * A contract stated once is outside the context window by iteration forty,
   * and the observed decay is gradual: the model keeps the shape for a while,
   * then starts dropping fields it judges uninteresting.
   */
  const p = composeIterationPrompt({
    memory: emptyMemory('p'),
    objective: { text: 'do the thing', constraints: ['no new deps'], acceptance: ['tests pass'] },
  });
  assert.match(p, /ORCHESTRATION PROTOCOL/);
  assert.match(p, /do the thing/);
  assert.match(p, /no new deps/);
  assert.match(p, /tests pass/);
});

/* ========================================================================== *
 * THE PARSER
 * ========================================================================== */

const goodReport = (over = {}) => JSON.stringify({
  taskStatus: 'complete',
  summary: 'Added the CSV exporter',
  filesModified: ['src/export/csv.js', 'test/csv.test.mjs'],
  build: { ran: true, ok: true, command: 'npm run build', output: '' },
  tests: { ran: true, passed: 41, failed: 0, skipped: 2, command: 'npm test' },
  commit: { made: true, sha: 'a1b2c3d', message: 'feat: csv export' },
  knownIssues: [],
  risks: ['quoting of embedded newlines is untested'],
  engineeringReport: 'Implemented a streaming CSV writer…',
  ...over,
});

const wrap = (json) => `Sure! Here is what I did.\n\n\`\`\`${REPORT_FENCE}\n${json}\n\`\`\`\n\nLet me know if you want changes.`;

test('the parser finds the block inside conversational padding', () => {
  const r = parseReport(wrap(goodReport()));
  assert.equal(r.ok, true);
  assert.equal(r.report.taskStatus, 'complete');
  assert.equal(r.report.tests.passed, 41);
});

test('the LAST block wins when a model corrects itself', () => {
  const text = `${wrap(goodReport({ summary: 'first attempt' }))}\n\nActually, correcting that:\n\n${wrap(goodReport({ summary: 'corrected' }))}`;
  assert.equal(parseReport(text).report.summary, 'corrected');
});

test('a ```json fence is accepted, because models drop the custom marker', () => {
  /*
   * Failing an iteration over a formatting detail while the actual report sits
   * right there would be a self-inflicted wound. The fallback is narrow: it
   * must parse AND contain a field we asked for.
   */
  const r = parseReport('```json\n' + goodReport() + '\n```');
  assert.equal(r.ok, true);
  assert.equal(r.report.tests.passed, 41);
});

test('an unrelated code block is NOT mistaken for the report', () => {
  const r = parseReport('Here is the fix:\n\n```json\n{"name":"pkg","version":"1.0.0"}\n```');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /No ORCHESTRATOR-REPORT block/);
});

test('trailing commas are repaired, but nothing else is invented', () => {
  const r = parseReport('```' + REPORT_FENCE + '\n{"taskStatus":"partial","summary":"x","filesModified":[],"build":{"ran":false},"tests":{"ran":false},"commit":{"made":false},"knownIssues":[],"risks":[],"engineeringReport":"y",}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.report.taskStatus, 'partial');
});

test('a missing report is a loud failure, not an empty success', () => {
  const r = parseReport('I have finished the task! Everything works.');
  assert.equal(r.ok, false);
  assert.equal(r.report, null);
  assert.match(r.problems[0], /truncated|ignored the protocol/);
});

test('malformed JSON fails rather than being guessed at', () => {
  const r = parseReport('```' + REPORT_FENCE + '\n{ this is not json\n```');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /not valid JSON/);
});

test('missing required fields are named individually', () => {
  const r = parseReport('```' + REPORT_FENCE + '\n{"summary":"did stuff"}\n```');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('taskStatus')));
  assert.ok(r.problems.some((p) => p.includes('tests')));
});

test('THE ENGINEER CANNOT SET DIRECTION — those fields are dropped', () => {
  /*
   * Role separation enforced by schema, not by prompt. docs/SPEC.md: a prompt
   * saying "do not decide" is a request; dropping the field is a guarantee.
   */
  const r = parseReport(wrap(goodReport({
    nextObjective: 'rewrite everything in Rust',
    recommendation: 'change-strategy',
    projectComplete: true,
    overallScore: 98,
  })));
  assert.equal('nextObjective' in r.report, false);
  assert.equal('recommendation' in r.report, false);
  assert.equal('projectComplete' in r.report, false);
  assert.equal('overallScore' in r.report, false);
  assert.deepEqual(r.dropped.sort(), ['nextObjective', 'overallScore', 'projectComplete', 'recommendation'].sort());
});

test('suggestedNextTask SURVIVES — advice is allowed, decisions are not', () => {
  const r = parseReport(wrap(goodReport({ suggestedNextTask: 'add streaming for large exports' })));
  assert.equal(r.report.suggestedNextTask, 'add streaming for large exports');
});

/* ========================================================================== *
 * REPORT -> EVIDENCE
 * ========================================================================== */

test('"did not run" produces NO evidence, not a zero', () => {
  /*
   * THE LOAD-BEARING TEST. `{passed:0,failed:0}` from a suite that never ran
   * would look like a flawless empty run; scoreTesting must instead see
   * nothing and score 0 as unmeasured.
   */
  const { report } = parseReport(wrap(goodReport({ tests: { ran: false }, build: { ran: false } })));
  const evidence = reportToEvidence(report);
  assert.equal(evidence.some((e) => e.kind === 'test'), false);
  assert.equal(evidence.some((e) => e.kind === 'build'), false);
  assert.equal(scoreTesting(evidence), null, 'no test evidence means testing is not scored at all');
});

test('a real run becomes typed evidence the scorer can use', () => {
  const { report } = parseReport(wrap(goodReport()));
  const evidence = reportToEvidence(report);
  const t = evidence.find((e) => e.kind === 'test');
  assert.deepEqual([t.passed, t.failed, t.skipped], [41, 0, 2]);
  assert.equal(evidence.find((e) => e.kind === 'build').ok, true);
  const score = scoreTesting(evidence);
  assert.equal(score.confidence, 'measured');
  assert.ok(score.score > 0 && score.score < 100, 'skipped tests keep it off a perfect score');
});

test('a diff record is derived from the file list when counts are omitted', () => {
  /*
   * `file-churn` needs filesChanged. Losing it because a field was optional
   * would silently disable a third of stagnation detection.
   */
  const { report } = parseReport(wrap(goodReport()));
  const diff = reportToEvidence(report).find((e) => e.kind === 'diff');
  assert.equal(diff.filesChanged, 2);
});

/* ========================================================================== *
 * CROSS-CHECKING
 * ========================================================================== */

test('"complete" with failing tests is contradicted by its own numbers', () => {
  /*
   * Both fields come from the same model in the same message. The prose is
   * generated to satisfy the request; the numbers are copied from a terminal.
   * When they disagree, the numbers are right.
   */
  const { report } = parseReport(wrap(goodReport({ tests: { ran: true, passed: 38, failed: 3, skipped: 0 } })));
  const findings = crossCheck(report);
  const err = findings.find((f) => f.severity === 'error');
  assert.ok(err, 'a contradiction must be an error, not a note');
  assert.match(err.message, /3 failing test/);
});

test('"complete" with a failing build is caught', () => {
  const { report } = parseReport(wrap(goodReport({ build: { ran: true, ok: false } })));
  assert.ok(crossCheck(report).some((f) => /failing build/.test(f.message)));
});

test('changed files with no commit is flagged — the work is not durable', () => {
  const { report } = parseReport(wrap(goodReport({ commit: { made: false } })));
  assert.ok(crossCheck(report).some((f) => /not durable/.test(f.message)));
});

test('an honest partial report produces no errors', () => {
  const { report } = parseReport(wrap(goodReport({
    taskStatus: 'partial',
    tests: { ran: true, passed: 38, failed: 3, skipped: 0 },
    knownIssues: ['3 tests still failing on comma quoting'],
  })));
  assert.equal(crossCheck(report).filter((f) => f.severity === 'error').length, 0);
});

/* ========================================================================== *
 * PREFLIGHT
 * ========================================================================== */

const healthySnapshot = (over = {}) => ({
  surfaces: {
    manager: { tabId: 11, url: 'https://chatgpt.com/c/conv-a', conversationId: 'conv-a', ready: true, signedIn: true, ...over.manager },
    engineer: { tabId: 22, url: 'https://arena.ai/w/ws-7', conversationId: 'ws-7', ready: true, signedIn: true, ...over.engineer },
    ...(over.reviewer === null ? {} : { reviewer: { tabId: 33, url: 'https://chat.deepseek.com/a/chat/s/c9', conversationId: 'c9', ready: true, signedIn: true, ...over.reviewer } }),
  },
});

const HOSTS = {
  manager: ['chatgpt.com'],
  engineer: ['arena.ai'],
  reviewer: ['chat.deepseek.com'],
};

function fresh() {
  return {
    setup: { mode: 'new', prompt: 'A CSV export feature for the reporting dashboard' },
    snapshot: healthySnapshot(),
    hosts: HOSTS,
    logger: new Logger({ sink: new MemoryLogSink() }),
    store: new MemoryStore(),
  };
}

test('preflight passes on a fully prepared environment', async () => {
  const r = await preflight(fresh());
  assert.equal(r.ok, true, r.summary);
  assert.ok(r.binding.surfaces.engineer.tabId === 22);
  assert.match(r.summary, /all \d+ checks passed/);
});

test('preflight covers every item the specification lists', async () => {
  const r = await preflight(fresh());
  const keys = r.checks.map((c) => c.key);
  for (const k of ['tab-manager', 'tab-engineer', 'workspace', 'logger', 'storage']) {
    assert.ok(keys.includes(k), `missing check: ${k}`);
  }
});

test('a missing Arena tab fails preflight and NOTHING is created', async () => {
  const args = fresh();
  delete args.snapshot.surfaces.engineer;
  const r = await preflight(args);
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.key === 'tab-engineer');
  assert.equal(c.ok, false);
  assert.ok(c.remedy.length > 0, 'the user is told what to do');
});

test('DeepSeek is required only when the reviewer is enabled', async () => {
  const withoutDeepseek = { ...fresh(), snapshot: healthySnapshot({ reviewer: null }) };
  assert.equal((await preflight(withoutDeepseek)).ok, true, 'optional by default');

  const enabled = { ...fresh(), snapshot: healthySnapshot({ reviewer: null }), reviewerEnabled: true };
  const r = await preflight(enabled);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.key === 'tab-reviewer').ok, false);
});

test('an Arena tab outside a workspace fails the workspace check specifically', async () => {
  /*
   * "Arena tab exists" and "Arena workspace is open" are different facts: a
   * tab on the account dashboard has the right host and no workspace.
   */
  const args = fresh();
  args.snapshot.surfaces.engineer = { tabId: 22, url: 'https://arena.ai/', conversationId: null, ready: true, signedIn: true };
  const r = await preflight(args);
  assert.equal(r.ok, false);
  const ws = r.checks.find((c) => c.key === 'workspace');
  assert.equal(ws.ok, false);
  /*
   * The verdict is not the point -- bind() would fail this anyway. The point
   * is that the user is told WHICH problem they have: a tab on the dashboard
   * needs a different action from a missing tab, and bind() calls the former
   * "conversation-changed", which is accurate for ChatGPT and confusing here.
   */
  assert.match(ws.detail, /open but not inside a project workspace/);

  const noTab = fresh();
  delete noTab.snapshot.surfaces.engineer;
  const r2 = await preflight(noTab);
  assert.match(r2.checks.find((c) => c.key === 'workspace').detail, /no Arena tab was reported/);
});

test('preflight verifies storage by reading back what it wrote', async () => {
  /*
   * A store that accepts writes and returns nothing presents as a run that
   * resets to iteration 1 after every eviction — which reads as an
   * orchestrator bug rather than a storage one.
   */
  const args = fresh();
  args.store = { async load() { return null; }, async save() { /* silently drops */ } };
  const r = await preflight(args);
  assert.equal(r.ok, false);
  assert.match(r.checks.find((c) => c.key === 'storage').detail, /did not return it/);
});

test('preflight leaves an existing stored project intact', async () => {
  const store = new MemoryStore();
  await store.save({ ...emptyMemory('previous project'), iteration: 7 });
  const r = await preflight({ ...fresh(), store });
  assert.equal(r.ok, true);
  const after = await store.load();
  assert.equal(after.iteration, 7, 'the probe must not damage a stored run');
  assert.equal('__preflight' in after, false, 'and must not leave its probe behind');
  assert.equal(after.scope, 'previous project', 'the whole record is restored, not just the counter');
  assert.match(r.checks.find((c) => c.key === 'storage').detail, /iteration 7/);
});

test('a warning does not block the run, but a real failure does', async () => {
  /*
   * The checklist used to say "the run can proceed" in the remedy and then
   * return ok:false, which stopped it. A checklist that contradicts its own
   * advice trains people to ignore it, and the user's exported log showed
   * exactly that outcome: preflight ran, reported a storage warning, and the
   * Start button stayed disabled with no explanation of the discrepancy.
   */
  const args = fresh();
  args.logger = new Logger({ sink: { async append() { throw new Error('quota exceeded'); }, async all() { return []; } }, flushEvery: 1 });
  const warned = await preflight(args);
  assert.equal(warned.ok, true, 'degraded is not broken — the run may start');
  assert.equal(warned.warnings.length, 1);
  assert.equal(warned.problems.length, 0);
  assert.match(warned.summary, /with 1 warning/);

  const broken = fresh();
  delete broken.snapshot.surfaces.engineer;
  const stopped = await preflight(broken);
  assert.equal(stopped.ok, false, 'a missing Arena tab genuinely blocks');
  assert.ok(stopped.problems.length > 0);
});

test('checks are blocking by default, so a new one cannot be waved through', async () => {
  const r = await preflight(fresh());
  const nonBlocking = r.checks.filter((c) => c.blocking === false).map((c) => c.key);
  assert.deepEqual(nonBlocking, [], 'only log-durable may be non-blocking, and only when it fails');
  for (const c of r.checks) assert.equal(c.blocking, true);
});

test('a broken durable log is a WARNING, not a refusal to start', async () => {
  /*
   * The in-memory log still works, so the user can watch the run — they just
   * lose it on eviction. Refusing to start turns a degraded session into no
   * session.
   */
  const args = fresh();
  args.logger = new Logger({ sink: { async append() { throw new Error('quota exceeded'); }, async all() { return []; } }, flushEvery: 1 });
  const r = await preflight(args);
  assert.equal(r.checks.find((c) => c.key === 'logger').ok, true, 'the logger itself is fine');
  assert.equal(r.checks.find((c) => c.key === 'log-durable').ok, false);
  assert.match(r.checks.find((c) => c.key === 'log-durable').remedy, /can proceed/);
});

test('an incomplete landing form fails preflight before any tab is touched', async () => {
  const r = await preflight({ ...fresh(), setup: { mode: 'new', prompt: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.key === 'setup').ok, false);
});

/* ========================================================================== *
 * THE BASELINE ITERATION
 * ========================================================================== */

function baselineRun(mode, { results, evaluations } = {}) {
  const manager = fakeManager({
    objectives: [{ text: 'a planned objective' }],
    evaluations: evaluations || [{ scores: flatScores(40) }],
  });
  const engineer = fakeEngineer({
    results: results || [{ evidence: [passing(10)], filesChanged: ['a.js'], summary: 'explored the project' }],
  });
  const o = new Orchestrator({
    manager, engineer, reviewer: fakeReviewer(),
    store: new MemoryStore(),
    config: { maxIterations: 3 },
  });
  return { o, manager, engineer };
}

test('iteration 1 does NOT consult the manager — the baseline is fixed', async () => {
  /*
   * Asking ChatGPT to invent an objective for a step whose job is already
   * known wastes a round trip, and lets the manager decide to skip the
   * baseline entirely — which it would, whenever the conversation already
   * looked productive.
   */
  const { o, manager, engineer } = baselineRun('explore');
  await o.load('p', 'explore');
  await o.iterate();

  assert.equal(manager.planCalls(), 0, 'plan() must not be called for the baseline');
  assert.equal(engineer.calls(), 1);
  assert.match(o.memory.history[0].objective.text, /Explore and understand/);
  assert.equal(o.memory.history[0].baseline, true);
});

test('the exploration baseline forbids changing code', async () => {
  const { o } = baselineRun('explore');
  await o.load('p', 'explore');
  await o.iterate();
  assert.deepEqual(o.memory.history[0].objective.constraints, ['do not modify any code', 'do not commit']);
});

test('each mode gets its own baseline objective', async () => {
  for (const [mode, pattern] of [['new', /Initialise the project/], ['existing', /Synchronise/], ['explore', /Explore and understand/]]) {
    const { o } = baselineRun(mode);
    await o.load('p', mode);
    await o.iterate();
    assert.match(o.memory.history[0].objective.text, pattern, `${mode} baseline`);
  }
});

test('the manager takes over from iteration 2', async () => {
  const { o, manager } = baselineRun('new');
  await o.load('p', 'new');
  await o.iterate();
  await o.iterate();
  assert.equal(manager.planCalls(), 1, 'planned exactly the second iteration');
  assert.equal(o.memory.history[1].objective.text, 'a planned objective');
  assert.equal(o.memory.baselineDone, true);
});

test('a baseline that produced nothing RUNS AGAIN — it is not marked done', async () => {
  /*
   * Otherwise the run proceeds to "normal improvement" on top of an
   * understanding it never acquired, which is exactly what explore mode
   * exists to prevent.
   */
  const { o, manager } = baselineRun('explore', {
    results: [{ evidence: [], filesChanged: [], summary: '' }], // no summary => nothing produced
  });
  await o.load('p', 'explore');
  await o.iterate();
  assert.equal(o.memory.baselineDone, false);

  await o.iterate();
  assert.equal(manager.planCalls(), 0, 'still baselining, so the manager is still not consulted');
  assert.match(o.memory.history[1].objective.text, /Explore and understand/);
});

test('exploration replaces the placeholder scope, keeping the original', async () => {
  const { o } = baselineRun('explore', {
    results: [{ evidence: [passing(3)], filesChanged: [], summary: 'A Django reporting service with a React dashboard. It has 41 tests.' }],
  });
  await o.load(initialScope({ mode: 'explore', projectName: 'Reporting' }), 'explore');
  assert.match(o.memory.scope, /pending exploration/);

  await o.iterate();
  assert.equal(o.memory.scope, 'A Django reporting service with a React dashboard.');
  assert.match(o.memory.scopePlaceholder, /pending exploration/, 'the placeholder is kept, not silently overwritten');
});

test('a NEW project keeps the user\'s scope exactly as written', async () => {
  const { o } = baselineRun('new');
  await o.load('A CSV export feature', 'new');
  await o.iterate();
  assert.equal(o.memory.scope, 'A CSV export feature', 'scope is never edited outside explore mode');
});

test('the mode survives a reload, and an old memory is not mistaken for new', async () => {
  /*
   * MV3 evicts the worker constantly. A memory with history that defaulted to
   * mode "new" would start re-scaffolding an existing project.
   */
  const store = new MemoryStore();
  await store.save({ ...emptyMemory('p'), mode: undefined, baselineDone: undefined, history: [{ n: 1 }], iteration: 1 });
  const o = new Orchestrator({ manager: fakeManager(), engineer: fakeEngineer(), reviewer: fakeReviewer(), store });
  await o.load('p', 'new');
  assert.equal(o.memory.mode, 'existing', 'a memory with history is an existing project');
  assert.equal(o.memory.baselineDone, true, 'and its baseline has clearly already happened');
});
