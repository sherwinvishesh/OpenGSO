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
export type BotKind = 'assistant' | 'search' | 'training';

export interface AiBot {
  /** Canonical name, and the identifier a user writes in opengeo.config.json. */
  name: string;
  vendor: string;
  /** Case-insensitive User-Agent substrings. Empty means robots.txt-only (no crawler to match). */
  uaPatterns: string[];
  /** The token used in robots.txt `User-agent:` lines. */
  robotsToken: string;
  kind: BotKind;
  notes?: string;
  /** True for a crawler the user defined in their own config rather than one shipped in this file. */
  custom?: boolean;
}

export const BOT_KINDS: readonly BotKind[] = ['assistant', 'search', 'training'];

export const AI_BOTS: readonly AiBot[] = [
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

/** Bots that can actually be routed by User-Agent. The robots.txt-only tokens are excluded. */
export const ROUTABLE_BOTS: readonly AiBot[] = AI_BOTS.filter((b) => b.uaPatterns.length > 0);

/** Default markdown-routing list: every routable bot. Narrowing is the user's choice, not ours. */
export const DEFAULT_MARKDOWN_ROUTING: readonly string[] = ROUTABLE_BOTS.map((b) => b.name);

/**
 * A crawler the user added themselves, as it appears in `bots.custom` in opengeo.config.json.
 *
 * The list above ships with OpenGEO and is updated by pull request, which is the right cadence for
 * a shared list and the wrong one for the person whose in-house agent started crawling yesterday.
 * Everything except the name has a sensible answer derived from it, so the minimum viable entry is
 * `{ "name": "AcmeBot" }`.
 */
export interface CustomBotInput {
  name: string;
  vendor?: string;
  uaPatterns?: string[];
  robotsToken?: string;
  kind?: BotKind;
  notes?: string;
}

/**
 * Fill a user-supplied entry out into a real bot, or return undefined if it is unusable.
 *
 * Nothing here trusts the input: it arrives from a hand-edited JSON file or from a browser form,
 * and a malformed entry must not be able to take the middleware down on the next request.
 */
export function normalizeCustomBot(input: CustomBotInput | null | undefined): AiBot | undefined {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) return undefined;
  const patterns = (Array.isArray(input?.uaPatterns) ? input.uaPatterns : [])
    .filter((pattern): pattern is string => typeof pattern === 'string')
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
 */
export function resolveBots(custom: readonly CustomBotInput[] | undefined): readonly AiBot[] {
  if (!custom || custom.length === 0) return AI_BOTS;
  const seen = new Set(AI_BOTS.map((bot) => bot.name.toLowerCase()));
  const extra: AiBot[] = [];
  for (const entry of custom) {
    const bot = normalizeCustomBot(entry);
    if (!bot || seen.has(bot.name.toLowerCase())) continue;
    seen.add(bot.name.toLowerCase());
    extra.push(bot);
  }
  return extra.length > 0 ? [...AI_BOTS, ...extra] : AI_BOTS;
}

/** The routable subset of `resolveBots`. */
export function resolveRoutableBots(custom: readonly CustomBotInput[] | undefined): readonly AiBot[] {
  return resolveBots(custom).filter((bot) => bot.uaPatterns.length > 0);
}

export function findBot(name: string, bots: readonly AiBot[] = AI_BOTS): AiBot | undefined {
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
 */
export function identifyBot(userAgent: string | null | undefined, bots: readonly AiBot[] = AI_BOTS): AiBot | undefined {
  if (!userAgent) return undefined;
  const ua = userAgent.toLowerCase();
  return bots.find((bot) => bot.uaPatterns.length > 0 && bot.uaPatterns.some((p) => ua.includes(p)));
}
