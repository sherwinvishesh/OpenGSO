import type { AiBot } from '../shared/bots.js';
import { findBot, identifyBot, ROUTABLE_BOTS } from '../shared/bots.js';
import type { ProbeOptions, ProbeResult } from '../shared/http.js';
import { BROWSER_UA, cleanUrl, probe } from '../shared/http.js';
import { twinUrl } from '../shared/routes.js';
import { HEADERS } from '../shared/version.js';
import { parseLinkAlternate, varyIncludesAccept } from './headers.js';
import { summarizeRobots } from './startup.js';

/**
 * `opengeo prod test <url>` (idea.md §7).
 *
 * This is not a second scorer. `opengeo test` grades a site; this answers a narrower and more
 * operational question: is the middleware actually installed, and are the two bot levers doing
 * what the config says they should?
 *
 * The two levers are deliberately reported apart, because conflating them is the mistake this
 * whole design exists to avoid:
 *
 *   Lever 1, `bots.markdownRouting` - who receives the markdown twin. It decides a *format*, never
 *            access. A bot missing from it sees the ordinary site, exactly like a human.
 *   Lever 2, `bots.blocked`         - who is disallowed in robots.txt. Opt-in, empty by default,
 *            and written by `generate`, never by prod. Prod has no blocking code path at all, so
 *            the probe for it reads the deployed robots.txt rather than the middleware.
 *
 * Each probe isolates one variable. The routed-bot probe sends a browser-typical Accept header so
 * that a markdown response can only have been caused by the User-Agent, and the Accept probe sends
 * a browser User-Agent so a markdown response can only have been caused by the Accept header.
 */

export type ProbeVerdict = 'pass' | 'fail' | 'warn';
export type LeverId = 'routing' | 'negotiation' | 'blocking';

export interface ProdProbe {
  id: string;
  title: string;
  lever: LeverId;
  /** Exactly what was sent, so a reader can reproduce the result by hand. */
  sent: { url: string; userAgent: string; accept: string };
  status: number;
  verdict: ProbeVerdict;
  reason: string;
  detail?: string;
  /** The §7 headers that came back. Only the ones OpenGEO has an opinion about. */
  headers: Record<string, string>;
  curl: string;
}

export interface RobotsReport {
  url: string;
  found: boolean;
  blocked: string[];
  allowed: string[];
  notes: string[];
}

export interface ProdVerification {
  target: string;
  twinUrl: string;
  /** The bot whose User-Agent was impersonated for the routing probe. */
  bot: string;
  /** True when at least one response carried `X-AEO-Version`, i.e. prod answered at all. */
  installed: boolean;
  probes: ProdProbe[];
  robots: RobotsReport;
  /** Places where the two levers contradict each other. Empty is the healthy case. */
  conflicts: string[];
  counts: { pass: number; warn: number; fail: number };
  ok: boolean;
}

export interface VerifyProdOptions {
  /** Bot name to impersonate for the lever-1 probe. Default ClaudeBot. */
  bot?: string;
  timeoutMs?: number;
  /** Injected by tests so the probe matrix can be exercised without a live server. */
  probeFn?: (url: string, options?: ProbeOptions) => Promise<ProbeResult>;
}

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MARKDOWN_ACCEPT = 'text/markdown,text/plain;q=0.9';
/** Accepts neither HTML nor markdown, which is the only case §7 answers with a 406. */
const HOSTILE_ACCEPT = 'application/pdf';

/**
 * A User-Agent that is deliberately not on the bot list, and must stay that way. It is how the
 * §16 promise gets tested rather than asserted: every AI product that launches after this list was
 * last updated looks exactly like this to a server.
 */
const UNKNOWN_BOT_UA = 'Mozilla/5.0 (compatible; NotYetKnownAiBot/1.0; +https://example.com/bot)';

const DEFAULT_BOT = 'ClaudeBot';

