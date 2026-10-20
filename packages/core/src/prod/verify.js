import { AI_BOTS, botUserAgent, findBot } from '../shared/bots.js';
import { BROWSER_ACCEPT, BROWSER_UA, HOSTILE_ACCEPT, cleanUrl, isMarkdownResponse, probe } from '../shared/http.js';
import { twinUrl } from '../shared/routes.js';
import { HEADERS } from '../shared/version.js';
import { parseLinkAlternate, varyIncludesAccept } from './headers.js';
import { summarizeRobots } from './startup.js';

/**
 * @import { AiBot } from '../shared/bots.js'
 * @import { ProbeOptions, ProbeResult } from '../shared/http.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').ProbeVerdict} ProbeVerdict
 * @typedef {import('../shared/api-types.js').LeverId} LeverId
 * @typedef {import('../shared/api-types.js').ProdProbe} ProdProbe
 * @typedef {import('../shared/api-types.js').RobotsReport} RobotsReport
 * @typedef {import('../shared/api-types.js').ProdVerification} ProdVerification
 */

/**
 * `omnigeo prod test <url>` (§7).
 *
 * This is not a second scorer. `omnigeo test` grades a site; this answers a narrower and more
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

/**
 * @typedef {object} VerifyProdOptions
 * @property {string} [bot] Bot name to impersonate for the lever-1 probe. Default ClaudeBot.
 * @property {number} [timeoutMs]
 * @property {readonly AiBot[]} [bots] The crawler catalogue `--bot` resolves against. Defaults to
 *   the shipped list; callers with a config in hand pass the resolved one so `--bot MyCrawler` can
 *   probe a project's own agent.
 * @property {(url: string, options?: ProbeOptions) => Promise<ProbeResult>} [probeFn] Injected by
 *   tests so the probe matrix can be exercised without a live server.
 */

const MARKDOWN_ACCEPT = 'text/markdown,text/plain;q=0.9';

/**
 * A User-Agent that is deliberately not on the bot list, and must stay that way. It is how the
 * §16 promise gets tested rather than asserted: every AI product that launches after this list was
 * last updated looks exactly like this to a server.
 */
const UNKNOWN_BOT_UA = 'Mozilla/5.0 (compatible; NotYetKnownAiBot/1.0; +https://example.com/bot)';

export const DEFAULT_BOT = 'ClaudeBot';

/**
 * @param {string} url
 * @param {VerifyProdOptions} [options]
 * @returns {Promise<ProdVerification>}
 */
