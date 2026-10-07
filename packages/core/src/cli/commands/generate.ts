import { relative } from 'node:path';
import { c, heading, terminalSafe } from '../../shared/log.js';
import { resolveAiCall } from '../../shared/ai-call.js';
import type { AiProvider } from '../../shared/providers.js';
import { isCI } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import { createAiEnhancer } from '../../generate/ai.js';
import { generateSite } from '../../generate/site.js';
import { twinUrlFor } from '../../generate/generate.js';
import type { EnhanceInput, EnhanceOutput } from '../../generate/generate.js';
import { parseArgs } from '../args.js';
import { canRedraw, createProgress } from '../progress.js';
import type { CommandContext } from '../index.js';
import { resolveProject, resolveTarget } from '../project.js';

const SPEC = {
  booleans: ['force', 'json', 'single', 'skip-files'],
  strings: ['project', 'tier', 'timeout', 'max-pages', 'depth', 'provider', 'model'],
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

  let enhance: ((input: EnhanceInput) => Promise<EnhanceOutput>) | undefined;
  if (tier === 'ai') {
    const built = buildEnhancer(args, loaded);
    if ('error' in built) {
      process.stderr.write(`\n${built.error}\n\n`);
      return 1;
    }
    enhance = built.enhance;
    process.stdout.write(
      `\n${c.bold('OpenGEO')} ${c.gray('generate')}  ${site}  ${c.gray(`AI tier, ${built.provider}/${built.model}, ${built.source}`)}\n`,
    );
  } else {
    process.stdout.write(`\n${c.bold('OpenGEO')} ${c.gray('generate')}  ${site}\n`);
  }

  const single = args.bool('single');
  const progress = args.bool('json') ? undefined : createProgress();
  const progressIsLive = canRedraw();
  let lastPhase = '';
  const result = await generateSite({
    target: target.toString(),
    loaded,
    tier,
    force: args.bool('force'),
    single,
    maxPages: args.num('max-pages'),
    maxDepth: args.num('depth'),
    timeoutMs: args.num('timeout') !== undefined ? args.num('timeout')! * 1000 : undefined,
    skipSiteFiles: args.bool('skip-files'),
    enhance,
    onProgress: (event) => {
      if (!progress) return;
      if (event.phase === 'crawl') {
        if (lastPhase !== 'crawl') {
          progress.phase('Discovering routes by following links');
          lastPhase = 'crawl';
        }
        progress.step(event.crawl.visited + 1, event.crawl.found, event.crawl.route);
        return;
      }
      if (event.phase === 'generate') {
        if (lastPhase !== 'generate') {
          progress.phase('Converting pages');
          lastPhase = 'generate';
        }
        // Every route fires four events (fetch, extract, ai, write) and the live block can show all
        // of them, but the plain transcript prints a line per event, which is four times the noise
        // the old code made. So the counter always advances and only the AI pass, the one with a
        // real per-route cost, gets a line in the transcript.
        const detail = event.generate.phase === 'ai' ? `${event.generate.route} ${c.gray('(AI)')}` : event.generate.route;
        if (progressIsLive || event.generate.phase === 'ai') {
          progress.step(event.generate.index, event.generate.total, detail);
        }
        return;
      }
      if (event.phase === 'files') {
        progress.phase('Writing robots.txt, llms.txt and sitemap.xml');
        lastPhase = 'files';
      }
    },
  });
  progress?.done();

  if (args.bool('json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          site: result.site,
          durationMs: result.durationMs,
          pages: result.generate.pages,
          files: result.files,
          warnings: result.warnings,
          manifest: result.generate.manifest,
        },
        null,
        2,
      )}\n`,
    );
    return result.generate.pages.some((page) => page.status === 'failed') ? 1 : 0;
  }

  // Provider error bodies and page warnings are remote text, so they are cleaned before printing.
  const report = terminalSafe(result);
  process.stdout.write(`${heading('Pages')}\n`);
  for (const page of report.generate.pages) {
    const label =
      page.status === 'written'
        ? c.green('written')
        : page.status === 'cached'
          ? c.gray('cached ')
          : page.status === 'skipped-manual'
            ? c.yellow('manual ')
            : page.status === 'proposed'
              ? c.yellow('kept   ')
              : c.red('failed ');
    const detail =
      page.status === 'written'
        ? c.gray(`${page.tokens} tokens  ${twinUrlFor(site, page.route)}`)
        : c.gray(page.reason ?? '');
    process.stdout.write(`  ${label} ${page.route.padEnd(24)} ${detail}\n`);
    for (const warning of page.warnings) process.stdout.write(`          ${c.yellow('warn')} ${warning}\n`);
  }

  if (report.files.length > 0) {
    process.stdout.write(`${heading('Site files')}\n`);
    for (const file of report.files) {
      const label =
        file.status === 'written'
          ? c.green('written')
          : file.status === 'unchanged'
            ? c.gray('cached ')
            : file.status === 'proposed'
              ? c.yellow('kept   ')
              : c.red('failed ');
      const detail =
        file.status === 'proposed'
          ? c.gray(`yours left alone, proposal at ${relative(process.cwd(), file.path) || file.path}`)
          : c.gray(relative(process.cwd(), file.path) || file.path);
      process.stdout.write(`  ${label} ${file.name.padEnd(24)} ${detail}\n`);
    }
  }

  const pages = report.generate.pages;
  const written = pages.filter((page) => page.status === 'written').length;
  const failed = pages.filter((page) => page.status === 'failed').length;
  const proposed = pages.filter((page) => page.status === 'proposed').length;
  const aiPages = pages.filter((page) => page.tier === 'ai').length;
  const fellBack = pages.filter((page) => page.warnings.some((w) => w.startsWith('Kept the algorithmic version'))).length;

  process.stdout.write(
    `\n  ${written} written, ${pages.length - written - failed - proposed} unchanged` +
      `${proposed > 0 ? `, ${c.yellow(`${proposed} kept as yours`)}` : ''}${failed > 0 ? `, ${c.red(`${failed} failed`)}` : ''}` +
      `${tier === 'ai' ? `, ${aiPages} AI-enhanced${fellBack > 0 ? `, ${c.yellow(`${fellBack} fell back on fidelity`)}` : ''}` : ''}` +
      ` ${c.gray(`in ${report.durationMs}ms`)}\n`,
  );
  process.stdout.write(`  ${c.gray(`Output: ${relative(process.cwd(), report.generate.publicDir) || report.generate.publicDir}`)}\n`);

  const crawlWarnings = report.warnings.filter((w) => !w.includes('.opengeo-proposed'));
  if (crawlWarnings.length > 0) {
    process.stdout.write(`${heading('Notes')}\n`);
    for (const warning of crawlWarnings) process.stdout.write(`  ${c.yellow('warn')} ${warning}\n`);
  }
  for (const file of report.files) {
    if (file.status === 'proposed' && file.message) {
      process.stdout.write(`\n${indent(file.message)}\n`);
    }
  }
  process.stdout.write('\n');
  return failed > 0 ? 1 : 0;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

interface EnhancerReady {
  enhance: (input: EnhanceInput) => Promise<EnhanceOutput>;
  provider: AiProvider;
  model: string;
  source: string;
}

/**
 * Resolve the key and build the AI enhancer, or produce the exact §13 message explaining what is
 * missing. The key is read from the project's own `.env` and never printed, only its origin is.
 */
function buildEnhancer(
  args: ReturnType<typeof parseArgs>,
  loaded: ReturnType<typeof resolveProject>,
): EnhancerReady | { error: string } {
  if (isCI()) return { error: ERRORS.ciBlocked("generate's AI tier") };

  const resolved = resolveAiCall(loaded.root, loaded.config, { provider: args.str('provider'), model: args.str('model') });
  if ('error' in resolved) return resolved;
  if ('missing' in resolved) return { error: ERRORS.noApiKey("generate's AI tier") };
  const { provider, model, apiKey, overrides, keySource } = resolved.call;

  try {
    const enhance = createAiEnhancer({ provider, model, apiKey, overrides });
    return {
      enhance,
      provider,
      model,
      source: keySource ? `key from ${keySource === 'env-file' ? '.env' : 'environment'}` : 'no key needed',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
