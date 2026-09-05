import { createInterface, type Interface } from 'node:readline';
import { c } from '../shared/log.js';

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

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  choose<T extends string>(question: string, options: ChoiceOption<T>[], fallback: T): Promise<T>;
  secret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  note?: string;
}

export interface PrompterOptions {
  /** When true, every question resolves to its default without printing a prompt. */
  autoAccept?: boolean;
  /** Injected by tests. Supplying either one also means "this is interactive", TTY or not. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function createPrompter(options: PrompterOptions = {}): Prompter {
  const injected = Boolean(options.input || options.output);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // A non-TTY stdin means a pipe or a CI job. Answering from defaults is the only sane behaviour;
  // waiting for input nobody can type would hang the process forever.
  const auto = options.autoAccept || (!injected && !process.stdin.isTTY);
  let muted = false;
  let rl: Interface | undefined;
  // Set when the input stream ends: Ctrl-D, or a pipe that ran out of answers. From that point on
  // there is nobody left to ask, so every prompt takes its default rather than waiting forever.
  let ended = false;

  const iface = (): Interface => {
    if (rl) return rl;
    rl = createInterface({ input, output, terminal: true });
    const internal = rl as unknown as { _writeToOutput(text: string): void; output: NodeJS.WritableStream };
    const original = internal._writeToOutput.bind(internal);
    internal._writeToOutput = (text: string) => {
      if (!muted) return original(text);
      // One asterisk per keystroke, so the length of the key is the only thing on screen.
      internal.output.write(text.includes('\n') ? '\n' : '*');
    };
    return rl;
  };

  const question = (text: string): Promise<string> =>
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
        if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index]!.value;
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
