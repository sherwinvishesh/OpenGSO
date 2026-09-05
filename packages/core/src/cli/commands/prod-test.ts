import { writeFileSync } from 'node:fs';
import { resolveBots } from '../../shared/bots.js';
import { c } from '../../shared/log.js';
import { prodVerificationToJson, renderProdVerification, verifyProd } from '../../prod/index.js';
import { parseArgs } from '../args.js';
import type { CommandContext } from '../index.js';
import { resolveProject, resolveTarget } from '../project.js';

const SPEC = {
  booleans: ['json', 'verbose'],
  strings: ['bot', 'project', 'out', 'timeout'],
  alias: { v: 'verbose' },
} as const;

/**
 * `opengeo prod test <url>` (§7).
 *
 * The exit code follows the failures, not the warnings. A warning here is a real finding, but it
 * is the kind a CDN can cause and a user may knowingly accept; failing the command on it would
 * teach people to stop reading the output.
 */
export async function prodTestCommand(ctx: CommandContext): Promise<number> {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
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
    writeFileSync(out, text, 'utf8');
    process.stdout.write(`${c.gray(`Wrote ${out}`)}\n`);
  } else {
    process.stdout.write(text);
  }

  return result.ok ? 0 : 1;
}
