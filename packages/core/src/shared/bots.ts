/**
 * The AI bot list (idea.md §7, §17).
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
}

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

export function findBot(name: string): AiBot | undefined {
  const lowered = name.toLowerCase();
  return AI_BOTS.find((b) => b.name.toLowerCase() === lowered || b.robotsToken.toLowerCase() === lowered);
}

/**
 * Identify an AI bot from a User-Agent string.
 *
 * Returns `undefined` for anything unrecognised - and every caller must treat that as "ordinary
 * visitor", never as "suspicious". Blocking unknowns by default would wall the site off from every
 * AI product that launches after this list was last updated (§7, §16).
 */
export function identifyBot(userAgent: string | null | undefined): AiBot | undefined {
  if (!userAgent) return undefined;
  const ua = userAgent.toLowerCase();
  return ROUTABLE_BOTS.find((bot) => bot.uaPatterns.some((p) => ua.includes(p)));
}
