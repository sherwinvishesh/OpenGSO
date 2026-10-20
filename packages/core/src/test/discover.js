import { probe } from '../shared/http.js';
import { isMarkdownPath, twinUrl } from '../shared/routes.js';
import { countWords } from '../shared/tokens.js';

/**
 * @import { Evidence } from './evidence.js'
 * @import { ProbeResult } from '../shared/http.js'
 */

/**
 * Finding every Markdown document a site actually serves (§5).
 *
 * The content review needs documents, and the only honest way to get them from a site OpenGEO did
 * not generate is to ask the site. Three sources, in descending order of how deliberate they are:
 *
 * 1. The twin of the URL the user named. Always reviewed, even when nothing else is found.
 * 2. `llms.txt`. A site that publishes one has explicitly said "these are the documents for you",
 *    which is a stronger signal than anything inferred.
 * 3. `sitemap.xml`, mapped through the twin-URL convention. A guess, so it is fetched and kept only
 *    when what comes back is really markdown.
 *
 * Everything is verified by fetching it. A URL that 404s, returns HTML, or comes back empty is not
 * a document, and reporting it as one would send the reviewer a login page to critique.
 */

/** @typedef {'requested' | 'llms.txt' | 'sitemap.xml' | 'advertised'} TwinSource */

/**
 * @typedef {object} DiscoveredTwin
 * @property {string} url
 * @property {string} [pageUrl] The page this document is the twin of, when it follows the `<path>.md` convention.
 * @property {TwinSource} source
 * @property {string} markdown
 * @property {number} bytes
 * @property {number} words
 */

/**
 * @typedef {object} DiscoveryResult
 * @property {DiscoveredTwin[]} twins Verified documents, requested-first, then in the order the site listed them.
 * @property {Array<{ url: string; source: TwinSource; reason: string }>} rejected Candidates that were fetched and rejected, with the reason, so the report can say why.
 * @property {number} overCap How many candidates were dropped before fetching because of the cap.
 * @property {{ llms: boolean; sitemap: boolean }} sources
 */

/**
 * @typedef {object} DiscoverOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxFetch] Hard cap on how many candidate URLs are fetched. A sitemap can list thousands.
 * @property {Evidence} [evidence] Evidence from a structural run, so the main flow does not fetch llms.txt or the twin twice.
 * @property {number} [concurrency] How many candidates are fetched at once.
 */

const DEFAULT_MAX_FETCH = 25;
const DEFAULT_CONCURRENCY = 5;

/**
 * @param {URL} target
 * @param {DiscoverOptions} [options]
 * @returns {Promise<DiscoveryResult>}
 */
