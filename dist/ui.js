/**
 * THE VIEW LAYER — rendering only.
 *
 * Every function here takes state and returns an HTML string. None of them
 * decide anything: "what step is this?" is answered by `status.js`, "may I
 * press Stop?" by `controls.js`, "what happened?" by `logger.js`.
 *
 * WHY THAT SEPARATION IS ENFORCED RATHER THAN INTENDED
 * ----------------------------------------------------
 * The moment a panel computes its own summary line, there are two answers to
 * "what is it doing" and the one on screen wins. That is how a UI ends up
 * displaying "Waiting for Arena" for a run that crashed ten minutes ago. So
 * the rendering functions are pure string builders over data they did not
 * produce, and they are unit-tested without a browser.
 *
 * Escaping is applied to every interpolated value. Log entries contain AI
 * output, filenames and error text — all attacker-adjacent, all rendered.
 */

/** Everything user-supplied goes through this. No exceptions. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_COLOR = {
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
  pending: '#58a6ff',
};

const SOURCE_BADGE = {
  user: ['You', '#8957e5'],
  extension: ['EXT', '#6e7681'],
  chatgpt: ['GPT', '#10a37f'],
  arena: ['ARENA', '#f78166'],
  deepseek: ['DEEP', '#4d6bfe'],
  system: ['SYS', '#484f58'],
};

const clock = (at) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

/* ========================================================================== *
 * LIVE STATUS PANEL
 * ========================================================================== */

export function renderStatus(s) {
  const dot = s.status === 'running' ? 'live' : s.status === 'blocked' ? 'bad' : 'idle';

  /*
   * Health is rendered with its evidence fraction ALWAYS, and greyed when
   * nothing is measured. A bare "82%" in a large font is the flattery the
   * scoring module spends its whole design preventing; undoing that in the UI
   * would make the safeguard cosmetic.
   */
  const health = s.health == null
    ? '<span class="muted">not yet scored</span>'
    : `<span class="big ${s.measuredDimensions === 0 ? 'unmeasured' : ''}">${s.health}%</span>
       <span class="muted small">${s.measuredDimensions}/${s.totalDimensions} dimensions measured</span>`;

  return `
    <div class="status">
      <div class="row">
        <span class="dot ${dot}"></span>
        <div class="grow">
          <div class="label">Current step</div>
          <div class="step">${esc(s.step)}</div>
          ${s.why ? `<div class="why">${esc(s.why)}</div>` : ''}
        </div>
        ${s.stepElapsed ? `<div class="timer" title="time in this step">${esc(s.stepElapsed)}</div>` : ''}
      </div>

      <div class="grid">
        <div><div class="label">Current AI</div><div>${s.ai ? esc(s.ai.toUpperCase()) : '<span class="muted">none</span>'}</div></div>
        <div><div class="label">Iteration</div><div>${esc(s.iterationLabel)}</div></div>
        <div><div class="label">Elapsed</div><div>${esc(s.elapsed)}</div></div>
        <div><div class="label">Project health</div><div>${health}</div></div>
      </div>

      <div class="next"><span class="label">Next</span> ${esc(s.next)}</div>
      ${s.stagnating ? '<div class="warn">⟳ Loop detected — a strategy review has been pulled forward.</div>' : ''}
      ${s.blocked ? `<div class="err">⛔ ${esc(s.blocked.detail)}</div>` : ''}
    </div>`;
}

/* ========================================================================== *
 * WORKFLOW
 * ========================================================================== */

export function renderWorkflow(stages) {
  return `<div class="flow">${stages
    .map(
      (s) => `<div class="stage ${s.state}">
        <span class="marker">${s.state === 'done' ? '✓' : s.state === 'active' ? '▶' : '○'}</span>
        <span>${esc(s.label)}</span>
      </div>`,
    )
    .join('<div class="arrow">↓</div>')}</div>`;
}

/* ========================================================================== *
 * ACTIVITY LOG
 * ========================================================================== */

/**
 * @param {object[]} events   already filtered
 * @param {number} notShown   events the bounded view is not displaying
 */
