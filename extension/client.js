/**
 * The panel's view of the background worker.
 *
 * WHY THE UI DOES NOT HOLD THE ORCHESTRATOR
 * -----------------------------------------
 * A side panel is a document. Close it, or let Chrome discard it, and
 * everything in its memory goes with it. If the run lived here, closing the
 * panel to look at something would abort a multi-hour job.
 *
 * So the background service worker owns the run and the panel is a *view*: it
 * asks for a state snapshot, renders it, and sends commands. That also means
 * two surfaces (popup and side panel) can be open at once without either
 * owning the truth.
 *
 * MV3 service workers are themselves evicted after ~30s idle, which is why
 * every phase boundary persists (see orchestrator.js) and why the log is
 * durable rather than in-memory. This client reconnects transparently.
 */

/** Shape-compatible with the Logger the panel expects, backed by messages. */
function remoteLogger(state) {
  return {
    sessionId: state.sessionId,
    live: state.events,
    notShown: state.notShown,
    openEvents: () => state.openEvents,
    sinkFailures: state.sinkFailures,
    view(filters = {}) {
      const q = (filters.search || '').trim().toLowerCase();
      return state.events.filter((e) => {
        if (filters.channels && !filters.channels.includes(e.channel)) return false;
        if (filters.sources && !filters.sources.includes(e.source)) return false;
        if (filters.statuses && !filters.statuses.includes(e.status)) return false;
        if (q) {
          const hay = `${e.label} ${e.description} ${e.type} ${JSON.stringify(e.data)}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    },
    log(type, fields) {
      /*
       * UI-originated events are forwarded, not logged locally.
       *
       * "Every user action must be logged" -- including button clicks. If the
       * panel kept them in its own array they would be lost when the panel
       * closes, and the exported log would show a run nobody appeared to
       * touch. The background worker owns the one true sequence.
       */
      void chrome.runtime.sendMessage({ kind: 'log', type, fields });
    },
    all: () => chrome.runtime.sendMessage({ kind: 'export' }),
  };
}

export async function connectToBackground() {
  let state = await chrome.runtime.sendMessage({ kind: 'state' });

  /*
   * Push updates keep the panel live; the poll is a safety net for the case
   * where the service worker was evicted and restarted, dropping its port.
   * Without the net the panel silently freezes -- showing a stale "Waiting for
   * Arena response" forever, which is precisely the hidden-background-process
   * failure this whole objective exists to prevent.
   */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'state') state = msg.state;
  });
  setInterval(async () => {
    try {
      state = await chrome.runtime.sendMessage({ kind: 'state' });
    } catch {
      /* worker asleep; the next tick will wake it */
    }
  }, 1000);

  const send = (kind, extra = {}) => chrome.runtime.sendMessage({ kind, ...extra });

  return {
    memory: () => state.memory,
    logger: () => remoteLogger(state),
    config: () => state.config,
    startedAt: () => state.startedAt,
    start: () => send('start'),
    pause: () => send('pause'),
    resume: () => send('resume'),
    stop: () => send('stop'),
    skip: () => send('skip'),
    retry: () => send('retry'),
    export: () => send('download-log'),
    report: () => send('open-report'),
  };
}
