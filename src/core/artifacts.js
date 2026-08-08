/**
 * FILE AND ARTIFACT MANAGEMENT.
 *
 * §19: downloads associated with project/run/iteration/phase, metadata kept,
 * duplicates avoided, interrupted downloads handled, collisions handled, and
 * -- the sharp one -- "do not assume downloads completed merely because a
 * browser action returned."
 *
 * THAT LAST POINT IS THE WHOLE DESIGN
 * -----------------------------------
 * `chrome.downloads.download()` resolves with an id the moment the download is
 * ACCEPTED, not when it lands. A network drop, a full disk, or the user
 * cancelling all happen afterwards, and the promise has already resolved
 * happily. A registry that marks a file "downloaded" on that promise is
 * recording an intention as a fact -- the same class of error as treating an
 * AI's claim as evidence, which is the mistake this whole project is organised
 * against.
 *
 * So an artifact moves through states, and only an observed completion counts:
 *
 *   requested -> in-progress -> complete
 *                            -> interrupted
 *                            -> cancelled
 *
 * PURE. The downloader is injected; `extension/downloads.js` supplies the real
 * one.
 */

export const ARTIFACT_STATES = /** @type {const} */ ([
  'requested', 'in-progress', 'complete', 'interrupted', 'cancelled',
]);

/** Classify by extension, for the UI and for deciding what is parseable. */
export function classify(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (['md', 'markdown', 'txt'].includes(ext)) return 'report';
  if (['json', 'ndjson'].includes(ext)) return 'data';
  if (['zip', 'tar', 'gz', 'tgz'].includes(ext)) return 'archive';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'screenshot';
  if (['xml', 'junit', 'lcov', 'info'].includes(ext)) return 'test-report';
  if (['log'].includes(ext)) return 'log';
  return 'other';
}

/**
 * Make a filename unique and traceable.
 *
 * Prefixing with run and iteration means a folder of forty downloads is
 * readable without a database, and -- more importantly -- two iterations that
 * both produce `report.md` do not overwrite each other. Browsers resolve
 * collisions by appending "(1)", which silently decouples the file on disk
 * from the name in the record.
 */
