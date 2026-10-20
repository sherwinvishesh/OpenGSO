/**
 * Colour, width and glyphs, for a terminal whose capabilities are not known in advance.
 *
 * `shared/log.js` covers the nine basic SGR pairs and is used in fifty places, so it stays exactly
 * as it is. This is the layer above it: 24-bit colour where the terminal has it, 256 where it does
 * not, the basic nine where it has neither, and plain text where colour is switched off entirely.
 * Everything degrades on its own, so a caller never has to ask what it is drawing on.
 *
 * Width is the other half. Once output contains escape sequences, `String.length` stops being the
 * number of columns a string occupies, and every alignment in the report is wrong by the length of
 * its colour codes. `visibleWidth` is the answer to that, and every pad, truncate and wrap here is
 * written in terms of it.
 */

import { isCI } from '../ci.js';
import { colourDepth } from '../log.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

/**
 * 0 no colour, 1 the basic sixteen, 2 the 256-colour cube, 3 full 24-bit.
 *
 * @typedef {0 | 1 | 2 | 3} ColourDepth
 */

// What the terminal can show. The rule lives with the basic colours, so the two never disagree.
export { colourDepth };

/**
 * Whether box-drawing and block glyphs will render as one column each.
 *
 * A terminal without a UTF-8 locale prints them as replacement characters or, worse, as two columns,
 * which silently breaks every box in the interface. The ASCII fallback is not as pretty and is
 * always correct.
 *
 * @returns {boolean}
 */
export function unicodeOk() {
  if (process.env.OPENGSO_ASCII) return false;
  if (process.platform === 'win32') return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  return /utf-?8/i.test(locale);
}

/**
 * @typedef {object} Rgb
 * @property {number} r
 * @property {number} g
 * @property {number} b
 */

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {Rgb}
 */
export function rgb(r, g, b) {
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) };
}

/**
 * @param {string} value
 * @returns {Rgb}
 */
export function hex(value) {
  const raw = value.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
  return rgb(parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16));
}

/**
 * Foreground. Picks the best encoding the terminal admits to, and returns the text bare at depth 0.
 *
 * @param {Rgb} colour
 * @param {string} text
 * @returns {string}
 */
export function fg(colour, text) {
  const depth = colourDepth();
  if (depth === 0) return text;
  if (depth === 3) return `${CSI}38;2;${colour.r};${colour.g};${colour.b}m${text}${CSI}39m`;
  if (depth === 2) return `${CSI}38;5;${cube(colour)}m${text}${CSI}39m`;
  return `${CSI}${basic(colour)}m${text}${CSI}39m`;
}

/**
 * Nearest cell in the xterm 6x6x6 cube, or the greyscale ramp when the channels are close enough.
 *
 * @param {Rgb} colour
 * @returns {number}
 */
function cube(colour) {
  const { r, g, b } = colour;
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const axis = (/** @type {number} */ v) => Math.round((v / 255) * 5);
  return 16 + 36 * axis(r) + 6 * axis(g) + axis(b);
}

/**
 * Nearest of the eight, plus the bright bit when the colour is light enough to warrant it.
 *
 * @param {Rgb} colour
 * @returns {number}
 */
function basic(colour) {
  const { r, g, b } = colour;
  const bright = Math.max(r, g, b) > 160;
  const bit = (/** @type {number} */ v) => (v > 96 ? 1 : 0);
  const code = bit(r) + bit(g) * 2 + bit(b) * 4;
  return (bright ? 90 : 30) + code;
}

/**
 * A colour `t` of the way from `from` to `to`, 0..1.
 *
 * Mixed in sRGB rather than a perceptual space on purpose: the ramps here run between two hues that
 * are already close in lightness, where the difference is not worth the arithmetic.
 *
 * @param {Rgb} from
 * @param {Rgb} to
 * @param {number} t
 * @returns {Rgb}
 */
export function mix(from, to, t) {
  const k = clamp(t, 0, 1);
  return rgb(
    Math.round(from.r + (to.r - from.r) * k),
    Math.round(from.g + (to.g - from.g) * k),
    Math.round(from.b + (to.b - from.b) * k),
  );
}

/**
 * Paints each character its own step along a ramp. One escape per character, so keep the runs short.
 *
 * @param {string} text
 * @param {Rgb} from
 * @param {Rgb} to
 * @returns {string}
 */
export function gradient(text, from, to) {
  if (colourDepth() < 2 || text.length < 2) return fg(to, text);
  const chars = [...text];
  return chars.map((ch, index) => fg(mix(from, to, index / (chars.length - 1)), ch)).join('');
}

