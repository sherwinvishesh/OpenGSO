import { createInterface } from 'node:readline';
import { c } from '../shared/log.js';

/** @import { Interface } from 'node:readline' */

/**
 * The prompts `opengeo start` and `opengeo settings` need, and nothing else.
 *
 * `node:readline` is in the standard library, so an interactive setup costs no dependency.
 * The API key prompt masks its input: it is the one value in OpenGEO that must never end up in a
 * scrollback buffer or a screen recording (§11).
 *
 * This uses the callback flavour rather than `node:readline/promises` for one specific reason:
 * masking requires overriding `_writeToOutput`, and the promises Interface does not have it. The
 * promises version reads better right up until the moment the secret prompt echoes the key.
 */

/**
 * Every default is announced the same way, in one place, so no prompt can drift into its own
 * phrasing. The word matters more than the brackets: `[public]` looks like an instruction to type
 * something, `[default: public]` looks like what pressing Enter will do.
 */
export const DEFAULT_LABEL = 'default: ';

/**
 * @typedef {object} Prompter
 * @property {(question: string, fallback?: string) => Promise<string>} ask
 * @property {<T extends string>(question: string, options: ChoiceOption<T>[], fallback: T) => Promise<T>} choose
 * @property {(question: string) => Promise<string>} secret
 * @property {(question: string, fallback: boolean) => Promise<boolean>} confirm
 * @property {() => void} close
 * @property {(label: string, index: number, total: number) => void} [stage] Where in a multi-step flow
 *   the next question sits.
 *
 *   Optional because it is a drawing concern and most prompters have no drawing to do: the readline
 *   prompter below ignores it entirely and `runSetup`'s own `heading()` lines already say the same
 *   thing in scrollback. The full-screen stepper is the one implementation that needs it, and this
 *   is how it finds out without setup having to know which prompter it got.
 * @property {() => void} [settle] No more questions.
 *
 *   A prompter that took the screen over gives it back here, so everything setup says afterwards -
 *   the summary, where the key lives, the closing score - lands in normal scrollback where it can be
 *   scrolled and copied like any other command's output. Called once, before the last thing setup
 *   prints rather than after it, so the tail is written live instead of appearing all at once.
 *
 *   Optional for the same reason `stage` is: the readline prompter never held the screen and has
 *   nothing to hand back.
 * @property {() => Promise<void>} [pause] Nothing to answer here, but something to read.
 *
 *   Step 3 of setup asks no question: it explains that blocking is a lever separate from routing and
 *   that OpenGEO leaves it empty (§7). In scrollback that prints and the flow moves on, which is
 *   right, because the words stay on the screen. On a display that repaints, "prints and moves on"
 *   means the next question wipes them before anybody has read one, so a prompter that draws frames
 *   holds here for a keypress instead.
 *
 *   Optional, and ignored by the readline prompter for exactly that reason.
 */

/**
 * @template {string} T
 * @typedef {object} ChoiceOption
 * @property {T} value
 * @property {string} label
 * @property {string} [note]
 */

/**
 * @typedef {object} PrompterOptions
 * @property {boolean} [autoAccept] When true, every question resolves to its default without printing a prompt.
 * @property {NodeJS.ReadableStream} [input] Injected by tests. Supplying either one also means "this is
 *   interactive", TTY or not.
 * @property {NodeJS.WritableStream} [output]
 */

/**
 * @param {PrompterOptions} [options]
 * @returns {Prompter}
 */
export function createPrompter(options = {}) {
  const injected = Boolean(options.input || options.output);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // A non-TTY stdin means a pipe or a CI job. Answering from defaults is the only sane behaviour;
  // waiting for input nobody can type would hang the process forever.
  const auto = options.autoAccept || (!injected && !process.stdin.isTTY);
  let muted = false;
  /** @type {Interface | undefined} */
  let rl;
  // Set when the input stream ends: Ctrl-D, or a pipe that ran out of answers. From that point on
  // there is nobody left to ask, so every prompt takes its default rather than waiting forever.
  let ended = false;

  /** @returns {Interface} */
  const iface = () => {
    if (rl) return rl;
    rl = createInterface({ input, output, terminal: true });
    const internal = /** @type {{ _writeToOutput(text: string): void; output: NodeJS.WritableStream }} */ (
      /** @type {unknown} */ (rl)
    );
    const original = internal._writeToOutput.bind(internal);
    internal._writeToOutput = (text) => {
      if (!muted) return original(text);
      // One asterisk per keystroke, so the length of the key is the only thing on screen.
      internal.output.write(text.includes('\n') ? '\n' : '*');
    };
    return rl;
  };

  /**
   * @param {string} text
   * @returns {Promise<string>}
   */
  const question = (text) =>
    new Promise((resolve) => {
      if (ended) return resolve('');
      const active = iface();
      // EOF closes readline without ever invoking the question callback. Without this the promise
      // never settles and node exits mid-question with an unsettled-top-level-await warning.
      const onClose = () => {
        ended = true;
        resolve('');
      };
      active.once('close', onClose);
      active.question(text, (answer) => {
        active.off('close', onClose);
        resolve(answer);
      });
    });

  return {
    async ask(text, fallback = '') {
      if (auto || ended) return fallback;
      // A question with no default shows no bracket at all. An empty `[]` reads like a value the
      // reader is failing to see, and it is the one hint that is worse than no hint.
      const suffix = fallback ? c.gray(` [${DEFAULT_LABEL}${fallback}]`) : '';
      const answer = (await question(`${text}${suffix} `)).trim();
      return answer || fallback;
    },

    async choose(text, choices, fallback) {
      if (auto || ended) return fallback;
      output.write(`${text}\n`);
      choices.forEach((choice, index) => {
        const marker = choice.value === fallback ? c.gray(' (default)') : '';
        output.write(`  ${index + 1}) ${choice.label}${marker}\n`);
        if (choice.note) output.write(`     ${c.gray(choice.note)}\n`);
      });
      for (;;) {
        const hint = c.gray(`[${DEFAULT_LABEL}${choices.findIndex((o) => o.value === fallback) + 1}]`);
        const raw = (await question(`${c.gray('  choose a number ')}${hint} `)).trim();
        if (!raw || ended) return fallback;
        const index = Number(raw) - 1;
        if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
        output.write(`  ${c.yellow(`Pick a number between 1 and ${choices.length}.`)}\n`);
      }
    },

    async secret(text) {
      if (auto || ended) return '';
      output.write(`${text} `);
      muted = true;
      try {
        return (await question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
    },

    async confirm(text, fallback) {
      if (auto || ended) return fallback;
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = (await question(`${text} ${c.gray(`[${hint}]`)} `)).trim().toLowerCase();
      if (!answer) return fallback;
      return answer === 'y' || answer === 'yes';
    },

    close() {
      rl?.close();
      rl = undefined;
      ended = true;
    },
  };
}
