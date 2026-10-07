/** Tiny ANSI helper. A colour library would be a dependency for something that is 20 lines. */
const ESC = String.fromCharCode(27) + '[';

/** @returns {boolean} */
const enabled = () => {
  if (process.env.NO_COLOR) return false;
  // FORCE_COLOR=0 is the conventional way to turn colour off, so it cannot be read as merely "set".
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') return force !== '0' && force.toLowerCase() !== 'false';
  // A dumb terminal is a terminal that has told us it cannot do this. It reports isTTY, so the
  // check below would have said yes and filled the screen with the literal escape sequences.
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout && process.stdout.isTTY);
};

/**
 * @param {number} open
 * @param {number} close
 * @returns {(s: string) => string}
 */
const wrap = (open, close) => (s) =>
  enabled() ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const SYM = {
  pass: () => c.green('PASS'),
  fail: () => c.red('FAIL'),
  warn: () => c.yellow('WARN'),
  na: () => c.gray(' n/a'),
  // Four characters like the rest, so a column of statuses stays a column.
  partial: () => c.yellow('PART'),
  locked: () => c.gray('LOCK'),
};

/**
 * @param {string} text
 * @returns {string}
 */
export function heading(text) {
  return `\n${c.bold(text)}\n${c.gray('-'.repeat(Math.max(text.length, 8)))}`;
}

/**
 * Bytes a terminal would act on rather than print: C0 controls other than newline and tab (ESC,
 * BEL, carriage return), DEL, the C1 block (0x9b is a one-byte CSI), and the bidi overrides that
 * make text read in a different order from the order it is in.
 */
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Remote text, made printable.
 *
 * A tested page, a provider's error body and a model's answer can all carry escape sequences that
 * set the window title, write the clipboard, erase lines or hide everything after them. Dropping
 * the control bytes leaves the rest as inert, readable text.
 *
 * @param {string} text
 * @returns {string}
 */
export function terminalText(text) {
  return text.replace(TERMINAL_UNSAFE, '');
}

/**
 * {@link terminalText} over every string in a result, as a copy.
 *
 * This is the render boundary: each renderer cleans what it was handed before adding any colour of
 * its own, so one call covers every field and a new field is covered without anyone remembering.
 * Only plain objects and arrays are walked. JSON output does not come through here, because
 * `JSON.stringify` already escapes control characters and the data should stay exact.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function terminalSafe(value) {
  if (typeof value === 'string') return /** @type {T} */ (terminalText(value));
  if (Array.isArray(value)) return /** @type {T} */ (value.map((item) => terminalSafe(item)));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return /** @type {T} */ (Object.fromEntries(Object.entries(value).map(([key, item]) => [key, terminalSafe(item)])));
  }
  return value;
}
