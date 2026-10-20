import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_FILENAME, defaultConfig, loadConfig, saveConfig } from '../shared/config.js';
import { ENV_FILENAME, KEY_VAR } from '../shared/env.js';
import { c, heading } from '../shared/log.js';
import {
  abortAfterWrites,
  askSiteUrl,
  askWebRoot,
  askRouting,
  writeSearchCrawlerWarning,
  askProvider,
  keyHeld,
  writeKeyLocation,
  writeAddedBots,
} from './configure-steps.js';
import { runSettings } from './configure-settings.js';

/**
 * @import { OpenGeoConfig } from '../shared/config.js'
 * @import { StepContext } from './configure-steps.js'
 */

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

// The steps and the settings menu live beside this walkthrough; re-exported for the callers
// that already import them from here.
export { SetupAbort } from './configure-steps.js';
export { runSettings } from './configure-settings.js';
/**
 * @typedef {import('./configure-steps.js').SetupMode} SetupMode
 * @typedef {import('./configure-steps.js').SetupOptions} SetupOptions
 * @typedef {import('./configure-steps.js').SetupResult} SetupResult
 */

/**
 * Which of the two a directory should get, asked the same way by every caller.
 *
 * Only a config that belongs to *this* directory counts. `loadConfig` walks up, which is right for
 * running a command from a subdirectory and wrong here: finding somebody else's project two levels
 * up and silently editing it is a surprise, and inheriting their answers as defaults is worse. A
 * directory with nothing of its own is being set up, so it gets the walkthrough.
 *
 * @param {string} root
 * @returns {SetupMode}
 */
export function setupMode(root) {
  const found = loadConfig(root);
  return found.exists && found.root === root ? 'settings' : 'first-run';
}

/**
 * What OpenGEO is, in the six lines somebody who just typed `opengeo` will actually read.
 *
 * A bare `opengeo` lands here, so this is the product's first screen for most people. It says what
 * the problem is before it says what the tool does, because "Markdown twin" means nothing until you
 * have been told that agents are reading HTML written for browsers and getting it wrong.
 *
 * @param {(text: string) => void} write
 * @returns {void}
 */
function writeIntro(write) {
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

/**
 * @param {SetupOptions} options
 * @returns {Promise<SetupResult>}
 */
export async function runSetup(options) {
  // Settings is a different shape of interaction, not a re-worded walkthrough: you arrive knowing
  // the one thing you came to change. It gets its own driver over the same four steps.
  if ((options.mode ?? 'first-run') === 'settings') return runSettings(options);

  const { root, prompter } = options;
  const write = options.out ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const existing = loadConfig(root);
  // Only reuse a config that belongs to this directory. Walking up found someone else's project.
  const hasConfig = existing.exists && existing.root === root;
  const base = hasConfig ? existing.config : defaultConfig();
  /** @type {StepContext} */
  const ctx = { root, prompter, write, settings: false, hasConfig, preview: options.preview, written: [] };

  /**
   * One step announced two ways, and never both at once.
   *
   * A prompter that draws a rail is already showing "Step 2 of 4  Blocking" at the top of the frame,
   * and the underlined `2/4  Blocking` three lines below it is the same four words again. The flat
   * flow has no rail, so there the heading is the only thing saying where you are.
   *
   * @param {number} index
   * @param {string} label
   * @param {string} title
   * @returns {void}
   */
  const step = (index, label, title) => {
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
  // The only step that writes before the config is saved: .gitignore goes in ahead of the key.
  const provider = await askProvider(ctx, base).catch((error) => {
    throw abortAfterWrites(error, ctx.written);
  });

  // The last question is answered, so the screen goes back to whoever had it. Everything below this
  // line is output rather than interaction, and belongs in scrollback.
  prompter.settle?.();

  const createdConfig = !existsSync(join(root, CONFIG_FILENAME));
  /** @type {OpenGeoConfig} */
  const config = {
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
  // Only a list picked by hand can trigger it: neither canned answer includes a search engine.
  writeSearchCrawlerWarning(write, config.bots);
  write(`  ${c.green('ok')} Blocking ${config.bots.blocked.length === 0 ? 'nobody' : config.bots.blocked.join(', ')}\n`);
  if (provider?.keyWritten && provider.ai.auth === 'none') {
    write(`  ${c.green('ok')} Using ${provider.ai.provider} ${provider.ai.model}, which needs no key\n`);
  } else if (provider?.keyWritten) {
    write(`  ${c.green('ok')} Wrote ${KEY_VAR} to ${relative(root, provider.keyWritten.envPath) || ENV_FILENAME}\n`);
    write(`  ${c.green('ok')} ${ENV_FILENAME} is gitignored, so the key cannot be committed\n`);
  }

  writeAddedBots(write, routing.addedBots);
  writeKeyLocation(write, root, keyHeld(root, config.ai));

  /** @type {SetupResult} */
  const result = { root, configPath, config, createdConfig, addedBots: routing.addedBots, keyWritten: provider?.keyWritten };

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
