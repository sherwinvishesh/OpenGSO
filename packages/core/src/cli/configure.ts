import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CustomBotInput } from '../shared/bots.js';
import { resolveBots, resolveRoutableBots } from '../shared/bots.js';
import type { OpenGeoConfig } from '../shared/config.js';
import { CONFIG_FILENAME, defaultConfig, loadConfig, projectDirProblem, saveConfig } from '../shared/config.js';
import type { AiProvider, ProviderApi } from '../shared/providers.js';
import { PROVIDERS, providerInfo } from '../shared/providers.js';
import type { GitignoreResult } from '../shared/env.js';
import {
  BASE_URL_VAR,
  ENV_FILENAME,
  KEY_VAR,
  MODEL_VAR,
  PROVIDER_VAR,
  ensureEnvGitignored,
  readCredentials,
  writeEnvVars,
} from '../shared/env.js';
import { parseUrl } from '../shared/http.js';
import { c, heading } from '../shared/log.js';
import { pickBots } from './bot-picker.js';
import type { Prompter } from './prompt.js';
import { detectWebRoot, type SitePreview, type WebRootGuess } from '../shared/site-probe.js';
import { previewLines } from './setup-preview.js';

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
 * The two modes share the five steps and nothing else, because they are not the same interaction.
 * `first-run` (`runSetup`) is a walkthrough: it opens by saying what OpenGEO is, asks the questions
 * in order, and ends by naming the three commands to try next. `settings` (`runSettings`) is a menu:
 * every setting on one screen with its current value beside it, pick a number, change that one
 * thing, land back on the menu. Somebody running settings on a working project already knows the one
 * thing they came to change, and a walkthrough would make them press Enter past everything else to
 * reach it.
 */

const MAX_URL_ATTEMPTS = 5;

export type SetupMode = 'first-run' | 'settings';

/**
 * Which of the two a directory should get, asked the same way by every caller.
 *
 * Only a config that belongs to *this* directory counts. `loadConfig` walks up, which is right for
 * running a command from a subdirectory and wrong here: finding somebody else's project two levels
 * up and silently editing it is a surprise, and inheriting their answers as defaults is worse. A
 * directory with nothing of its own is being set up, so it gets the walkthrough.
 */
export function setupMode(root: string): SetupMode {
  const found = loadConfig(root);
  return found.exists && found.root === root ? 'settings' : 'first-run';
}

/** A setup that stopped on purpose. The message is already user-facing; the CLI just prints it. */
export class SetupAbort extends Error {}

