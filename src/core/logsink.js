/**
 * THE DURABLE LOG SINK.
 *
 * Tier 1 of the two-tier log: the system of record that never discards.
 * `MemoryLogSink` is the test double and the dry-run implementation;
 * `IdbLogSink` lives in the extension layer because IndexedDB is a browser
 * API and the core is contractually browser-free.
 *
 * The interface is deliberately two methods -- `append` and `all` -- because
 * anything richer would tempt the engine into querying storage mid-run, and a
 * log that the orchestrator READS is a log that can change its behaviour.
 * It writes. The UI reads.
 */

/** In-memory, unbounded. Used by tests and dry runs. */
export class MemoryLogSink {
  constructor() {
    this.events = [];
    this.appends = 0;
  }

  async append(batch) {
    this.appends++;
    this.events.push(...batch);
  }

  async all() {
    return [...this.events];
  }

  async clear() {
    this.events = [];
  }

  get size() {
    return this.events.length;
  }
}

/**
 * A sink that fails on demand. Test-only, and it earns its place: the "never
 * silently discard" guarantee is entirely about what happens when the write
 * fails, and that path cannot be exercised by a sink that always works.
 */
export class FlakyLogSink extends MemoryLogSink {
  constructor({ failFor = 0 } = {}) {
    super();
    this.remainingFailures = failFor;
  }

  async append(batch) {
    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      throw new Error('quota exceeded');
    }
    return super.append(batch);
  }
}

/* ========================================================================== *
 * EXPORT
 * ========================================================================== */

/**
 * Serialise the full log for download.
 *
 * NDJSON rather than a JSON array, and the reason is the failure case: a
 * 60,000-event array is one syntax error away from being entirely unreadable,
 * and the most likely time it gets truncated is a crash mid-write -- exactly
 * the log somebody needs. NDJSON degrades to "all lines up to the break".
 */
export function toNdjson(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** CSV for spreadsheet triage. Flat fields only; `data` is JSON in one cell. */
export function toCsv(events) {
  const cols = ['id', 'at', 'iso', 'type', 'channel', 'source', 'status', 'label', 'description', 'durationMs', 'iteration', 'phase', 'correlationId', 'data'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = events.map((e) =>
    cols.map((c) => esc(c === 'iso' ? new Date(e.at).toISOString() : e[c])).join(','),
  );
  return [cols.join(','), ...rows].join('\n') + '\n';
}
