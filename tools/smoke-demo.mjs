#!/usr/bin/env node
/**
 * DOES THE DEMO ACTUALLY RUN?
 *
 * `node --check` proves the bundle parses. Parsing is not running: a demo can
 * parse perfectly and then throw on the first click, or complete a run while
 * silently logging nothing. This drives the real bundle through a minimal DOM
 * shim and asserts the resulting Activity Log is coherent.
 *
 * It also guards the demo's VALUE, not just its correctness. The demo is meant
 * to show an imperfect run -- a failing build, a stall, a strategy change --
 * because a green log demonstrates the parts of the UI that matter least. The
 * required-event list below fails the build if the scripted run stops
 * exercising those paths, which it silently did once already when the
 * objectives were too dissimilar to trip the loop detector.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const listeners = [];
function el(tag='div'){
  const e={ tag, children:[], attrs:{}, _html:'', hidden:false, textContent:'',
    querySelector:()=>el(), querySelectorAll:()=>[],
    addEventListener:(t,f)=>listeners.push([t,f]),
    setAttribute:(k,v)=>{e.attrs[k]=v;}, getAttribute:(k)=>e.attrs[k],
    closest:()=>null, matches:()=>false, click:()=>{},
    get innerHTML(){return e._html;}, set innerHTML(v){e._html=v;},
    ownerDocument:{ addEventListener:(t,f)=>listeners.push([t,f]) },
  };
  return e;
}
const root = el();
const nodes = new Map();
root.querySelector = (sel) => { if(!nodes.has(sel)) nodes.set(sel, el()); return nodes.get(sel); };
root.querySelectorAll = () => [];
globalThis.document = { getElementById: () => root, createElement: () => el(), addEventListener:()=>{} };
globalThis.Blob = class { constructor(p){ this.parts=p; } };
globalThis.URL = { createObjectURL: () => 'blob:x' };

const html = readFileSync('demo.html','utf8');
let code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
code += `\nglobalThis.__engine = engine; globalThis.__logger = logger; globalThis.__orch = orch; globalThis.__panel = panel;`;
writeFileSync('/tmp/run.mjs', code);
await import('/tmp/run.mjs');

const engine = globalThis.__engine, logger = globalThis.__logger, orch = globalThis.__orch;

/*
 * Drive the real first-run flow: choose a mode, run preflight, then start.
 * Calling engine.start() directly would skip the two screens the user
 * actually meets first, which is exactly the part most likely to break.
 */
const setup = { mode: 'explore', projectName: 'Reporting service', prompt: '' };
const pre = await engine.preflight(setup);
assert.equal(pre.ok, true, `preflight failed: ${pre.summary}`);
assert.ok(pre.prompt && pre.prompt.includes('EXPLORATION ONLY'), 'explore mode must inject the exploration brief');
assert.ok(pre.prompt.includes('ORCHESTRATION PROTOCOL'), 'the protocol must be prepended for the user');
assert.equal(/## OBJECTIVE/.test(pre.prompt), false, 'explore mode must not add an empty objective heading');

await engine.start(setup);

assert.equal(orch.memory.mode, 'explore', 'the chosen mode is persisted');
assert.equal(orch.memory.baselineDone, true, 'the exploration baseline completed');
assert.equal(orch.memory.history[0].baseline, true, 'iteration 1 is marked as the baseline');
assert.match(orch.memory.history[0].objective.text, /Explore and understand/);

const ev = logger.live;
const types = new Set(ev.map((e) => e.type));

const REQUIRED = [
  'workflow-started', 'tab-focused', 'prompt-copied', 'prompt-pasted', 'prompt-submitted',
  'awaiting-response', 'response-received', 'planning-complete', 'task-complete',
  'evidence-collected', 'git-commit-detected', 'build-failed', 'evaluation-complete',
  'review-complete', 'stagnation-detected', 'strategy-changed', 'iteration-finished',
  'workflow-completed', 'session-ended',
];

const missing = REQUIRED.filter((t) => !types.has(t));
assert.deepEqual(missing, [], `the demo no longer exercises: ${missing.join(', ')}`);

assert.ok(ev.length > 100, `expected a busy log, got ${ev.length} events`);
assert.equal(orch.memory.iteration, 6, 'the scripted run should complete six iterations');
assert.equal(logger.openEvents().length, 0, 'every wait must be closed — a dangling wait means a lost outcome');

const malformed = ev.filter((e) => !e.id || !e.label || !e.source || !e.type);
assert.deepEqual(malformed, [], 'every entry must be fully formed');

const ids = ev.map((e) => e.id);
assert.deepEqual([...ids].sort(), ids, 'the log must be totally ordered');

const durable = await logger.all();
assert.equal(durable.length, ev.length, 'the durable sink must hold everything the view holds');

// The panel must render every tab without throwing.
for (const t of ['log', 'workflow', 'errors', 'summary']) {
  globalThis.__panel.setTab(t);
  globalThis.__panel.paint();
}
globalThis.__panel.destroy();

console.log(`ok: landing -> preflight -> explore run; ${orch.memory.iteration} iterations, ${ev.length} events, ${types.size} distinct types, all 4 tabs rendered`);
