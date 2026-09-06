import { colourDepth } from './paint.js';

/**
 * Ownership of the terminal, and giving it back.
 *
 * A full-screen interface has to switch the terminal into the alternate buffer, hide the cursor and
 * put stdin into raw mode. All three are global mutations of something the user owns, and any exit
 * path that skips the restore leaves them with an invisible cursor and a shell that no longer echoes
 * what they type. So the restore is registered once, on `exit`, on both fatal signals and on an
 * uncaught throw, and it is idempotent: there is no code path out of this process that leaves the
 * terminal changed.
 */

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

const ALT_ON = `${CSI}?1049h`;
const ALT_OFF = `${CSI}?1049l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR = `${CSI}2J${CSI}H`;

export interface Size {
  columns: number;
  rows: number;
}

export interface ScreenOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export interface Screen {
  size(): Size;
  /** Wipe and redraw from the top left. The whole frame is written in one `write` so it cannot tear. */
  paint(lines: string[]): void;
  /** Step out to the normal buffer, run something that prints for itself, step back in. */
  suspend<T>(run: () => Promise<T>): Promise<T>;
  onResize(handler: () => void): () => void;
  close(): void;
}

/**
 * Whether a full-screen interface is appropriate here at all.
 *
 * Both streams have to be a terminal, because raw mode needs stdin and the alternate buffer needs
 * stdout, and a pipe on either side means somebody is capturing the output rather than reading it.
 * CI is excluded even when it hands us a pty: a build log full of cursor moves is not a build log.
 */
export function canUseTui(options: ScreenOptions = {}): boolean {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) return false;
  if (process.env.OPENGEO_NO_TUI) return false;
  if (process.env.CI) return false;
  return colourDepth() > 0;
}

let restore: (() => void) | undefined;
let hooked = false;

/**
 * Registered once per process, not once per screen.
 *
 * The home screen opens and closes a screen every time it suspends for a command, and adding a
 * listener on each pass would trip Node's max-listeners warning after ten runs and, worse, would
 * restore the terminal ten times over.
 */
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  const cleanup = () => restore?.();
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (error) => {
    cleanup();
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}

export function openScreen(options: ScreenOptions = {}): Screen {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const resizeHandlers = new Set<() => void>();
  let open = false;

  const enter = () => {
    if (open) return;
    open = true;
    output.write(ALT_ON + CURSOR_HIDE + CLEAR);
    if (input.isTTY && !input.isRaw) input.setRawMode(true);
  };

  const leave = () => {
    if (!open) return;
    open = false;
    if (input.isTTY && input.isRaw) input.setRawMode(false);
    output.write(CURSOR_SHOW + ALT_OFF);
  };

  hookExit();
  restore = leave;
  enter();

  const onResize = () => {
    for (const handler of resizeHandlers) handler();
  };
  output.on('resize', onResize);

  return {
    size(): Size {
      return { columns: output.columns || 80, rows: output.rows || 24 };
    },

    paint(lines: string[]): void {
      const { rows } = this.size();
      // Clipped rather than scrolled. A frame taller than the window would push its own top off the
      // screen, and the top is where the header is.
      const visible = lines.slice(0, Math.max(1, rows - 1));
      const frame = visible.map((line) => `${line}${CSI}K`).join('\n');
      output.write(`${CSI}H${CSI}J${frame}`);
    },

    async suspend<T>(run: () => Promise<T>): Promise<T> {
      leave();
      try {
        return await run();
      } finally {
        enter();
      }
    },

    onResize(handler: () => void): () => void {
      resizeHandlers.add(handler);
      return () => resizeHandlers.delete(handler);
    },

    close(): void {
      output.off('resize', onResize);
      resizeHandlers.clear();
      leave();
      if (restore === leave) restore = undefined;
    },
  };
}
