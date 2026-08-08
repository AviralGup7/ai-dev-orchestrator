/**
 * THE PROJECT STORE — persistence with a shape, a version, and a repair path.
 *
 * `MemoryStore` reads and writes one blob. That is right for the engine's
 * working state and wrong for the product's record, for the reason §5 gives:
 * an ever-growing event log inside one `chrome.storage.local` value means
 * every write re-serialises the entire history, and the cost grows with the
 * run until a fifty-iteration project is spending seconds per phase boundary
 * rewriting megabytes.
 *
 * SO THE RECORD IS SPLIT BY LIFETIME AND WRITE FREQUENCY
 *
 *   project      small, written rarely            key/value
 *   run          small, written per phase         key/value
 *   iteration    grows, written once then frozen  one record each
 *   events       unbounded, append-only           IndexedDB (logsink)
 *
 * An iteration is written while it is in flight and never touched again once
 * finished, so the total write cost per phase is bounded by the size of ONE
 * iteration rather than the whole run.
 *
 * PURE. The backend is injected -- a `KeyValue` with get/set/remove/keys. The
 * browser implementation lives in `extension/idbsink.js`.
 */

import {
  SCHEMA_VERSION, makeProject, makeRun, makeSession, makeIteration,
  toMemory, fromMemory, resumability, describeState, endActive, beginActive,
} from './session.js';
import { migrate, checkIntegrity } from './migrate.js';

const K = {
  index: 'idx',                       // { projects: [...], activeProjectId }
  project: (id) => `prj:${id}`,
  run: (id) => `run:${id}`,
  iteration: (id) => `itr:${id}`,
  session: (id) => `ses:${id}`,
};

