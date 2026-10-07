import { c } from '../shared/log.js';
import { SetupAbort } from './configure.js';
import { confirm, field, pause, select } from './tui/interact.js';
import { readKeys } from './tui/keys.js';
import { glyphs, stripAnsi, terminalWidth, truncate, wrap } from './tui/paint.js';
import { canUseTui, openScreen } from './tui/screen.js';
import { ink } from './tui/theme.js';
import { box, wordmark } from './tui/widgets.js';

/**
 * @import { ChoiceOption, Prompter } from './prompt.js'
 * @import { KeyReader } from './tui/keys.js'
 * @import { ScreenOptions } from './tui/screen.js'
 */

/**
 * Setup as a full-screen stepper, without a second implementation of setup.
 *
 * The temptation here is to write a TUI onboarding flow beside the flat one, and then to have two
 * things that both know what OpenGEO asks and in what order. This is a `Prompter` instead: the same
 * `runSetup`, the same four steps, the same questions in the same order, drawn differently. When
 * the gate is closed there is no stepper at all and `createPrompter` answers, so a pipe, a CI job
 * and `--yes` behave exactly as they did before any of this existed.
 *
 * The frame covers the questions and nothing else, which is the rule that decides where every line
 * of setup's prose ends up. Before the first `stage()` there is no frame at all and no screen has
 * been opened, so the "what this is" intro prints in ordinary scrollback exactly as it always has.
 * Between the first question and the last, what `runSetup` narrates is buffered and drawn above the
 * next question as the context for it, so the explanation for step 2 is on screen while step 2 is
 * being answered and gone by step 3. `settle()` ends the frame the moment the questions do, and the
 * summary, the key location and the closing score print live to scrollback after it.
 *
 * The screen is opened lazily rather than in `openStepper` for the first of those three: entering
 * the alternate buffer up front would swallow the intro, and there is no way to write to scrollback
 * once you are in it.
 */

/**
 * @typedef {object} Stepper
 * @property {Prompter} prompter
 * @property {(text: string) => void} write Where `runSetup`'s narration goes. Buffered, drawn above the
 *   next question, flushed on close.
 * @property {() => void} close
 */

/**
 * @typedef {ScreenOptions & {
 *   tag?: string; // Shown as the tag in the top right of the frame, e.g. `opengeo 0.1.0`.
 *   title?: string; // The title in the frame's top edge. Defaults to the wordmark.
 * }} StepperOptions
 */

/** How many buffered lines a frame will show. Beyond this the oldest are dropped, not the newest. */
const CONTEXT_LINES = 12;

/**
 * @param {StepperOptions} [options]
 * @returns {Stepper | undefined}
 */
