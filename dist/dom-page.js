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
  /*
   * SELF-REPORTING FAILURE.
   *
   * Chrome discards an in-page exception (crbug 1271527) and hands the
   * extension `result: undefined`, so a throw here becomes the word
   * "undefined" in the log. Catching it and returning it as data is the only
   * way the reason survives the boundary.
   */
  try {
    return typeIn(selectors, text);
  } catch (err) {
    return { __threw: true, ok: false, error: String(err?.message || err), stack: String(err?.stack || '').slice(0, 600) };
  }
}

function typeIn(selectors, text) {
  const pick = (list) => { for (const s of list) { const el = document.querySelector(s); if (el) return el; } return null; };
  const el = pick(selectors.composer);
  if (!el) return { ok: false, why: 'no composer' };

  el.focus();
  let usedExecCommand = false;

  if (el.isContentEditable) {
    /*
     * PROSEMIRROR KEEPS ITS OWN STATE TREE. WRITING THE DOM DOES NOT REACH IT.
     *
     * ChatGPT's composer is a ProseMirror editor. It maintains an immutable
     * document model SEPARATE from the visible DOM and updates it only via its
     * own transaction system, which is driven by `beforeinput`/`input` events
     * carrying a real `inputType` -- or by `document.execCommand('insertText')`.
     *
     * Assigning `textContent` makes the text VISIBLE while ProseMirror still
     * believes the editor is empty. The consequences are exactly what run
     * 202608090550 shows: the send button is never enabled (so "no send
     * control"), Enter is ignored (so the message is never sent), and the page
     * sits at an unchanged character count until the budget expires.
     *
     * The previous comment here claimed execCommand was "deprecated and
     * inconsistent". It IS formally deprecated -- and it is also the only API
     * every one of these editors actually listens to. Correctness beats tidy.
     *
     * Order matters: select the existing content first so the insert REPLACES
     * rather than appends. A retry would otherwise send the prompt twice over.
     */
    let inserted = false;
    try {
      const sel = window.getSelection?.();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      inserted = document.execCommand('insertText', false, text);
      usedExecCommand = inserted;
    } catch {
      inserted = false;
    }

    if (!inserted) {
      /*
       * Fallback: rebuild the DOM and fire a SPEC-SHAPED InputEvent.
       *
       * `beforeinput` first, because that is the event ProseMirror and Lexical
       * key on; a bare `new Event('input')` with no `inputType` is ignored by
       * both. `composed: true` so it crosses a shadow boundary if the editor
       * is encapsulated.
       */
      el.textContent = '';
      const p = document.createElement('p');
      p.textContent = text;
      el.appendChild(p);
      for (const type of ['beforeinput', 'input']) {
        el.dispatchEvent(new InputEvent(type, {
          inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true,
        }));
      }
    }
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

  /*
   * READING BACK `textContent` PROVES ALMOST NOTHING ON ITS OWN.
   *
   * The check above reads the property we just wrote, so on the DOM-fallback
   * path it is very nearly a tautology: it passed for the whole of run
   * 202608090550 while ProseMirror's model stayed empty and the message was
   * never sent. It only ever catches a composer that reverts the write.
   *
   * `enabledSend` asks the FRAMEWORK instead. These editors enable the send
   * control as a direct consequence of their model becoming non-empty, so a
   * send control that exists and is not disabled is independent evidence that
   * the text reached the state tree -- the one thing we actually need to know.
   *
   * Reported rather than fatal: it is a signal, not a certainty. Some
   * surfaces keep the control permanently enabled, and failing the paste on
   * that basis would break the sites that work today. `pageClick` is where the
   * decision gets made, and it now has this to work with.
   */
  let enabledSend = null;
  try {
    const send = pickFrom(selectors.send);
    enabledSend = send
      ? !(send.disabled || send.getAttribute?.('aria-disabled') === 'true')
      : false;
  } catch {
    enabledSend = null;
  }

  return { ok: true, chars: text.length, readBack: got.length, enabledSend, via: usedExecCommand ? 'execCommand' : 'dom' };
}

/** Shared selector walk. Defined once so `pageType` and `pageClick` agree. */
function pickFrom(list) {
  for (const s of list || []) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  return null;
}

/** Click send, preferring the button over a synthetic Enter. */
export async function pageClick(selectors, which) {
  /* See pageType: an in-page throw would otherwise arrive as `undefined`. */
  try {
    return await clickIn(selectors, which);
  } catch (err) {
    return { __threw: true, ok: false, error: String(err?.message || err), stack: String(err?.stack || '').slice(0, 600) };
  }
}

async function clickIn(selectors, which) {
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
      const sent = await composerEmptied(composer);
      return sent
        ? { ok: true, via: 'enter', why: el ? 'the send button was disabled' : 'no send button was mounted' }
        : {
          ok: false,
          via: 'enter',
          why: 'the prompt was typed but never sent — Enter did not submit and no usable send button appeared. '
            + 'The composer still holds the text, which means the page framework never registered the input.',
        };
    }
    return {
      ok: false,
      why: el ? `the ${which} control is disabled` : `no ${which} control appeared within 1.5s`,
    };
  }

  el.click();

  if (which !== 'send') return { ok: true, via: 'click' };

  /*
   * VERIFY THE SUBMIT, DO NOT ASSUME IT.
   *
   * `el.click()` dispatches a MouseEvent with `isTrusted: false`, and some
   * handlers short-circuit on exactly that. Returning `ok: true` here is the
   * same class of mistake the paste used to make: reporting an action rather
   * than an outcome. Run 202608090550 then waited four minutes for a reply to
   * a message that was still sitting in the composer.
   *
   * A cleared composer is the page telling us it accepted the message.
   */
  if (await composerEmptied(composer)) return { ok: true, via: 'click' };

  if (composer) {
    composer.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      composer.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true,
      }));
    }
    if (await composerEmptied(composer)) return { ok: true, via: 'click+enter' };
  }

  return {
    ok: false,
    via: 'click',
    why: 'the send button was clicked but the composer still holds the prompt — the click was not accepted '
      + '(a synthetic click carries isTrusted: false, which some handlers reject)',
  };
}

