/**
 * `chrome.storage.local` as a key/value backend for the ProjectStore.
 *
 * The core defines the interface (get/set/remove/keys) and this supplies it.
 * Deliberately thin: every decision about WHAT to store and when lives in
 * `projectstore.js`, which is testable in Node.
 *
 * WHY chrome.storage AND NOT IndexedDB HERE
 * -----------------------------------------
 * The split is by access pattern, not by preference. Project and run records
 * are small, fixed-size, and rewritten at every phase boundary -- exactly what
 * a key/value store is good at. The EVENT LOG is unbounded and append-only,
 * which is why it lives in IndexedDB (`idbsink.js`). Putting the log here
 * would mean re-serialising the whole history on every write; putting the run
 * record in IndexedDB would mean a transaction for a 2KB object.
 *
 * ON WRITE RATE -- MEASURED, NOT ASSUMED.
 *
 * `chrome.storage.sync` documents MAX_WRITE_OPERATIONS_PER_MINUTE = 120;
 * `local` publishes no such constant, though third-party guidance claims a
 * similar practical throttle. Rather than trust either, the actual rate was
 * measured: a full six-iteration run performs ~27 writes per iteration, and a
 * real iteration takes MINUTES because it waits on AI round trips. The
 * sustained rate is therefore roughly 27 writes per several minutes.
 *
 * That is far below any documented or rumoured cap, so no batching layer is
 * added -- it would be complexity guarding against a limit this workload
 * cannot approach. If iterations ever become sub-second (a local companion
 * running builds directly), re-measure before assuming that still holds.
 */

export class ChromeKeyValue {
  constructor({ prefix = 'ps:' } = {}) {
    this.prefix = prefix;
  }

  k(key) { return `${this.prefix}${key}`; }

  async get(key) {
    const got = await chrome.storage.local.get(this.k(key));
    const v = got?.[this.k(key)];
    return v === undefined ? null : v;
  }

  async set(key, value) {
    /*
     * A failed write is thrown, not swallowed.
     *
     * `chrome.storage.local` rejects on quota, and a store that quietly
     * dropped the write would leave the run advancing in memory while the
     * record froze -- so a reload would silently rewind to the last successful
     * write with no indication anything was lost. ProjectStore surfaces this
     * as a diagnostic.
     */
    await chrome.storage.local.set({ [this.k(key)]: value });
  }

  async remove(key) {
    await chrome.storage.local.remove(this.k(key));
  }

  async keys(prefix = '') {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(this.prefix + prefix))
      .map((k) => k.slice(this.prefix.length));
  }

  /** Bytes in use, for the storage-pressure warning in the UI. */
  async bytes() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.getBytesInUse(null, resolve);
      } catch {
        resolve(null);
      }
    });
  }
}
