import { join } from 'node:path';
import { resolveBots, resolveRoutableBots } from '../shared/bots.js';
import { CONFIG_FILENAME, defaultConfig, projectDirProblem } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { PROVIDERS, providerInfo } from '../shared/providers.js';
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
import { c } from '../shared/log.js';
import { pickBots } from './bot-picker.js';
import { detectWebRoot } from '../shared/site-probe.js';
import { previewLines } from './setup-preview.js';

/**
 * @import { CustomBotInput } from '../shared/bots.js'
 * @import { OpenGeoConfig } from '../shared/config.js'
 * @import { AiProvider, ProviderApi } from '../shared/providers.js'
 * @import { GitignoreResult } from '../shared/env.js'
 * @import { Prompter } from './prompt.js'
 * @import { SitePreview, WebRootGuess } from '../shared/site-probe.js'
 */

/**
 * The steps `runSetup` and `runSettings` both ask, and the shapes they pass between them.
 *
 * Each step is one question with its own validation, so the walkthrough and the menu can put
 * them in different orders without either owning them.
 */

const MAX_URL_ATTEMPTS = 5;

/** @typedef {'first-run' | 'settings'} SetupMode */

/** A setup that stopped on purpose. The message is already user-facing; the CLI just prints it. */
export class SetupAbort extends Error {}

/**
 * The prompter that reports a cancel cannot know what this run had already written, so its "Nothing
 * was written." is corrected here, where that is known.
 *
 * @param {unknown} error
 * @param {string[]} written
 * @returns {unknown}
 */
export function abortAfterWrites(error, written) {
  if (!(error instanceof SetupAbort) || written.length === 0) return error;
  return new SetupAbort(`${error.message.replace(/\s*Nothing was written\.$/, '')} ${ERRORS.stoppedAfterWriting(written)}`);
}

/**
 * @typedef {object} SetupOptions
 * @property {string} root
 * @property {Prompter} prompter
 * @property {SetupMode} [mode] Defaults to first-run. `settings` re-frames the same questions as edits
 *   (§12).
 * @property {(text: string) => void} [out] Where the flow narrates itself. Injected so the whole thing
 *   is testable without a terminal.
 * @property {(url: string) => Promise<SitePreview | undefined>} [preview] Fetches the site URL as it is
 *   entered, so the answer can be checked while it is still cheap to change. Injected rather than
 *   imported, because configure.js should not decide on every caller's behalf that setup makes a
 *   network request: the CLI passes `previewSite`, tests pass a stub, and a caller that wants four
 *   silent questions passes nothing and gets exactly what it always got.
 * @property {(result: SetupResult, write: (text: string) => void) => Promise<void>} [finish] Runs after
 *   the config is saved, to end setup on a real number instead of three commands to go and try.
 *   Injected for the same reason and one more: `test` pulls in jsdom and the AI providers, and
 *   configure.js is imported by packages that ship neither.
 */

/**
 * @typedef {object} SetupResult
 * @property {string} root
 * @property {string} configPath
 * @property {OpenGeoConfig} config
 * @property {boolean} createdConfig
 * @property {CustomBotInput[]} addedBots Crawlers the user defined during this run, already merged into
 *   `config.bots.custom`.
 * @property {{ provider: AiProvider; envPath: string; gitignore: GitignoreResult }} [keyWritten] Set
 *   only when a key was actually written, which is also the only time .gitignore is touched.
 */

/** @typedef {'all' | 'assistants' | 'none' | 'custom'} RoutingChoice */

/**
 * Everything a step needs to ask its question. Passed around so the steps stay independent.
 *
 * @typedef {object} StepContext
 * @property {string} root
 * @property {Prompter} prompter
 * @property {(text: string) => void} write
 * @property {boolean} settings Framing only. In settings mode every default is the current value, never
 *   a recommendation.
 * @property {boolean} hasConfig
 * @property {SetupOptions['preview']} [preview]
 * @property {string[]} written Files this run has already changed, so a cancel can say so.
 */

/**
 * @param {StepContext} ctx
 * @param {string} current
 * @returns {Promise<string>}
 */
export async function askSiteUrl(ctx, current) {
  // Bounded, because a prompter whose input has ended answers every question the same way and an
  // unbounded retry loop would spin forever on it.
  for (let attempt = 1; ; attempt += 1) {
    const answer = await ctx.prompter.ask('  Site URL', current);
    if (parseUrl(answer)) {
      await reportSite(ctx, answer);
      return answer;
    }
    if (attempt >= MAX_URL_ATTEMPTS) {
      throw new SetupAbort(ERRORS.setupUrlGaveUp(answer));
    }
    ctx.write(`  ${c.yellow(ERRORS.setupUrlRefused(answer))}\n`);
  }
}

/**
 * What is actually at that URL, said out loud before the next question.
 *
 * Never a gate. A site that is not running yet is a completely normal thing to be setting OpenGEO up
 * against, and refusing the URL over it would be wrong. The probe is here so that a typo, a wrong
 * port or a client-rendered page is visible now rather than three commands later.
 *
 * @param {StepContext} ctx
 * @param {string} url
 * @returns {Promise<void>}
 */
