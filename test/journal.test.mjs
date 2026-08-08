/**
 * The copy-pasteable log.
 *
 * The user's requirement is that the log is INPUT to the next development
 * session — pasted into a chat window to improve the extension. That makes two
 * properties correctness concerns rather than niceties: it must not leak a
 * secret into a chat window, and it must not lose the beginning of the run to
 * truncation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, redact } from '../src/core/journal.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { MemoryStore } from '../src/core/store.js';
import { fakeManager, fakeEngineer, fakeReviewer, flatScores, passing } from './helpers/fakes.mjs';

test('redact removes credentials that scraped AI output could contain', () => {
  const dirty = [
    'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'secret GOCSPX-abcdefghijklmnop',
    'key sk-abcdefghijklmnopqrstuvwx',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'git push https://user:ghp_zzzzzzzzzzzzzzzz@github.com/a/b.git',
  ].join('\n');

  const clean = redact(dirty);
  assert.equal(/ghp_[A-Za-z0-9]/.test(clean), false);
  assert.equal(clean.includes('GOCSPX-abcdefghijklmnop'), false);
  assert.equal(clean.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.equal(clean.includes('Bearer abcdefghij'), false);
  assert.match(clean, /REDACTED/);
});

test('redaction runs on the RENDERED log, not just on fields that looked risky', async () => {
  /*
   * The realistic leak is not our own token — it is the engineer pasting an
   * .env file back in a summary. So the check is on the output of render().
   */
  const j = new Journal();
  j.record({ type: 'executed', at: 1, iteration: 1 });
  const memory = {
    scope: 'a project', status: 'running', iteration: 1, phase: 'plan',
    decisions: [], scores: [],
    history: [{
      n: 1,
      objective: { text: 'fix CI' },
      summary: 'CI needs GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA to push',
      filesChanged: ['.github/workflows/ci.yml'],
      evidence: [{ kind: 'log', text: 'export KEY=sk-abcdefghijklmnopqrstuvwx' }],
    }],
  };
  const md = j.render(memory, null);
  assert.equal(/ghp_A/.test(md), false, 'a token in an AI summary must not survive rendering');
  assert.equal(/sk-abcdefghijklmnop/.test(md), false, 'nor one inside evidence');
});

test('the environment binding is rendered, so the reader knows what was driven', () => {
  const j = new Journal();
  const md = j.render(null, {
    surfaces: {
      manager: { tabId: 11, host: 'chatgpt.com', conversationId: 'conv-a', label: 'ChatGPT', title: 'Project' },
      engineer: { tabId: 22, host: 'arena.ai', conversationId: 'ws-7', label: 'Arena', title: 'repo' },
    },
  });
  assert.match(md, /chatgpt\.com/);
  assert.match(md, /conv-a/);
  assert.match(md, /arena\.ai/);
});

test('environment problems appear FIRST, with remedies and the no-recovery promise', () => {
  const j = new Journal();
  j.record({
    type: 'environment-drift',
    at: 1,
    surface: 'manager',
    detail: 'x',
    problems: [{
      surface: 'manager', label: 'ChatGPT (project manager)',
      kind: 'conversation-changed', detail: 'bound to "a", now on "b"',
      remedy: 'switch that tab back to the bound conversation, then resume',
    }],
  });
  const md = j.render(null, null);

  const problemsAt = md.indexOf('Environment problems');
  const timelineAt = md.indexOf('## Timeline');
  assert.ok(problemsAt > -1 && problemsAt < timelineAt, 'the reason you opened the log goes on top');
  assert.match(md, /switch that tab back/);
  assert.match(md, /did \*\*not\*\* attempt to recover/);
});

test('an over-long journal drops the MIDDLE, keeping how the run started', () => {
  /*
   * A ring buffer keeps the newest N — which throws away the binding and the
   * first symptom, the two things a reader needs. Verified by sabotage:
   * switching to `slice(-limit)` fails this test.
   */
  const j = new Journal({ limit: 100 });
  for (let i = 0; i < 500; i++) j.record({ type: 'action-finished', at: i, action: `step-${i}` });

  assert.equal(j.events.length, 100);
  assert.equal(j.events[0].action, 'step-0', 'the first event must survive');
  assert.equal(j.events.at(-1).action, 'step-499', 'so must the last');
  assert.ok(j.dropped > 0);
  assert.match(j.render(null, null), /dropped from the middle/);
});

test('a real run produces a log with the timeline, scores and evidence in it', async () => {
  const journal = new Journal();
  const orch = new Orchestrator({
    manager: fakeManager({
      objectives: [
        { text: 'implement the CSV export pipeline' },
        { text: 'wire up keyboard navigation in the sidebar' },
      ],
      evaluations: [{ scores: flatScores(45) }],
    }),
    engineer: fakeEngineer({
      results: [{ evidence: [passing(12)], filesChanged: ['src/export.js'], summary: 'added exporter' }],
    }),
    reviewer: fakeReviewer(),
    store: new MemoryStore(),
    onEvent: journal.record,
    config: { maxIterations: 2 },
  });

  await orch.run();
  const md = journal.render(orch.memory, null);

  assert.match(md, /# AI Development Orchestrator — Run Log/);
  assert.match(md, /implement the CSV export pipeline/);
  assert.match(md, /src\/export\.js/);
  assert.match(md, /`test` passed=12/);
  assert.match(md, /\| testing \|/);
  assert.match(md, /iteration-finished/);
  assert.match(md, /budget-exhausted/);
});

test('events carry the iteration they belong to, so the timeline is not off by one', async () => {
  const journal = new Journal();
  const orch = new Orchestrator({
    manager: fakeManager({
      objectives: [
        { text: 'implement the CSV export pipeline' },
        { text: 'wire up keyboard navigation in the sidebar' },
      ],
      evaluations: [{ scores: flatScores(45) }],
    }),
    engineer: fakeEngineer({ results: [{ evidence: [passing(5)], filesChanged: [], summary: '' }] }),
    reviewer: fakeReviewer(),
    store: new MemoryStore(),
    onEvent: journal.record,
    config: { maxIterations: 2 },
  });
  await orch.run();

  const firstPlan = journal.events.find((e) => e.type === 'planned');
  assert.equal(firstPlan.iteration, 1, 'the first plan belongs to iteration 1, not 0');
});
