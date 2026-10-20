import { writeFileSync } from 'node:fs';
import { resolveBots } from '../../shared/bots.js';
import { c } from '../../shared/log.js';
import { verifyProd } from '../../prod/verify.js';
import { prodVerificationToJson, renderProdVerification } from '../../prod/verify-report.js';
import { EXIT_USAGE, parseArgs } from '../args.js';
import { resolveProject, resolveTarget } from '../project.js';
import { stripAnsi } from '../../shared/render/paint.js';

/** @import { CommandContext } from '../index.js' */

const SPEC = /** @type {const} */ ({
  booleans: ['json', 'verbose'],
  strings: ['bot', 'project', 'out'],
  numbers: { timeout: { min: 0, exclusive: true } },
  alias: { v: 'verbose' },
});

/**
 * `omnigeo prod test <url>` (§7).
 *
 * The exit code follows the failures, not the warnings. A warning here is a real finding, but it
 * is the kind a CDN can cause and a user may knowingly accept; failing the command on it would
 * teach people to stop reading the output.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function prodTestCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const problem = args.problem();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return EXIT_USAGE;
  }

  const loaded = resolveProject(args);
  const target = resolveTarget(args, loaded, 'prod test');
  const timeout = args.num('timeout');

  const result = await verifyProd(target.toString(), {
    bot: args.str('bot') || undefined,
    bots: resolveBots(loaded.config.bots.custom),
    timeoutMs: timeout === undefined ? undefined : timeout * 1000,
  });

  const text = args.bool('json')
    ? `${prodVerificationToJson(result)}\n`
    : renderProdVerification(result, { verbose: args.bool('verbose') });

  const out = args.str('out');
  if (out) {
    // The report was coloured for the terminal it would have gone to. A file is not one.
    writeFileSync(out, stripAnsi(text), 'utf8');
    process.stdout.write(`${c.gray(`Wrote ${out}`)}\n`);
  } else {
    process.stdout.write(text);
  }

  return result.ok ? 0 : 1;
}
