/**
 * THE ORCHESTRATION PROTOCOL.
 *
 * "The user should only write the project description. The extension is
 * responsible for wrapping it in the orchestration protocol."
 *
 * This composes every prompt sent to Arena: a standing contract about response
 * shape, the project metadata the user must never assemble by hand, and the
 * actual objective.
 *
 * WHY A DELIMITED BLOCK AND NOT PROSE
 * -----------------------------------
 * The response has to be machine-readable, and the reliable failure of asking
 * a model for JSON is that it returns JSON wrapped in an apology, or JSON with
 * a trailing comment, or prose containing JSON. Asking for a FENCED BLOCK with
 * a specific marker gives the parser an unambiguous anchor and lets the model
 * be as chatty as it likes around it — which it will be regardless, so the
 * format should tolerate it rather than forbid it.
 *
 * WHAT THIS FILE MAY NOT DO
 * The protocol asks Arena for a `suggestedNextTask`. It is deliberately
 * described in the prompt as ADVICE. docs/SPEC.md enforces role separation by
 * response schema — Arena "should NOT decide project direction" — so the
 * parser drops any field that looks like a decision, and this text is written
 * so the model is not encouraged to produce one. A prompt saying "do not
 * decide" is a request; the parser is the guarantee.
 *
 * PURE.
 */

import { DIMENSION_KEYS } from './types.js';

/** Bumped when the response contract changes, so old logs stay interpretable. */
export const PROTOCOL_VERSION = 1;

/** The fence the parser looks for. Distinctive enough not to occur by chance. */
export const REPORT_FENCE = 'ORCHESTRATOR-REPORT';

/**
 * The fields Arena must return, with the reason each exists.
 *
 * Kept as data rather than baked into the template string so the parser, the
 * validator and the prompt cannot drift apart — one list, three consumers.
 */
export const REPORT_FIELDS = /** @type {const} */ ([
  { key: 'taskStatus', type: 'enum', values: ['complete', 'partial', 'blocked', 'failed'], required: true },
  { key: 'summary', type: 'string', required: true },
  { key: 'filesModified', type: 'string[]', required: true },
  { key: 'build', type: 'object', shape: '{ ran: boolean, ok: boolean, command: string, output: string }', required: true },
  { key: 'tests', type: 'object', shape: '{ ran: boolean, passed: number, failed: number, skipped: number, command: string }', required: true },
  { key: 'lint', type: 'object', shape: '{ ran: boolean, errors: number, warnings: number }', required: false },
  { key: 'coverage', type: 'object', shape: '{ ran: boolean, linesPct: number, branchesPct: number }', required: false },
  { key: 'commit', type: 'object', shape: '{ made: boolean, sha: string, message: string }', required: true },
  { key: 'diff', type: 'object', shape: '{ filesChanged: number, insertions: number, deletions: number }', required: false },
  { key: 'knownIssues', type: 'string[]', required: true },
  { key: 'risks', type: 'string[]', required: true },
  { key: 'suggestedNextTask', type: 'string', required: false },
  { key: 'artifacts', type: 'string[]', required: false },
  { key: 'engineeringReport', type: 'string', required: true },
]);

/* ========================================================================== *
 * THE STANDING CONTRACT
 * ========================================================================== */

/**
 * The instruction block prepended to every Arena prompt.
 *
 * Sent EVERY time, not once at the start. A contract stated in message one is
 * outside the context window by message forty, and the observed failure is
 * gradual: the model keeps the shape for a while, then starts omitting fields
 * it judges uninteresting. Re-stating it costs tokens and buys a parser that
 * keeps working.
 */
