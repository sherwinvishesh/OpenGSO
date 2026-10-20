import { BOT_KINDS, normalizeCustomBot } from '../shared/bots.js';
import { ERRORS } from '../shared/errors.js';
import { c } from '../shared/log.js';

/**
 * @import { AiBot, BotKind, CustomBotInput } from '../shared/bots.js'
 * @import { Prompter } from './prompt.js'
 */

/**
 * The by-hand crawler picker behind the `custom` option in `opengso start` and `opengso settings`.
 *
 * The three canned answers (every agent, assistants only, nobody) cover almost every project, so
 * this exists for the two cases they cannot: a site that wants a specific handful of agents, and a
 * site whose crawler is not in OpenGSO's list at all - an in-house agent, or an AI product newer
 * than the installed version. Adding one here writes it into `bots.custom` in the config, which is
 * the same list prod reads at boot, so a crawler added at this prompt is routable immediately.
 *
 * A number toggles, so does a name, and a blank line finishes. Names are matched case-insensitively
 * against both the bot name and its robots.txt token, because "gptbot" is what a person types.
 */

/**
 * @typedef {object} BotPickerOptions
 * @property {Prompter} prompter
 * @property {(text: string) => void} out
 * @property {readonly AiBot[]} bots The full list to choose from, built-ins plus any custom crawlers
 *   already in the config.
 * @property {readonly string[]} selected Names selected when the picker opens.
 * @property {string} verb Wording differs between "who gets markdown" and "who gets disallowed in
 *   robots.txt".
 * @property {boolean} routableOnly When false, robots.txt-only tokens are hidden: they can never be
 *   routed by User-Agent.
 * @property {boolean} allowAdd Blocking is a robots.txt list, and inventing a crawler for it makes no
 *   sense.
 */

/**
 * @typedef {object} BotPickerResult
 * @property {string[]} selected Names the user ended up with, in the order the list presents them.
 * @property {CustomBotInput[]} added Crawlers defined during this session, ready to be merged into
 *   `bots.custom`.
 */

/**
 * A hard ceiling on the loop. Every prompt answers with its default once the input stream ends, and
 * "" means done here, so EOF already exits - this is the belt to that braces.
 */
const MAX_ROUNDS = 500;

/**
 * @param {BotPickerOptions} options
 * @returns {Promise<BotPickerResult>}
 */
export async function pickBots(options) {
  const { prompter, out, verb } = options;
  const catalogue = [...options.bots];
  /** @type {CustomBotInput[]} */
  const added = [];
  /** @param {string} name */
  const canonical = (name) => catalogue.find((bot) => bot.name.toLowerCase() === name.toLowerCase())?.name;
  const chosen = new Set(options.selected.map(canonical).filter(/** @returns {name is string} */ (name) => Boolean(name)));
  // A name in the config that matches nothing on the list is left exactly as it was found. It is
  // far more likely to be a crawler this version has not heard of than a mistake to clean up.
  const unrecognised = options.selected.filter((name) => !canonical(name));

  const visible = () => catalogue.filter((bot) => !options.routableOnly || bot.uaPatterns.length > 0);

  render(out, visible(), chosen, options);

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const answer = (await prompter.ask(`  ${verb} ${c.gray('(name, number, all, none, add, or Enter to finish)')}`)).trim();
    if (!answer) break;

    const list = visible();
    const word = answer.toLowerCase();

    if (word === 'done' || word === 'q' || word === 'quit') break;

    if (word === 'all') {
      for (const bot of list) chosen.add(bot.name);
      render(out, list, chosen, options);
      continue;
    }
    if (word === 'none') {
      chosen.clear();
      render(out, list, chosen, options);
      continue;
    }
    if (word === 'list' || word === 'show') {
      render(out, list, chosen, options);
      continue;
    }
    if (word === 'add' || word === 'new' || word === '+') {
      if (!options.allowAdd) {
        out(`  ${c.yellow(ERRORS.crawlerAddRoutingOnly)}\n`);
        continue;
      }
      const bot = await addCustomBot(prompter, out, catalogue);
      if (bot) {
        catalogue.push(bot);
        added.push({
          name: bot.name,
          vendor: bot.vendor,
          uaPatterns: bot.uaPatterns,
          robotsToken: bot.robotsToken,
          kind: bot.kind,
        });
        chosen.add(bot.name);
        out(`  ${c.green('added')} ${bot.name}, matching any User-Agent containing ${bot.uaPatterns.join(' or ')}.\n`);
        render(out, visible(), chosen, options);
      }
      continue;
    }

    // One line can carry several answers, because "1 4 9" is how people actually use a list.
    const tokens = answer.split(/[\s,]+/).filter(Boolean);
    let matched = false;
    for (const token of tokens) {
      const bot = resolveToken(token, list);
      if (!bot) {
        out(`  ${c.yellow(ERRORS.unknownCrawler(token))}\n`);
        continue;
      }
      matched = true;
      if (chosen.has(bot.name)) chosen.delete(bot.name);
      else chosen.add(bot.name);
    }
    if (matched) render(out, list, chosen, options);
  }

  const selected = [...unrecognised, ...visible().filter((bot) => chosen.has(bot.name)).map((bot) => bot.name)];
  return { selected, added };
}