export async function verifyProd(url, options = {}) {
  const bot = resolveBot(options.bot ?? DEFAULT_BOT, options.bots);
  const target = cleanUrl(url);
  const origin = new URL(target).origin;
  const run = options.probeFn ?? probe;
  const timeoutMs = options.timeoutMs;

  /**
   * @param {string} userAgent
   * @param {string} accept
   */
  const send = (userAgent, accept) =>
    run(target, { headers: { 'User-Agent': userAgent, Accept: accept }, timeoutMs });

  const botUa = botUserAgent(bot, options.bots);
  const [routed, unknown, negotiated, browser, hostile, robotsTxt] = await Promise.all([
    send(botUa, BROWSER_ACCEPT),
    send(UNKNOWN_BOT_UA, BROWSER_ACCEPT),
    send(BROWSER_UA, MARKDOWN_ACCEPT),
    send(BROWSER_UA, BROWSER_ACCEPT),
    send(BROWSER_UA, HOSTILE_ACCEPT),
    run(`${origin}/robots.txt`, { headers: { 'User-Agent': BROWSER_UA }, timeoutMs }),
  ]);

  /** @type {ProdProbe[]} */
  const probes = [
    judgeRoutedBot(bot, botUa, routed, target),
    judgeUnknownBot(unknown, target),
    judgeAcceptMarkdown(negotiated, target),
    judgeBrowser(browser, target),
    judgeNotAcceptable(hostile, target),
  ];

  const installed = probes.some((p) => Boolean(p.headers[HEADERS.aeoVersion]));
  const robots = readRobots(`${origin}/robots.txt`, robotsTxt, options.bots);
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
 *
 * @param {string} name
 * @param {readonly AiBot[]} [bots]
 * @returns {AiBot}
 */
export function resolveBot(name, bots = AI_BOTS) {
  const bot = findBot(name, bots);
  if (!bot) {
    throw new Error(
      [
        `Unknown bot "${name}".`,
        ``,
        `Bots that can be routed by User-Agent: ${bots
          .filter((b) => b.uaPatterns.length > 0)
          .map((b) => b.name)
          .join(', ')}.`,
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

// --- probe judgements -------------------------------------------------------------------------

/**
 * @param {AiBot} bot
 * @param {string} ua
 * @param {ProbeResult} result
 * @param {string} url
 * @returns {ProdProbe}
 */
function judgeRoutedBot(bot, ua, result, url) {
  const base = {
    id: 'routed-bot',
    title: `${bot.name} receives the markdown twin`,
    lever: /** @type {const} */ ('routing'),
    sent: { url, userAgent: ua, accept: BROWSER_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, ua, BROWSER_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };
  const blocked = judgeBlocked(result, `${bot.name} was`);
  if (blocked) return { ...base, ...blocked };

  if (isMarkdownResponse(result)) {
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
      reason: `No ${HEADERS.aeoVersion} on the response, so omnigeo-prod is not running at this URL.`,
      detail: 'Install omnigeo-prod and put its middleware in front of your pages (proxy.ts on Next.js; its README has Express, Nuxt, SvelteKit, Astro, React Router, Vite and edge recipes), then re-run this command.',
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: `omnigeo-prod answered but served HTML to ${bot.name}.`,
    detail: `Either ${bot.name} is missing from bots.markdownRouting, or there is no twin for this route yet - run \`omnigeo generate\`.`,
  };
}

/**
 * @param {ProbeResult} result
 * @param {string} url
 * @returns {ProdProbe}
 */
function judgeUnknownBot(result, url) {
  const base = {
    id: 'unknown-bot',
    title: 'An unrecognised bot is served the normal site, never blocked',
    lever: /** @type {const} */ ('routing'),
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
        'omnigeo-prod has no blocking code path, so this is a CDN, WAF or host rule. Every AI product launched since the bot list was last updated looks exactly like this request.',
    };
  }
  if (isMarkdownResponse(result)) {
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
    detail: 'Expected the ordinary page. OmniGEO never blocks a bot it does not recognise.',
  };
}

/**
 * @param {ProbeResult} result
 * @param {string} url
 * @returns {ProdProbe}
 */
function judgeAcceptMarkdown(result, url) {
  const base = {
    id: 'accept-markdown',
    title: 'Accept: text/markdown returns markdown at the same URL',
    lever: /** @type {const} */ ('negotiation'),
    sent: { url, userAgent: BROWSER_UA, accept: MARKDOWN_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, BROWSER_UA, MARKDOWN_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };

  if (isMarkdownResponse(result)) {
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
      reason: `No ${HEADERS.aeoVersion} on the response, so omnigeo-prod is not running at this URL.`,
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: 'omnigeo-prod answered but did not honour Accept: text/markdown.',
    detail: 'Most often this means no twin exists for this route yet. Run `omnigeo generate <url>`.',
  };
}

/**
 * @param {ProbeResult} result
 * @param {string} url
 * @returns {ProdProbe}
 */
function judgeBrowser(result, url) {
  const base = {
    id: 'browser',
    title: 'An ordinary browser still gets the ordinary site',
    lever: /** @type {const} */ ('negotiation'),
    sent: { url, userAgent: BROWSER_UA, accept: BROWSER_ACCEPT },
    status: result.status,
    headers: collectHeaders(result),
    curl: curlFor(url, BROWSER_UA, BROWSER_ACCEPT),
  };

  const unreachable = judgeUnreachable(result);
  if (unreachable) return { ...base, ...unreachable };

  if (isMarkdownResponse(result)) {
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
  /** @type {string[]} */
  const notes = [];
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
 *
 * @param {string} text
 * @returns {string}
 */
function asSentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {ProbeResult} result
 * @param {string} url
 * @returns {ProdProbe}
 */
function judgeNotAcceptable(result, url) {
  const base = {
    id: 'not-acceptable',
    title: 'An Accept header that excludes both formats gets a 406',
    lever: /** @type {const} */ ('negotiation'),
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
      reason: `Answered ${result.status} with no ${HEADERS.aeoVersion}, so omnigeo-prod is not running at this URL.`,
    };
  }
  return {
    ...base,
    verdict: 'fail',
    reason: `Answered ${result.status} instead of 406 to \`Accept: ${HOSTILE_ACCEPT}\`.`,
    detail:
      'prod only sends 406 on a route that has a twin, so either there is no twin for this route yet (run `omnigeo generate <url>`), or something upstream is answering before the middleware sees the request.',
  };
}

/**
 * @param {ProbeResult} result
 * @returns {Pick<ProdProbe, 'verdict' | 'reason' | 'detail'> | undefined}
 */
function judgeUnreachable(result) {
  if (result.status !== 0) return undefined;
  return {
    verdict: 'fail',
    reason: `Could not reach ${result.url}.`,
    detail: result.error,
  };
}

/**
 * @param {ProbeResult} result
 * @param {string} who
 * @returns {Pick<ProdProbe, 'verdict' | 'reason' | 'detail'> | undefined}
 */
function judgeBlocked(result, who) {
  if (result.status !== 401 && result.status !== 403 && result.status !== 429) return undefined;
  return {
    verdict: 'fail',
    reason: `${who} answered ${result.status}, which is a block, not a routing decision.`,
    detail:
      'omnigeo-prod contains no blocking code. Blocking lives in robots.txt (lever 2) and is advisory; a hard block here comes from a CDN, WAF or host rule.',
  };
}

// --- lever 2 ----------------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {ProbeResult} result
 * @param {readonly AiBot[]} [bots]
 * @returns {RobotsReport}
 */
function readRobots(url, result, bots) {
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
        'Run `omnigeo generate <url>` to write one, or hand-write it. prod never writes this file.',
      ],
    };
  }

  const { allowed, blocked } = summarizeRobots(result.body, bots);
  /** @type {string[]} */
  const notes = [];
  notes.push(
    blocked.length > 0
      ? `Disallowed at the site root: ${blocked.join(', ')}.`
      : 'No AI bot is disallowed. That is the default, and OmniGEO never adds a block you did not ask for.',
  );
  if (allowed.length > 0) {
    notes.push(`Explicitly named and allowed: ${allowed.length} AI bot${allowed.length === 1 ? '' : 's'}.`);
  }
  notes.push('This list comes from bots.blocked and is written by `omnigeo generate`. prod itself never blocks anyone.');
  return { url, found: true, blocked, allowed, notes };
}

/**
 * The two levers are independent by design, but a user can still set them against each other. Say
 * so plainly rather than quietly doing something reasonable: the fix depends on what they meant.
 *
 * @param {AiBot} bot
 * @param {RobotsReport} robots
 * @param {ProdProbe[]} probes
 * @returns {string[]}
 */
function findConflicts(bot, robots, probes) {
  /** @type {string[]} */
  const conflicts = [];
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
  // What a conditional request is answered against, so it belongs beside the date.
  HEADERS.etag,
];

/**
 * @param {ProbeResult} result
 * @returns {Record<string, string>}
 */
function collectHeaders(result) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of INTERESTING_HEADERS) {
    const value = result.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/**
 * @param {string} url
 * @param {string} userAgent
 * @param {string} accept
 * @returns {string}
 */
function curlFor(url, userAgent, accept) {
  return `curl -sI -H 'User-Agent: ${userAgent}' -H 'Accept: ${accept}' '${url}'`;
}