/** Matches an SGR sequence and the handful of cursor sequences this codebase emits. */
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}[()][A-B0-2]|${ESC}[78=>]`, 'g');

/**
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Columns a string occupies once drawn.
 *
 * Escapes are removed first, then the wide ranges are counted twice: CJK, Hangul, and the emoji
 * planes, which is enough for the box drawing here to stay square. Combining marks count as zero.
 *
 * @param {string} text
 * @returns {number}
 */
export function visibleWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x200d) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    if (code === 0xfe0f) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * Cut to `width` columns, keeping escapes intact.
 *
 * Truncating a coloured string by slicing bytes can land in the middle of an escape sequence and
 * dump `[38;2;108m` into the report, so the sequences are stepped over rather than counted.
 *
 * @param {string} text
 * @param {number} width
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncate(text, width, ellipsis = '...') {
  if (visibleWidth(text) <= width) return text;
  const budget = Math.max(0, width - ellipsis.length);
  let out = '';
  let used = 0;
  let index = 0;
  const chars = [...text];
  while (index < chars.length && used < budget) {
    const ch = chars[index];
    if (ch === ESC) {
      // Copy the whole sequence: it costs no columns but dropping half of it corrupts the line.
      let seq = ch;
      index += 1;
      while (index < chars.length) {
        const next = chars[index];
        seq += next;
        index += 1;
        if (/[A-Za-z]/.test(next)) break;
      }
      out += seq;
      continue;
    }
    const w = visibleWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
    index += 1;
  }
  // Any colour still open at the cut has to be closed, or it bleeds into the rest of the line.
  return `${out}${CSI}0m${ellipsis}`;
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} [filler]
 * @returns {string}
 */
export function padEnd(text, width, filler = ' ') {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + filler.repeat(gap) : text;
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} [filler]
 * @returns {string}
 */
export function padStart(text, width, filler = ' ') {
  const gap = width - visibleWidth(text);
  return gap > 0 ? filler.repeat(gap) + text : text;
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function centre(text, width) {
  const gap = width - visibleWidth(text);
  if (gap <= 0) return text;
  const left = Math.floor(gap / 2);
  return ' '.repeat(left) + text + ' '.repeat(gap - left);
}

/**
 * Word wrap to a column count, breaking a word that is longer than the line rather than letting it
 * run off. Plain text only: wrapping a coloured string would need the open sequence reopened on
 * every line, and nothing here needs that.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  if (width <= 0) return [text];
  /** @type {string[]} */
  const out = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === '') {
        line = word;
      } else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (visibleWidth(line) > width) {
        out.push(truncate(line, width, ''));
        line = [...line].slice(width).join('');
      }
    }
    out.push(line);
  }
  return out;
}

/** The indent under a report row: body text, notes and fixes all start in this column. */
export const BODY_INDENT = 6;

/**
 * Wrap body text into the report's body column, so prose under a check or a probe row lines up
 * whichever report it is in.
 *
 * @param {string} text
 * @param {number} width
 * @param {(value: string) => string} [paint]
 * @returns {string[]}
 */
export function indentWrapped(text, width, paint = (value) => value) {
  const gutter = ' '.repeat(BODY_INDENT);
  return wrap(text, Math.max(20, width - BODY_INDENT)).map((line) => `${gutter}${paint(line)}`);
}

/**
 * Whether output can be redrawn in place: the live progress block, and half of the full-screen gate.
 *
 * This does not ask about stdin: nothing that redraws reads a key, so a command being fed from a
 * pipe can still redraw its own output perfectly well. `canUseTui` is this plus a terminal on
 * stdin. `colourDepth()` already folds in `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`.
 *
 * @param {NodeJS.WriteStream} [output]
 * @returns {boolean}
 */
export function canRedraw(output = process.stdout) {
  if (!output.isTTY) return false;
  if (isCI()) return false;
  if (process.env.OPENGSO_NO_TUI) return false;
  return colourDepth() > 0;
}

/**
 * Terminal width, floored so a narrow pane cannot produce negative padding, capped so a maximised
 * window does not stretch a two-column table across 300 characters.
 *
 * @param {number} [max]
 * @returns {number}
 */
export function terminalWidth(max = 92) {
  const columns = process.stdout && process.stdout.columns ? process.stdout.columns : 80;
  return Math.max(40, Math.min(max, columns));
}

/**
 * Box drawing, meters and status marks, in a Unicode set and an ASCII one that is always safe.
 *
 * @typedef {object} GlyphSet
 * @property {string} topLeft
 * @property {string} topRight
 * @property {string} bottomLeft
 * @property {string} bottomRight
 * @property {string} horizontal
 * @property {string} vertical
 * @property {string[]} blocks Eight steps of a filled cell, for sub-character meter resolution.
 * @property {string} empty
 * @property {string} ghost A cell that is measurable but not being measured yet: the locked half of a meter.
 * @property {string} dot
 * @property {string} arrow
 * @property {string} tick
 * @property {string} cross
 * @property {string} tilde
 * @property {string} lock
 * @property {string[]} spinner
 * @property {string[]} spark
 */

/** @type {GlyphSet} */
const UNICODE = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  blocks: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
  empty: '░',
  ghost: '▒',
  dot: '●',
  arrow: '▸',
  tick: '✓',
  cross: '✗',
  tilde: '∼',
  lock: '▫',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
};

/** @type {GlyphSet} */
const ASCII = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  blocks: ['#', '#', '#', '#', '#', '#', '#', '#'],
  empty: '.',
  ghost: ':',
  dot: '*',
  arrow: '>',
  tick: 'v',
  cross: 'x',
  tilde: '~',
  lock: '-',
  spinner: ['-', '\\', '|', '/'],
  spark: ['_', '.', '-', '-', '=', '=', '^', '^'],
};

/**
 * @returns {GlyphSet}
 */
export function glyphs() {
  return unicodeOk() ? UNICODE : ASCII;
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}
