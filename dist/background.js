/**
 * THE SERVICE WORKER — where the run actually lives.
 *
 * Owns the Orchestrator, the Logger and the durable sink. The popup and the
 * side panel are views onto this; either can be closed without touching the
 * run.
 *
 * MV3 EVICTION IS THE DESIGN CONSTRAINT
 * -------------------------------------
 * MV3 SERVICE WORKER LIFETIME -- verified against Chrome's documented rules,
 * August 2026:
 *
 *   - terminated after 30s of inactivity; ANY event or extension API call
 *     resets that timer (Chrome 110+);
 *   - terminated when a SINGLE event or API call takes longer than 5 minutes;
 *   - terminated when a fetch() response takes more than 30s to arrive.
 *
 * The second rule is the one that shapes this design: a run must never be a
 * single awaited event, or Chrome kills it at five minutes. The first is why a
 * heartbeat is needed while waiting on an AI -- during a multi-minute wait the
 * orchestrator makes no API calls at all, so the idle timer is not reset.
 *
 * Eviction is not an edge case here, it is the normal condition: the
 * orchestrator spends most of its life waiting for an AI. Three consequences,
 * all load-bearing:
 *
 *   1. Memory persists at every phase boundary (orchestrator.js), so a restart
 *      resumes rather than restarting the iteration.
 *   2. The log is durable (idbsink.js), so an eviction cannot swallow events.
 *   3. On wake, the live view is rebuilt from the sink -- otherwise the panel
 *      would show an empty Activity Log for a run that is hours in, which
 *      looks exactly like "it lost everything".
 */

import { Orchestrator } from './core/orchestrator.js';
import { Logger } from './core/logger.js';
import { bridgeToLogger } from './core/bridge.js';
import { toNdjson } from './core/logsink.js';
import { summarise } from './core/logger.js';
import { IdbLogSink, ChromeStore } from './idbsink.js';
import { preflight } from './core/preflight.js';
import { composeFirstPrompt } from './core/protocol.js';
import { initialScope, validateSetup } from './core/modes.js';
import { emptyMemory } from './core/types.js';
import { snapshotEnvironment, EXPECTED_HOSTS } from './probe.js';
import { createPageReader } from './dom-page.js';
import { DomTransport } from './transports/dom.js';
import { ManagerAdapter } from './adapters/manager.js';
import { EngineerAdapter } from './adapters/engineer.js';
import { ReviewerAdapter } from './adapters/reviewer.js';
import { Runner } from './core/runner.js';
import { ProjectStore } from './core/projectstore.js';
import { ChromeKeyValue } from './kvstore.js';
import { bind, verify } from './core/environment.js';
import { analyse } from './core/analytics.js';
import { replay, narrate } from './core/replay.js';
import { scanTab } from './scan.js';
import { ScanBudget, boundCapture, describeCapture, diffCaptures, renderCapture } from './core/surface.js';

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
const projectStore = new ProjectStore({ kv: new ChromeKeyValue() });
let runner = null;
let binding = null;
/** The detached run promise. See the note in `start`. */
let activeRun = null;
const budget = new ScanBudget();
/** Last capture per surface, so a repeat failure can be logged as a diff. */
const lastCapture = new Map();

const logger = new Logger({
  sink,
  liveLimit: 500,
  onEvent: (event) => {
    broadcast();
    /*
     * THE AUTOMATIC TRIGGER.
     *
     * Every logged event passes through here, so an error captures the page
     * that produced it without any call site remembering to ask. That matters
     * because the call sites that log errors are the ones written in a hurry.
     *
     * Fired and NOT awaited: `log()` is synchronous by design (an awaited log
     * lets a slow write reorder events relative to the actions they describe),
     * and a scan takes hundreds of milliseconds. The scan logs its own result
     * when it completes.
     */
    void maybeScan(event);
  },
});

let orch = null;
let startedAt = null;
let running = false;
/** The setup that passed preflight, so Start does not re-ask for it. */
let pendingSetup = null;

/* Clicking the icon opens the side panel next to the current tab. It does not
   create, close or navigate a tab -- see docs/ENVIRONMENT.md. */
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});

/**
 * KEEP-ALIVE, SCOPED TO ACTUAL WORK.
 *
 * Chrome resets the 30s idle timer on any extension API call (Chrome 110+).
 * While waiting minutes for an AI reply the orchestrator makes no API calls at
 * all, so the worker is evicted mid-wait and the in-flight response is lost --
 * recoverable, because phases are idempotent, but it would turn every slow
 * reply into a redundant re-run.
 *
 * A 20-second `chrome.storage` touch prevents that. It runs ONLY while a run
 * is in flight, and stops the moment it is not: an unconditional keep-alive is
 * the pattern Chrome's own docs warn against and the Web Store rejects.
 */
