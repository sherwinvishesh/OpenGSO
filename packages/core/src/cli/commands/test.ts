import { writeFileSync } from 'node:fs';
import { c } from '../../shared/log.js';
import { renderReport, testUrl, toJson } from '../../test/index.js';
import { parseArgs } from '../args.js';
import type { CommandContext } from '../index.js';
import { resolveProject, resolveTarget } from '../project.js';

const SPEC = {
  booleans: ['json', 'verbose', 'quality'],
  strings: ['project', 'out', 'timeout'],
  alias: { v: 'verbose' },
} as const;

export async function testCommand(ctx: CommandContext): Promise<number> {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const loaded = resolveProject(args);
  const target = resolveTarget(args, loaded, 'test');
  const result = await testUrl(target.toString(), { timeoutMs: args.num('timeout') });

  if (args.bool('json')) {
    const json = `${toJson(result)}\n`;
    const out = args.str('out');
    if (out) {
      writeFileSync(out, json, 'utf8');
      process.stdout.write(`${c.gray(`Wrote ${out}`)}\n`);
    } else {
      process.stdout.write(json);
    }
    return result.score.counts.fail === 0 ? 0 : 1;
  }

  process.stdout.write(renderReport(result, { verbose: args.bool('verbose') }));
  return result.score.counts.fail === 0 ? 0 : 1;
}