export function openStepper(options = {}) {
  if (!canUseTui(options)) return undefined;
  const output = options.output ?? process.stdout;
  const keys = readKeys(options.input ?? process.stdin);
  // `framed` is the whole state machine: false means writes go to scrollback and no screen exists,
  // true means they are buffered into the next frame. `stage()` turns it on, `settle()` turns it off.
  const state = { label: '', index: 0, total: 0, buffer: '', framed: false };
  /** @type {Screen | undefined} */
  let screen;

  /**
   * Opened on the first question, not before. See the note at the top of the file.
   *
   * @returns {Screen}
   */
  const ensureScreen = () => (screen ??= openScreen(options));

  /**
   * Hands the terminal back and lets whatever was still buffered land in scrollback.
   *
   * @returns {void}
   */
  const settle = () => {
    state.framed = false;
    screen?.close();
    screen = undefined;
    const tail = state.buffer.replace(/^\n+/, '');
    state.buffer = '';
    if (tail.trim().length > 0) output.write(tail.endsWith('\n') ? tail : `${tail}\n`);
  };

  /**
   * The frame every question is drawn inside: rail, then whatever has been narrated since.
   *
   * @returns {string[]}
   */
  const header = () => {
    const width = Math.min(ensureScreen().size().columns, 96);
    const rail = state.total > 0 ? stepRail(state.label, state.index, state.total, width - 4) : [c.bold(state.label || 'Setup')];
    const lines = box(rail, { title: options.title ?? wordmark(), tag: options.tag, width });
    const context = state.buffer.split('\n');
    // Trailing blanks are an artefact of how the flat flow spaces itself for scrollback, and on a
    // repainting screen they only push the question down.
    while (context.length > 0 && /** @type {string} */ (context[context.length - 1]).trim() === '') context.pop();
    if (context.length > CONTEXT_LINES) context.splice(0, context.length - CONTEXT_LINES);
    return context.length > 0 ? [...lines, '', ...context.map((line) => `  ${line}`)] : lines;
  };

  /**
   * Escape and Ctrl-C from any question. Nothing has been saved yet, and the message says so.
   *
   * A declaration rather than a `const`, because that is what lets the compiler see that the lines
   * after each call are unreachable and stop asking the caller to handle an `undefined` answer.
   *
   * @returns {never}
   */
  function cancelled() {
    throw new SetupAbort('Setup was cancelled. Nothing was written.');
  }

  /** @type {Prompter} */
  const prompter = {
    /**
     * @param {string} label
     * @param {number} index
     * @param {number} total
     */
    stage(label, index, total) {
      state.label = label;
      state.index = index;
      state.total = total;
      // The narration belongs to the step that produced it, so a new step starts on a clean frame.
      state.buffer = '';
      state.framed = true;
    },
    /**
     * @param {string} question
     * @param {string} [fallback]
     * @returns {Promise<string>}
     */
    async ask(question, fallback) {
      const answer = await field(ensureScreen(), keys, {
        header: header(),
        label: question.trim(),
        value: fallback ?? '',
        hint: fallback ? `Enter keeps ${fallback}` : undefined,
      });
      if (answer === undefined) cancelled();
      state.buffer = '';
      return answer === '' ? fallback ?? '' : answer;
    },
    /**
     * @template {string} T
     * @param {string} question
     * @param {ChoiceOption<T>[]} choices
     * @param {T} fallback
     * @returns {Promise<T>}
     */
    async choose(question, choices, fallback) {
      const width = Math.min(terminalWidth(), 96);
      /** @type {T | undefined} */
      const answer = await select(ensureScreen(), keys, {
        header: [...header(), '', `  ${c.bold(question.trim())}`],
        items: choices.map((choice) => ({ value: choice.value, label: choice.label, note: noteFor(choice, width) })),
        selected: Math.max(0, choices.findIndex((choice) => choice.value === fallback)),
        hints: [['up/down', 'move'], ['enter', 'select'], ['esc', 'cancel']],
      });
      if (answer === undefined) cancelled();
      state.buffer = '';
      return answer;
    },
    /**
     * @param {string} question
     * @returns {Promise<string>}
     */
    async secret(question) {
      const answer = await field(ensureScreen(), keys, {
        header: header(),
        label: stripAnsi(question).replace(/:\s*$/, '').trim(),
        secret: true,
        hint: 'Shown as asterisks, written to .env, and never printed anywhere else.',
      });
      if (answer === undefined) cancelled();
      state.buffer = '';
      return answer;
    },
    /**
     * @param {string} question
     * @param {boolean} fallback
     * @returns {Promise<boolean>}
     */
    async confirm(question, fallback) {
      const answer = await confirm(ensureScreen(), keys, { header: header(), question: question.trim(), fallback });
      if (answer === undefined) cancelled();
      state.buffer = '';
      return answer;
    },
    /** @returns {Promise<void>} */
    async pause() {
      // The frame is already showing what there is to read; all this adds is the reason to stop.
      const carryOn = await pause(ensureScreen(), keys, { header: header(), hint: 'next step' });
      if (!carryOn) cancelled();
      state.buffer = '';
    },
    settle,
    close() {
      // Owned by the stepper, not by whoever borrowed the prompter: `runSetup`'s callers close the
      // prompter in a `finally`, and closing the screen there would tear the frame down early.
    },
  };

  return {
    prompter,
    /** @param {string} text */
    write(text) {
      if (state.framed) state.buffer += text;
      // Outside the frame there is nothing to draw it above, and no screen in the way of printing
      // it: the intro before the first question, and everything after the last one.
      else output.write(text);
    },
    close() {
      // Idempotent, because the usual path has already settled and this is the `finally` behind it.
      settle();
      keys.close();
    },
  };
}

/**
 * Where you are, as one line and one row of dots.
 *
 * A rail rather than a percentage: setup has four steps, they are not the same size, and a bar that
 * claimed 25% after the first question would be measuring the wrong thing. Dots say how many are
 * left, which is the only number anybody wants at a prompt.
 *
 * @param {string} label
 * @param {number} index
 * @param {number} total
 * @param {number} [width]
 * @returns {string[]}
 */
export function stepRail(label, index, total, width = terminalWidth()) {
  const g = glyphs();
  const dots = Array.from({ length: total }, (_, position) => {
    if (position + 1 < index) return ink.ok(g.dot);
    if (position + 1 === index) return ink.accent(g.dot);
    return ink.faint(g.dot);
  }).join(' ');
  return [truncate(`${dots}   ${c.bold(`Step ${index} of ${total}`)}  ${label}`, Math.max(8, width))];
}

/**
 * Choice notes wrap under the label rather than running off the frame.
 *
 * @template {string} T
 * @param {ChoiceOption<T>} choice
 * @param {number} width
 * @returns {string | undefined}
 */
function noteFor(choice, width) {
  if (!choice.note) return undefined;
  const room = Math.max(20, width - stripAnsi(choice.label).length - 10);
  const [first] = wrap(choice.note, room);
  if (!first) return undefined;
  return first.length < choice.note.length ? `${first.replace(/\s+\S*$/, '')}...` : first;
}

/**
 * Exported for the tests: a screen the stepper can be driven against without a terminal.
 *
 * @typedef {import('./tui/screen.js').Screen} Screen
 */
