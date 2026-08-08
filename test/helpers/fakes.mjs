/**
 * Fake adapters.
 *
 * WHY THESE ARE WORTH CARE
 * ------------------------
 * The whole architectural claim of this project is that the engine is
 * independent of how the AIs are reached. These fakes are the proof: if the
 * orchestrator runs correctly against them, the DOM transport is a detail.
 *
 * They are also the thing that makes the hard behaviours testable at all. You
 * cannot ask the real ChatGPT to "flatter the scores so I can check the
 * reconciler downgrades them" -- but you can ask a fake, and that is exactly
 * the scenario that matters most.
 *
 * Each fake is SCRIPTABLE rather than fixed, because the interesting tests are
 * about sequences: the same objective twice, a score that plateaus, evidence
 * that never changes.
 */

/** A manager that walks a script of objectives and scorecards. */
export function fakeManager({ objectives = [], evaluations = [] } = {}) {
  let planCalls = 0;
  let evalCalls = 0;

  return {
    planCalls: () => planCalls,
    evalCalls: () => evalCalls,

    async plan(ctx) {
      const scripted = objectives[planCalls] ?? objectives[objectives.length - 1];
      planCalls++;
      if (typeof scripted === 'function') return scripted(ctx);
      return scripted ?? { text: `objective ${planCalls}` };
    },

    async evaluate(ctx) {
      const scripted = evaluations[evalCalls] ?? evaluations[evaluations.length - 1];
      evalCalls++;
      if (typeof scripted === 'function') return scripted(ctx);
      return scripted ?? { scores: [] };
    },
  };
}

/** An engineer that returns scripted evidence. */
export function fakeEngineer({ results = [] } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async execute(ctx) {
      const scripted = results[calls] ?? results[results.length - 1];
      calls++;
      if (typeof scripted === 'function') return scripted(ctx);
      return scripted ?? { evidence: [], filesChanged: [], summary: 'did nothing' };
    },
  };
}

/** A reviewer that records what it was asked and answers from a script. */
export function fakeReviewer({ responses = [] } = {}) {
  let calls = 0;
  const seen = [];
  return {
    calls: () => calls,
    seen: () => seen,
    async review(ctx) {
      seen.push(ctx);
      const scripted = responses[calls] ?? responses[responses.length - 1];
      calls++;
      if (typeof scripted === 'function') return scripted(ctx);
      return scripted ?? { recommendation: 'continue' };
    },
  };
}

/** A full scorecard at one level, for tests that only care about the total. */
export function flatScores(value, confidence = 'measured', basis = [{ kind: 'test' }]) {
  const keys = [
    'completion', 'quality', 'testing', 'architecture', 'uiux',
    'performance', 'security', 'documentation', 'accessibility',
  ];
  return keys.map((dimension) => ({
    dimension,
    score: value,
    confidence,
    basis: confidence === 'measured' ? basis : [],
  }));
}

/** Passing-test evidence, shaped like the real thing. */
export function passing(n = 100) {
  return { kind: 'test', passed: n, failed: 0, skipped: 0, at: Date.now() };
}
