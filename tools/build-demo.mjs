#!/usr/bin/env node
/**
 * Build a single self-contained HTML demo of the side panel.
 *
 * WHY THIS EXISTS
 * ---------------
 * The UI cannot be reviewed until it is loaded as an unpacked extension in
 * Chrome, against three logged-in AI tabs, driving a real project. That is a
 * long feedback loop for "is the Activity Log readable?".
 *
 * So: inline every module into one file, drive it with the FAKE adapters and a
 * simulated clock, and open it in a browser. The engine, the logger, the
 * status derivation and every rendering function are the REAL ones — the only
 * substitutions are the three AI adapters and a sped-up timeline. If the demo
 * had its own reimplementation of any of that, it would prove nothing.
 *
 * The workspace preview sandbox has no network, so everything is inlined
 * rather than imported. Deterministic and code-generated, as preferred.
 *
 * Writes demo.html.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Strip import/export syntax so modules can be concatenated in one scope. */
function inline(path) {
  return readFileSync(path, 'utf8')
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(const|function|class|let|async)/gm, '$1')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, 'const __default = ');
}

const MODULES = [
  'src/core/types.js',
  'src/core/events.js',
  'src/core/scoring.js',
  'src/core/detect.js',
  'src/core/controls.js',
  'src/core/modes.js',
  'src/core/protocol.js',
  'src/core/report.js',
  'src/core/stop.js',
  'src/core/store.js',
  'src/core/environment.js',
  'src/core/preflight.js',
  'src/core/logsink.js',
  'src/core/logger.js',
  'src/core/status.js',
  'src/core/bridge.js',
  'src/core/orchestrator.js',
  'extension/ui.js',
  'extension/panel.js',
];

const { CSS } = await import('../extension/styles.js');

const core = MODULES.map((m) => `\n/* ==== ${m} ==== */\n${inline(m)}`).join('\n');

/**
 * The demo script.
 *
 * The fakes deliberately produce an IMPERFECT run: a failing build, a plateau
 * that trips loop detection, a strategy change. A demo where everything
 * succeeds shows the parts of the UI that matter least — nobody needs help
 * reading a green log.
 */
