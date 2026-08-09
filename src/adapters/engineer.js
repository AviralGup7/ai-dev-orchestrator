/**
 * THE ENGINEER ADAPTER — Arena as the execution environment.
 *
 * Sends the orchestration protocol plus the objective, waits for real work to
 * finish, and converts what comes back into typed evidence.
 *
 * THE DISTINCTION §8 DEMANDS
 * --------------------------
 * "Do not return 'it worked' merely because Arena generated text." The adapter
 * reports one of six outcomes, and the difference between them is the
 * difference between a run that can trust its scores and one that cannot:
 *
 *   completed   a report block arrived and parsed
 *   malformed   text arrived, no usable report -- the work may have happened,
 *               but nothing can be measured, so nothing is claimed
 *   timed-out   no reply in the budget
 *   failed      the transport could not deliver or read
 *
 * A malformed reply is NOT silently downgraded to "did nothing". It produces
 * log evidence carrying the raw text, so a human can see what Arena actually
 * said, and zero measured evidence, so no dimension gains a number from it.
 */

import { Adapter, AdapterError } from './base.js';
import { composeFirstPrompt, composeIterationPrompt } from '../core/protocol.js';
import { parseReport, reportToEvidence, crossCheck } from '../core/report.js';
import { parseAll } from '../core/parse.js';
import { redact } from '../core/journal.js';
import { REPORT_FENCE } from '../core/protocol.js';

/** A one-line rendering of what a record actually observed. */
function describeRecord(e) {
  switch (e.kind) {
    case 'test': return `${e.passed} passed, ${e.failed} failed, ${e.skipped} skipped`;
    case 'build': return e.ok ? 'build succeeded' : 'build failed';
    case 'lint': return `${e.errors} errors, ${e.warnings} warnings`;
    case 'coverage': return `${e.linesPct ?? '?'}% lines`;
    case 'diff': return `${e.filesChanged} files changed`;
    default: return String(e.text ?? e.kind).slice(0, 120);
  }
}

export class EngineerAdapter extends Adapter {
  get role() { return 'engineer'; }
  get surface() { return 'engineer'; }