export function safeName(filename, { runId, iteration }) {
  /*
   * Strip path traversal BEFORE sanitising separators.
   *
   * Replacing `/` with `-` first turns `../../etc/passwd` into
   * `..-..-etc-passwd` -- harmless on disk but a filename that still reads as
   * an escape attempt, and one that depends entirely on the browser treating
   * `-` as literal. Removing the segments is the honest fix: take the LAST
   * path component and drop any leading dots.
   */
  const last = String(filename).split(/[/\\]/).filter((p) => p && p !== '.' && p !== '..').pop() ?? 'artifact';
  const base = last.replace(/^\.+/, '').replace(/[?%*:|"<>]/g, '-').slice(-120) || 'artifact';
  const shortRun = String(runId ?? 'run').split('-').pop();
  return `orchestrator/${shortRun}/i${String(iteration ?? 0).padStart(3, '0')}-${base}`;
}

export class ArtifactRegistry {
  /**
   * @param {object} deps
   * @param {object} [deps.downloader] `{ download(url, filename), probe(id) }`
   * @param {(e:object)=>void} [deps.onEvent]
   */
  constructor({ downloader = null, onEvent = () => {} } = {}) {
    this.downloader = downloader;
    this.onEvent = onEvent;
    this.items = [];
    /** filename+iteration -> artifact, for duplicate suppression. */
    this._byKey = new Map();
  }

  key(filename, iteration) {
    return `${iteration ?? '-'}::${filename}`;
  }

  /**
   * Register an artifact the engineer says it produced.
   *
   * `requested` only. Nothing is claimed about the file existing until the
   * downloader says otherwise.
   */
  register({ filename, url = null, projectId, runId, iteration, phase = 'execute', sha = null }) {
    const k = this.key(filename, iteration);

    /*
     * DUPLICATE SUPPRESSION IS PER ITERATION, not global.
     *
     * A run that produces `report.md` every iteration is producing forty
     * different reports, and deduplicating globally would keep only the first
     * -- discarding thirty-nine real artifacts. Deduplicating within an
     * iteration catches the actual problem: the same file mentioned twice in
     * one response, or a retried phase requesting it again.
     */
    const existing = this._byKey.get(k);
    if (existing) {
      this.onEvent({ type: 'artifact-duplicate', filename, iteration, artifactId: existing.id });
      return existing;
    }

    const artifact = {
      id: `art-${Date.now().toString(36)}-${this.items.length}`,
      filename,
      safeName: safeName(filename, { runId, iteration }),
      kind: classify(filename),
      url,
      sha,
      projectId,
      runId,
      iteration,
      phase,
      state: 'requested',
      requestedAt: Date.now(),
      completedAt: null,
      bytes: null,
      downloadId: null,
      error: null,
      attempts: 0,
    };
    this.items.push(artifact);
    this._byKey.set(k, artifact);
    this.onEvent({ type: 'file-associated', filename, iteration, artifactId: artifact.id, kind: artifact.kind });
    return artifact;
  }

  /**
   * Attempt the download and then VERIFY it.
   *
   * The two steps are separate because the first one lies. `download()`
   * resolving means the browser accepted the request; only `probe()` can say
   * whether bytes arrived.
   */
  async fetch(artifact) {
    if (!this.downloader) {
      artifact.state = 'interrupted';
      artifact.error = 'no downloader is configured';
      return artifact;
    }
    if (artifact.state === 'complete') return artifact;

    artifact.attempts++;
    artifact.state = 'in-progress';
    this.onEvent({ type: 'file-download-started', filename: artifact.filename, artifactId: artifact.id });

    try {
      const id = await this.downloader.download(artifact.url, artifact.safeName);
      artifact.downloadId = id;

      const status = await this.downloader.probe(id);
      if (status?.state === 'complete') {
        artifact.state = 'complete';
        artifact.completedAt = Date.now();
        artifact.bytes = status.bytes ?? null;
        /*
         * A "complete" download of zero bytes is not complete. It is the
         * shape a cancelled or blocked download takes, and accepting it would
         * put an empty file in the record as though it were a report.
         */
        if (artifact.bytes === 0) {
          artifact.state = 'interrupted';
          artifact.error = 'the file downloaded as zero bytes';
        }
      } else {
        artifact.state = status?.state === 'interrupted' ? 'interrupted' : 'in-progress';
        artifact.error = status?.error ?? null;
      }
    } catch (err) {
      artifact.state = 'interrupted';
      artifact.error = String(err?.message || err);
    }

    this.onEvent({
      type: artifact.state === 'complete' ? 'file-downloaded' : 'file-download-failed',
      filename: artifact.filename,
      artifactId: artifact.id,
      state: artifact.state,
      bytes: artifact.bytes,
      error: artifact.error,
    });
    return artifact;
  }

  /** Retry the interrupted ones. Bounded; an unavailable file stays that way. */
  async retryInterrupted({ maxAttempts = 3 } = {}) {
    const out = [];
    for (const a of this.items) {
      if (a.state === 'interrupted' && a.attempts < maxAttempts && a.url) out.push(await this.fetch(a));
    }
    return out;
  }

  forIteration(n) {
    return this.items.filter((a) => a.iteration === n);
  }

  /** What the UI shows, and what the session summary counts. */
  summary() {
    const by = (s) => this.items.filter((a) => a.state === s).length;
    return {
      total: this.items.length,
      complete: by('complete'),
      interrupted: by('interrupted'),
      pending: by('requested') + by('in-progress'),
      bytes: this.items.reduce((n, a) => n + (a.bytes ?? 0), 0),
      /*
       * Reported separately rather than folded into `complete`. "Nine of
       * twelve artifacts arrived" is a fact the user should see; a bare
       * "12 artifacts" would imply all of them did.
       */
      unverified: this.items.filter((a) => a.state !== 'complete').map((a) => a.filename),
    };
  }

  toJSON() {
    return this.items.map((a) => ({ ...a }));
  }

  static from(items = [], deps = {}) {
    const r = new ArtifactRegistry(deps);
    r.items = items.map((a) => ({ ...a }));
    for (const a of r.items) r._byKey.set(r.key(a.filename, a.iteration), a);
    return r;
  }
}
