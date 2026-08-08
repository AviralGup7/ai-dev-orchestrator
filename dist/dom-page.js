/**
 * THE PAGE READER — the browser half of the DOM transport.
 *
 * `src/transports/dom.js` owns the completion state machine and is pure.
 * This file is the part that cannot be: it injects code into a tab and reads
 * back what it found.
 *
 * Everything it does is on the allow-list in `src/core/actions.js`:
 * read-conversation, paste-prompt, submit-prompt, focus-existing-tab. It
 * creates nothing, navigates nowhere, and closes nothing.
 */

import { SELECTORS, pageProbe } from './transports/dom.js';

/**
 * Type into the composer.
 *
 * Injected rather than done through `chrome.debugger` or synthetic key events,
 * because modern chat composers are React-controlled: setting `.value`
 * directly updates the DOM and leaves React's internal state empty, so the
 * send button stays disabled and the submit does nothing. The native setter
 * plus a bubbling `input` event is what actually makes the framework notice.
 */
function pageType(selectors, text) {
  const pick = (list) => { for (const s of list) { const el = document.querySelector(s); if (el) return el; } return null; };
  const el = pick(selectors.composer);
  if (!el) return { ok: false, why: 'no composer' };

  el.focus();

  if (el.isContentEditable) {
    /*
     * contenteditable composers (ChatGPT, DeepSeek) ignore `.value`. Replacing
     * `textContent` and firing `input` is the least invasive thing that works;
     * `execCommand` would be simpler and is deprecated and inconsistent.
     */
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { ok: true, chars: text.length };
}

/** Click send, preferring the button over a synthetic Enter. */
function pageClick(selectors, which) {
  const pick = (list) => { for (const s of list) { const el = document.querySelector(s); if (el) return el; } return null; };
  const el = pick(which === 'stop' ? selectors.stop : selectors.send);
  if (!el) return { ok: false, why: `no ${which} control` };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
    /*
     * Reported rather than forced. A disabled send button usually means the
     * composer did not actually receive the text -- the React problem above --
     * and clicking harder will not fix it. Saying so names the real fault.
     */
    return { ok: false, why: `the ${which} control is disabled` };
  }
  el.click();
  return { ok: true };
}

/**
 * A `page` object for the DomTransport, bound to a surface->tabId map.
 *
 * @param {() => object} getBinding  returns `{ surfaces: { manager: {tabId} } }`
 */
export function createPageReader(getBinding) {
  const tabFor = (surface) => {
    const tabId = getBinding()?.surfaces?.[surface]?.tabId;
    if (!tabId) throw Object.assign(new Error(`no bound tab for ${surface}`), { outcome: 'failed' });
    return tabId;
  };

  const run = async (surface, func, args) => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabFor(surface) },
      func,
      args,
      world: 'MAIN',
    });
    if (!res) throw Object.assign(new Error('the page returned nothing'), { outcome: 'failed' });
    return res.result;
  };

  return {
    async read(surface) {
      return run(surface, pageProbe, [SELECTORS[surface]]);
    },
    async type(surface, text) {
      const r = await run(surface, pageType, [SELECTORS[surface], text]);
      if (!r?.ok) throw Object.assign(new Error(`could not type into ${surface}: ${r?.why}`), { outcome: 'failed' });
      return r;
    },
    async click(surface, which) {
      const r = await run(surface, pageClick, [SELECTORS[surface], which]);
      if (!r?.ok) throw Object.assign(new Error(`could not submit on ${surface}: ${r?.why}`), { outcome: 'failed' });
      return r;
    },
  };
}
