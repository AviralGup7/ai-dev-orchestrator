/** Popup: live status + controls, then hand off to the side panel. */
import { CSS } from './styles.js';
import { renderStatus, renderControls } from './ui.js';
import { liveStatus } from '../src/core/status.js';
import { availableControls } from '../src/core/controls.js';
import { connectToBackground } from './client.js';

document.getElementById('s').textContent = CSS;
const engine = await connectToBackground();

function paint() {
  const memory = engine.memory();
  document.getElementById('status').innerHTML =
    renderStatus(liveStatus(memory, { lastEvent: engine.logger().live.at(-1), config: engine.config(), startedAt: engine.startedAt() }));
  document.getElementById('controls').innerHTML = renderControls(availableControls(memory));
}
setInterval(paint, 500);
paint();

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (btn && !btn.disabled) { await engine[btn.dataset.action]?.(); paint(); }
});

document.getElementById('open').addEventListener('click', async () => {
  // Opens the side panel for the CURRENT window. This is not "opening a tab":
  // no navigation occurs and no user tab is created, closed or changed.
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  window.close();
});
