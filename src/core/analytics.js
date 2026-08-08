/**
 * ANALYTICS — derived from the record, never invented.
 *
 * §23 asks for a dozen metrics. The temptation with a metrics module is to
 * return a number for every field because a dashboard with gaps looks
 * unfinished. That temptation is exactly what this project exists to resist:
 * a fabricated regression rate is worse than an empty one, because the empty
 * one prompts a question and the fabricated one ends it.
 *
 * SO EVERY METRIC IS A VALUE *AND* A BASIS
 *
 *   { value, basis: 'measured' | 'estimated' | 'unknown', n, note }
 *
 * `unknown` is a first-class answer. Token efficiency and cost, which the
 * specification lists, are `unknown` here and will stay that way while the
 * transport is a browser tab -- the page does not report token counts, and
 * inferring them from character counts would be a guess wearing a unit.
 *
 * PURE.
 */

const UNKNOWN = (note) => ({ value: null, basis: 'unknown', n: 0, note });
const measured = (value, n, note = '') => ({ value, basis: 'measured', n, note });
const estimated = (value, n, note = '') => ({ value, basis: 'estimated', n, note });

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v, p = 1) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);

/**
 * @param {object[]} iterations
 * @param {object} [opts] `{ run, events }`
 */
export function analyse(iterations = [], { run = null, events = [] } = {}) {
  const done = iterations.filter((i) => i.finishedAt);
  const scored = done.filter((i) => Number.isFinite(i.overall));

  /* ---- progress ------------------------------------------------------- */

  const deltas = [];
  for (let i = 1; i < scored.length; i++) deltas.push(scored[i].overall - scored[i - 1].overall);

  const improvement = deltas.length
    ? measured(round(mean(deltas)), deltas.length, 'mean change in overall score per iteration')
    : UNKNOWN('fewer than two scored iterations');

  /*
   * The trend is computed by least squares over the whole run rather than by
   * comparing first and last, because a single anomalous iteration at either
   * end would otherwise define the entire trajectory -- and the anomalous
   * iteration is usually the first, where the baseline scores everything low.
   */
  const trend = scored.length >= 3
    ? measured(round(slope(scored.map((i, x) => [x, i.overall]))), scored.length, 'least-squares slope of overall score')
    : UNKNOWN('needs at least three scored iterations');

  /* ---- timing --------------------------------------------------------- */

  const durations = done
    .filter((i) => i.startedAt && i.finishedAt)
    .map((i) => i.finishedAt - i.startedAt);

  const iterationMs = durations.length
    ? measured(Math.round(mean(durations)), durations.length, 'wall time per completed iteration')
    : UNKNOWN('no completed iterations');

  const waits = events.filter((e) => e.type === 'response-received' && Number.isFinite(e.durationMs));
  const latency = waits.length
    ? measured(Math.round(mean(waits.map((e) => e.durationMs))), waits.length, 'mean AI response time')
    : UNKNOWN('no timed responses recorded');

  const latencyByActor = {};
  for (const actor of ['manager', 'engineer', 'reviewer']) {
    const xs = waits.filter((e) => e.actor === actor).map((e) => e.durationMs);
    latencyByActor[actor] = xs.length ? measured(Math.round(mean(xs)), xs.length) : UNKNOWN('no responses');
  }

  /* ---- reliability ---------------------------------------------------- */

  const attempted = iterations.length;
  const failed = iterations.filter((i) => i.error).length;
  const successRate = attempted
    ? measured(round((done.length / attempted) * 100), attempted, 'completed / attempted iterations')
    : UNKNOWN('no iterations');

  const retries = events.filter((e) => e.type === 'step-retried' || e.type === 'recovery-attempt').length;
  const retryRate = attempted
    ? measured(round(retries / attempted, 2), attempted, 'retries per iteration')
    : UNKNOWN('no iterations');

  /* ---- testing -------------------------------------------------------- */

  const testEvidence = done
    .map((i) => ({ n: i.n, e: (i.evidence || []).find((x) => x.kind === 'test') }))
    .filter((x) => x.e);

  const testGrowth = testEvidence.length >= 2
    ? measured(
      testEvidence.at(-1).e.total - testEvidence[0].e.total,
      testEvidence.length,
      `total tests went ${testEvidence[0].e.total} → ${testEvidence.at(-1).e.total}`,
    )
    : UNKNOWN('needs test evidence from at least two iterations');

  const covEvidence = done
    .map((i) => (i.evidence || []).find((x) => x.kind === 'coverage'))
    .filter(Boolean);
  const coverageGrowth = covEvidence.length >= 2 && covEvidence[0].linesPct != null
    ? measured(round(covEvidence.at(-1).linesPct - covEvidence[0].linesPct), covEvidence.length, 'line coverage change')
    : UNKNOWN('needs coverage evidence from at least two iterations');

  /*
   * REGRESSION: a suite that had zero failures and then had some.
   *
   * Only counted between iterations that BOTH produced test evidence.
   * Comparing an iteration that ran tests against one that did not would
   * report a regression every time somebody skipped the suite, which is a
   * different problem and would drown the real signal.
   */
  let regressions = 0;
  let recoveries = 0;
  for (let i = 1; i < testEvidence.length; i++) {
    const prev = testEvidence[i - 1].e;
    const cur = testEvidence[i].e;
    if (prev.failed === 0 && cur.failed > 0) regressions++;
    if (prev.failed > 0 && cur.failed === 0) recoveries++;
  }
  const regressionRate = testEvidence.length >= 2
    ? measured(round((regressions / (testEvidence.length - 1)) * 100), testEvidence.length - 1,
      `${regressions} regression(s) across ${testEvidence.length - 1} comparable pairs`)
    : UNKNOWN('needs test evidence from at least two iterations');

  /* ---- discovery ------------------------------------------------------ */

  const issueCounts = done.map((i) => (i.knownIssues || []).length);
  const discovered = done.reduce((sum, i, idx) => {
    const prev = idx > 0 ? new Set(done[idx - 1].knownIssues || []) : new Set();
    return sum + (i.knownIssues || []).filter((x) => !prev.has(x)).length;
  }, 0);
  const bugDiscoveryRate = done.length
    ? estimated(round(discovered / done.length, 2), done.length,
      'new issues named per iteration — the engineer reports these, so it is a report of a report')
    : UNKNOWN('no completed iterations');

  /* ---- stagnation ----------------------------------------------------- */

  const stagnating = done.filter((i) => (i.signals || []).length >= 2).length;
  const stagnationFrequency = done.length
    ? measured(round((stagnating / done.length) * 100), done.length, 'iterations where 2+ loop signals fired')
    : UNKNOWN('no completed iterations');

  /* ---- evidence quality ----------------------------------------------- */

  const last = scored.at(-1);
  const evidencedShare = last?.scores?.length
    ? measured(
      round((last.scores.filter((s) => s.confidence !== 'asserted').length / last.scores.length) * 100),
      last.scores.length,
      'share of dimensions resting on evidence rather than opinion',
    )
    : UNKNOWN('nothing scored yet');

  return {
    improvement,
    trend,
    iterationMs,
    latency,
    latencyByActor,
    successRate,
    retryRate,
    testGrowth,
    coverageGrowth,
    regressionRate,
    recoveries: measured(recoveries, testEvidence.length),
    bugDiscoveryRate,
    stagnationFrequency,
    evidencedShare,

    /*
     * Explicitly unavailable, and named so the UI shows the gap rather than a
     * plausible zero. Both need token accounting the browser transport cannot
     * see; inferring them from character counts would be a guess wearing a
     * unit, which is the failure mode this whole module is designed against.
     */
    tokenEfficiency: UNKNOWN('the browser transport cannot observe token counts'),
    cost: UNKNOWN('no pricing information is available through a browser tab'),

    totals: {
      iterationsAttempted: attempted,
      iterationsCompleted: done.length,
      iterationsFailed: failed,
      activeMs: run?.activeMs ?? null,
      issuesOpen: issueCounts.at(-1) ?? 0,
    },
  };
}

/** Least-squares slope. Returns null for degenerate input. */
function slope(points) {
  const n = points.length;
  if (n < 2) return null;
  const sx = points.reduce((a, [x]) => a + x, 0);
  const sy = points.reduce((a, [, y]) => a + y, 0);
  const sxy = points.reduce((a, [x, y]) => a + x * y, 0);
  const sxx = points.reduce((a, [x]) => a + x * x, 0);
  const denom = n * sxx - sx * sx;
  return denom === 0 ? null : (n * sxy - sx * sy) / denom;
}

/** Render for the dashboard: value plus how much it can be trusted. */
export function formatMetric(m) {
  if (!m || m.basis === 'unknown') return { text: '—', title: m?.note ?? 'not available', basis: 'unknown' };
  const text = typeof m.value === 'number' ? String(m.value) : String(m.value ?? '—');
  return { text, title: m.note || '', basis: m.basis, n: m.n };
}
