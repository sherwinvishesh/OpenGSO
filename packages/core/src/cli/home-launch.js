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
 * @param {HomeOptions} options
 * @param {HomeAction} action
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} output
 * @returns {Promise<void>}
 */
export async function runInScrollback(options, action, argv, output) {
  const name = commandFor(action);
  const handler = options.commands[name];
  if (!handler) return;
  const shown = [name, ...argv].join(' ');
  output.write(`\n${ink.faint(`$ opengeo ${shown}`)}\n`);
  try {
    await handler({ argv, packageName: options.packageName, version: options.version });
  } catch (error) {
    output.write(`\n${c.red('Error')} ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
