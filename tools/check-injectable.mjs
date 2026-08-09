/**
 * INJECTED FUNCTIONS MUST NOT REFERENCE MODULE SCOPE.
 *
 * `chrome.scripting.executeScript({ func })` SERIALISES the function and
 * re-evaluates it inside the page. The official reference states it plainly:
 * "any bound parameters and execution context will be lost." A module-level
 * helper the function calls simply does not exist there.
 *
 * WHY THIS IS A BUILD CHECK AND NOT A TEST
 * ----------------------------------------
 * Tests import these functions normally, so the closure is intact and every
 * call resolves. The suite passed 46/46 with the bug present. Worse, the one
 * place it bit sits inside a `try { } catch { }` that would have swallowed the
 * ReferenceError into a null field — so even executing the serialised form
 * against a DOM stub did not reveal it.
 *
 * Only static analysis catches this reliably, because the failure is a
 * reference that may never be evaluated on the path a test happens to take.
 *
 * The rule has now been violated three times in this file — `fence`,
 * `selectors`, and `typeIn`/`pickFrom`/`composerEmptied` — each documented in
 * a comment immediately after the previous one. A comment is not enforcement.
 */
import { readFileSync } from 'node:fs';

/*
 * EVERY function passed as `func:` to executeScript, not just the two that
 * broke. `pageProbe` and `scanPage` are injected the same way and have already
 * each cost a session to the same rule -- `fence` and `selectors` respectively.
 */
const TARGETS = [
  { file: 'extension/dom-page.js', fns: ['pageType', 'pageClick'] },
  { file: 'src/transports/dom.js', fns: ['pageProbe'] },
  { file: 'extension/scan.js', fns: ['scanPage'] },
];

/** Names that legitimately exist inside a page. */
const GLOBALS = new Set([
  'document', 'window', 'navigator', 'location', 'console', 'setTimeout',
  'clearTimeout', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Math', 'JSON', 'Date', 'Error', 'RegExp', 'Set', 'Map', 'InputEvent',
  'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLTextAreaElement',
  'HTMLInputElement', 'getComputedStyle', 'Node', 'Element', 'NodeList',
]);

const problems = [];
let checked = 0;

for (const { file: FILE, fns } of TARGETS) {
const src = readFileSync(FILE, 'utf8');

/** Every function declared at module scope in THIS file. */
const moduleScope = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)]
  .map((m) => m[1]);

/** Extract one function's source by brace matching from its declaration. */
function bodyOf(name) {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const at = src.search(decl);
  if (at === -1) return null;
  let depth = 0; let started = false;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}') { depth--; if (started && depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

for (const name of fns) {
  checked++;
  const body = bodyOf(name);
  if (!body) { problems.push(`${name}: not found in ${FILE}`); continue; }

  /* Names declared INSIDE the function are fine. */
  const local = new Set([
    ...[...body.matchAll(/(?:const|let|var)\s+(\w+)/g)].map((m) => m[1]),
    ...[...body.matchAll(/function\s+(\w+)/g)].map((m) => m[1]),
    ...[...body.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)]
      .flatMap((m) => m[1].split(',').map((p) => p.trim().split(/[\s=]/)[0]).filter(Boolean)),
    name,
  ]);

  for (const other of moduleScope) {
    if (other === name || local.has(other)) continue;
    /* A call to a module-scope function, not a substring of a longer word. */
    if (new RegExp(`(?<![.\\w$])${other}\\s*\\(`).test(body)) {
      problems.push(
        `${name}() calls module-scope ${other}() — executeScript serialises ${name} `
        + `and ${other} will be "not defined" inside the page`,
      );
    }
  }

  /* Imported bindings are just as unreachable. */
  for (const m of src.matchAll(/^import\s+\{([^}]+)\}/gm)) {
    for (const raw of m[1].split(',')) {
      const id = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!id || local.has(id) || GLOBALS.has(id)) continue;
      if (new RegExp(`(?<![.\\w$])${id}(?![\\w$])`).test(body)) {
        problems.push(`${name}() references imported ${id} — imports do not exist inside the page; pass it via args`);
      }
    }
  }
}

}

if (problems.length) {
  console.error('FAIL: injected functions reference things that will not exist in the page\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  Fix: declare the helper INSIDE the injected function, or pass the value through executeScript's \`args\`.`);
  process.exit(1);
}

console.log(`ok: ${checked} injected functions are self-contained (no module-scope escapes)`);
