/** Tiny ANSI helper. A colour library would be a dependency for something that is 20 lines. */
const ESC = String.fromCharCode(27) + '[';

/**
 * What a stream can show: 0 no colour, 1 the basic sixteen, 2 the 256-colour cube, 3 full 24-bit.
 *
 * The one rule for colour, used by `c` below and by everything `shared/render/paint.js` draws, so the two
 * can never disagree about whether it is on. Read fresh on every call rather than cached at import
 * time: the test suite sets and unsets these variables between cases.
 *
 * @param {{ isTTY?: boolean } | undefined} [stream] Where the text is going. stdout by default, and
 *   stderr is asked about separately, because either can be a pipe while the other is a terminal.
 * @returns {0 | 1 | 2 | 3}
 */
export function colourDepth(stream = process.stdout) {
  const env = process.env;
  if (env.NO_COLOR) return 0;
  // FORCE_COLOR=0 is the conventional way to turn colour off, so it cannot be read as merely "set".
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    if (force === '0' || force.toLowerCase() === 'false') return 0;
    if (force === '1') return 1;
    if (force === '2') return 2;
    return 3;
  }
  if (!stream || !stream.isTTY) return 0;
  const term = env.TERM ?? '';
  // A dumb terminal is a terminal that has told us it cannot do this, though it reports isTTY.
  if (term === 'dumb') return 0;
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  // A Windows console sets no TERM at all, and every one the supported Node versions run on
  // understands these sequences. Windows Terminal is the one known to do 24-bit.
  if (process.platform === 'win32' && !term) return env.WT_SESSION ? 3 : 2;
  // Terminal.app reports xterm-256color and means it, but it cannot do 24-bit. iTerm, Kitty,
  // WezTerm, Ghostty and VS Code all set COLORTERM, so the check above has already caught them.
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 2;
  if (term.includes('256color')) return 2;
  if (term.includes('color') || term.includes('xterm') || term.includes('screen')) return 1;
  return 0;
}

/**
 * @param {() => { isTTY?: boolean } | undefined} stream
 */
const palette = (stream) => {
  /**
   * @param {number} open
   * @param {number} close
   * @returns {(s: string) => string}
   */
  const wrap = (open, close) => (s) => (colourDepth(stream()) > 0 ? `${ESC}${open}m${s}${ESC}${close}m` : s);
  return {
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
};

export const c = palette(() => process.stdout);

/** The same colours, decided for stderr, which is what a message written there should ask. */
export const cErr = palette(() => process.stderr);

export const SYM = {
  pass: () => c.green('PASS'),
  fail: () => c.red('FAIL'),
  warn: () => c.yellow('WARN'),
  na: () => c.gray(' n/a'),
  // Four characters like the rest, so a column of statuses stays a column.
  partial: () => c.yellow('PART'),
  locked: () => c.gray('LOCK'),
  // A convention the page has not adopted. Not red: nothing here is broken.
  suggestion: () => c.cyan('TIP '),
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
