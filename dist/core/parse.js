/**
 * TERMINAL OUTPUT -> TYPED EVIDENCE.
 *
 * The single most load-bearing conversion in the system. Every score that
 * claims to be `measured` traces back to a number this file read off some
 * tool's output. Get it wrong and the anti-flattery machinery upstream is
 * protecting a lie.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * Prose never becomes measured evidence. "The tests seem to be passing" is a
 * sentence; `1276 passing` is an observation. The parsers only ever match
 * shapes that a TOOL produces -- counts, exit codes, percentages -- and
 * everything else is kept as `log` evidence, which is the weakest kind and
 * cannot on its own justify a measured score.
 *
 * WHY REGEXES AND NOT A REAL PARSER
 * ---------------------------------
 * The input is the concatenated stdout of arbitrary tools, interleaved,
 * ANSI-coloured, possibly truncated mid-line by a scraper. There is no grammar
 * to parse. The honest design is a set of narrow patterns for formats that
 * actually exist, each of which either matches confidently or does not fire.
 *
 * A pattern that ALMOST matches must not fire. A wrong number is far worse
 * than a missing one: a missing number leaves the dimension unmeasured and
 * visible; a wrong number is authoritative and invisible.
 *
 * PROVENANCE
 * Every record carries where it came from, which pattern produced it, and the
 * exact text it matched, so a score can be traced back:
 *   82% -> testing 94 -> "1276 passed, 0 failed" -> iteration 7, execute phase
 *
 * PURE.
 */

import { makeEvidence } from './types.js';

