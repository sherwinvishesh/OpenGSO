import { c } from '../../shared/log.js';
import { terminalWidth, visibleWidth } from './paint.js';
import { ink } from './theme.js';
import { keyHints, listView, rule, textField } from './widgets.js';

/**
 * @import { Key, KeyReader } from './keys.js'
 * @import { Screen } from './screen.js'
 * @import { ListItem } from './widgets.js'
 */

/**
 * The two interactions every full-screen view is built from: pick one of these, and type this.
 *
 * Both take the screen and the key reader rather than owning them, so a view can draw its own header
 * above the question and the whole thing repaints as one frame. Both answer `undefined` for a
 * cancel, which every caller has to handle: Escape and Ctrl-C are always a way out.
 */

/**
 * @template T
 * @typedef {object} SelectOptions
 * @property {string[] | (() => string[])} header A function is called on every draw, for a header
 *   whose layout depends on the terminal width.
 * @property {ReadonlyArray<ListItem<T>>} items
 * @property {number} [selected]
 * @property {ReadonlyArray<[string, string]>} [hints]
 * @property {Record<string, T>} [shortcuts] Single-key shortcuts, e.g. `q` to quit. Checked before
 *   the list's own handling.
 */

/**
 * @template T
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {SelectOptions<T>} options
 * @returns {Promise<T | undefined>}
 */
export async function select(screen, keys, options) {
  const items = options.items;
  const first = items.findIndex((item) => !item.disabled);
  let index = clampToEnabled(items, options.selected ?? (first < 0 ? 0 : first), 1);
  let top = 0;

  for (;;) {
    const header = typeof options.header === 'function' ? options.header() : options.header;
    // `paint` clips at rows - 1, so a list taller than what is left under the header scrolls
    // instead, or the selected row and the hints can be cut off with nothing saying so.
    const room = Math.max(3, screen.size().rows - 1 - header.length - 3);
    const rows = listView(items, index);
    if (rows.length > room) {
      if (index < top) top = index;
      if (index >= top + room) top = index - room + 1;
      top = Math.min(Math.max(0, top), rows.length - room);
    } else {
      top = 0;
    }
    const visible = rows.slice(top, top + room);
    const above = top;
    const below = rows.length - top - visible.length;
    screen.paint([
      ...header,
      // The two blank lines around the list carry the scroll markers, so scrolling costs no rows.
      above > 0 ? `  ${ink.faint(`${above} more above`)}` : '',
      ...visible,
      below > 0 ? `  ${ink.faint(`${below} more below`)}` : '',
      keyHints(options.hints ?? [['up/down', 'move'], ['enter', 'select'], ['q', 'quit']]),
    ]);

    const key = await keys.next();
    if (key.name === 'ctrl-c' || key.name === 'ctrl-d' || key.name === 'escape') return undefined;
    if (key.name === 'char' && options.shortcuts && key.value.toLowerCase() in options.shortcuts) {
      const target = options.shortcuts[key.value.toLowerCase()];
      // A dimmed row is unselectable however it is reached, or the shortcut runs what the install lacks.
      if (!items.some((item) => item.value === target && item.disabled)) return target;
      continue;
    }
    if (key.name === 'up') index = clampToEnabled(items, index - 1, -1);
    else if (key.name === 'down') index = clampToEnabled(items, index + 1, 1);
    else if (key.name === 'home') index = clampToEnabled(items, 0, 1);
    else if (key.name === 'end') index = clampToEnabled(items, items.length - 1, -1);
    else if (key.name === 'enter') {
      const chosen = items[index];
      if (chosen && !chosen.disabled) return chosen.value;
    }
  }
}

/**
 * Step to the next enabled row in `direction`, wrapping, and give up rather than loop if none are.
 *
 * @template T
 * @param {ReadonlyArray<ListItem<T>>} items
 * @param {number} start
 * @param {1 | -1} direction
 * @returns {number}
 */
function clampToEnabled(items, start, direction) {
  if (items.length === 0) return 0;
  let index = ((start % items.length) + items.length) % items.length;
  for (let step = 0; step < items.length; step += 1) {
    if (!items[index]?.disabled) return index;
    index = ((index + direction) % items.length + items.length) % items.length;
  }
  return ((start % items.length) + items.length) % items.length;
}

