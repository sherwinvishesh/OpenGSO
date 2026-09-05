import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CustomBotInput } from '../shared/bots.js';
import { resolveBots, resolveRoutableBots } from '../shared/bots.js';
import type { AiProvider, OpenGeoConfig } from '../shared/config.js';
import { AI_PROVIDERS, CONFIG_FILENAME, DEFAULT_MODELS, defaultConfig, loadConfig, saveConfig } from '../shared/config.js';
import type { GitignoreResult } from '../shared/env.js';
import { ENV_FILENAME, KEY_VAR, MODEL_VAR, PROVIDER_VAR, ensureEnvGitignored, readCredentials, writeEnvVars } from '../shared/env.js';
import { parseUrl } from '../shared/http.js';
import { c, heading } from '../shared/log.js';
import { pickBots } from './bot-picker.js';
import type { Prompter } from './prompt.js';

/**
 * The interactive configuration flow, behind both `opengeo start` and `opengeo settings` (§11, §12).
 *
 * Four questions, in an order chosen so nobody is asked for a secret before the thing that keeps
 * the secret safe exists: `.gitignore` is updated *before* the key is written, every time, and the
 * command says so on screen. That gitignore line is the actual leak-prevention mechanism, not the
 * documentation around it.
 *
 * A key is optional and the prompt says so plainly. Most of OpenGEO needs no key at all, and a
 * setup flow that implied otherwise would make the free path feel like the degraded one.
 *
 * The two modes ask the same questions and differ only in framing. `first-run` is the walkthrough a
 * new project gets, and ends by naming the three commands to try next. `settings` assumes the
 * project already works: every default is the current value, the block list becomes editable, and
 * it finishes with what actually changed rather than with a tutorial.
 */

const MAX_URL_ATTEMPTS = 5;

export type SetupMode = 'first-run' | 'settings';

/** A setup that stopped on purpose. The message is already user-facing; the CLI just prints it. */
export class SetupAbort extends Error {}

export interface SetupOptions {
  root: string;
  prompter: Prompter;
  /** Defaults to first-run. `settings` re-frames the same questions as edits (§12). */
  mode?: SetupMode;
  /** Where the flow narrates itself. Injected so the whole thing is testable without a terminal. */
  out?: (text: string) => void;
}

export interface SetupResult {
  root: string;
  configPath: string;
  config: OpenGeoConfig;
  createdConfig: boolean;
  /** Crawlers the user defined during this run, already merged into `config.bots.custom`. */
  addedBots: CustomBotInput[];
  /** Set only when a key was actually written, which is also the only time .gitignore is touched. */
  keyWritten?: { provider: AiProvider; envPath: string; gitignore: GitignoreResult };
}

