/**
 * The view layer.
 *
 * Rendering is tested because the UI is where two safeguards can be quietly
 * undone: a health percentage shown without its evidence caveat re-introduces
 * the flattery `scoring.js` exists to prevent, and an unescaped log entry turns
 * scraped AI output into script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, renderStatus, renderWorkflow, renderLog, renderControls, renderErrors, renderSummary } from '../extension/ui.js';
import { liveStatus, workflowState, errorCenter } from '../src/core/status.js';
import { availableControls } from '../src/core/controls.js';
import { Logger, summarise } from '../src/core/logger.js';

test('every interpolated value is escaped — log entries contain AI output', () => {
  /*
   * The Activity Log renders objectives, filenames, error text and raw model
   * responses. All of it is attacker-adjacent: an AI asked to fix a bug will
   * happily echo back whatever was in the file it read.
   */
  const nasty = '<img src=x onerror="alert(1)">';
  const log = new Logger();
  log.log('planning-complete', { description: nasty, data: { objective: nasty } });

  const html = renderLog(log.live);
  assert.equal(html.includes('<img src=x'), false, 'raw markup must not survive');
  assert.match(html, /&lt;img src=x/);
  assert.equal(esc('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('the status panel never shows a health score without its evidence fraction', () => {
  /*
   * A bare "82%" in a large font undoes the entire confidence model. The
   * caveat must be in the same glance, not a tooltip.
   */
  const html = renderStatus(liveStatus({
    status: 'running', phase: 'execute', iteration: 5,
    objective: { text: 'x' },
    history: [{ overall: 82 }],
    scores: [{ scores: [
      { dimension: 'testing', confidence: 'measured' },
      { dimension: 'uiux', confidence: 'asserted' },
      { dimension: 'security', confidence: 'asserted' },
    ] }],
    flags: {},
  }, {}));

  assert.match(html, /82%/);
  assert.match(html, /1\/3 dimensions measured/);
});

test('a score with nothing measured behind it is visually marked', () => {
  const html = renderStatus(liveStatus({
    status: 'running', phase: 'plan', iteration: 2,
    history: [{ overall: 91 }],
    scores: [{ scores: [{ dimension: 'uiux', confidence: 'asserted' }] }],
    flags: {},
  }, {}));
  assert.match(html, /class="big unmeasured"/, 'an entirely asserted score must not look authoritative');
});

test('the status panel answers "what next" and surfaces a block', () => {
  const html = renderStatus(liveStatus({
    status: 'blocked', phase: 'execute', iteration: 3, history: [], scores: [], flags: {},
    block: { detail: 'ChatGPT: conversation-changed' },
  }, {}));
  assert.match(html, /Blocked/);
  assert.match(html, /conversation-changed/);
  assert.match(html, /Next/);
});

test('the workflow highlights exactly one stage', () => {
  const html = renderWorkflow(workflowState({ status: 'running', phase: 'evaluate', iteration: 4 }));
  assert.equal((html.match(/class="stage active"/g) || []).length, 1);
  assert.match(html, /ChatGPT Review/);
  assert.match(html, /DeepSeek Strategy Review/);
});

test('the log banner states how many events the view is not showing', () => {
  /*
   * The durable sink keeps everything; the panel shows a window. Saying so
   * plainly is the difference between a bounded view and a lie.
   */
  const log = new Logger({ liveLimit: 5 });
  for (let i = 0; i < 30; i++) log.log('scrolled');
  const html = renderLog(log.view(), log.notShown);
  assert.match(html, /25 earlier events not shown/);
  assert.match(html, /in the export/);
});

test('a pending entry is visibly in flight, not reported as a success', () => {
  const log = new Logger();
  log.begin('awaiting-response', { source: 'arena', description: 'running tests' });
  const html = renderLog(log.live);
  assert.match(html, /class="spin"/, 'a wait must look like a wait');
  assert.match(html, /running tests/);
});