/** Strip ANSI colour codes and carriage-return progress rewrites. */
export function clean(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

/**
 * @typedef {object} Provenance
 * @property {string} source        e.g. 'arena-terminal'
 * @property {string} sourceType    'terminal' | 'file' | 'scrape' | 'report'
 * @property {number} capturedAt
 * @property {number|null} iteration
 * @property {string|null} phase
 * @property {string} parser        which pattern fired
 * @property {string} rawReference  the exact text matched
 */

function provenance(ctx, parser, raw) {
  return {
    source: ctx.source || 'unknown',
    sourceType: ctx.sourceType || 'terminal',
    capturedAt: ctx.capturedAt ?? Date.now(),
    iteration: ctx.iteration ?? null,
    phase: ctx.phase ?? null,
    parser,
    rawReference: String(raw ?? '').slice(0, 240),
  };
}

const int = (v) => {
  const n = parseInt(String(v).replace(/[,_]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

/* ========================================================================== *
 * TESTS
 * ========================================================================== */

/**
 * Test-count patterns, most specific first.
 *
 * Order matters enormously. Jest prints
 *   `Tests: 3 failed, 2 skipped, 1276 passed, 1281 total`
 * and a naive `(\d+) passed` would match it and report 1276 passed with zero
 * failures -- the exact catastrophic direction of error, since it turns a
 * failing suite into a perfect score. The composite patterns must be tried
 * before the single-count ones.
 */
const TEST_PATTERNS = [
  {
    name: 'jest-summary',
    // Tests: 3 failed, 2 skipped, 1276 passed, 1281 total
    re: /tests?:\s*(?:(\d[\d,_]*)\s*failed,?\s*)?(?:(\d[\d,_]*)\s*skipped,?\s*)?(?:(\d[\d,_]*)\s*todo,?\s*)?(\d[\d,_]*)\s*passed/i,
    take: (m) => ({ failed: int(m[1]), skipped: int(m[2]) + int(m[3]), passed: int(m[4]) }),
  },
  {
    name: 'node-test-tap',
    // # pass 247 / # fail 0 / # skipped 3 — matched as a block
    re: /#\s*pass\s+(\d[\d,_]*)[\s\S]{0,200}?#\s*fail\s+(\d[\d,_]*)/i,
    take: (m, text) => {
      const sk = /#\s*skipped\s+(\d[\d,_]*)/i.exec(text);
      return { passed: int(m[1]), failed: int(m[2]), skipped: sk ? int(sk[1]) : 0 };
    },
  },
  {
    name: 'mocha',
    /*
     * ANCHORED TO THE START OF A LINE. THIS PATTERN FABRICATED A `measured`
     * SCORE OUT OF AN ENGLISH SENTENCE.
     *
     * It used to be a bare /(\d+)\s+passing/i, which matches prose. In the
     * evaluation of 2026-08-09 it fired on:
     *
     *   "Journal and its render() method exist and carry 7 passing tests,
     *    but grep finds no production import."
     *
     * and reported "7 passed, 0 failed — read by mocha from terminal". The
     * reviewer then scored `testing` as MEASURED on the strength of it. A
     * false `measured` is the exact failure this project exists to prevent:
     * asserted scores are excluded from the completion criteria so that
     * uncertainty stays visible, and manufacturing one defeats that.
     *
     * Real mocha prints the count at the start of a line, indented by its
     * reporter and followed by nothing but whitespace or a duration:
     *
     *     1276 passing (41s)
     *
     * The line anchor plus the end-of-line guard is what separates that from
     * a clause in the middle of a sentence.
     */
    re: /^[ \t]*(\d[\d,_]*)\s+passing\b[ \t]*(?:\([^)]*\))?[ \t]*$/im,
    take: (m, text) => ({
      passed: int(m[1]),
      failed: int((/^[ \t]*(\d[\d,_]*)\s+failing\b/im.exec(text) || [])[1]),
      skipped: int((/^[ \t]*(\d[\d,_]*)\s+pending\b/im.exec(text) || [])[1]),
    }),
  },
  {
    name: 'pytest',
    // ===== 3 failed, 1276 passed, 2 skipped in 41.20s =====
    re: /=+\s*(?:(\d[\d,_]*)\s+failed,?\s*)?(\d[\d,_]*)\s+passed(?:,?\s*(\d[\d,_]*)\s+skipped)?/i,
    take: (m) => ({ failed: int(m[1]), passed: int(m[2]), skipped: int(m[3]) }),
  },
  {
    name: 'go-test',
    re: /ok\s+\S+\s+[\d.]+s(?:\s|$)/i,
    take: () => null, // presence only; go test gives no counts without -json
  },
  {
    name: 'generic-passed-failed',
    // 1276 passed, 0 failed
    re: /(\d[\d,_]*)\s*passed[,\s]+(\d[\d,_]*)\s*failed/i,
    take: (m, text) => ({
      passed: int(m[1]),
      failed: int(m[2]),
      skipped: int((/(\d[\d,_]*)\s*skipped/i.exec(text) || [])[1]),
    }),
  },
];

/**
 * Phrases that must NEVER produce test evidence.
 *
 * A model narrating its work writes "all 1276 tests should pass now" or "the
 * tests are passing". Those contain a number and the word passing, which is
 * exactly enough to fool a pattern. The number is real but the observation is
 * imagined -- nothing was run.
 */
const HEDGES = /\b(should|seem|seems|appear|appears|expect|expected|likely|probably|presumably|I believe|looks like|assume|assuming|would pass|will pass)\b/i;

/**
 * Extract test evidence.
 *
 * @returns {object|null} null when nothing was observed. NOT a zero.
 */
export function parseTests(text, ctx = {}) {
  const src = clean(text);
  if (!src.trim()) return null;

  for (const p of TEST_PATTERNS) {
    const m = p.re.exec(src);
    if (!m) continue;

    /*
     * Reject a match embedded in hedged prose.
     *
     * Checked on the LINE, not the whole output: a run whose summary line is
     * clean should not be discarded because a model wrote "this should fix it"
     * three paragraphs earlier.
     */
    const line = lineAround(src, m.index);
    if (HEDGES.test(line)) continue;

    const counts = p.take(m, src);
    if (!counts) continue;
    if (counts.passed + counts.failed + counts.skipped === 0) continue;

    return makeEvidence('test', {
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      total: counts.passed + counts.failed + counts.skipped,
      provenance: provenance(ctx, p.name, line),
    });
  }
  return null;
}

function lineAround(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

/* ========================================================================== *
 * BUILD
 * ========================================================================== */

const BUILD_FAIL = [
  { name: 'exit-code', re: /(?:exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?|exit status\s+)([1-9]\d*)/i },
  { name: 'build-failed', re: /\b(?:build|compilation|compile)\s+failed\b/i },
  { name: 'tsc-errors', re: /found\s+([1-9]\d*)\s+errors?/i },
  { name: 'webpack-errors', re: /\berrors?:\s*([1-9]\d*)/i },
  { name: 'make-error', re: /^make(?:\[\d+\])?:\s*\*\*\*/im },
];

const BUILD_OK = [
  { name: 'exit-zero', re: /exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?0\b/i },
  { name: 'build-succeeded', re: /\b(?:build|compil\w+)\s+(?:succeeded|successful|complete[d]?|passed)\b/i },
  { name: 'tsc-clean', re: /found\s+0\s+errors/i },
  { name: 'webpack-ok', re: /\bcompiled\s+successfully\b/i },
];

export function parseBuild(text, ctx = {}) {
  const src = clean(text);
  if (!src.trim()) return null;

  /*
   * FAILURE IS CHECKED FIRST, and that asymmetry is deliberate.
   *
   * Real build output frequently contains both -- a successful compile step
   * followed by a failing bundle step, or "Compiled successfully" followed by
   * a non-zero exit. If success won, a partially failing build would be
   * recorded as green, and `reconcile()` upstream caps every dimension at 50
   * on a failing build precisely because that state matters. Erring toward
   * "failed" costs a pessimistic score; erring toward "ok" costs the guarantee.
   */
  for (const p of BUILD_FAIL) {
    const m = p.re.exec(src);
    if (m && !HEDGES.test(lineAround(src, m.index))) {
      return makeEvidence('build', {
        ok: false,
        errors: m[1] ? int(m[1]) : undefined,
        durationMs: parseDuration(src),
        provenance: provenance(ctx, p.name, lineAround(src, m.index)),
      });
    }
  }
  for (const p of BUILD_OK) {
    const m = p.re.exec(src);
    if (m && !HEDGES.test(lineAround(src, m.index))) {
      return makeEvidence('build', {
        ok: true,
        durationMs: parseDuration(src),
        provenance: provenance(ctx, p.name, lineAround(src, m.index)),
      });
    }
  }
  return null;
}

function parseDuration(text) {
  const m = /(?:done|built|finished|completed|took)\s+in\s+([\d.]+)\s*(ms|s|m)\b/i.exec(text)
    || /\bin\s+([\d.]+)\s*(ms|s|m)\b/i.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Math.round(m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : v * 60000);
}

/* ========================================================================== *
 * LINT
 * ========================================================================== */

export function parseLint(text, ctx = {}) {
  const src = clean(text);

  // ESLint: "✖ 12 problems (3 errors, 9 warnings)"
  const eslint = /(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i.exec(src);
  if (eslint) {
    return makeEvidence('lint', {
      errors: int(eslint[2]),
      warnings: int(eslint[3]),
      provenance: provenance(ctx, 'eslint-summary', lineAround(src, eslint.index)),
    });
  }

  // "0 errors, 0 warnings" / "3 errors and 9 warnings"
  const generic = /(\d+)\s+errors?\s*(?:,|and)\s*(\d+)\s+warnings?/i.exec(src);
  if (generic && !HEDGES.test(lineAround(src, generic.index))) {
    return makeEvidence('lint', {
      errors: int(generic[1]),
      warnings: int(generic[2]),
      provenance: provenance(ctx, 'generic-lint', lineAround(src, generic.index)),
    });
  }
  return null;
}

/* ========================================================================== *
 * COVERAGE
 * ========================================================================== */

export function parseCoverage(text, ctx = {}) {
  const src = clean(text);

  // Istanbul table: "All files | 81.42 | 68.1 | 74.2 | 80.9 |"
  const istanbul = /all\s+files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i.exec(src);
  if (istanbul) {
    return makeEvidence('coverage', {
      statementsPct: parseFloat(istanbul[1]),
      branchesPct: parseFloat(istanbul[2]),
      functionsPct: parseFloat(istanbul[3]),
      linesPct: parseFloat(istanbul[4]),
      provenance: provenance(ctx, 'istanbul-table', lineAround(src, istanbul.index)),
    });
  }

  // Labelled percentages anywhere: "Lines: 81.4%  Branches: 68%"
  const grab = (label) => {
    const m = new RegExp(`${label}\\s*[:=]\\s*([\\d.]+)\\s*%`, 'i').exec(src);
    return m ? parseFloat(m[1]) : undefined;
  };
  const lines = grab('lines');
  const branches = grab('branch(?:es)?');
  const functions = grab('functions?');
  const statements = grab('statements?');

  if ([lines, branches, functions, statements].some((v) => v !== undefined)) {
    return makeEvidence('coverage', {
      linesPct: lines, branchesPct: branches, functionsPct: functions, statementsPct: statements,
      provenance: provenance(ctx, 'labelled-percentages', 'coverage percentages'),
    });
  }

  // Go: "coverage: 81.4% of statements"
  const go = /coverage:\s*([\d.]+)%\s*of\s*statements/i.exec(src);
  if (go) {
    return makeEvidence('coverage', {
      statementsPct: parseFloat(go[1]),
      linesPct: parseFloat(go[1]),
      provenance: provenance(ctx, 'go-coverage', lineAround(src, go.index)),
    });
  }
  return null;
}

/* ========================================================================== *
 * DIFF
 * ========================================================================== */

export function parseDiff(text, ctx = {}) {
  const src = clean(text);

  // git diff --stat: "7 files changed, 210 insertions(+), 12 deletions(-)"
  const stat = /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/i.exec(src);
  if (stat) {
    return makeEvidence('diff', {
      filesChanged: int(stat[1]),
      insertions: stat[2] ? int(stat[2]) : null,
      deletions: stat[3] ? int(stat[3]) : null,
      provenance: provenance(ctx, 'git-diff-stat', lineAround(src, stat.index)),
    });
  }

  /*
   * Fall back to counting +/- lines in a unified diff.
   *
   * `+++`/`---` headers are excluded, or every changed file would add two
   * phantom lines -- which is a systematic overcount, not noise, and would
   * make `trivial-diffs` in the loop detector stop firing for small changes.
   */
  if (/^diff --git |^@@ /m.test(src)) {
    const lines = src.split('\n');
    const insertions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const files = new Set(
      lines.filter((l) => l.startsWith('diff --git'))
        .map((l) => (l.split(/\s+/)[2] || '').replace(/^a\//, '')),
    );
    if (files.size || insertions || deletions) {
      return makeEvidence('diff', {
        filesChanged: files.size,
        insertions,
        deletions,
        files: [...files].slice(0, 50),
        provenance: provenance(ctx, 'unified-diff', `${files.size} files in a unified diff`),
      });
    }
  }
  return null;
}

/* ========================================================================== *
 * GIT COMMIT
 * ========================================================================== */

/**
 * Commit SHAs, as `log` evidence.
 *
 * Deliberately not its own evidence kind: `EVIDENCE_KINDS` is a closed set the
 * scoring module reasons over, and adding to it would mean every consumer must
 * handle a kind that contributes to no dimension. A commit is corroboration
 * that work was durable, not a measurement of quality.
 */
export function parseCommit(text, ctx = {}) {
  const src = clean(text);
  const m = /\[[\w./-]+\s+([0-9a-f]{7,40})\]|commit\s+([0-9a-f]{7,40})/i.exec(src);
  if (!m) return null;
  const sha = m[1] || m[2];
  return makeEvidence('log', {
    text: `commit ${sha}`,
    sha,
    provenance: provenance(ctx, 'git-commit', lineAround(src, m.index)),
  });
}

/* ========================================================================== *
 * EVERYTHING
 * ========================================================================== */

/**
 * Run every parser over a blob of terminal output.
 *
 * @returns {{evidence: object[], unparsed: boolean}}
 */
export function parseAll(text, ctx = {}) {
  const src = clean(text);
  const evidence = [];
  for (const fn of [parseTests, parseBuild, parseLint, parseCoverage, parseDiff, parseCommit]) {
    const e = fn(src, ctx);
    if (e) evidence.push(e);
  }

  /*
   * Output that yielded nothing structured is kept as `log` evidence.
   *
   * Not discarded: it is the raw material a human needs when the scores look
   * wrong, and `evidence-stasis` in the loop detector deliberately EXCLUDES
   * log evidence from its fingerprint, so keeping it cannot corrupt detection.
   */
  if (evidence.length === 0 && src.trim()) {
    evidence.push(makeEvidence('log', {
      text: src.slice(0, 4000),
      provenance: provenance(ctx, 'unparsed', src.slice(0, 240)),
    }));
    return { evidence, unparsed: true };
  }
  return { evidence, unparsed: false };
}

/**
 * Human explanation of where a score came from.
 *
 * The §13 requirement: `82% -> Testing 94 -> 1276 passed / 0 failed ->
 * captured during iteration 7`. Never an unexplained number.
 */
export function explainEvidence(e) {
  if (!e) return 'no evidence';
  const p = e.provenance;
  const what = {
    test: () => `${e.passed} passed, ${e.failed} failed, ${e.skipped} skipped`,
    build: () => (e.ok ? 'build succeeded' : 'build FAILED'),
    lint: () => `${e.errors} lint errors, ${e.warnings} warnings`,
    coverage: () => `${e.linesPct ?? '—'}% lines, ${e.branchesPct ?? '—'}% branches`,
    diff: () => `${e.filesChanged} file(s) changed, +${e.insertions ?? '?'}/-${e.deletions ?? '?'}`,
    log: () => String(e.text ?? '').slice(0, 80),
  }[e.kind];

  const desc = what ? what() : e.kind;
  if (!p) return desc;
  return `${desc} — read by \`${p.parser}\` from ${p.sourceType}` +
    (p.iteration != null ? ` during iteration ${p.iteration}` : '') +
    (p.rawReference ? `: "${p.rawReference.slice(0, 100)}"` : '');
}