const HEARTBEAT_MS = 20_000;
let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!running) { stopHeartbeat(); return; }
    void chrome.storage.local.set({ 'orchestrator-heartbeat': Date.now() });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

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
  /*
   * The project record is loaded on EVERY wake, not only when the log is
   * empty. An MV3 worker is evicted constantly, and a panel asking for state
   * after an eviction must see the run that is genuinely in progress -- not an
   * empty dashboard that looks like the project was lost.
   */
  if (!projectStore.project) {
    try {
      await projectStore.load();
    } catch (err) {
      logger.log('error', { status: 'error', source: 'system', description: `Could not load the project: ${reason(err)}` });
    }
  }
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

/**
 * Capture the page behind an error, if that is warranted.
 *
 * All the "is this warranted" judgement is in `ScanBudget`. This function only
 * resolves which tab to look at and records the result.
 */
async function maybeScan(event) {
  const verdict = budget.may(event);
  if (!verdict.allowed) return;

  const surface = event.surface || event.data?.surface || event.source;
  let tabId = event.data?.tabId ?? orch?.environment?.binding?.surfaces?.[surface]?.tabId;

  if (!tabId) {
    /*
     * Fall back to a fresh probe rather than giving up.
     *
     * The most valuable moment to scan is a failure that happened BEFORE a
     * binding existed -- a preflight that could not find the composer, say.
     * Requiring a binding would disable the feature exactly when the user has
     * the least information.
     */
    try {
      const snap = await snapshotEnvironment();
      tabId = snap.surfaces?.[surface]?.tabId;
    } catch { /* probe failed; nothing to scan */ }
  }
  if (!tabId) return;

  budget.begin(surface);
  try {
    const raw = await scanTab(tabId, {
      surface,
      maxNodes: budget.config.maxNodes,
      maxDepth: budget.config.maxDepth,
    });
    const bounded = boundCapture({ ...raw, surface }, budget.config);
    if (!bounded.ok) throw new Error(bounded.problem);

    const previous = lastCapture.get(surface);
    const diff = previous ? diffCaptures(previous, bounded.capture) : null;
    lastCapture.set(surface, bounded.capture);

    logger.log('surface-scan', {
      source: 'extension',
      status: 'warning',
      iteration: event.iteration ?? null,
      description: describeCapture(bounded.capture),
      correlationId: event.id,
      /*
       * Both shapes are stored: the structured capture, because a later tool
       * (or a diff against the next failure) needs the fields; and the
       * rendered markdown, because the log export is meant to be pasted to an
       * agent and re-rendering it at read time would mean every consumer needs
       * the renderer.
       */
      data: {
        capture: bounded.capture,
        markdown: renderCapture(bounded.capture),
        diff,
        becauseOf: event.type,
      },
    });
  } catch (err) {
    /*
     * A failed scan is logged as `surface-scan-failed`, which is in NEVER_SCAN
     * -- otherwise this line would trigger the scan that produced it, forever.
     */
    logger.log('surface-scan-failed', {
      source: 'extension',
      status: 'warning',
      description: `Could not capture ${surface}: ${reason(err)}`,
      correlationId: event.id,
      data: { remedy: 'The page may have closed, or the extension may lack access to it.' },
    });
  } finally {
    budget.end();
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
    scans: budget.summary(),
    /*
     * The durable record travels with the snapshot so the panel can render a
     * project after a worker eviction without a second round trip -- the
     * panel polls, and a second call would double the traffic for data that
     * changes at the same moments.
     */
    project: projectStore.project,
    run: projectStore.run,
    iterations: projectStore.iterations,
    resumability: projectStore.resumability(),
    diagnostics: projectStore.diagnostics,
    binding: binding?.surfaces ?? {},
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

/**
 * Build the real runner: adapters over a DOM transport, bound to the tabs the
 * user already had open.
 *
 * The binding is captured at this moment and held for the run, which is what
 * makes "the tab changed" detectable -- see src/core/environment.js.
 */
async function ensureRunner(setup = null) {
  if (runner) return runner;

  const { config = {} } = await chrome.storage.local.get('config');
  const snapshot = await snapshotEnvironment();
  const required = config.reviewerEnabled ? ['manager', 'engineer', 'reviewer'] : ['manager', 'engineer'];
  binding = bind(snapshot, { require: required, hosts: EXPECTED_HOSTS });

  const page = createPageReader(() => binding);
  const transport = new DomTransport({
    page,
    config: { timeoutMs: config.timeoutMs ?? 240_000 },
    onEvent: (e) => logger.log(mapTransportEvent(e.type), {
      source: e.surface === 'engineer' ? 'arena' : e.surface === 'reviewer' ? 'deepseek' : 'chatgpt',
      description: describeTransport(e),
      data: e,
    }),
  });

  const adapterEvents = (e) => logger.log(mapAdapterEvent(e.type), {
    source: e.actor === 'engineer' ? 'arena' : e.actor === 'reviewer' ? 'deepseek' : 'chatgpt',
    status: e.type.includes('failed') || e.ok === false ? 'error' : 'success',
    iteration: e.iteration ?? null,
    durationMs: e.durationMs ?? null,
    description: describeAdapter(e),
    data: e,
  });

  runner = new Runner({
    manager: new ManagerAdapter({ transport, onEvent: adapterEvents }),
    engineer: new EngineerAdapter({ transport, onEvent: adapterEvents }),
    reviewer: config.reviewerEnabled
      ? new ReviewerAdapter({ transport, onEvent: adapterEvents })
      : null,
    store: projectStore,
    environment: {
      async check() {
        /*
         * `verify` is imported STATICALLY at the top of this file.
         *
         * It was `await import(...)` here, which is disallowed on
         * ServiceWorkerGlobalScope by the HTML specification
         * (w3c/ServiceWorker#1356). The run started, reached its first
         * environment check, and died with:
         *
         *   "import() is disallowed on ServiceWorkerGlobalScope"
         *
         * reported as `tab-missing` -- so the message blamed the user's tabs
         * for a bug in this file. Every module a worker needs must be a
         * static import; there is no lazy loading in this context.
         */
        const snap = await snapshotEnvironment();
        return verify(binding, snap);
      },
    },
    config,
    onEvent: bridgeToLogger(logger),
  });
  orch = runner.orchestrator;
  logger.log('state-restored', {
    source: 'system',
    description: `Runner ready${setup ? ` — mode "${setup.mode}"` : ''}`,
  });
  return runner;
}

/* Event name translation, so the Activity Log speaks one vocabulary. */
const TRANSPORT_EVENTS = {
  'prompt-pasted': 'prompt-pasted',
  'prompt-submitted': 'prompt-submitted',
  'response-started': 'awaiting-response',
  'response-progress': 'response-progress',
  'response-complete': 'response-received',
  'response-settled': 'response-received',
  'waiting-for-idle': 'awaiting-response',
};
const ADAPTER_EVENTS = {
  'prompt-sent': 'prompt-submitted',
  'response-received': 'response-received',
  'prompt-failed': 'error',
  'response-validated': 'evidence-collected',
  'schema-reprompt': 'step-retried',
  'execution-requested': 'task-started',
  'execution-completed': 'task-complete',
  'response-malformed': 'error',
  'report-contradiction': 'error',
  'evidence-recovered': 'evidence-collected',
};
const mapTransportEvent = (t) => TRANSPORT_EVENTS[t] ?? 'user-action';
const mapAdapterEvent = (t) => ADAPTER_EVENTS[t] ?? 'user-action';

function describeTransport(e) {
  switch (e.type) {
    case 'prompt-pasted': return `Pasted ${e.chars} characters into the ${e.surface} composer`;
    case 'prompt-submitted': return `Submitted the prompt to ${e.surface}`;
    case 'response-started': return `${e.surface} began responding`;
    case 'response-progress': {
      const mins = Math.round(e.elapsedMs / 60_000);
      const quiet = Math.round(e.silentMs / 60_000);
      return `${e.surface} still working — ${mins}m elapsed, ${e.chars} characters so far` +
        (e.busy ? ' (generating)' : quiet >= 2 ? `, quiet for ${quiet}m` : '');
    }
    case 'response-complete': return `${e.surface} replied (${e.chars} characters)`;
    case 'waiting-for-idle': return `Waiting for ${e.surface} to finish a previous response`;
    default: return e.type;
  }
}

function describeAdapter(e) {
  switch (e.type) {
    case 'prompt-sent': return `Sent the ${e.what} request${e.attempt ? ` (attempt ${e.attempt + 1})` : ''}`;
    case 'response-received': return `Received ${e.chars} characters in ${Math.round((e.durationMs ?? 0) / 1000)}s`;
    case 'prompt-failed': return `${e.what} failed: ${e.error}`;
    case 'response-validated': return e.ok
      ? `The ${e.what} validated${e.dropped?.length ? ` (dropped: ${e.dropped.join(', ')})` : ''}`
      : `The ${e.what} did not validate: ${(e.problems || []).join('; ')}`;
    case 'schema-reprompt': return `Re-asking with the schema error attached`;
    case 'execution-completed': return `Arena finished: ${e.taskStatus}, ${e.files} file(s), evidence: ${(e.evidence || []).join(', ')}`;
    case 'report-contradiction': return `Report contradicts its own numbers: ${e.message}`;
    case 'evidence-recovered': return `Recovered ${e.kind} evidence from the raw output`;
    default: return e.type;
  }
}

const COMMANDS = {
  async state() {
    await rehydrate();
    return snapshot();
  },

  async start(msg = {}) {
    if (running) return { ok: false, why: 'already running' };
    const setup = msg.setup || pendingSetup;

    if (!projectStore.project) {
      if (!setup) {
        logger.log('error', {
          status: 'error',
          description: 'No project has been set up yet — choose a workflow on the landing screen first.',
        });
        broadcast();
        return { ok: false, why: 'no project' };
      }
      await projectStore.createProject({ scope: initialScope(setup), mode: setup.mode, name: setup.projectName });
      await projectStore.startRun({ config: (await chrome.storage.local.get('config'))?.config ?? {}, mode: setup.mode });
    }

    let r;
    try {
      r = await ensureRunner(setup);
    } catch (err) {
      /*
       * A binding failure here is the environment contract doing its job: the
       * tabs are not what they were. Reported, never worked around.
       */
      logger.log('environment-drift', {
        status: 'error',
        description: `Cannot start: ${reason(err)}`,
        data: { problems: err?.problems ?? null },
      });
      broadcast();
      return { ok: false, why: 'environment', problems: err?.problems ?? null };
    }

    /*
     * THE RUN IS NOT AWAITED INSIDE THE MESSAGE HANDLER.
     *
     * Verified against Chrome's documented service-worker lifecycle: "Chrome
     * terminates a service worker when a single request, such as an event or
     * API call, takes longer than 5 minutes to process."
     *
     * `r.start()` is a multi-hour loop. Awaiting it inside `onMessage` makes
     * the whole run one event, so Chrome would kill the worker at the
     * five-minute mark -- mid-iteration, every time, on the first real run.
     * The default per-response timeout was 300_000ms, sitting exactly on that
     * ceiling: a single slow Arena reply was enough to trigger it.
     *
     * So the handler returns immediately and the run proceeds as a detached
     * task. Each ADAPTER call is its own await, and every chrome API call
     * inside it resets the 30s idle timer (Chrome 110+), so the worker stays
     * alive while work is genuinely happening. When it is evicted anyway, the
     * persisted phase record is what makes resuming correct -- which is the
     * reason phases were made idempotent in the first place.
     */
    running = true;
    startedAt = Date.now();
    startHeartbeat();

    activeRun = (async () => {
      try {
        const verdict = await r.start();
        notify('Workflow finished', `${verdict.why}. Open the panel for the session summary.`);
        return verdict;
      } catch (err) {
        logger.log('error', { status: 'error', description: `The run ended unexpectedly: ${reason(err)}` });
        return { stop: true, reason: 'fatal-error', why: reason(err) };
      } finally {
        running = false;
        stopHeartbeat();
        await logger.flush();
        broadcast();
      }
    })();

    return { ok: true, started: true, runId: projectStore.run?.id ?? null };
  },

  /**
   * Wait for the detached run, for tests and for a caller that genuinely
   * wants the verdict. Never used by the panel, which polls state instead.
   */
  async 'await-run'() {
    return activeRun ? activeRun : { ok: false, why: 'no run in flight' };
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

  /**
   * Read the pre-opened environment and validate it.
   *
   * Reads only. `chrome.tabs.query` inspects tabs that already exist; nothing
   * is created, closed or navigated.
   */
  async preflight({ setup }) {
    const check = validateSetup(setup || {});
    const snapshot = await snapshotEnvironment();

    const result = await preflight({
      setup,
      snapshot,
      hosts: EXPECTED_HOSTS,
      reviewerEnabled: Boolean((await chrome.storage.local.get('config'))?.config?.reviewerEnabled),
      logger,
      store,
    });
    result.setupProblems = check.problems;

    /*
     * The composed prompt is returned so the panel can SHOW IT BEFORE SENDING.
     * The spec promises the user never assembles context by hand; that is only
     * trustworthy if they can see what was assembled on their behalf.
     */
    if (result.ok) {
      pendingSetup = setup;
      result.prompt = composeFirstPrompt({
        mode: setup.mode,
        prompt: setup.prompt,
        projectName: setup.projectName,
        memory: emptyMemory(initialScope(setup), setup.mode),
      });
    }

    logger.log(result.ok ? 'config-loaded' : 'error', {
      source: 'system',
      status: result.ok ? 'success' : 'error',
      /*
       * The DESCRIPTION carries the detail, not just the count.
       *
       * "2 of 9 checks failed: Arena AI tab, Arena workspace is open" told the
       * user which checks failed and nothing about why. The reasons were in
       * `data`, which the log line does not show -- so four rechecks produced
       * four identical, uninformative lines. The exported log had the answer
       * buried one level down.
       */
      description: result.problems.length
        ? `${result.summary}\n${result.problems.map((p) => `  · ${p.label}: ${p.detail}`).join('\n')}`
        : result.summary,
      data: {
        failed: result.problems.map((p) => `${p.label}: ${p.detail}`),
        remedies: result.problems.map((p) => p.remedy).filter(Boolean),
        surfaces: Object.fromEntries(
          Object.entries(snapshot.surfaces ?? {}).map(([k, v]) => [k, { url: v.url, tabId: v.tabId, conversationId: v.conversationId }]),
        ),
        scanned: snapshot.scanned,
      },
    });
    broadcast();
    return result;
  },

  /** "View Latest Report" — honest about not existing yet. */
  async 'open-report'() {
    logger.log('user-action', {
      source: 'user',
      status: 'warning',
      description: 'No report has been generated yet — reports appear after the first iteration.',
    });
    broadcast();
    return { ok: false, why: 'no report yet' };
  },

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

  /**
   * What the extension can actually see, verbatim.
   *
   * Added because diagnosing "Arena tab not found" took a round trip through
   * an exported log to discover the tab WAS found and the URL pattern was
   * wrong. A user should be able to answer "what do you see?" without me
   * parsing NDJSON.
   *
   * Lists every tab on a known AI host, whether an id could be derived, and
   * why not. Nothing here changes state.
   */
  async diagnose() {
    const all = await chrome.tabs.query({});
    const snapshot = await snapshotEnvironment();
    const known = ['chatgpt.com', 'chat.openai.com', 'arena.ai', 'www.arena.ai', 'chat.deepseek.com', 'deepseek.com'];

    const candidates = all
      .filter((t) => {
        try { return known.includes(new URL(t.url || '').host.toLowerCase()); } catch { return false; }
      })
      .map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: Boolean(t.active) }));

    const resolved = Object.fromEntries(
      Object.entries(snapshot.surfaces ?? {}).map(([k, v]) => [k, {
        tabId: v.tabId, url: v.url, conversationId: v.conversationId,
        usable: Boolean(v.conversationId),
      }]),
    );

    /*
     * `invisible` is the count of tabs the extension cannot read at all --
     * host permissions were not granted, so `url` comes back empty. That is a
     * completely different problem from "no matching tab", and conflating the
     * two sent the last diagnosis down the wrong path.
     */
    const invisible = all.filter((t) => !t.url).length;

    logger.log('config-loaded', {
      source: 'system',
      description: `Diagnostics: ${all.length} tabs, ${candidates.length} on AI hosts, ${invisible} unreadable`,
      data: { candidates, resolved, invisible },
    });
    broadcast();
    return { tabsTotal: all.length, invisible, candidates, resolved, expectedHosts: EXPECTED_HOSTS };
  },

  /** Analytics for the dashboard. Derived; never fabricated. */
  async analytics() {
    return analyse(projectStore.iterations, {
      run: projectStore.run,
      events: logger.live,
    });
  },

  /** Iteration history, for the history view. */
  async history() {
    return {
      project: projectStore.project,
      run: projectStore.run,
      iterations: projectStore.iterations,
      runs: await projectStore.listRuns(),
      state: projectStore.state(),
      resumability: projectStore.resumability(),
      diagnostics: projectStore.diagnostics,
    };
  },

  /** Replay a stored session without contacting anything. */
  async replay() {
    await logger.flush();
    /*
     * Fall back to the LIVE view when durable storage is unavailable.
     *
     * Replay's whole purpose is inspecting a run after the fact, and the
     * moment a user most wants it is when something went wrong -- which is
     * correlated with storage having failed. Returning an error envelope then
     * would deny them the in-memory events they still have. Degraded is
     * reported, not silently substituted.
     */
    let events;
    let durable = true;
    try {
      events = await sink.all();
    } catch (err) {
      durable = false;
      events = logger.live;
      logger.log('error', {
        status: 'warning',
        source: 'system',
        description: `Replaying from memory only — durable log unavailable: ${reason(err)}`,
      });
    }
    const { final, checkpoints } = replay(events, { keepFrames: false });
    return { final, checkpoints, narrative: narrate(events), events: events.length, durable };
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
