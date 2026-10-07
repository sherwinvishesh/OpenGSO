import { JSDOM } from 'jsdom';
import { AI_BOTS } from '../shared/bots.js';
import { HEADERS, MARKDOWN_CONTENT_TYPE } from '../shared/version.js';
import { HOSTILE_ACCEPT, parseUrl } from '../shared/http.js';
import { parseRobots, robotsAllows, robotsRulesFor } from '../shared/robots.js';
import { varyIncludesAccept } from '../prod/headers.js';
import { extractPage } from '../generate/extract.js';
import { parseFrontmatter } from '../generate/frontmatter.js';
import { verifyFidelity } from '../generate/fidelity.js';
import { contentHash } from '../shared/hash.js';
import { checkDefinition } from './checks.js';
import { fail, na, partial, pass, ramp } from './checks.js';
import { isSitemapIndex, looksLikeHtml, MAX_CHILD_SITEMAPS, sitemapLocs } from './discover.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 * @import { ProbeResult } from '../shared/http.js'
 */

/**
 * The check implementations (§5).
 *
 * Every function here is pure over `Evidence`, so the whole checklist can be unit-tested against
 * synthetic responses with no network involved.
 */

/**
 * The two ends of the TTFB ramp.
 *
 * A single budget could only ever answer "fast enough, yes or no", which is the wrong shape for a
 * number that is continuous in reality: 420ms and 3.2s are both "over budget" and are not remotely
 * the same problem. Anything at or under `TTFB_FAST_MS` is unimprovable from an agent's point of
 * view; past `TTFB_SLOW_MS` a crawler with a short timeout is dropping the page, so there is
 * nothing left to award. In between the score slides, which is also the only way the report can
 * show progress on a page someone is actively optimising.
 */
export const TTFB_FAST_MS = 400;
export const TTFB_SLOW_MS = 1500;
/** Below this word count, a page's raw HTML is not meaningfully extractable without running JS. */
export const SSR_MIN_WORDS = 60;
/** Under this, there is so little text that partial credit would be flattery rather than measurement. */
export const SSR_FLOOR_WORDS = 15;
/**
 * How much shorter than the live page a twin may be and still count as complete.
 *
 * Markdown is denser than rendered text, and a good twin drops navigation, cookie banners and
 * footers, so it is legitimately shorter. Half is generous on purpose: this check is looking for a
 * stub, not auditing prose.
 */
export const TWIN_FULL_RATIO = 0.5;
export const TWIN_FLOOR_RATIO = 0.08;

/**
 * @param {Evidence} evidence
 * @returns {CheckResult[]}
 */
export function runChecks(evidence) {
  return collapseTwinCascade([
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
    checkDrift(evidence),
  ], evidence);
}

/**
 * One missing twin costs one check, not twelve (§5).
 *
 * Without this, a site that has simply never installed OpenGEO fails B1 and then fails eleven more
 * checks that are all restatements of the same fact: you cannot inspect the Content-Type of a
 * document that does not exist, and reporting that as eleven separate defects is not a measurement,
 * it is an echo. It also wrecks the scale. anthropic.com and openai.com are well-built sites that
 * an agent can read perfectly well, and the uncollapsed scorer put both at 38/100, which tells the
 * reader nothing except that the number is not to be trusted.
 *
 * So when the twin URL does not answer, everything downstream of it leaves the denominator and the
 * whole verdict on the markdown layer is carried by B1, the heaviest check in the table. Those two
 * sites now score 80: the fundamentals are all there, the markdown layer is not, and the gap
 * between them is one line in the report instead of twelve.
 *
 * They leave as `locked`, not as `na`. That distinction is the entire difference between a report
 * that says "twelve things do not apply to you" and one that says "twelve things worth 46
 * points are waiting behind a single missing file". The arithmetic is identical; only one of them
 * tells the reader what to do next.
 *
 * A twin that exists but is wrong is a different situation and is still scored in full detail.
 *
 * @param {CheckResult[]} results
 * @param {Evidence} e
 * @returns {CheckResult[]}
 */
function collapseTwinCascade(results, e) {
  if (servesFile(e.twin)) return results;

  return results.map((result) => {
    const why = LOCKED_ON_TWIN[result.id] ?? (result.status === 'pass' ? undefined : LOCKED_ON_LIVE_URL[result.id]);
    if (!why) return result;
    return {
      ...result,
      status: /** @type {const} */ ('locked'),
      earned: 0,
      lockedBy: 'B1',
      reason: `No markdown twin at ${e.twinUrl}, so ${why}. The missing twin is scored once, on B1.`,
      // What the live site actually said is worth keeping: an AI crawler getting a 403 is a real
      // finding even though it is not this check's to score.
      detail: result.id in LOCKED_ON_LIVE_URL ? result.detail ?? result.reason : result.detail,
    };
  });
}

// Read off the twin response itself. With no twin there is nothing to read, pass or fail: B5
// "passing" because a 404 page happened to carry nosniff is noise, not a point earned.
/** @type {Record<string, string>} */
const LOCKED_ON_TWIN = {
  B2: 'there is no twin response whose Content-Type could be checked',
  B3: 'there is no twin body to measure',
  B4: 'there is no twin response to carry a token count',
  B5: 'there is no twin response to carry the header',
  B6: 'there is no twin response to keep out of the search index',
  B12: 'there is no markdown response to advertise a spec version on',
  B14: 'there is no twin that could have drifted',
};

