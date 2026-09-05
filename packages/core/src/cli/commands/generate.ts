import { relative } from 'node:path';
import { normalizeRoute } from '../../shared/routes.js';
import { c, heading } from '../../shared/log.js';
import { generatePages, twinUrlFor } from '../../generate/generate.js';
import { parseArgs } from '../args.js';
import type { CommandContext } from '../index.js';
import { resolveProject, resolveTarget } from '../project.js';

const SPEC = {
  booleans: ['force', 'json'],
  strings: ['project', 'tier', 'timeout'],
} as const;

export async function generateCommand(ctx: CommandContext): Promise<number> {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const loaded = resolveProject(args);
  const target = resolveTarget(args, loaded, 'generate');
  const site = target.origin;

  const tierFlag = args.str('tier');
  if (tierFlag && tierFlag !== 'free' && tierFlag !== 'ai') {
    process.stderr.write(`Unknown tier "${tierFlag}". OpenGEO has two: free (algorithmic, no key) and ai (BYOK).\n`);
    return 1;
  }
  const tier = (tierFlag as 'free' | 'ai' | undefined) ?? loaded.config.generate.tier;

  const routes = [normalizeRoute(target.pathname), ...loaded.config.extraRoutes.map(normalizeRoute)];

  process.stdout.write(`\n${c.bold('OpenGEO')} ${c.gray('generate')}  ${site}\n`);
  const result = await generatePages({
    site,
    routes,
    loaded,
    tier,
    force: args.bool('force'),
    onProgress: (event) => {
      if (event.phase !== 'fetch') return;
      process.stdout.write(`  ${c.gray(`[${event.index}/${event.total}]`)} ${event.route}\n`);
    },
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
    return result.pages.some((page) => page.status === 'failed') ? 1 : 0;
  }

  process.stdout.write(heading('Pages'));
  for (const page of result.pages) {
    const label =
      page.status === 'written'
        ? c.green('written')
        : page.status === 'cached'
          ? c.gray('cached ')
          : page.status === 'skipped-manual'
            ? c.yellow('manual ')
            : c.red('failed ');
    const detail = page.status === 'written' ? c.gray(`${page.tokens} tokens  ${twinUrlFor(site, page.route)}`) : c.gray(page.reason ?? '');
    process.stdout.write(`  ${label} ${page.route.padEnd(20)} ${detail}\n`);
    for (const warning of page.warnings) process.stdout.write(`          ${c.yellow('warn')} ${warning}\n`);
  }

  const written = result.pages.filter((page) => page.status === 'written').length;
  const failed = result.pages.filter((page) => page.status === 'failed').length;
  process.stdout.write(
    `\n  ${written} written, ${result.pages.length - written - failed} unchanged${failed > 0 ? `, ${c.red(`${failed} failed`)}` : ''}` +
      ` ${c.gray(`in ${result.durationMs}ms`)}\n`,
  );
  process.stdout.write(`  ${c.gray(`Output: ${relative(process.cwd(), result.publicDir) || result.publicDir}`)}\n\n`);
  return failed > 0 ? 1 : 0;
}
