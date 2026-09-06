import { probe } from '../shared/http.js';
import { isMarkdownPath, twinUrl } from '../shared/routes.js';
import type { Evidence } from './evidence.js';

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

export type TwinSource = 'requested' | 'llms.txt' | 'sitemap.xml' | 'advertised';

export interface DiscoveredTwin {
  url: string;
  /** The page this document is the twin of, when it follows the `<path>.md` convention. */
  pageUrl?: string;
  source: TwinSource;
  markdown: string;
  bytes: number;
  words: number;
}

export interface DiscoveryResult {
  /** Verified documents, requested-first, then in the order the site listed them. */
  twins: DiscoveredTwin[];
  /** Candidates that were fetched and rejected, with the reason, so the report can say why. */
  rejected: Array<{ url: string; source: TwinSource; reason: string }>;
  /** How many candidates were dropped before fetching because of the cap. */
  overCap: number;
  sources: { llms: boolean; sitemap: boolean };
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Hard cap on how many candidate URLs are fetched. A sitemap can list thousands. */
  maxFetch?: number;
  /** Evidence from a structural run, so the main flow does not fetch llms.txt or the twin twice. */
  evidence?: Evidence;
  /** How many candidates are fetched at once. */
  concurrency?: number;
}

const DEFAULT_MAX_FETCH = 25;
const DEFAULT_CONCURRENCY = 5;

export async function discoverTwins(target: URL, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
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

  const candidates = new Map<string, TwinSource>();
  const add = (url: string, source: TwinSource) => {
    if (!candidates.has(url)) candidates.set(url, source);
  };

  add(requested, evidence?.advertisedTwinUrl === requested ? 'advertised' : 'requested');
  if (llms.ok) for (const url of markdownLinksIn(llms.body, target.origin)) add(url, 'llms.txt');
  if (sitemap.ok) for (const url of sitemapTwins(sitemap.body, target.origin)) add(url, 'sitemap.xml');

  const all = [...candidates.entries()];
  const fetching = all.slice(0, maxFetch);
  const overCap = all.length - fetching.length;

  const twins: DiscoveredTwin[] = [];
  const rejected: DiscoveryResult['rejected'] = [];

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

function judge(result: { ok: boolean; status: number; body: string }): { ok: true } | { ok: false; reason: string } {
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
 */
export function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(body.slice(0, 400));
}

/** Markdown links and bare URLs in llms.txt that point at a `.md` document on this origin. */
export function markdownLinksIn(body: string, origin: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw, origin);
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

  for (const [, href] of body.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) push(href!);
  for (const [bare] of body.matchAll(/https?:\/\/[^\s)<>"']+\.md\b/g)) push(bare);
  return out;
}

/** Every `<loc>` in a sitemap, mapped through the twin-URL convention. */
export function sitemapTwins(body: string, origin: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [, loc] of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(loc!), origin);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const candidate = isMarkdownPath(url.pathname) ? url.toString() : twinUrl(url.toString());
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/** `/resume.md` -> `/resume`, so the report can name the page a document belongs to. */
function pageUrlOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!isMarkdownPath(parsed.pathname)) return undefined;
    parsed.pathname = parsed.pathname.replace(/\/index\.md$/, '/').replace(/\.md$/, '');
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run));
  }
}
