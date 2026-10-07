import { isCI } from '../shared/ci.js';
import { c } from '../shared/log.js';
import { colourDepth, terminalWidth, truncate } from '../shared/render/paint.js';
import { ink } from '../shared/render/theme.js';
import { progressMeter } from '../shared/render/meters.js';
import { spinnerFrame } from './tui/widgets.js';

/**
 * The thing that runs while you wait.
 *
 * A crawl of forty routes, or ten sequential provider calls, is a minute of a tool saying nothing.
 * The old answer was one appended line per unit of work, which is honest and turns a long run into
 * four hundred lines of scrollback that bury the report underneath them.
 *
 * So there are two modes, and the choice is made once, from the terminal:
 *
 * - **Live.** One block, two lines, redrawn in place: spinner, phase, meter, and what is being
 *   worked on right now. It leaves nothing behind when it finishes.
 * - **Plain.** What the CLI printed before this module existed: a phase heading, then one
 *   `[3/10] route` line per item. This is what a pipe, a CI log, `NO_COLOR` and `TERM=dumb` get,
 *   and `--json` gets it by never constructing a reporter at all.
 *
 * Nothing here writes an escape code in plain mode. That is the whole point of the split: a log
 * file is not a terminal, and cursor moves in one are corruption.
 */

const CSI = `${String.fromCharCode(27)}[`;
const FRAME_MS = 90;
const METER_WIDTH = 18;

/**
 * @typedef {object} ProgressOptions
 * @property {NodeJS.WriteStream} [output]
 * @property {boolean} [plain] Force the append-only transcript, whatever the terminal claims.
 */

/**
 * @typedef {object} Progress
 * @property {(label: string) => void} phase Start a new phase. Resets the counter and, in plain mode,
 *   prints a heading.
 * @property {(done: number, total: number, label?: string) => void} step Advance within the phase. A
 *   `total` of 0 means the size is not known yet.
 * @property {(text: string) => void} note A line that survives into scrollback in both modes, with the
 *   block redrawn under it.
 * @property {(text?: string) => void} finish End the current phase: clear the block, write `text` if
 *   there is one, and go quiet until the next `phase()`. This is what a run with several timed stages
 *   uses between them.
 * @property {(summary?: string) => void} done `finish`, and stop for good. Nothing paints after this.
 */

/**
 * Whether the live block is appropriate here.
 *
 * Unlike `canUseTui` this does not ask about stdin: nothing here reads a key, so a command being
 * fed from a pipe can still redraw its own output perfectly well. Everything else is the same
 * question, and `colourDepth()` already folds in `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`.
 *
 * @param {NodeJS.WriteStream} [output]
 * @returns {boolean}
 */
export function canRedraw(output = process.stdout) {
  if (!output.isTTY) return false;
  if (isCI()) return false;
  if (process.env.OPENGEO_NO_TUI) return false;
  return colourDepth() > 0;
}

/**
 * @param {ProgressOptions} [options]
 * @returns {Progress}
 */
export function createProgress(options = {}) {
  const output = options.output ?? process.stdout;
  return !options.plain && canRedraw(output) ? liveProgress(output) : plainProgress(output);
}

/**
 * The old behaviour, kept: a heading per phase, a line per item, nothing redrawn.
 *
 * @param {NodeJS.WriteStream} output
 * @returns {Progress}
 */
function plainProgress(output) {
  return {
    phase(label) {
      output.write(`\n  ${c.gray(label)}\n`);
    },
    step(done, total, label) {
      const counter = total > 0 ? `[${done}/${total}]` : `[${done}]`;
      output.write(label ? `  ${c.gray(counter)} ${label}\n` : `  ${c.gray(counter)}\n`);
    },
    note(text) {
      output.write(`${text}\n`);
    },
    finish(text) {
      if (text) output.write(`${text}\n`);
    },
    done(summary) {
      if (summary) output.write(`${summary}\n`);
    },
  };
}

/**
 * @param {NodeJS.WriteStream} output
 * @returns {Progress}
 */
function liveProgress(output) {
  let label = '';
  let subject = '';
  let done = 0;
  let total = 0;
  let tick = 0;
  let painted = 0;
  let closed = false;

  const clear = () => {
    if (painted === 0) return;
    // Up over the block, then erase from the cursor to the end of the screen. Carriage returns
    // alone would leave the tail of a longer previous frame sitting on screen under a shorter one.
    output.write(`${CSI}${painted}A${CSI}0J`);
    painted = 0;
  };

  /** @returns {string[]} */
  const frame = () => {
    // The stream being written to, not `process.stdout`: they are the same in production and are
    // not in a test, and a block that overflows its own stream is the one bug this module cannot
    // be allowed to have.
    const width = Math.max(40, Math.min(120, output.columns || terminalWidth(120)));
    const counter = total > 0 ? c.gray(`${done}/${total}`) : done > 0 ? c.gray(String(done)) : '';
    const bar = total > 0 ? `  ${progressMeter(done, total, METER_WIDTH)}` : '';
    const lines = [truncate(`  ${spinnerFrame(tick)} ${c.bold(label)}${bar}  ${counter}`, width)];
    if (subject) lines.push(truncate(`    ${ink.muted(subject)}`, width));
    return lines;
  };

  const paint = () => {
    if (closed || !label) return;
    clear();
    const lines = frame();
    output.write(`${lines.join('\n')}\n`);
    painted = lines.length;
  };

  // Named rather than inlined on the returned object, so `done` can call it without depending on
  // `this` surviving a destructure.
  /** @param {string} [text] */
  const finishBlock = (text) => {
    if (closed) return;
    clear();
    // An empty label is what makes `paint()` a no-op, so the timer can keep ticking harmlessly
    // between phases without drawing a stale block over whatever was printed in the gap.
    label = '';
    subject = '';
    if (text) output.write(`${text}\n`);
  };

  // Unref'd, so a forgotten `done()` can never hold the process open, and the spinner cannot keep
  // an otherwise finished command alive.
  const timer = setInterval(() => {
    tick += 1;
    paint();
  }, FRAME_MS);
  timer.unref?.();

  return {
    phase(next) {
      label = next;
      subject = '';
      done = 0;
      total = 0;
      paint();
    },
    step(nextDone, nextTotal, nextLabel) {
      done = nextDone;
      total = nextTotal;
      if (nextLabel !== undefined) subject = nextLabel;
      paint();
    },
    note(text) {
      clear();
      output.write(`${text}\n`);
      paint();
    },
    finish: finishBlock,
    done(summary) {
      if (closed) return;
      finishBlock(summary);
      closed = true;
      clearInterval(timer);
    },
  };
}