type RoutingChoice = 'all' | 'assistants' | 'none' | 'custom';

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { root, prompter } = options;
  const mode = options.mode ?? 'first-run';
  const settings = mode === 'settings';
  const write = options.out ?? ((text: string) => process.stdout.write(text));

  const existing = loadConfig(root);
  // Only reuse a config that belongs to this directory. Walking up found someone else's project.
  const hasConfig = existing.exists && existing.root === root;
  const base = hasConfig ? existing.config : defaultConfig();

  write(`\n${c.bold(settings ? 'OpenGEO settings' : 'OpenGEO setup')}\n`);
  write(`${c.gray(root)}\n`);
  write(
    `${c.gray(
      hasConfig
        ? `${CONFIG_FILENAME} exists - its current values are the defaults below.`
        : `${CONFIG_FILENAME} will be created here.`,
    )}\n`,
  );
  if (settings) write(`${c.gray('Press Enter on any question to leave that setting exactly as it is.')}\n`);

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
  const publicDir = await prompter.ask('  Web root (generated files land here)', base.publicDir || defaultConfig().publicDir);

  // 2. Bot routing -----------------------------------------------------------------------------
  write(heading('2/4  Which AI agents get the Markdown twin'));
  write(`\n${c.gray('This chooses a format, never access. An agent that is not on this list still sees your')}\n`);
  write(`${c.gray('normal site, exactly like a human visitor.')}\n\n`);

  const routableBots = resolveRoutableBots(base.bots.custom);
  const everyone = routableBots.map((bot) => bot.name);
  const assistantsAndSearch = routableBots.filter((bot) => bot.kind !== 'training').map((bot) => bot.name);

  const routingChoice = await prompter.choose<RoutingChoice>(
    '  Route markdown to:',
    [
      {
        value: 'all',
        label: `every AI bot OpenGEO knows about (${everyone.length})`,
        note: 'The twin is the same content in a cleaner format, so there is rarely a reason to withhold it.',
      },
      {
        value: 'assistants',
        label: `assistants and search crawlers only (${assistantsAndSearch.length})`,
        note: 'Training crawlers get the normal HTML instead.',
      },
      { value: 'none', label: 'nobody for now', note: 'Accept: text/markdown still works. Only User-Agent routing is off.' },
      {
        value: 'custom',
        label: 'let me pick, one by one',
        note: 'Shows every crawler to tick off by name, and lets you add one OpenGEO has never heard of.',
      },
    ],
    currentRoutingChoice(base.bots.markdownRouting, everyone, assistantsAndSearch, settings),
  );

  let markdownRouting: string[];
  let addedBots: CustomBotInput[] = [];
  if (routingChoice === 'all') markdownRouting = everyone;
  else if (routingChoice === 'assistants') markdownRouting = assistantsAndSearch;
  else if (routingChoice === 'none') markdownRouting = [];
  else {
    const picked = await pickBots({
      prompter,
      out: write,
      bots: routableBots,
      // Starting from what the project already routes to, so `custom` is an edit rather than a
      // blank sheet. A fresh project routes to everyone, which is the right thing to narrow from.
      selected: hasConfig ? base.bots.markdownRouting : everyone,
      verb: 'markdown to',
      routableOnly: true,
      allowAdd: true,
    });
    markdownRouting = picked.selected;
    addedBots = picked.added;
  }

  const customBots = [...base.bots.custom, ...addedBots];

  // 3. Blocking --------------------------------------------------------------------------------
  write(heading('3/4  Blocking (a separate lever)'));
  write(`\n${c.gray('Blocking is not the same setting as routing, and OpenGEO never turns it on for you.')}\n`);
  write(`${c.gray('It is written into robots.txt by `opengeo generate`, is advisory, and starts empty.')}\n\n`);
  write(
    base.bots.blocked.length > 0
      ? `  ${c.yellow(`Currently blocking: ${base.bots.blocked.join(', ')}.`)}\n`
      : `  ${c.gray('Nothing is blocked.')}\n`,
  );

  let blocked = base.bots.blocked;
  if (settings) {
    // Offered only in settings mode. A first run has no reason to block anybody, and putting the
    // question in front of a new user would imply OpenGEO thinks they should.
    write('\n');
    const edit = await prompter.confirm('  Edit the block list?', false);
    if (edit) {
      const picked = await pickBots({
        prompter,
        out: write,
        bots: resolveBots(customBots),
        selected: base.bots.blocked,
        verb: 'block',
        routableOnly: false,
        allowAdd: false,
      });
      blocked = picked.selected;
      write(`\n  ${c.gray('Takes effect the next time `opengeo generate` rewrites robots.txt.')}\n`);
    }
  } else {
    write(`  ${c.gray(`Add names to bots.blocked in ${CONFIG_FILENAME} if you ever want to.`)}\n`);
  }

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
        note: 'You can run `opengeo settings` again at any time.',
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
    bots: { markdownRouting, blocked, custom: customBots },
    ai,
  };
  const configPath = saveConfig(root, config);

  write(heading(settings ? 'Saved' : 'Done'));
  write('\n');
  if (settings) {
    for (const line of describeChanges(base, config, keyWritten)) write(`  ${line}\n`);
    write(`  ${c.gray(`${relative(root, configPath) || CONFIG_FILENAME} written.`)}\n`);
  } else {
    write(`  ${c.green('ok')} ${createdConfig ? 'Created' : 'Updated'} ${relative(root, configPath) || CONFIG_FILENAME}\n`);
    write(`  ${c.green('ok')} Routing markdown to ${markdownRouting.length} AI agent${markdownRouting.length === 1 ? '' : 's'}\n`);
    write(`  ${c.green('ok')} Blocking ${blocked.length === 0 ? 'nobody' : blocked.join(', ')}\n`);
    if (keyWritten) {
      write(`  ${c.green('ok')} Wrote ${KEY_VAR} to ${relative(root, keyWritten.envPath) || ENV_FILENAME}\n`);
      write(`  ${c.green('ok')} ${ENV_FILENAME} is gitignored, so the key cannot be committed\n`);
    }
  }

  if (addedBots.length > 0) {
    write(`\n${c.bold('Crawlers you added')}\n`);
    for (const bot of addedBots) {
      write(`  ${bot.name} ${c.gray(`matches any User-Agent containing ${(bot.uaPatterns ?? []).join(' or ')}`)}\n`);
    }
    write(`  ${c.gray(`Stored in bots.custom in ${CONFIG_FILENAME}. Restart your site for prod to pick them up.`)}\n`);
  }

  write(`\n${c.bold('Where your key lives')}\n`);
  write(`  ${c.gray(join(root, ENV_FILENAME))}${keyWritten || found ? '' : c.gray('  (nothing there yet)')}\n`);
  write(`  ${c.gray('It is read from that file and sent to the provider you chose, and nowhere else. OpenGEO')}\n`);
  write(`  ${c.gray('has no telemetry, no analytics and no cloud sync, so there is nothing else to audit.')}\n`);

  if (!settings) {
    write(`\n${c.bold('Next')}\n`);
    write(`  opengeo test ${site}${c.gray('       score the page as it is today')}\n`);
    write(`  opengeo generate ${site}${c.gray('   write the twins, robots.txt, llms.txt, sitemap.xml')}\n`);
    write(`  opengeo prod test ${site}${c.gray('  once the middleware is wired in')}\n`);
  }
  write('\n');

  return { root, configPath, config, createdConfig, addedBots, keyWritten };
}

