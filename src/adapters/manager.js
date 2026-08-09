/**
 * THE MANAGER ADAPTER — ChatGPT as project manager.
 *
 * Plans the next objective and evaluates the result. Structurally cannot write
 * code: `schema.js` drops `patch`, `code`, `command` and friends before the
 * response reaches the engine.
 *
 * WHY THE PROMPTS LIVE HERE AND NOT IN protocol.js
 * ------------------------------------------------
 * `protocol.js` composes the ENGINEER's prompt, because that contract is a
 * standing document re-sent every iteration. The manager's prompts are
 * different each time -- a plan request and an evaluation request are not the
 * same shape -- and belong with the code that validates their replies. Keeping
 * the prompt next to its validator is what stops them drifting apart, which is
 * the failure that produces "the model stopped returning that field" bugs.
 */

import { Adapter } from './base.js';
import { validatePlan, validateEvaluation } from '../core/schema.js';
import { metadataBlock } from '../core/protocol.js';
import { explainEvidence } from '../core/parse.js';
import { DIMENSION_KEYS } from '../core/types.js';

const FENCE = 'ORCHESTRATOR-PLAN';
const EVAL_FENCE = 'ORCHESTRATOR-EVALUATION';

/** Pull the last fenced block, tolerating chattiness and a dropped marker. */
export function extractJson(text, fence) {
  /*
   * THE SAME HARDENING THE ENGINEER PATH ALREADY HAS.
   *
   * This function is a SECOND, weaker copy of `report.js`'s extractor. Every
   * repair made there had to be made here too, and was not:
   *
   *   - per-line backticks       fixed in report.js at 25a94a1, missing here
   *   - bare fence, no backticks fixed in report.js at 217121a, missing here
   *
   * Run 202608091410 is the bill for that. ChatGPT returned its evaluation
   * with every line wrapped in inline code, the last-resort branch below
   * sliced from the first `{` to the last `}` and produced
   *
   *   {`\n`  "scores": [],`\n`  "issues": []`\n`}
   *
   * which fails at "position 2 (line 1 column 3)" -- exactly what the log
   * says. The manager repeated itself, the new identical-reply guard fired
   * correctly, and the run ended on a formatting detail the engineer path
   * had already learned to handle.
   *
   * Unwrapping here rather than importing report.js's helper keeps the
   * adapter free of a dependency on the engineer's report format, which is a
   * different contract. The duplication of the RULE is deliberate; the
   * duplication of the BUG was not.
   */
  const src = unwrapLineBackticks(String(text ?? ''));
  const tagged = new RegExp('```[ \\t]*' + fence + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'gi');
  let m, last = null;
  while ((m = tagged.exec(src)) !== null) last = m[1];
  if (last) return last.trim();

  const generic = /```[a-z]*[ \t]*\r?\n(\{[\s\S]*?\})\s*```/gi;
  while ((m = generic.exec(src)) !== null) last = m[1];
  if (last) return last.trim();

  /*
   * Last resort: a bare object in the text. Models sometimes answer with JSON
   * and no fence at all. Anchored to the FIRST { and the LAST } so a brace in
   * prose does not truncate it.
   */
  const a = src.indexOf('{');
  const b = src.lastIndexOf('}');
  return a !== -1 && b > a ? src.slice(a, b + 1) : null;
}

/**
 * Undo per-line inline-code wrapping: `  "a": 1,`  ->    "a": 1,
 *
 * Conservative by construction. A line must open AND close with exactly one
 * backtick and hold at least one character between them, so:
 *   - a markdown fence (``` or ```json) is untouched -- it opens with two
 *     more backticks, and eating it would destroy the block this protects;
 *   - a backtick INSIDE a string value survives, because prose fields quote
 *     shell commands and silently corrupting one is worse than failing.
 */