async function reportSite(ctx, url) {
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
 *
 * @param {StepContext} ctx
 * @param {string} current
 * @returns {Promise<string>}
 */
export async function askWebRoot(ctx, current) {
  // `current` on a project with no config of its own is `defaultConfig().publicDir`, which nobody
  // typed, so the detector is free to replace it. Once opengeo.config.json exists the same string
  // is an answer somebody gave, and a guess about a convention does not get to overrule that.
  const configured = ctx.hasConfig ? current : '';
  /** @type {WebRootGuess} */
  const guess = detectWebRoot(ctx.root);
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

/**
 * @param {string} root
 * @param {string} publicDir
 * @returns {string | undefined}
 */
function webRootProblem(root, publicDir) {
  return projectDirProblem(root, { publicDir, internalDir: defaultConfig().internalDir });
}

/**
 * @typedef {object} RoutingAnswer
 * @property {string[]} markdownRouting
 * @property {CustomBotInput[]} addedBots
 */

/**
 * @param {StepContext} ctx
 * @param {OpenGeoConfig} config
 * @returns {Promise<RoutingAnswer>}
 */
export async function askRouting(ctx, config) {
  const routableBots = resolveRoutableBots(config.bots.custom);
  const everyone = routableBots.map((bot) => bot.name);
  const assistantsAndSearch = routableBots.filter((bot) => bot.kind !== 'training').map((bot) => bot.name);

  const routingChoice = await ctx.prompter.choose(
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

/**
 * @param {StepContext} ctx
 * @param {OpenGeoConfig} config
 * @returns {Promise<string[]>}
 */
export async function askBlocked(ctx, config) {
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

/**
 * @typedef {object} ProviderAnswer
 * @property {OpenGeoConfig['ai']} ai
 * @property {SetupResult['keyWritten']} [keyWritten]
 */

/**
 * Step 4, and the only step that writes a file of its own.
 *
 * Returns undefined when nothing should change, which covers three different answers: "skip",
 * an endpoint the user did not finish giving, and an empty key. None of them should overwrite what
 * is already configured.
 *
 * @param {StepContext} ctx
 * @param {OpenGeoConfig} config
 * @returns {Promise<ProviderAnswer | undefined>}
 */
export async function askProvider(ctx, config) {
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
  const providerChoice = await prompter.choose(
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
    /** @type {AiProvider | 'skip'} */ ('skip'),
  );
  if (providerChoice === 'skip') return undefined;

  const info = providerInfo(providerChoice);
  const endpoint = await askEndpoint(prompter, write, providerChoice, config);
  if (!endpoint) {
    write(`  ${c.yellow(ERRORS.noEndpointGiven)}\n`);
    return undefined;
  }

  // The gitignore line goes in before the key does. Never the other way round.
  const gitignore = ensureEnvGitignored(root);
  if (!gitignore.alreadyPresent && !ctx.written.includes('.gitignore')) ctx.written.push('.gitignore');
  write(
    `\n  ${gitignore.alreadyPresent ? c.gray(`${ENV_FILENAME} is already in .gitignore.`) : c.green(`Added ${ENV_FILENAME} to .gitignore.`)}\n`,
  );

  // A model server on this machine has no key. Asking for one and accepting the empty answer
  // would work, but it would also teach people that OpenGEO wants a secret it cannot use.
  const key = endpoint.keyless
    ? ''
    : await prompter.secret(`  ${info.label} API key ${c.gray(`(hidden as you type${info.keysUrl ? `, get one at ${info.keysUrl}` : ''})`)}:`);

  if (!key && !endpoint.keyless) {
    write(`  ${c.yellow(ERRORS.noKeyEntered)}\n`);
    return undefined;
  }

  // The configured model is only a sensible default when it belongs to the provider just picked.
  const sameProvider = config.ai.provider === providerChoice;
  const model = await prompter.ask('  Model', endpoint.model || (sameProvider ? config.ai.model : undefined) || info.defaultModel);
  // No base URL means none, not "keep the last one": a gateway left in .env would get this key.
  /** @type {Record<string, string | undefined>} */
  const vars = {
    [PROVIDER_VAR]: providerChoice,
    [MODEL_VAR]: model,
    [BASE_URL_VAR]: endpoint.baseUrl || undefined,
  };
  if (key) vars[KEY_VAR] = key;
  const envPath = writeEnvVars(root, vars);

  // The endpoint is an address, not a secret, so it also goes in the committed config where the
  // rest of the team can see which gateway this project talks to.
  /** @type {OpenGeoConfig['ai']} */
  const ai = { provider: providerChoice, model };
  if (endpoint.baseUrl) ai.baseUrl = endpoint.baseUrl;
  if (endpoint.api) ai.api = endpoint.api;
  if (endpoint.keyless) {
    ai.auth = 'none';
    write(`  ${c.gray('No key needed for this one, so none was written.')}\n`);
  }
  return { ai, keyWritten: { provider: providerChoice, envPath, gitignore } };
}

/**
 * @param {(text: string) => void} write
 * @param {string} root
 * @param {boolean} anyKey
 * @returns {void}
 */
export function writeKeyLocation(write, root, anyKey) {
  write(`\n${c.bold('Where your key lives')}\n`);
  write(`  ${c.gray(join(root, ENV_FILENAME))}${anyKey ? '' : c.gray('  (nothing there yet)')}\n`);
  write(`  ${c.gray('It is read from that file and sent to the provider you chose, and nowhere else. OpenGEO')}\n`);
  write(`  ${c.gray('has no telemetry, no analytics and no cloud sync, so there is nothing else to audit.')}\n`);
}

/**
 * @param {(text: string) => void} write
 * @param {CustomBotInput[]} addedBots
 * @returns {void}
 */
export function writeAddedBots(write, addedBots) {
  if (addedBots.length === 0) return;
  write(`\n${c.bold('Crawlers you added')}\n`);
  for (const bot of addedBots) {
    write(`  ${bot.name} ${c.gray(`matches any User-Agent containing ${(bot.uaPatterns ?? []).join(' or ')}`)}\n`);
  }
  write(`  ${c.gray(`Stored in bots.custom in ${CONFIG_FILENAME}. Restart your site for prod to pick them up.`)}\n`);
}

/**
 * The one line under a provider in the picker: what it costs you to choose it.
 *
 * @param {AiProvider} id
 * @returns {string}
 */
function providerNote(id) {
  const info = providerInfo(id);
  if (info.userDefined) return 'Any endpoint speaking the OpenAI, Anthropic or Gemini API. You give the URL.';
  if (info.keyless) return `Runs on this machine at ${info.baseUrl}. No key, no account, nothing sent off the box.`;
  return `${info.defaultModel}${info.keysUrl ? `  -  keys: ${info.keysUrl}` : ''}`;
}

/**
 * @typedef {object} EndpointAnswer
 * @property {string} [baseUrl]
 * @property {ProviderApi} [api]
 * @property {string} [model]
 * @property {boolean} keyless
 */

/**
 * The sub-flow for a provider OpenGEO does not ship with, and the escape hatch for one it does.
 *
 * A built-in provider answers this in zero questions. `custom` needs three, and they are asked in
 * the order somebody reading their gateway's docs would find them: the URL, the wire format, then
 * the model id. Getting the wire format wrong is the failure that produces the most confusing HTTP
 * error, so it is a pick list rather than free text.
 *
 * @param {Prompter} prompter
 * @param {(text: string) => void} write
 * @param {AiProvider} provider
 * @param {OpenGeoConfig} base
 * @returns {Promise<EndpointAnswer | undefined>}
 */
async function askEndpoint(prompter, write, provider, base) {
  const info = providerInfo(provider);
  if (!info.userDefined) return { keyless: Boolean(info.keyless) };

  write(`\n  ${c.gray('OpenGEO talks to any endpoint speaking one of three API shapes. Point it at yours.')}\n\n`);
  const baseUrl = (await prompter.ask('  Base URL (no trailing slash)', base.ai.baseUrl ?? '')).trim();
  if (!baseUrl) return undefined;
  if (!parseUrl(baseUrl)) {
    write(`  ${c.yellow(ERRORS.endpointNotUrl(baseUrl))}\n`);
    return undefined;
  }

  const api = await prompter.choose(
    '  Which API shape does it speak?',
    [
      { value: 'openai', label: 'OpenAI-compatible', note: 'It has POST /chat/completions. Almost everything does.' },
      { value: 'anthropic', label: 'Anthropic', note: 'POST /messages, with an x-api-key header.' },
      { value: 'gemini', label: 'Gemini', note: 'POST /models/<model>:generateContent.' },
    ],
    /** @type {ProviderApi} */ (base.ai.api ?? 'openai'),
  );

  const own = base.ai.provider === provider ? base.ai.model : '';
  const model = (await prompter.ask('  Model id your endpoint expects', own || '')).trim();
  const keyless = await prompter.confirm('  Does it run without a key?', false);
  return { baseUrl, api, model, keyless };
}

/**
 * Which of the four answers describes the routing a project already has.
 *
 * On a first run the answer is always `all`, because that is OpenGEO's recommendation rather than a
 * report of anything. In settings mode the default has to be whatever is currently true, or pressing
 * Enter through the flow would quietly widen a list the user had deliberately narrowed.
 *
 * @param {readonly string[]} routing
 * @param {readonly string[]} everyone
 * @param {readonly string[]} assistantsAndSearch
 * @param {boolean} settings
 * @returns {RoutingChoice}
 */
function currentRoutingChoice(routing, everyone, assistantsAndSearch, settings) {
  if (!settings) return 'all';
  if (sameNames(routing, everyone)) return 'all';
  if (routing.length === 0) return 'none';
  if (sameNames(routing, assistantsAndSearch)) return 'assistants';
  return 'custom';
}

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
export function sameNames(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].map((name) => name.toLowerCase()).sort();
  const right = [...b].map((name) => name.toLowerCase()).sort();
  return left.every((name, index) => name === right[index]);
}
