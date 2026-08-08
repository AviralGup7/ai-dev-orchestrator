#!/usr/bin/env node
/**
 * Produce a worked example of the run log, so the format can be reviewed
 * without a browser and without waiting for a real run.
 *
 * It drives the REAL orchestrator against fakes, then drifts the environment
 * on purpose — the interesting half of the log is the halt, and a sample that
 * only shows the happy path would not tell the reader what a failure looks
 * like when they need it.
 *
 * Writes docs/SAMPLE-RUN-LOG.md.
 */
import { writeFileSync } from 'node:fs';

import { Orchestrator } from '../src/core/orchestrator.js';
import { MemoryStore } from '../src/core/store.js';
import { Journal } from '../src/core/journal.js';
import { bind } from '../src/core/environment.js';

const SNAPSHOT = {
  surfaces: {
    manager: {
      tabId: 11, windowId: 1, url: 'https://chatgpt.com/c/6f21-manager',
      conversationId: '6f21-manager', title: 'Orchestrator — project manager',
      ready: true, signedIn: true,
    },
    engineer: {
      tabId: 22, windowId: 1, url: 'https://arena.ai/w/ws-orchestrator',
      conversationId: 'ws-orchestrator', title: 'ai-dev-orchestrator',
      ready: true, signedIn: true,
    },
    reviewer: {
      tabId: 33, windowId: 1, url: 'https://chat.deepseek.com/a/chat/s/9c04',
      conversationId: '9c04', title: 'strategic review', ready: true, signedIn: true,
    },
  },
};

const binding = bind(SNAPSHOT, {
  require: ['manager', 'engineer'],
  hosts: {
    manager: ['chatgpt.com', 'chat.openai.com'],
    engineer: ['arena.ai'],
    reviewer: ['deepseek.com', 'chat.deepseek.com'],
  },
});

/* Healthy for a while, then the user switches the ChatGPT tab to another chat. */
let checks = 0;
const environment = {
  binding,
  async check() {
    checks++;
    if (checks <= 10) return { ok: true, problems: [] };
    return {
      ok: false,
      problems: [{
        surface: 'manager',
        label: 'ChatGPT (project manager)',
        kind: 'conversation-changed',
        detail: 'bound to "6f21-manager", tab is now on "a-different-chat"',
        remedy: 'switch that tab back to the bound conversation, then resume',
      }],
    };
  },
};

const OBJECTIVES = [
  { text: 'add a CSV export pipeline with tests' },
  { text: 'wire up keyboard navigation in the sidebar' },
  { text: 'harden the retry budget in the network layer' },
];

const RESULTS = [
  {
    evidence: [
      { kind: 'test', passed: 41, failed: 3, skipped: 0, at: Date.now() },
      { kind: 'build', ok: true, durationMs: 4120, at: Date.now() },
      { kind: 'diff', filesChanged: 4, insertions: 210, deletions: 12, at: Date.now() },
    ],
    filesChanged: ['src/export/csv.js', 'test/csv.test.mjs', 'src/index.js', 'README.md'],
    summary: 'Added src/export/csv.js and a test file. 3 tests fail on quoting of embedded commas.',
  },
  {
    evidence: [
      { kind: 'test', passed: 47, failed: 0, skipped: 2, at: Date.now() },
      { kind: 'build', ok: true, durationMs: 3980, at: Date.now() },
      { kind: 'coverage', linesPct: 81, branchesPct: 68, at: Date.now() },
    ],
    filesChanged: ['src/export/csv.js', 'src/ui/sidebar.js'],
    summary: 'Fixed comma quoting; 2 keyboard-nav tests skipped pending a jsdom shim.',
  },
];

const journal = new Journal();
const orch = new Orchestrator({
  manager: {
    async plan(ctx) {
      return OBJECTIVES[Math.min(ctx.iteration - 1, OBJECTIVES.length - 1)];
    },
    async evaluate({ evidence }) {
      const t = evidence.find((e) => e.kind === 'test');
      const good = t && t.failed === 0;
      return {
        scores: [
          { dimension: 'completion', score: good ? 55 : 35, confidence: 'inferred', basis: [{ kind: 'diff' }] },
          { dimension: 'quality', score: 60, confidence: 'inferred', basis: [{ kind: 'lint' }] },
          { dimension: 'testing', score: 95, confidence: 'measured', basis: [{ kind: 'test' }] },
          { dimension: 'architecture', score: 70, confidence: 'asserted', basis: [] },
          { dimension: 'uiux', score: 50, confidence: 'asserted', basis: [] },
          { dimension: 'performance', score: 60, confidence: 'asserted', basis: [] },
          { dimension: 'security', score: 65, confidence: 'asserted', basis: [] },
          { dimension: 'documentation', score: 45, confidence: 'asserted', basis: [] },
          { dimension: 'accessibility', score: 30, confidence: 'asserted', basis: [] },
        ],
        openIssues: good ? ['keyboard-nav tests are skipped'] : ['CSV quoting of embedded commas'],
      };
    },
  },
  engineer: {
    async execute(ctx) {
      const i = OBJECTIVES.findIndex((o) => o.text === ctx.objective.text);
      return RESULTS[Math.min(Math.max(i, 0), RESULTS.length - 1)];
    },
  },
  reviewer: {
    async review() {
      return { recommendation: 'continue', rationale: 'testing is measured and rising' };
    },
  },
  store: new MemoryStore(),
  environment,
  onEvent: journal.record,
  config: { maxIterations: 10, reviewEvery: 2 },
});

const verdict = await orch.run();
const md = journal.render(orch.memory, binding);
writeFileSync('docs/SAMPLE-RUN-LOG.md', md);
console.log(`wrote docs/SAMPLE-RUN-LOG.md — ${md.split('\n').length} lines, verdict: ${verdict.reason}`);
