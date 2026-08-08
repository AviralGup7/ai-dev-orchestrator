/**
 * RESPONSE SCHEMAS — the boundary where model output stops being trusted.
 *
 * docs/SPEC.md's central structural claim: role separation is enforced by the
 * response schema, not by the prompt. A prompt saying "do not write code" is a
 * request. A validator that rejects a `patch` field is a guarantee.
 *
 * This module is that guarantee, generalised from `report.js` (which had it
 * for the engineer only) to all three roles.
 *
 * WHY A HAND-WRITTEN VALIDATOR AND NOT A LIBRARY
 * ----------------------------------------------
 * The project has zero runtime dependencies and that is load-bearing: an
 * extension ships its dependencies to the user's browser, and every one is
 * supply-chain surface in a thing that can read their ChatGPT session. Ajv is
 * ~120KB for what is, here, about two hundred lines of type checks.
 *
 * WHAT MAKES THIS DIFFERENT FROM ORDINARY VALIDATION
 * --------------------------------------------------
 * Three rules that a generic validator would not give you:
 *
 *   1. FORBIDDEN FIELDS ARE DROPPED, NOT REJECTED. If ChatGPT returns a
 *      `patch`, failing the whole response would lose a perfectly good plan
 *      over one extra key -- and the model will keep doing it. Dropping the
 *      key keeps the plan and removes the capability. What was dropped is
 *      recorded, because "the manager keeps trying to write code" is a fact
 *      the user should be able to see.
 *
 *   2. CONFIDENCE IS DOWNGRADED, NOT TRUSTED. A score claiming `measured`
 *      with no basis is not a validation error; it is a lie with a badge on.
 *      It becomes `asserted` and the downgrade is recorded.
 *
 *   3. UNKNOWN FIELDS SURVIVE unless forbidden. Models add commentary keys.
 *      Rejecting on unknown keys makes the system brittle against a model
 *      being helpful, which is a fight you lose every time.
 *
 * PURE.
 */

import { DIMENSION_KEYS, CONFIDENCE, EVIDENCE_KINDS } from './types.js';

/* ========================================================================== *
 * FORBIDDEN CAPABILITIES, PER ROLE
 * ========================================================================== */

/**
 * Fields each role must never be able to set.
 *
 * These are not stylistic. Each one names a capability that, if honoured,
 * would let a model step outside the role the architecture assigns it:
 *
 *   MANAGER   may plan and evaluate. May not write code, so anything that
 *             looks like a patch is dropped -- otherwise "the manager wrote
 *             the fix itself" becomes a silent code path with no engineer,
 *             no execution, and therefore no evidence.
 *
 *   ENGINEER  may execute and report. May not choose direction, so
 *             `nextObjective` and friends are dropped, and may not score its
 *             own work outside exploration.
 *
 *   REVIEWER  may advise. May not touch the project or declare it finished.
 */
export const FORBIDDEN = {
  manager: [
    'patch', 'diff', 'code', 'files', 'fileContents', 'writeFile', 'command',
    'commands', 'shell', 'bash', 'execute', 'apply',
  ],
  engineer: [
    'nextObjective', 'objective', 'nextIteration', 'plan', 'strategy',
    'newDirection', 'recommendation', 'stop', 'shouldStop', 'complete',
    'projectComplete', 'overall', 'overallScore', 'projectHealth',
  ],
  reviewer: [
    'patch', 'diff', 'code', 'files', 'fileContents', 'command', 'commands',
    'shell', 'execute', 'apply', 'stop', 'shouldStop', 'projectComplete',
    'scores',
  ],
};

/* ========================================================================== *
 * PRIMITIVES
 * ========================================================================== */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A validation result.
 *
 * `ok` is about whether the value is USABLE, not whether it was perfect.
 * `problems` are fatal; `warnings` are things the user should see but which
 * do not stop the run. Conflating them is how a system either crashes on
 * trivia or silently swallows real faults.
 */
function result(value, problems = [], warnings = [], dropped = []) {
  return { ok: problems.length === 0, value, problems, warnings, dropped };
}

function str(v, max = 4000) {
  return typeof v === 'string' ? v.slice(0, max) : String(v ?? '').slice(0, max);
}

