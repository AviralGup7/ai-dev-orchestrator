#!/usr/bin/env node
/**
 * BUILD A LOADABLE EXTENSION.
 *
 * WHY THIS EXISTS — the bug it fixes
 * ----------------------------------
 * `extension/` was never a loadable extension. `background.js` imports
 * `../src/core/orchestrator.js`, which resolves ABOVE the directory Chrome was
 * pointed at. A service worker may not fetch a module outside its package
 * root, so registration failed with the maximally unhelpful:
 *
 *     Service worker registration failed. Status code: 3
 *     An unknown error occurred when fetching the script.
 *
 * Nothing was syntactically wrong — every file parses, all 200 tests pass, and
 * the demo bundle runs. The repository layout was simply not the layout Chrome
 * requires, and no check covered that because every other consumer (Node,
 * tests, the demo bundler) resolves `../` happily.
 *
 * The fix is not to flatten the source tree. `src/core` must stay outside
 * `extension/` — that separation is what `tools/check-purity.mjs` enforces and
 * what keeps the engine runnable in Node. Instead this assembles a `dist/`
 * where everything the browser needs lives under one root:
 *
 *     dist/
 *       manifest.json
 *       background.js  panel.js  ui.js  …      (from extension/)
 *       core/          orchestrator.js …       (from src/core/)
 *       icon16/48/128.png                      (generated, not downloaded)
 *
 * and rewrites `../src/core/x.js` to `./core/x.js` on the way through.
 *
 * Deterministic and code-generated: no network, no binary assets checked in.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = 'dist';

/* ---------------------------------------------------------------- reset -- */

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'core'), { recursive: true });

/* ----------------------------------------------------------- core files -- */

/**
 * Copy `src/core/*.js` verbatim.
 *
 * Verbatim matters: these are the files the tests exercise. Any transformation
 * here would mean the shipped engine is not the tested engine, which is the
 * kind of divergence that produces a bug reproducible only after packaging.
 */
/*
 * EVERY src/ subtree the extension imports, not just core.
 *
 * The first version copied `src/core` only. When adapters and transports were
 * added the build happily produced a dist/ whose background.js imported paths
 * that did not exist -- and `check-loadable.mjs` caught it, which is the
 * entire reason that checker exists. Listing the trees explicitly (rather than
 * globbing src/) keeps the shipped surface deliberate: anything new has to be
 * added here on purpose.
 */
