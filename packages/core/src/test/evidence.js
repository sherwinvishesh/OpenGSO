import { botUserAgent, routingProbeBot } from '../shared/bots.js';
import { BROWSER_ACCEPT, BROWSER_UA, HOSTILE_ACCEPT, OMNIGEO_UA, probe } from '../shared/http.js';
import { twinUrl } from '../shared/routes.js';
import { parseLinkAlternate } from '../prod/headers.js';
import { servesFile } from './checks-site.js';
import { fetchChildSitemaps } from './discover.js';

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
  // B9. OmniGEO's own User-Agent is on no bot list, so only the Accept header can route it.
  acceptMarkdown: { 'User-Agent': OMNIGEO_UA, Accept: 'text/markdown' },
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
 * @property {ProbeResult[]} [sitemapChildren] When `sitemap` is a sitemap index, the first `MAX_CHILD_SITEMAPS` sitemaps it lists,
 *   fetched. Absent or empty otherwise.
 * @property {ProbeResult} twin The markdown twin, fetched at its canonical URL (or the one the HTML advertised).
 * @property {string} twinUrl
 * @property {string} [folder] The folder of its host the site may live in, `https://user.github.io/repo/`, when llms.txt,
 *   sitemap.xml or the twin was looked for there too because the usual place had none.
 * @property {string} [advertisedTwinUrl]
 * @property {string} [foreignTwinUrl] A twin the HTML advertised on another origin, or with a scheme other than http(s). It is
 *   reported and never fetched: the audit is of this site, and a Link header is not permission to
 *   make OmniGEO request a third party's URL or read a `data:` body as if the site had served it.
 * @property {ProbeResult} acceptMarkdown Same page URL, asking for markdown by content negotiation.
 * @property {ProbeResult} botUa Same page URL, as a known AI bot, with no markdown preference expressed.
 * @property {string} [botName] The crawler `botUa` impersonated. Absent means GPTBot.
 * @property {ProbeResult} notAcceptable Same page URL, with an Accept header that allows neither HTML nor markdown.
 * @property {readonly AiBot[]} [bots] The crawler catalogue A1 reads robots.txt against. Defaults to the shipped list; a caller with
 *   a config in hand passes the resolved one so a project's own crawler is judged too.
 * @property {string} [publicOrigin] The project's `publicOrigin`. Generate writes a twin's links against it, so B14 reads a page
 *   tested anywhere else, a dev server or a preview of the build, as if it lived there.
 */

/**
 * @typedef {object} GatherOptions
 * @property {number} [timeoutMs]
 * @property {readonly AiBot[]} [bots]
 * @property {readonly string[]} [markdownRouting] The project's `bots.markdownRouting`, so B10 probes a crawler it actually routes.
 * @property {string} [publicOrigin]
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
    headers: { 'User-Agent': BROWSER_UA, Accept: BROWSER_ACCEPT },
    timeoutMs,
  });

  const { advertisedTwinUrl, foreignTwinUrl } = resolveAdvertised(html, target);
  const canonicalTwinUrl = advertisedTwinUrl ?? twinUrl(target.toString());

  const routed = routingProbeBot(options.markdownRouting, options.bots);
  const botHeaders = routed ? { ...PROBE_HEADERS.botUa, 'User-Agent': botUserAgent(routed, options.bots) } : PROBE_HEADERS.botUa;

  const twinHeaders = { Accept: 'text/markdown,*/*;q=0.5' };
  const [robots, rootLlms, rootSitemap, conventionalTwin, acceptMarkdown, botUa, notAcceptable] = await Promise.all([
    probe(new URL('/robots.txt', origin).toString(), { timeoutMs }),
    probe(new URL('/llms.txt', origin).toString(), { timeoutMs }),
    probe(new URL('/sitemap.xml', origin).toString(), { timeoutMs }),
    probe(canonicalTwinUrl, { headers: twinHeaders, timeoutMs }),
    probe(target.toString(), { headers: PROBE_HEADERS.acceptMarkdown, timeoutMs }),
    probe(target.toString(), { headers: botHeaders, timeoutMs }),
    probe(target.toString(), { headers: PROBE_HEADERS.notAcceptable, timeoutMs }),
  ]);

  // A site in a folder of its host, like a GitHub Pages project site at user.github.io/repo/, keeps
  // its llms.txt and sitemap in that folder, since the host's root belongs to somebody else, and
  // the twin of its home page is the folder's index.md. Each is looked for there only when the usual
  // place has none, so a site at the root of its host costs no extra request.
  const page = sameOriginUrl(html.finalUrl, target) ?? target;
  const folder = siteFolderOf(page);
  const homeTwin = !advertisedTwinUrl && page.pathname.endsWith('/') && page.pathname !== '/' ? `${page.origin}${page.pathname}index.md` : undefined;
  const [llms, sitemap, twin] = await Promise.all([
    folder && !servesFile(rootLlms) ? orElse(rootLlms, probe(new URL('llms.txt', folder).toString(), { timeoutMs })) : rootLlms,
    folder && !servesFile(rootSitemap) ? orElse(rootSitemap, probe(new URL('sitemap.xml', folder).toString(), { timeoutMs })) : rootSitemap,
    homeTwin && !servesFile(conventionalTwin) ? orElse(conventionalTwin, probe(homeTwin, { headers: twinHeaders, timeoutMs })) : conventionalTwin,
  ]);
  const sitemapChildren = await fetchChildSitemaps(sitemap, origin, timeoutMs);

  return {
    target,
    origin,
    html,
    robots,
    llms,
    sitemap,
    sitemapChildren,
    twin,
    twinUrl: twin === conventionalTwin ? canonicalTwinUrl : twin.url,
    folder: folder && (!servesFile(rootLlms) || !servesFile(rootSitemap)) ? folder : undefined,
    advertisedTwinUrl,
    foreignTwinUrl,
    acceptMarkdown,
    botUa,
    botName: routed?.name,
    notAcceptable,
    bots: options.bots,
    publicOrigin: options.publicOrigin,
  };
}

/**
 * The second place a file was looked for, when the file is there, or the first answer, which is the
 * one the report explains.
 *
 * @param {ProbeResult} first
 * @param {Promise<ProbeResult>} second
 * @returns {Promise<ProbeResult>}
 */
async function orElse(first, second) {
  const found = await second;
  return servesFile(found) ? found : first;
}

/**
 * The first folder of a page's path, `https://user.github.io/repo/` for `/repo/` or `/repo/about`,
 * which is where a site that lives in a folder of its host keeps its own files. A page at the top
 * of its host has none.
 *
 * @param {URL} page
 * @returns {string | undefined}
 */
export function siteFolderOf(page) {
  const [first, ...rest] = page.pathname.split('/').slice(1);
  return first && rest.length > 0 ? new URL(`/${first}/`, page.origin).toString() : undefined;
}

/**
 * @param {string} url
 * @param {URL} target
 * @returns {URL | undefined}
 */
function sameOriginUrl(url, target) {
  try {
    const parsed = new URL(url);
    return parsed.origin === target.origin ? parsed : undefined;
  } catch {
    return undefined;
  }
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
