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

import { renderStatus, renderWorkflow, renderLog, renderControls, renderErrors, renderSummary, esc } from './ui.js';
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

  root.addEventListener('click', async (ev) => {
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
      await engine[action]?.();
      markDirty();
    }
  });

  $('#search').addEventListener('input', (ev) => {
    filters.search = ev.target.value;
    markDirty();
  });

  /*
   * Keyboard shortcuts, logged like every other user action.
   * Space is deliberately NOT bound: it scrolls, and stealing scroll in a log
   * panel is hostile.
   */
  root.ownerDocument.addEventListener('keydown', async (ev) => {
    if (ev.target.matches('input, textarea')) return;
    const map = { p: 'pause', r: 'resume', s: 'stop', e: 'export' };
    const action = map[ev.key.toLowerCase()];
    if (!action || !ev.altKey) return;
    ev.preventDefault();
    engine.logger().log('shortcut-pressed', { description: `Alt+${ev.key.toUpperCase()} → ${action}`, data: { action } });
    await engine[action]?.();
    markDirty();
  });

  /* ------------------------------------------------------------ render -- */

  function paint() {
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
