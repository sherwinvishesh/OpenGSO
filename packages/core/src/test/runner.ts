import { JSDOM } from 'jsdom';
import { AI_BOTS } from '../shared/bots.js';
import { HEADERS, MARKDOWN_CONTENT_TYPE } from '../shared/version.js';
import { parseRobots } from '../prod/startup.js';
import { extractPage } from '../generate/extract.js';
import type { CheckResult } from './checks.js';
import { fail, na, pass } from './checks.js';
import type { Evidence } from './evidence.js';
import type { ProbeResult } from '../shared/http.js';

/**
 * The check implementations (idea.md §5).
 *
 * Every function here is pure over `Evidence`, so the whole checklist can be unit-tested against
 * synthetic responses with no network involved.
 */

/** Above this, TTFB is slow enough that agents fetching many pages will feel it. */
const TTFB_BUDGET_MS = 1200;
/** Below this word count, a page's raw HTML is not meaningfully extractable without running JS. */
const SSR_MIN_WORDS = 60;

export function runChecks(evidence: Evidence): CheckResult[] {
  return [
    checkRobots(evidence),
    checkLlmsTxt(evidence),
    checkSitemap(evidence),
    checkJsonLd(evidence),
    checkSsrExtractable(evidence),
    checkTtfb(evidence),
    checkNoAi(evidence),
    checkHttps(evidence),
    checkTwinReachable(evidence),
    checkTwinContentType(evidence),
    checkTwinNonEmpty(evidence),
    checkTokensHeader(evidence),
    checkNosniff(evidence),
    checkTwinNoindex(evidence),
    checkVaryAccept(evidence),
    checkLinkAlternate(evidence),
    checkAcceptNegotiation(evidence),
    checkBotUaNegotiation(evidence),
    checkNotAcceptable(evidence),
    checkAeoVersion(evidence),
    checkHtmlUnaffected(evidence),
  ];
}

// ---- Category A ------------------------------------------------------------------------------

function checkRobots(e: Evidence): CheckResult {
  if (!e.robots.ok) {
    return fail(
      'A1',
      `No robots.txt at ${e.robots.url} (HTTP ${e.robots.status || 'unreachable'}). AI crawlers get no explicit signal about what they may read.`,
    );
  }
  const groups = parseRobots(e.robots.body);
  const blockedAssistants: string[] = [];
  const blockedTraining: string[] = [];

  for (const bot of AI_BOTS) {
    const rules = groups.get(bot.robotsToken.toLowerCase()) ?? groups.get('*');
    if (!rules) continue;
    const blockedAtRoot = rules.some((rule) => rule.type === 'disallow' && rule.path === '/');
    if (!blockedAtRoot) continue;
    if (bot.kind === 'training') blockedTraining.push(bot.name);
    else blockedAssistants.push(bot.name);
  }

  if (blockedAssistants.length > 0) {
    return fail(
      'A1',
      `robots.txt disallows ${blockedAssistants.join(', ')} at /. These are live assistant and search agents - blocking them removes the site from AI answers entirely.`,
      blockedTraining.length > 0 ? `Also blocking training crawlers: ${blockedTraining.join(', ')}.` : undefined,
    );
  }
  if (blockedTraining.length > 0) {
    return pass(
      'A1',
      `robots.txt allows every assistant and search agent. Bulk training crawlers (${blockedTraining.join(', ')}) are disallowed, which reads as a deliberate opt-out rather than a mistake.`,
    );
  }
  return pass('A1', 'robots.txt is present and does not disallow any known AI bot.');
}

