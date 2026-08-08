/**
 * THE SIMULATED TRANSPORT.
 *
 * Implements the same `send({prompt, surface, timeoutMs})` contract as the DOM
 * transport, and produces replies that look like what the real AIs return --
 * including the ways they go wrong.
 *
 * WHY THIS IS A REAL SUBSYSTEM AND NOT A TEST FIXTURE
 * ---------------------------------------------------
 * §25 asks for it before relying on live automation, and the reason is
 * arithmetic: a fifty-iteration run against real services is hours of wall
 * time, three rate limits, and a different failure every attempt. Every
 * scenario in §41 -- timeout, malformed response, tab disappearance, repeated
 * failure, recovery -- is reproducible here in milliseconds and deterministic.
 *
 * It is also the honest way to test the UI. A dashboard that has only ever
 * rendered a successful run is a dashboard whose error states have never been
 * seen.
 *
 * DETERMINISM
 * A seeded PRNG, so a failing scenario reproduces exactly. `Math.random()`
 * would make an intermittent bug unreproducible, which is the specific problem
 * simulation exists to solve.
 */

import { AdapterError } from '../adapters/base.js';

/** Mulberry32. Small, fast, good enough, and identical across runs. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fault injection.
 *
 * Each entry says: on this surface, at this call number, do this instead.
 * Deliberately keyed by call index rather than probability -- "fail the third
 * Arena call" is a reproducible scenario; "fail 20% of calls" is a flaky test.
 */
export const FAULTS = /** @type {const} */ ([
  'timeout',        // never replies
  'empty',          // replies with whitespace
  'malformed',      // replies with prose and no report block
  'truncated',      // replies with a cut-off JSON block
  'transport',      // the tab is gone
  'forbidden',      // returns fields the role may not set
  'flattery',       // claims measured scores with no evidence
  'contradiction',  // "complete" alongside failing tests
]);

export class SimTransport {
  /**
   * @param {object} [options]
   * @param {number} [options.seed]
   * @param {object} [options.faults]     `{ engineer: {3: 'timeout'} }`
   * @param {object} [options.script]     project trajectory
   * @param {number} [options.latencyMs]  simulated think time
   */
  constructor({ seed = 1, faults = {}, script = {}, latencyMs = 0 } = {}) {
    this.random = rng(seed);
    this.faults = faults;
    this.latencyMs = latencyMs;
    this.calls = { manager: 0, engineer: 0, reviewer: 0 };
    this.sent = [];
    this.script = {
      /** Test counts per engineer call. The project's actual trajectory. */
      tests: [
        { passed: 38, failed: 6, skipped: 0, build: true },
        { passed: 44, failed: 2, skipped: 2, build: false },
        { passed: 45, failed: 1, skipped: 2, build: true },
        { passed: 45, failed: 1, skipped: 2, build: true },   // stall
        { passed: 45, failed: 1, skipped: 2, build: true },   // stall
        { passed: 58, failed: 0, skipped: 0, build: true },
        { passed: 72, failed: 0, skipped: 0, build: true },
        { passed: 91, failed: 0, skipped: 0, build: true },
      ],
      objectives: [
        'add a CSV export pipeline with tests',
        'wire up keyboard navigation in the sidebar',
        'fix quoting of embedded commas in the exporter',
        'fix embedded comma quoting in the CSV exporter',
        'fix the exporter quoting of embedded commas',
        'improve error handling for the sync module',
        'add integration tests for the export pipeline',
        'document the public plugin interface',
      ],
      ...script,
    };
  }

  faultFor(surface) {
    const n = this.calls[surface];
    return this.faults[surface]?.[n] ?? null;
  }

