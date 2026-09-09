import { c } from '../../shared/log.js';
import type { Key, KeyReader } from './keys.js';
import type { Screen } from './screen.js';
import { terminalWidth, visibleWidth } from './paint.js';
import { ink } from './theme.js';
import type { ListItem } from './widgets.js';
import { keyHints, listView, rule, textField } from './widgets.js';

/**
 * The two interactions every full-screen view is built from: pick one of these, and type this.
 *
 * Both take the screen and the key reader rather than owning them, so a view can draw its own header
 * above the question and the whole thing repaints as one frame. Both answer `undefined` for a
 * cancel, which every caller has to handle: Escape and Ctrl-C are always a way out.
 */

export interface SelectOptions<T> {
  header: string[];
  items: ReadonlyArray<ListItem<T>>;
  selected?: number;
  hints?: ReadonlyArray<[string, string]>;
  /** Single-key shortcuts, e.g. `q` to quit. Checked before the list's own handling. */
  shortcuts?: Record<string, T>;
}

export async function select<T>(screen: Screen, keys: KeyReader, options: SelectOptions<T>): Promise<T | undefined> {
  const items = options.items;
  const first = items.findIndex((item) => !item.disabled);
  let index = clampToEnabled(items, options.selected ?? (first < 0 ? 0 : first), 1);

  for (;;) {
    screen.paint([
      ...options.header,
      '',
      ...listView(items, index),
      '',
      keyHints(options.hints ?? [['up/down', 'move'], ['enter', 'select'], ['q', 'quit']]),
    ]);

    const key = await keys.next();
    if (key.name === 'ctrl-c' || key.name === 'ctrl-d' || key.name === 'escape') return undefined;
    if (key.name === 'char' && options.shortcuts && key.value.toLowerCase() in options.shortcuts) {
      return options.shortcuts[key.value.toLowerCase()];
    }
    if (key.name === 'up') index = clampToEnabled(items, index - 1, -1);
    else if (key.name === 'down') index = clampToEnabled(items, index + 1, 1);
    else if (key.name === 'home') index = clampToEnabled(items, 0, 1);
    else if (key.name === 'end') index = clampToEnabled(items, items.length - 1, -1);
    else if (key.name === 'enter') {
      const chosen = items[index];
      if (chosen && !chosen.disabled) return chosen.value;
    } else if (key.name === 'char' && /^[1-9]$/.test(key.value)) {
      const target = Number(key.value) - 1;
      const item = items[target];
      if (item && !item.disabled) return item.value;
    }
  }
}

/** Step to the next enabled row in `direction`, wrapping, and give up rather than loop if none are. */
function clampToEnabled<T>(items: ReadonlyArray<ListItem<T>>, start: number, direction: 1 | -1): number {
  if (items.length === 0) return 0;
  let index = ((start % items.length) + items.length) % items.length;
  for (let step = 0; step < items.length; step += 1) {
    if (!items[index]?.disabled) return index;
    index = ((index + direction) % items.length + items.length) % items.length;
  }
  return ((start % items.length) + items.length) % items.length;
}

export interface FieldOptions {
  header: string[];
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** Returns a message when the value is not acceptable yet, or undefined when it is. */
  validate?: (value: string) => string | undefined;
  /** Show asterisks instead of the value. For the API key, and nothing else. */
  secret?: boolean;
}

export async function field(screen: Screen, keys: KeyReader, options: FieldOptions): Promise<string | undefined> {
  let value = options.value ?? '';
  let caret = value.length;
  let error: string | undefined;

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

    const key: Key = await keys.next();
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
      caret = upto.length;
      value = upto + value.slice(caret);
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
 */
export async function multiSelect<T>(
  screen: Screen,
  keys: KeyReader,
  options: { header: string[]; items: ReadonlyArray<ListItem<T>>; chosen: ReadonlySet<T>; extra?: ReadonlyArray<[string, string]> },
): Promise<Set<T> | undefined> {
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

/** Yes or no, drawn as a two-row list so it looks like every other question. */
export async function confirm(
  screen: Screen,
  keys: KeyReader,
  options: { header: string[]; question: string; fallback?: boolean },
): Promise<boolean | undefined> {
  const answer = await select<boolean>(screen, keys, {
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
 */
export async function pause(
  screen: Screen,
  keys: KeyReader,
  options: { header: string[]; hint?: string },
): Promise<boolean> {
  screen.paint([...options.header, '', keyHints([['enter', options.hint ?? 'continue']])]);
  for (;;) {
    const key = await keys.next();
    if (key.name === 'ctrl-c' || key.name === 'ctrl-d') return false;
    if (key.name !== 'unknown') return true;
  }
}

/** A section divider inside a full-screen view, matching the one the flat report uses. */
export function section(label: string): string {
  return rule(label);
}
