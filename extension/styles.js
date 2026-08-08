/**
 * Styles as a JS export rather than a .css file.
 *
 * The reason is the workspace preview: it renders HTML in a sandboxed iframe
 * with no network, so an external stylesheet silently does not load and the
 * demo looks broken in the one place the user will actually look at it.
 * Inlining is also fine for the real extension — one file fewer, and no
 * flash of unstyled panel on open.
 */
export const CSS = `
:root {
  --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3;
  --muted: #8b949e; --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
h1 { font-size: 14px; margin: 0; letter-spacing: .2px; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.grow { flex: 1; min-width: 0; }

header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}

/* tabs */
.tabs { display: flex; gap: 2px; padding: 6px 8px 0; background: var(--panel); border-bottom: 1px solid var(--line); }
.tab {
  background: none; border: 0; color: var(--muted); padding: 7px 11px; cursor: pointer;
  font: inherit; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0;
}
.tab:hover { color: var(--text); background: #1f242c; }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab .count { font-size: 10px; background: var(--bad); color: #fff; border-radius: 8px; padding: 0 5px; margin-left: 4px; }

main { padding: 10px 12px 24px; }
section[hidden] { display: none; }

/* status */
.status { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 11px; margin-bottom: 10px; }
.status .row { display: flex; align-items: flex-start; gap: 9px; }
.label { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
.step { font-size: 15px; font-weight: 600; }
.why { color: var(--muted); font-size: 12px; margin-top: 1px; overflow-wrap: anywhere; }
.timer { font-variant-numeric: tabular-nums; color: var(--accent); font-size: 15px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); margin-top: 6px; flex: none; }
.dot.live { background: var(--ok); animation: pulse 1.6s infinite; }
.dot.bad { background: var(--bad); }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-top: 11px; }
.big { font-size: 19px; font-weight: 700; }
.big.unmeasured { color: var(--warn); }
.next { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.next .label { margin-right: 6px; }
.warn { margin-top: 9px; padding: 7px 9px; border-radius: 6px; background: #2d2410; color: var(--warn); font-size: 12px; }
.err  { margin-top: 9px; padding: 7px 9px; border-radius: 6px; background: #2d1214; color: var(--bad); font-size: 12px; }

/* workflow */
.flow { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.stage { display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 5px; color: var(--muted); }
.stage .marker { width: 14px; text-align: center; }
.stage.done { color: var(--ok); }
.stage.active { color: var(--text); background: #1f2937; font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
.arrow { color: var(--line); padding-left: 13px; line-height: 1; font-size: 11px; }

/* controls */
.controls { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.btn {
  background: #21262d; color: var(--text); border: 1px solid var(--line);
  padding: 6px 11px; border-radius: 6px; cursor: pointer; font: inherit;
}
.btn:hover:not(:disabled) { background: #30363d; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn.primary { background: #238636; border-color: #2ea043; }
.btn.danger:not(:disabled) { background: #4a1517; border-color: #6e2224; color: #ff9d9d; }
.btn.small { padding: 3px 8px; font-size: 11px; }

/* filters */
.filters { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 8px; }
.filters input[type="search"] {
  flex: 1; min-width: 110px; background: var(--bg); border: 1px solid var(--line);
  color: var(--text); padding: 5px 8px; border-radius: 6px; font: inherit;
}
.chip {
  background: #21262d; border: 1px solid var(--line); color: var(--muted);
  padding: 3px 9px; border-radius: 12px; cursor: pointer; font-size: 11px;
}
.chip[aria-pressed="true"] { background: #1f6feb33; border-color: var(--accent); color: var(--accent); }

/* log */
.truncated { padding: 7px 9px; margin-bottom: 8px; border-radius: 6px; background: #1f2937; color: var(--accent); font-size: 11px; }
.entry { border-bottom: 1px solid var(--line); padding: 7px 2px; }
.entry:hover { background: #11161d; }
.entry-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
.badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; color: #fff; letter-spacing: .4px; }
.type { font-weight: 500; }
.iter { font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
.dur { font-size: 10px; color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
.desc { color: var(--muted); font-size: 12px; margin: 2px 0 0 4px; overflow-wrap: anywhere; }
.evid { font-size: 9px; color: #444c56; margin-left: 4px; font-family: ui-monospace, monospace; }
.entry.error .type { color: var(--bad); }
.spin { display: inline-block; animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
details.data { margin: 4px 0 0 4px; }
details summary { cursor: pointer; color: var(--muted); font-size: 11px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 7px; overflow: auto; font-size: 11px; margin: 5px 0 0; }
.empty { color: var(--muted); text-align: center; padding: 26px 10px; }

/* errors */
.errhead { color: var(--muted); font-size: 11px; margin-bottom: 8px; }
.errcard { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--bad); border-radius: 6px; padding: 9px; margin-bottom: 8px; }
.errcard.resolved { border-left-color: var(--ok); opacity: .65; }
.errtop { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.errmeta { color: var(--muted); font-size: 11px; margin: 3px 0; }
.errfix { color: var(--accent); font-size: 12px; margin: 6px 0; }
.pill { font-size: 10px; padding: 1px 7px; border-radius: 9px; flex: none; }
.pill.ok { background: #16371f; color: var(--ok); }
.pill.bad { background: #3a1416; color: var(--bad); }

/* summary */
table.summary { width: 100%; border-collapse: collapse; }
table.summary th { text-align: left; font-weight: 400; color: var(--muted); padding: 5px 0; font-size: 12px; }
table.summary td { text-align: right; padding: 5px 0; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
code { font-family: ui-monospace, monospace; font-size: 11px; }

/* landing + preflight */
.landing, .preflight { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.modes { display: grid; gap: 7px; margin: 8px 0 12px; }
.modecard {
  display: flex; flex-direction: column; gap: 3px; text-align: left; cursor: pointer;
  background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 10px 11px;
  color: var(--text); font: inherit;
}
.modecard:hover { border-color: var(--muted); }
.modecard.chosen { border-color: var(--accent); background: #1f6feb1a; box-shadow: inset 2px 0 0 var(--accent); }
.modename { font-weight: 600; font-size: 14px; }
.modeblurb { color: var(--muted); font-size: 12px; }
.modecard .pill { align-self: flex-start; margin-top: 3px; }
.field { display: block; margin-bottom: 10px; }
.field .label { display: block; margin-bottom: 4px; }
.field input, .field textarea {
  width: 100%; background: var(--bg); border: 1px solid var(--line); color: var(--text);
  border-radius: 6px; padding: 7px 9px; font: inherit; resize: vertical;
}
.field input:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
.fielderr { display: block; color: var(--bad); font-size: 11px; margin-top: 3px; }
.explain { color: var(--muted); font-size: 12px; background: #11161d; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
.check { display: flex; gap: 8px; padding: 6px 2px; border-bottom: 1px solid var(--line); align-items: flex-start; }
.check .mark { width: 14px; text-align: center; }
.check.ok .mark { color: var(--ok); }
.check.bad .mark { color: var(--bad); }
.check.warnrow .mark { color: var(--warn); }
.preview { margin: 10px 0; }
.preview pre { max-height: 260px; }
`;
