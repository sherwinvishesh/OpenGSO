import { ERRORS } from '../shared/errors.js';
import { c } from '../shared/log.js';
import { ink } from '../shared/render/theme.js';
import { field, select } from './tui/interact.js';
import { readKeys } from './tui/keys.js';
import { canUseTui, openScreen } from './tui/screen.js';
import { runFlatHome } from './home-flat.js';
import { copyFixPrompt, runInScrollback } from './home-launch.js';
import { readHomeStatus } from './home-status.js';
import { homeEntries, homeHeader } from './home-view.js';

/**
 * @import { KeyReader } from './tui/keys.js'
 * @import { Screen } from './tui/screen.js'
 * @import { HomeOptions } from './home-launch.js'
 * @import { HomeAction } from './home-view.js'
 */

/** @typedef {import('./home-status.js').HomeStatus} HomeStatus */

/**
 * `omnigeo` on its own: the application, rather than a wall of flags.
 *
 * The first thing anyone types after installing something is its name, and until now that answered
 * with either a help page or a browser window. Neither is what the question meant. This is a home
 * screen: it reads the project off disk, says where it stands in four lines, and offers the five
 * things there are to do, each of which can be reached with one keystroke.
 *
 * The rule that shapes the whole file is that **it never hosts a command's output**. Picking Test
 * leaves the alternate screen buffer, runs the real `testCommand` in normal scrollback with its
 * live progress, and waits for a key before coming back. A report is long, and being able to scroll
 * and copy it is worth more than a pane with its own scrollbar. It also means there is exactly one
 * implementation of every command: the home screen is a launcher, not a second front end.
 */

// The status, view and flat-menu halves live beside this loop; re-exported so the names importers
// already use keep working.
export { readHomeStatus } from './home-status.js';
export { homeEntries, homeHeader, plainStatus, statusRows } from './home-view.js';

/** @type {Record<string, HomeAction>} */
const SHORTCUTS = {
  t: 'test',
  g: 'generate',
  p: 'prod',
  d: 'dashboard',
  s: 'settings',
  q: 'quit',
};

/**
 * The application loop.
 *
 * Returns a process exit code, which is always 0 for a normal quit: the home screen is a launcher,
 * and the exit code of the last thing launched is not the exit code of the launcher. A test that
 * scored 40 should not make `omnigeo` itself look like it crashed.
 *
 * @param {HomeOptions} options
 * @returns {Promise<number>}
 */
export async function runHome(options) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const root = options.root ?? process.cwd();

  if (!canUseTui({ input, output })) return runFlatHome(options, root);

  const screen = openScreen({ input, output });
  /** @type {KeyReader} */
  let keys = readKeys(input);
  // `keys` is read when the event fires, not now: it is replaced after every command.
  const stopResize = screen.onResize(() => keys.wake());

  try {
    for (;;) {
      const status = readHomeStatus(root);
      /** @type {HomeAction | undefined} */
      const action = await select(screen, keys, {
        // A function, so a resize draws the box at the new width rather than the one it opened at.
        header: () => ['', ...homeHeader(status, `${options.packageName} ${options.version}`, screen.size().columns)],
        items: homeEntries(options.commands, status),
        shortcuts: SHORTCUTS,
        hints: [
          ['up/down', 'move'],
          ['enter', 'run'],
          ['t g p d s', 'jump'],
          ['q', 'quit'],
        ],
      });
      if (!action || action === 'quit') return 0;

      const argv = await composeArgs(screen, keys, action, status, `${options.packageName} ${options.version}`);
      if (!argv) continue;

      // The key reader is detached before the command runs. Both it and whatever the command puts
      // on stdin (`settings` opens a readline) would otherwise receive every keystroke, and the
      // menu would replay the setup answers into itself the moment the command returned.
      keys.close();
      const ended = await screen.suspend(async () => {
        const offer = await runInScrollback(options, action, argv, output);
        if (offer) {
          const reply = await readLine(
            input,
            output,
            `Type ${c.bold('c')} and press Enter to copy the fix prompt for Claude Code (${offer.summary}), or just Enter to go back.`,
          );
          if (reply === undefined) return true;
          if (reply.trim().toLowerCase() !== 'c') return false;
          await copyFixPrompt(offer, output, options.clipboard);
        }
        return await waitForKey(input, output);
      });
      // Ctrl-D at the prompt closes stdin for good, and a menu with no input could only hang.
      if (ended) return 0;
      keys = readKeys(input);
    }
  } finally {
    stopResize();
    keys.close();
    screen.close();
  }
}

