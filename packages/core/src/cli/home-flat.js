import { c } from '../shared/log.js';
import { createPrompter } from './prompt.js';
import { readHomeStatus } from './home-status.js';
import { copyFixPrompt, runInScrollback } from './home-launch.js';
import { homeEntries, plainStatus } from './home-view.js';

/**
 * @import { HomeOptions } from './home-launch.js'
 * @import { HomeStatus } from './home-status.js'
 * @import { HomeAction } from './home-view.js'
 */

/**
 * The same menu without any of the terminal control.
 *
 * `NO_COLOR`, `TERM=dumb`, `CI` and a pipe on either end all land here, and a pipe goes straight on
 * to the help page. It is numbered rather than arrow-driven because there is no raw mode to read
 * arrows with, and it is the same list in the same order so that describing one describes both.
 *
 * @param {HomeOptions} options
 * @param {string} root
 * @returns {Promise<number>}
 */
export async function runFlatHome(options, root) {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  // Nobody is there to answer, or nobody is there to read the question (`opengso | head`). A menu
  // would either hang or silently pick its own default, and both are worse than the help page the
  // old bare invocation printed.
  if (!input.isTTY || !output.isTTY) return -1;

  for (;;) {
    const status = readHomeStatus(root);
    output.write(`\n${c.bold('OpenGSO')} ${c.gray(`${options.packageName} ${options.version}`)}\n`);
    output.write(`${status.project}  ${c.gray(status.site ?? 'no site configured yet')}\n`);
    for (const row of plainStatus(status)) output.write(`${row}\n`);
    output.write('\n');

    const entries = homeEntries(options.commands, status).filter((entry) => !entry.disabled);
    // One reader per question, closed before the command starts. A menu reader left attached to
    // stdin echoes every keystroke, including the API key `settings` is masking, and a Ctrl-D meant
    // for the command would close it too.
    const prompter = createPrompter({ input, output });
    /** @type {HomeAction} */
    let action;
    try {
      action = await prompter.choose(
        'What would you like to do?',
        entries.map((entry) => ({ value: entry.value, label: entry.label, note: entry.note })),
        /** @type {HomeAction} */ ('quit'),
      );
    } finally {
      prompter.close();
    }
    if (action === 'quit') return 0;

    const argv = flatArgs(action, status);
    const offer = await runInScrollback(options, action, argv, output);
    if (!offer) continue;
    // A fresh reader for the same reason as above: the command has just let go of stdin.
    const asker = createPrompter({ input, output });
    try {
      if (await asker.confirm(`\nCopy the fix prompt for Claude Code (${offer.summary})?`, false)) {
        await copyFixPrompt(offer, output, options.clipboard);
      }
    } finally {
      asker.close();
    }
  }
}

/**
 * No form in the flat menu: it takes the configured site and the defaults, or it needs a flag.
 *
 * @param {HomeAction} action
 * @param {HomeStatus} status
 * @returns {string[]}
 */
function flatArgs(action, status) {
  if (action === 'settings' || action === 'setup') return [];
  if (action === 'dashboard') return status.configured ? ['--no-setup'] : [];
  // The site of a folder project is its public address, and generate would crawl that instead.
  if (action === 'generate' && status.folder) return [];
  return status.site ? [status.site] : [];
}