export function renderLog(events, notShown = 0) {
  if (events.length === 0) {
    return '<div class="empty">No events match the current filter.</div>';
  }

  /*
   * The count of hidden events is rendered as a BANNER, not a footnote.
   *
   * "The log must never silently discard events" is honoured by the durable
   * sink, but the panel still shows a window onto it. Saying so plainly — with
   * the export button right there — is the difference between a bounded view
   * and a lie.
   */
  const banner = notShown > 0
    ? `<div class="truncated">${notShown} earlier event${notShown === 1 ? '' : 's'} not shown in this view — all of them are in the export.</div>`
    : '';

  const rows = events
    .slice()
    .reverse()
    .map((e) => {
      const [badge, colour] = SOURCE_BADGE[e.source] || ['?', '#6e7681'];
      const dur = Number.isFinite(e.durationMs) ? `<span class="dur">${fmtMs(e.durationMs)}</span>` : '';
      const spin = e.status === 'pending' ? '<span class="spin">◍</span> ' : '';
      /*
       * A surface scan renders as readable markdown, not as its raw JSON.
       *
       * The whole point of the capture is that a person or an AI reads it and
       * understands the page. `JSON.stringify` of four hundred nodes is
       * technically the same information and practically unreadable, which
       * would make the feature look like noise and get it switched off.
       */
      const extra = e.type === 'surface-scan' && e.data?.capture
        ? `<details class="data"><summary>page capture — ${esc(e.data.capture.surface)}</summary><pre>${esc(renderCaptureText(e.data))}</pre></details>`
        : e.data && Object.keys(e.data).length
          ? `<details class="data"><summary>details</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>`
          : '';
      return `<div class="entry ${e.status}">
        <div class="entry-head">
          <span class="time">${clock(e.at)}</span>
          <span class="badge" style="background:${colour}">${badge}</span>
          <span class="type" style="color:${STATUS_COLOR[e.status]}">${spin}${esc(e.label)}</span>
          ${e.iteration != null ? `<span class="iter">i${e.iteration}</span>` : ''}
          ${dur}
        </div>
        ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}
        <div class="evid" title="event id — quote this in a bug report">${esc(e.id || '')}</div>
        ${extra}
      </div>`;
    })
    .join('');

  return banner + rows;
}

/**
 * Capture + diff as text. Imported lazily via the argument rather than at the
 * top of the file so `ui.js` keeps its one job: turning data into strings.
 */
