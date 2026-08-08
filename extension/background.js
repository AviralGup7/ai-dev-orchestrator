/**
 * THE SERVICE WORKER — where the run actually lives.
 *
 * Owns the Orchestrator, the Logger and the durable sink. The popup and the
 * side panel are views onto this; either can be closed without touching the
 * run.
 *
 * MV3 EVICTION IS THE DESIGN CONSTRAINT
 * -------------------------------------
 * Chrome kills an idle service worker after ~30 seconds. That is not an edge
 * case for this extension, it is the normal condition: the orchestrator spends
 * most of its life waiting for an AI to finish writing. Three consequences,
 * all already handled elsewhere and all load-bearing here:
 *
 *   1. Memory persists at every phase boundary (orchestrator.js), so a restart
 *      resumes rather than restarting the iteration.
 *   2. The log is durable (idbsink.js), so an eviction cannot swallow events.
 *   3. On wake, the live view is rebuilt from the sink -- otherwise the panel
 *      would show an empty Activity Log for a run that is hours in, which
 *      looks exactly like "it lost everything".
 */

import { Orchestrator } from '../src/core/orchestrator.js';
import { Logger } from '../src/core/logger.js';
import { bridgeToLogger } from '../src/core/bridge.js';
import { toNdjson } from '../src/core/logsink.js';
import { summarise } from '../src/core/logger.js';
import { IdbLogSink, ChromeStore } from './idbsink.js';

/**
 * Never let an error about an error hide the real one.
 *
 * `err.message` throws when `err` is null or undefined -- which happens for
 * real: IndexedDB rejects with `req.error`, and that is null when the database
 * cannot be opened at all. The result was a service worker reporting
 * "Cannot read properties of undefined (reading 'message')", an error about
 * the error, while the actual fact (storage unavailable) never reached the
 * log. src/core has used `String(err?.message || err)` throughout for exactly
 * this reason; the extension layer had not caught up.
 */
const reason = (err) => String(err?.message || err || 'unknown error');

const sink = new IdbLogSink();
const store = new ChromeStore();
const logger = new Logger({ sink, liveLimit: 500, onEvent: broadcast });

let orch = null;
let startedAt = null;
let running = false;

/* Clicking the icon opens the side panel next to the current tab. It does not
   create, close or navigate a tab -- see docs/ENVIRONMENT.md. */
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  logger.log('extension-started', { description: 'Extension installed or updated' });
});

/**
 * Rebuild the live view after an eviction.
 *
 * Without this the panel reconnects to a Logger with an empty `live` array and
 * renders "no events" over a run that has been going for two hours.
 */
async function rehydrate() {
  if (logger.live.length > 0) return;
  try {
    const recent = await sink.recent(500);
    if (recent.length) {
      logger.live = recent;
      logger.notShown = Math.max(0, (await sink.count()) - recent.length);
      logger.log('crash-recovered', {
        source: 'system',
        description: `Service worker restarted — restored ${recent.length} recent events from storage`,
      });
    }
  } catch (err) {
    logger.log('error', { status: 'error', source: 'system', description: `Could not restore the log: ${reason(err)}` });
  }
}

function snapshot() {
  return {
    memory: orch?.memory ?? null,
    config: orch?.config ?? {},
    sessionId: logger.sessionId,
    events: logger.live,
    notShown: logger.notShown,
    openEvents: logger.openEvents().length,
    sinkFailures: logger.sinkFailures,
    startedAt,
    running,
  };
}

/** Push state to any open view. Failure is expected when none is open. */
function broadcast() {
  /*
   * Wrapped in try/catch as well as .catch().
   *
   * With no panel open there is no receiver, and Chrome signals that either by
   * rejecting the promise OR by throwing synchronously, depending on version.
   * A synchronous throw here would propagate out of `log()`'s subscriber call
   * and, before that path was hardened, could take down a command handler --
   * meaning the extension breaks precisely when nobody is watching it, which
   * is the hardest state to debug.
   */
  try {
    const p = chrome.runtime.sendMessage({ kind: 'state', state: snapshot() });
    if (p?.catch) p.catch(() => {});
  } catch {
    /* no receiver; expected whenever the panel is closed */
  }
}