export async function discoverTwins(target, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxFetch = options.maxFetch ?? DEFAULT_MAX_FETCH;
  const evidence = options.evidence;

  // A user who points `test` straight at a `.md` URL means that document, not the twin of it.
  const requested = isMarkdownPath(target.pathname) ? target.toString() : (evidence?.twinUrl ?? twinUrl(target.toString()));

  const [llms, sitemap] = evidence
    ? [evidence.llms, evidence.sitemap]
    : await Promise.all([
        probe(new URL('/llms.txt', target.origin).toString(), { timeoutMs }),
        probe(new URL('/sitemap.xml', target.origin).toString(), { timeoutMs }),
      ]);
  const childSitemaps = evidence ? (evidence.sitemapChildren ?? []) : await fetchChildSitemaps(sitemap, target.origin, timeoutMs);

  /** @type {Map<string, TwinSource>} */
  const candidates = new Map();
  /**
   * @param {string} url
   * @param {TwinSource} source
   */
  const add = (url, source) => {
    if (!candidates.has(url)) candidates.set(url, source);
  };

  add(requested, evidence?.advertisedTwinUrl === requested ? 'advertised' : 'requested');
  if (llms.ok) for (const url of markdownLinksIn(llms.body, target.origin, llms.url)) add(url, 'llms.txt');
  if (sitemap.ok) for (const url of sitemapTwins(sitemap.body, target.origin)) add(url, 'sitemap.xml');
  for (const child of childSitemaps) if (child.ok) for (const url of sitemapTwins(child.body, target.origin)) add(url, 'sitemap.xml');

  const all = [...candidates.entries()];
  const fetching = all.slice(0, maxFetch);
  const overCap = all.length - fetching.length;

  /** @type {DiscoveredTwin[]} */
  const twins = [];
  /** @type {DiscoveryResult['rejected']} */
  const rejected = [];

  // The requested twin is usually already in hand from the structural pass. Reusing it keeps the
  // main flow at one fetch per document rather than two.
  const prefetched =
    evidence && evidence.twinUrl === requested ? { body: evidence.twin.body, ok: evidence.twin.ok, status: evidence.twin.status } : undefined;

  await inBatches(fetching, options.concurrency ?? DEFAULT_CONCURRENCY, async ([url, source]) => {
    const result =
      url === requested && prefetched
        ? prefetched
        : await probe(url, { headers: { Accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.5' }, timeoutMs });

    const verdict = judge(result);
    if (verdict.ok) {
      const markdown = result.body.trim();
      twins.push({ url, pageUrl: pageUrlOf(url), source, markdown, bytes: new TextEncoder().encode(markdown).length, words: countWords(markdown) });
    } else {
      rejected.push({ url, source, reason: verdict.reason });
    }
  });

  const order = new Map(fetching.map(([url], index) => [url, index]));
  twins.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
  rejected.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));

  return { twins, rejected, overCap, sources: { llms: llms.ok, sitemap: sitemap.ok } };
}

/**
 * @param {{ ok: boolean; status: number; body: string }} result
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
function judge(result) {
  if (!result.ok) return { ok: false, reason: `HTTP ${result.status || 'unreachable'}` };
  const body = result.body.trim();
  if (!body) return { ok: false, reason: 'the response was empty' };
  if (looksLikeHtml(body)) return { ok: false, reason: 'the response was HTML, not Markdown' };
  return { ok: true };
}

/**
 * A markdown twin that is really an HTML page is the single most common false positive: a catch-all
 * route, a SPA shell, or a 404 page served with a 200. Sniffing the body rather than trusting the
 * content-type is deliberate, because a static host serving `.md` as `text/html` is exactly the
 * misconfiguration B2 exists to catch, and it must not also poison the review.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function looksLikeHtml(body) {
  return /^\s*(<!doctype html|<html[\s>])/i.test(body.slice(0, 400));
}

/**
 * Markdown links and bare URLs in llms.txt that point at a `.md` document on this origin.
 *
 * @param {string} body
 * @param {string} origin
 * @param {string} [base] Where the llms.txt was found, which a relative link is relative to: a site in
 *   a folder of its host keeps it in that folder.
 * @returns {string[]}
 */
export function markdownLinksIn(body, origin, base = origin) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} raw */
  const push = (raw) => {
    /** @type {URL} */
    let url;
    try {
      url = new URL(raw, base);
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (!isMarkdownPath(url.pathname)) return;
    url.hash = '';
    const value = url.toString();
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };

  for (const [, href] of body.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) push(/** @type {string} */ (href));
  for (const [bare] of body.matchAll(/https?:\/\/[^\s)<>"']+\.md\b/g)) push(bare);
  return out;
}

/**
 * Every `<loc>` in a sitemap, mapped through the twin-URL convention.
 *
 * A sitemap index yields nothing: its `<loc>`s are other sitemaps, and `/sitemap-1.xml.md` is not a
 * document anyone serves. The caller reads the children through `fetchChildSitemaps` instead.
 *
 * @param {string} body
 * @param {string} origin
 * @returns {string[]}
 */
export function sitemapTwins(body, origin) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  if (isSitemapIndex(body)) return out;
  for (const url of sitemapLocs(body, origin)) {
    if (url.origin !== origin) continue;
    const candidate = isMarkdownPath(url.pathname) ? url.toString() : twinUrl(url.toString());
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/** A sitemap index can list thousands of sitemaps. This many are read; the reason says when there were more. */
export const MAX_CHILD_SITEMAPS = 10;

/**
 * @param {string} body
 * @returns {boolean}
 */
export function isSitemapIndex(body) {
  return /<sitemapindex[\s>]/i.test(body);
}

/**
 * Every parseable `<loc>` in a sitemap or sitemap index, resolved against `base`.
 *
 * @param {string} body
 * @param {string} base
 * @returns {URL[]}
 */
export function sitemapLocs(body, base) {
  /** @type {URL[]} */
  const out = [];
  for (const [, loc] of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      out.push(new URL(decodeEntities(/** @type {string} */ (loc)), base));
    } catch {
      // A malformed <loc> is skipped, the same as a crawler would.
    }
  }
  return out;
}

/**
 * The sitemaps a sitemap index points at, fetched. Empty for anything that is not an index.
 *
 * Each child is fetched at its path on the audited origin. That keeps the request on the site being
 * tested, for the reason evidence.js gives for an advertised twin, and it still works when a local
 * run reads an index written for the production host.
 *
 * @param {ProbeResult} sitemap
 * @param {string} origin
 * @param {number} timeoutMs
 * @returns {Promise<ProbeResult[]>}
 */
export async function fetchChildSitemaps(sitemap, origin, timeoutMs) {
  if (!sitemap.ok || !isSitemapIndex(sitemap.body)) return [];
  const children = sitemapLocs(sitemap.body, origin).slice(0, MAX_CHILD_SITEMAPS);
  return Promise.all(children.map((url) => probe(new URL(`${url.pathname}${url.search}`, origin).toString(), { timeoutMs })));
}

/**
 * `/resume.md` -> `/resume`, so the report can name the page a document belongs to.
 *
 * @param {string} url
 * @returns {string | undefined}
 */
function pageUrlOf(url) {
  try {
    const parsed = new URL(url);
    if (!isMarkdownPath(parsed.pathname)) return undefined;
    parsed.pathname = parsed.pathname.replace(/\/index\.md$/, '/').replace(/\.md$/, '');
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {number} size
 * @param {(item: T) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function inBatches(items, size, run) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run));
  }
}
