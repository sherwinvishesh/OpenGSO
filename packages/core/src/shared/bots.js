/**
 * The AI bot list (§7, §17).
 *
 * This is the single community-contribution surface: new AI products launch constantly, so this file
 * is expected to change often. Keep it as plain data - no logic - so a first-time contributor can
 * add a bot without understanding anything else in the codebase.
 *
 * Two fields matter and they are NOT the same lever (§7):
 *  - `uaPatterns`  - matched against a live request's User-Agent, to decide who gets markdown.
 *  - `robotsToken` - the name written into `robots.txt`, which only well-behaved *bulk* crawlers
 *                    consult. Some entries (Google-Extended, Applebot-Extended) are robots.txt
 *                    tokens ONLY: they are opt-out signals with no crawler of their own, so they
 *                    have no `uaPatterns` and can never be routed by User-Agent.
 */

/** @typedef {'assistant' | 'search' | 'training'} BotKind */

/**
 * @typedef {object} AiBot
 * @property {string} name Canonical name, and the identifier a user writes in opengeo.config.json.
 * @property {string} vendor
 * @property {string[]} uaPatterns Case-insensitive User-Agent substrings. Empty means robots.txt-only
 *   (no crawler to match).
 * @property {string} robotsToken The token used in robots.txt `User-agent:` lines.
 * @property {BotKind} kind
 * @property {string} [notes]
 * @property {boolean} [custom] True for a crawler the user defined in their own config rather than
 *   one shipped in this file.
 */

/** @type {readonly BotKind[]} */
export const BOT_KINDS = ['assistant', 'search', 'training'];

/** @type {readonly AiBot[]} */
export const AI_BOTS = [
  { name: 'GPTBot', vendor: 'OpenAI', uaPatterns: ['gptbot'], robotsToken: 'GPTBot', kind: 'training' },
  { name: 'OAI-SearchBot', vendor: 'OpenAI', uaPatterns: ['oai-searchbot'], robotsToken: 'OAI-SearchBot', kind: 'search' },
  { name: 'ChatGPT-User', vendor: 'OpenAI', uaPatterns: ['chatgpt-user'], robotsToken: 'ChatGPT-User', kind: 'assistant' },
  { name: 'ClaudeBot', vendor: 'Anthropic', uaPatterns: ['claudebot'], robotsToken: 'ClaudeBot', kind: 'training' },
  { name: 'Claude-User', vendor: 'Anthropic', uaPatterns: ['claude-user'], robotsToken: 'Claude-User', kind: 'assistant' },
  { name: 'Claude-SearchBot', vendor: 'Anthropic', uaPatterns: ['claude-searchbot'], robotsToken: 'Claude-SearchBot', kind: 'search' },
  { name: 'anthropic-ai', vendor: 'Anthropic', uaPatterns: ['anthropic-ai'], robotsToken: 'anthropic-ai', kind: 'training' },
  { name: 'PerplexityBot', vendor: 'Perplexity', uaPatterns: ['perplexitybot'], robotsToken: 'PerplexityBot', kind: 'search' },
  { name: 'Perplexity-User', vendor: 'Perplexity', uaPatterns: ['perplexity-user'], robotsToken: 'Perplexity-User', kind: 'assistant' },
  {
    name: 'Google-Extended',
    vendor: 'Google',
    uaPatterns: [],
    robotsToken: 'Google-Extended',
    kind: 'training',
    notes: 'robots.txt opt-out token for Gemini training only. It is not a crawler and never appears in a User-Agent.',
  },
  {
    name: 'Applebot-Extended',
    vendor: 'Apple',
    uaPatterns: [],
    robotsToken: 'Applebot-Extended',
    kind: 'training',
    notes: 'robots.txt opt-out token for Apple Intelligence training. Not a crawler; Applebot itself is the crawler.',
  },
  { name: 'Applebot', vendor: 'Apple', uaPatterns: ['applebot'], robotsToken: 'Applebot', kind: 'search' },
  { name: 'Bingbot', vendor: 'Microsoft', uaPatterns: ['bingbot'], robotsToken: 'bingbot', kind: 'search' },
  { name: 'CCBot', vendor: 'Common Crawl', uaPatterns: ['ccbot'], robotsToken: 'CCBot', kind: 'training' },
  { name: 'Bytespider', vendor: 'ByteDance', uaPatterns: ['bytespider'], robotsToken: 'Bytespider', kind: 'training' },
  { name: 'meta-externalagent', vendor: 'Meta', uaPatterns: ['meta-externalagent'], robotsToken: 'meta-externalagent', kind: 'training' },
  { name: 'meta-externalfetcher', vendor: 'Meta', uaPatterns: ['meta-externalfetcher'], robotsToken: 'meta-externalfetcher', kind: 'assistant' },
  { name: 'Amazonbot', vendor: 'Amazon', uaPatterns: ['amazonbot'], robotsToken: 'Amazonbot', kind: 'search' },
  { name: 'cohere-ai', vendor: 'Cohere', uaPatterns: ['cohere-ai', 'cohere-training-data-crawler'], robotsToken: 'cohere-ai', kind: 'training' },
  { name: 'MistralAI-User', vendor: 'Mistral', uaPatterns: ['mistralai-user'], robotsToken: 'MistralAI-User', kind: 'assistant' },
  { name: 'DuckAssistBot', vendor: 'DuckDuckGo', uaPatterns: ['duckassistbot'], robotsToken: 'DuckAssistBot', kind: 'assistant' },
  { name: 'YouBot', vendor: 'You.com', uaPatterns: ['youbot'], robotsToken: 'YouBot', kind: 'search' },
  { name: 'Diffbot', vendor: 'Diffbot', uaPatterns: ['diffbot'], robotsToken: 'Diffbot', kind: 'training' },
  { name: 'Ai2Bot', vendor: 'Allen Institute for AI', uaPatterns: ['ai2bot'], robotsToken: 'Ai2Bot', kind: 'training' },
  { name: 'FirecrawlAgent', vendor: 'Firecrawl', uaPatterns: ['firecrawlagent', 'firecrawl'], robotsToken: 'FirecrawlAgent', kind: 'assistant' },
  { name: 'PetalBot', vendor: 'Huawei', uaPatterns: ['petalbot'], robotsToken: 'PetalBot', kind: 'search' },
  { name: 'ImagesiftBot', vendor: 'ImageSift', uaPatterns: ['imagesiftbot'], robotsToken: 'ImagesiftBot', kind: 'training' },
  { name: 'Timpibot', vendor: 'Timpi', uaPatterns: ['timpibot'], robotsToken: 'Timpibot', kind: 'training' },
];

