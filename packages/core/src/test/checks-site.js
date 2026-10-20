import { AI_BOTS } from '../shared/bots.js';
import { HEADERS } from '../shared/version.js';
import { parseUrl } from '../shared/http.js';
import { parseRobots, robotsAllows, robotsRulesFor } from '../shared/robots.js';
import { checkDefinition } from './checks.js';
import { fail, na, partial, pass, ramp } from './checks.js';
import { isSitemapIndex, looksLikeHtml, MAX_CHILD_SITEMAPS, sitemapLocs } from './discover.js';
import { SSR_MIN_WORDS, liveExtract } from './live-page.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 * @import { ProbeResult } from '../shared/http.js'
 */

/**
 * Category A: the page and the site files around it, A1 to A8 (§5). Pure over `Evidence`.
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

/** Under this, there is so little text that partial credit would be flattery rather than measurement. */
export const SSR_FLOOR_WORDS = 15;

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
export function servesFile(response) {
  return response.ok && !looksLikeHtml(response.body);
}

/**
 * The folder of its host this site lives in, `https://user.github.io/repo/`, when its own llms.txt or
 * sitemap.xml was found there rather than at the root of the host, which is what says it is one.
 *
 * @param {Evidence} e
 * @returns {string | undefined}
 */
function siteFolder(e) {
  const folder = e.folder;
  return folder && [e.llms, e.sitemap].some((file) => file.url.startsWith(folder) && servesFile(file)) ? folder : undefined;
}

// ---- Category A ------------------------------------------------------------------------------

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkRobots(e) {
  if (!e.robots.ok) {
    const folder = siteFolder(e);
    const pages = e.target.hostname.endsWith('.github.io') ? ` On GitHub Pages that is the ${e.target.hostname} repository.` : '';
    return fail(
      'A1',
      `No robots.txt at ${e.robots.url} (HTTP ${e.robots.status || 'unreachable'}). AI crawlers get no explicit signal about what they may read.`,
      undefined,
      folder
        ? `Crawlers read robots.txt only at the root of the host, and this site lives in ${folder}, so it has to be published from that root (+9).${pages} Allow the AI agents you want reading the site, and add a Sitemap line for ${folder}sitemap.xml.`
        : 'Serve a robots.txt that allows the AI agents you want reading the site (+9). `omnigeo generate` writes one.',
    );
  }
  if (!servesFile(e.robots)) {
    return fail(
      'A1',
      `${e.robots.url} answered with an HTML page, not a robots.txt. A catch-all route is handling it, so AI crawlers get no robots rules at all.`,
      undefined,
      'Serve a real robots.txt ahead of the catch-all route (+9). `omnigeo generate` writes one.',
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
export function checkLlmsTxt(e) {
  if (!e.llms.ok) {
    return fail(
      'A2',
      `No llms.txt at ${e.llms.url}${e.folder ? ` or ${e.folder}llms.txt` : ''} (HTTP ${e.llms.status || 'unreachable'}).`,
      undefined,
      'Serve /llms.txt with a title and your key pages as markdown links (+3). `omnigeo generate` writes it.',
    );
  }
  if (!servesFile(e.llms)) {
    return fail(
      'A2',
      `${e.llms.url} answered with an HTML page, not an llms.txt. A catch-all route is handling it.`,
      undefined,
      'Serve a real /llms.txt ahead of the catch-all route (+3). `omnigeo generate` writes it.',
    );
  }
  const body = e.llms.body.trim();
  const links = (body.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const hasTitle = /^#\s+\S/m.test(body);

  if (!body) {
    return partial('A2', 1, 'llms.txt exists but is empty. The file is being served, which is most of the plumbing.', {
      fix: 'Add a `# Title` line and a list of your key pages as markdown links (+2). `omnigeo generate` writes it for you.',
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
export function checkSitemap(e) {
  if (!e.sitemap.ok) {
    return fail(
      'A3',
      `No sitemap.xml at ${e.sitemap.url}${e.folder ? ` or ${e.folder}sitemap.xml` : ''} (HTTP ${e.sitemap.status || 'unreachable'}).`,
      undefined,
      'Serve a /sitemap.xml listing every page (+9). `omnigeo generate` builds one from a crawl.',
    );
  }
  const body = e.sitemap.body;
  if (!/<(urlset|sitemapindex)[\s>]/i.test(body)) {
    return partial('A3', 3, 'Something answers at /sitemap.xml, but it has no <urlset> or <sitemapindex> root element, so no crawler will read it as a sitemap.', {
      detail: `First 80 characters: ${JSON.stringify(body.slice(0, 80))}`,
      fix: 'Serve a real sitemap: `<urlset>` with one `<url><loc>` per page (+6). `omnigeo generate` writes one from the crawl.',
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
      fix: `Add ${e.target.pathname} and any other pages the sitemap is missing (+3). \`omnigeo generate\` rebuilds it from a crawl.`,
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
    fix: `Add ${e.target.pathname} and any other missing pages to one of the sitemaps the index lists (+3). \`omnigeo generate\` writes a single sitemap from a crawl.`,
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
 * @param {() => Document} doc
 * @returns {CheckResult}
 */
export function checkJsonLd(e, doc) {
  if (!e.html.ok || !e.html.body)
    return fail(
      'A4',
      'Could not read the HTML response to look for JSON-LD.',
      undefined,
      'Get the page returning HTML first; this check reads the markup for a JSON-LD block (+2).',
    );
  const blocks = Array.from(doc().querySelectorAll('script[type="application/ld+json"]'));
  if (blocks.length === 0) {
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
export function checkSsrExtractable(e) {
  if (!e.html.ok || !e.html.body) {
    return fail(
      'A5',
      `The page did not return usable HTML (HTTP ${e.html.status || 'unreachable'}).`,
      undefined,
      'Get the URL returning a 2xx HTML response (+9). Nothing else on this report can be measured properly until it does.',
    );
  }
  const extracted = liveExtract(e);
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
export function checkTtfb(e) {
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
 * @param {() => Document} doc
 * @returns {CheckResult}
 */
export function checkNoAi(e, doc) {
  /** @type {string[]} */
  const found = [];
  const headerValue = e.html.headers.get(HEADERS.robotsTag) ?? '';
  if (/\bnoai\b/i.test(headerValue)) found.push(`X-Robots-Tag: ${headerValue}`);
  if (/\bnoimageai\b/i.test(headerValue)) found.push(`X-Robots-Tag: ${headerValue}`);

  if (e.html.body) {
    for (const meta of Array.from(doc().querySelectorAll('meta[name], meta[property]'))) {
      const name = (meta.getAttribute('name') ?? meta.getAttribute('property') ?? '').toLowerCase();
      const content = meta.getAttribute('content') ?? '';
      if (!['robots', 'googlebot'].includes(name) && !name.includes('ai')) continue;
      if (/\bnoai\b|\bnoimageai\b/i.test(content) || /\bnoai\b|\bnoimageai\b/i.test(name)) {
        found.push(`<meta name="${name}" content="${content}">`);
      }
    }
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
export function checkHttps(e) {
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
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)];
}