/**
 * Did the composer clear? Polled for ~2s.
 *
 * The one signal that means "the page took the message". Checked rather than
 * assumed, because both submit routes can silently no-op: a synthetic click
 * carries `isTrusted: false`, and Enter is ignored when the editor's model
 * never received the text.
 *
 * A composer we cannot read returns `true` -- absence of evidence must not
 * become a failure, or surfaces that clear differently would break.
 */
async function composerEmptied(composer) {
  if (!composer) return true;
  const read = () => (composer.isContentEditable ? composer.textContent : composer.value) || '';
  for (let i = 0; i < 20; i++) {
    if (read().trim().length === 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
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

    /*
     * AN IN-PAGE THROW MUST NOT ARRIVE AS `undefined`.
     *
     * Chrome does not implement `InjectionResult.error` (crbug 1271527; MDN
     * states it outright). When an injected function throws -- or, being
     * async, rejects -- Chrome reports `result: undefined` and writes the real
     * error only to the TARGET PAGE's console, where a background worker can
     * never read it.
     *
     * That is how run 202608090835 produced "could not submit on engineer:
     * undefined": `undefined?.why` is `undefined`, so the one fact that
     * mattered was destroyed at the boundary and replaced with a word.
     *
     * The injected functions therefore catch their own errors and return them
     * as data (see `guarded` below). Wrapping them out here would require
     * `eval` inside the page, which ChatGPT's and Arena's CSP forbid.
     *
     * This branch is the backstop for the case no try/catch can cover: the
     * injection never completing at all.
     */
    if (res.result === undefined || res.result === null) {
      throw Object.assign(
        new Error(`${func.name || 'the injected function'} returned nothing — it threw inside the page, `
          + 'the frame was destroyed, or the injection was blocked. Chrome does not report in-page '
          + 'errors to the extension; check the page console.'),
        { outcome: 'failed' },
      );
    }

    if (res.result.__threw) {
      throw Object.assign(
        new Error(`${func.name || 'the injected function'} failed inside the page: ${res.result.error}`),
        { outcome: 'failed', pageStack: res.result.stack },
      );
    }

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