  async execute(ctx) {
    const prompt = ctx.first
      ? composeFirstPrompt({
        mode: ctx.mode,
        prompt: ctx.userPrompt ?? '',
        projectName: ctx.projectName ?? '',
        memory: ctx.memory ?? null,
      })
      : composeIterationPrompt({ memory: ctx.memory ?? null, objective: ctx.objective });

    this.emit('execution-requested', { iteration: ctx.iteration, chars: prompt.length });

    const text = await this.sendWithRetries(prompt, { what: 'execution', iteration: ctx.iteration });

    /*
     * NOT `exchange()`.
     *
     * The engineer's reply is not retried on a schema failure, and that is a
     * deliberate difference from the manager. Re-asking ChatGPT to reformat a
     * plan costs one cheap round trip. Re-asking Arena costs it RUNNING THE
     * WORK AGAIN -- another build, another test suite, possibly another commit
     * -- because the protocol asks it to execute, not to reformat. The right
     * response to a malformed engineering report is to keep the text as
     * evidence and let a human look, not to spend another five minutes of
     * compute hoping for tidier JSON.
     */
    const parsed = parseReport(text);
    const iterationCtx = { source: 'arena', sourceType: 'terminal', iteration: ctx.iteration, phase: 'execute' };

    if (!parsed.ok || !parsed.report) {
      /*
       * SHIP A SAMPLE OF THE TEXT THAT FAILED TO PARSE.
       *
       * This event recorded `chars: 60433` and `chars: 104042` in two real
       * runs and not one character of the actual reply. Both times the parser
       * was wrong -- it required literal backticks that a RENDERED page does
       * not contain -- and both times diagnosing it meant reasoning about what
       * the text probably looked like, with the text itself sitting right
       * there and being dropped.
       *
       * The head and tail, not the middle: a report is bounded by its fence at
       * the top and its closing brace at the bottom, and truncation shows up
       * as a tail that stops mid-token. Bounded at 2000 characters each so a
       * 100k reply cannot overrun the log's size limits, and redacted on the
       * way out like every other captured page text.
       *
       * `fenceSeen` is the one-bit answer to "did the model emit the marker at
       * all, or ignore the protocol?" -- the two failures the old message
       * conflated into one sentence.
       */
      const sample = (t, n) => redact(String(t).slice(0, n));
      this.emit('response-malformed', {
        iteration: ctx.iteration,
        problems: parsed.problems,
        chars: text.length,
        fenceSeen: text.includes(REPORT_FENCE),
        backticksSeen: text.includes('```'),
        head: sample(text, 2000),
        tail: redact(String(text).slice(-2000)),
      });

      /*
       * Fall back to parsing the RAW TEXT for evidence.
       *
       * Arena often does the work correctly and then formats the report badly.
       * The terminal output is usually still in the reply, and a real
       * `1276 passed, 0 failed` is a real observation regardless of whether
       * the JSON around it was well-formed. Refusing to look would discard a
       * measured fact because of a formatting error.
       */
      const salvaged = parseAll(text, iterationCtx);
      return {
        outcome: 'malformed',
        summary: `Arena replied but the report could not be read: ${parsed.problems.join('; ')}`,
        filesChanged: [],
        evidence: salvaged.evidence,
        artifacts: [],
        raw: text.slice(0, 20_000),
        problems: parsed.problems,
      };
    }

    const report = parsed.report;
    const evidence = reportToEvidence(report);

    /*
     * Also parse the raw text, and keep whatever the structured report did not
     * already give us. A model that reports `tests.ran: false` while its own
     * terminal output shows a suite running is contradicting itself, and the
     * terminal is the more reliable witness.
     */
    const fromText = parseAll(text, iterationCtx).evidence
      .filter((e) => e.kind !== 'log' && !evidence.some((x) => x.kind === e.kind));
    for (const e of fromText) {
      this.emit('evidence-recovered', { iteration: ctx.iteration, kind: e.kind });
      evidence.push(e);
    }

    // Attach provenance to evidence that came from the structured report.
    for (const e of evidence) {
      if (!e.provenance) {
        e.provenance = {
          source: 'arena', sourceType: 'report', capturedAt: Date.now(),
          iteration: ctx.iteration ?? null, phase: 'execute',
          parser: 'engineer-report',
          /*
           * The reference names the NUMBERS, not the prose.
           *
           * "partial: Worked on iteration 1" tells a reader nothing about
           * where a testing score came from. The point of provenance is that
           * 94% traces to "1276 passed, 0 failed" -- so the reference has to
           * carry the observation, not the narration.
           */
          rawReference: describeRecord(e),
        };
      }
    }

    const contradictions = crossCheck(report);
    for (const c of contradictions) {
      this.emit('report-contradiction', { iteration: ctx.iteration, severity: c.severity, message: c.message });
    }

    const failedByOwnNumbers = contradictions.some((c) => c.severity === 'error');

    this.emit('execution-completed', {
      iteration: ctx.iteration,
      taskStatus: report.taskStatus,
      files: report.filesModified?.length ?? 0,
      evidence: evidence.map((e) => e.kind),
    });

    return {
      /*
       * `taskStatus: complete` alongside three failing tests is reported as
       * `partial`, not `completed`. The prose is generated to satisfy the
       * request; the numbers are copied from a terminal. When they disagree,
       * the numbers win -- and the contradiction is on the record.
       */
      outcome: failedByOwnNumbers ? 'partial' : 'completed',
      taskStatus: report.taskStatus,
      summary: report.summary ?? '',
      engineeringReport: report.engineeringReport ?? '',
      filesChanged: report.filesModified ?? [],
      evidence,
      artifacts: report.artifacts ?? [],
      knownIssues: report.knownIssues ?? [],
      risks: report.risks ?? [],
      suggestedNextTask: report.suggestedNextTask,
      commit: report.commit ?? null,
      contradictions,
      scores: report.scores,      // exploration only
      roadmap: report.roadmap,    // exploration only
      dropped: parsed.dropped,
      raw: text.slice(0, 20_000),
    };
  }
}

export { AdapterError };
