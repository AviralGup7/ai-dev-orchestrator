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
import { REPORT_FENCE } from './core/protocol.js';

/**
 * Type into the composer.
 *
 * Injected rather than done through `chrome.debugger` or synthetic key events,
 * because modern chat composers are React-controlled: setting `.value`
 * directly updates the DOM and leaves React's internal state empty, so the
 * send button stays disabled and the submit does nothing. The native setter
 * plus a bubbling `input` event is what actually makes the framework notice.
 */
export function pageType(selectors, text) {
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

  /*
   * VERIFY THE TEXT ACTUALLY LANDED. DO NOT TAKE OUR OWN WORD FOR IT.
   *
   * This used to return `{ok: true}` unconditionally, having only assigned to
   * a property. In run 202608081932 it reported "Pasted 2029 characters into
   * the manager composer" and the very next call failed with "no send
   * control" -- because ChatGPT only renders its send button once React
   * believes the composer is non-empty, and React had not accepted the
   * assignment. The paste had not worked; only our report of it had.
   *
   * Reading the value back is the difference between "I set a property" and
   * "the page has the text".
   */
  const got = el.isContentEditable ? (el.textContent || '') : (el.value || '');
  if (got.length < Math.min(text.length, 32)) {
    return {
      ok: false,
      why: `the composer did not accept the text (wrote ${text.length} characters, read back ${got.length}) `
        + '— the page framework rejected the programmatic input',
      wrote: text.length,
      readBack: got.length,
    };
  }

  return { ok: true, chars: text.length, readBack: got.length };
}

/** Click send, preferring the button over a synthetic Enter. */
export async function pageClick(selectors, which) {
  const pick = (list) => { for (const s of list) { const el = document.querySelector(s); if (el) return el; } return null; };

  /*
   * WAIT BRIEFLY FOR THE CONTROL TO APPEAR.
   *
   * ChatGPT does not keep a disabled send button in the DOM -- it MOUNTS one
   * once React re-renders with a non-empty composer. Looking synchronously in
   * the same tick as the paste therefore finds nothing and reports "no send
   * control", which reads like a rotted selector and is not: the button
   * simply does not exist yet. Backgrounded tabs (the failing run had
   * `visibility: hidden`) render on a slower schedule, which is exactly when
   * this bites.
   *
   * ~1.5s of polling, not a fixed sleep, and only on the miss path.
   */
  let el = pick(which === 'stop' ? selectors.stop : selectors.send);
  for (let i = 0; !el && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    el = pick(which === 'stop' ? selectors.stop : selectors.send);
  }

  const composer = pick(selectors.composer);

  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') {
    /*
     * FALL BACK TO ENTER, because for these composers it is not a hack: it is
     * the primary way a human submits, and it goes through the framework's own
     * keyboard handler rather than depending on a button we located.
     *
     * Only attempted for `send`. Synthesising Enter to try to STOP a running
     * generation would submit the composer instead -- the opposite of the
     * intent -- so a missing stop control stays an honest failure.
     */
    if (which === 'send' && composer) {
      composer.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        composer.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true, composed: true,
        }));
      }
      return { ok: true, via: 'enter', why: el ? 'the send button was disabled' : 'no send button was mounted' };
    }
    return {
      ok: false,
      why: el ? `the ${which} control is disabled` : `no ${which} control appeared within 1.5s`,
    };
  }

  el.click();
  return { ok: true, via: 'click' };
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
      /* The fence is passed in: `func` is serialised and loses its closure. */
      return run(surface, pageProbe, [SELECTORS[surface], REPORT_FENCE]);
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