/**
 * Notifications explain what happened AND what happens next, as required.
 * A notification that says "Build failed" and nothing else makes the user open
 * the panel to find out whether the run died — which is the anxiety the
 * requirement is trying to remove.
 */
function notify(title, message) {
  chrome.notifications?.create?.({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
  });
}

async function ensureOrchestrator() {
  if (orch) return orch;
  const { config = {} } = await chrome.storage.local.get('config');
  orch = new Orchestrator({
    // Adapters are registered here once they exist; until then the extension
    // has no AI transport and Start will report that honestly rather than
    // pretending to run.
    manager: null,
    engineer: null,
    reviewer: null,
    store,
    config,
    onEvent: bridgeToLogger(logger),
  });
  await orch.load();
  logger.log('state-restored', { source: 'system', description: 'Project memory loaded from storage' });
  return orch;
}

const COMMANDS = {
  async state() {
    await rehydrate();
    return snapshot();
  },

  async start() {
    if (running) return { ok: false, why: 'already running' };
    const o = await ensureOrchestrator();
    if (!o.manager || !o.engineer) {
      /*
       * HONEST REFUSAL RATHER THAN A SILENT NO-OP.
       *
       * The adapters are not written yet. A Start button that does nothing is
       * the "hidden background process" failure in miniature: the user presses
       * it, nothing happens, and they cannot tell whether it is working
       * silently or broken.
       */
      logger.log('error', {
        status: 'error',
        description: 'No AI adapters are registered yet — the extension cannot drive ChatGPT or Arena.',
        data: { remedy: 'This build ships the engine, logging and UI. Adapters are the next milestone.' },
      });
      broadcast();
      return { ok: false, why: 'no adapters' };
    }
    running = true;
    startedAt = Date.now();
    try {
      const verdict = await o.run();
      notify('Workflow finished', `${verdict.why}. The run is stopped; open the panel for the session summary.`);
      return verdict;
    } finally {
      running = false;
      await logger.flush();
      broadcast();
    }
  },

  async pause() { orch?.pause(); broadcast(); notify('Workflow paused', 'No prompts will be sent until you press Resume.'); },
  async resume() {
    if (orch?.memory?.block) await orch.unblock();
    orch?.resume();
    broadcast();
    return COMMANDS.start();
  },
  async stop() {
    await orch?.stop();
    running = false;
    await logger.flush();
    broadcast();
    notify('Workflow stopped', 'State was saved — you can resume this project later.');
  },
  async skip() { orch?.skipStep(); broadcast(); },
  async retry() { orch?.retryStep(); broadcast(); },

  async log({ type, fields }) {
    logger.log(type, fields);
    return { ok: true };
  },

  async export() {
    await logger.flush();
    return sink.all();
  },

  /**
   * Download the full log.
   *
   * `downloads.download` is an allowed action (see actions.js) -- it saves a
   * file and does not touch a tab.
   */
  async 'download-log'() {
    await logger.flush();
    const all = await sink.all();
    const url = 'data:application/x-ndjson;charset=utf-8,' + encodeURIComponent(toNdjson(all));
    await chrome.downloads.download({ url, filename: `orchestrator-${logger.sessionId}.ndjson`, saveAs: true });
    logger.log('log-exported', { source: 'user', description: `Exported ${all.length} events` });
    broadcast();
    return { ok: true, events: all.length };
  },

  async 'session-summary'() {
    await logger.flush();
    return summarise(await sink.all(), orch?.memory ?? null, {
      sessionId: logger.sessionId,
      notShown: logger.notShown,
      openEvents: logger.openEvents().length,
      sinkFailures: logger.sinkFailures,
    });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = COMMANDS[msg?.kind];
  if (!fn) return false;
  Promise.resolve(fn(msg))
    .then(reply)
    .catch((err) => {
      logger.log('error', { status: 'error', description: `Command "${msg.kind}" failed: ${reason(err)}`, data: { stack: err?.stack ?? null } });
      reply({ ok: false, error: reason(err) });
    });
  return true; // async reply
});

/*
 * Flush on suspend. Best-effort: MV3 gives no guarantee the callback finishes,
 * which is exactly why `flushEvery` is small and the sink is transactional.
 * Relying on this alone to save the log would lose the last batch of every
 * evicted session.
 */
chrome.runtime.onSuspend?.addListener(() => { void logger.flush(); });
