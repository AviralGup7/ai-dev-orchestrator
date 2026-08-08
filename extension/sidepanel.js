/**
 * Side panel entry point.
 *
 * Thin by design: it injects the stylesheet, connects to the background
 * worker, and hands a live `engine` interface to `createPanel`. Every decision
 * lives in src/core; every pixel lives in ui.js. If this file grows logic,
 * that is the smell.
 */
import { CSS } from './styles.js';
import { createPanel } from './panel.js';
import { connectToBackground } from './client.js';

document.getElementById('s').textContent = CSS;
const engine = await connectToBackground();
createPanel({ root: document.getElementById('app'), engine });