/**
 * @typedef {object} FieldOptions
 * @property {string[]} header
 * @property {string} label
 * @property {string} [value]
 * @property {string} [placeholder]
 * @property {string} [hint]
 * @property {(value: string) => string | undefined} [validate] Returns a message when the value is
 *   not acceptable yet, or undefined when it is.
 * @property {boolean} [secret] Show asterisks instead of the value. For the API key, and nothing else.
 */

/**
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {FieldOptions} options
 * @returns {Promise<string | undefined>}
 */
export async function field(screen, keys, options) {
  // Code points, not UTF-16 units, so an emoji is one step for the arrows, backspace and the mask.
  let chars = [...(options.value ?? '')];
  let caret = chars.length;
  /** @type {string | undefined} */
  let error;

  for (;;) {
    const value = chars.join('');
    const shown = options.secret ? '*'.repeat(chars.length) : value;
    const width = Math.max(20, terminalWidth() - visibleWidth(options.label) - 8);
    screen.paint([
      ...options.header,
      '',
      `  ${c.bold(options.label)}  ${textField(shown, caret, { width, placeholder: options.placeholder })}`,
      options.hint ? `  ${ink.faint(options.hint)}` : '',
      error ? `  ${ink.warn(error)}` : '',
      '',
      keyHints([['enter', 'accept'], ['esc', 'back']]),
    ]);

    /** @type {Key} */
    const key = await keys.next();
    if (key.name === 'ctrl-c' || key.name === 'escape') return undefined;
    // A redraw, not an edit, so it must not clear a validation message the user has not acted on.
    if (key.name === 'resize') continue;
    if (key.name === 'enter') {
      const problem = options.validate?.(value.trim());
      if (!problem) return value.trim();
      error = problem;
      continue;
    }
    error = undefined;
    if (key.name === 'backspace') {
      if (caret > 0) {
        chars.splice(caret - 1, 1);
        caret -= 1;
      }
    } else if (key.name === 'delete') {
      chars.splice(caret, 1);
    } else if (key.name === 'left') caret = Math.max(0, caret - 1);
    else if (key.name === 'right') caret = Math.min(chars.length, caret + 1);
    else if (key.name === 'home') caret = 0;
    else if (key.name === 'end') caret = chars.length;
    else if (key.name === 'ctrl-u') {
      chars = chars.slice(caret);
      caret = 0;
    } else if (key.name === 'ctrl-w') {
      const upto = [...chars.slice(0, caret).join('').replace(/\S+\s*$/, '')];
      chars = [...upto, ...chars.slice(caret)];
      caret = upto.length;
    } else if (key.name === 'char' || key.name === 'space') {
      const typed = [...key.value];
      chars.splice(caret, 0, ...typed);
      caret += typed.length;
    }
  }
}

/**
 * Yes or no, drawn as a two-row list so it looks like every other question.
 *
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {{ header: string[]; question: string; fallback?: boolean }} options
 * @returns {Promise<boolean | undefined>}
 */
export async function confirm(screen, keys, options) {
  /** @type {boolean | undefined} */
  const answer = await select(screen, keys, {
    header: [...options.header, '', `  ${c.bold(options.question)}`],
    items: [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ],
    selected: options.fallback === false ? 1 : 0,
    hints: [['up/down', 'move'], ['enter', 'select'], ['esc', 'back']],
  });
  return answer;
}

/**
 * Hold the frame until it has been read.
 *
 * Not every step of a flow is a question. Setup's third one states a policy - blocking is a separate
 * lever and OpenGEO leaves it empty - and in scrollback that prints and the flow moves on, which is
 * right, because the words stay where they were printed. On a screen that repaints, "prints and
 * moves on" means the next question wipes them before anybody has read a word of it.
 *
 * Any key continues, because there is nothing to get wrong here. Ctrl-C still leaves, and answers
 * false so the caller aborts the same way it does from a real question: a screen with no answer on
 * it is a bad place to make Ctrl-C stop working.
 *
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {{ header: string[]; hint?: string }} options
 * @returns {Promise<boolean>}
 */
export async function pause(screen, keys, options) {
  screen.paint([...options.header, '', keyHints([['enter', options.hint ?? 'continue']])]);
  for (;;) {
    const key = await keys.next();
    if (key.name === 'ctrl-c' || key.name === 'ctrl-d') return false;
    if (key.name !== 'unknown') return true;
  }
}

/**
 * A section divider inside a full-screen view, matching the one the flat report uses.
 *
 * @param {string} label
 * @returns {string}
 */
export function section(label) {
  return rule(label);
}
