import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROUTABLE_BOTS } from '../../shared/bots.js';
import type { AiProvider, OpenGeoConfig } from '../../shared/config.js';
import { AI_PROVIDERS, CONFIG_FILENAME, DEFAULT_MODELS, defaultConfig, loadConfig, saveConfig } from '../../shared/config.js';
import type { GitignoreResult } from '../../shared/env.js';
import { ENV_FILENAME, KEY_VAR, MODEL_VAR, PROVIDER_VAR, ensureEnvGitignored, readCredentials, writeEnvVars } from '../../shared/env.js';
import { parseUrl } from '../../shared/http.js';
import { c, heading } from '../../shared/log.js';
import { parseArgs } from '../args.js';
import type { CommandContext } from '../index.js';
import type { Prompter } from '../prompt.js';
import { createPrompter } from '../prompt.js';

const SPEC = {
  booleans: ['yes'],
  strings: ['project'],
  alias: { y: 'yes' },
} as const;

/**
 * `opengeo setup` (idea.md §11, §12).
 *
 * Four questions, in an order chosen so nobody is asked for a secret before the thing that keeps
 * the secret safe exists: `.gitignore` is updated *before* the key is written, every time, and the
 * command says so on screen. That gitignore line is the actual leak-prevention mechanism, not the
 * documentation around it.
 *
 * A key is optional and the prompt says so plainly. Most of OpenGEO needs no key at all, and a
 * setup flow that implied otherwise would make the free path feel like the degraded one.
 */

const MAX_URL_ATTEMPTS = 5;

/** A setup that stopped on purpose. The message is already user-facing; the CLI just prints it. */
export class SetupAbort extends Error {}

export interface SetupOptions {
  root: string;
  prompter: Prompter;
  /** Where the flow narrates itself. Injected so the whole thing is testable without a terminal. */
  out?: (text: string) => void;
}

export interface SetupResult {
  root: string;
  configPath: string;
  config: OpenGeoConfig;
  createdConfig: boolean;
  /** Set only when a key was actually written, which is also the only time .gitignore is touched. */
  keyWritten?: { provider: AiProvider; envPath: string; gitignore: GitignoreResult };
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { root, prompter } = options;
  const write = options.out ?? ((text: string) => process.stdout.write(text));

  const existing = loadConfig(root);
  // Only reuse a config that belongs to this directory. Walking up found someone else's project.
  const base = existing.exists && existing.root === root ? existing.config : defaultConfig();

  write(`\n${c.bold('OpenGEO setup')}\n`);
  write(`${c.gray(root)}\n`);
  write(
    `${c.gray(
      existing.exists && existing.root === root
        ? `${CONFIG_FILENAME} exists - its current values are the defaults below.`
        : `${CONFIG_FILENAME} will be created here.`,
    )}\n`,
  );

  // 1. Site ------------------------------------------------------------------------------------
  write(heading('1/4  Your site'));
  write(`\n${c.gray('OpenGEO always works against a URL, never a source directory: it has to see what your')}\n`);
  write(`${c.gray('site actually serves. A local dev server is fine.')}\n\n`);