test('every log row exposes its event id, for bug reports and replay', () => {
  const log = new Logger();
  log.log('state-saved');
  assert.match(renderLog(log.live), /evt-[^<"]*-000001/);
});

test('controls are rendered disabled rather than omitted', () => {
  const html = renderControls(availableControls({ status: 'running' }));
  assert.match(html, /data-action="start"[^>]*disabled/);
  assert.match(html, /data-action="stop"/);
  assert.equal(html.includes('data-action="pause" class="btn" disabled'), false);
  // all eight controls are always present, so the layout never jumps
  for (const a of ['start', 'pause', 'resume', 'stop', 'skip', 'retry', 'export', 'report']) {
    assert.match(html, new RegExp(`data-action="${a}"`), `${a} must always be visible`);
  }
});

test('the error center renders a suggestion and a retry affordance', () => {
  const log = new Logger();
  log.log('build-failed', {
    source: 'arena', status: 'error', phase: 'execute', iteration: 2,
    description: 'tsc exited 2', data: { stderr: 'TS2304' },
  });
  const html = renderErrors(errorCenter(log.live));
  assert.match(html, /tsc exited 2/);
  assert.match(html, /1 unresolved/);
  assert.match(html, /Retry this step/);
  assert.match(html, /Technical details/);
  assert.match(html, /TS2304/);
});

test('an empty error center says so instead of rendering nothing', () => {
  assert.match(renderErrors([]), /No errors this session/);
});

test('the session summary reports completion with its measured fraction', () => {
  const s = summarise([], {
    status: 'stopped', stopReason: 'target-reached',
    history: [{ overall: 91 }],
    scores: [{ scores: [
      { dimension: 'testing', confidence: 'measured' },
      { dimension: 'uiux', confidence: 'asserted' },
    ] }],
  });
  const html = renderSummary(s);
  assert.match(html, /91% — 1\/2 dimensions measured/);
  assert.match(html, /target-reached/);
});

test('the summary surfaces steps that never reported an outcome', () => {
  /*
   * "0 errors" while three steps hang is the kind of quiet lie this project
   * treats as a bug.
   */
  const html = renderSummary(summarise([], null, { openEvents: 3 }));
  assert.match(html, /3 step\(s\) never reported an outcome/);
});

test('the summary admits storage failures rather than rounding them away', () => {
  const html = renderSummary(summarise([], null, { sinkFailures: [{ error: 'quota' }] }));
  assert.match(html, /1 storage failure/);
});

/* ====================================================== mission control == */

test('the scorecard colours by CONFIDENCE, not by value', async () => {
  /*
   * A 95% asserted score and a 95% measured score are identical as numbers and
   * mean completely different things. If the UI presents them the same way,
   * the entire scoring model is undone at the last step.
   */
  const { renderScores } = await import('../extension/ui.js');
  const html = renderScores([
    { dimension: 'testing', score: 95, confidence: 'measured', basis: [{ kind: 'test' }] },
    { dimension: 'uiux', score: 95, confidence: 'asserted', basis: [] },
  ]);
  assert.match(html, /var\(--ok\)/, 'measured is green');
  assert.match(html, /var\(--warn\)/, 'asserted is amber');
  assert.match(html, /1 of 2 dimensions rest on evidence/);
  assert.match(html, /cannot end a run/);
});

test('an unknown metric renders as a dash with a reason, never a zero', async () => {
  const { renderAnalytics } = await import('../extension/ui.js');
  const { analyse } = await import('../src/core/analytics.js');
  const html = renderAnalytics(analyse([]));
  assert.match(html, /Token efficiency/);
  assert.equal(/Token efficiency<\/th><td>0/.test(html), false, 'must not fabricate a zero');
  assert.match(html, /—/);
  assert.match(html, /cannot observe token counts/);
});

test('the environment strip distinguishes missing from optional', async () => {
  const { renderEnvironment } = await import('../extension/ui.js');
  const html = renderEnvironment({ surfaces: { manager: { tabId: 11 } }, project: 'a project' });
  assert.match(html, />READY</);
  assert.match(html, />MISSING</, 'a required missing surface is called out');
  assert.match(html, />OFF</, 'an optional one is not an error');
});

test('the roles panel shows which AI has the floor', async () => {
  const { renderRoles } = await import('../extension/ui.js');
  const working = renderRoles({ ai: 'arena', status: 'running', step: 'Waiting for Arena' },
    { surfaces: { manager: { tabId: 1 }, engineer: { tabId: 2 } } });
  assert.match(working, />WORKING</);
  assert.match(working, />WAITING</, 'the others are waiting, not idle');
});

test('iteration history explains why the run moved on', async () => {
  const { renderHistory } = await import('../extension/ui.js');
  const html = renderHistory([{
    n: 4, startedAt: 0, finishedAt: 42000,
    objective: { text: 'fix comma quoting', rationale: 'the largest gap' },
    summary: 'patched the writer', filesChanged: ['src/csv.js'],
    evidence: [{ kind: 'test' }], overall: 62,
    signals: [{ kind: 'file-churn' }],
    review: { recommendation: 'change-strategy', newDirection: 'move to sync' },
    contradictions: [{ message: 'reported complete with 3 failing tests' }],
  }]);
  assert.match(html, /fix comma quoting/);
  assert.match(html, /the largest gap/);
  assert.match(html, /Loop signals: file-churn/);
  assert.match(html, /move to sync/);
  assert.match(html, /reported complete with 3 failing/);
  assert.match(html, /42s/);
});

test('replay states plainly that nothing was contacted', async () => {
  const { renderReplay } = await import('../extension/ui.js');
  const html = renderReplay({ narrative: [{ at: Date.now(), iteration: 1, text: 'Objective: x' }], events: 12, durable: true });
  assert.match(html, /No AI was contacted/);
  assert.match(html, /12 logged events/);
});

test('a memory-only replay says so rather than pretending to be complete', async () => {
  const { renderReplay } = await import('../extension/ui.js');
  const html = renderReplay({ narrative: [{ at: 1, iteration: 1, text: 'x' }], events: 3, durable: false });
  assert.match(html, /Replaying from memory/);
  assert.match(html, /may be missing/);
});
