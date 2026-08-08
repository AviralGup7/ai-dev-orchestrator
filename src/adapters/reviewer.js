/**
 * THE REVIEWER ADAPTER — DeepSeek as strategic reviewer.
 *
 * Runs every Nth iteration, or early when the detector finds a loop. Looks at
 * the trajectory rather than the last result, and says whether the current
 * approach is still worth pursuing.
 *
 * WHY IT IS SHOWN THE TRAJECTORY AND NOT THE CODE
 * -----------------------------------------------
 * The reviewer's value is the thing neither of the other two can see: the
 * manager is invested in its own plan and the engineer only sees this
 * iteration. Giving it the diff would invite it to review the code, which is
 * the manager's job, and it would stop noticing that six iterations have
 * touched the same file with no score movement.
 *
 * `schema.js` drops `patch`, `scores`, `stop` and `projectComplete`, so the
 * boundary is structural rather than a request in the prompt.
 */

import { Adapter } from './base.js';
import { validateReview } from '../core/schema.js';

const FENCE = 'ORCHESTRATOR-REVIEW';

function parseJson(text) {
  const src = String(text ?? '');
  const tagged = new RegExp('```[ \\t]*' + FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'gi');
  let m, last = null;
  while ((m = tagged.exec(src)) !== null) last = m[1];
  if (!last) {
    const generic = /```[a-z]*[ \t]*\r?\n(\{[\s\S]*?\})\s*```/gi;
    while ((m = generic.exec(src)) !== null) last = m[1];
  }
  if (!last) {
    const a = src.indexOf('{'); const b = src.lastIndexOf('}');
    if (a !== -1 && b > a) last = src.slice(a, b + 1);
  }
  if (!last) return { error: 'no JSON block found in the review' };
  try {
    return { value: JSON.parse(last.replace(/,\s*([}\]])/g, '$1')) };
  } catch (err) {
    return { error: `the review JSON did not parse: ${err.message}` };
  }
}

export class ReviewerAdapter extends Adapter {
  get role() { return 'reviewer'; }
  get surface() { return 'reviewer'; }

  async review(ctx) {
    const { value } = await this.exchange({
      prompt: this.reviewPrompt(ctx),
      what: 'review',
      iteration: ctx.iteration,
      validate: (text) => {
        const j = parseJson(text);
        if (j.error) return { ok: false, value: null, problems: [j.error], warnings: [], dropped: [] };
        return validateReview(j.value);
      },
    });
    return value;
  }

  reviewPrompt(ctx) {
    const history = (ctx.history?.recent ?? []).map((r) => {
      const ev = (r.evidence || []).map((e) => e.kind).join(', ') || 'none';
      return `- iteration ${r.n}: "${r.objective?.text ?? '?'}" → ${r.overall ?? '?'}% ` +
        `(${(r.filesChanged || []).length} files, evidence: ${ev})`;
    }).join('\n') || '- no completed iterations yet';

    const older = (ctx.history?.summary ?? []).slice(-10)
      .map((s) => `- iteration ${s.n}: "${s.objective ?? '?'}" → ${s.overall ?? '?'}%`).join('\n');

    const scores = (ctx.scores ?? []).map((s) => `- ${s.dimension}: ${s.score}% (${s.confidence})`).join('\n')
      || '- nothing scored yet';

    const signals = (ctx.signals ?? []).map((s) => `- ${s.kind ?? s}: ${s.detail ?? ''}`).join('\n')
      || '- none';

    return `## YOU ARE THE STRATEGIC REVIEWER

You are not writing code and you are not scoring this project. You are deciding
whether the current approach is still the right one.

### Recent iterations
${history}

${older ? `### Earlier\n${older}\n` : ''}
### Current scores
${scores}

### Loop signals the orchestrator detected locally
${signals}

### Open issues
${(ctx.openIssues ?? []).slice(0, 10).map((i) => `- ${i}`).join('\n') || '- none recorded'}

### What to look for

- Is the project actually improving, or only changing?
- Are iterations circling the same files or the same bug?
- Is a neglected area (tests, security, documentation) now the real constraint?
- Is the score rising because work happened, or because scores drifted upward
  without evidence behind them?

Recommend \`change-strategy\` only if you can name what should be done instead.
A change with no direction is worse than continuing, because the next planner
is told the strategy changed and not told to what.

### Required response format

\`\`\`${FENCE}
{
  assessment: string             what is actually happening, plainly
  signals: string[]              patterns you see in the trajectory
  recommendation: "continue" | "change-strategy" | "escalate"
  strategy: string               the new direction, if you are recommending one
  recommendedActions: string[]   concrete next steps, highest impact first
  rationale: string
}
\`\`\`

Do not include code, patches, or scores. They will be discarded.`;
  }
}
