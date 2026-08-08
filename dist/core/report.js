/**
 * PARSING ARENA'S REPORT.
 *
 * This is where prose becomes evidence, and it is the most security-relevant
 * file in the project — not in the XSS sense, but in the sense that everything
 * downstream trusts what comes out of here. A parser that is too forgiving
 * turns a model's optimism into a `measured` score.
 *
 * THREE JOBS, IN ORDER
 * --------------------
 *   1. Find the block. Tolerantly — models wrap JSON in apologies.
 *   2. Reject what must not be honoured. Arena may not decide direction, so
 *      any field that looks like a decision is DROPPED, not warned about.
 *   3. Convert only what was actually run into typed evidence.
 *
 * THE `ran: false` DISTINCTION IS THE WHOLE POINT
 * A suite that did not run and a suite with no failures both look like
 * `failed: 0`. Treating them the same would let "I didn't run the tests"
 * become a perfect testing score — the exact flattery failure the scoring
 * module exists to prevent, arriving through a side door.
 *
 * PURE.
 */

import { makeEvidence } from './types.js';
import { REPORT_FENCE, REPORT_FIELDS } from './protocol.js';

/**
 * Fields Arena is structurally forbidden from setting.
 *
 * docs/SPEC.md: role separation is enforced "by response schema rather than by
 * prompt" — *a prompt saying 'do not write code' is a request; a response
 * validator that rejects a `patch` field is a guarantee.* The engineer's
 * mirror of that rule is direction: it may suggest, it may not decide.
 *
 * `suggestedNextTask` is deliberately NOT here. It is advice, kept and shown
 * to the manager as input. The banned names are the ones that would be acted
 * on automatically if some future code path read them without thinking.
 */
const FORBIDDEN_FIELDS = [
  'nextObjective',
  'objective',
  'nextIteration',
  'plan',
  'strategy',
  'newDirection',
  'recommendation',
  'stop',
  'shouldStop',
  'complete',
  'projectComplete',
  'overall',
  'overallScore',
  'projectHealth',
];

/**
 * Extract the fenced block.
 *
 * Handles: the fence with or without a language hint, extra prose either side,
 * and multiple blocks (the LAST wins — a model that corrects itself puts the
 * correction last).
 */