  async send({ prompt, surface, timeoutMs = 300_000 }) {
    this.calls[surface] = (this.calls[surface] ?? 0) + 1;
    const call = this.calls[surface];
    this.sent.push({ surface, call, chars: prompt.length, at: Date.now() });

    const fault = this.faultFor(surface);

    if (fault === 'transport') {
      throw new AdapterError('failed', `the ${surface} tab is no longer open`);
    }
    if (fault === 'timeout') {
      /*
       * Rejects immediately rather than actually waiting timeoutMs.
       *
       * A test that genuinely waits five minutes to prove a timeout is a test
       * nobody runs. What matters is that the adapter sees a timeout-shaped
       * failure; the clock is the transport's business and is covered
       * separately in the DOM transport's own tests.
       */
      throw new AdapterError('timed-out', `${surface} did not respond within ${timeoutMs}ms`);
    }
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (fault === 'empty') return { text: '   \n  ' };

    const body = surface === 'manager'
      ? (/QUALITY REVIEWER/.test(prompt) ? this.evaluation(call, fault) : this.plan(call, fault))
      : surface === 'engineer' ? this.execution(call, fault, prompt)
        : this.review(call, fault);

    return { text: body };
  }

  /* ---------------------------------------------------------- manager -- */

  plan(call, fault) {
    if (fault === 'malformed') {
      return 'Sure! I think the next thing to do is probably improve the tests a bit. Let me know what you think.';
    }
    if (fault === 'truncated') {
      return '```ORCHESTRATOR-PLAN\n{\n  "objective": "add streaming to the exp';
    }
    const objective = this.script.objectives[Math.min(call - 1, this.script.objectives.length - 1)];
    const extra = fault === 'forbidden'
      ? ',\n  "patch": "diff --git a/src/csv.js b/src/csv.js\\n+fixed",\n  "command": "npm run fix"'
      : '';
    return `Looking at the state of the project, here is what I would do next.

\`\`\`ORCHESTRATOR-PLAN
{
  "objective": "${objective}",
  "tasks": ["implement it", "add tests", "run the suite"],
  "priority": "high",
  "expectedEvidence": ["test results", "build status"],
  "constraints": ["do not change the public API"],
  "acceptance": ["the suite passes", "the build is green"],
  "rationale": "This is the largest gap between the current state and the target."${extra}
}
\`\`\``;
  }

  evaluation(call, fault) {
    if (fault === 'malformed') return 'The project looks like it is coming along nicely. Maybe 70%?';

    const t = this.script.tests[Math.min(call - 1, this.script.tests.length - 1)];
    const base = t.build ? Math.min(40 + call * 6, 88) : 40;

    if (fault === 'flattery') {
      /*
       * Every dimension claimed as `measured` at 95, with a basis naming
       * evidence that was never produced. Exactly the failure the confidence
       * model exists to catch, and the reason it must be tested against a
       * transport that actually attempts it.
       */
      return `\`\`\`ORCHESTRATOR-EVALUATION
{
  "scores": [
    ${['completion', 'quality', 'testing', 'architecture', 'uiux', 'performance', 'security', 'documentation', 'accessibility']
      .map((d) => `{ "dimension": "${d}", "score": 95, "confidence": "measured", "basis": ["comprehensive analysis"] }`)
      .join(',\n    ')}
  ],
  "issues": [],
  "reasoning": "Everything looks excellent."
}
\`\`\``;
    }

    const scored = [
      `{ "dimension": "completion", "score": ${base}, "confidence": "inferred", "basis": ["diff: files changed"] }`,
      `{ "dimension": "quality", "score": ${Math.max(30, base - 8)}, "confidence": "inferred", "basis": ["lint output"] }`,
      `{ "dimension": "testing", "score": ${t.failed ? 55 : 90}, "confidence": "measured", "basis": ["test run: ${t.passed} passed"] }`,
      `{ "dimension": "architecture", "score": 70, "confidence": "asserted", "basis": [] }`,
      `{ "dimension": "uiux", "score": 55, "confidence": "asserted", "basis": [] }`,
      `{ "dimension": "performance", "score": 62, "confidence": "asserted", "basis": [] }`,
      `{ "dimension": "security", "score": 60, "confidence": "asserted", "basis": [] }`,
      `{ "dimension": "documentation", "score": ${Math.min(40 + call * 4, 80)}, "confidence": "asserted", "basis": [] }`,
      `{ "dimension": "accessibility", "score": 35, "confidence": "asserted", "basis": [] }`,
    ];
    return `Here is my assessment.

\`\`\`ORCHESTRATOR-EVALUATION
{
  "scores": [
    ${scored.join(',\n    ')}
  ],
  "issues": [${t.failed ? `"${t.failed} tests still failing"` : ''}],
  "resolved": [],
  "reasoning": "Testing is measured; the rest rests on weaker evidence."
}
\`\`\``;
  }