export async function verifyProd(url: string, options: VerifyProdOptions = {}): Promise<ProdVerification> {
  const bot = resolveBot(options.bot ?? DEFAULT_BOT);
  const target = cleanUrl(url);
  const origin = new URL(target).origin;
  const run = options.probeFn ?? probe;
  const timeoutMs = options.timeoutMs;

  const send = (userAgent: string, accept: string) =>
    run(target, { headers: { 'User-Agent': userAgent, Accept: accept }, timeoutMs });

  const botUa = botUserAgent(bot);
  const [routed, unknown, negotiated, browser, hostile, robotsTxt] = await Promise.all([
    send(botUa, BROWSER_ACCEPT),
    send(UNKNOWN_BOT_UA, BROWSER_ACCEPT),
    send(BROWSER_UA, MARKDOWN_ACCEPT),
    send(BROWSER_UA, BROWSER_ACCEPT),
    send(BROWSER_UA, HOSTILE_ACCEPT),
    run(`${origin}/robots.txt`, { headers: { 'User-Agent': BROWSER_UA }, timeoutMs }),
  ]);

  const probes: ProdProbe[] = [
    judgeRoutedBot(bot, botUa, routed, target),
    judgeUnknownBot(unknown, target),
    judgeAcceptMarkdown(negotiated, target),
    judgeBrowser(browser, target),
    judgeNotAcceptable(hostile, target),
  ];

  const installed = probes.some((p) => Boolean(p.headers[HEADERS.aeoVersion]));
  const robots = readRobots(`${origin}/robots.txt`, robotsTxt);
  const conflicts = findConflicts(bot, robots, probes);

  const counts = {
    pass: probes.filter((p) => p.verdict === 'pass').length,
    warn: probes.filter((p) => p.verdict === 'warn').length,
    fail: probes.filter((p) => p.verdict === 'fail').length,
  };

  return {
    target,
    twinUrl: twinUrl(target),
    bot: bot.name,
    installed,
    probes,
    robots,
    conflicts,
    counts,
    ok: counts.fail === 0,
  };
}

/**
 * Resolve a `--bot` name, and refuse the two robots.txt-only tokens with an explanation rather
 * than a probe that could never pass. Google-Extended and Applebot-Extended are opt-out signals
 * with no crawler behind them, so no request will ever carry them as a User-Agent.
 */
