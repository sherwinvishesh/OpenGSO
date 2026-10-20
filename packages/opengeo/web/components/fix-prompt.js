import { button, card, cardHead, doc, el, setLabel } from '../ui.js';

/** @import { FixPrompts } from '../../../core/src/shared/api-types.js' */

/**
 * Copying a fix prompt for Claude Code, from anywhere a report is drawn.
 *
 * The prompts themselves are built on the server by the same function as `opengeo test --prompt`,
 * so the text pasted from here is the text the terminal prints. Nothing in this file writes a word
 * of one.
 */

/** How long a toast stays up. Long enough to read a dozen words, short enough not to pile up. */
const TOAST_MS = 3200;

/**
 * Put text on the clipboard. The async API first; then the old selection-and-copy route, which is
 * what a browser that withholds the clipboard from a page outside a secure context still allows.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no focus, no permission). The fallback below is a separate permission.
  }
  const document = doc();
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * The live region toasts go in. It is put in place when a copy button is drawn rather than with the
 * first toast, because a screen reader announces changes to a live region it already knows about
 * and can miss the text of one that arrives with its content.
 */
function toastRegion() {
  const document = doc();
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = el('div', { className: 'toast-region', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.append(region);
  }
  return region;
}

/**
 * A short message at the bottom of the window, read out by a screen reader without moving focus.
 *
 * @param {string} message
 * @param {'ok' | 'fail'} [tone]
 */
export function toast(message, tone = 'ok') {
  const node = el('div', { className: `toast toast-${tone}`, text: message });
  toastRegion().append(node);
  setTimeout(() => node.remove(), TOAST_MS);
}

/**
 * Copy one prompt and say so, in a toast and on the button that did it.
 *
 * @param {string} text
 * @param {string} what Names the prompt in the toast: "3 fixes and 6 suggestions", "A3", "2 partly there".
 * @param {HTMLButtonElement} [source]
 * @returns {Promise<boolean>}
 */
export async function copyPrompt(text, what, source) {
  const copied = await copyText(text);
  if (copied) {
    toast(`Fix prompt copied (${what}). Paste it into Claude Code.`);
    if (source) flashLabel(source, 'Copied');
  } else {
    toast('Could not reach the clipboard. Open "Show the prompt" and copy it from there.', 'fail');
  }
  return copied;
}

/** @type {WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>} */
const flashes = new WeakMap();

/**
 * @param {HTMLButtonElement} node
 * @param {string} label
 */
function flashLabel(node, label) {
  const original = node.dataset.label ?? node.textContent ?? '';
  node.dataset.label = original;
  setLabel(node, label);
  clearTimeout(flashes.get(node));
  flashes.set(
    node,
    setTimeout(() => setLabel(node, original), 1600),
  );
}

/**
 * The small text button on a group title or a check row.
 *
 * @param {string} label
 * @param {string} text
 * @param {string} what Names the prompt in the toast.
 * @param {string} [accessibleName] When the label alone would be ambiguous among several.
 */
export function copyLink(label, text, what, accessibleName) {
  toastRegion();
  /** @type {HTMLButtonElement} */
  const node = el('button', {
    className: 'copy-link',
    attrs: { type: 'button', 'aria-label': accessibleName, title: 'Copy a fix prompt for Claude Code' },
    text: label,
    on: { click: () => void copyPrompt(text, what, node) },
  });
  return node;
}

let promptIds = 0;

/**
 * The card above the checks: one button for everything, and the prompt itself behind a toggle for
 * anyone who wants to read what they are about to paste.
 *
 * @param {FixPrompts} prompts
 */
export function fixPromptCard(prompts) {
  toastRegion();
  const { summary } = prompts;
  const pre = el('pre', { className: 'prompt-text', attrs: { id: `fix-prompt-${++promptIds}`, tabindex: 0 }, hidden: true, text: prompts.all });
  const closed = 'Show the prompt';
  const toggle = el('button', {
    className: 'copy-link prompt-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': pre.id },
    text: closed,
    on: {
      click: () => {
        const open = pre.hidden;
        pre.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide the prompt' : closed;
      },
    },
  });
  const copy = button({ label: 'Copy fix prompt', primary: true, small: true, onClick: () => void copyPrompt(prompts.all, summary, copy) });
  return card(
    'fix-card',
    cardHead({ title: 'Fix it with Claude Code', sub: `One prompt with ${summary}, ready to paste into Claude Code or any coding agent.`, right: copy }),
    el(
      'div',
      { className: 'card-pad stack-sm' },
      el(
        'p',
        { className: 'muted', style: { margin: '0' } },
        'It names the files OpenGEO writes, what to change, and the command that confirms each fix. ',
        'Every group and failing check below has its own copy button for a narrower job. Press ',
        el('kbd', { text: 'c' }),
        ' to copy this one.',
      ),
      toggle,
    ),
    pre,
  );
}
