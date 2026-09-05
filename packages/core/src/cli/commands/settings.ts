import { resolve } from 'node:path';
import { c } from '../../shared/log.js';
import { parseArgs } from '../args.js';
import { SetupAbort, runSetup } from '../configure.js';
import type { CommandContext } from '../index.js';
import { createPrompter } from '../prompt.js';

/**
 * `opengeo settings` (§11, §12): the same four questions `opengeo start` asks a new project, in
 * edit mode.
 *
 * It is a separate command rather than a flag on `start` because the two are wanted at different
 * moments. `start` is "get me running"; `settings` is "change one thing" - most often the site URL
 * after a deploy, or the bot lists after reading about a new crawler. Keeping them apart also means
 * `settings` can ship in `opengeo-cli`, which has no dashboard to start.
 *
 * Nothing here is a second implementation of the setup flow. It is the same function with
 * `mode: 'settings'`, which is what stops the two drifting apart.
 */

const SPEC = {
  booleans: ['yes'],
  strings: ['project'],
  alias: { y: 'yes' },
} as const;

export async function settingsCommand(ctx: CommandContext): Promise<number> {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const dir = args.str('project');
  const root = dir ? resolve(process.cwd(), dir) : process.cwd();
  const prompter = createPrompter({ autoAccept: args.bool('yes') });

  try {
    await runSetup({ root, prompter, mode: 'settings' });
    return 0;
  } catch (error) {
    if (error instanceof SetupAbort) {
      process.stderr.write(`\n${c.red('settings stopped')} ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    prompter.close();
  }
}
