import { resolveBots } from '../shared/bots.js';
import type { LoadedConfig } from '../shared/config.js';
import { publicDirPath } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { normalizeRoute } from '../shared/routes.js';
import type { CrawlProgress, CrawlResult } from './crawl.js';
import { crawlSite } from './crawl.js';
import type { SiteFileResult, SitePage } from './files.js';
import { writeSiteFiles } from './files.js';
import type { EnhanceInput, EnhanceOutput, GenerateProgress, GenerateResult } from './generate.js';
import { generatePages } from './generate.js';

/**
 * One crawl, three outputs (§6).
 *
 * This is the whole of `opengeo generate` above the CLI: discover routes by following links, turn
 * each discovered page into a markdown twin, then write robots.txt, llms.txt and sitemap.xml from
 * that same page list. Nothing is fetched twice - the HTML the crawl already downloaded is handed
 * straight to the generator.
 *
 * The CLI and the product website both call this function, so the UI can never drift into being a
 * second implementation of the pipeline (§8).
 */

export type SiteProgress =
  | { phase: 'crawl'; crawl: CrawlProgress }
  | { phase: 'generate'; generate: GenerateProgress }
  | { phase: 'files' };

export interface GenerateSiteOptions {
  /** The URL the user typed. Its origin is the site; its path is where the crawl starts. */
  target: string;
  loaded: LoadedConfig;
  tier?: 'free' | 'ai';
  force?: boolean;
  /** Generate only the target URL, no crawl. Keeps every other page in the manifest untouched. */
  single?: boolean;
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  /** Skip robots.txt / llms.txt / sitemap.xml entirely. */
  skipSiteFiles?: boolean;
  siteName?: string;
  siteDescription?: string;
  enhance?: (input: EnhanceInput) => Promise<EnhanceOutput>;
  onProgress?: (event: SiteProgress) => void;
}

export interface GenerateSiteResult {
  /** Origin every route is resolved against. */
  site: string;
  target: string;
  single: boolean;
  crawl?: CrawlResult;
  generate: GenerateResult;
  files: SiteFileResult[];
  warnings: string[];
  durationMs: number;
}

export async function generateSite(options: GenerateSiteOptions): Promise<GenerateSiteResult> {
  const started = Date.now();
  const target = new URL(options.target);
  const site = target.origin;
  const config = options.loaded.config;
  const warnings: string[] = [];

  let crawl: CrawlResult | undefined;
  let routes: string[];
  let carryForward: readonly string[] | 'all' = [];
  const sources = new Map<string, string>();

  if (options.single) {
    routes = [normalizeRoute(target.pathname)];
  } else {
    crawl = await crawlSite({
      site,
      startRoutes: [target.pathname],
      extraRoutes: config.extraRoutes,
      maxPages: options.maxPages ?? config.crawl.maxPages,
      maxDepth: options.maxDepth ?? config.crawl.maxDepth,
      exclude: config.crawl.exclude,
      timeoutMs: options.timeoutMs,
      onProgress: (event) => options.onProgress?.({ phase: 'crawl', crawl: event }),
    });
    warnings.push(...crawl.warnings);
    for (const page of crawl.pages) sources.set(page.route, page.html);
    routes = crawl.pages.map((page) => page.route);

    for (const failure of crawl.failures) {
      warnings.push(`${failure.route}: ${failure.reason}`);
    }
    carryForward = crawl.failures.map((failure) => failure.route);
    if (routes.length === 0) {
      // The start page itself failed. Fall through with the single route so the caller gets a real
      // per-page error rather than a silent empty run, and keep everything generated before, since
      // a run that reached no page cannot say any of them are gone.
      routes = [normalizeRoute(target.pathname)];
      carryForward = 'all';
      warnings.push(ERRORS.siteUnreachableKept);
    }
  }

  const generate = await generatePages({
    site,
    routes,
    loaded: options.loaded,
    tier: options.tier,
    force: options.force,
    merge: options.single === true,
    carryForward,
    sources,
    enhance: options.enhance,
    onProgress: (event) => options.onProgress?.({ phase: 'generate', generate: event }),
  });

  let files: SiteFileResult[] = [];
  if (!options.skipSiteFiles) {
    options.onProgress?.({ phase: 'files' });
    // Driven off the manifest rather than this run's page list, so a single-page rerun and a
    // fully-cached rerun both still describe the whole site.
    const pages: SitePage[] = Object.values(generate.manifest.pages).map((entry) => ({
      route: entry.route,
      url: entry.url,
      title: entry.title,
      description: entry.description,
      tokens: entry.tokens,
      lastUpdated: entry.lastUpdated,
    }));

    files = writeSiteFiles({
      site,
      publicDir: publicDirPath(options.loaded),
      pages,
      blocked: config.bots.blocked,
      bots: resolveBots(config.bots.custom),
      siteName: options.siteName ?? pages.find((p) => p.route === '/')?.title,
      siteDescription: options.siteDescription ?? pages.find((p) => p.route === '/')?.description,
      force: options.force,
    });

    for (const file of files) {
      if (file.status === 'proposed' || file.status === 'failed') {
        warnings.push(file.message ?? `${file.name}: ${file.status}`);
      }
    }
  }

  return {
    site,
    target: options.target,
    single: options.single === true,
    crawl,
    generate,
    files,
    warnings,
    durationMs: Date.now() - started,
  };
}
