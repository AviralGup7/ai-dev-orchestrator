/**
 * THE SIDE PANEL CONTROLLER.
 *
 * Owns the DOM, the filter state and the repaint loop. Owns no decisions.
 *
 * WHY A SIDE PANEL AND NOT A POPUP
 * --------------------------------
 * The specification says the icon opens the Activity Log, and the log's whole
 * purpose is to be watched during execution. A popup is destroyed the instant
 * it loses focus — and this orchestrator's normal operation is switching
 * between the ChatGPT, Arena and DeepSeek tabs, which destroys the popup every
 * few seconds. The user would be shown the log only while nothing is
 * happening. The popup remains as a launcher (`popup.html`); the side panel is
 * the real surface.
 *
 * REPAINTS ARE PULLED, NOT PUSHED
 * A naive design re-renders on every logged event. During a busy phase that is
 * hundreds of renders a second, and the visible symptom is that the log jumps
 * away while you are trying to read it. So events accumulate and a timer
 * repaints at a fixed rate; the "Elapsed" clock needs that timer anyway.
 */

import { renderStatus, renderWorkflow, renderLog, renderControls, renderErrors, renderSummary, renderLanding, renderPreflight, renderPromptPreview, esc } from './ui.js';
import { MODES } from '../src/core/modes.js';
import { liveStatus, workflowState, errorCenter } from '../src/core/status.js';
import { availableControls } from '../src/core/controls.js';
import { summarise } from '../src/core/logger.js';
import { CHANNELS } from '../src/core/events.js';

const TABS = [
  { key: 'log', label: 'Activity Log' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'errors', label: 'Errors' },
  { key: 'summary', label: 'Summary' },
];