export function resolveBot(name: string): AiBot {
  const bot = findBot(name);
  if (!bot) {
    throw new Error(
      [
        `Unknown bot "${name}".`,
        ``,
        `Bots that can be routed by User-Agent: ${ROUTABLE_BOTS.map((b) => b.name).join(', ')}.`,
      ].join('\n'),
    );
  }
  if (bot.uaPatterns.length === 0) {
    throw new Error(
      [
        `${bot.name} is a robots.txt token, not a crawler, so it can never be probed by User-Agent.`,
        ``,
        bot.notes ?? '',
        `Pick a bot that actually crawls, e.g. --bot ${DEFAULT_BOT}.`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return bot;
}

function botUserAgent(bot: AiBot): string {
  const ua = `Mozilla/5.0 (compatible; ${bot.name}/1.0; +https://github.com/sherwinvishesh/OpenGEO)`;
  if (identifyBot(ua)?.name === bot.name) return ua;
  // Defensive: a bot whose UA token is not its own name. None today, but bots.ts is the
  // community-contribution surface, and a probe that silently fails to impersonate anyone would
  // report a routing failure that does not exist.
  return `Mozilla/5.0 (compatible; ${bot.uaPatterns[0]}/1.0; +https://github.com/sherwinvishesh/OpenGEO)`;
}

// --- probe judgements -------------------------------------------------------------------------

function judgeRoutedBot(bot: AiBot, ua: string, result: ProbeResult, url: string): ProdProbe {
  const base = {
    id: 'routed-bot',
    title: `${bot.name} receives the markdown twin`,
    lever: 'routing' as const,
    sent: { url, userAgent: ua, accept: BROWSER_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, ua, BROWSER_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };
  const blocked = judgeBlocked(result, `${bot.name} was`);
  if (blocked) return { ...base, ...blocked };

  if (isMarkdown(result)) {
    return {
      ...base,
      verdict: 'pass',
      reason: `${bot.name} is on the markdown routing list and got the twin at the same URL, with a browser-typical Accept header.`,
      detail: `Content-Type ${result.headers.get('content-type')}, ${result.body.length} bytes.`,
    };
  }
  if (!base.headers[HEADERS.aeoVersion]) {
    return {
      ...base,
      verdict: 'fail',
      reason: `No ${HEADERS.aeoVersion} on the response, so opengeo-prod is not running at this URL.`,
      detail: 'Install opengeo-prod and wire the adapter into your middleware, then re-run this command.',
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: `opengeo-prod answered but served HTML to ${bot.name}.`,
    detail: `Either ${bot.name} is missing from bots.markdownRouting, or there is no twin for this route yet - run \`opengeo generate\`.`,
  };
}

function judgeUnknownBot(result: ProbeResult, url: string): ProdProbe {
  const base = {
    id: 'unknown-bot',
    title: 'An unrecognised bot is served the normal site, never blocked',
    lever: 'routing' as const,
    sent: { url, userAgent: UNKNOWN_BOT_UA, accept: BROWSER_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, UNKNOWN_BOT_UA, BROWSER_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };

  if (result.status === 401 || result.status === 403 || result.status === 429) {
    return {
      ...base,
      verdict: 'fail',
      reason: `An unrecognised bot got ${result.status}. Something on this host blocks bots it does not know.`,
      detail:
        'opengeo-prod has no blocking code path, so this is a CDN, WAF or host rule. Every AI product launched since the bot list was last updated looks exactly like this request.',
    };
  }
  if (isMarkdown(result)) {
    return {
      ...base,
      verdict: 'warn',
      reason: 'An unrecognised bot received markdown. Harmless, but the routing list is not what decided it.',
      detail: 'Check whether something upstream is rewriting the Accept header.',
    };
  }
  if (result.ok) {
    return {
      ...base,
      verdict: 'pass',
      reason: `Served ${result.status} and the normal site, which is exactly right: an unknown bot is treated as an ordinary visitor.`,
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: `An unrecognised bot got ${result.status}.`,
    detail: 'Expected the ordinary page. OpenGEO never blocks a bot it does not recognise.',
  };
}

function judgeAcceptMarkdown(result: ProbeResult, url: string): ProdProbe {
  const base = {
    id: 'accept-markdown',
    title: 'Accept: text/markdown returns markdown at the same URL',
    lever: 'negotiation' as const,
    sent: { url, userAgent: BROWSER_UA, accept: MARKDOWN_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, BROWSER_UA, MARKDOWN_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };

  if (isMarkdown(result)) {
    if (result.redirected) {
      return {
        ...base,
        verdict: 'warn',
        reason: `Markdown was served, but after a redirect to ${result.finalUrl}.`,
        detail: '§7 asks for a rewrite, not a redirect: the URL the agent asked for should be the URL that answers.',
      };
    }
    return {
      ...base,
      verdict: 'pass',
      reason: 'A browser User-Agent asking for text/markdown got markdown, so the Accept header alone is enough.',
      detail: `${HEADERS.markdownTokens}: ${base.headers[HEADERS.markdownTokens] ?? 'absent'}.`,
    };
  }
  if (!base.headers[HEADERS.aeoVersion]) {
    return {
      ...base,
      verdict: 'fail',
      reason: `No ${HEADERS.aeoVersion} on the response, so opengeo-prod is not running at this URL.`,
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: 'opengeo-prod answered but did not honour Accept: text/markdown.',
    detail: 'Most often this means no twin exists for this route yet. Run `opengeo generate <url>`.',
  };
}

function judgeBrowser(result: ProbeResult, url: string): ProdProbe {
  const base = {
    id: 'browser',
    title: 'An ordinary browser still gets the ordinary site',
    lever: 'negotiation' as const,
    sent: { url, userAgent: BROWSER_UA, accept: BROWSER_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, BROWSER_UA, BROWSER_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };

  if (isMarkdown(result)) {
    return {
      ...base,
      verdict: 'fail',
      reason: 'A normal browser was served markdown. Human visitors are seeing raw Markdown instead of your site.',
      detail: 'Check that nothing upstream is forcing an Accept header on browser requests.',
    };
  }
  if (!result.ok) {
    return { ...base, verdict: 'fail', reason: `A normal browser got ${result.status}.` };
  }

  const vary = base.headers[HEADERS.vary];
  const alternate = parseLinkAlternate(result.headers.get(HEADERS.link));
  const notes: string[] = [];
  if (alternate) notes.push(`the twin is advertised at ${alternate}`);
  else notes.push('no Link: rel="alternate" header, so an agent has to guess the twin URL');

  // Whole tokens, never a substring: `Vary: Accept-Encoding` is on nearly every compressed
  // response and says nothing about content negotiation.
  if (!varyIncludesAccept(vary)) {
    return {
      ...base,
      verdict: 'warn',
      reason: `HTML was served correctly, but Vary does not include Accept (Vary: ${vary ?? 'absent'}).`,
      detail: `A shared cache can store this HTML and hand it to the next agent that asks for markdown. ${asSentence(notes.join('; '))}.`,
    };
  }
  return {
    ...base,
    verdict: alternate ? 'pass' : 'warn',
    reason: alternate
      ? 'HTML unchanged, with `Vary: Accept` and the markdown alternate advertised.'
      : 'HTML unchanged with `Vary: Accept`, but the markdown alternate is not advertised.',
    detail: `${asSentence(notes.join('; '))}.`,
  };
}

/**
 * The notes below get joined into a sentence of their own, sometimes after another one. Written
 * lowercase at the call site so they read as a list, they need their first letter lifted here.
 */
function asSentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function judgeNotAcceptable(result: ProbeResult, url: string): ProdProbe {
  const base = {
    id: 'not-acceptable',
    title: 'An Accept header that excludes both formats gets a 406',
    lever: 'negotiation' as const,
    sent: { url, userAgent: BROWSER_UA, accept: HOSTILE_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, BROWSER_UA, HOSTILE_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };

  if (result.status === 406) {
    return {
      ...base,
      verdict: 'pass',
      reason: `Answered 406 to \`Accept: ${HOSTILE_ACCEPT}\`, which is the honest response when neither representation was asked for.`,
    };
  }
  if (!base.headers[HEADERS.aeoVersion]) {
    return {
      ...base,
      verdict: 'fail',
      reason: `Answered ${result.status} with no ${HEADERS.aeoVersion}, so opengeo-prod is not running at this URL.`,
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: `Answered ${result.status} instead of 406 to \`Accept: ${HOSTILE_ACCEPT}\`.`,
    detail: 'Something upstream is answering before the middleware sees the request.',
  };
}

function judgeUnreachable(result: ProbeResult): Pick<ProdProbe, 'verdict' | 'reason' | 'detail'> | undefined {
  if (result.status !== 0) return undefined;
  return {
    verdict: 'fail',
    reason: `Could not reach ${result.url}.`,
    detail: result.error,
  };
}

function judgeBlocked(result: ProbeResult, who: string): Pick<ProdProbe, 'verdict' | 'reason' | 'detail'> | undefined {
  if (result.status !== 401 && result.status !== 403 && result.status !== 429) return undefined;
  return {
    verdict: 'fail',
    reason: `${who} answered ${result.status}, which is a block, not a routing decision.`,
    detail:
      'opengeo-prod contains no blocking code. Blocking lives in robots.txt (lever 2) and is advisory; a hard block here comes from a CDN, WAF or host rule.',
  };
}

// --- lever 2 ----------------------------------------------------------------------------------

function readRobots(url: string, result: ProbeResult): RobotsReport {
  if (result.status === 0) {
    return {
      url,
      found: false,
      blocked: [],
      allowed: [],
      notes: [`Could not fetch robots.txt: ${result.error ?? 'no response'}.`],
    };
  }
  if (!result.ok) {
    return {
      url,
      found: false,
      blocked: [],
      allowed: [],
      notes: [
        `No robots.txt (${result.status}), so nothing is blocked.`,
        'Run `opengeo generate <url>` to write one, or hand-write it. prod never writes this file.',
      ],
    };
  }

  const { allowed, blocked } = summarizeRobots(result.body);
  const notes: string[] = [];
  notes.push(
    blocked.length > 0
      ? `Disallowed at the site root: ${blocked.join(', ')}.`
      : 'No AI bot is disallowed. That is the default, and OpenGEO never adds a block you did not ask for.',
  );
  if (allowed.length > 0) {
    notes.push(`Explicitly named and allowed: ${allowed.length} AI bot${allowed.length === 1 ? '' : 's'}.`);
  }
  notes.push('This list comes from bots.blocked and is written by `opengeo generate`. prod itself never blocks anyone.');
  return { url, found: true, blocked, allowed, notes };
}

/**
 * The two levers are independent by design, but a user can still set them against each other. Say
 * so plainly rather than quietly doing something reasonable: the fix depends on what they meant.
 */
function findConflicts(bot: AiBot, robots: RobotsReport, probes: ProdProbe[]): string[] {
  const conflicts: string[] = [];
  const routed = probes.find((p) => p.id === 'routed-bot');
  if (robots.blocked.includes(bot.name) && routed?.verdict === 'pass') {
    conflicts.push(
      `robots.txt disallows ${bot.name}, but the middleware routes markdown to it. Remove it from bots.blocked, or from bots.markdownRouting - the two lists currently disagree about the same bot.`,
    );
  }
  return conflicts;
}

// --- small helpers ----------------------------------------------------------------------------

const INTERESTING_HEADERS = [
  HEADERS.contentType,
  HEADERS.vary,
  HEADERS.link,
  HEADERS.aeoVersion,
  HEADERS.markdownTokens,
  HEADERS.robotsTag,
  HEADERS.contentTypeOptions,
  HEADERS.markdownSourceHash,
  HEADERS.lastModified,
];

function collectHeaders(result: ProbeResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of INTERESTING_HEADERS) {
    const value = result.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function isMarkdown(result: ProbeResult): boolean {
  return (result.headers.get('content-type') ?? '').toLowerCase().includes('text/markdown');
}

function curlFor(url: string, userAgent: string, accept: string): string {
  return `curl -sI -H 'User-Agent: ${userAgent}' -H 'Accept: ${accept}' '${url}'`;
}