function checkLlmsTxt(e: Evidence): CheckResult {
  if (!e.llms.ok) {
    return fail('A2', `No llms.txt at ${e.llms.url} (HTTP ${e.llms.status || 'unreachable'}).`);
  }
  const body = e.llms.body.trim();
  if (!body) return fail('A2', 'llms.txt exists but is empty.');
  if (!/^#\s+\S/m.test(body)) {
    return fail('A2', 'llms.txt has no `# Title` heading, which the llms.txt convention requires as its first line.');
  }
  const links = (body.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  if (links === 0) {
    return fail('A2', 'llms.txt has a title but lists no links, so an agent reading it learns nothing about the site.');
  }
  return pass('A2', `llms.txt is present and valid, listing ${links} link${links === 1 ? '' : 's'}.`);
}

function checkSitemap(e: Evidence): CheckResult {
  if (!e.sitemap.ok) {
    return fail('A3', `No sitemap.xml at ${e.sitemap.url} (HTTP ${e.sitemap.status || 'unreachable'}).`);
  }
  const body = e.sitemap.body;
  if (!/<(urlset|sitemapindex)[\s>]/i.test(body)) {
    return fail('A3', 'sitemap.xml exists but has no <urlset> or <sitemapindex> root element.');
  }
  const locs = (body.match(/<loc>/gi) ?? []).length;
  if (locs === 0) return fail('A3', 'sitemap.xml parses but contains no <loc> entries.');
  return pass('A3', `sitemap.xml is present and valid, listing ${locs} URL${locs === 1 ? '' : 's'}.`);
}

function checkJsonLd(e: Evidence): CheckResult {
  if (!e.html.ok || !e.html.body) return fail('A4', 'Could not read the HTML response to look for JSON-LD.');
  const dom = new JSDOM(e.html.body, { url: e.target.toString() });
  const blocks = Array.from(dom.window.document.querySelectorAll('script[type="application/ld+json"]'));
  if (blocks.length === 0) {
    dom.window.close();
    return fail('A4', 'No Schema.org JSON-LD found. Agents have no structured description of what this page is.');
  }
  const types: string[] = [];
  const broken: string[] = [];
  for (const block of blocks) {
    const raw = block.textContent?.trim() ?? '';
    try {
      collectTypes(JSON.parse(raw), types);
    } catch (error) {
      broken.push(error instanceof Error ? error.message : String(error));
    }
  }
  dom.window.close();

  if (broken.length > 0) {
    return fail('A4', `A JSON-LD block is present but does not parse: ${broken[0]}`);
  }
  if (types.length === 0) {
    return fail('A4', 'JSON-LD is present and parses, but declares no @type, so it describes nothing.');
  }
  return pass('A4', `JSON-LD present and valid: ${unique(types).join(', ')}.`);
}

function collectTypes(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const type = record['@type'];
  if (typeof type === 'string') out.push(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') out.push(t);
  if (Array.isArray(record['@graph'])) collectTypes(record['@graph'], out);
}

function checkSsrExtractable(e: Evidence): CheckResult {
  if (!e.html.ok || !e.html.body) {
    return fail('A5', `The page did not return usable HTML (HTTP ${e.html.status || 'unreachable'}).`);
  }
  const extracted = extractPage(e.html.body, { url: e.target.toString(), minWords: SSR_MIN_WORDS });
  if (extracted.wordCount >= SSR_MIN_WORDS) {
    return pass(
      'A5',
      `${extracted.wordCount} words of real content are present in the raw HTML, so agents that do not run JavaScript still see the page.`,
      `Extracted from <${extracted.contentRoot}>.`,
    );
  }
  const emptyRoot = /<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(e.html.body);
  return fail(
    'A5',
    emptyRoot
      ? 'The raw HTML contains an empty mount element and almost no text: this page is client-rendered, so agents that do not execute JavaScript see nothing.'
      : `Only ${extracted.wordCount} words of extractable content in the raw HTML (need ${SSR_MIN_WORDS}). Agents that do not run JavaScript will see close to nothing.`,
  );
}

function checkTtfb(e: Evidence): CheckResult {
  if (!e.html.ok) return na('A6', 'The page did not respond, so there is no time-to-first-byte to measure.');
  if (e.html.ttfbMs <= TTFB_BUDGET_MS) {
    return pass('A6', `Time to first byte was ${e.html.ttfbMs}ms, within the ${TTFB_BUDGET_MS}ms budget.`);
  }
  return fail(
    'A6',
    `Time to first byte was ${e.html.ttfbMs}ms, over the ${TTFB_BUDGET_MS}ms budget. Agents fetching several pages will feel this.`,
  );
}

function checkNoAi(e: Evidence): CheckResult {
  const found: string[] = [];
  const headerValue = e.html.headers.get(HEADERS.robotsTag) ?? '';
  if (/\bnoai\b/i.test(headerValue)) found.push(`X-Robots-Tag: ${headerValue}`);
  if (/\bnoimageai\b/i.test(headerValue)) found.push(`X-Robots-Tag: ${headerValue}`);

  if (e.html.body) {
    const dom = new JSDOM(e.html.body, { url: e.target.toString() });
    for (const meta of Array.from(dom.window.document.querySelectorAll('meta[name], meta[property]'))) {
      const name = (meta.getAttribute('name') ?? meta.getAttribute('property') ?? '').toLowerCase();
      const content = meta.getAttribute('content') ?? '';
      if (!['robots', 'googlebot'].includes(name) && !name.includes('ai')) continue;
      if (/\bnoai\b|\bnoimageai\b/i.test(content) || /\bnoai\b|\bnoimageai\b/i.test(name)) {
        found.push(`<meta name="${name}" content="${content}">`);
      }
    }
    dom.window.close();
  }

  if (found.length > 0) {
    return fail(
      'A7',
      `An AI opt-out tag is set on this page: ${unique(found)[0]}. This tells AI tools to skip the page entirely - remove it unless the opt-out is intentional.`,
    );
  }
  return pass('A7', 'No noai or noimageai opt-out tag is set.');
}

function checkHttps(e: Evidence): CheckResult {
  const host = e.target.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return na('A8', 'Local development target - HTTPS and HSTS are not meaningful here.');
  }
  if (e.target.protocol !== 'https:') {
    return fail('A8', 'The site is served over plain HTTP. Some agents refuse insecure origins outright.');
  }
  const hsts = e.html.headers.get('strict-transport-security');
  if (!hsts) return fail('A8', 'Served over HTTPS, but no Strict-Transport-Security header is set.');
  return pass('A8', `Served over HTTPS with HSTS (${hsts}).`);
}

// ---- Category B ------------------------------------------------------------------------------

function isMarkdownResponse(response: ProbeResult): boolean {
  const contentType = response.headers.get(HEADERS.contentType) ?? '';
  return contentType.toLowerCase().includes('text/markdown');
}

function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(body);
}

