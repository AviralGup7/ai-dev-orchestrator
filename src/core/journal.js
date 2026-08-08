/**
 * THE LOG THE USER ASKED TO BE ABLE TO COPY AND PASTE.
 *
 * Requirement, verbatim: "make sure to keep a very detailed log of everything
 * in md file i can copy paste to improve extension."
 *
 * That last clause changes the design. This is not an audit trail for
 * compliance and it is not a debug dump -- it is INPUT TO THE NEXT DEVELOPMENT
 * SESSION, pasted into a chat window. So it optimises for three things a
 * normal logger does not care about:
 *
 *   1. It must fit in a context window. Unbounded logs get truncated by the
 *      chat client, silently, from the top -- and the top is where the setup
 *      and the first failure live. So the journal is capped and drops the
 *      middle, marking what it dropped.
 *   2. It must be readable without the code in front of you. Every environment
 *      failure carries its remedy inline.
 *   3. It must never contain a secret. Anything pasted into a chat is
 *      published. `redact()` runs over every rendered value, not just the ones
 *      that looked risky when this was written.
 *
 * PURE. It renders records; it does not collect them.
 */

/**
 * Patterns for things that must never reach a chat window.
 *
 * Deliberately broader than "tokens we use". The journal renders scraped AI
 * output, and an AI asked to fix a build will happily echo an .env file back.
 */
const SECRETS = [
  [/\bghp_[A-Za-z0-9_]{10,}/g, '[REDACTED:github-pat]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, '[REDACTED:github-pat]'],
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, '[REDACTED:google-oauth-secret]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED:jwt]'],
  // A URL with credentials in it: https://user:token@host/...
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [re, with_] of SECRETS) out = out.replace(re, with_);
  return out;
}

const ICON = {
  'run-started': '▶',
  'run-stopped': '■',
  'run-paused': '❚❚',
  'iteration-started': '▸',
  'iteration-finished': '✓',
  'iteration-failed': '✗',
  planned: '·',
  executed: '·',
  evaluated: '·',
  reviewed: '·',
  'stagnation-detected': '⟳',
  'strategy-changed': '⇄',
  'environment-drift': '⛔',
  'environment-bound': '🔗',
  'action-started': ' ',
  'action-finished': ' ',
  'action-failed': '!',
};

/**
 * Collects events and renders markdown.
 *
 * @param {object} [options]
 * @param {number} [options.limit]  max events retained
 */
export class Journal {
  constructor({ limit = 2000 } = {}) {
    this.limit = limit;
    this.events = [];
    this.dropped = 0;
  }

  /** Wire this straight into `Orchestrator({ onEvent })`. */
  record = (event) => {
    this.events.push(event);
    if (this.events.length > this.limit) {
      /*
       * DROP FROM THE MIDDLE, NOT THE FRONT.
       *
       * The default ring-buffer behaviour keeps the most recent N, which for
       * this purpose is the worst possible choice: the beginning of a run
       * contains the binding, the scope, and usually the first symptom of
       * whatever went wrong. A log that has forgotten how the run started
       * cannot be used to improve the extension, which is the only reason it
       * exists.
       */
      const keepHead = Math.floor(this.limit * 0.25);
      const keepTail = this.limit - keepHead;
      this.dropped += this.events.length - this.limit;
      this.events = [...this.events.slice(0, keepHead), ...this.events.slice(-keepTail)];
    }
  };

