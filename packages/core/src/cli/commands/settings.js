import { resolve } from 'node:path';
import { c } from '../../shared/log.js';
import { parseArgs } from '../args.js';
import { SetupAbort, setupMode } from '../configure.js';
import { runOnboarding } from '../onboarding.js';

/** @import { CommandContext } from '../index.js' */

/**
 * `opengeo settings` (§11, §12): the menu of everything in `opengeo.config.json`.
 *
 * It is a separate command rather than a flag on `start` because the two are wanted at different
 * moments. `start` is "get me running"; `settings` is "change one thing" - most often the site URL
 * after a deploy, or the bot lists after reading about a new crawler. Keeping them apart also means
 * `settings` can ship in `opengeo-cli`, which has no dashboard to start.
 *
 * A directory with no config gets the walkthrough instead, the same one `start` runs. A menu of
 * settings for a project that does not exist yet is a worse first contact than four questions, and
 * the person who typed `settings` in an empty directory wanted to configure it either way.
 *
 * Nothing here is a second implementation of the setup flow. Both modes are `runSetup`, over the
 * same five steps, which is what stops them drifting apart.
 */

const SPEC = /** @type {const} */ ({
  booleans: ['yes'],
  strings: ['project'],
  alias: { y: 'yes' },
});

/**
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function settingsCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const dir = args.str('project');
  const root = dir ? resolve(process.cwd(), dir) : process.cwd();

  try {
    await runOnboarding({
      root,
      mode: setupMode(root),
      autoAccept: args.bool('yes'),
      tag: `${ctx.packageName} ${ctx.version}`,
    });
    return 0;
  } catch (error) {
    if (error instanceof SetupAbort) {
      process.stderr.write(`\n${c.red('settings stopped')} ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