export function extractBlock(text, fence = REPORT_FENCE) {
  const src = String(text ?? '');
  const re = new RegExp('```[ \\t]*' + fence + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'gi');
  let match = null;
  let last = null;
  while ((match = re.exec(src)) !== null) last = match[1];
  if (last !== null) return last.trim();

  /*
   * FALLBACK: a bare fenced block containing an object with our fields.
   *
   * Models drop the custom fence marker with some regularity — usually
   * substituting ```json. Refusing to parse that would fail an iteration over
   * a formatting detail while the actual report sits right there. The fallback
   * is narrow: it must parse AND contain a field we asked for, so an unrelated
   * code sample in the reply is not mistaken for the report.
   */
  const generic = /```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi;
  const required = REPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
  let fb = null;
  while ((match = generic.exec(src)) !== null) {
    const body = match[1].trim();
    if (!body.startsWith('{')) continue;
    try {
      const obj = JSON.parse(relaxed(body));
      if (required.some((k) => k in obj)) fb = body;
    } catch {
      /* not our block */
    }
  }
  if (fb !== null) return fb;

  /*
   * FALLBACK 2: THE TEXT WAS READ FROM A RENDERED PAGE, SO THERE ARE NO
   * BACKTICKS AT ALL.
   *
   * Both branches above require literal ``` characters. That is correct for
   * markdown SOURCE and wrong for everything this project actually reads: the
   * transport takes `element.innerText`, and by then the browser has turned
   * ```ORCHESTRATOR-REPORT into a <pre><code> whose text contains the fence
   * NAME and the JSON but not one backtick. The chrome around it ("Copy",
   * "Edit", a language label) is rendered as text too.
   *
   * This is not hypothetical. Run 202608081932: the engineer worked for 378
   * seconds, returned 60,433 characters, and the whole thing was thrown away
   * as `response-malformed` -- "the engineer either ignored the protocol or
   * the response was truncated" -- when it had done neither. The iteration was
   * lost to a markdown artefact.
   *
   * Strategy: find the fence NAME, then take the first balanced JSON object
   * after it. Brace matching rather than a regex, because the report contains
   * nested objects and prose full of braces, and a greedy or lazy match gets
   * one of those two cases wrong.
   */
  const at = src.lastIndexOf(fence);
  if (at !== -1) {
    const body = firstJsonObject(src, at + fence.length);
    if (body) {
      try {
        const obj = JSON.parse(relaxed(body));
        if (required.some((k) => k in obj)) return body;
      } catch {
        /*
         * Returned anyway when it LOOKS like our report.
         *
         * `parseReport` reports precise per-field problems and can re-prompt
         * with them attached; returning null here throws all of that away and
         * says only "no block found", which is the least actionable message
         * available and -- as the run above showed -- an actively misleading
         * one.
         */
        if (required.some((k) => body.includes(`"${k}"`) || body.includes(`${k}:`))) return body;
      }
    }
  }

  return null;
}

/**
 * The first brace-balanced `{...}` at or after `from`.
 *
 * String-aware: a `}` inside a JSON string, or an escaped quote, must not end
 * the object. `engineeringReport` is free prose and routinely contains both.
 *
 * @returns {string|null}
 */
function firstJsonObject(src, from) {
  const start = src.indexOf('{', from);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;   // never closed: truncated, which is a real and different fault
}

/**
 * Repair the two things models reliably get wrong about JSON.
 *
 * Deliberately minimal. A parser that rewrites its input aggressively will
 * eventually "fix" a malformed report into a plausible wrong one, and a wrong
 * report that parses is far more dangerous than one that fails loudly.
 */
function relaxed(json) {
  return String(json)
    .replace(/,\s*([}\]])/g, '$1')      // trailing commas
    .replace(/^\uFEFF/, '');            // BOM
}

/**
 * Parse a raw Arena response.
 *
 * @returns {{ok:boolean, report:object|null, problems:string[], dropped:string[], raw:string|null}}
 */
export function parseReport(text) {
  const problems = [];
  const dropped = [];

  const raw = extractBlock(text);
  if (!raw) {
    return {
      ok: false,
      report: null,
      raw: null,
      dropped,
      problems: [
        `No ${REPORT_FENCE} block found in the response. The engineer either ignored the protocol or the response was truncated.`,
      ],
    };
  }

  let obj;
  try {
    obj = JSON.parse(relaxed(raw));
  } catch (err) {
    return {
      ok: false,
      report: null,
      raw,
      dropped,
      problems: [`The report block is not valid JSON: ${err.message}`],
    };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, report: null, raw, dropped, problems: ['The report block is not a JSON object.'] };
  }

  /* -- 1. strip anything that would let the engineer steer ---------------- */
  for (const key of FORBIDDEN_FIELDS) {
    if (key in obj) {
      delete obj[key];
      dropped.push(key);
    }
  }

  /* -- 2. required fields -------------------------------------------------- */
  const report = {};
  for (const f of REPORT_FIELDS) {
    const v = obj[f.key];
    if (v === undefined || v === null) {
      if (f.required) problems.push(`Missing required field "${f.key}".`);
      continue;
    }
    report[f.key] = coerce(f, v, problems);
  }

  if (report.taskStatus && !['complete', 'partial', 'blocked', 'failed'].includes(report.taskStatus)) {
    problems.push(`taskStatus "${report.taskStatus}" is not one of complete/partial/blocked/failed.`);
    delete report.taskStatus;
  }

  /*
   * `scores` is accepted only from exploration, and only in the shape the
   * scoring module already validates. It is NOT in REPORT_FIELDS because a
   * normal iteration must not carry scores from the engineer — evaluation is
   * the manager's job, and an engineer that scores its own work is grading its
   * own homework.
   */
  if (Array.isArray(obj.scores)) {
    report.scores = obj.scores
      .filter((s) => s && typeof s === 'object' && typeof s.dimension === 'string')
      .map((s) => ({
        dimension: String(s.dimension),
        score: Number(s.score),
        confidence: ['measured', 'inferred', 'asserted'].includes(s.confidence) ? s.confidence : 'asserted',
        basis: s.basis ? [{ kind: 'log', note: String(s.basis).slice(0, 300) }] : [],
      }));
  }
  if (typeof obj.roadmap === 'string' || Array.isArray(obj.roadmap)) {
    report.roadmap = Array.isArray(obj.roadmap) ? obj.roadmap.map(String) : [String(obj.roadmap)];
  }

  return { ok: problems.length === 0, report, problems, dropped, raw };
}

function coerce(field, v, problems) {
  switch (field.type) {
    case 'string':
    case 'enum':
      return String(v);
    case 'string[]':
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === 'string') return v.trim() ? [v] : [];
      problems.push(`Field "${field.key}" should be a list.`);
      return [];
    case 'object':
      return v && typeof v === 'object' ? v : {};
    default:
      return v;
  }
}

/* ========================================================================== *
 * REPORT -> EVIDENCE
 * ========================================================================== */

/**
 * Convert a parsed report into typed evidence.
 *
 * ONLY what actually ran becomes evidence. `ran: false` produces nothing —
 * not a zero, not an empty record. The distinction matters because
 * `scoreTesting` treats "no test evidence" as a score of 0 and an unmeasured
 * dimension, whereas a `{passed: 0, failed: 0}` record would look like a
 * flawless empty suite.
 */
export function reportToEvidence(report) {
  const out = [];
  if (!report) return out;

  const t = report.tests;
  if (t && t.ran !== false && (num(t.passed) + num(t.failed) + num(t.skipped)) > 0) {
    out.push(makeEvidence('test', {
      passed: num(t.passed),
      failed: num(t.failed),
      skipped: num(t.skipped),
      command: t.command ? String(t.command) : undefined,
    }));
  }

  const b = report.build;
  if (b && b.ran !== false && typeof b.ok === 'boolean') {
    out.push(makeEvidence('build', { ok: b.ok, command: b.command ? String(b.command) : undefined }));
  }

  const l = report.lint;
  if (l && l.ran !== false && (Number.isFinite(Number(l.errors)) || Number.isFinite(Number(l.warnings)))) {
    out.push(makeEvidence('lint', { errors: num(l.errors), warnings: num(l.warnings) }));
  }

  const c = report.coverage;
  if (c && c.ran !== false && Number.isFinite(Number(c.linesPct))) {
    out.push(makeEvidence('coverage', { linesPct: num(c.linesPct), branchesPct: num(c.branchesPct) }));
  }

  const d = report.diff;
  if (d && Number.isFinite(Number(d.filesChanged))) {
    out.push(makeEvidence('diff', {
      filesChanged: num(d.filesChanged),
      insertions: num(d.insertions),
      deletions: num(d.deletions),
    }));
  } else if (Array.isArray(report.filesModified) && report.filesModified.length) {
    /*
     * Derive a diff record from the file list when the engineer omitted the
     * counts. `file-churn` in the loop detector needs filesChanged to work at
     * all, and losing that signal because a field was optional would silently
     * disable a third of stagnation detection.
     */
    out.push(makeEvidence('diff', { filesChanged: report.filesModified.length, insertions: null, deletions: null }));
  }

  return out;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ========================================================================== *
 * CROSS-CHECKING
 * ========================================================================== */

/**
 * Compare the engineer's narrative against its own numbers.
 *
 * THE SPECIFIC FAILURE THIS CATCHES: `taskStatus: "complete"` alongside
 * `tests.failed: 3`. Both fields come from the same model in the same message,
 * and models are strongly biased toward reporting success — the prose is
 * generated to satisfy the request, the numbers are copied from a terminal.
 * When they disagree, the numbers are right.
 *
 * Returns findings rather than mutating anything: the caller decides whether a
 * contradiction downgrades the status or merely gets logged. Silently
 * rewriting the report would hide the fact that the engineer is unreliable,
 * which is itself information the reviewer should have.
 */
export function crossCheck(report) {
  const findings = [];
  if (!report) return findings;

  const t = report.tests || {};
  const b = report.build || {};

  if (report.taskStatus === 'complete' && t.ran !== false && num(t.failed) > 0) {
    findings.push({
      severity: 'error',
      field: 'taskStatus',
      message: `reported "complete" with ${num(t.failed)} failing test(s)`,
    });
  }
  if (report.taskStatus === 'complete' && b.ran !== false && b.ok === false) {
    findings.push({ severity: 'error', field: 'taskStatus', message: 'reported "complete" with a failing build' });
  }
  if (report.commit?.made === true && !report.commit?.sha) {
    findings.push({ severity: 'warning', field: 'commit', message: 'claims a commit was made but gave no SHA' });
  }
  if (Array.isArray(report.filesModified) && report.filesModified.length > 0 && report.commit?.made === false) {
    findings.push({
      severity: 'warning',
      field: 'commit',
      message: `${report.filesModified.length} file(s) changed but nothing was committed — the work is not durable`,
    });
  }
  if (t.ran === false) {
    findings.push({ severity: 'warning', field: 'tests', message: 'the test suite was not run, so testing cannot be measured' });
  }
  if (report.taskStatus === 'complete' && (!Array.isArray(report.filesModified) || report.filesModified.length === 0)) {
    findings.push({ severity: 'warning', field: 'filesModified', message: 'reported "complete" without changing any files' });
  }

  return findings;
}
