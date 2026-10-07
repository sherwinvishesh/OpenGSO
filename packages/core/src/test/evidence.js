import { botUserAgent, routingProbeBot } from '../shared/bots.js';
import { BROWSER_UA, HOSTILE_ACCEPT, OPENGEO_UA, probe } from '../shared/http.js';
import { twinUrl } from '../shared/routes.js';
import { parseLinkAlternate } from '../prod/headers.js';

/**
 * @import { AiBot } from '../shared/bots.js'
 * @import { ProbeResult } from '../shared/http.js'
 */

/**
 * Everything the checks need, gathered in one pass.
 *
 * Probing is separated from checking so the check functions stay pure and testable against
 * synthetic evidence - no network, no timing flakiness, in the unit tests.
 */

/** A User-Agent a site would recognise as a well-known AI crawler. Used for the B10 probe. */
export const GPTBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';

/**
 * What the three live-URL probes send, each built so that only one lever can explain a markdown
 * answer. docs/checks.md quotes these, and docs.test.js holds it to that.
 */
export const PROBE_HEADERS = {
  // B9. OpenGEO's own User-Agent is on no bot list, so only the Accept header can route it.
  acceptMarkdown: { 'User-Agent': OPENGEO_UA, Accept: 'text/markdown' },
  // B10. Any type, which is what most crawlers send, and expresses no preference for markdown.
  botUa: { 'User-Agent': GPTBOT_UA, Accept: '*/*' },
  // B11. Neither HTML nor markdown.
  notAcceptable: { Accept: HOSTILE_ACCEPT },
};

/**
 * @typedef {object} Evidence
 * @property {URL} target
 * @property {string} origin
 * @property {ProbeResult} html The page fetched the way a browser would.
 * @property {ProbeResult} robots
 * @property {ProbeResult} llms
 * @property {ProbeResult} sitemap
 * @property {ProbeResult} twin The markdown twin, fetched at its canonical URL (or the one the HTML advertised).
 * @property {string} twinUrl
 * @property {string} [advertisedTwinUrl]
 * @property {string} [foreignTwinUrl] A twin the HTML advertised on another origin, or with a scheme other than http(s). It is
 *   reported and never fetched: the audit is of this site, and a Link header is not permission to
 *   make OpenGEO request a third party's URL or read a `data:` body as if the site had served it.
 * @property {ProbeResult} acceptMarkdown Same page URL, asking for markdown by content negotiation.
 * @property {ProbeResult} botUa Same page URL, as a known AI bot, with no markdown preference expressed.
 * @property {string} [botName] The crawler `botUa` impersonated. Absent means GPTBot.
 * @property {ProbeResult} notAcceptable Same page URL, with an Accept header that allows neither HTML nor markdown.
 * @property {readonly AiBot[]} [bots] The crawler catalogue A1 reads robots.txt against. Defaults to the shipped list; a caller with
 *   a config in hand passes the resolved one so a project's own crawler is judged too.
 */

/**
 * @typedef {object} GatherOptions
 * @property {number} [timeoutMs]
 * @property {readonly AiBot[]} [bots]
 * @property {readonly string[]} [markdownRouting] The project's `bots.markdownRouting`, so B10 probes a crawler it actually routes.
 */

/**
 * @param {URL} target
 * @param {GatherOptions} [options]
 * @returns {Promise<Evidence>}
 */
export async function gatherEvidence(target, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const origin = target.origin;

  const html = await probe(target.toString(), {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    timeoutMs,
  });

  const { advertisedTwinUrl, foreignTwinUrl } = resolveAdvertised(html, target);
  const canonicalTwinUrl = advertisedTwinUrl ?? twinUrl(target.toString());

  const routed = routingProbeBot(options.markdownRouting, options.bots);
  const botHeaders = routed ? { ...PROBE_HEADERS.botUa, 'User-Agent': botUserAgent(routed, options.bots) } : PROBE_HEADERS.botUa;

  const [robots, llms, sitemap, twin, acceptMarkdown, botUa, notAcceptable] = await Promise.all([
    probe(new URL('/robots.txt', origin).toString(), { timeoutMs }),
    probe(new URL('/llms.txt', origin).toString(), { timeoutMs }),
    probe(new URL('/sitemap.xml', origin).toString(), { timeoutMs }),
    probe(canonicalTwinUrl, { headers: { Accept: 'text/markdown,*/*;q=0.5' }, timeoutMs }),
    probe(target.toString(), { headers: PROBE_HEADERS.acceptMarkdown, timeoutMs }),
    probe(target.toString(), { headers: botHeaders, timeoutMs }),
    probe(target.toString(), { headers: PROBE_HEADERS.notAcceptable, timeoutMs }),
  ]);

  return {
    target,
    origin,
    html,
    robots,
    llms,
    sitemap,
    twin,
    twinUrl: canonicalTwinUrl,
    advertisedTwinUrl,
    foreignTwinUrl,
    acceptMarkdown,
    botUa,
    botName: routed?.name,
    notAcceptable,
    bots: options.bots,
  };
}

/**
 * The advertised twin, if it is on this origin; otherwise what was advertised, to report.
 *
 * @param {ProbeResult} html
 * @param {URL} target
 * @returns {{ advertisedTwinUrl?: string; foreignTwinUrl?: string }}
 */
function resolveAdvertised(html, target) {
  const advertised = parseLinkAlternate(html.headers.get('link'));
  if (!advertised) return {};
  /** @type {URL} */
  let url;
  try {
    url = new URL(advertised, target);
  } catch {
    return {};
  }
  // The same rule discover.js applies to llms.txt and sitemap links.
  const sameSite = (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === target.origin;
  return sameSite ? { advertisedTwinUrl: url.toString() } : { foreignTwinUrl: advertised };
}
