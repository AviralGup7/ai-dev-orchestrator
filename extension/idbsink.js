/**
 * THE DURABLE LOG SINK, for real.
 *
 * Tier 1 of the two-tier log. This is the reason "never silently discard
 * events" is achievable at all: `chrome.storage.local` is capped at 10 MB and
 * is a key/value store that must be rewritten wholesale, which for a
 * 60,000-event log means reading and re-serialising megabytes on every flush.
 * IndexedDB appends, and with `unlimitedStorage` it is bounded by disk.
 *
 * It lives in `extension/` rather than `src/core/` because IndexedDB is a
 * browser API and the core is contractually browser-free. The engine gets the
 * interface; the browser gets the implementation.
 */

const DB = 'orchestrator-log';
const STORE = 'events';
const VERSION = 1;

export class IdbLogSink {
  constructor({ name = DB } = {}) {
    this.name = name;
    this._db = null;
  }

  async _open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          /*
           * Keyed by the event id, which is `evt-<session>-<000123>`.
           *
           * A string key rather than autoIncrement, deliberately: the id is
           * already unique and already sorts in emission order, so IndexedDB's
           * natural key order IS the timeline. An autoIncrement key would be a
           * second ordering that could disagree with the first after a crash
           * and replay, and then "which one is the real sequence?" has no good
           * answer.
           */
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('session', 'id');
          store.createIndex('at', 'at');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  /**
   * Append a batch in ONE transaction.
   *
   * All-or-nothing on purpose. A partial write leaves the log with a hole in
   * the middle and no indication that anything is missing -- which is worse
   * than failing loudly, because the Logger's retry path can recover from a
   * rejected batch but cannot recover from one it believes succeeded.
   */
  async append(batch) {
    if (!batch.length) return;
    const db = await this._open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of batch) store.put(e);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('log write aborted (quota?)'));
    });
  }

  async all() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Newest N, for restoring the live view after a service-worker restart. */
  async recent(n = 500) {
    const all = await this.all();
    return all.slice(-n);
  }

  async count() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async clear() {
    const db = await this._open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

/**
 * Persistence for the orchestrator's memory (not the log).
 *
 * `chrome.storage.local` is right here and wrong for the log: memory is a
 * single small object rewritten at every phase boundary, which is exactly the
 * shape key/value storage is good at.
 */
export class ChromeStore {
  constructor({ key = 'orchestrator-memory' } = {}) {
    this.key = key;
    this.writes = 0;
  }

  async load() {
    const got = await chrome.storage.local.get(this.key);
    return got?.[this.key] ?? null;
  }

  async save(memory) {
    this.writes++;
    await chrome.storage.local.set({ [this.key]: memory });
  }

  async clear() {
    await chrome.storage.local.remove(this.key);
  }
}
