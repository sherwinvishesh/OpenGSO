import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_FILENAME, defaultConfig, loadConfig, saveConfig } from '../shared/config.js';
import { ENV_FILENAME, readCredentials } from '../shared/env.js';
import { c, heading } from '../shared/log.js';
import {
  SetupAbort,
  abortAfterWrites,
  askSiteUrl,
  askWebRoot,
  askRouting,
  askBlocked,
  askProvider,
  keyHeld,
  writeKeyLocation,
  writeAddedBots,
  writeSearchCrawlerWarning,
  sameNames,
} from './configure-steps.js';

/**
 * @import { CustomBotInput } from '../shared/bots.js'
 * @import { OmniGeoConfig } from '../shared/config.js'
 * @import { Credentials } from '../shared/env.js'
 * @import { SetupOptions, SetupResult, StepContext } from './configure-steps.js'
 */

/**
 * `omnigeo settings`: the menu over the same steps the walkthrough asks in order.
 */

/** @typedef {'site' | 'webroot' | 'routing' | 'blocked' | 'provider' | 'done'} SettingKey */

/**
 * `omnigeo settings` - the menu (§12).
 *
 * Deliberately not the walkthrough with different wording. Somebody running `settings` on a working
 * project arrives knowing the one thing they came to change, and making them press Enter through
 * three questions they do not care about to reach the fourth is how a settings screen teaches people
 * to edit the JSON by hand instead. So: every setting on one screen with its current value beside
 * it, pick a number, change that one thing, land back on the menu.
 *
 * Each edit is saved as it is made rather than at the end. There is no "discard" here because there
 * is nothing accumulating to discard: the menu is a list of finished actions, not a form.
 *
 * @param {SetupOptions} options
 * @returns {Promise<SetupResult>}
 */
export async function runSettings(options) {
  const { root, prompter } = options;
  const write = options.out ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const existing = loadConfig(root);
  const hasConfig = existing.exists && existing.root === root;
  const before = hasConfig ? existing.config : defaultConfig();
  /** @type {StepContext} */
  const ctx = { root, prompter, write, settings: true, hasConfig, preview: options.preview, written: [] };

  /** @type {OmniGeoConfig} */
  let config = { ...before, bots: { ...before.bots }, ai: { ...before.ai } };
  const createdConfig = !existsSync(join(root, CONFIG_FILENAME));
  let configPath = join(root, CONFIG_FILENAME);
  /** @type {CustomBotInput[]} */
  const addedBots = [];
  /** @type {SetupResult['keyWritten']} */
  let keyWritten;
  let saved = false;

  // Before the header, so a prompter that draws a frame has these three lines as its first context
  // rather than leaving them in scrollback underneath a screen nobody can scroll to.
  prompter.stage?.('Settings', 0, 0);
  write(`\n${c.bold('OmniGEO settings')}\n`);
  write(`${c.gray(root)}\n`);
  write(`${c.gray(hasConfig ? `${CONFIG_FILENAME} - pick a number to change that one setting.` : `${CONFIG_FILENAME} does not exist yet. Changing anything here creates it.`)}\n`);
  // On opening, because a project set up before the presets left search engines out may be
  // routing them without anyone having chosen to.
  writeSearchCrawlerWarning(write, config.bots);

  for (;;) {
    const found = readCredentials(root, config.ai);
    /** @type {SettingKey} */
    let choice;
    try {
      choice = await prompter.choose(`\n${c.bold('  Settings')}`, menuOptions(config, found), /** @type {SettingKey} */ ('done'));
    } catch (error) {
      // Every edit was saved as it was made, so leaving the menu is Done whichever key does it.
      if (error instanceof SetupAbort) break;
      throw error;
    }
    if (choice === 'done') break;

    write('\n');
    // Zero steps, so a prompter that draws a rail draws the label alone: settings is a menu you
    // return to, not a sequence you are partway through. The name tracks whatever is being edited.
    prompter.stage?.(menuLabel(choice), 0, 0);
    try {
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
          if (!ctx.written.includes(ENV_FILENAME)) ctx.written.push(ENV_FILENAME);
        }
      }
    } catch (error) {
      throw abortAfterWrites(error, ctx.written);
    }

    configPath = saveConfig(root, config);
    saved = true;
    const savedAs = relative(root, configPath) || CONFIG_FILENAME;
    if (!ctx.written.includes(savedAs)) ctx.written.push(savedAs);
    // Back to the menu, and the confirmation is the first thing on that frame rather than the last
    // thing on the one being replaced, which is a frame nobody ever sees.
    prompter.stage?.('Settings', 0, 0);
    write(`\n  ${c.green('saved')} ${c.gray(relative(root, configPath) || CONFIG_FILENAME)}\n`);
    if (choice === 'routing') writeSearchCrawlerWarning(write, config.bots);
  }

  prompter.settle?.();

  write(heading('Saved'));
  write('\n');
  const changes = describeChanges(before, config, keyWritten);
  if (changes.length === 0) write(`  ${c.gray('Nothing changed. Every answer matched what was already there.')}\n`);
  for (const line of changes) write(`  ${line}\n`);
  // A setting saved back to the value it started at rewrites the file, but saying so under
  // "Nothing changed" would read as a contradiction.
  if (saved && changes.length > 0) write(`  ${c.gray(`${relative(root, configPath) || CONFIG_FILENAME} written.`)}\n`);

  writeAddedBots(write, addedBots);
  writeKeyLocation(write, root, keyHeld(root, config.ai));
  write('\n');

  return { root, configPath, config, createdConfig: createdConfig && saved, addedBots, keyWritten };
}