const demo = `
const SCOPE = 'A CSV export feature for the reporting dashboard';

/*
 * THE DEMO GOES IN CIRCLES ON PURPOSE, IN THE MIDDLE.
 *
 * Iterations 3-5 chase the same exporter bug with near-identical objectives,
 * the same file, and evidence that does not move. That trips objective-repeat,
 * file-churn, score-plateau and evidence-stasis -- enough to cross the
 * threshold of 2 -- which pulls a DeepSeek review forward and produces a
 * strategy change.
 *
 * A demo where everything succeeds exercises the parts of the UI that matter
 * least. Nobody needs help reading a green log; the reason this panel exists
 * is the run that stalls.
 */
const OBJECTIVES = [
  'add a CSV export pipeline with tests',
  'wire up keyboard navigation in the sidebar',
  'fix quoting of embedded commas in the exporter',
  'fix embedded comma quoting in the CSV exporter',
  'fix the exporter quoting of embedded commas',
  'improve error handling for the sync module',
];

const RUNS = [
  { passed: 38, failed: 6, skipped: 0, build: true,  files: ['src/export/csv.js', 'test/csv.test.mjs'] },
  { passed: 44, failed: 2, skipped: 2, build: false, files: ['src/ui/sidebar.js'] },
  { passed: 45, failed: 1, skipped: 2, build: true,  files: ['src/export/csv.js'] },
  { passed: 45, failed: 1, skipped: 2, build: true,  files: ['src/export/csv.js'] },
  { passed: 45, failed: 1, skipped: 2, build: true,  files: ['src/export/csv.js'] },
  { passed: 58, failed: 0, skipped: 0, build: true,  files: ['src/sync/index.js'] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sink = new MemoryLogSink();
const logger = new Logger({ sink, liveLimit: 400 });
const store = new MemoryStore();
let startedAt = null;

/** Logs the browser-automation steps an adapter would perform. */
async function drive(source, label, ms, iteration) {
  logger.log('tab-focused', { source: 'extension', description: 'Switched to the ' + label + ' tab (already open)', iteration });
  logger.log('prompt-copied', { source: 'extension', description: 'Copied the composed prompt', iteration });
  logger.log('prompt-pasted', { source: 'extension', description: 'Pasted into the composer', iteration });
  logger.log('prompt-submitted', { source: 'extension', description: 'Submitted the prompt', iteration });
  const done = logger.begin('awaiting-response', { source, description: 'Waiting for ' + label + ' to finish', iteration });
  await sleep(ms);
  return (chars) => done('response-received', { source, description: 'Response received (' + chars + ' characters)', data: { length: chars }, iteration });
}

const manager = {
  async plan(ctx) {
    const n = ctx.iteration;
    const close = await drive('chatgpt', 'ChatGPT', 900, n);
    close(1400);
    /* Iteration 1 is the fixed baseline, so the manager is first asked at 2. */
    const text = OBJECTIVES[Math.min(n - 2, OBJECTIVES.length - 1)] || OBJECTIVES[0];
    logger.log('planning-complete', { source: 'chatgpt', description: 'Objective: ' + text, iteration: n });
    return { text, constraints: ['do not change the public API'] };
  },
  async evaluate(ctx) {
    const n = ctx.evidenceIteration;
    const close = await drive('chatgpt', 'ChatGPT', 1100, n);
    close(2100);
    const t = ctx.evidence.find((e) => e.kind === 'test');
    const b = ctx.evidence.find((e) => e.kind === 'build');
    // Flat through the stalled middle, so score-plateau fires too.
    const curve = [55, 45, 62, 62, 62, 74];
    const base = b && !b.ok ? 40 : curve[Math.min(n - 1, curve.length - 1)];
    return {
      scores: [
        { dimension: 'completion', score: base, confidence: 'inferred', basis: [{ kind: 'diff' }] },
        { dimension: 'quality', score: base - 5, confidence: 'inferred', basis: [{ kind: 'lint' }] },
        { dimension: 'testing', score: 90, confidence: 'measured', basis: [{ kind: 'test' }] },
        { dimension: 'architecture', score: 70, confidence: 'asserted', basis: [] },
        { dimension: 'uiux', score: 55, confidence: 'asserted', basis: [] },
        { dimension: 'performance', score: 65, confidence: 'asserted', basis: [] },
        { dimension: 'security', score: 60, confidence: 'asserted', basis: [] },
        { dimension: 'documentation', score: 50, confidence: 'asserted', basis: [] },
        { dimension: 'accessibility', score: 35, confidence: 'asserted', basis: [] },
      ],
      openIssues: t && t.failed ? [t.failed + ' failing tests in the exporter'] : [],
    };
  },
};

const engineer = {
  async execute(ctx) {
    const n = (store.data && store.data.iteration || 0) + 1;
    const r = RUNS[Math.min(n - 1, RUNS.length - 1)];
    const close = await drive('arena', 'Arena', 1600, n);
    close(3200);

    logger.log('git-commit-detected', { source: 'arena', description: 'Commit a1b2c3d — ' + ctx.objective.text, iteration: n });
    if (!r.build) {
      logger.log('build-failed', { source: 'arena', status: 'error', phase: 'execute', iteration: n,
        description: 'Build failed: tsc exited with code 2', data: { stderr: "src/ui/sidebar.js(41,7): error TS2304: Cannot find name 'focusRing'." } });
    }
    logger.log('evidence-collected', { source: 'extension', iteration: n,
      description: r.passed + ' passed, ' + r.failed + ' failed, ' + r.skipped + ' skipped; build ' + (r.build ? 'ok' : 'FAILED') });

    return {
      summary: 'Changed ' + r.files.length + ' file(s) for: ' + ctx.objective.text,
      filesChanged: r.files,
      evidence: [
        { kind: 'test', passed: r.passed, failed: r.failed, skipped: r.skipped, at: Date.now() },
        { kind: 'build', ok: r.build, durationMs: 4100, at: Date.now() },
        { kind: 'diff', filesChanged: r.files.length, insertions: 90 + n * 10, deletions: 12, at: Date.now() },
      ],
    };
  },
};

const reviewer = {
  async review(ctx) {
    const n = (store.data && store.data.iteration || 0) + 1;
    const close = await drive('deepseek', 'DeepSeek', 1300, n);
    close(1800);
    const looping = (ctx.signals || []).length >= 2;
    return looping
      ? { recommendation: 'change-strategy', newDirection: 'Stop iterating on the exporter; the failing area is the sync module.', rationale: 'Three iterations touched the same files with no score movement.' }
      : { recommendation: 'continue', rationale: 'Testing is measured and rising.' };
  },
};

/* The evaluate() context needs the iteration number for logging; the engine
   does not pass it, so it is threaded through the objective. Demo-only glue. */
const _eval = manager.evaluate.bind(manager);
manager.evaluate = (ctx) => _eval({ ...ctx, evidenceIteration: (store.data && store.data.iteration || 0) + 1 });

const orch = new Orchestrator({
  manager, engineer, reviewer, store,
  onEvent: bridgeToLogger(logger),
  config: { maxIterations: 6, reviewEvery: 3, target: 90 },
});

let running = false;
let chosen = null;

/* A pre-opened environment, exactly as the contract assumes. */
const SNAPSHOT = { surfaces: {
  manager:  { tabId: 11, url: 'https://chatgpt.com/c/demo-manager',   conversationId: 'demo-manager', ready: true, signedIn: true, title: 'Orchestrator PM' },
  engineer: { tabId: 22, url: 'https://arena.ai/w/demo-workspace',    conversationId: 'demo-workspace', ready: true, signedIn: true, title: 'reporting-service' },
  reviewer: { tabId: 33, url: 'https://chat.deepseek.com/a/chat/s/d9', conversationId: 'd9', ready: true, signedIn: true, title: 'strategy' },
} };
const HOSTS = { manager: ['chatgpt.com'], engineer: ['arena.ai'], reviewer: ['chat.deepseek.com'] };

const engine = {
  memory: () => orch.memory,
  logger: () => logger,
  config: () => orch.config,
  startedAt: () => startedAt,

  async preflight(setup) {
    logger.log('config-loaded', { source: 'system', description: 'Running pre-start validation' });
    const setupCheck = validateSetup(setup);
    const result = await preflight({ setup, snapshot: SNAPSHOT, hosts: HOSTS, logger, store });
    result.setupProblems = setupCheck.problems;
    if (result.ok) {
      chosen = setup;
      result.prompt = composeFirstPrompt({
        mode: setup.mode,
        prompt: setup.prompt,
        projectName: setup.projectName,
        memory: { ...emptyMemory(initialScope(setup), setup.mode) },
      });
    }
    logger.log(result.ok ? 'config-loaded' : 'error', {
      source: 'system',
      status: result.ok ? 'success' : 'error',
      description: result.summary,
    });
    return result;
  },

  async start(setup) {
    if (running) return;
    const s = setup || chosen || { mode: 'new', prompt: SCOPE };
    running = true;
    startedAt = Date.now();
    logger.log('extension-started', { source: 'extension', description: 'Extension started' });
    logger.log('config-loaded', { source: 'system', description: 'Configuration loaded — target 90%, max 6 iterations (demo)' });
    const scope = initialScope(s);
    logger.log('project-loaded', { source: 'extension', description: 'Project loaded (' + s.mode + '): ' + scope });
    await orch.load(scope, s.mode);
    logger.log('state-restored', { source: 'system', description: 'State restored from storage' });
    try { await orch.run(); } catch (e) {
      logger.log('error', { status: 'error', description: String(e && e.message || e) });
    }
    logger.log('session-ended', { source: 'system', description: 'Run finished — see the Summary tab' });
    running = false;
    panel.markDirty();
  },
  async pause() { orch.pause(); },
  async resume() { orch.resume(); if (!running) engine.start(); },
  async stop() { await orch.stop(); },
  async skip() { orch.skipStep(); },
  async retry() { orch.retryStep(); },
  async export() {
    const all = await logger.all();
    const blob = new Blob([toNdjson(all)], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'orchestrator-' + logger.sessionId + '.ndjson';
    a.click();
    logger.log('log-exported', { source: 'user', description: 'Exported ' + all.length + ' events as NDJSON' });
  },
  async report() {
    logger.log('user-action', { source: 'user', description: 'Opened the latest report (not implemented in the demo)', status: 'warning' });
  },
};

const panel = createPanel({ root: document.getElementById('app'), engine, repaintMs: 400 });
logger.log('extension-started', { source: 'extension', description: 'Demo loaded — choose a workflow' });
panel.markDirty();
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Development Orchestrator — side panel demo</title>
<style>
${CSS}
body { max-width: 460px; margin: 0 auto; border-left: 1px solid var(--line); border-right: 1px solid var(--line); min-height: 100vh; }
.demo-note { background: #1f2937; color: #58a6ff; padding: 7px 12px; font-size: 11px; border-bottom: 1px solid var(--line); }
</style>
</head>
<body>
<div class="demo-note">
  Demo — the real engine, logger and UI, driven by fake AI adapters on a sped-up clock.
  Choose a workflow, run the environment check, then start. Alt+P pause · Alt+R resume · Alt+S stop · Alt+E export.
</div>
<div id="app"></div>
<script type="module">
${core}
${demo}
</script>
</body>
</html>
`;

writeFileSync('demo.html', html);
console.log(`wrote demo.html — ${(html.length / 1024).toFixed(0)} KB, ${MODULES.length} modules inlined`);

/*
 * PARSE THE BUNDLE BEFORE CLAIMING SUCCESS.
 *
 * Concatenating modules into one scope reintroduces a hazard ES modules
 * removed: two files may each declare `describe` quite legally, and the
 * bundle is then a hard SyntaxError. That happened on the first build and the
 * whole 135-test suite stayed green, because the tests import modules
 * properly. A build that writes a broken file and prints "wrote demo.html" is
 * worse than a build that fails.
 */
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { execFileSync } = require_('node:child_process');
const { writeFileSync: wf, mkdtempSync } = require_('node:fs');
const { tmpdir } = require_('node:os');
const { join: pjoin } = require_('node:path');

const tmp = pjoin(mkdtempSync(pjoin(tmpdir(), 'demo-')), 'bundle.mjs');
wf(tmp, html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
try {
  execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
  console.log('ok: the inlined bundle parses');
} catch (err) {
  console.error('the demo bundle is not valid JavaScript:\n' + String(err.stderr || err));
  process.exit(1);
}