  /** @returns {string} markdown */
  render(memory = null, binding = null) {
    const L = [];
    const t0 = this.events[0]?.at;

    L.push('# AI Development Orchestrator — Run Log');
    L.push('');
    L.push(`_Generated ${new Date().toISOString()} · ${this.events.length} events` +
      (this.dropped ? ` · ${this.dropped} dropped from the middle_` : '_'));
    L.push('');

    /* ---- environment ------------------------------------------------- */
    L.push('## Environment (pre-initiated — not created by the orchestrator)');
    L.push('');
    if (binding?.surfaces && Object.keys(binding.surfaces).length) {
      L.push('| Role | Tab | Host | Conversation | Title |');
      L.push('|---|---|---|---|---|');
      for (const [key, s] of Object.entries(binding.surfaces)) {
        L.push(`| ${key} | ${s.tabId} | ${s.host} | \`${redact(s.conversationId)}\` | ${redact(s.title).slice(0, 60)} |`);
      }
    } else {
      L.push('_No binding recorded — the run never started._');
    }
    L.push('');

    /* ---- outcome ----------------------------------------------------- */
    if (memory) {
      L.push('## Run state');
      L.push('');
      L.push(`- **Scope:** ${redact(memory.scope) || '_none_'}`);
      L.push(`- **Status:** \`${memory.status}\`` + (memory.stopReason ? ` (${memory.stopReason})` : ''));
      L.push(`- **Iterations completed:** ${memory.iteration}`);
      L.push(`- **Phase:** ${memory.phase}`);
      if (memory.block) {
        L.push(`- **Blocked:** ${redact(memory.block.detail)}`);
      }
      const last = memory.scores?.[memory.scores.length - 1];
      if (last) {
        L.push('');
        L.push('| Dimension | Score | Confidence | Basis |');
        L.push('|---|---:|---|---|');
        for (const s of last.scores) {
          const basis = (s.basis || []).map((b) => b.kind).join(', ') || '—';
          L.push(`| ${s.dimension} | ${s.score}% | ${s.confidence} | ${basis} |`);
        }
      }
      L.push('');
    }

    /* ---- blocking problems, first, because they are why you are reading */
    const drift = this.events.filter((e) => e.type === 'environment-drift');
    if (drift.length) {
      L.push('## ⛔ Environment problems (run halted, awaiting the user)');
      L.push('');
      for (const d of drift) {
        for (const p of d.problems || []) {
          L.push(`- **${p.label || p.surface}** — \`${p.kind}\`: ${redact(p.detail)}`);
          L.push(`  - _Remedy:_ ${p.remedy}`);
        }
      }
      L.push('');
      L.push('> The orchestrator did **not** attempt to recover. It never opens tabs, ' +
        'creates conversations, signs in, or navigates. Fix the environment above and resume.');
      L.push('');
    }

    /* ---- timeline ---------------------------------------------------- */
    L.push('## Timeline');
    L.push('');
    L.push('```');
    for (const e of this.events) {
      const dt = t0 ? `+${((e.at - t0) / 1000).toFixed(1)}s`.padStart(9) : '';
      const it = e.iteration != null ? `i${e.iteration}` : '  ';
      const icon = ICON[e.type] ?? '·';
      L.push(`${dt} ${it.padEnd(4)} ${icon} ${e.type}${detail(e)}`);
    }
    L.push('```');
    L.push('');

    /* ---- decisions --------------------------------------------------- */
    if (memory?.decisions?.length) {
      L.push('## Decisions and strategy changes');
      L.push('');
      for (const d of memory.decisions) {
        L.push(`- **i${d.iteration} ${d.kind}:** ${redact(d.text)}`);
        if (d.rationale) L.push(`  - _Why:_ ${redact(d.rationale)}`);
      }
      L.push('');
    }

    /* ---- iteration detail -------------------------------------------- */
    if (memory?.history?.length) {
      L.push('## Iterations');
      L.push('');
      for (const r of memory.history) {
        L.push(`### Iteration ${r.n}${r.error ? ' — FAILED' : ''}`);
        L.push('');
        L.push(`- **Objective:** ${redact(r.objective?.text) || '_none recorded_'}`);
        if (r.summary) L.push(`- **Engineer said:** ${redact(r.summary).slice(0, 500)}`);
        if (r.filesChanged?.length) {
          L.push(`- **Files changed (${r.filesChanged.length}):** ${r.filesChanged.slice(0, 20).map(redact).join(', ')}`);
        }
        if (r.evidence?.length) {
          L.push('- **Evidence:**');
          for (const ev of r.evidence) L.push(`  - \`${ev.kind}\` ${redact(summariseEvidence(ev))}`);
        }
        if (r.overall != null) L.push(`- **Overall:** ${r.overall}% (${r.confidence})`);
        if (r.signals?.length) L.push(`- **Loop signals:** ${r.signals.map((s) => s.kind ?? s).join(', ')}`);
        if (r.error) L.push(`- **Error:** ${redact(r.error)}`);
        L.push('');
      }
    }

    return L.join('\n');
  }
}

function summariseEvidence(ev) {
  const { kind, at, ...rest } = ev;
  return Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 80) : v}`)
    .join(' ');
}

function detail(e) {
  const skip = new Set(['type', 'at', 'iteration', 'problems']);
  const bits = Object.entries(e)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${redact(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 120)}`);
  return bits.length ? '  ' + bits.join(' ') : '';
}