/**
 * What the frame is called while one setting is being edited.
 *
 * @param {Exclude<SettingKey, 'done'>} choice
 * @returns {string}
 */
function menuLabel(choice) {
  /** @type {Record<Exclude<SettingKey, 'done'>, string>} */
  const labels = {
    site: 'Site URL',
    webroot: 'Web root',
    routing: 'Markdown routing',
    blocked: 'Blocked crawlers',
    provider: 'AI provider',
  };
  return labels[choice];
}

/**
 * The menu itself: every setting on one screen, with what it is set to right now beside it.
 *
 * @param {OmniGeoConfig} config
 * @param {Credentials | undefined} found
 * @returns {Array<{ value: SettingKey; label: string; note?: string }>}
 */
function menuOptions(config, found) {
  /**
   * @param {string} name
   * @param {string} value
   */
  const label = (name, value) => `${name.padEnd(20)}${c.gray(value)}`;
  const model = config.ai.model ? ` ${config.ai.model}` : '';
  // A key for another provider is never sent to this one, so calling it "the key" would be wrong.
  const key = !found
    ? 'no key configured'
    : found.provider !== config.ai.provider
      ? `only key is for ${found.provider}`
      : found.keyless
        ? 'no key needed'
        : `key in ${ENV_FILENAME}`;
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

/**
 * What settings mode prints instead of a tutorial: the diff, and nothing when there is not one.
 *
 * @param {OmniGeoConfig} before
 * @param {OmniGeoConfig} after
 * @param {SetupResult['keyWritten']} keyWritten
 * @returns {string[]}
 */
function describeChanges(before, after, keyWritten) {
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {string} label
   * @param {string} from
   * @param {string} to
   */
  const changed = (label, from, to) => {
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
  changed('AI provider', describeAi(before.ai), describeAi(after.ai));
  // A model server on this machine is saved through the same step but has no key to write.
  if (keyWritten && after.ai.auth !== 'none') {
    lines.push(`${c.green('changed')} API key ${c.gray(`written to ${ENV_FILENAME}, which is gitignored`)}`);
  }
  return lines;
}

/**
 * @param {OmniGeoConfig['ai']} ai
 * @returns {string}
 */
function describeAi(ai) {
  return [ai.provider, ai.model, ai.baseUrl ? `at ${ai.baseUrl}` : ''].filter(Boolean).join(' ');
}

/**
 * @param {readonly string[]} names
 * @returns {string}
 */
function describeList(names) {
  return names.length === 0 ? 'nobody' : names.join(', ');
}