/**
 * The little form in front of each command.
 *
 * Only the two questions that change the answer are asked. Everything else has a flag and a sane
 * default, and a menu that re-asked every flag would be slower than typing the command. Returns
 * undefined when the user backed out, which must not be read as "run it with no arguments".
 *
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {HomeAction} action
 * @param {HomeStatus} status
 * @param {string} version
 * @returns {Promise<string[] | undefined>}
 */
async function composeArgs(screen, keys, action, status, version) {
  const header = ['', ...homeHeader(status, version, screen.size().columns)];
  const site = status.site ?? '';

  if (action === 'settings' || action === 'setup') return [];
  if (action === 'dashboard') return status.configured ? ['--no-setup'] : [];

  if (action === 'prod') {
    const url = await askUrl(screen, keys, header, site, 'Which deployed URL should I probe?');
    return url ? [url] : undefined;
  }

  if (action === 'test') {
    /** @type {'full' | 'structure' | 'content' | undefined} */
    const mode = await select(screen, keys, {
      header,
      items: [
        { value: 'structure', label: 'Structure', note: 'the 22 checks and the 0-100 score. Free, no key.' },
        { value: 'full', label: 'Structure and content', note: 'both passes. The content half needs a key.' },
        { value: 'content', label: 'Content only', note: 'an AI review of the markdown, no score' },
      ],
      hints: [['up/down', 'move'], ['enter', 'select'], ['esc', 'back']],
    });
    if (!mode) return undefined;
    const url = await askUrl(screen, keys, header, site, 'Which URL should I test?');
    if (!url) return undefined;
    return mode === 'full' ? [url] : [url, `--${mode}`];
  }

  if (action === 'generate') {
    /** @type {'free' | 'ai' | undefined} */
    const tier = await select(screen, keys, {
      header,
      items: [
        { value: 'free', label: 'Free', note: 'algorithmic extraction. No key, no cost.' },
        { value: 'ai', label: 'AI', note: 'rewritten by your provider. Needs a key.', disabled: !status.provider },
      ],
      hints: [['up/down', 'move'], ['enter', 'select'], ['esc', 'back']],
    });
    if (!tier) return undefined;
    // A folder project has nothing to ask: no positional reads the folder its config names.
    if (status.folder) return tier === 'ai' ? ['--tier', 'ai'] : [];
    const url = await askUrl(screen, keys, header, site, 'Which site should I crawl?');
    if (!url) return undefined;
    return tier === 'ai' ? [url, '--tier', 'ai'] : [url];
  }

  return [];
}

/**
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {string[]} header
 * @param {string} site
 * @param {string} label
 * @returns {Promise<string | undefined>}
 */
async function askUrl(screen, keys, header, site, label) {
  return await field(screen, keys, {
    header: [...header, '', `  ${c.bold(label)}`],
    label: 'URL',
    value: site,
    placeholder: 'https://example.com',
    hint: 'Enter to accept, esc to go back.',
    validate: (value) => (isUrlish(value) ? undefined : ERRORS.urlNeedsScheme),
  });
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isUrlish(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Wait before returning to the menu.
 *
 * Called from inside `suspend`, so the terminal is back in cooked mode and this is a plain "press
 * Enter". Trying to read a single raw keypress here would mean turning raw mode back on while the
 * report is still on screen, which is how a terminal ends up echoing nothing after a Ctrl-C.
 *
 * Resolves true when the input ended instead (Ctrl-D on an empty line), which is not a keypress and
 * never arrives as `data`.
 *
 * @param {NodeJS.ReadStream} input
 * @param {NodeJS.WriteStream} output
 * @returns {Promise<boolean>}
 */
async function waitForKey(input, output) {
  return (await readLine(input, output, ink.faint('Press Enter to go back to the menu.'))) === undefined;
}

/**
 * One cooked-mode line, or undefined when the input ended instead.
 *
 * @param {NodeJS.ReadStream} input
 * @param {NodeJS.WriteStream} output
 * @param {string} question
 * @returns {Promise<string | undefined>}
 */
function readLine(input, output, question) {
  return new Promise((resolve) => {
    output.write(`\n${question} `);
    /** @param {string | undefined} line */
    const settle = (line) => {
      input.off('data', onData);
      input.off('end', onEnd);
      output.write('\n');
      resolve(line);
    };
    const onData = (/** @type {Buffer | string} */ chunk) => settle(String(chunk));
    const onEnd = () => settle(undefined);
    input.once('data', onData);
    input.once('end', onEnd);
    input.resume();
  });
}