export function protocolBlock() {
  const fields = REPORT_FIELDS.map((f) => {
    const t = f.shape || (f.type === 'enum' ? f.values.map((v) => `"${v}"`).join(' | ') : f.type);
    return `  ${f.key}: ${t}${f.required ? '' : '   (optional)'}`;
  }).join('\n');

  return `## ORCHESTRATION PROTOCOL v${PROTOCOL_VERSION} — read this first

You are the ENGINEER in an orchestrated workflow. A separate system decides
what to work on and evaluates the result. Your job is to execute the objective
below and report what actually happened.

### Rules

1. Work only on the objective given. If you believe something else is more
   important, put it in \`suggestedNextTask\` — do not do it instead.
2. Run the build and the test suite. Report the real numbers, including
   failures. A report of success that the evidence does not support is the
   single most damaging thing you can produce here, because the scores are
   computed from these numbers.
3. If you could not do something, say so in \`taskStatus\` and \`knownIssues\`.
   "blocked" and "partial" are useful answers. An invented success is not.
4. Commit your work. Report the SHA.
5. Do not ask questions and wait — there is no human in this loop to answer.
   If a decision is genuinely required, set \`taskStatus: "blocked"\` and
   explain what you need in \`knownIssues\`.

### Required response format

Answer normally if you like, then end your message with EXACTLY this block:

\`\`\`${REPORT_FENCE}
{
${fields}
}
\`\`\`

Notes on the fields:
- \`ran: false\` is the honest answer when a build or suite was not executed.
  Do not report zeros as if they were a passing run — a suite that did not run
  and a suite with no failures are completely different facts.
- \`filesModified\` lists repository-relative paths you actually changed.
- \`engineeringReport\` is prose: what you changed, why, what you rejected,
  and what a reviewer should look at first.
- \`suggestedNextTask\` is advice only. The orchestrator decides direction.`;
}

/* ========================================================================== *
 * PROJECT METADATA
 * ========================================================================== */

/**
 * "The user should never manually assemble project context."
 *
 * Everything here is read from memory. Sizes are bounded because this is
 * prepended to every prompt and the failure mode of an unbounded context block
 * is not an error — it is the model silently losing the earliest part of the
 * message, which is where the protocol lives.
 */
export function metadataBlock(memory, { maxIssues = 8, maxDecisions = 3 } = {}) {
  if (!memory) return '';

  const last = memory.history?.[memory.history.length - 1];
  const scores = memory.scores?.[memory.scores.length - 1]?.scores || [];
  const measured = scores.filter((s) => s.confidence === 'measured');

  const lines = [];
  lines.push('## PROJECT STATE (assembled automatically — do not ask the user for this)');
  lines.push('');
  lines.push(`- Workflow mode: ${memory.mode || 'unknown'}`);
  lines.push(`- Iteration: ${(memory.iteration ?? 0) + 1}`);
  lines.push(`- Scope: ${memory.scope || '(not yet established)'}`);

  if (last) {
    lines.push(`- Previous iteration (${last.n}): ${clip(last.objective?.text || '—', 160)}`);
    lines.push(`  - Outcome: ${clip(last.summary || 'no summary recorded', 240)}`);
    if (last.filesChanged?.length) {
      lines.push(`  - Files touched: ${last.filesChanged.slice(0, 10).join(', ')}`);
    }
  } else {
    lines.push('- Previous iteration: none — this is the first.');
  }

  if (scores.length) {
    /*
     * SCORES ARE SENT WITH THEIR CONFIDENCE, ALWAYS.
     *
     * Sending "testing: 90" alone invites the model to treat it as established
     * fact and reason from it. Sending "testing: 90 (measured)" versus
     * "uiux: 60 (asserted)" tells it which numbers are real — and the asserted
     * ones are exactly the ones it should try to replace with evidence.
     */
    lines.push(`- Current scores (${measured.length}/${scores.length} measured):`);
    for (const s of scores) {
      lines.push(`  - ${s.dimension}: ${s.score}% (${s.confidence})`);
    }
    lines.push(`- Overall health: ${last?.overall ?? '—'}%`);
  } else {
    lines.push('- Current scores: none yet — nothing has been evaluated.');
  }

  if (memory.openIssues?.length) {
    lines.push(`- Known issues (${memory.openIssues.length}):`);
    for (const i of memory.openIssues.slice(0, maxIssues)) lines.push(`  - ${clip(i, 160)}`);
    if (memory.openIssues.length > maxIssues) {
      lines.push(`  - …and ${memory.openIssues.length - maxIssues} more`);
    }
  }

  /*
   * WHAT HAS ALREADY BEEN TRIED AND FAILED.
   *
   * Placed immediately after known issues and before strategy history,
   * because it is the single most decision-relevant fact the manager can
   * have: an objective that already failed once should not be proposed again
   * without a stated change of approach.
   *
   * This block never rendered before -- `failedAttempts` was collected
   * nowhere and printed nowhere, so every plan was made as if no attempt had
   * ever failed.
   */
  if (memory.failedAttempts?.length) {
    lines.push(`- Already tried and FAILED (${memory.failedAttempts.length}) — do not simply repeat these:`);
    for (const f of memory.failedAttempts.slice(-maxIssues)) {
      const what = clip(f.objective || 'an unnamed objective', 140);
      lines.push(`  - iteration ${f.iteration} (${f.taskStatus}): ${what}`);
      if (f.why) lines.push(`    why it failed: ${clip(f.why, 160)}`);
    }
    lines.push('  If you propose something similar, say explicitly what is different this time.');
  }

  const strategies = (memory.decisions || []).filter((d) => d.kind === 'strategy');
  if (strategies.length) {
    lines.push('- Strategy changes so far:');
    for (const d of strategies.slice(-maxDecisions)) {
      lines.push(`  - iteration ${d.iteration}: ${clip(d.text, 200)}`);
    }
  }

  if (memory.flags?.stagnation) {
    lines.push(`- ⚠ The orchestrator has detected a loop: ${(memory.flags.signals || []).map((s) => s.kind ?? s).join(', ')}.`);
    lines.push('  Repeating the previous approach is unlikely to help.');
  }

  return lines.join('\n');
}

