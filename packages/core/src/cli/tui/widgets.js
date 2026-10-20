import { c } from '../../shared/log.js';
import { fg, glyphs, gradient, padEnd, terminalWidth, truncate, visibleWidth } from '../../shared/render/paint.js';
import { PALETTE, ink } from '../../shared/render/theme.js';

/** @import { Rgb } from '../../shared/render/paint.js' */

/**
 * The drawing vocabulary: boxes, lists, fields, spinners. The meters and sparklines are in
 * shared/render/meters.js, where a pillar's report can reach them without importing the CLI.
 *
 * Every one of these returns a string or an array of strings rather than writing anywhere, so all
 * of it can be tested without a terminal.
 */

/**
 * @typedef {object} BoxOptions
 * @property {string} [title]
 * @property {string} [tag] Drawn at the far right of the top edge, e.g. a version.
 * @property {number} [width]
 * @property {Rgb} [colour]
 * @property {number} [padding]
 */

/**
 * A titled box around a block of lines.
 *
 * The title sits in the top edge rather than on a line of its own, which buys back a row and reads
 * as a frame instead of a heading with a rectangle under it.
 *
 * @param {readonly string[]} lines
 * @param {BoxOptions} [options]
 * @returns {string[]}
 */
export function box(lines, options = {}) {
  const g = glyphs();
  const width = options.width ?? terminalWidth();
  const colour = options.colour ?? PALETTE.faint;
  const pad = options.padding ?? 1;
  const inner = width - 2 - pad * 2;
  const edge = (/** @type {string} */ text) => fg(colour, text);

  const titlePart = options.title ? ` ${c.bold(options.title)} ` : '';
  const tagPart = options.tag ? ` ${ink.faint(options.tag)} ` : '';
  const used = visibleWidth(titlePart) + visibleWidth(tagPart);
  const fill = Math.max(0, width - 2 - used - 1);
  const top =
    edge(g.topLeft) + edge(g.horizontal) + titlePart + edge(g.horizontal.repeat(fill)) + tagPart + edge(g.topRight);

  const body = lines.map((line) => {
    const clipped = truncate(line, inner);
    return edge(g.vertical) + ' '.repeat(pad) + padEnd(clipped, inner) + ' '.repeat(pad) + edge(g.vertical);
  });

  const bottom = edge(g.bottomLeft + g.horizontal.repeat(width - 2) + g.bottomRight);
  return [top, ...body, bottom];
}

/**
 * A full-width rule with an optional label sitting in it. The section divider for flat output.
 *
 * @param {string} [label]
 * @param {number} [width]
 * @returns {string}
 */
export function rule(label, width = terminalWidth()) {
  const g = glyphs();
  if (!label) return ink.faint(g.horizontal.repeat(width));
  const text = ` ${c.bold(label)} `;
  const rest = Math.max(0, width - visibleWidth(text) - 2);
  return ink.faint(g.horizontal.repeat(2)) + text + ink.faint(g.horizontal.repeat(rest));
}

/**
 * @template T
 * @typedef {object} ListItem
 * @property {T} value
 * @property {string} label
 * @property {string} [note]
 * @property {boolean} [disabled] Rendered dim and unselectable.
 */

/**
 * The selectable list.
 *
 * The selected row is marked with an arrow and its label brightened rather than given a background:
 * a reverse-video bar looks wrong on half the colour schemes in use, and the arrow reads at a glance
 * on all of them.
 *
 * @template T
 * @param {readonly ListItem<T>[]} items
 * @param {number} selected
 * @param {{ width?: number }} [options]
 * @returns {string[]}
 */
export function listView(items, selected, options = {}) {
  const g = glyphs();
  const width = options.width ?? terminalWidth();
  const labelWidth = Math.max(...items.map((item) => visibleWidth(item.label)), 4);
  return items.map((item, index) => {
    const active = index === selected;
    const marker = active ? ink.accent(g.arrow) : ' ';
    // Padded only when something follows it. A row with no note would otherwise end in whatever
    // the longest label in the list needed, which is invisible on screen and ugly the moment
    // anybody copies the menu out of their terminal.
    const text = item.note ? padEnd(item.label, labelWidth) : item.label;
    const label = item.disabled ? ink.faint(text) : active ? c.bold(text) : text;
    const note = item.note ? `  ${ink.faint(item.note)}` : '';
    return truncate(`  ${marker} ${label}${note}`, width);
  });
}

/**
 * A one-line text field with a visible caret. Scrolls horizontally once the value outgrows the box.
 *
 * @param {string} value
 * @param {number} caret In code points, not UTF-16 units.
 * @param {{ width?: number; placeholder?: string }} [options]
 * @returns {string}
 */
export function textField(value, caret, options = {}) {
  const width = options.width ?? 48;
  if (value === '' && options.placeholder) return ink.faint(truncate(options.placeholder, width));
  // In code points, as the caret is, so the inverted cell is never half of a surrogate pair.
  const chars = [...value];
  const start = Math.max(0, caret - width + 1);
  const window = chars.slice(start, start + width);
  const local = caret - start;
  const before = window.slice(0, local).join('');
  const at = window[local] ?? ' ';
  const after = window.slice(local + 1).join('');
  return `${before}${invert(at)}${after}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function invert(text) {
  const ESC = String.fromCharCode(27);
  return `${ESC}[7m${text}${ESC}[27m`;
}

/**
 * A filled status dot, for a row that is reporting a state rather than a measurement.
 *
 * @param {Rgb} colour
 * @returns {string}
 */
export function dot(colour) {
  return fg(colour, glyphs().dot);
}

/**
 * The key hints along the bottom of a full-screen view.
 *
 * @param {ReadonlyArray<[string, string]>} pairs
 * @returns {string}
 */
export function keyHints(pairs) {
  return `  ${pairs.map(([key, what]) => `${c.bold(key)} ${ink.faint(what)}`).join(ink.faint('   '))}`;
}

/**
 * The product wordmark, ramped. Drawn once at the top of a full-screen view.
 *
 * @returns {string}
 */
export function wordmark() {
  return gradient('OpenGSO', PALETTE.ok, PALETTE.okBright);
}

/**
 * Spinner frames, advanced by the caller.
 *
 * No timer lives in here. The thing that redraws owns the clock, because a spinner with its own
 * `setInterval` keeps the event loop alive after the work finishes and the process hangs on exit.
 *
 * @param {number} tick
 * @returns {string}
 */
export function spinnerFrame(tick) {
  const frames = glyphs().spinner;
  return ink.accent(frames[tick % frames.length]);
}