function strList(v, { max = 50, maxLen = 500 } = {}) {
  if (Array.isArray(v)) return v.filter((x) => x != null).slice(0, max).map((x) => str(x, maxLen));
  if (typeof v === 'string' && v.trim()) return [str(v, maxLen)];
  return [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Strip forbidden fields.
 *
 * Case-insensitive and it also checks nested one level, because
 * `{result: {patch: "..."}}` is the same capability wearing a hat. Deeper than
 * one level is not walked: at some point a `code` key inside free-form
 * commentary is just a word, and over-zealous stripping would mangle honest
 * content.
 */
export function stripForbidden(obj, role) {
  const banned = FORBIDDEN[role] || [];
  const lower = new Map(banned.map((b) => [b.toLowerCase(), b]));
  const dropped = [];

  const strip = (o, path = '') => {
    if (!isObj(o)) return;
    for (const key of Object.keys(o)) {
      if (lower.has(key.toLowerCase())) {
        delete o[key];
        dropped.push(path ? `${path}.${key}` : key);
      }
    }
    if (!path) {
      for (const [key, val] of Object.entries(o)) {
        if (isObj(val)) strip(val, key);
      }
    }
  };

  strip(obj);
  return dropped;
}

/* ========================================================================== *
 * SCORES
 * ========================================================================== */

/**
 * Validate a list of scores, downgrading anything that overclaims.
 *
 * THE CENTRAL ANTI-FLATTERY CHECK.
 *
 * A model asked to score its own work will produce a plausible number and
 * label it confidently. The score is kept -- the number may well be sensible
 * -- but the CLAIM about how it was arrived at is checked against whether any
 * basis was supplied. No basis, no `measured`.
 */
export function validateScores(raw, { evidence = [] } = {}) {
  const problems = [];
  const warnings = [];
  if (raw == null) return result([], [], []);
  if (!Array.isArray(raw)) return result([], ['`scores` must be a list'], []);

  const seen = new Set();
  const out = [];

  for (const s of raw) {
    if (!isObj(s)) {
      warnings.push('a score entry was not an object and was ignored');
      continue;
    }
    const dimension = str(s.dimension, 40);
    if (!DIMENSION_KEYS.includes(dimension)) {
      warnings.push(`unknown dimension "${dimension}" ignored`);
      continue;
    }
    if (seen.has(dimension)) {
      /*
       * A duplicate dimension is dropped rather than merged or overwritten.
       * Silently keeping the last one lets a model "correct" a low score with
       * a high one later in the same list and have it stick.
       */
      warnings.push(`duplicate score for "${dimension}" ignored`);
      continue;
    }
    seen.add(dimension);

    const n = num(s.score);
    if (n === null) {
      warnings.push(`"${dimension}" had no usable score`);
      continue;
    }
    const score = Math.max(0, Math.min(100, Math.round(n)));

    let confidence = CONFIDENCE.includes(s.confidence) ? s.confidence : 'asserted';
    const basis = normaliseBasis(s.basis, evidence);

    if (confidence === 'measured' && basis.length === 0) {
      confidence = 'asserted';
      warnings.push(`"${dimension}" claimed to be measured with no basis — downgraded to asserted`);
    }
    if (confidence === 'inferred' && basis.length === 0) {
      confidence = 'asserted';
      warnings.push(`"${dimension}" claimed to be inferred with no basis — downgraded to asserted`);
    }

    out.push({ dimension, score, confidence, basis, reasoning: s.reasoning ? str(s.reasoning, 800) : undefined });
  }

  return result(out, problems, warnings);
}

/**
 * Turn a claimed basis into evidence references.
 *
 * A basis that names an evidence kind the iteration actually produced is
 * matched to it. A basis that names one it did NOT produce is kept as prose
 * and does not count -- which is how "measured, basis: test results" gets
 * caught when no tests were run.
 */
function normaliseBasis(basis, evidence) {
  const kinds = new Set(evidence.map((e) => e.kind));
  const out = [];
  for (const b of strList(basis, { max: 8, maxLen: 300 })) {
    const hit = EVIDENCE_KINDS.find((k) => b.toLowerCase().includes(k));
    if (hit && kinds.has(hit)) out.push({ kind: hit, note: b });
  }
  if (Array.isArray(basis)) {
    for (const b of basis) {
      if (isObj(b) && EVIDENCE_KINDS.includes(b.kind) && kinds.has(b.kind)) {
        out.push({ kind: b.kind, note: str(b.note ?? '', 300) });
      }
    }
  }
  return out;
}

/* ========================================================================== *
 * MANAGER: PLAN
 * ========================================================================== */

/**
 * `{ objective, tasks[], priority, expectedEvidence[], constraints[], acceptance[] }`
 */
export function validatePlan(raw) {
  const problems = [];
  const warnings = [];
  if (!isObj(raw)) return result(null, ['the plan was not a JSON object']);

  const obj = { ...raw };
  const dropped = stripForbidden(obj, 'manager');
  if (dropped.length) {
    warnings.push(`the manager tried to set ${dropped.join(', ')} — dropped; it may plan, not implement`);
  }

  const text = str(obj.objective ?? obj.text ?? '', 2000).trim();
  if (!text) problems.push('the plan has no objective');
  if (text.length > 0 && text.length < 8) problems.push(`the objective "${text}" is too short to act on`);

  const priority = ['critical', 'high', 'normal', 'low'].includes(obj.priority) ? obj.priority : 'normal';

  const expectedEvidence = strList(obj.expectedEvidence, { max: 10, maxLen: 120 })
    .filter((e) => {
      const ok = EVIDENCE_KINDS.some((k) => e.toLowerCase().includes(k));
      if (!ok) warnings.push(`expected evidence "${e}" names no known evidence kind`);
      return ok;
    });

  /*
   * `expectedEvidence` empty is a WARNING, not an error.
   *
   * It is how the plan says what would prove the objective was met, and a plan
   * without it cannot be checked afterwards. But refusing the plan outright
   * would stall a run over a field models omit constantly -- so the run
   * proceeds and the gap is visible.
   */
  if (expectedEvidence.length === 0) {
    warnings.push('the plan names no expected evidence, so completing it cannot be verified');
  }

  return result({
    text,
    tasks: strList(obj.tasks, { max: 20, maxLen: 400 }),
    priority,
    expectedEvidence,
    constraints: strList(obj.constraints, { max: 15, maxLen: 300 }),
    acceptance: strList(obj.acceptance ?? obj.acceptanceCriteria, { max: 15, maxLen: 300 }),
    rationale: obj.rationale ? str(obj.rationale, 1500) : undefined,
  }, problems, warnings, dropped);
}

/* ========================================================================== *
 * MANAGER: EVALUATION
 * ========================================================================== */

/** `{ scores[], issues[], resolved[], confidence, reasoning }` */
export function validateEvaluation(raw, { evidence = [] } = {}) {
  const warnings = [];
  if (!isObj(raw)) return result(null, ['the evaluation was not a JSON object']);

  const obj = { ...raw };
  const dropped = stripForbidden(obj, 'manager');
  if (dropped.length) warnings.push(`dropped ${dropped.join(', ')} from the evaluation`);

  const scores = validateScores(obj.scores, { evidence });
  warnings.push(...scores.warnings);

  /*
   * An evaluation with NO scores is a fatal problem, unlike a plan with no
   * expected evidence. Evaluation has exactly one job; a response that did not
   * do it is not a partial success, and accepting it would advance the
   * iteration with an empty scorecard that later reads as "nothing improved".
   */
  const problems = scores.value.length === 0 ? ['the evaluation produced no usable scores'] : [];

  return result({
    scores: scores.value,
    openIssues: strList(obj.issues ?? obj.openIssues, { max: 30, maxLen: 400 }),
    resolved: strList(obj.resolved ?? obj.resolvedIssues, { max: 30, maxLen: 400 }),
    reasoning: obj.reasoning ? str(obj.reasoning, 2000) : undefined,
  }, problems, warnings, dropped);
}

/* ========================================================================== *
 * REVIEWER
 * ========================================================================== */

/** `{ assessment, signals[], strategy, recommendedActions[], recommendation }` */
export function validateReview(raw) {
  const warnings = [];
  if (!isObj(raw)) return result(null, ['the review was not a JSON object']);

  const obj = { ...raw };
  const dropped = stripForbidden(obj, 'reviewer');
  if (dropped.length) {
    warnings.push(`the reviewer tried to set ${dropped.join(', ')} — dropped; it advises, it does not act`);
  }

  const RECS = ['continue', 'change-strategy', 'escalate'];
  let recommendation = RECS.includes(obj.recommendation) ? obj.recommendation : null;
  const newDirection = str(obj.strategy ?? obj.newDirection ?? '', 1500).trim();

  /*
   * A recommendation of `change-strategy` with no direction is incoherent, and
   * honouring it would record a strategy change whose content is empty -- the
   * next plan would then be told the strategy changed and not told to what.
   */
  if (recommendation === 'change-strategy' && !newDirection) {
    warnings.push('the reviewer recommended a strategy change but described no new direction — treated as continue');
    recommendation = 'continue';
  }
  if (!recommendation) {
    recommendation = newDirection ? 'change-strategy' : 'continue';
  }

  return result({
    recommendation,
    newDirection: newDirection || undefined,
    assessment: obj.assessment ? str(obj.assessment, 3000) : undefined,
    signals: strList(obj.signals, { max: 20, maxLen: 200 }),
    recommendedActions: strList(obj.recommendedActions ?? obj.actions, { max: 15, maxLen: 400 }),
    rationale: obj.rationale ? str(obj.rationale, 1500) : undefined,
  }, [], warnings, dropped);
}

/* ========================================================================== *
 * DIAGNOSTICS
 * ========================================================================== */

/**
 * A one-line explanation suitable for a reprompt.
 *
 * The recovery contract allows exactly one schema-aware reprompt. That is only
 * worth doing if the model is told what was wrong in terms it can act on, so
 * this returns the problems as instructions rather than as complaints.
 */
export function describeProblems(validation) {
  if (!validation || validation.ok) return '';
  return [
    'Your previous response could not be used:',
    ...validation.problems.map((p) => `- ${p}`),
    '',
    'Reply again with the same content in the required format. Do not apologise or explain; just send the corrected block.',
  ].join('\n');
}