/**
 * Which of the four answers describes the routing a project already has.
 *
 * On a first run the answer is always `all`, because that is OpenGEO's recommendation rather than a
 * report of anything. In settings mode the default has to be whatever is currently true, or pressing
 * Enter through the flow would quietly widen a list the user had deliberately narrowed.
 */
function currentRoutingChoice(
  routing: readonly string[],
  everyone: readonly string[],
  assistantsAndSearch: readonly string[],
  settings: boolean,
): RoutingChoice {
  if (!settings) return 'all';
  if (sameNames(routing, everyone)) return 'all';
  if (routing.length === 0) return 'none';
  if (sameNames(routing, assistantsAndSearch)) return 'assistants';
  return 'custom';
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map((name) => name.toLowerCase()).sort();
  const right = [...b].map((name) => name.toLowerCase()).sort();
  return left.every((name, index) => name === right[index]);
}

/** What settings mode prints instead of a tutorial: the diff, or the fact that there is not one. */
function describeChanges(
  before: OpenGeoConfig,
  after: OpenGeoConfig,
  keyWritten: SetupResult['keyWritten'],
): string[] {
  const lines: string[] = [];
  const changed = (label: string, from: string, to: string) => {
    if (from !== to) lines.push(`${c.green('changed')} ${label} ${c.gray(from)} ${c.gray('->')} ${to}`);
  };

  changed('site', before.site, after.site);
  changed('web root', before.publicDir, after.publicDir);
  if (!sameNames(before.bots.markdownRouting, after.bots.markdownRouting)) {
    lines.push(
      `${c.green('changed')} markdown routing ${c.gray(`${before.bots.markdownRouting.length} agents ->`)} ${after.bots.markdownRouting.length} agents`,
    );
  }
  if (!sameNames(before.bots.blocked, after.bots.blocked)) {
    lines.push(
      `${c.green('changed')} block list ${c.gray(`${describeList(before.bots.blocked)} ->`)} ${describeList(after.bots.blocked)}`,
    );
  }
  if (after.bots.custom.length > before.bots.custom.length) {
    lines.push(`${c.green('added')} ${after.bots.custom.length - before.bots.custom.length} custom crawler(s)`);
  }
  if (keyWritten) lines.push(`${c.green('changed')} API key ${c.gray(`written to ${ENV_FILENAME}, which is gitignored`)}`);

  if (lines.length === 0) lines.push(c.gray('Nothing changed. Every answer matched what was already there.'));
  return lines;
}

function describeList(names: readonly string[]): string {
  return names.length === 0 ? 'nobody' : names.join(', ');
}