function checkTwinReachable(e: Evidence): CheckResult {
  if (e.twin.error) return fail('B1', `Could not reach the markdown twin at ${e.twinUrl}: ${e.twin.error}`);
  if (!e.twin.ok) {
    return fail(
      'B1',
      `The markdown twin at ${e.twinUrl} returned HTTP ${e.twin.status}. Agents that follow the .md convention get nothing.`,
    );
  }
  return pass('B1', `The markdown twin at ${e.twinUrl} returned HTTP ${e.twin.status}.`);
}

function checkTwinContentType(e: Evidence): CheckResult {
  const actual = e.twin.headers.get(HEADERS.contentType);
  if (!e.twin.ok) return fail('B2', `No markdown twin response to inspect (HTTP ${e.twin.status || 'unreachable'}).`);
  if (!actual) return fail('B2', 'The markdown twin response has no Content-Type header at all.');
  const normalized = actual.toLowerCase().replace(/\s*;\s*/g, '; ').trim();
  if (normalized === MARKDOWN_CONTENT_TYPE) return pass('B2', `Content-Type is exactly ${MARKDOWN_CONTENT_TYPE}.`);
  return fail(
    'B2',
    `Content-Type is "${actual}", not "${MARKDOWN_CONTENT_TYPE}". Agents sniffing the type may treat the body as HTML or plain text.`,
  );
}

function checkTwinNonEmpty(e: Evidence): CheckResult {
  if (!e.twin.ok) return fail('B3', `No markdown twin response to inspect (HTTP ${e.twin.status || 'unreachable'}).`);
  const body = e.twin.body.trim();
  if (!body) return fail('B3', 'The markdown twin responded 2xx with an empty body.');
  if (looksLikeHtml(body)) {
    return fail('B3', 'The markdown twin URL returned an HTML document, not markdown. The route is being handled by the normal page renderer.');
  }
  return pass('B3', `The markdown twin returned ${body.length} characters of markdown.`);
}