function renderCaptureText(data) {
  const parts = [];
  if (data.becauseOf) parts.push(`Captured because: ${data.becauseOf}\n`);
  if (data.diff && !data.diff.unchanged) {
    parts.push('CHANGED SINCE THE LAST CAPTURE OF THIS SURFACE:');
    for (const s of data.diff.newSignals || []) parts.push(`  + page now says: ${s}`);
    for (const s of data.diff.changed || []) parts.push(`  ~ ${s}`);
    for (const s of data.diff.appeared || []) parts.push(`  + appeared: ${s}`);
    for (const s of data.diff.vanished || []) parts.push(`  - vanished: ${s}`);
    parts.push('');
  } else if (data.diff?.unchanged) {
    parts.push('IDENTICAL to the previous capture of this surface — the page is stuck.\n');
  }
  parts.push(data.markdown || '');
  return parts.join('\n');
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/* ========================================================================== *
 * CONTROLS
 * ========================================================================== */

export function renderControls(controls) {
  const order = ['start', 'pause', 'resume', 'stop', 'skip', 'retry', 'export', 'report'];
  return `<div class="controls">${order
    .map((k) => {
      const c = controls[k];
      if (!c) return '';
      const danger = k === 'stop' ? ' danger' : '';
      const primary = k === 'start' ? ' primary' : '';
      return `<button data-action="${k}" class="btn${danger}${primary}"
        ${c.enabled ? '' : 'disabled'} title="${esc(c.reason || c.label)}">${esc(c.label)}</button>`;
    })
    .join('')}</div>`;
}

/* ========================================================================== *
 * ERROR CENTER
 * ========================================================================== */

export function renderErrors(errors) {
  const open = errors.filter((e) => !e.resolved);
  if (errors.length === 0) return '<div class="empty">No errors this session.</div>';

  return `
    <div class="errhead">${open.length} unresolved · ${errors.length - open.length} resolved</div>
    ${errors
      .map(
        (e) => `<div class="errcard ${e.resolved ? 'resolved' : ''}">
        <div class="errtop">
          <strong>${esc(e.summary)}</strong>
          ${e.resolved ? '<span class="pill ok">resolved</span>' : '<span class="pill bad">open</span>'}
        </div>
        <div class="errmeta">${esc(e.component)} · ${clock(e.at)}${e.iteration != null ? ` · iteration ${e.iteration}` : ''} · <code>${esc(e.id)}</code></div>
        <div class="errfix">→ ${esc(e.suggestion)}</div>
        ${e.retryable && !e.resolved ? `<button class="btn small" data-action="retry" data-error="${esc(e.id)}">Retry this step</button>` : ''}
        <details><summary>Technical details</summary><pre>${esc(JSON.stringify(e.details, null, 2))}</pre></details>
      </div>`,
      )
      .join('')}`;
}

/* ========================================================================== *
 * SESSION SUMMARY
 * ========================================================================== */

export function renderSummary(s) {
  const rows = [
    ['Iterations completed', `${s.iterations} of ${s.iterationsAttempted} attempted`],
    ['Prompts sent', s.promptsSent],
    ['Responses received', s.responsesReceived],
    ['Response volume', `${s.responseChars.toLocaleString()} characters`],
    ['Files uploaded', s.filesUploaded],
    ['Files downloaded', s.filesDownloaded],
    ['Time elapsed', fmtMs(s.elapsedMs)],
    ['Time spent waiting on AIs', fmtMs(s.totalWaitMs)],
    ['Errors', s.errors],
    ['Strategy changes', s.strategyChanges],
    ['Loops detected', s.stagnationEvents],
    ['Steps skipped', s.stepsSkipped],
    ['Steps retried', s.stepsRetried],
    [
      'Completion score',
      s.completion == null
        ? 'not scored'
        : `${s.completion}% — ${s.measuredDimensions}/${s.totalDimensions} dimensions measured`,
    ],
    ['Final status', `${s.status ?? 'unknown'}${s.stopReason ? ` (${s.stopReason})` : ''}`],
    ['Total events logged', s.totalEvents],
  ];

  /*
   * Anything unfinished is surfaced rather than rounded away. An open event
   * means a step began and never reported an outcome — the summary saying
   * "0 errors" while three steps hang is the kind of quiet lie this project
   * treats as a bug.
   */
  const caveats = [];
  if (s.openEvents > 0) caveats.push(`${s.openEvents} step(s) never reported an outcome`);
  if (s.sinkFailures?.length) caveats.push(`${s.sinkFailures.length} storage failure(s) — some events may only exist in this session`);

  return `
    <table class="summary">${rows
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
      .join('')}</table>
    ${caveats.length ? `<div class="warn">${caveats.map(esc).join('<br>')}</div>` : ''}
    <div class="controls"><button class="btn" data-action="export">Export full log</button></div>`;
}

/* ========================================================================== *
 * LANDING SCREEN
 * ========================================================================== */

/**
 * The three workflow options.
 *
 * Rendered as large radio-style cards rather than a dropdown: the choice
 * changes what the extension does for the next several hours, and a
 * dropdown's default value gets accepted without being read. A card the user
 * has to click is a decision they made.
 */
export function renderLanding({ modes, mode, projectName = '', prompt = '', problems = [] }) {
  const byField = new Map(problems.map((p) => [p.field, p.message]));
  const spec = modes.find((m) => m.key === mode);

  const cards = modes.map((m) => `
    <button class="modecard ${m.key === mode ? 'chosen' : ''}" data-mode="${esc(m.key)}"
            aria-pressed="${m.key === mode}">
      <span class="modename">${esc(m.label)}</span>
      <span class="modeblurb">${esc(m.blurb)}</span>
      ${m.needsPrompt ? '' : '<span class="pill ok">no prompt needed</span>'}
    </button>`).join('');

  /*
   * The prompt field is not merely hidden in explore mode -- it is replaced
   * with an explanation. A field that silently disappears reads as a bug; a
   * sentence saying why there is nothing to fill in reads as a design.
   */
  const promptSection = !spec ? '' : spec.needsPrompt
    ? `<label class="field">
         <span class="label">Primary project prompt</span>
         <textarea id="prompt" rows="5" placeholder="Describe what you want built. The extension writes the rest of the prompt.">${esc(prompt)}</textarea>
         ${byField.has('prompt') ? `<span class="fielderr">${esc(byField.get('prompt'))}</span>` : ''}
       </label>`
    : spec.key === 'explore'
      ? `<div class="explain">Arena will read the project first and report what it finds — purpose,
         architecture, tests, debt and risks — then propose a prioritised roadmap.
         <strong>You do not write a prompt.</strong></div>`
      : `<label class="field">
           <span class="label">Objective update <span class="muted">(optional)</span></span>
           <textarea id="prompt" rows="3" placeholder="Leave blank to continue the work already in progress.">${esc(prompt)}</textarea>
         </label>`;

  return `
    <div class="landing">
      <div class="label">Choose a workflow</div>
      <div class="modes">${cards}</div>
      <label class="field">
        <span class="label">Project name <span class="muted">(optional)</span></span>
        <input id="projectName" type="text" value="${esc(projectName)}" placeholder="Reporting dashboard">
      </label>
      ${promptSection}
      <div class="explain small">
        Everything else — the response format, progress reporting, engineering report,
        commit and test expectations, and the project state — is assembled for you and
        prepended to every prompt.
      </div>
      <div class="controls">
        <button class="btn primary" data-action="preflight" ${spec ? '' : 'disabled'}>Check environment &amp; start</button>
      </div>
    </div>`;
}

/**
 * The preflight checklist.
 *
 * Every row shows its outcome AND its remedy, because a failed check with no
 * remedy just tells the user they cannot proceed. The Start button is disabled
 * until everything passes -- the orchestrator will not create a tab to fix it.
 */
export function renderPreflight(result) {
  const rows = result.checks.map((c) => `
    <div class="check ${c.ok ? 'ok' : c.blocking === false ? 'warnrow' : 'bad'}">
      <span class="mark">${c.ok ? '✓' : c.blocking === false ? '!' : '✗'}</span>
      <div class="grow">
        <div>${esc(c.label)}</div>
        ${c.detail ? `<div class="muted small">${esc(c.detail)}</div>` : ''}
        ${!c.ok && c.remedy ? `<div class="errfix small">→ ${esc(c.remedy)}</div>` : ''}
      </div>
    </div>`).join('');

  return `
    <div class="preflight">
      <div class="label">Environment check</div>
      ${rows}
      ${result.ok
        ? `<div class="explain small">${esc(result.summary)} Nothing was created, opened or changed.</div>`
        : '<div class="warn">The orchestrator will not open tabs, start chats or sign in to fix these. Put the environment right, then re-check.</div>'}
      <div class="controls">
        <button class="btn" data-action="recheck">Re-check</button>
        <button class="btn" data-action="back">Back</button>
        <button class="btn primary" data-action="confirm-start" ${result.ok ? '' : 'disabled'}>Start run</button>
      </div>
    </div>`;
}

/** A preview of exactly what will be sent, before it is sent. */
export function renderPromptPreview(text) {
  return `
    <details class="preview">
      <summary>Preview the prompt that will be sent (${text.length.toLocaleString()} characters)</summary>
      <pre>${esc(text)}</pre>
    </details>`;
}

/* ========================================================================== *
 * MISSION CONTROL
 * ========================================================================== */

const AI_STATE_COLOUR = { WORKING: '#58a6ff', WAITING: '#d29922', READY: '#3fb950', IDLE: '#6e7681', BLOCKED: '#f85149' };

/**
 * The three AI roles and what each is doing.
 *
 * Derived from the live status rather than stored, for the reason status.js
 * already gives: a field written at the start of a phase and not cleared on a
 * throw reports "WORKING" forever after a crash.
 */
export function renderRoles(status, environment = {}) {
  const roles = [
    { key: 'chatgpt', label: 'Manager', surface: 'manager', who: 'ChatGPT' },
    { key: 'arena', label: 'Engineer', surface: 'engineer', who: 'Arena' },
    { key: 'deepseek', label: 'Reviewer', surface: 'reviewer', who: 'DeepSeek' },
  ];

  return `<div class="roles">${roles.map((r) => {
    const bound = environment?.surfaces?.[r.surface];
    let state = 'IDLE';
    if (!bound) state = r.surface === 'reviewer' ? 'IDLE' : 'BLOCKED';
    else if (status.ai === r.key) state = 'WORKING';
    else if (status.status === 'running') state = 'WAITING';
    else if (status.status === 'blocked') state = 'BLOCKED';
    else state = 'READY';

    return `<div class="role">
      <span class="roledot" style="background:${AI_STATE_COLOUR[state]}${state === 'WORKING' ? ';animation:pulse 1.4s infinite' : ''}"></span>
      <div class="grow">
        <div class="rolename">${esc(r.label)} <span class="muted small">${esc(r.who)}</span></div>
        ${state === 'WORKING' && status.step ? `<div class="muted small">${esc(status.step)}</div>` : ''}
      </div>
      <span class="rolestate" style="color:${AI_STATE_COLOUR[state]}">${state}</span>
    </div>`;
  }).join('')}</div>`;
}

/** The environment strip: what is bound, and what is missing. */
export function renderEnvironment(environment, diagnostics = []) {
  const rows = [
    ['Arena', 'engineer', true],
    ['ChatGPT', 'manager', true],
    ['DeepSeek', 'reviewer', false],
    ['Project', '__project', true],
  ];
  const surfaces = environment?.surfaces ?? {};

  return `<div class="envstrip">${rows.map(([label, key, required]) => {
    const ok = key === '__project' ? Boolean(environment?.project) : Boolean(surfaces[key]);
    const state = ok ? 'READY' : required ? 'MISSING' : 'OFF';
    const colour = ok ? 'var(--ok)' : required ? 'var(--bad)' : 'var(--muted)';
    const detail = key === '__project'
      ? (environment?.project ?? '')
      : (surfaces[key] ? `tab ${surfaces[key].tabId}` : '');
    return `<div class="envrow">
      <span class="dot" style="background:${colour}"></span>
      <span class="envname">${esc(label)}</span>
      <span class="muted small grow">${esc(String(detail).slice(0, 40))}</span>
      <span style="color:${colour}">${state}</span>
    </div>`;
  }).join('')}
  ${diagnostics.length ? `<div class="warn small">${diagnostics.map((d) => esc(d.message)).join('<br>')}</div>` : ''}
  </div>`;
}

/**
 * The scorecard: every dimension with its confidence made visible.
 *
 * Bars are coloured by CONFIDENCE, not by value. A 95% asserted score and a
 * 95% measured score look identical as numbers and mean completely different
 * things, and the whole scoring model is undone if the UI presents them the
 * same way.
 */
export function renderScores(scores = []) {
  if (!scores.length) return '<div class="empty">Nothing scored yet.</div>';

  const colour = { measured: 'var(--ok)', inferred: 'var(--accent)', asserted: 'var(--warn)' };
  const evidenced = scores.filter((s) => s.confidence !== 'asserted').length;

  return `
    <div class="muted small" style="margin-bottom:8px">
      ${evidenced} of ${scores.length} dimensions rest on evidence —
      the rest are the model's opinion and cannot end a run.
    </div>
    ${scores.map((s) => {
    const basis = (s.basis || []).map((b) => b.kind).join(', ');
    return `<div class="scorerow" title="${esc(s.reasoning || basis || s.confidence)}">
        <span class="scorename">${esc(s.dimension)}</span>
        <span class="bar"><span class="fill" style="width:${s.score}%;background:${colour[s.confidence]}"></span></span>
        <span class="scoreval">${s.score}%</span>
        <span class="conf" style="color:${colour[s.confidence]}">${s.confidence}</span>
      </div>${basis ? `<div class="scorebasis">↳ ${esc(basis)}</div>` : ''}`;
  }).join('')}`;
}

/** Analytics, rendering `unknown` as a dash rather than a fabricated zero. */
export function renderAnalytics(a) {
  if (!a) return '<div class="empty">No analytics yet.</div>';

  const rows = [
    ['Improvement / iteration', a.improvement, (v) => `${v > 0 ? '+' : ''}${v} pts`],
    ['Score trend', a.trend, (v) => `${v > 0 ? '+' : ''}${v} pts/iter`],
    ['Iteration duration', a.iterationMs, (v) => `${Math.round(v / 1000)}s`],
    ['AI response time', a.latency, (v) => `${Math.round(v / 1000)}s`],
    ['Success rate', a.successRate, (v) => `${v}%`],
    ['Retries / iteration', a.retryRate, (v) => String(v)],
    ['Test growth', a.testGrowth, (v) => `${v > 0 ? '+' : ''}${v} tests`],
    ['Coverage change', a.coverageGrowth, (v) => `${v > 0 ? '+' : ''}${v}%`],
    ['Regression rate', a.regressionRate, (v) => `${v}%`],
    ['Bug discovery', a.bugDiscoveryRate, (v) => `${v}/iter`],
    ['Stagnation frequency', a.stagnationFrequency, (v) => `${v}%`],
    ['Evidence-backed', a.evidencedShare, (v) => `${v}%`],
    ['Token efficiency', a.tokenEfficiency, String],
    ['Estimated cost', a.cost, String],
  ];

  return `<table class="summary">${rows.map(([label, m, fmt]) => {
    const known = m && m.basis !== 'unknown' && m.value != null;
    /*
     * An unknown metric is a dash with a tooltip, never a zero. A fabricated
     * number ends a question that an empty one would prompt.
     */
    const cell = known
      ? `${esc(fmt(m.value))} <span class="conf" style="color:${m.basis === 'measured' ? 'var(--ok)' : 'var(--warn)'}">${m.basis}</span>`
      : `<span class="muted" title="${esc(m?.note ?? '')}">—</span>`;
    return `<tr><th>${esc(label)}</th><td>${cell}</td></tr>`;
  }).join('')}</table>`;
}

/**
 * Iteration history — why the run moved from N to N+1.
 */
export function renderHistory(iterations = []) {
  if (!iterations.length) return '<div class="empty">No iterations yet.</div>';

  return [...iterations].reverse().map((it) => {
    const ev = (it.evidence || []).map((e) => `<code>${esc(e.kind)}</code>`).join(' ') || '<span class="muted">none</span>';
    /*
     * `Number.isFinite`, not truthiness. A timestamp of 0 is falsy, so the
     * truthy check reported "—" for any iteration whose clock started at the
     * epoch — which is every iteration in a test fixture, and any real one on
     * a machine with a badly-set clock. The bug is invisible in production and
     * makes the fixture look broken, which is the worst combination: it trains
     * you to distrust the test rather than the code.
     */
    const dur = Number.isFinite(it.finishedAt) && Number.isFinite(it.startedAt)
      ? `${Math.round((it.finishedAt - it.startedAt) / 1000)}s`
      : '—';
    const signals = (it.signals || []).map((s) => s.kind ?? s).join(', ');

    return `<details class="itercard">
      <summary>
        <strong>Iteration ${it.n}</strong>
        <span class="muted small">${esc((it.objective?.text ?? 'no objective').slice(0, 60))}</span>
        <span class="iterscore">${it.overall != null ? `${it.overall}%` : '—'}</span>
      </summary>
      <div class="iterbody">
        <div><span class="label">Objective</span> ${esc(it.objective?.text ?? '—')}</div>
        ${it.objective?.rationale ? `<div class="muted small">Why: ${esc(it.objective.rationale)}</div>` : ''}
        <div><span class="label">Result</span> ${esc((it.summary || '—').slice(0, 400))}</div>
        <div><span class="label">Files</span> ${(it.filesChanged || []).map((f) => `<code>${esc(f)}</code>`).join(' ') || '<span class="muted">none</span>'}</div>
        <div><span class="label">Evidence</span> ${ev}</div>
        <div><span class="label">Duration</span> ${dur}</div>
        ${signals ? `<div class="warn small">Loop signals: ${esc(signals)}</div>` : ''}
        ${it.review ? `<div><span class="label">Review</span> ${esc(it.review.recommendation)}${it.review.newDirection ? ` — ${esc(it.review.newDirection)}` : ''}</div>` : ''}
        ${(it.contradictions || []).length ? `<div class="err small">${it.contradictions.map((c) => esc(c.message)).join('<br>')}</div>` : ''}
        ${it.scores?.length ? `<details><summary class="muted small">scores</summary>${renderScores(it.scores)}</details>` : ''}
        ${(it.artifacts || []).length ? `<div><span class="label">Artifacts</span> ${it.artifacts.map((a) => `<code>${esc(a.filename ?? a)}</code>`).join(' ')}</div>` : ''}
      </div>
    </details>`;
  }).join('');
}

/** The replay narrative — the decision trail, in order. */
export function renderReplay(replayData) {
  if (!replayData?.narrative?.length) return '<div class="empty">Nothing to replay yet.</div>';
  const banner = replayData.durable === false
    ? '<div class="warn small">Replaying from memory — the durable log was unavailable, so earlier events may be missing.</div>'
    : '';
  return banner + `<div class="narrative">${replayData.narrative.map((n) => `
    <div class="narrow">
      <span class="time">${new Date(n.at).toLocaleTimeString('en-GB', { hour12: false })}</span>
      <span class="iter">i${n.iteration ?? 0}</span>
      <span>${esc(n.text)}</span>
    </div>`).join('')}</div>
    <div class="muted small" style="margin-top:8px">Reconstructed from ${replayData.events} logged events. No AI was contacted.</div>`;
}