/**
 * Bots that can actually be routed by User-Agent. The robots.txt-only tokens are excluded.
 *
 * @type {readonly AiBot[]}
 */
export const ROUTABLE_BOTS = AI_BOTS.filter((b) => b.uaPatterns.length > 0);

/**
 * Default markdown-routing list: every routable bot except the search-index crawlers.
 *
 * Every markdown response carries `X-Robots-Tag: noindex`, which keeps the twin out of search
 * indexes. Handing that response to Bingbot at the canonical URL would tell it to drop the page
 * itself, so a crawler whose job is building a search index gets the HTML unless the project routes
 * it on purpose. It can still ask for markdown with an Accept header.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_MARKDOWN_ROUTING = ROUTABLE_BOTS.filter((b) => b.kind !== 'search').map((b) => b.name);

/**
 * A crawler the user added themselves, as it appears in `bots.custom` in opengeo.config.json.
 *
 * The list above ships with OpenGEO and is updated by pull request, which is the right cadence for
 * a shared list and the wrong one for the person whose in-house agent started crawling yesterday.
 * Everything except the name has a sensible answer derived from it, so the minimum viable entry is
 * `{ "name": "AcmeBot" }`.
 *
 * @typedef {object} CustomBotInput
 * @property {string} name
 * @property {string} [vendor]
 * @property {string[]} [uaPatterns]
 * @property {string} [robotsToken]
 * @property {BotKind} [kind]
 * @property {string} [notes]
 */

/**
 * Fill a user-supplied entry out into a real bot, or return undefined if it is unusable.
 *
 * Nothing here trusts the input: it arrives from a hand-edited JSON file or from a browser form,
 * and a malformed entry must not be able to take the middleware down on the next request.
 *
 * @param {CustomBotInput | null | undefined} input
 * @returns {AiBot | undefined}
 */
export function normalizeCustomBot(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) return undefined;
  const patterns = (Array.isArray(input?.uaPatterns) ? input.uaPatterns : [])
    .filter(/** @returns {pattern is string} */ (pattern) => typeof pattern === 'string')
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean);
  const kind = input?.kind && BOT_KINDS.includes(input.kind) ? input.kind : 'assistant';
  return {
    name,
    vendor: input?.vendor?.trim() || 'Custom',
    // No pattern given means match the name, which is what a crawler almost always puts in its UA.
    uaPatterns: patterns.length > 0 ? patterns : [name.toLowerCase()],
    robotsToken: input?.robotsToken?.trim() || name,
    kind,
    notes: input?.notes?.trim() || undefined,
    custom: true,
  };
}

