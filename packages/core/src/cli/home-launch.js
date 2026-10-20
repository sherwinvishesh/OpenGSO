import { copyToClipboard } from '../shared/clipboard.js';
import { ERRORS } from '../shared/errors.js';
import { c } from '../shared/log.js';
import { ink } from '../shared/render/theme.js';

/**
 * @import { CommandName } from '../shared/errors.js'
 * @import { CommandHandler } from './index.js'
 * @import { HomeAction } from './home-view.js'
 */

/**
 * The one place a menu action becomes a real command, shared by the full-screen loop and the flat
 * menu so the two cannot launch the same thing in different ways.
 */

/**
 * @typedef {object} HomeOptions
 * @property {string} packageName
 * @property {string} version
 * @property {Partial<Record<CommandName, CommandHandler>>} commands Whatever this install actually
 *   ships. An entry with no handler is drawn dim, not hidden.
 * @property {string} [root]
 * @property {NodeJS.ReadStream} [input]
 * @property {NodeJS.WriteStream} [output]
 * @property {Parameters<typeof copyToClipboard>[1]} [clipboard] Injected by tests, so none of them
 *   touches the real clipboard.
 */

/**
 * Which handler an action runs, and under what name it is announced.
 *
 * @param {HomeAction} action
 * @returns {CommandName}
 */
function commandFor(action) {
  if (action === 'prod') return 'prod test';
  if (action === 'dashboard') return 'start';
  if (action === 'setup') return 'settings';
  return /** @type {CommandName} */ (action);
}

/**
 * The fix prompt a test run left behind, for the menu to offer.
 *
 * @typedef {object} FixPromptOffer
 * @property {string} text
 * @property {string} summary What it asks for, as "3 fixes and 6 suggestions".
 */

/**
 * Runs the command, and hands back the fix prompt when it was a test run that built one.
 *
 * The prompt comes back through a callback rather than being built here because building it means
 * importing the test pillar, and this file is in every package's bundle.
 *
 * @param {HomeOptions} options
 * @param {HomeAction} action
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} output
 * @returns {Promise<FixPromptOffer | undefined>}
 */
export async function runInScrollback(options, action, argv, output) {
  const name = commandFor(action);
  const handler = options.commands[name];
  if (!handler) return undefined;
  const shown = [name, ...argv].join(' ');
  output.write(`\n${ink.faint(`$ opengeo ${shown}`)}\n`);
  /** @type {FixPromptOffer | undefined} */
  let offer;
  try {
    await handler({
      argv,
      packageName: options.packageName,
      version: options.version,
      onFixPrompt: (text, summary) => {
        offer = { text, summary };
      },
    });
  } catch (error) {
    output.write(`\n${c.red('Error')} ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return offer;
}

/**
 * Copy the prompt and say how that went, in one line.
 *
 * @param {FixPromptOffer} offer
 * @param {NodeJS.WriteStream} output
 * @param {Parameters<typeof copyToClipboard>[1]} [clipboard] Injected by tests.
 * @returns {Promise<void>}
 */
export async function copyFixPrompt(offer, output, clipboard) {
  const copied = await copyToClipboard(offer.text, { terminal: output, ...clipboard });
  if (!copied.ok) output.write(`${c.yellow('!')} ${ERRORS.clipboardUnavailable(copied.tried)}\n`);
  else if (copied.confirmed) output.write(`${c.green('Copied')} the fix prompt (${offer.summary}). Paste it into Claude Code.\n`);
  else output.write(`${c.green('Sent')} the fix prompt to ${copied.via}. ${ink.faint('If nothing pastes, your terminal does not allow it.')}\n`);
}
