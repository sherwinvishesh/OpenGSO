import { colourDepth } from '../../shared/render/paint.js';

/**
 * Ownership of the terminal, and giving it back.
 *
 * A full-screen interface has to switch the terminal into the alternate buffer, hide the cursor and
 * put stdin into raw mode. All three are global mutations of something the user owns, and any exit
 * path that skips the restore leaves them with an invisible cursor and a shell that no longer echoes
 * what they type. So the restore is registered on `exit` and on an uncaught throw, and on both fatal
 * signals while any screen is open, and it is idempotent: there is no code path out of this process
 * that leaves the terminal changed.
 */

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

const ALT_ON = `${CSI}?1049h`;
const ALT_OFF = `${CSI}?1049l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR = `${CSI}2J${CSI}H`;

/**
 * @typedef {object} Size
 * @property {number} columns
 * @property {number} rows
 */

/**
 * @typedef {object} ScreenOptions
 * @property {NodeJS.ReadStream} [input]
 * @property {NodeJS.WriteStream} [output]
 */

/**
 * @typedef {object} Screen
 * @property {() => Size} size
 * @property {(lines: string[]) => void} paint Wipe and redraw from the top left. The whole frame is
 *   written in one `write` so it cannot tear.
 * @property {<T>(run: () => Promise<T>) => Promise<T>} suspend Step out to the normal buffer, run
 *   something that prints for itself, step back in.
 * @property {(handler: () => void) => () => void} onResize
 * @property {() => void} close
 */

/**
 * Whether a full-screen interface is appropriate here at all.
 *
 * Both streams have to be a terminal, because raw mode needs stdin and the alternate buffer needs
 * stdout, and a pipe on either side means somebody is capturing the output rather than reading it.
 * CI is excluded even when it hands us a pty: a build log full of cursor moves is not a build log.
 *
 * @param {ScreenOptions} [options]
 * @returns {boolean}
 */
export function canUseTui(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) return false;
  if (process.env.OPENGEO_NO_TUI) return false;
  if (process.env.CI) return false;
  return colourDepth() > 0;
}

/**
 * The restore of every screen that currently holds the terminal, innermost last. One slot was not
 * enough: a command run from the home screen opens a screen of its own, and closing it emptied the
 * slot while the home screen went back to raw mode with nothing left to undo it.
 *
 * @type {Array<() => void>}
 */
const openScreens = [];
let hooked = false;

/**
 * What the exit hooks run. Exported so the safety net can be exercised without killing anything.
 *
 * @returns {void}
 */
export function restoreScreens() {
  for (const leave of [...openScreens].reverse()) leave();
}

const onSigint = () => {
  restoreScreens();
  process.exit(130);
};

const onSigterm = () => {
  restoreScreens();
  process.exit(143);
};

/**
 * The signal hooks are held only while a screen holds the terminal. Held for good, they ran first
 * and exited on every later Ctrl-C, so `opengeo start` launched from the home screen never got to
 * close its server.
 *
 * @param {boolean} armed
 * @returns {void}
 */
function armSignals(armed) {
  if (armed) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  } else {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

/**
 * Registered once per process, not once per screen.
 *
 * The home screen opens and closes a screen every time it suspends for a command, and adding a
 * listener on each pass would trip Node's max-listeners warning after ten runs and, worse, would
 * restore the terminal ten times over.
 *
 * @returns {void}
 */
function hookExit() {
  if (hooked) return;
  hooked = true;
  const cleanup = restoreScreens;
  process.on('exit', cleanup);
  process.on('uncaughtException', (error) => {
    cleanup();
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}

/**
 * @param {ScreenOptions} [options]
 * @returns {Screen}
 */
export function openScreen(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  /** @type {Set<() => void>} */
  const resizeHandlers = new Set();
  let open = false;

  const enter = () => {
    if (open) return;
    open = true;
    if (openScreens.length === 0) armSignals(true);
    openScreens.push(leave);
    output.write(ALT_ON + CURSOR_HIDE + CLEAR);
    if (input.isTTY && !input.isRaw) input.setRawMode(true);
  };

  /** @returns {void} */
  function leave() {
    if (!open) return;
    open = false;
    const index = openScreens.lastIndexOf(leave);
    if (index !== -1) openScreens.splice(index, 1);
    if (openScreens.length === 0) armSignals(false);
    if (input.isTTY && input.isRaw) input.setRawMode(false);
    output.write(CURSOR_SHOW + ALT_OFF);
  }

  hookExit();
  enter();

  const onResize = () => {
    for (const handler of resizeHandlers) handler();
  };
  output.on('resize', onResize);

  return {
    /** @returns {Size} */
    size() {
      return { columns: output.columns || 80, rows: output.rows || 24 };
    },

    /**
     * @param {string[]} lines
     * @returns {void}
     */
    paint(lines) {
      const { rows } = this.size();
      // Clipped rather than scrolled. A frame taller than the window would push its own top off the
      // screen, and the top is where the header is.
      const visible = lines.slice(0, Math.max(1, rows - 1));
      const frame = visible.map((line) => `${line}${CSI}K`).join('\n');
      output.write(`${CSI}H${CSI}J${frame}`);
    },

    /**
     * @template T
     * @param {() => Promise<T>} run
     * @returns {Promise<T>}
     */
    async suspend(run) {
      leave();
      try {
        return await run();
      } finally {
        enter();
      }
    },

    /**
     * @param {() => void} handler
     * @returns {() => void}
     */
    onResize(handler) {
      resizeHandlers.add(handler);
      return () => resizeHandlers.delete(handler);
    },

    /** @returns {void} */
    close() {
      output.off('resize', onResize);
      resizeHandlers.clear();
      leave();
    },
  };
}