  /* --------------------------------------------------------- engineer -- */

  execution(call, fault, prompt) {
    if (fault === 'malformed') {
      /*
       * Prose that CONTAINS real terminal output. The engineer adapter should
       * salvage the measured evidence from it rather than discarding
       * everything because the JSON was missing -- a real observation is real
       * regardless of the formatting around it.
       */
      return `I made the changes and ran the suite.\n\n\`\`\`\n1276 passed, 3 failed\n\`\`\`\n\nLet me know if you want anything adjusted.`;
    }
    if (fault === 'truncated') {
      return '```ORCHESTRATOR-REPORT\n{\n  "taskStatus": "complete",\n  "summary": "did the thing",\n  "tests": {';
    }

    const t = this.script.tests[Math.min(call - 1, this.script.tests.length - 1)];
    const exploring = /EXPLORATION ONLY/.test(prompt);
    const files = exploring ? [] : ['src/export/csv.js', 'test/csv.test.mjs'].slice(0, 1 + (call % 2));

    const status = fault === 'contradiction' ? 'complete' : (t.failed ? 'partial' : 'complete');
    const extra = fault === 'forbidden'
      ? ',\n  "nextObjective": "rewrite the whole thing in Rust",\n  "projectComplete": true'
      : '';

    return `Ran the work.

\`\`\`
$ npm test
Tests: ${t.failed} failed, ${t.skipped} skipped, ${t.passed} passed, ${t.passed + t.failed + t.skipped} total
$ npm run build
${t.build ? 'webpack compiled successfully in 4123 ms' : 'npm ERR! exit code 2'}
$ git diff --stat
 ${files.length} files changed, ${40 + call * 7} insertions(+), ${call * 2} deletions(-)
\`\`\`

\`\`\`ORCHESTRATOR-REPORT
{
  "taskStatus": "${status}",
  "summary": "${exploring ? 'A Node service with a CSV export feature. 44 tests, one failing area around comma quoting.' : `Worked on iteration ${call}.`}",
  "filesModified": ${JSON.stringify(files)},
  "build": { "ran": true, "ok": ${t.build}, "command": "npm run build", "output": "" },
  "tests": { "ran": true, "passed": ${t.passed}, "failed": ${t.failed}, "skipped": ${t.skipped}, "command": "npm test" },
  "commit": { "made": ${files.length > 0}, "sha": "a1b2c3${call}", "message": "iteration ${call}" },
  "diff": { "filesChanged": ${files.length}, "insertions": ${40 + call * 7}, "deletions": ${call * 2} },
  "knownIssues": [${t.failed ? `"${t.failed} failing tests"` : ''}],
  "risks": [],
  "suggestedNextTask": "consider streaming for large exports",
  "artifacts": ${exploring ? '["report.md"]' : '[]'},
  "engineeringReport": "Detail of what changed and why."${exploring ? ',\n  "roadmap": ["fix comma quoting", "add streaming", "document the API"]' : ''}${extra}
}
\`\`\``;
  }

  /* --------------------------------------------------------- reviewer -- */

  review(call, fault) {
    if (fault === 'malformed') return 'Things look fine to me, keep going.';
    const extra = fault === 'forbidden' ? ',\n  "patch": "diff ...",\n  "scores": [{"dimension":"testing","score":99}]' : '';

    /*
     * The second review recommends a change, because the scripted trajectory
     * stalls at iterations 3-5. A reviewer that always says "continue" would
     * never exercise the strategy-change path.
     */
    const changing = call >= 2;
    return `\`\`\`ORCHESTRATOR-REVIEW
{
  "assessment": "${changing ? 'Three iterations have touched the same file with no score movement.' : 'Progress is steady and evidence-backed.'}",
  "signals": ${changing ? '["file-churn", "score-plateau"]' : '[]'},
  "recommendation": "${changing ? 'change-strategy' : 'continue'}",
  ${changing ? '"strategy": "Stop iterating on the exporter; the failing area is the sync module.",' : ''}
  "recommendedActions": ["move to the sync module", "add integration coverage"],
  "rationale": "${changing ? 'Repetition without measured movement.' : 'Testing is measured and rising.'}"${extra}
}
\`\`\``;
  }
}