/*
 * Named `clip`, not `truncate`: detect.js already declares a module-scoped
 * `truncate`, and the demo bundler concatenates every core module into one
 * scope where two declarations are a hard SyntaxError. Same class of collision
 * as `describe` last session -- ES modules scope per file, so both names
 * coexist happily right up until they do not. Caught by the bundle's
 * `node --check`, which exists because of the previous one.
 */
function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/* ========================================================================== *
 * MODE-SPECIFIC OPENINGS
 * ========================================================================== */

/**
 * The exploration brief for Self Exploration mode.
 *
 * Every item from the specification's list, ordered so that understanding
 * precedes judgement — an assessment of "technical debt" written before the
 * architecture is understood is a guess dressed as a finding.
 *
 * It explicitly forbids changing code. Exploration that quietly starts fixing
 * things produces a diff nobody asked for, evaluated against an objective that
 * was "look around".
 */
export function explorationBrief() {
  return `## FIRST ITERATION: EXPLORATION ONLY — DO NOT CHANGE ANY CODE

Before any improvement work begins, build an accurate picture of this project.
Change nothing. Commit nothing. Read, run read-only commands, and report.

Cover, in this order:

1. Purpose — what is this project for, and who uses it?
2. Repository structure — the layout, and what lives where.
3. Documentation — what exists, and what it claims.
4. Technologies — languages, frameworks, build tooling, package manager.
5. Dependencies — direct dependencies and anything notably outdated or risky.
6. Architecture — the main components and how they communicate.
7. Implementation state — what is actually built versus scaffolded.
8. Completed features.
9. Missing or partial features.
10. Technical debt — with file references, not impressions.
11. Bugs — anything you can demonstrate, ideally by running something.
12. Testing — is there a suite, does it run, does it pass, what is covered?
13. UI/UX — only if there is an interface you can actually inspect.
14. Performance — only if you can measure something.
15. Security — dependency advisories, secrets in the repo, obvious exposure.

Then produce:

- A comprehensive understanding report (this goes in \`engineeringReport\`).
- A PRIORITISED improvement roadmap, highest impact first, with your reasoning.
- Initial scores for: ${DIMENSION_KEYS.join(', ')}.

### About those scores — this part matters

For each score, state the EVIDENCE and mark it as one of:

- \`measured\`  — you ran something and read the number off the output.
- \`inferred\`  — reasoned from partial evidence, and say from what.
- \`asserted\`  — your impression, with nothing behind it.

Marking an impression as \`measured\` is worse than not scoring it at all: the
orchestrator excludes asserted scores from its completion criteria precisely so
that uncertainty is visible, and a false \`measured\` defeats that. If you did
not run the tests, \`testing\` is not measured. If you cannot see the running
interface, \`uiux\` is asserted. That is expected and fine.

Report scores inside the JSON block as:
\`scores: [{ dimension, score, confidence, basis }]\`
where \`basis\` is a short string naming what you actually observed.`;
}

