/**
 * Persistence.
 *
 * Two implementations behind one interface, for the same reason the adapters
 * exist: the engine must not know whether it is running in a browser or in a
 * test. `MemoryStore` is the test double; `ChromeStore` is the real one and is
 * the ONLY file in src/core that may mention `chrome` -- see the exemption in
 * tools/check-purity.mjs.
 */

/** In-memory. Used by tests and by a dry run. */
export class MemoryStore {
  constructor(initial = null) {
    this.data = initial;
    this.writes = 0;
  }

  async load() {
    return this.data ? structuredClone(this.data) : null;
  }

  async save(memory) {
    this.writes++;
    // Cloned on write: the engine mutates its own copy freely, and a store
    // that held a live reference would make "persisted" and "in memory"
    // indistinguishable -- which would hide a missing save() in every test.
    this.data = structuredClone(memory);
  }

  async clear() {
    this.data = null;
  }
}