/**
 * @param {string} token
 * @param {readonly AiBot[]} list
 * @returns {AiBot | undefined}
 */
function resolveToken(token, list) {
  if (/^\d+$/.test(token)) return list[Number(token) - 1];
  const lowered = token.toLowerCase();
  return list.find((bot) => bot.name.toLowerCase() === lowered || bot.robotsToken.toLowerCase() === lowered);
}

/**
 * @param {(text: string) => void} out
 * @param {readonly AiBot[]} list
 * @param {ReadonlySet<string>} chosen
 * @param {Pick<BotPickerOptions, 'allowAdd'>} options
 * @returns {void}
 */
function render(out, list, chosen, options) {
  const width = Math.max(...list.map((bot) => bot.name.length), 4);
  const numberWidth = String(list.length).length;
  out('\n');
  for (const [index, bot] of list.entries()) {
    const on = chosen.has(bot.name);
    const mark = on ? c.green('[x]') : c.gray('[ ]');
    const number = c.gray(`${String(index + 1).padStart(numberWidth)})`);
    const name = on ? bot.name.padEnd(width) : c.gray(bot.name.padEnd(width));
    const tail = c.gray(`${bot.vendor} · ${bot.kind}${bot.custom ? ' · yours' : ''}`);
    out(`  ${number} ${mark} ${name}  ${tail}\n`);
  }
  if (options.allowAdd) {
    out(`  ${' '.repeat(numberWidth)}  ${c.gray('+')}  ${c.gray('add'.padEnd(width))}  ${c.gray('a crawler OpenGSO has never heard of')}\n`);
  }
  out(`\n  ${c.gray(`${chosen.size} of ${list.length} selected.`)}\n`);
}

/**
 * Ask for a new crawler. A blank name is how the user backs out, so it is never an error.
 *
 * @param {Prompter} prompter
 * @param {(text: string) => void} out
 * @param {readonly AiBot[]} existing
 * @returns {Promise<AiBot | undefined>}
 */
async function addCustomBot(prompter, out, existing) {
  out(`\n  ${c.bold('Add a crawler')}\n`);
  out(`  ${c.gray('Everything except the name is optional and is guessed from it. Blank name cancels.')}\n\n`);

  const name = (await prompter.ask('  Name')).trim();
  if (!name) {
    out(`  ${c.gray('Nothing added.')}\n`);
    return undefined;
  }
  if (existing.some((bot) => bot.name.toLowerCase() === name.toLowerCase())) {
    out(`  ${c.yellow(ERRORS.crawlerAlreadyListed(name))}\n`);
    return undefined;
  }

  const vendor = await prompter.ask('  Who runs it', 'Custom');
  const patterns = await prompter.ask('  User-Agent contains', name.toLowerCase());
  const robotsToken = await prompter.ask('  robots.txt token', name);
  const kind = await prompter.choose(
    '  What does it do?',
    [
      { value: 'assistant', label: 'assistant', note: 'Fetches a page because a person asked about it, right now.' },
      { value: 'search', label: 'search', note: 'Indexes pages to answer search queries later.' },
      { value: 'training', label: 'training', note: 'Collects pages as training data.' },
    ],
    /** @type {BotKind} */ ('assistant'),
  );

  return normalizeCustomBot({
    name,
    vendor,
    uaPatterns: patterns.split(/[\s,]+/).filter(Boolean),
    robotsToken,
    kind: BOT_KINDS.includes(kind) ? kind : 'assistant',
  });
}