  let site = base.site;
  // Bounded, because a prompter whose input has ended answers every question the same way and an
  // unbounded retry loop would spin forever on it.
  for (let attempt = 1; ; attempt += 1) {
    const answer = await prompter.ask('  Site URL', site);
    if (parseUrl(answer)) {
      site = answer;
      break;
    }
    if (attempt >= MAX_URL_ATTEMPTS) {
      throw new SetupAbort(`"${answer}" is not a URL OpenGEO can fetch, and setup ran out of attempts. Nothing was written.`);
    }
    write(`  ${c.yellow(`"${answer}" is not a URL OpenGEO can fetch. Include the scheme, e.g. http://localhost:3000.`)}\n`);
  }
  const publicDir = await prompter.ask('  Web root (generated files land here)', base.publicDir);

  // 2. Bot routing -----------------------------------------------------------------------------
  write(heading('2/4  Which AI agents get the Markdown twin'));
  write(`\n${c.gray('This chooses a format, never access. An agent that is not on this list still sees your')}\n`);
  write(`${c.gray('normal site, exactly like a human visitor.')}\n\n`);

  const assistantsAndSearch = ROUTABLE_BOTS.filter((bot) => bot.kind !== 'training').map((bot) => bot.name);
  const routingChoice = await prompter.choose(
    '  Route markdown to:',
    [
      {
        value: 'all',
        label: `every AI bot OpenGEO knows about (${ROUTABLE_BOTS.length})`,
        note: 'The twin is the same content in a cleaner format, so there is rarely a reason to withhold it.',
      },
      {
        value: 'assistants',
        label: `assistants and search crawlers only (${assistantsAndSearch.length})`,
        note: 'Training crawlers get the normal HTML instead.',
      },
      { value: 'none', label: 'nobody for now', note: 'Accept: text/markdown still works. Only User-Agent routing is off.' },
    ],
    'all',
  );
  const markdownRouting =
    routingChoice === 'all' ? ROUTABLE_BOTS.map((bot) => bot.name) : routingChoice === 'assistants' ? assistantsAndSearch : [];

  // 3. Blocking --------------------------------------------------------------------------------
  write(heading('3/4  Blocking (a separate lever)'));
  write(`\n${c.gray('Blocking is not the same setting as routing, and OpenGEO never turns it on for you.')}\n`);
  write(`${c.gray('It is written into robots.txt by `opengeo generate`, is advisory, and starts empty.')}\n\n`);
  write(
    base.bots.blocked.length > 0
      ? `  ${c.yellow(`Currently blocking: ${base.bots.blocked.join(', ')}. Left exactly as it is.`)}\n`
      : `  ${c.gray(`Nothing is blocked. Add names to bots.blocked in ${CONFIG_FILENAME} if you ever want to.`)}\n`,
  );

  // 4. API key ---------------------------------------------------------------------------------
  write(heading('4/4  AI provider key (optional)'));
  write(`\n${c.gray('Everything that matters works without one: the structural 0-100 test, the whole free')}\n`);
  write(`${c.gray('generate tier, and opengeo-prod. A key only unlocks `generate --tier ai` and')}\n`);
  write(`${c.gray('`test --quality`, and it is only ever sent to the provider you pick below.')}\n\n`);

  const found = readCredentials(root);
  if (found) {
    write(
      `  ${c.green('A key is already configured')} ${c.gray(
        `(${found.provider}, from ${found.source === 'env-file' ? ENV_FILENAME : 'your shell environment'})`,
      )}\n\n`,
    );
  }

  const providerChoice = await prompter.choose<AiProvider | 'skip'>(
    found ? '  Replace it?' : '  Add a key?',
    [
      {
        value: 'skip',
        label: found ? 'keep the key I already have' : 'skip for now',
        note: 'You can run `opengeo setup` again at any time.',
      },
      ...AI_PROVIDERS.map((provider) => ({ value: provider, label: provider })),
    ],
    'skip',
  );

  let ai = { provider: base.ai.provider, model: base.ai.model };
  let keyWritten: SetupResult['keyWritten'];

  if (providerChoice !== 'skip') {
    // The gitignore line goes in before the key does. Never the other way round.
    const gitignore = ensureEnvGitignored(root);
    write(
      `\n  ${gitignore.alreadyPresent ? c.gray(`${ENV_FILENAME} is already in .gitignore.`) : c.green(`Added ${ENV_FILENAME} to .gitignore.`)}\n`,
    );

    const key = await prompter.secret(`  ${providerChoice} API key ${c.gray('(hidden as you type)')}:`);
    if (!key) {
      write(`  ${c.yellow('No key entered, so nothing was written.')}\n`);
    } else {
      const model = await prompter.ask('  Model', base.ai.model || DEFAULT_MODELS[providerChoice]);
      const envPath = writeEnvVars(root, { [PROVIDER_VAR]: providerChoice, [KEY_VAR]: key, [MODEL_VAR]: model });
      ai = { provider: providerChoice, model };
      keyWritten = { provider: providerChoice, envPath, gitignore };
    }
  }

  const createdConfig = !existsSync(join(root, CONFIG_FILENAME));
  const config: OpenGeoConfig = {
    ...base,
    site,
    publicDir,
    bots: { markdownRouting, blocked: base.bots.blocked },
    ai,
  };
  const configPath = saveConfig(root, config);

  write(heading('Done'));
  write('\n');
  write(`  ${c.green('ok')} ${createdConfig ? 'Created' : 'Updated'} ${relative(root, configPath) || CONFIG_FILENAME}\n`);
  write(`  ${c.green('ok')} Routing markdown to ${markdownRouting.length} AI agent${markdownRouting.length === 1 ? '' : 's'}\n`);
  write(`  ${c.green('ok')} Blocking ${config.bots.blocked.length === 0 ? 'nobody' : config.bots.blocked.join(', ')}\n`);
  if (keyWritten) {
    write(`  ${c.green('ok')} Wrote ${KEY_VAR} to ${relative(root, keyWritten.envPath) || ENV_FILENAME}\n`);
    write(`  ${c.green('ok')} ${ENV_FILENAME} is gitignored, so the key cannot be committed\n`);
  }

  write(`\n${c.bold('Where your key lives')}\n`);
  write(`  ${c.gray(join(root, ENV_FILENAME))}${keyWritten ? '' : c.gray('  (nothing there yet)')}\n`);
  write(`  ${c.gray('It is read from that file and sent to the provider you chose, and nowhere else. OpenGEO')}\n`);
  write(`  ${c.gray('has no telemetry, no analytics and no cloud sync, so there is nothing else to audit.')}\n`);

  write(`\n${c.bold('Next')}\n`);
  write(`  opengeo test ${site}${c.gray('       score the page as it is today')}\n`);
  write(`  opengeo generate ${site}${c.gray('   write the twins, robots.txt, llms.txt, sitemap.xml')}\n`);
  write(`  opengeo prod test ${site}${c.gray('  once the middleware is wired in')}\n\n`);

  return { root, configPath, config, createdConfig, keyWritten };
}

export async function setupCommand(ctx: CommandContext): Promise<number> {
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
    await runSetup({ root, prompter });
    return 0;
  } catch (error) {
    if (error instanceof SetupAbort) {
      process.stderr.write(`\n${c.red('setup stopped')} ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    prompter.close();
  }
}