export interface SetupOptions {
  root: string;
  prompter: Prompter;
  /** Defaults to first-run. `settings` re-frames the same questions as edits (§12). */
  mode?: SetupMode;
  /** Where the flow narrates itself. Injected so the whole thing is testable without a terminal. */
  out?: (text: string) => void;
  /**
   * Fetches the site URL as it is entered, so the answer can be checked while it is still cheap to
   * change. Injected rather than imported, because configure.ts should not decide on every caller's
   * behalf that setup makes a network request: the CLI passes `previewSite`, tests pass a stub, and
   * a caller that wants four silent questions passes nothing and gets exactly what it always got.
   */
  preview?: (url: string) => Promise<SitePreview | undefined>;
  /**
   * Runs after the config is saved, to end setup on a real number instead of three commands to go
   * and try. Injected for the same reason and one more: `test` pulls in jsdom and the AI providers,
   * and configure.ts is imported by packages that ship neither.
   */
  finish?: (result: SetupResult, write: (text: string) => void) => Promise<void>;
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

/**
 * What OpenGEO is, in the six lines somebody who just typed `opengeo` will actually read.
 *
 * A bare `opengeo` lands here, so this is the product's first screen for most people. It says what
 * the problem is before it says what the tool does, because "Markdown twin" means nothing until you
 * have been told that agents are reading HTML written for browsers and getting it wrong.
 */
function writeIntro(write: (text: string) => void): void {
  write(`\n${c.bold('What this is')}\n`);
  write(`  ${c.gray('AI agents read your site by scraping pages built for browsers, and they lose things:')}\n`);
  write(`  ${c.gray('nav chrome, scripts and layout come through, prices and dates sometimes do not.')}\n`);
  write(`  ${c.gray('OpenGEO serves those agents a clean Markdown copy of every page, at the same URL,')}\n`);
  write(`  ${c.gray('and measures whether it is working.')}\n\n`);
  write(`  ${c.bold('test')}      ${c.gray('score a live URL out of 100, then have a model read the Markdown')}\n`);
  write(`  ${c.bold('generate')}  ${c.gray('write a .md twin of every page, plus robots.txt, llms.txt, sitemap.xml')}\n`);
  write(`  ${c.bold('prod')}      ${c.gray('middleware that serves the twin to agents and the real page to people')}\n\n`);
  write(`  ${c.gray('Four questions and you are set up. Nothing is uploaded and there is no account.')}\n`);
}

/** Everything a step needs to ask its question. Passed around so the steps stay independent. */
interface StepContext {
  root: string;
  prompter: Prompter;
  write: (text: string) => void;
  /** Framing only. In settings mode every default is the current value, never a recommendation. */
  settings: boolean;
  hasConfig: boolean;
  preview?: SetupOptions['preview'];
}

async function askSiteUrl(ctx: StepContext, current: string): Promise<string> {
  // Bounded, because a prompter whose input has ended answers every question the same way and an
  // unbounded retry loop would spin forever on it.
  for (let attempt = 1; ; attempt += 1) {
    const answer = await ctx.prompter.ask('  Site URL', current);
    if (parseUrl(answer)) {
      await reportSite(ctx, answer);
      return answer;
    }
    if (attempt >= MAX_URL_ATTEMPTS) {
      throw new SetupAbort(`"${answer}" is not a URL OpenGEO can fetch, and setup ran out of attempts. Nothing was written.`);
    }
    ctx.write(`  ${c.yellow(`"${answer}" is not a URL OpenGEO can fetch. Include the scheme, e.g. http://localhost:3000.`)}\n`);
  }
}

/**
 * What is actually at that URL, said out loud before the next question.
 *
 * Never a gate. A site that is not running yet is a completely normal thing to be setting OpenGEO up
 * against, and refusing the URL over it would be wrong. The probe is here so that a typo, a wrong
 * port or a client-rendered page is visible now rather than three commands later.
 */
async function reportSite(ctx: StepContext, url: string): Promise<void> {
  if (!ctx.preview) return;
  const preview = await ctx.preview(url).catch(() => undefined);
  if (!preview) return;
  for (const line of previewLines(preview)) ctx.write(`  ${line}\n`);
}

/**
 * The one question setup can usually answer for itself.
 *
 * A configured project's own value always wins: the detector is a guess about a convention, and the
 * answer already in `opengeo.config.json` is a decision somebody made. On a fresh directory the
 * guess becomes the default, and the reason is printed beside it so it can be overruled on sight
 * rather than accepted because it was there.
 */
async function askWebRoot(ctx: StepContext, current: string): Promise<string> {
  // `current` on a project with no config of its own is `defaultConfig().publicDir`, which nobody
  // typed, so the detector is free to replace it. Once opengeo.config.json exists the same string
  // is an answer somebody gave, and a guess about a convention does not get to overrule that.
  const configured = ctx.hasConfig ? current : '';
  const guess: WebRootGuess = detectWebRoot(ctx.root);
  if (!configured && guess.found) ctx.write(`  ${c.gray(`Detected ${guess.dir}/ - ${guess.why}.`)}\n`);
  let answer = await ctx.prompter.ask('  Web root (generated files land here)', configured || guess.dir);
  // The detector's guess is always a folder below the root, so offering it again cannot loop, and a
  // non-interactive prompter that only ever returns the fallback gets a valid answer the second time.
  for (let problem = webRootProblem(ctx.root, answer); problem; problem = webRootProblem(ctx.root, answer)) {
    ctx.write(`  ${c.yellow(problem.split('\n')[0] ?? problem)}\n`);
    answer = await ctx.prompter.ask('  Web root (generated files land here)', guess.dir);
  }
  return answer;
}

function webRootProblem(root: string, publicDir: string): string | undefined {
  return projectDirProblem(root, { publicDir, internalDir: defaultConfig().internalDir });
}

interface RoutingAnswer {
  markdownRouting: string[];
  addedBots: CustomBotInput[];
}

async function askRouting(ctx: StepContext, config: OpenGeoConfig): Promise<RoutingAnswer> {
  const routableBots = resolveRoutableBots(config.bots.custom);
  const everyone = routableBots.map((bot) => bot.name);
  const assistantsAndSearch = routableBots.filter((bot) => bot.kind !== 'training').map((bot) => bot.name);

  const routingChoice = await ctx.prompter.choose<RoutingChoice>(
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
    currentRoutingChoice(config.bots.markdownRouting, everyone, assistantsAndSearch, ctx.settings),
  );

  if (routingChoice === 'all') return { markdownRouting: everyone, addedBots: [] };
  if (routingChoice === 'assistants') return { markdownRouting: assistantsAndSearch, addedBots: [] };
  if (routingChoice === 'none') return { markdownRouting: [], addedBots: [] };

  const picked = await pickBots({
    prompter: ctx.prompter,
    out: ctx.write,
    bots: routableBots,
    // Starting from what the project already routes to, so `custom` is an edit rather than a
    // blank sheet. A fresh project routes to everyone, which is the right thing to narrow from.
    selected: ctx.hasConfig ? config.bots.markdownRouting : everyone,
    verb: 'markdown to',
    routableOnly: true,
    allowAdd: true,
  });
  return { markdownRouting: picked.selected, addedBots: picked.added };
}

async function askBlocked(ctx: StepContext, config: OpenGeoConfig): Promise<string[]> {
  const picked = await pickBots({
    prompter: ctx.prompter,
    out: ctx.write,
    bots: resolveBots(config.bots.custom),
    selected: config.bots.blocked,
    verb: 'block',
    routableOnly: false,
    allowAdd: false,
  });
  ctx.write(`\n  ${c.gray('Takes effect the next time `opengeo generate` rewrites robots.txt.')}\n`);
  return picked.selected;
}

interface ProviderAnswer {
  ai: OpenGeoConfig['ai'];
  keyWritten?: SetupResult['keyWritten'];
}

/**
 * Step 4, and the only step that writes a file of its own.
 *
 * Returns undefined when nothing should change, which covers three different answers: "skip",
 * an endpoint the user did not finish giving, and an empty key. None of them should overwrite what
 * is already configured.
 */
async function askProvider(ctx: StepContext, config: OpenGeoConfig): Promise<ProviderAnswer | undefined> {
  const { prompter, write, root } = ctx;
  const found = readCredentials(root);
  if (found) {
    write(
      `  ${c.green('A key is already configured')} ${c.gray(
        `(${found.provider}, from ${found.source === 'env-file' ? ENV_FILENAME : 'your shell environment'})`,
      )}\n\n`,
    );
  }

  // The catalogue drives the list, so adding a provider is a row in one file and nothing here
  // changes. `custom` is last on purpose: it is the answer for people who already know they need it.
  const providerChoice = await prompter.choose<AiProvider | 'skip'>(
    found ? '  Replace it?' : '  Add a key?',
    [
      {
        value: 'skip',
        label: found ? 'keep the key I already have' : 'skip for now',
        note: 'You can run `opengeo settings` again at any time.',
      },
      ...PROVIDERS.map((provider) => ({
        value: provider.id,
        label: provider.label,
        note: providerNote(provider.id),
      })),
    ],
    'skip',
  );
  if (providerChoice === 'skip') return undefined;

  const info = providerInfo(providerChoice);
  const endpoint = await askEndpoint(prompter, write, providerChoice, config);
  if (!endpoint) {
    write(`  ${c.yellow('No endpoint given, so nothing was written.')}\n`);
    return undefined;
  }

  // The gitignore line goes in before the key does. Never the other way round.
  const gitignore = ensureEnvGitignored(root);
  write(
    `\n  ${gitignore.alreadyPresent ? c.gray(`${ENV_FILENAME} is already in .gitignore.`) : c.green(`Added ${ENV_FILENAME} to .gitignore.`)}\n`,
  );

  // A model server on this machine has no key. Asking for one and accepting the empty answer
  // would work, but it would also teach people that OpenGEO wants a secret it cannot use.
  const key = endpoint.keyless
    ? ''
    : await prompter.secret(`  ${info.label} API key ${c.gray(`(hidden as you type${info.keysUrl ? `, get one at ${info.keysUrl}` : ''})`)}:`);

  if (!key && !endpoint.keyless) {
    write(`  ${c.yellow('No key entered, so nothing was written.')}\n`);
    return undefined;
  }

  const model = await prompter.ask('  Model', endpoint.model || config.ai.model || info.defaultModel);
  const vars: Record<string, string> = { [PROVIDER_VAR]: providerChoice, [MODEL_VAR]: model };
  if (key) vars[KEY_VAR] = key;
  if (endpoint.baseUrl) vars[BASE_URL_VAR] = endpoint.baseUrl;
  const envPath = writeEnvVars(root, vars);

  // The endpoint is an address, not a secret, so it also goes in the committed config where the
  // rest of the team can see which gateway this project talks to.
  const ai: OpenGeoConfig['ai'] = { provider: providerChoice, model };
  if (endpoint.baseUrl) ai.baseUrl = endpoint.baseUrl;
  if (endpoint.api) ai.api = endpoint.api;
  if (endpoint.keyless) {
    ai.auth = 'none';
    write(`  ${c.gray('No key needed for this one, so none was written.')}\n`);
  }
  return { ai, keyWritten: { provider: providerChoice, envPath, gitignore } };
}

function writeKeyLocation(write: (text: string) => void, root: string, anyKey: boolean): void {
  write(`\n${c.bold('Where your key lives')}\n`);
  write(`  ${c.gray(join(root, ENV_FILENAME))}${anyKey ? '' : c.gray('  (nothing there yet)')}\n`);
  write(`  ${c.gray('It is read from that file and sent to the provider you chose, and nowhere else. OpenGEO')}\n`);
  write(`  ${c.gray('has no telemetry, no analytics and no cloud sync, so there is nothing else to audit.')}\n`);
}

function writeAddedBots(write: (text: string) => void, addedBots: CustomBotInput[]): void {
  if (addedBots.length === 0) return;
  write(`\n${c.bold('Crawlers you added')}\n`);
  for (const bot of addedBots) {
    write(`  ${bot.name} ${c.gray(`matches any User-Agent containing ${(bot.uaPatterns ?? []).join(' or ')}`)}\n`);
  }
  write(`  ${c.gray(`Stored in bots.custom in ${CONFIG_FILENAME}. Restart your site for prod to pick them up.`)}\n`);
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  // Settings is a different shape of interaction, not a re-worded walkthrough: you arrive knowing
  // the one thing you came to change. It gets its own driver over the same four steps.
  if ((options.mode ?? 'first-run') === 'settings') return runSettings(options);

  const { root, prompter } = options;
  const write = options.out ?? ((text: string) => process.stdout.write(text));
  const existing = loadConfig(root);
  // Only reuse a config that belongs to this directory. Walking up found someone else's project.
  const hasConfig = existing.exists && existing.root === root;
  const base = hasConfig ? existing.config : defaultConfig();
  const ctx: StepContext = { root, prompter, write, settings: false, hasConfig, preview: options.preview };

  /**
   * One step announced two ways, and never both at once.
   *
   * A prompter that draws a rail is already showing "Step 2 of 4  Blocking" at the top of the frame,
   * and the underlined `2/4  Blocking` three lines below it is the same four words again. The flat
   * flow has no rail, so there the heading is the only thing saying where you are.
   */
  const step = (index: number, label: string, title: string): void => {
    prompter.stage?.(label, index, 4);
    if (!prompter.stage) write(heading(title));
  };

  write(`\n${c.bold('OpenGEO setup')}\n`);
  write(`${c.gray(root)}\n`);
  write(`${c.gray(hasConfig ? `${CONFIG_FILENAME} exists - its current values are the defaults below.` : `${CONFIG_FILENAME} will be created here.`)}\n`);
  writeIntro(write);

  // 1. Site ------------------------------------------------------------------------------------
  step(1, 'Your site', '1/4  Your site');
  write(`\n${c.gray('OpenGEO always works against a URL, never a source directory: it has to see what your')}\n`);
  write(`${c.gray('site actually serves. A local dev server is fine.')}\n\n`);
  const site = await askSiteUrl(ctx, base.site);
  const publicDir = await askWebRoot(ctx, base.publicDir);

  // 2. Bot routing -----------------------------------------------------------------------------
  step(2, 'Which agents get the twin', '2/4  Which AI agents get the Markdown twin');
  write(`\n${c.gray('This chooses a format, never access. An agent that is not on this list still sees your')}\n`);
  write(`${c.gray('normal site, exactly like a human visitor.')}\n\n`);
  const routing = await askRouting(ctx, base);
  const customBots = [...base.bots.custom, ...routing.addedBots];

  // 3. Blocking --------------------------------------------------------------------------------
  step(3, 'Blocking', '3/4  Blocking (a separate lever)');
  write(`\n${c.gray('Blocking is not the same setting as routing, and OpenGEO never turns it on for you.')}\n`);
  write(`${c.gray('It is written into robots.txt by `opengeo generate`, is advisory, and starts empty.')}\n\n`);
  // Not offered on a first run. Putting the question in front of a new user would imply OpenGEO
  // thinks they should be blocking somebody.
  write(`  ${c.gray('Nothing is blocked.')}\n`);
  write(`  ${c.gray(`Run \`opengeo settings\` if you ever want to change that.`)}\n`);
  // The one step that tells rather than asks. In scrollback that is the end of it, but a prompter
  // drawing frames would paint step 4 straight over these four lines, so it holds for a keypress.
  await prompter.pause?.();

  // 4. API key ---------------------------------------------------------------------------------
  step(4, 'AI provider', '4/4  AI provider (optional)');
  write(`\n${c.gray('Everything that matters works without one: the structural 0-100 test, the whole free')}\n`);
  write(`${c.gray('generate tier, and opengeo-prod. A key only unlocks `generate --tier ai` and')}\n`);
  write(`${c.gray('`test --content`, and it is only ever sent to the provider you pick below.')}\n\n`);
  const provider = await askProvider(ctx, base);

  // The last question is answered, so the screen goes back to whoever had it. Everything below this
  // line is output rather than interaction, and belongs in scrollback.
  prompter.settle?.();

  const createdConfig = !existsSync(join(root, CONFIG_FILENAME));
  const config: OpenGeoConfig = {
    ...base,
    site,
    publicDir,
    bots: { markdownRouting: routing.markdownRouting, blocked: base.bots.blocked, custom: customBots },
    ai: provider?.ai ?? { ...base.ai },
  };
  const configPath = saveConfig(root, config);

  write(heading('Done'));
  write('\n');
  write(`  ${c.green('ok')} ${createdConfig ? 'Created' : 'Updated'} ${relative(root, configPath) || CONFIG_FILENAME}\n`);
  write(`  ${c.green('ok')} Routing markdown to ${config.bots.markdownRouting.length} AI agent${config.bots.markdownRouting.length === 1 ? '' : 's'}\n`);
  write(`  ${c.green('ok')} Blocking ${config.bots.blocked.length === 0 ? 'nobody' : config.bots.blocked.join(', ')}\n`);
  if (provider?.keyWritten) {
    write(`  ${c.green('ok')} Wrote ${KEY_VAR} to ${relative(root, provider.keyWritten.envPath) || ENV_FILENAME}\n`);
    write(`  ${c.green('ok')} ${ENV_FILENAME} is gitignored, so the key cannot be committed\n`);
  }

  writeAddedBots(write, routing.addedBots);
  writeKeyLocation(write, root, Boolean(provider?.keyWritten) || Boolean(readCredentials(root)));

  const result: SetupResult = { root, configPath, config, createdConfig, addedBots: routing.addedBots, keyWritten: provider?.keyWritten };

  // A number beats a homework list. When the caller can run the structural test it does so here and
  // setup ends on the score the site has right now, which is also the only honest way to show what
  // the rest of OpenGEO is for. Without one, the three commands are still the best available close.
  if (options.finish) {
    await options.finish(result, write);
  } else {
    write(`\n${c.bold('Next')}\n`);
    write(`  opengeo test ${site}${c.gray('       score the page as it is today')}\n`);
    write(`  opengeo generate ${site}${c.gray('   write the twins, robots.txt, llms.txt, sitemap.xml')}\n`);
    write(`  opengeo prod test ${site}${c.gray('  once the middleware is wired in')}\n`);
    write('\n');
  }

  return result;
}

type SettingKey = 'site' | 'webroot' | 'routing' | 'blocked' | 'provider' | 'done';

/**
 * `opengeo settings` - the menu (§12).
 *
 * Deliberately not the walkthrough with different wording. Somebody running `settings` on a working
 * project arrives knowing the one thing they came to change, and making them press Enter through
 * three questions they do not care about to reach the fourth is how a settings screen teaches people
 * to edit the JSON by hand instead. So: every setting on one screen with its current value beside
 * it, pick a number, change that one thing, land back on the menu.
 *
 * Each edit is saved as it is made rather than at the end. There is no "discard" here because there
 * is nothing accumulating to discard: the menu is a list of finished actions, not a form.
 */
export async function runSettings(options: SetupOptions): Promise<SetupResult> {
  const { root, prompter } = options;
  const write = options.out ?? ((text: string) => process.stdout.write(text));
  const existing = loadConfig(root);
  const hasConfig = existing.exists && existing.root === root;
  const before = hasConfig ? existing.config : defaultConfig();
  const ctx: StepContext = { root, prompter, write, settings: true, hasConfig, preview: options.preview };

  let config: OpenGeoConfig = { ...before, bots: { ...before.bots }, ai: { ...before.ai } };
  const createdConfig = !existsSync(join(root, CONFIG_FILENAME));
  let configPath = join(root, CONFIG_FILENAME);
  const addedBots: CustomBotInput[] = [];
  let keyWritten: SetupResult['keyWritten'];
  let saved = false;

  // Before the header, so a prompter that draws a frame has these three lines as its first context
  // rather than leaving them in scrollback underneath a screen nobody can scroll to.
  prompter.stage?.('Settings', 0, 0);
  write(`\n${c.bold('OpenGEO settings')}\n`);
  write(`${c.gray(root)}\n`);
  write(`${c.gray(hasConfig ? `${CONFIG_FILENAME} - pick a number to change that one setting.` : `${CONFIG_FILENAME} does not exist yet. Changing anything here creates it.`)}\n`);

  for (;;) {
    const found = readCredentials(root);
    const choice = await prompter.choose<SettingKey>(`\n${c.bold('  Settings')}`, menuOptions(config, found?.provider), 'done');
    if (choice === 'done') break;

    write('\n');
    // Zero steps, so a prompter that draws a rail draws the label alone: settings is a menu you
    // return to, not a sequence you are partway through. The name tracks whatever is being edited.
    prompter.stage?.(menuLabel(choice), 0, 0);
    if (choice === 'site') {
      config = { ...config, site: await askSiteUrl(ctx, config.site) };
    } else if (choice === 'webroot') {
      config = { ...config, publicDir: await askWebRoot(ctx, config.publicDir) };
    } else if (choice === 'routing') {
      write(`  ${c.gray('This chooses a format, never access. Agents not on the list see your normal site.')}\n\n`);
      const routing = await askRouting(ctx, config);
      addedBots.push(...routing.addedBots);
      config = {
        ...config,
        bots: { ...config.bots, markdownRouting: routing.markdownRouting, custom: [...config.bots.custom, ...routing.addedBots] },
      };
    } else if (choice === 'blocked') {
      write(`  ${c.gray('A separate lever from routing. It is advisory, and only ever reaches robots.txt.')}\n\n`);
      config = { ...config, bots: { ...config.bots, blocked: await askBlocked(ctx, config) } };
    } else {
      write(`  ${c.gray('Only `generate --tier ai` and `test --content` need this. Everything else works without a key.')}\n\n`);
      const provider = await askProvider(ctx, config);
      if (provider) {
        config = { ...config, ai: provider.ai };
        keyWritten = provider.keyWritten;
      }
    }

    configPath = saveConfig(root, config);
    saved = true;
    // Back to the menu, and the confirmation is the first thing on that frame rather than the last
    // thing on the one being replaced, which is a frame nobody ever sees.
    prompter.stage?.('Settings', 0, 0);
    write(`\n  ${c.green('saved')} ${c.gray(relative(root, configPath) || CONFIG_FILENAME)}\n`);
  }

  prompter.settle?.();

  write(heading('Saved'));
  write('\n');
  for (const line of describeChanges(before, config, keyWritten)) write(`  ${line}\n`);
  if (saved) write(`  ${c.gray(`${relative(root, configPath) || CONFIG_FILENAME} written.`)}\n`);

  writeAddedBots(write, addedBots);
  writeKeyLocation(write, root, Boolean(keyWritten) || Boolean(readCredentials(root)));
  write('\n');

  return { root, configPath, config, createdConfig: createdConfig && saved, addedBots, keyWritten };
}

/** What the frame is called while one setting is being edited. */
function menuLabel(choice: Exclude<SettingKey, 'done'>): string {
  const labels: Record<Exclude<SettingKey, 'done'>, string> = {
    site: 'Site URL',
    webroot: 'Web root',
    routing: 'Markdown routing',
    blocked: 'Blocked crawlers',
    provider: 'AI provider',
  };
  return labels[choice];
}

/** The menu itself: every setting on one screen, with what it is set to right now beside it. */
function menuOptions(config: OpenGeoConfig, keyProvider: string | undefined): Array<{ value: SettingKey; label: string; note?: string }> {
  const label = (name: string, value: string) => `${name.padEnd(20)}${c.gray(value)}`;
  const model = config.ai.model ? ` ${config.ai.model}` : '';
  const key = keyProvider ? `key in ${ENV_FILENAME}` : 'no key configured';
  return [
    { value: 'site', label: label('Site URL', config.site) },
    { value: 'webroot', label: label('Web root', config.publicDir) },
    {
      value: 'routing',
      label: label('Markdown routing', `${config.bots.markdownRouting.length} agent${config.bots.markdownRouting.length === 1 ? '' : 's'}`),
    },
    { value: 'blocked', label: label('Blocked crawlers', describeList(config.bots.blocked)) },
    { value: 'provider', label: label('AI provider', `${config.ai.provider}${model}, ${key}`) },
    { value: 'done', label: 'Done' },
  ];
}

/** The one line under a provider in the picker: what it costs you to choose it. */
function providerNote(id: AiProvider): string {
  const info = providerInfo(id);
  if (info.userDefined) return 'Any endpoint speaking the OpenAI, Anthropic or Gemini API. You give the URL.';
  if (info.keyless) return `Runs on this machine at ${info.baseUrl}. No key, no account, nothing sent off the box.`;
  return `${info.defaultModel}${info.keysUrl ? `  -  keys: ${info.keysUrl}` : ''}`;
}

interface EndpointAnswer {
  baseUrl?: string;
  api?: ProviderApi;
  model?: string;
  keyless: boolean;
}

/**
 * The sub-flow for a provider OpenGEO does not ship with, and the escape hatch for one it does.
 *
 * A built-in provider answers this in zero questions. `custom` needs three, and they are asked in
 * the order somebody reading their gateway's docs would find them: the URL, the wire format, then
 * the model id. Getting the wire format wrong is the failure that produces the most confusing HTTP
 * error, so it is a pick list rather than free text.
 */
async function askEndpoint(
  prompter: Prompter,
  write: (text: string) => void,
  provider: AiProvider,
  base: OpenGeoConfig,
): Promise<EndpointAnswer | undefined> {
  const info = providerInfo(provider);
  if (!info.userDefined) return { keyless: Boolean(info.keyless) };

  write(`\n  ${c.gray('OpenGEO talks to any endpoint speaking one of three API shapes. Point it at yours.')}\n\n`);
  const baseUrl = (await prompter.ask('  Base URL (no trailing slash)', base.ai.baseUrl ?? '')).trim();
  if (!baseUrl) return undefined;
  if (!parseUrl(baseUrl)) {
    write(`  ${c.yellow(`"${baseUrl}" is not a URL OpenGEO can call. Include the scheme, e.g. https://gateway.example.com/v1.`)}\n`);
    return undefined;
  }

  const api = await prompter.choose<ProviderApi>(
    '  Which API shape does it speak?',
    [
      { value: 'openai', label: 'OpenAI-compatible', note: 'It has POST /chat/completions. Almost everything does.' },
      { value: 'anthropic', label: 'Anthropic', note: 'POST /messages, with an x-api-key header.' },
      { value: 'gemini', label: 'Gemini', note: 'POST /models/<model>:generateContent.' },
    ],
    base.ai.api ?? 'openai',
  );

  const model = (await prompter.ask('  Model id your endpoint expects', base.ai.model || '')).trim();
  const keyless = await prompter.confirm('  Does it run without a key?', false);
  return { baseUrl, api, model, keyless };
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