// Probed against the live URL. These can genuinely succeed without a `.md` twin - a site can wire
// Accept negotiation at the same URL - so a pass is kept and anything short of one is locked. A
// partial is locked too: kept in the denominator, a `Vary: Accept` on the HTML alone cost the site
// points it would not have lost by sending nothing.
/** @type {Record<string, string>} */
const LOCKED_ON_LIVE_URL = {
  B7: 'there are not two formats for a CDN to cache apart',
  B8: 'there is no twin for the HTML page to advertise',
  B9: 'there is no markdown representation to negotiate for',
  B10: 'there is no markdown to route a crawler to',
  B11: 'a site serving one format has nothing to refuse',
};

/**
 * Every check the cascade can take out of the denominator.
 *
 * The report prices this list as one block, and docs.test.js adds up their weights to check the
 * number written in docs/checks.md is the number the code would actually produce.
 *
 * @type {readonly string[]}
 */
export const TWIN_LOCKED_IDS = [...Object.keys(LOCKED_ON_TWIN), ...Object.keys(LOCKED_ON_LIVE_URL)];

/**
 * A 2xx that is the file it claims to be, rather than an HTML page standing in for it.
 *
 * A single-page app or a catch-all route answers 200 with its shell for every path. Reading that
 * shell as a robots.txt, an llms.txt or a markdown twin hands out points for files the site does
 * not have, and with the twin it also keeps the cascade from locking.
 *
 * @param {ProbeResult} response
 * @returns {boolean}
 */
function servesFile(response) {
  return response.ok && !looksLikeHtml(response.body);
}