const TREES = ['core', 'adapters', 'transports'];
const coreFiles = [];
const CROSS = /(['"])\.\.\/(core|adapters|transports)\/([A-Za-z0-9_.-]+\.js)\1/g;
for (const tree of TREES) {
  const dir = join('src', tree);
  if (!existsSync(dir)) continue;
  mkdirSync(join(OUT, tree), { recursive: true });
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    /*
     * `../adapters/base.js` from inside src/adapters resolves identically in
     * dist/adapters, so cross-tree imports survive the move unchanged. Copied
     * verbatim so the shipped engine is byte-for-byte the tested engine.
     */
    writeFileSync(join(OUT, tree, f), readFileSync(join(dir, f)));
    coreFiles.push(`${tree}/${f}`);
  }
}
void CROSS;

/* ------------------------------------------------------ extension files -- */

/**
 * Rewrite the one thing that cannot survive the move.
 *
 * `../src/core/x.js` -> `./core/x.js`. Narrow on purpose: a broad rewrite
 * would silently mangle a string that merely looked like a path, and the
 * failure would appear at runtime in a service worker with no console open.
 */
const REWRITE = /(['"])\.\.\/src\/(core|adapters|transports)\/([A-Za-z0-9_.-]+\.js)\1/g;

let rewrites = 0;
const extFiles = readdirSync('extension');
for (const f of extFiles) {
  const src = join('extension', f);
  if (f === 'manifest.template.json' || f.endsWith('.md')) continue; // template is emitted below
  if (f.endsWith('.js')) {
    const before = readFileSync(src, 'utf8');
    const after = before.replace(REWRITE, (_m, q, tree, name) => {
      rewrites++;
      return `${q}./${tree}/${name}${q}`;
    });
    writeFileSync(join(OUT, f), after);
  } else {
    writeFileSync(join(OUT, f), readFileSync(src));
  }
}

/* -------------------------------------------------------------- icons ---- */

/**
 * Generate PNG icons in code rather than committing binaries.
 *
 * `notifications.create` needs a real `iconUrl` and the action needs icons, so
 * their absence is not cosmetic — a missing icon file makes a notification
 * throw at the moment it is trying to tell the user something went wrong.
 *
 * A minimal, correct PNG encoder: RGBA, one IDAT, zlib via node:zlib. Roughly
 * forty lines and no dependency, which beats a build step that downloads an
 * image or an AI-generated asset that changes every run.
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const p = row + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: three stacked bars on a dark rounded square — the three AIs, and
 * the middle one lit, which is the orchestrator's whole job. Legible at 16px,
 * which is the only size that really matters in a toolbar.
 */
function draw(x, y, size) {
  const u = size / 16;
  const r = 3 * u;

  // rounded-square mask
  const cx = Math.min(x, size - 1 - x);
  const cy = Math.min(y, size - 1 - y);
  if (cx < r && cy < r && Math.hypot(r - cx, r - cy) > r) return [0, 0, 0, 0];

  const bars = [
    { y0: 3.5, y1: 5.5, w: 9.5, on: false },
    { y0: 7.0, y1: 9.0, w: 7.0, on: true },
    { y0: 10.5, y1: 12.5, w: 5.0, on: false },
  ];
  for (const b of bars) {
    if (y >= b.y0 * u && y < b.y1 * u && x >= 3.25 * u && x < (3.25 + b.w) * u) {
      return b.on ? [88, 166, 255, 255] : [139, 148, 158, 255];
    }
  }
  return [22, 27, 34, 255];
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), png(size, draw));
}

/* ------------------------------------------------------------ manifest --- */

/*
 * Read manifest.TEMPLATE.json.
 *
 * There is deliberately no `manifest.json` in extension/. Twice now the same
 * "status code 3" was reported because that folder was loaded instead of
 * dist/ -- and it was a reasonable mistake, because extension/ was the only
 * folder in the repo with a manifest in it, so it looked like the extension.
 *
 * Without a manifest, Chrome refuses extension/ with "Manifest file is missing
 * or unreadable", which names the problem. Making the wrong path fail clearly
 * beats documenting that it is the wrong path.
 */
const manifest = JSON.parse(readFileSync('extension/manifest.template.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/*
 * The manifest is the one file the build edits rather than copies.
 *
 * Version comes from package.json so the two cannot disagree — they already
 * had (manifest said 0.2.0, package.json said 0.3.0), which is exactly the
 * sort of drift that makes a bug report describe a build nobody can identify.
 */
manifest.version = pkg.version;
manifest.icons = { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' };
manifest.action = { ...manifest.action, default_icon: manifest.icons };

/*
 * `scripting` is KEPT now, and that is a reversal worth stating.
 *
 * It was stripped last session on the grounds that nothing called it and an
 * unused permission inflates the install prompt for no benefit. Surface
 * scanning calls it: `chrome.scripting.executeScript` is how a page is read
 * when an error happens. The reasoning has not changed -- ask for what is
 * used -- only the facts have.
 *
 * The build asserts the justification still holds rather than trusting the
 * comment, because the comment is what went stale last time.
 */
const usesScripting = readdirSync('extension')
  .filter((f) => f.endsWith('.js'))
  .some((f) => readFileSync(join('extension', f), 'utf8').includes('chrome.scripting'));
if (!usesScripting) {
  manifest.permissions = manifest.permissions.filter((p) => p !== 'scripting');
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

/* -------------------------------------------------------------- verify --- */

/**
 * VERIFY THE OUTPUT, because this whole file exists because something shipped
 * unverified.
 *
 * Every relative import in dist/ must resolve to a file that is also in dist/.
 * That is precisely the property Chrome enforces and that nothing else did.
 */
const problems = [];

function walk(dir, base = '') {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const rel = base ? `${base}/${f}` : f;
    if (readdirSync(dir, { withFileTypes: true }).find((d) => d.name === f)?.isDirectory()) {
      walk(p, rel);
    } else if (f.endsWith('.js')) {
      const code = readFileSync(p, 'utf8');
      for (const m of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('../') && !base) {
          problems.push(`${rel} imports "${spec}" — above the extension root; Chrome cannot fetch it`);
          continue;
        }
        const resolved = join(dir, spec);
        if (!existsSync(resolved)) problems.push(`${rel} imports "${spec}" — not present in dist/`);
      }
    }
  }
}
walk(OUT);

for (const html of readdirSync(OUT).filter((f) => f.endsWith('.html'))) {
  const code = readFileSync(join(OUT, html), 'utf8');
  for (const m of code.matchAll(/src=["']([^"']+)["']/g)) {
    if (!existsSync(join(OUT, m[1]))) problems.push(`${html} references "${m[1]}" — missing from dist/`);
  }
}

const m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
for (const rel of [
  m.background?.service_worker,
  m.action?.default_popup,
  m.side_panel?.default_path,
  ...Object.values(m.icons || {}),
]) {
  if (rel && !existsSync(join(OUT, rel))) problems.push(`manifest references "${rel}" — missing from dist/`);
}

if (problems.length) {
  console.error('dist/ is not loadable:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

const files = readdirSync(OUT).length + TREES.reduce((n, t) =>
  n + (existsSync(join(OUT, t)) ? readdirSync(join(OUT, t)).length : 0), 0);
console.log(`ok: dist/ built — ${files} files, ${coreFiles.length} src modules, ${rewrites} imports rewritten`);
console.log('   load it with chrome://extensions → Developer mode → Load unpacked → select dist/');