function unwrapLineBackticks(text) {
  if (!text.includes('`')) return text;
  return text.replace(/^([ \t]*)`([^`].*?)`[ \t]*$/gm, '$1$2');
}

function parseJson(text, fence) {
  const raw = extractJson(text, fence);
  if (!raw) return { error: 'no JSON block found in the response' };
  try {
    return { value: JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')) };
  } catch (err) {
    return { error: `the JSON block did not parse: ${err.message}` };
  }
}

export class ManagerAdapter extends Adapter {
  get role() { return 'manager'; }
  get surface() { return 'manager'; }

  /* ----------------------------------------------------------- planning - */

  async plan(ctx) {
    const prompt = this.planPrompt(ctx);
    const { value } = await this.exchange({
      prompt,
      what: 'plan',
      iteration: ctx.iteration,
      validate: (text) => {
        const j = parseJson(text, FENCE);
        if (j.error) return { ok: false, value: null, problems: [j.error], warnings: [], dropped: [] };
        return validatePlan(j.value);
      },
    });
    return value;
  }

  planPrompt(ctx) {
    const meta = metadataBlock(ctx.memory ?? null);
    const stuck = ctx.flags?.stagnation
      ? `\n\nThe orchestrator has detected a loop (${(ctx.flags.signals || []).map((s) => s.kind ?? s).join(', ')}). ` +
        'Repeating the previous approach will not help. Choose something different in kind, not just in wording.'
      : '';

    const strategy = ctx.baseline?.roadmap?.length
      ? `\n\nThe exploration roadmap, in priority order:\n${ctx.baseline.roadmap.slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : '';

    return `## YOU ARE THE PROJECT MANAGER

Decide the single next objective for an autonomous engineer. You do not write
code — a separate system executes, and a third reviews strategy. Your objective
is the only instruction it will receive.

${meta}${strategy}${stuck}

### What makes a good objective here

- ONE thing. An objective with "and" in it usually becomes two half-done things.
- Achievable in one iteration by an engineer with repository access.
- Stated so that its completion is checkable from evidence — test counts, a
  build result, a diff — not from an opinion.
- Aimed at whatever most limits the project right now. If a dimension rests on
  no evidence, producing that evidence is often worth more than new features.

### Required response format

End your message with exactly this block:

\`\`\`${FENCE}
{
  objective: string        one sentence, imperative
  tasks: string[]          concrete steps, optional
  priority: "critical" | "high" | "normal" | "low"
  expectedEvidence: string[]   which of test/build/lint/coverage/diff would prove it
  constraints: string[]    what the engineer must not do
  acceptance: string[]     how we will know it is done
  rationale: string        why this, now
}
\`\`\`

Do not include code, patches or shell commands. They will be discarded.`;
  }

  /* --------------------------------------------------------- evaluating - */

  async evaluate(ctx) {
    const evidence = ctx.evidence ?? [];
    const prompt = this.evaluatePrompt(ctx);
    const { value } = await this.exchange({
      prompt,
      what: 'evaluation',
      iteration: ctx.iteration,
      validate: (text) => {
        const j = parseJson(text, EVAL_FENCE);
        if (j.error) return { ok: false, value: null, problems: [j.error], warnings: [], dropped: [] };
        return validateEvaluation(j.value, { evidence });
      },
    });
    return value;
  }

  evaluatePrompt(ctx) {
    const evidence = ctx.evidence ?? [];

    /*
     * The evidence is presented ALREADY PARSED, with provenance.
     *
     * Pasting raw terminal output invites the model to re-read the numbers and
     * get them wrong -- and its reading would then compete with the parser's.
     * There is one authority for what the tests said, and it is not the model.
     */
    const evidenceBlock = evidence.length
      ? evidence.map((e) => `- ${explainEvidence(e)}`).join('\n')
      : '- none was captured this iteration';

    return `## YOU ARE THE QUALITY REVIEWER

Score the project against the evidence below. The evidence has already been
parsed from the engineer's terminal output; these numbers are authoritative.

### Objective this iteration
${ctx.objective?.text ?? '(none recorded)'}

### What the engineer reported
${(ctx.summary || '(no summary)').slice(0, 2000)}

### Evidence captured
${evidenceBlock}

### How to score

Score each of: ${DIMENSION_KEYS.join(', ')}.

For every score state a confidence:

- \`measured\`  — you are reading it off the evidence above. Say which item.
- \`inferred\`  — reasoned from partial evidence. Say from what.
- \`asserted\`  — your impression, with nothing behind it.

**Marking an impression as measured is worse than not scoring it.** Asserted
scores are excluded from the completion criteria precisely so uncertainty stays
visible; a false \`measured\` defeats that. If no tests ran, testing is not
measured. If you cannot see the running interface, uiux is asserted. That is
expected.

Do not inflate. A score that rises without evidence behind it is the specific
failure this system exists to prevent.

### Required response format

\`\`\`${EVAL_FENCE}
{
  scores: [{ dimension, score, confidence, basis, reasoning }]
  issues: string[]       what is still wrong
  resolved: string[]     previously known issues now fixed
  reasoning: string      the overall picture in a sentence or two
}
\`\`\``;
  }
}