function checkTokensHeader(e: Evidence): CheckResult {
  const raw = e.twin.headers.get(HEADERS.markdownTokens);
  if (!raw) {
    return fail('B4', `No ${HEADERS.markdownTokens} header, so an agent cannot gauge the response size before fetching it.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fail('B4', `${HEADERS.markdownTokens} is "${raw}", which is not a positive integer.`);
  }
  return pass('B4', `${HEADERS.markdownTokens}: ${value}.`);
}

function checkNosniff(e: Evidence): CheckResult {
  const value = e.twin.headers.get(HEADERS.contentTypeOptions);
  if (value?.toLowerCase().trim() === 'nosniff') return pass('B5', 'X-Content-Type-Options: nosniff is set on the markdown response.');
  return fail('B5', value ? `X-Content-Type-Options is "${value}", not "nosniff".` : 'No X-Content-Type-Options header on the markdown response.');
}

function checkTwinNoindex(e: Evidence): CheckResult {
  const value = e.twin.headers.get(HEADERS.robotsTag);
  if (!value) {
    return fail('B6', 'No X-Robots-Tag on the markdown twin, so search engines may index it as duplicate content alongside the HTML page.');
  }
  if (!/\bnoindex\b/i.test(value)) return fail('B6', `X-Robots-Tag is "${value}" and does not include noindex.`);
  return pass('B6', `X-Robots-Tag includes noindex ("${value}").`);
}

/**
 * `Vary` is a comma-separated list of field names, so this has to compare whole tokens. Matching
 * the substring "accept" would count `Vary: Accept-Encoding` - which almost every compressed
 * response carries - as a pass, and the check would never fail on a real site.
 */
function varyIncludesAccept(value: string): boolean {
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .some((token) => token === 'accept' || token === '*');
}

function checkVaryAccept(e: Evidence): CheckResult {
  const htmlVary = e.html.headers.get(HEADERS.vary) ?? '';
  const twinVary = e.twin.headers.get(HEADERS.vary) ?? '';
  const htmlOk = varyIncludesAccept(htmlVary);
  const twinOk = varyIncludesAccept(twinVary);

  if (htmlOk && twinOk) return pass('B7', 'Vary: Accept is set on both the HTML and the markdown response.');
  const missing = [!htmlOk ? 'the HTML response' : null, !twinOk ? 'the markdown response' : null].filter(Boolean);
  return fail(
    'B7',
    `Vary does not include Accept on ${missing.join(' or ')}. A CDN will cache one format and serve it to visitors asking for the other.`,
    `HTML Vary: "${htmlVary || 'absent'}"; markdown Vary: "${twinVary || 'absent'}".`,
  );
}

function checkLinkAlternate(e: Evidence): CheckResult {
  if (e.advertisedTwinUrl) {
    return pass('B8', `The HTML response advertises its markdown twin: Link rel="alternate" -> ${e.advertisedTwinUrl}`);
  }
  const link = e.html.headers.get(HEADERS.link);
  return fail(
    'B8',
    link
      ? `The HTML response has a Link header ("${link}") but no rel="alternate" entry of type text/markdown.`
      : 'The HTML response has no Link rel="alternate" header, so an agent has to guess the markdown twin URL.',
  );
}

function checkAcceptNegotiation(e: Evidence): CheckResult {
  if (!e.acceptMarkdown.ok) {
    return fail('B9', `A request with Accept: text/markdown returned HTTP ${e.acceptMarkdown.status || 'nothing'}.`);
  }
  if (isMarkdownResponse(e.acceptMarkdown)) {
    return pass('B9', 'A request with Accept: text/markdown received markdown at the same URL.');
  }
  return fail(
    'B9',
    `A request with Accept: text/markdown received "${e.acceptMarkdown.headers.get(HEADERS.contentType) ?? 'no Content-Type'}" instead of markdown. Content negotiation is not wired up.`,
  );
}

function checkBotUaNegotiation(e: Evidence): CheckResult {
  if (!e.botUa.ok) return fail('B10', `A GPTBot-identified request returned HTTP ${e.botUa.status || 'nothing'}.`);
  if (isMarkdownResponse(e.botUa)) {
    return pass('B10', 'A known AI bot User-Agent received markdown without needing to send an Accept header.');
  }
  return fail(
    'B10',
    `A GPTBot User-Agent received "${e.botUa.headers.get(HEADERS.contentType) ?? 'no Content-Type'}". Most AI crawlers never send Accept: text/markdown, so User-Agent routing is what actually reaches them.`,
  );
}

function checkNotAcceptable(e: Evidence): CheckResult {
  if (e.notAcceptable.status === 406) {
    return pass('B11', 'An Accept header excluding both HTML and markdown correctly returned 406 Not Acceptable.');
  }
  return fail(
    'B11',
    `An Accept: application/json request returned HTTP ${e.notAcceptable.status || 'nothing'} instead of 406 Not Acceptable.`,
  );
}

function checkAeoVersion(e: Evidence): CheckResult {
  const value = e.twin.headers.get(HEADERS.aeoVersion) ?? e.acceptMarkdown.headers.get(HEADERS.aeoVersion);
  if (value) return pass('B12', `X-AEO-Version advertises "${value}".`);
  return fail('B12', 'No X-AEO-Version header, so an agent cannot tell which serving spec this site implements.');
}

function checkHtmlUnaffected(e: Evidence): CheckResult {
  if (!e.html.ok) return fail('B13', `The original HTML URL returned HTTP ${e.html.status || 'nothing'}.`);
  const contentType = e.html.headers.get(HEADERS.contentType) ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return fail('B13', `A normal browser request received "${contentType}" instead of HTML. Human visitors are being served the wrong format.`);
  }
  if (!e.html.body.trim()) return fail('B13', 'The original HTML URL returned an empty body to a normal browser request.');
  return pass('B13', 'A normal browser request still receives the real HTML page, unchanged.');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