export function createPanel({ root, engine, repaintMs = 500 }) {
  /*
   * `engine` is an INTERFACE, not the Orchestrator.
   *
   * The panel is driven identically by the real background worker and by the
   * in-page demo — same code, same rendering, no "if (demo)" branches. If the
   * demo diverged from production the demo would stop being evidence that the
   * UI works.
   *
   * Required: memory(), logger(), config(), startedAt(), and the commands
   * start/pause/resume/stop/skip/retry/export.
   */
  let tab = 'log';                       // Activity Log first: it is the source of truth
  let filters = { channels: null, statuses: null, search: '' };
  let dirty = true;

  /*
   * SCREEN vs TAB. The landing screen is not a fifth tab.
   *
   * Before a project exists there is nothing for the Activity Log to show, and
   * offering Workflow/Errors/Summary tabs over an empty run is four ways to
   * look at nothing. The tabs appear once a run exists -- which is also the
   * moment the Activity Log becomes the source of truth the spec calls for.
   */
  let screen = engine.memory()?.scope ? 'run' : 'landing';
  let setup = { mode: null, projectName: '', prompt: '' };
  let setupProblems = [];
  let preflightResult = null;
  let promptPreview = null;
  /** Surfaced in the panel, so a broken control is visible, not just logged. */
  let lastError = null;

  root.innerHTML = `
    <header>
      <h1>AI Development Orchestrator</h1>
      <span class="muted small" id="sess"></span>
    </header>
    <div class="tabs" role="tablist">
      ${TABS.map((t) => `<button class="tab" role="tab" data-tab="${t.key}" aria-selected="${t.key === tab}">${t.label}<span class="count" data-count="${t.key}" hidden></span></button>`).join('')}
    </div>
    <main>
      <div id="status"></div>
      <div id="controls"></div>
      <section id="pane-log">
        <div class="filters">
          <input type="search" id="search" placeholder="Filter the log…" aria-label="Filter the log">
          ${CHANNELS.map((c) => `<button class="chip" data-channel="${c}" aria-pressed="false">${c}</button>`).join('')}
          <button class="chip" data-only-errors aria-pressed="false">errors only</button>
        </div>
        <div id="log"></div>
      </section>
      <section id="pane-workflow" hidden></section>
      <section id="pane-errors" hidden></section>
      <section id="pane-summary" hidden></section>
    </main>`;

  const $ = (sel) => root.querySelector(sel);
  const markDirty = () => { dirty = true; };

  /* ------------------------------------------------------------ events -- */

  /** Read the landing form back out of the DOM before re-rendering it. */
  function captureForm() {
    const name = root.querySelector('#projectName');
    const prompt = root.querySelector('#prompt');
    if (name) setup.projectName = name.value;
    // `prompt` is absent in explore mode; leaving the previous value alone
    // means switching modes back and forth does not silently discard typing.
    if (prompt) setup.prompt = prompt.value;
  }

  /**
   * EVERY HANDLER RUNS INSIDE THIS.
   *
   * The extension appeared completely dead because `engine.preflight` was
   * undefined: calling it threw a TypeError inside a click handler, the
   * rejection went nowhere, and the user pressed the button thirteen times
   * while the log dutifully recorded thirteen presses and no consequence.
   *
   * An unhandled exception in a UI event handler is invisible by default --
   * no dialog, nothing in the panel, and in a side panel not even a console
   * anyone is looking at. That is exactly the "silent failure" the
   * observability objective forbids, and the log proved the failure was
   * silent rather than unlogged: the presses were recorded perfectly.
   *
   * So every handler is wrapped, and a thrown error becomes a logged, visible
   * error like any other.
   */
  async function guarded(what, fn) {
    try {
      await fn();
    } catch (err) {
      engine.logger().log('error', {
        status: 'error',
        source: 'extension',
        description: `"${what}" failed: ${String(err?.message || err || 'unknown error')}`,
        data: { stack: err?.stack ?? null, remedy: 'This is a bug in the extension. Export the log and report it.' },
      });
      lastError = String(err?.message || err || 'unknown error');
      markDirty();
    }
  }

  root.addEventListener('click', (ev) => guarded(describeTarget(ev.target), async () => {
    const modeBtn = ev.target.closest('[data-mode]');
    if (modeBtn) {
      captureForm();
      setup.mode = modeBtn.dataset.mode;
      setupProblems = [];
      engine.logger().log('settings-changed', {
        description: `Workflow mode set to "${modeBtn.dataset.mode}"`,
        data: { mode: modeBtn.dataset.mode },
      });
      markDirty();
      return;
    }

    const tabBtn = ev.target.closest('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      markDirty();
      /*
       * Every user action is logged, including navigation. The requirement
       * lists "button clicks" explicitly, and it earns its place: knowing the
       * user was staring at the Summary tab when they pressed Stop is context
       * a bug report otherwise loses.
       */
      engine.logger().log('button-clicked', { description: `Opened the ${tabBtn.dataset.tab} tab`, data: { tab: tabBtn.dataset.tab } });
      return;
    }

    const chip = ev.target.closest('[data-channel]');
    if (chip) {
      const c = chip.dataset.channel;
      const set = new Set(filters.channels || []);
      set.has(c) ? set.delete(c) : set.add(c);
      filters.channels = set.size ? [...set] : null;
      chip.setAttribute('aria-pressed', String(set.has(c)));
      markDirty();
      return;
    }

    const only = ev.target.closest('[data-only-errors]');
    if (only) {
      const on = only.getAttribute('aria-pressed') !== 'true';
      only.setAttribute('aria-pressed', String(on));
      filters.statuses = on ? ['error', 'warning'] : null;
      markDirty();
      return;
    }

    const btn = ev.target.closest('[data-action]');
    if (btn && !btn.disabled) {
      const action = btn.dataset.action;
      engine.logger().log('button-clicked', { description: `Pressed ${action}`, data: { action } });

      if (action === 'preflight' || action === 'recheck') {
        lastError = null;
        captureForm();
        /*
         * Checked here too, not only in the generic dispatch below.
         *
         * This branch calls `engine.preflight` directly, so it bypassed the
         * `typeof` guard entirely -- and this is the exact method that was
         * missing. The generic guard would have caught every control except
         * the one that actually broke.
         */
        if (typeof engine.preflight !== 'function') {
          throw new Error('the "preflight" control is not connected to the background worker');
        }
        const result = await engine.preflight(setup);
        setupProblems = result.setupProblems || [];
        preflightResult = result.ok === undefined ? result : result;
        promptPreview = result.prompt || null;
        screen = 'preflight';
        markDirty();
        return;
      }
      if (action === 'back') { screen = 'landing'; markDirty(); return; }
      if (action === 'confirm-start') {
        screen = 'run';
        markDirty();
        await engine.start(setup);
        markDirty();
        return;
      }

      /*
       * A MISSING COMMAND IS A BUG, AND IT SAYS SO.
       *
       * `engine[action]?.()` silently did nothing when the method did not
       * exist -- which is how a whole button became inert without a trace.
       * Optional chaining is the right tool for an optional thing; a control
       * the UI is rendering is not optional.
       */
      if (typeof engine[action] !== 'function') {
        throw new Error(`the "${action}" control is not connected to the background worker`);
      }
      await engine[action]();
      markDirty();
    }
  }));

  $('#search').addEventListener('input', (ev) => {
    filters.search = ev.target.value;
    markDirty();
  });

  /** A human name for whatever was clicked, for the error message. */
  function describeTarget(el) {
    const b = el.closest?.('[data-action],[data-mode],[data-tab]');
    if (!b) return 'click';
    return b.dataset.action || `mode:${b.dataset.mode}` || `tab:${b.dataset.tab}`;
  }

  /*
   * Keyboard shortcuts, logged like every other user action.
   * Space is deliberately NOT bound: it scrolls, and stealing scroll in a log
   * panel is hostile.
   */
  root.ownerDocument.addEventListener('keydown', (ev) => guarded('shortcut', async () => {
    if (ev.target.matches('input, textarea')) return;
    const map = { p: 'pause', r: 'resume', s: 'stop', e: 'export' };
    const action = map[ev.key.toLowerCase()];
    if (!action || !ev.altKey) return;
    ev.preventDefault();
    engine.logger().log('shortcut-pressed', { description: `Alt+${ev.key.toUpperCase()} → ${action}`, data: { action } });
    if (typeof engine[action] !== 'function') {
      throw new Error(`the "${action}" shortcut is not connected to the background worker`);
    }
    await engine[action]();
    markDirty();
  }));

  /* ------------------------------------------------------------ render -- */

  function paint() {
    if (screen !== 'run') return paintSetup();
    const memory = engine.memory();
    const logger = engine.logger();
    const config = engine.config();
    const events = logger.live;
    const last = events[events.length - 1] || null;

    const status = liveStatus(memory, { lastEvent: last, config, startedAt: engine.startedAt(), now: Date.now() });
    $('#status').innerHTML = renderStatus(status);
    $('#controls').innerHTML = renderControls(availableControls(memory));

    for (const t of TABS) {
      root.querySelector(`[data-tab="${t.key}"]`).setAttribute('aria-selected', String(t.key === tab));
      root.querySelector(`#pane-${t.key}`).hidden = t.key !== tab;
    }

    const errs = errorCenter(events);
    const openErrs = errs.filter((e) => !e.resolved).length;
    const badge = root.querySelector('[data-count="errors"]');
    badge.hidden = openErrs === 0;
    badge.textContent = String(openErrs);

    if (tab === 'log') {
      $('#log').innerHTML = renderLog(logger.view(filters), logger.notShown);
    } else if (tab === 'workflow') {
      $('#pane-workflow').innerHTML = renderWorkflow(workflowState(memory));
    } else if (tab === 'errors') {
      $('#pane-errors').innerHTML = renderErrors(errs);
    } else {
      $('#pane-summary').innerHTML = renderSummary(
        summarise(events, memory, {
          sessionId: logger.sessionId,
          notShown: logger.notShown,
          openEvents: logger.openEvents().length,
          sinkFailures: logger.sinkFailures,
        }),
      );
    }

    $('#sess').textContent = `session ${logger.sessionId}`;
    root.querySelector('.tabs').hidden = false;
    dirty = false;
  }

  /** The pre-run screens. Tabs are hidden: there is nothing to tab through. */
  function paintSetup() {
    root.querySelector('.tabs').hidden = true;
    $('#controls').innerHTML = '';
    for (const t of TABS) root.querySelector(`#pane-${t.key}`).hidden = true;
    $('#pane-log').hidden = false;

    if (screen === 'landing') {
      $('#status').innerHTML = lastError
        ? `<div class="err">⚠ ${esc(lastError)} — see the Activity Log.</div>`
        : '';
      $('#log').innerHTML = renderLanding({ modes: MODES, ...setup, problems: setupProblems });
    } else {
      $('#status').innerHTML = lastError ? `<div class="err">⚠ ${esc(lastError)}</div>` : '';
      $('#log').innerHTML =
        renderPreflight(preflightResult) + (promptPreview ? renderPromptPreview(promptPreview) : '');
    }
    $('#sess').textContent = `session ${engine.logger().sessionId}`;
    dirty = false;
  }

  /*
   * Repaint on a timer, but only when something changed OR a clock is
   * visibly ticking. Repainting unconditionally would blow away an expanded
   * <details> element every 500ms while the user is reading it.
   */
  const timer = setInterval(() => {
    if (dirty || engine.memory()?.status === 'running') paint();
  }, repaintMs);

  paint();

  return {
    markDirty,
    paint,
    destroy: () => clearInterval(timer),
    setTab: (t) => { tab = t; markDirty(); },
  };
}
