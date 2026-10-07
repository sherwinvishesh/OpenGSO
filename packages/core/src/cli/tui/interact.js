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
 * @property {string[]} header
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
    // `paint` clips at rows - 1, so a list taller than what is left under the header scrolls
    // instead, or the selected row and the hints can be cut off with nothing saying so.
    const room = Math.max(3, screen.size().rows - 1 - options.header.length - 3);
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
      ...options.header,
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
  let value = options.value ?? '';
  let caret = value.length;
  /** @type {string | undefined} */
  let error;

  for (;;) {
    const shown = options.secret ? '*'.repeat(value.length) : value;
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
    if (key.name === 'enter') {
      const problem = options.validate?.(value.trim());
      if (!problem) return value.trim();
      error = problem;
      continue;
    }
    error = undefined;
    if (key.name === 'backspace') {
      if (caret > 0) {
        value = value.slice(0, caret - 1) + value.slice(caret);
        caret -= 1;
      }
    } else if (key.name === 'delete') {
      value = value.slice(0, caret) + value.slice(caret + 1);
    } else if (key.name === 'left') caret = Math.max(0, caret - 1);
    else if (key.name === 'right') caret = Math.min(value.length, caret + 1);
    else if (key.name === 'home') caret = 0;
    else if (key.name === 'end') caret = value.length;
    else if (key.name === 'ctrl-u') {
      value = value.slice(caret);
      caret = 0;
    } else if (key.name === 'ctrl-w') {
      const upto = value.slice(0, caret).replace(/\S+\s*$/, '');
      value = upto + value.slice(caret);
      caret = upto.length;
    } else if (key.name === 'char' || key.name === 'space') {
      value = value.slice(0, caret) + key.value + value.slice(caret);
      caret += key.value.length;
    }
  }
}

/**
 * A multi-select over the same list widget, for the crawler pickers.
 *
 * Space toggles, `a` takes everything, `n` clears, Enter is done. Returns undefined on a cancel so
 * an aborted pick cannot be read as "the user chose none of them".
 *
 * @template T
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {{ header: string[]; items: ReadonlyArray<ListItem<T>>; chosen: ReadonlySet<T>; extra?: ReadonlyArray<[string, string]> }} options
 * @returns {Promise<Set<T> | undefined>}
 */
export async function multiSelect(screen, keys, options) {
  const chosen = new Set(options.chosen);
  let index = 0;

  for (;;) {
    const marked = options.items.map((item) => ({
      ...item,
      label: `${chosen.has(item.value) ? ink.ok('[x]') : ink.faint('[ ]')} ${item.label}`,
    }));
    screen.paint([
      ...options.header,
      '',
      ...listView(marked, index),
      '',
      `  ${ink.faint(`${chosen.size} of ${options.items.length} selected`)}`,
      '',
      keyHints([['space', 'toggle'], ['a', 'all'], ['n', 'none'], ['enter', 'done'], ...(options.extra ?? [])]),
    ]);

    const key = await keys.next();
    if (key.name === 'ctrl-c' || key.name === 'escape') return undefined;
    if (key.name === 'enter') return chosen;
    if (key.name === 'up') index = (index - 1 + options.items.length) % options.items.length;
    else if (key.name === 'down') index = (index + 1) % options.items.length;
    else if (key.name === 'space') {
      const item = options.items[index];
      if (item) {
        if (chosen.has(item.value)) chosen.delete(item.value);
        else chosen.add(item.value);
      }
    } else if (key.name === 'char' && key.value.toLowerCase() === 'a') {
      for (const item of options.items) chosen.add(item.value);
    } else if (key.name === 'char' && key.value.toLowerCase() === 'n') {
      chosen.clear();
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