/**
 * The built-in list plus the user's own crawlers, which is what every caller actually wants.
 *
 * A custom entry that reuses a built-in name is dropped rather than merged: silently shadowing
 * GPTBot's User-Agent patterns with a typo would be a very quiet way to break routing.
 *
 * @param {readonly CustomBotInput[] | undefined} custom
 * @returns {readonly AiBot[]}
 */
export function resolveBots(custom) {
  if (!custom || custom.length === 0) return AI_BOTS;
  const seen = new Set(AI_BOTS.map((bot) => bot.name.toLowerCase()));
  /** @type {AiBot[]} */
  const extra = [];
  for (const entry of custom) {
    const bot = normalizeCustomBot(entry);
    if (!bot || seen.has(bot.name.toLowerCase())) continue;
    seen.add(bot.name.toLowerCase());
    extra.push(bot);
  }
  return extra.length > 0 ? [...AI_BOTS, ...extra] : AI_BOTS;
}

/**
 * The routable subset of `resolveBots`.
 *
 * @param {readonly CustomBotInput[] | undefined} custom
 * @returns {readonly AiBot[]}
 */
export function resolveRoutableBots(custom) {
  return resolveBots(custom).filter((bot) => bot.uaPatterns.length > 0);
}

/**
 * @param {string} name
 * @param {readonly AiBot[]} [bots]
 * @returns {AiBot | undefined}
 */
export function findBot(name, bots = AI_BOTS) {
  const lowered = name.toLowerCase();
  return bots.find((b) => b.name.toLowerCase() === lowered || b.robotsToken.toLowerCase() === lowered);
}

/**
 * Identify an AI bot from a User-Agent string.
 *
 * Returns `undefined` for anything unrecognised - and every caller must treat that as "ordinary
 * visitor", never as "suspicious". Blocking unknowns by default would wall the site off from every
 * AI product that launches after this list was last updated (§7, §16).
 *
 * `bots` defaults to the built-in list. Pass `resolveBots(config.bots.custom)` to include the
 * crawlers the user defined themselves.
 *
 * @param {string | null | undefined} userAgent
 * @param {readonly AiBot[]} [bots]
 * @returns {AiBot | undefined}
 */
export function identifyBot(userAgent, bots = AI_BOTS) {
  if (!userAgent) return undefined;
  const ua = userAgent.toLowerCase();
  return bots.find((bot) => bot.uaPatterns.length > 0 && bot.uaPatterns.some((p) => ua.includes(p)));
}

/**
 * A User-Agent that `identifyBot` reads back as `bot`, for probing a site's routing as that bot.
 *
 * @param {AiBot} bot
 * @param {readonly AiBot[]} [bots]
 * @returns {string}
 */
export function botUserAgent(bot, bots = AI_BOTS) {
  const ua = `Mozilla/5.0 (compatible; ${bot.name}/1.0; +https://github.com/sherwinvishesh/OpenGEO)`;
  if (identifyBot(ua, bots)?.name === bot.name) return ua;
  // Defensive: a bot whose UA token is not its own name. None today, but this file is the
  // community-contribution surface, and a probe that silently fails to impersonate anyone would
  // report a routing failure that does not exist.
  return `Mozilla/5.0 (compatible; ${bot.uaPatterns[0]}/1.0; +https://github.com/sherwinvishesh/OpenGEO)`;
}

/**
 * The crawler `opengeo test` impersonates for B10: GPTBot, unless the project routes a list that
 * leaves it out, in which case the first routable crawler on that list. Probing a bot the project
 * chose not to route would report a failure the site does not have.
 *
 * @param {readonly string[] | undefined} markdownRouting
 * @param {readonly AiBot[]} [bots]
 * @returns {AiBot | undefined} Undefined means GPTBot.
 */
export function routingProbeBot(markdownRouting, bots = AI_BOTS) {
  if (!markdownRouting || markdownRouting.some((name) => name.toLowerCase() === 'gptbot')) return undefined;
  return markdownRouting.map((name) => findBot(name, bots)).find((bot) => bot !== undefined && bot.uaPatterns.length > 0);
}