// ---- Category A ------------------------------------------------------------------------------

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkRobots(e) {
  if (!e.robots.ok) {
    return fail(
      'A1',
      `No robots.txt at ${e.robots.url} (HTTP ${e.robots.status || 'unreachable'}). AI crawlers get no explicit signal about what they may read.`,
      undefined,
      'Serve a robots.txt that allows the AI agents you want reading the site (+9). `opengeo generate` writes one.',
    );
  }
  if (!servesFile(e.robots)) {
    return fail(
      'A1',
      `${e.robots.url} answered with an HTML page, not a robots.txt. A catch-all route is handling it, so AI crawlers get no robots rules at all.`,
      undefined,
      'Serve a real robots.txt ahead of the catch-all route (+9). `opengeo generate` writes one.',
    );
  }
  const groups = parseRobots(e.robots.body);
  // The page under test, path and query, which is what a crawler matches the rules against.
  const path = `${e.target.pathname}${e.target.search}`;
  /** @type {string[]} */
  const blockedAssistants = [];
  /** @type {string[]} */
  const blockedTraining = [];
  let wholeSite = true;

  for (const bot of e.bots ?? AI_BOTS) {
    const rules = robotsRulesFor(groups, bot.robotsToken);
    if (!rules || robotsAllows(rules, path)) continue;
    if (bot.kind === 'training') {
      blockedTraining.push(bot.name);
      continue;
    }
    blockedAssistants.push(bot.name);
    if (robotsAllows(rules, '/')) wholeSite = false;
  }

  if (blockedAssistants.length > 0) {
    return fail(
      'A1',
      wholeSite
        ? `robots.txt disallows ${blockedAssistants.join(', ')} from ${path}. These are live assistant and search agents - blocking them removes the site from AI answers entirely.`
        : `robots.txt disallows ${blockedAssistants.join(', ')} from ${path}. These are live assistant and search agents - blocking them keeps this page out of AI answers.`,
      blockedTraining.length > 0 ? `Also blocking training crawlers: ${blockedTraining.join(', ')}.` : undefined,
      `Remove the Disallow rule that covers ${path} for ${blockedAssistants.join(', ')} (+9). These are the agents that answer questions about the site.`,
    );
  }
  if (blockedTraining.length > 0) {
    // Deliberate, and read as deliberate: the assistants that answer questions about this site are
    // all still allowed, which is the part that decides whether the site appears in AI answers at
    // all. What it costs is the training corpus, so most of the weight stays and the report says
    // plainly that the remainder is a policy choice rather than a bug to go and fix.
    return partial(
      'A1',
      6,
      `robots.txt allows every assistant and search agent. Bulk training crawlers (${blockedTraining.join(', ')}) are disallowed, which reads as a deliberate opt-out rather than a mistake.`,
      { fix: `Allow ${blockedTraining.join(', ')} as well if the opt-out was not intended (+3). If it was, this is the right configuration and those points are the price of it.` },
    );
  }
  return pass('A1', 'robots.txt is present and does not disallow any known AI bot.');
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkLlmsTxt(e) {
  if (!e.llms.ok) {
    return fail(
      'A2',
      `No llms.txt at ${e.llms.url} (HTTP ${e.llms.status || 'unreachable'}).`,
      undefined,
      'Serve /llms.txt with a title and your key pages as markdown links (+3). `opengeo generate` writes it.',
    );
  }
  if (!servesFile(e.llms)) {
    return fail(
      'A2',
      `${e.llms.url} answered with an HTML page, not an llms.txt. A catch-all route is handling it.`,
      undefined,
      'Serve a real /llms.txt ahead of the catch-all route (+3). `opengeo generate` writes it.',
    );
  }
  const body = e.llms.body.trim();
  const links = (body.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const hasTitle = /^#\s+\S/m.test(body);

  if (!body) {
    return partial('A2', 1, 'llms.txt exists but is empty. The file is being served, which is most of the plumbing.', {
      fix: 'Add a `# Title` line and a list of your key pages as markdown links (+2). `opengeo generate` writes it for you.',
    });
  }
  if (links === 0) {
    return partial('A2', 1, 'llms.txt lists no links, so an agent reading it learns nothing about the site.', {
      fix: 'List your key pages as markdown links under a `## Pages` heading (+2).',
    });
  }
  if (!hasTitle) {
    return partial('A2', 2, `llms.txt lists ${links} link${links === 1 ? '' : 's'} but has no \`# Title\` heading, which the convention requires as its first line.`, {
      fix: 'Add a `# Site name` first line, and a one-line `> description` under it (+1).',
    });
  }
  return pass('A2', `llms.txt is present and valid, listing ${links} link${links === 1 ? '' : 's'}.`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkSitemap(e) {
  if (!e.sitemap.ok) {
    return fail(
      'A3',
      `No sitemap.xml at ${e.sitemap.url} (HTTP ${e.sitemap.status || 'unreachable'}).`,
      undefined,
      'Serve a /sitemap.xml listing every page (+9). `opengeo generate` builds one from a crawl.',
    );
  }
  const body = e.sitemap.body;
  if (!/<(urlset|sitemapindex)[\s>]/i.test(body)) {
    return partial('A3', 3, 'Something answers at /sitemap.xml, but it has no <urlset> or <sitemapindex> root element, so no crawler will read it as a sitemap.', {
      detail: `First 80 characters: ${JSON.stringify(body.slice(0, 80))}`,
      fix: 'Serve a real sitemap: `<urlset>` with one `<url><loc>` per page (+6). `opengeo generate` writes one from the crawl.',
    });
  }
  if (isSitemapIndex(body)) return checkSitemapIndex(e);
  const listed = Array.from(body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi), (match) => /** @type {string} */ (match[1]));
  const locs = listed.length;
  if (locs === 0) {
    return partial('A3', 3, 'sitemap.xml parses but contains no <loc> entries, so it advertises nothing.', {
      fix: 'Add one `<url><loc>` per page (+6).',
    });
  }
  // The page being tested is the one URL known for certain to exist, so a sitemap that omits it is
  // demonstrably incomplete. This is a weaker statement than a full crawl comparison and is the
  // strongest one the evidence supports, which is why the reason says exactly what was checked.
  //
  // Compared as parsed paths rather than as a substring of the document. The pathname of a homepage
  // is "/", every sitemap ever written contains a slash, and a substring test therefore handed a
  // free pass to exactly the case people test first.
  const listsTarget = listed.some((loc) => locPath(loc, e.target) === locPath(e.target.pathname, e.target));
  if (!listsTarget) {
    return partial('A3', 6, `sitemap.xml is valid and lists ${locs} URL${locs === 1 ? '' : 's'}, but ${e.target.pathname} is not one of them, so at least one real page is missing from it.`, {
      fix: `Add ${e.target.pathname} and any other pages the sitemap is missing (+3). \`opengeo generate\` rebuilds it from a crawl.`,
    });
  }
  return pass('A3', `sitemap.xml is present and valid, listing ${locs} URL${locs === 1 ? '' : 's'}.`);
}

/**
 * A3 for a `<sitemapindex>`, whose `<loc>`s are other sitemaps rather than pages.
 *
 * The page under test can only ever be in one of the children, so the children are what is read.
 * When the index lists more than were fetched and none of those lists the page, nothing true can be
 * said about the rest, so it passes with the limit in the detail rather than charging for a page
 * that may well be in sitemap number eleven.
 *
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkSitemapIndex(e) {
  const declared = sitemapLocs(e.sitemap.body, e.origin).length;
  const children = (e.sitemapChildren ?? []).filter((child) => child.ok && /<urlset[\s>]/i.test(child.body));
  const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (children.length === 0) {
    return partial('A3', 3, `sitemap.xml is a sitemap index listing ${plural(declared, 'sitemap')}, but none that was fetched answered with a <urlset>, so it advertises no pages.`, {
      fix: 'Serve each sitemap the index lists, as a `<urlset>` with one `<url><loc>` per page (+6).',
    });
  }
  const pages = children.flatMap((child) => sitemapLocs(child.body, e.origin));
  const target = locPath(e.target.pathname, e.target);
  const read = `${plural(children.length, 'sitemap')} it lists`;
  if (pages.some((loc) => locPath(loc.toString(), e.target) === target)) {
    return pass('A3', `sitemap.xml is a sitemap index, and ${e.target.pathname} is listed in the ${read}.`);
  }
  if (declared > MAX_CHILD_SITEMAPS) {
    return pass(
      'A3',
      `sitemap.xml is a valid sitemap index listing ${plural(declared, 'sitemap')}.`,
      `${e.target.pathname} is not in the first ${MAX_CHILD_SITEMAPS}, and the rest were not fetched.`,
    );
  }
  return partial('A3', 6, `sitemap.xml is a sitemap index, and none of the ${read} include ${e.target.pathname}, so at least one real page is missing from them.`, {
    fix: `Add ${e.target.pathname} and any other missing pages to one of the sitemaps the index lists (+3). \`opengeo generate\` writes a single sitemap from a crawl.`,
  });
}

/**
 * The path a `<loc>` points at, tolerant of a relative entry, compared without a trailing slash.
 *
 * @param {string} loc
 * @param {URL} base
 * @returns {string}
 */
function locPath(loc, base) {
  try {
    return new URL(loc, base).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return loc.replace(/\/+$/, '') || '/';
  }
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkJsonLd(e) {
  if (!e.html.ok || !e.html.body)
    return fail(
      'A4',
      'Could not read the HTML response to look for JSON-LD.',
      undefined,
      'Get the page returning HTML first; this check reads the markup for a JSON-LD block (+2).',
    );
  const dom = new JSDOM(e.html.body, { url: e.target.toString() });
  const blocks = Array.from(dom.window.document.querySelectorAll('script[type="application/ld+json"]'));
  if (blocks.length === 0) {
    dom.window.close();
    return fail(
      'A4',
      'No Schema.org JSON-LD found. Agents have no structured description of what this page is.',
      undefined,
      'Add a `<script type="application/ld+json">` block with an `@type` describing the page (+2).',
    );
  }
  /** @type {string[]} */
  const types = [];
  /** @type {string[]} */
  const broken = [];
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
    return partial('A4', 1, `A JSON-LD block is present but does not parse: ${broken[0]}`, {
      fix: 'Fix the JSON syntax so the block parses, and give it an @type (+1).',
    });
  }
  if (types.length === 0) {
    return partial('A4', 1, 'JSON-LD is present and parses, but declares no @type, so it describes nothing.', {
      fix: 'Add an `@type` naming what the page is: Person, Article, Product, Organization (+1).',
    });
  }
  return pass('A4', `JSON-LD present and valid: ${unique(types).join(', ')}.`);
}

/**
 * @param {unknown} value
 * @param {string[]} out
 * @returns {void}
 */
function collectTypes(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = /** @type {Record<string, unknown>} */ (value);
  const type = record['@type'];
  if (typeof type === 'string') out.push(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') out.push(t);
  if (Array.isArray(record['@graph'])) collectTypes(record['@graph'], out);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkSsrExtractable(e) {
  if (!e.html.ok || !e.html.body) {
    return fail(
      'A5',
      `The page did not return usable HTML (HTTP ${e.html.status || 'unreachable'}).`,
      undefined,
      'Get the URL returning a 2xx HTML response (+9). Nothing else on this report can be measured properly until it does.',
    );
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
  if (emptyRoot || extracted.wordCount <= SSR_FLOOR_WORDS) {
    return fail(
      'A5',
      emptyRoot
        ? 'The raw HTML contains an empty mount element and almost no text: this page is client-rendered, so agents that do not execute JavaScript see nothing.'
        : `Only ${extracted.wordCount} words of extractable content in the raw HTML (need ${SSR_MIN_WORDS}). Agents that do not run JavaScript will see close to nothing.`,
      undefined,
      'Server-render the page content, or pre-render it at build time (+9). There is no header that fixes this one.',
    );
  }
  // Partly server-rendered: a heading and a paragraph in the HTML, the substance behind hydration.
  // Real, and worth something, and not the same as an empty shell.
  const earned = ramp(extracted.wordCount, SSR_FLOOR_WORDS, SSR_MIN_WORDS, checkDefinition('A5').weight);
  return partial(
    'A5',
    earned,
    `Only ${extracted.wordCount} words of extractable content in the raw HTML, against the ${SSR_MIN_WORDS} a page needs to read as substantive. Agents that do not run JavaScript see a fragment of the page.`,
    {
      detail: `Extracted from <${extracted.contentRoot}>.`,
      fix: `Server-render the rest of the body, not just the shell (+${checkDefinition('A5').weight - Math.round(earned)}).`,
    },
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkTtfb(e) {
  if (!e.html.ok) return na('A6', 'The page did not respond, so there is no time-to-first-byte to measure.');
  const weight = checkDefinition('A6').weight;
  if (e.html.ttfbMs <= TTFB_FAST_MS) {
    return pass('A6', `Time to first byte was ${e.html.ttfbMs}ms, comfortably inside the ${TTFB_FAST_MS}ms an agent fetch wants.`);
  }
  if (e.html.ttfbMs >= TTFB_SLOW_MS) {
    return fail(
      'A6',
      `Time to first byte was ${e.html.ttfbMs}ms, past the ${TTFB_SLOW_MS}ms ceiling. Agents fetching several pages under a short timeout will drop this one.`,
      undefined,
      `Get first byte under ${TTFB_FAST_MS}ms (+${weight}). Cache the HTML at the edge if the work behind it is slow.`,
    );
  }
  const earned = ramp(TTFB_SLOW_MS - e.html.ttfbMs, 0, TTFB_SLOW_MS - TTFB_FAST_MS, weight);
  return partial('A6', earned, `Time to first byte was ${e.html.ttfbMs}ms. Usable, but past the ${TTFB_FAST_MS}ms an agent fetch wants.`, {
    fix: `Get first byte under ${TTFB_FAST_MS}ms (+${weight - Math.round(earned)}).`,
  });
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkNoAi(e) {
  /** @type {string[]} */
  const found = [];
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
      undefined,
      `Remove \`${unique(found)[0]}\` unless the opt-out is deliberate (+8).`,
    );
  }
  return pass('A7', 'No noai or noimageai opt-out tag is set.');
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkHttps(e) {
  const host = e.target.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return na('A8', 'Local development target - HTTPS and HSTS are not meaningful here.');
  }
  // An agent that asks for http:// and is redirected to https:// talks to the site over HTTPS, and
  // the HSTS header it reads is the HTTPS response's. Judging the scheme the user typed failed
  // every site that upgrades correctly.
  const landed = e.html.redirected ? parseUrl(e.html.finalUrl) : undefined;
  if ((landed ?? e.target).protocol !== 'https:') {
    return fail(
      'A8',
      'The site is served over plain HTTP. Some agents refuse insecure origins outright.',
      undefined,
      'Serve the site over HTTPS, then add `Strict-Transport-Security` (+9).',
    );
  }
  const hsts = e.html.headers.get('strict-transport-security');
  if (!hsts) {
    // The part that matters is done. HTTPS is what decides whether an agent will talk to the origin
    // at all; HSTS closes the first-visit downgrade window, which is a real gap and a smaller one.
    return partial('A8', 6, 'Served over HTTPS, but no Strict-Transport-Security header is set, so a first visit can still be downgraded.', {
      fix: 'Add `Strict-Transport-Security: max-age=63072000; includeSubDomains` to the HTML response (+3).',
    });
  }
  return pass('A8', `Served over HTTPS with HSTS (${hsts}).`);
}

// ---- Category B ------------------------------------------------------------------------------

/**
 * @param {ProbeResult} response
 * @returns {boolean}
 */
function isMarkdownResponse(response) {
  const contentType = response.headers.get(HEADERS.contentType) ?? '';
  return contentType.toLowerCase().includes('text/markdown');
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkTwinReachable(e) {
  if (e.twin.error)
    return fail(
      'B1',
      `Could not reach the markdown twin at ${e.twinUrl}: ${e.twin.error}`,
      undefined,
      `Serve a markdown twin at ${e.twinUrl} (+10). \`opengeo generate\` writes it and the prod middleware serves it.`,
    );
  if (!e.twin.ok) {
    return fail(
      'B1',
      `The markdown twin at ${e.twinUrl} returned HTTP ${e.twin.status}. Agents that follow the .md convention get nothing.`,
      undefined,
      `Serve a markdown twin at ${e.twinUrl} (+10). \`opengeo generate\` writes it and the prod middleware serves it.`,
    );
  }
  if (!servesFile(e.twin)) {
    return fail(
      'B1',
      `The markdown twin URL ${e.twinUrl} answered HTTP ${e.twin.status} with an HTML page, not markdown. A catch-all route or the page renderer is handling the .md URL.`,
      undefined,
      `Route ${e.twinUrl} to the markdown twin, ahead of the page renderer (+10). \`opengeo generate\` writes it and the prod middleware serves it.`,
    );
  }
  return pass('B1', `The markdown twin at ${e.twinUrl} returned HTTP ${e.twin.status}.`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkTwinContentType(e) {
  const actual = e.twin.headers.get(HEADERS.contentType);
  if (!e.twin.ok)
    return fail(
      'B2',
      `No markdown twin response to inspect (HTTP ${e.twin.status || 'unreachable'}).`,
      undefined,
      'Fix B1 first: there is no twin response to read a Content-Type from (+5).',
    );
  if (!actual)
    return fail(
      'B2',
      'The markdown twin response has no Content-Type header at all.',
      undefined,
      `Send \`${MARKDOWN_CONTENT_TYPE}\` on the twin response (+5).`,
    );
  const normalized = actual.toLowerCase().replace(/\s*;\s*/g, '; ').trim();
  if (normalized === MARKDOWN_CONTENT_TYPE) return pass('B2', `Content-Type is exactly ${MARKDOWN_CONTENT_TYPE}.`);
  // The type is right and only the charset is missing. Every agent that matches on the media type
  // is already satisfied; what is left is the one that has to guess the encoding.
  if (normalized.startsWith('text/markdown')) {
    return partial('B2', 3, `Content-Type is "${actual}": the media type is right, but it does not declare "charset=utf-8", so the encoding is left to be guessed.`, {
      fix: `Send exactly \`${MARKDOWN_CONTENT_TYPE}\` (+2).`,
    });
  }
  // text/plain at least stops a browser rendering the markdown as HTML, so it is a smaller error
  // than text/html, but no agent selects on it and none will treat the body as markdown.
  if (normalized.startsWith('text/plain')) {
    return partial('B2', 2, `Content-Type is "${actual}", not "${MARKDOWN_CONTENT_TYPE}". The body will be read as plain text, so nothing selecting on the markdown type will find it.`, {
      fix: `Send \`${MARKDOWN_CONTENT_TYPE}\` (+3).`,
    });
  }
  return fail(
    'B2',
    `Content-Type is "${actual}", not "${MARKDOWN_CONTENT_TYPE}". Agents sniffing the type may treat the body as HTML or plain text.`,
    undefined,
    `Send \`${MARKDOWN_CONTENT_TYPE}\` on the twin response (+5).`,
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkTwinNonEmpty(e) {
  if (!e.twin.ok)
    return fail(
      'B3',
      `No markdown twin response to inspect (HTTP ${e.twin.status || 'unreachable'}).`,
      undefined,
      'Fix B1 first: there is no twin response to read a body from (+5).',
    );
  const body = e.twin.body.trim();
  if (!body)
    return fail(
      'B3',
      'The markdown twin responded 2xx with an empty body.',
      undefined,
      'Regenerate the twin: the route answers, but with nothing in it (+5).',
    );
  // Non-empty is the letter of the check; complete is the point of it. A twin holding a title and
  // nothing else is technically a body and is useless to the agent that fetched it, so the credit
  // slides with how much of the page actually made it across.
  const twinWords = countWords(body);
  const live = e.html.ok && e.html.body ? extractPage(e.html.body, { url: e.target.toString(), minWords: SSR_MIN_WORDS }) : undefined;
  const liveWords = live?.wordCount ?? 0;
  const complete = liveWords === 0 || twinWords >= liveWords * TWIN_FULL_RATIO;
  if (complete) return pass('B3', `The markdown twin returned ${body.length} characters of markdown.`);

  const weight = checkDefinition('B3').weight;
  const ratio = twinWords / liveWords;
  const earned = ramp(ratio, TWIN_FLOOR_RATIO, TWIN_FULL_RATIO, weight);
  return partial(
    'B3',
    earned,
    `The twin is ${twinWords} words against the live page's ${liveWords}, so most of the page did not make it into the markdown.`,
    {
      detail: `${Math.round(ratio * 100)}% of the extractable text.`,
      fix: `Regenerate the twin from the live page so it carries the whole body (+${weight - Math.round(earned)}).`,
    },
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkTokensHeader(e) {
  const raw = e.twin.headers.get(HEADERS.markdownTokens);
  if (!raw) {
    return fail(
      'B4',
      `No ${HEADERS.markdownTokens} header, so an agent cannot gauge the response size before fetching it.`,
      undefined,
      `Send \`${HEADERS.markdownTokens}\` with the token count of the body (+3). The prod middleware sets it from the manifest.`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fail(
      'B4',
      `${HEADERS.markdownTokens} is "${raw}", which is not a positive integer.`,
      undefined,
      `Send \`${HEADERS.markdownTokens}\` as a plain positive integer (+3).`,
    );
  }
  return pass('B4', `${HEADERS.markdownTokens}: ${value}.`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkNosniff(e) {
  const value = e.twin.headers.get(HEADERS.contentTypeOptions);
  if (value?.toLowerCase().trim() === 'nosniff') return pass('B5', 'X-Content-Type-Options: nosniff is set on the markdown response.');
  return fail(
    'B5',
    value ? `X-Content-Type-Options is "${value}", not "nosniff".` : 'No X-Content-Type-Options header on the markdown response.',
    undefined,
    'Add `X-Content-Type-Options: nosniff` to the twin response (+3).',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkTwinNoindex(e) {
  const value = e.twin.headers.get(HEADERS.robotsTag);
  if (!value) {
    return fail(
      'B6',
      'No X-Robots-Tag on the markdown twin, so search engines may index it as duplicate content alongside the HTML page.',
      undefined,
      'Add `X-Robots-Tag: noindex` to the twin response (+3).',
    );
  }
  if (!/\bnoindex\b/i.test(value)) {
    return partial('B6', 1, `X-Robots-Tag is "${value}" and does not include noindex, so the twin can still be indexed alongside the HTML page as duplicate content.`, {
      fix: 'Add `noindex` to the twin\'s X-Robots-Tag (+2).',
    });
  }
  return pass('B6', `X-Robots-Tag includes noindex ("${value}").`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkVaryAccept(e) {
  const htmlVary = e.html.headers.get(HEADERS.vary) ?? '';
  const twinVary = e.twin.headers.get(HEADERS.vary) ?? '';
  const htmlOk = varyIncludesAccept(htmlVary);
  const twinOk = varyIncludesAccept(twinVary);

  if (htmlOk && twinOk) return pass('B7', 'Vary: Accept is set on both the HTML and the markdown response.');
  const missing = [!htmlOk ? 'the HTML response' : null, !twinOk ? 'the markdown response' : null].filter(Boolean);
  const detail = `HTML Vary: "${htmlVary || 'absent'}"; markdown Vary: "${twinVary || 'absent'}".`;

  // One side set is a materially better position than neither: the format that carries the header
  // is cached correctly, and the poisoning risk is one-directional rather than both. It is also the
  // permanent state of a Next.js App Router deployment, where middleware cannot add a header to a
  // response it did not create, so calling it a total failure would be calling a framework limit a
  // defect on every single run.
  if (htmlOk || twinOk) {
    return partial('B7', 2, `Vary does not include Accept on ${missing.join(' or ')}. A CDN can cache that side's response and serve it to a visitor asking for the other format.`, {
      detail,
      fix: `Add \`Vary: Accept\` to ${missing.join(' and ')} (+2). Some frameworks will not let middleware set it on a response they created; a CDN or proxy rule is the way through.`,
    });
  }
  return fail(
    'B7',
    `Vary does not include Accept on ${missing.join(' or ')}. A CDN will cache one format and serve it to visitors asking for the other.`,
    detail,
    'Add `Vary: Accept` to both responses (+4).',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkLinkAlternate(e) {
  if (e.advertisedTwinUrl) {
    return pass('B8', `The HTML response advertises its markdown twin: Link rel="alternate" -> ${e.advertisedTwinUrl}`);
  }
  if (e.foreignTwinUrl) {
    return partial('B8', 1, `The HTML response advertises a markdown twin at ${e.foreignTwinUrl}, which is not on this site's origin, so OpenGEO did not fetch it and checked ${e.twinUrl} instead.`, {
      fix: `Point the Link header at the twin on this origin: \`<${e.twinUrl}>; rel="alternate"; type="text/markdown"\` (+2).`,
    });
  }
  const link = e.html.headers.get(HEADERS.link);
  if (link) {
    return partial('B8', 1, `The HTML response has a Link header ("${link}") but no rel="alternate" entry of type text/markdown, so an agent still has to guess the twin URL.`, {
      fix: `Add \`<${e.twinUrl}>; rel="alternate"; type="text/markdown"\` to the existing Link header (+2).`,
    });
  }
  return fail(
    'B8',
    'The HTML response has no Link rel="alternate" header, so an agent has to guess the markdown twin URL.',
    undefined,
    `Add \`Link: <${e.twinUrl}>; rel="alternate"; type="text/markdown"\` to the HTML response (+3).`,
  );
}

/**
 * Whether a negotiated response reached its markdown by redirect, which breaks the same-URL contract.
 *
 * Compared with where the browser's request landed rather than with the target, so a site that
 * redirects every request (a trailing slash, say) is not blamed for the markdown following suit.
 *
 * @param {ProbeResult} response
 * @param {Evidence} e
 */
function redirectedAway(response, e) {
  return response.redirected && response.finalUrl !== e.html.finalUrl;
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkAcceptNegotiation(e) {
  if (!e.acceptMarkdown.ok) {
    return fail(
      'B9',
      `A request with Accept: text/markdown returned HTTP ${e.acceptMarkdown.status || 'nothing'}.`,
      undefined,
      'Answer 2xx to a request carrying `Accept: text/markdown` (+6).',
    );
  }
  if (isMarkdownResponse(e.acceptMarkdown) && redirectedAway(e.acceptMarkdown, e)) {
    return fail(
      'B9',
      `A request with Accept: text/markdown was sent by redirect to ${e.acceptMarkdown.finalUrl} for its markdown. An agent that follows it cites that URL instead of the page.`,
      undefined,
      'Rewrite requests that prefer text/markdown to the twin instead of redirecting them, so the markdown is served at the same URL (+6). This is what the prod middleware does.',
    );
  }
  if (isMarkdownResponse(e.acceptMarkdown)) {
    return pass('B9', 'A request with Accept: text/markdown received markdown at the same URL.');
  }
  return fail(
    'B9',
    `A request with Accept: text/markdown received "${e.acceptMarkdown.headers.get(HEADERS.contentType) ?? 'no Content-Type'}" instead of markdown. Content negotiation is not wired up.`,
    undefined,
    'Rewrite requests that prefer text/markdown to the twin, at the same URL (+6). This is what the prod middleware does.',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkBotUaNegotiation(e) {
  if (!e.botUa.ok)
    return fail(
      'B10',
      `A ${e.botName ?? 'GPTBot'}-identified request returned HTTP ${e.botUa.status || 'nothing'}.`,
      undefined,
      'Answer 2xx to a known AI bot User-Agent (+6). Check nothing upstream is rate limiting or blocking it.',
    );
  if (isMarkdownResponse(e.botUa) && redirectedAway(e.botUa, e)) {
    return fail(
      'B10',
      `A GPTBot User-Agent was sent by redirect to ${e.botUa.finalUrl} for its markdown. A crawler that follows it indexes that URL instead of the page.`,
      undefined,
      'Rewrite known AI bot User-Agents to the twin instead of redirecting them, so the markdown is served at the same URL (+6). Set `bots.markdownRouting` and let the middleware do it.',
    );
  }
  if (isMarkdownResponse(e.botUa)) {
    return pass('B10', 'A known AI bot User-Agent received markdown without needing to send an Accept header.');
  }
  return fail(
    'B10',
    `A ${e.botName ?? 'GPTBot'} User-Agent received "${e.botUa.headers.get(HEADERS.contentType) ?? 'no Content-Type'}". Most AI crawlers never send Accept: text/markdown, so User-Agent routing is what actually reaches them.`,
    undefined,
    'Route known AI bot User-Agents to the twin as well, not only Accept headers (+6). Set `bots.markdownRouting` and let the middleware do it.',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkNotAcceptable(e) {
  if (e.notAcceptable.status === 406) {
    return pass('B11', 'An Accept header excluding both HTML and markdown correctly returned 406 Not Acceptable.');
  }
  return fail(
    'B11',
    `An Accept: ${HOSTILE_ACCEPT} request returned HTTP ${e.notAcceptable.status || 'nothing'} instead of 406 Not Acceptable.`,
    undefined,
    'Return 406 when the Accept header asks for a format the page cannot produce (+2).',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkAeoVersion(e) {
  const value = e.twin.headers.get(HEADERS.aeoVersion) ?? e.acceptMarkdown.headers.get(HEADERS.aeoVersion);
  if (value) return pass('B12', `X-AEO-Version advertises "${value}".`);
  return fail(
    'B12',
    'No X-AEO-Version header, so an agent cannot tell which serving spec this site implements.',
    undefined,
    'Add `X-AEO-Version` to the twin response (+2). The prod middleware sets it for you.',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkHtmlUnaffected(e) {
  if (!e.html.ok)
    return fail(
      'B13',
      `The original HTML URL returned HTTP ${e.html.status || 'nothing'}.`,
      undefined,
      'Get the HTML URL answering 2xx to a normal browser again (+9). Serving agents must never cost human visitors the page.',
    );
  const contentType = e.html.headers.get(HEADERS.contentType) ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return fail(
      'B13',
      `A normal browser request received "${contentType}" instead of HTML. Human visitors are being served the wrong format.`,
      undefined,
      'Serve markdown only to requests that asked for it (+9). A browser Accept header must still get HTML.',
    );
  }
  if (!e.html.body.trim())
    return fail(
      'B13',
      'The original HTML URL returned an empty body to a normal browser request.',
      undefined,
      'Return the real HTML page to a normal browser request (+9).',
    );
  return pass('B13', 'A normal browser request still receives the real HTML page, unchanged.');
}

/**
 * B14 - staleness and drift.
 *
 * This is the check §5 singles out as the one only OpenGEO can make, and the reason is
 * structural: OpenGEO owns both halves of the pipeline, so it knows the hash of the HTML each twin
 * was built from. Nothing that only inspects a live site from the outside can tell "this markdown
 * is a faithful copy of the current page" apart from "this markdown was accurate six months ago".
 *
 * It matters more here than it would elsewhere, because §6 rules out regenerating in CI. Nothing
 * catches a forgotten `opengeo generate` except this check.
 *
 * @param {Evidence} e
 * @returns {CheckResult}
 */
function checkDrift(e) {
  if (!e.twin.ok || !e.twin.body.trim()) {
    return fail(
      'B14',
      `There is no markdown twin to compare against the live page (HTTP ${e.twin.status || 'unreachable'}).`,
      undefined,
      'Fix B1 first: there is no twin to compare against the live page (+4).',
    );
  }
  if (!e.html.ok || !e.html.body.trim()) {
    return na('B14', 'The live HTML page did not respond, so there is nothing to compare the twin against.');
  }

  const parsed = parseFrontmatter(e.twin.body);
  // Two places the provenance can live, and prod only ever exposes the first. It strips frontmatter
  // at load so the body is clean markdown, and answers with the hash as a response header instead.
  // A twin served straight off a static host keeps its frontmatter, so both are read.
  const sourceHash =
    e.twin.headers.get(HEADERS.markdownSourceHash) ??
    (typeof parsed.data.source_hash === 'string' ? parsed.data.source_hash : undefined);
  const lastUpdated =
    e.twin.headers.get(HEADERS.lastModified) ??
    (typeof parsed.data.last_updated === 'string' ? parsed.data.last_updated : undefined);
  const age = describeAge(lastUpdated);

  // Extracted content, never raw HTML: generate hashes the same thing, for the same reason. A build
  // id or a script nonce changing is not the page changing, and a check that says otherwise on every
  // deploy is a check people learn to ignore.
  const extracted = extractPage(e.html.body, { url: e.target.toString(), minWords: SSR_MIN_WORDS });

  if (sourceHash) {
    const liveHash = contentHash(extracted.markdown);
    if (liveHash === sourceHash) {
      return pass(
        'B14',
        `The twin was generated from exactly this version of the page${age ? `, ${age}` : ''}.`,
        `source_hash ${sourceHash} matches the content of the live page.`,
      );
    }
    // The hash says something changed. How much is a different question, and it is the one the
    // reader actually has: a typo fix and a rewritten page both break the hash, and only one of them
    // is serving agents wrong information. Fidelity compares the facts, so it can tell them apart.
    const drift = verifyFidelity(extracted.markdown, parsed.body, { minWordRatio: 0.4, rejectInvented: false });
    if (drift.ok) {
      return partial(
        'B14',
        2,
        `The live page has changed since the twin was generated${age ? ` ${age}` : ''}, but every number, date and price on it still appears in the twin, so the drift is cosmetic so far.`,
        {
          detail: `Twin source_hash ${sourceHash}, the live page's content hashes to ${liveHash}.`,
          fix: 'Re-run `opengeo generate` to bring the twin back in step before the next edit makes it wrong (+2).',
        },
      );
    }
    return fail(
      'B14',
      `The live page has changed since the twin was generated${age ? ` ${age}` : ''}. AI agents are being served stale content. Re-run \`opengeo generate\`.`,
      `Twin source_hash ${sourceHash}, the live page's content hashes to ${liveHash}. ${drift.errors[0]}`,
      'Re-run `opengeo generate` (+4).',
    );
  }

  // No hash anywhere: a hand-written twin, or one produced by something other than OpenGEO. Fall back
  // to comparing the facts on the live page against the facts in the twin, which is slower to
  // reason about but works without any bookkeeping.
  const report = verifyFidelity(extracted.markdown, parsed.body, { minWordRatio: 0.4, rejectInvented: false });
  if (report.ok) {
    return pass(
      'B14',
      `The twin reports no source hash, but every number, date and price on the live page still appears in it${age ? ` (twin last updated ${age})` : ''}.`,
    );
  }
  if (report.errors.length === 1) {
    return partial('B14', 2, `The twin has drifted from the live page in one place${age ? `, and was last updated ${age}` : ''}. ${report.errors[0]}`, {
      detail: 'The twin reports no source hash, so this was compared fact by fact rather than by hash.',
      fix: 'Re-run `opengeo generate` (+2).',
    });
  }
  return fail(
    'B14',
    `The twin no longer matches the live page${age ? `, and was last updated ${age}` : ''}. ${report.errors[0]}`,
    `The twin reports no source hash, so this was compared fact by fact rather than by hash. ${report.errors.length} facts differ.`,
    'Re-run `opengeo generate` (+4).',
  );
}

/**
 * "3 days ago", "today". Undefined when there is no usable last_updated to report.
 *
 * @param {string | undefined} lastUpdated
 * @returns {string | undefined}
 */
function describeAge(lastUpdated) {
  if (!lastUpdated) return undefined;
  const then = Date.parse(lastUpdated);
  if (Number.isNaN(then)) return undefined;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * Same notion of a word the extractor uses, so the two counts B3 compares are comparable.
 *
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
