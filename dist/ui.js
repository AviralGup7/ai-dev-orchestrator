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
      const extra = e.data && Object.keys(e.data).length
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