/** New-project opening: standards first, then implementation. */
function newProjectBrief() {
  return `## FIRST ITERATION: ESTABLISH THE BASELINE

This is a new project in an existing workspace. Before feature work:

1. Confirm what is already in the workspace — do not assume it is empty, and
   do not delete anything you did not create.
2. Establish the engineering standards this project will use: language and
   version, package manager, test runner, lint/format config, directory layout.
   Write them down in the repository.
3. Initialise the repository if it is not already a git repository, and make an
   initial commit.
4. Set up the test suite infrastructure, with at least one real test that can
   genuinely fail. A test that cannot fail is worse than no test — it reports
   green forever and the score computed from it is meaningless.
5. Then begin implementation of the description below.

Report honestly if you only got partway. \`taskStatus: "partial"\` with real
numbers is far more useful than a claim of completion.`;
}

/** Existing-project opening: synchronise before continuing. */
function existingProjectBrief() {
  return `## FIRST ITERATION: SYNCHRONISE WITH THE CURRENT STATE

This workspace and repository already exist, and this conversation already has
history. Do not start over and do not re-scaffold.

1. Confirm the current state: branch, working tree cleanliness, last commit.
2. Run the build and the test suite as they stand, and report the real numbers
   as the baseline — including failures that were already there.
3. Summarise where the project actually is, as opposed to where the earlier
   conversation may have claimed it was.
4. Then continue with the objective below.

If the objective conflicts with what you find in the repository, report the
conflict in \`knownIssues\` rather than silently picking one.`;
}

/* ========================================================================== *
 * COMPOSITION
 * ========================================================================== */

/**
 * Build the complete first prompt for a mode.
 *
 * @param {object} args
 * @param {'new'|'existing'|'explore'} args.mode
 * @param {string} [args.prompt]      the user's description
 * @param {string} [args.projectName]
 * @param {object} [args.memory]
 */
export function composeFirstPrompt({ mode, prompt = '', projectName = '', memory = null }) {
  const parts = [protocolBlock()];
  const meta = metadataBlock(memory);
  if (meta) parts.push(meta);

  if (mode === 'explore') {
    parts.push(explorationBrief());
    /*
     * No user objective section at all in explore mode.
     *
     * Appending an empty "## OBJECTIVE" heading would invite the model to fill
     * the silence with one of its own — and an objective the user never wrote,
     * pursued autonomously for fifty iterations, is the specific outcome this
     * project's non-goals forbid.
     */
  } else if (mode === 'new') {
    parts.push(newProjectBrief());
    parts.push(`## THE PROJECT${projectName ? ` — ${projectName}` : ''}\n\n${prompt.trim()}`);
  } else {
    parts.push(existingProjectBrief());
    const text = prompt.trim();
    parts.push(
      text
        ? `## OBJECTIVE UPDATE${projectName ? ` — ${projectName}` : ''}\n\n${text}`
        : '## OBJECTIVE\n\nNo new objective was given. Continue the work already in progress in this conversation, and state clearly what you have chosen to continue with and why.',
    );
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Build a continuation prompt for iterations 2..n.
 *
 * Same protocol, same metadata, different objective — the point being that the
 * engineer's contract never changes, only the task.
 */
export function composeIterationPrompt({ memory, objective }) {
  const parts = [protocolBlock()];
  const meta = metadataBlock(memory);
  if (meta) parts.push(meta);

  const constraints = objective?.constraints?.length
    ? `\n\nConstraints:\n${objective.constraints.map((c) => `- ${c}`).join('\n')}`
    : '';
  const criteria = objective?.acceptance?.length
    ? `\n\nAcceptance criteria:\n${objective.acceptance.map((c) => `- ${c}`).join('\n')}`
    : '';

  parts.push(`## OBJECTIVE FOR THIS ITERATION\n\n${objective?.text || '(none given)'}${constraints}${criteria}`);
  return parts.join('\n\n---\n\n');
}
