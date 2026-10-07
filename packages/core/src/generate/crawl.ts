import { JSDOM } from 'jsdom';
import { ERRORS } from '../shared/errors.js';
import { MAX_PROBE_BYTES, probe } from '../shared/http.js';
import { normalizeRoute } from '../shared/routes.js';

/**
 * Route discovery by following real `<a href>` links (§6, and the §17 ceiling on how far
 * that can go).
 *
 * This is deliberately the dumbest thing that works everywhere: a same-origin breadth-first walk
 * over anchors that are actually in the served HTML. It is not a router adapter and never will be
 * (§16) - a route only a client-side router knows about is invisible here, and the honest answer to
 * that is `extraRoutes` in opengeo.config.json, not a per-framework integration.
 *
 * One crawl feeds three outputs: the markdown twins, llms.txt, and sitemap.xml. Nothing here
 * fetches a page twice - the HTML comes back with the result so generate can reuse it.
 */

/** Extensions that are never a page worth extracting, so the crawl doesn't fetch them at all. */
const NON_PAGE_EXTENSIONS = new Set([
  'css', 'js', 'mjs', 'cjs', 'json', 'xml', 'txt', 'md', 'map',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'rar', 'dmg', 'exe',
  'mp3', 'mp4', 'webm', 'mov', 'avi', 'wav', 'ogg',
  'csv', 'xlsx', 'docx', 'pptx',
]);

/** Framework-internal paths. Crawling these is always noise, never content. */
const INTERNAL_PREFIXES = ['/_next/', '/_nuxt/', '/_astro/', '/_vercel/', '/cdn-cgi/', '/__nextjs'];

export interface CrawlOptions {
  /** Origin + optional base path. Every discovered link must share this origin. */
  site: string;
  /** Where to start. Defaults to the site's own path. */
  startRoutes?: readonly string[];
  /** Routes the crawl can't reach on its own (§17's escape hatch). Always fetched, never skipped. */
  extraRoutes?: readonly string[];
  maxPages?: number;
  maxDepth?: number;
  /** Path prefixes to skip, from opengeo.config.json. */
  exclude?: readonly string[];
  timeoutMs?: number;
  onProgress?: (event: CrawlProgress) => void;
}

export interface CrawlProgress {
  route: string;
  depth: number;
  found: number;
  visited: number;
}

export interface CrawlPage {
  route: string;
  url: string;
  depth: number;
  html: string;
  status: number;
  contentType: string;
}

export interface CrawlFailure {
  route: string;
  url: string;
  reason: string;
}

export interface CrawlResult {
  site: string;
  origin: string;
  pages: CrawlPage[];
  failures: CrawlFailure[];
  /** Hit a cap? Say so out loud rather than quietly returning a partial site. */
  warnings: string[];
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const base = new URL(options.site);
  const origin = base.origin;
  const maxPages = options.maxPages ?? 200;
  const maxDepth = options.maxDepth ?? 4;
  const exclude = (options.exclude ?? []).map((p) => normalizeRoute(p));
  const timeoutMs = options.timeoutMs ?? 20_000;

  const startRoutes = (options.startRoutes?.length ? options.startRoutes : [base.pathname]).map(normalizeRoute);
  const extraRoutes = (options.extraRoutes ?? []).map(normalizeRoute);

  const queued = new Set<string>();
  const queue: Array<{ route: string; depth: number }> = [];
  const pages: CrawlPage[] = [];
  const failures: CrawlFailure[] = [];
  const warnings: string[] = [];

  const enqueue = (route: string, depth: number): void => {
    if (queued.has(route)) return;
    queued.add(route);
    queue.push({ route, depth });
  };

  for (const route of startRoutes) enqueue(route, 0);
  // Extra routes enter at depth 0 too: they are explicit user intent, so a depth cap must not drop
  // them, and their own links are worth following.
  for (const route of extraRoutes) enqueue(route, 0);

  let cappedPages = false;
  let cappedDepth = false;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (pages.length >= maxPages) {
      cappedPages = true;
      break;
    }

    const url = new URL(next.route, origin).toString();
    options.onProgress?.({ route: next.route, depth: next.depth, found: queued.size, visited: pages.length });

    // The type is checked from the headers, before the body is read, so a linked PDF or video is
    // never downloaded just to be thrown away.
    const response = await probe(url, { timeoutMs, readBody: servesHtml });
    if (!response.ok) {
      failures.push({ route: next.route, url, reason: response.error ?? `HTTP ${response.status}` });
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!servesHtml(response.headers)) {
      failures.push({ route: next.route, url, reason: `Served ${contentType}, not HTML - skipped.` });
      continue;
    }
    if (response.truncated) {
      failures.push({ route: next.route, url, reason: ERRORS.pageTooLarge(MAX_PROBE_BYTES) });
      continue;
    }
    if (!response.body) {
      failures.push({ route: next.route, url, reason: `HTTP ${response.status} with an empty body` });
      continue;
    }

    pages.push({ route: next.route, url, depth: next.depth, html: response.body, status: response.status, contentType });

    if (next.depth >= maxDepth) {
      cappedDepth = true;
      continue;
    }

    for (const link of extractLinks(response.body, response.finalUrl || url)) {
      if (!isCrawlable(link, origin, exclude)) continue;
      enqueue(normalizeRoute(link.pathname), next.depth + 1);
    }
  }

  if (cappedPages) {
    warnings.push(
      `Stopped at the ${maxPages}-page cap with ${queue.length} route${queue.length === 1 ? '' : 's'} still queued. Raise crawl.maxPages in opengeo.config.json to go further.`,
    );
  }
  if (cappedDepth) {
    warnings.push(
      `Stopped following links at depth ${maxDepth}. Raise crawl.maxDepth in opengeo.config.json, or list the deeper routes in extraRoutes.`,
    );
  }

  return { site: options.site, origin, pages, failures, warnings };
}

/** No content type is taken as HTML, as it always was here; any other type has to say so. */
function servesHtml(headers: Headers): boolean {
  const type = headers.get('content-type');
  return !type || type.toLowerCase().includes('html');
}

/**
 * Every `<a href>` in the document, resolved against the page's own URL.
 *
 * Scripts are not executed (§17): this sees the links that were in the HTML the server sent, which
 * is exactly the set an AI crawler sees.
 */
export function extractLinks(html: string, pageUrl: string): URL[] {
  const dom = new JSDOM(html, { url: pageUrl });
  const out: URL[] = [];
  for (const anchor of Array.from(dom.window.document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data|blob|sms|ftp):/i.test(trimmed)) continue;
    try {
      out.push(new URL(trimmed, pageUrl));
    } catch {
      // A malformed href is the page's problem, not something to fail the crawl over.
    }
  }
  dom.window.close();
  return out;
}

/**
 * Same origin, not an asset, not framework internals, not excluded.
 *
 * Query strings are dropped rather than treated as distinct routes: `?page=2` and `?utm_source=x`
 * are the two common cases, and generating a separate twin for every query variant of the same page
 * is how a crawl explodes.
 */
export function isCrawlable(link: URL, origin: string, exclude: readonly string[] = []): boolean {
  if (link.origin !== origin) return false;
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return false;

  const route = normalizeRoute(link.pathname);
  if (INTERNAL_PREFIXES.some((prefix) => route.startsWith(prefix))) return false;
  if (exclude.some((prefix) => route === prefix || route.startsWith(`${prefix}/`))) return false;

  const extension = /\.([a-z0-9]{1,8})$/i.exec(route)?.[1]?.toLowerCase();
  if (extension && NON_PAGE_EXTENSIONS.has(extension)) return false;

  return true;
}
