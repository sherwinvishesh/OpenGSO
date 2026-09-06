import { relative } from 'node:path';
import { c, heading } from '../../shared/log.js';
import { providerOverridesOf } from '../../shared/config.js';
import type { AiProvider } from '../../shared/providers.js';
import { AI_PROVIDERS, DEFAULT_MODELS, isAiProvider, providerInfo } from '../../shared/providers.js';
import { isCI, readCredentials } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import { createAiEnhancer } from '../../generate/ai.js';
import { generateSite } from '../../generate/site.js';
import { twinUrlFor } from '../../generate/generate.js';
import type { EnhanceInput, EnhanceOutput } from '../../generate/generate.js';
import { parseArgs } from '../args.js';
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
      if (args.bool('json')) return;
      if (event.phase === 'crawl') {
        if (lastPhase !== 'crawl') {
          process.stdout.write(`\n  ${c.gray('Discovering routes by following links')}\n`);
          lastPhase = 'crawl';
        }
        process.stdout.write(`  ${c.gray(`[${event.crawl.visited + 1}/${event.crawl.found}]`)} ${event.crawl.route}\n`);
        return;
      }
      if (event.phase === 'generate') {
        if (lastPhase !== 'generate') {
          process.stdout.write(`\n  ${c.gray('Converting pages')}\n`);
          lastPhase = 'generate';
        }
        if (event.generate.phase === 'ai') {
          process.stdout.write(`  ${c.gray(`[${event.generate.index}/${event.generate.total}]`)} ${event.generate.route} ${c.gray('(AI)')}\n`);
        }
      }
    },
  });

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

  process.stdout.write(`${heading('Pages')}\n`);
  for (const page of result.generate.pages) {
    const label =
      page.status === 'written'
        ? c.green('written')
        : page.status === 'cached'
          ? c.gray('cached ')
          : page.status === 'skipped-manual'
            ? c.yellow('manual ')
            : c.red('failed ');
    const detail =
      page.status === 'written'
        ? c.gray(`${page.tokens} tokens  ${twinUrlFor(site, page.route)}`)
        : c.gray(page.reason ?? '');
    process.stdout.write(`  ${label} ${page.route.padEnd(24)} ${detail}\n`);
    for (const warning of page.warnings) process.stdout.write(`          ${c.yellow('warn')} ${warning}\n`);
  }

  if (result.files.length > 0) {
    process.stdout.write(`${heading('Site files')}\n`);
    for (const file of result.files) {
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

  const pages = result.generate.pages;
  const written = pages.filter((page) => page.status === 'written').length;
  const failed = pages.filter((page) => page.status === 'failed').length;
  const aiPages = pages.filter((page) => page.tier === 'ai').length;
  const fellBack = pages.filter((page) => page.warnings.some((w) => w.startsWith('Kept the algorithmic version'))).length;

  process.stdout.write(
    `\n  ${written} written, ${pages.length - written - failed} unchanged${failed > 0 ? `, ${c.red(`${failed} failed`)}` : ''}` +
      `${tier === 'ai' ? `, ${aiPages} AI-enhanced${fellBack > 0 ? `, ${c.yellow(`${fellBack} fell back on fidelity`)}` : ''}` : ''}` +
      ` ${c.gray(`in ${result.durationMs}ms`)}\n`,
  );
  process.stdout.write(`  ${c.gray(`Output: ${relative(process.cwd(), result.generate.publicDir) || result.generate.publicDir}`)}\n`);

  const crawlWarnings = result.warnings.filter((w) => !w.includes('.opengeo-proposed'));
  if (crawlWarnings.length > 0) {
    process.stdout.write(`${heading('Notes')}\n`);
    for (const warning of crawlWarnings) process.stdout.write(`  ${c.yellow('warn')} ${warning}\n`);
  }
  for (const file of result.files) {
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

  const { root, config } = loaded;
  const providerFlag = args.str('provider');
  if (providerFlag && !isAiProvider(providerFlag)) {
    return { error: ERRORS.unknownProvider(providerFlag, AI_PROVIDERS) };
  }

  const credentials = readCredentials(root);
  const provider = (providerFlag as AiProvider | undefined) ?? credentials?.provider ?? config.ai.provider;
  // A model server on this machine has no key to find, so "no credentials" and "cannot run" are
  // different states. Only the providers that actually authenticate get turned away here.
  const keyless = Boolean(providerInfo(provider).keyless) || config.ai.auth === 'none';
  if (!credentials && !keyless) return { error: ERRORS.noApiKey("generate's AI tier") };

  const model = args.str('model') || credentials?.model || config.ai.model || DEFAULT_MODELS[provider];
  // The endpoint comes from the config, which is shared, and the key from .env, which is not. A
  // BASE_URL in the environment wins, because that is the machine-specific override.
  const overrides = { ...providerOverridesOf(config), baseUrl: credentials?.baseUrl ?? config.ai.baseUrl };

  try {
    const enhance = createAiEnhancer({ provider, model, apiKey: credentials?.apiKey ?? '', overrides });
    return {
      enhance,
      provider,
      model,
      source: credentials ? `key from ${credentials.source === 'env-file' ? '.env' : 'environment'}` : 'no key needed',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