/** In-memory key/value backend. Test double and dry-run implementation. */
export class MemoryKeyValue {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
    this.writes = 0;
    this.reads = 0;
  }

  async get(key) {
    this.reads++;
    const v = this.data.get(key);
    return v === undefined ? null : structuredClone(v);
  }

  async set(key, value) {
    this.writes++;
    this.data.set(key, structuredClone(value));
  }

  async remove(key) {
    this.data.delete(key);
  }

  async keys(prefix = '') {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** A backend that fails on demand, for the recovery tests. */
export class FlakyKeyValue extends MemoryKeyValue {
  constructor({ failWrites = 0, failReads = 0 } = {}) {
    super();
    this.failWrites = failWrites;
    this.failReads = failReads;
  }

  async set(key, value) {
    if (this.failWrites > 0) { this.failWrites--; throw new Error('QuotaExceededError'); }
    return super.set(key, value);
  }

  async get(key) {
    if (this.failReads > 0) { this.failReads--; throw new Error('storage unavailable'); }
    return super.get(key);
  }
}

/* ========================================================================== *
 * THE STORE
 * ========================================================================== */

export class ProjectStore {
  /**
   * @param {object} deps
   * @param {object} deps.kv                key/value backend
   * @param {(e:object)=>void} [deps.onEvent]
   */
  constructor({ kv, onEvent = () => {} } = {}) {
    this.kv = kv;
    this.onEvent = onEvent;
    this.project = null;
    this.run = null;
    this.session = null;
    this.iterations = [];
    /** Problems found while loading. Surfaced, never swallowed. */
    this.diagnostics = [];
  }

  /* ------------------------------------------------------------- loading - */

  /**
   * Load the active project, migrating and repairing as needed.
   *
   * Returns diagnostics rather than throwing. A user whose stored project is
   * damaged needs the extension to open and TELL them; an exception at startup
   * gives them a dead extension and no explanation.
   */
  async load() {
    this.diagnostics = [];
    let index;
    try {
      index = (await this.kv.get(K.index)) || { projects: [], activeProjectId: null };
    } catch (err) {
      this.diagnostics.push({ severity: 'error', message: `storage unreadable: ${String(err?.message || err)}` });
      return { ok: false, diagnostics: this.diagnostics };
    }

    if (!index.activeProjectId) return { ok: true, empty: true, diagnostics: this.diagnostics };

    const rawProject = await this.kv.get(K.project(index.activeProjectId));
    const m = migrate(rawProject);
    if (!m.ok) {
      /*
       * A project that cannot be migrated is KEPT under a quarantine key.
       *
       * Deleting it would destroy the user's history to make our code path
       * simpler, and the most likely cause -- data from a newer build -- is
       * fully recoverable by updating the extension.
       */
      await this.kv.set(`quarantine:${index.activeProjectId}:${Date.now()}`, m.original ?? rawProject);
      this.diagnostics.push({
        severity: 'error',
        message: `the stored project could not be loaded (${m.problems.join('; ')}). It has been kept, not deleted.`,
      });
      return { ok: false, diagnostics: this.diagnostics };
    }

    /*
     * A v2 migration returns the whole state, because splitting one blob into
     * project+run+iterations cannot be expressed as a project alone.
     */
    if (m.data?.project && m.data?.run) {
      this.project = m.data.project;
      this.run = m.data.run;
      this.iterations = m.data.iterations ?? [];
      if (m.steps.length) {
        this.diagnostics.push({ severity: 'info', message: `migrated stored data ${m.steps.join(', ')}` });
        await this.saveAll();
      }
    } else {
      this.project = m.data;
      this.run = this.project.activeRunId ? await this.loadMigrated(K.run(this.project.activeRunId)) : null;
      this.iterations = [];
      for (const id of this.run?.iterationIds ?? []) {
        const it = await this.loadMigrated(K.iteration(id));
        if (it) this.iterations.push(it);
        else this.diagnostics.push({ severity: 'warning', message: `iteration ${id} is missing from storage` });
      }
      this.iterations.sort((a, b) => a.n - b.n);
    }

    const integrity = checkIntegrity({ project: this.project, run: this.run, iterations: this.iterations });
    for (const p of integrity.problems) this.diagnostics.push({ severity: 'error', message: p });
    for (const r of integrity.repairs) this.diagnostics.push({ severity: 'warning', message: r });

    /*
     * A run recorded as `running` at load time was interrupted, by definition:
     * nothing can be running when nothing is loaded yet. Recording it as
     * paused makes the UI honest and the resume explicit.
     */
    if (this.run?.state === 'running') {
      this.run.state = 'paused';
      this.run.stopDetail = 'interrupted — the extension restarted while this run was active';
      this.diagnostics.push({ severity: 'warning', message: 'the previous session ended mid-run; the run is paused' });
      await this.saveRun();
    }

    return { ok: true, diagnostics: this.diagnostics, state: this.state() };
  }

  async loadMigrated(key) {
    const raw = await this.kv.get(key);
    if (!raw) return null;
    const m = migrate(raw);
    if (!m.ok) {
      this.diagnostics.push({ severity: 'error', message: `${key}: ${m.problems.join('; ')}` });
      return null;
    }
    return m.data;
  }

  /* ------------------------------------------------------------ creating - */

  async createProject({ scope, mode, name } = {}) {
    this.project = makeProject({ scope, mode, name });
    this.iterations = [];
    this.run = null;
    await this.kv.set(K.project(this.project.id), this.project);
    const index = (await this.kv.get(K.index)) || { projects: [] };
    index.projects = [...new Set([...(index.projects || []), this.project.id])];
    index.activeProjectId = this.project.id;
    await this.kv.set(K.index, index);
    this.onEvent({ type: 'project-loaded', description: `Created project ${this.project.id}` });
    return this.project;
  }

  async startRun({ config = {}, mode } = {}) {
    if (!this.project) throw new Error('no project loaded');
    this.run = makeRun({ projectId: this.project.id, config, mode: mode ?? this.project.mode });
    beginActive(this.run);
    this.run.state = 'running';
    this.project.activeRunId = this.run.id;
    this.project.runIds = [...new Set([...(this.project.runIds || []), this.run.id])];
    this.iterations = [];
    await this.saveRun();
    await this.saveProject();
    return this.run;
  }

  async startSession() {
    /*
     * Detect how the PREVIOUS session ended before starting a new one.
     *
     * A session that was evicted never wrote `endedAt` -- it had no chance.
     * The only way to observe an eviction is for the next session to find the
     * gap, which is why this belongs at startup rather than shutdown.
     */
    const prevId = (await this.kv.get('lastSessionId'));
    if (prevId) {
      const prev = await this.kv.get(K.session(prevId));
      if (prev && !prev.endedAt) {
        prev.endedBy = 'evicted';
        prev.endedAt = prev.startedAt;
        await this.kv.set(K.session(prevId), prev);
        this.diagnostics.push({ severity: 'info', message: 'the previous session was evicted rather than closed' });
      }
    }

    this.session = makeSession({ runId: this.run?.id ?? null, projectId: this.project?.id ?? null });
    await this.kv.set(K.session(this.session.id), this.session);
    await this.kv.set('lastSessionId', this.session.id);
    if (this.run) {
      this.run.sessionIds = [...(this.run.sessionIds || []), this.session.id].slice(-50);
      await this.saveRun();
    }
    return this.session;
  }

  async endSession(reason = 'clean') {
    if (!this.session) return;
    this.session.endedAt = Date.now();
    this.session.endedBy = reason;
    await this.kv.set(K.session(this.session.id), this.session);
  }

  async beginIteration(n) {
    /*
     * IDEMPOTENT. Resuming mid-iteration must reuse the existing record, not
     * append a second one -- otherwise the history grows a duplicate every
     * time the worker is evicted, and `detect.js` sees repeated objectives
     * that never happened.
     */
    const existing = this.iterations.find((i) => i.n === n && !i.finishedAt);
    if (existing) return existing;

    const it = makeIteration({ runId: this.run.id, projectId: this.project.id, n });
    this.iterations.push(it);
    this.run.iterationIds = [...new Set([...(this.run.iterationIds || []), it.id])];
    await this.saveIteration(it);
    await this.saveRun();
    return it;
  }

  /* -------------------------------------------------------------- saving - */

  async saveProject() {
    if (!this.project) return;
    this.project.updatedAt = Date.now();
    this.project.schemaVersion = SCHEMA_VERSION;
    await this.kv.set(K.project(this.project.id), this.project);
  }

  async saveRun() {
    if (!this.run) return;
    this.run.updatedAt = Date.now();
    this.run.schemaVersion = SCHEMA_VERSION;
    await this.kv.set(K.run(this.run.id), this.run);
  }

  async saveIteration(it) {
    if (!it) return;
    it.schemaVersion = SCHEMA_VERSION;
    await this.kv.set(K.iteration(it.id), it);
  }

  /** Write everything. Used after a migration and on explicit checkpoints. */
  async saveAll() {
    await this.saveProject();
    await this.saveRun();
    for (const it of this.iterations) await this.saveIteration(it);
    const index = (await this.kv.get(K.index)) || { projects: [] };
    index.projects = [...new Set([...(index.projects || []), this.project?.id].filter(Boolean))];
    index.activeProjectId = this.project?.id ?? null;
    await this.kv.set(K.index, index);
  }

  /**
   * Persist only what a phase boundary changed.
   *
   * The whole reason for splitting the record: a phase writes the run (small,
   * fixed size) and the current iteration (bounded), never the full history.
   */
  async checkpoint(iteration) {
    await this.saveRun();
    if (iteration) await this.saveIteration(iteration);
  }

  /* ------------------------------------------------------------ reporting */

  state() {
    return describeState({ project: this.project, run: this.run, iterations: this.iterations });
  }

  resumability() {
    return resumability(this.run);
  }

  /** The engine's working state, projected from the record. */
  toMemory() {
    return toMemory(this.project, this.run, this.iterations);
  }

  /** Fold the engine's working state back in. */
  absorb(memory, iteration) {
    return fromMemory(memory, { project: this.project, run: this.run, iteration });
  }

  async stopRun(reason, detail) {
    if (!this.run) return;
    endActive(this.run);
    this.run.state = reason === 'user-stopped' ? 'stopped' : 'stopped';
    this.run.stopReason = reason;
    this.run.stopDetail = detail ?? null;
    this.run.endedAt = Date.now();
    await this.saveRun();
  }

  /** Every run of this project, for the history view. */
  async listRuns() {
    if (!this.project) return [];
    const out = [];
    for (const id of this.project.runIds ?? []) {
      const r = await this.loadMigrated(K.run(id));
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }
}

/**
 * A `MemoryStore`-compatible facade.
 *
 * The Orchestrator takes a store with `load()`/`save(memory)`. Rather than
 * changing the engine and its 247 tests (§35), the ProjectStore is wrapped to
 * present that interface, projecting on read and absorbing on write.
 */
export class ProjectMemoryStore {
  constructor(projectStore) {
    this.ps = projectStore;
    this.writes = 0;
  }

  async load() {
    return this.ps.project ? this.ps.toMemory() : null;
  }

  async save(memory) {
    this.writes++;
    const n = memory.history?.length ? memory.history[memory.history.length - 1].n : memory.iteration;
    const iteration = this.ps.iterations.find((i) => i.n === n) ?? null;
    this.ps.absorb(memory, iteration);
    await this.ps.checkpoint(iteration);
  }

  async clear() {
    this.ps.project = null;
    this.ps.run = null;
    this.ps.iterations = [];
  }
}
