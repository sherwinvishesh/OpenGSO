import { existsSync } from 'node:fs';
import { resolveBots } from '../shared/bots.js';
import { internalDirPath, isLoopbackUrl, publicDirPath, publicOriginOf } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { basePathOf, normalizeRoute } from '../shared/routes.js';
import { whyUnreachable } from '../shared/http.js';
import { crawlSite } from './crawl.js';
import { writeSiteFiles } from './files.js';
import { refreshEdgeData } from '../prod/edge-data.js';
import { generatePages } from './generate.js';
import { manifestPath } from './manifest.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { CrawlProgress, CrawlResult } from './crawl.js'
 * @import { SiteFileResult, SitePage } from './files.js'
 * @import { EnhanceInput, EnhanceOutput, GenerateProgress, GenerateResult } from './generate.js'
 */

/**
 * A site generate cannot read pages from the way it was asked to: a folder with no pages in it, or a
 * site in a folder of its host given as something to crawl. Written for the person who has to fix
 * it, so the dashboard can show it as it is.
 */
export class SourceFilesError extends Error {
  /** @override */
  name = 'SourceFilesError';
}

/**
 * One crawl, three outputs (§6).
 *
 * This is the whole of `opengso generate` above the CLI: discover routes by following links, turn
 * each discovered page into a markdown twin, then write robots.txt, llms.txt and sitemap.xml from
 * that same page list. Nothing is fetched twice - the HTML the crawl already downloaded is handed
 * straight to the generator.
 *
 * The CLI and the product website both call this function, so the UI can never drift into being a
 * second implementation of the pipeline (§8).
 */

/**
 * @typedef {{ phase: 'crawl'; crawl: CrawlProgress }
 *   | { phase: 'generate'; generate: GenerateProgress }
 *   | { phase: 'files' }} SiteProgress
 */

/**
 * @typedef {object} GenerateSiteOptions
 * @property {string} target The URL the user typed. Its origin is the site; its path is where the
 *   crawl starts.
 * @property {LoadedConfig} loaded
 * @property {'free' | 'ai'} [tier]
 * @property {boolean} [force]
 * @property {boolean} [single] Generate only the target URL, no crawl. Keeps every other page in the
 *   manifest untouched.
 * @property {number} [maxPages]
 * @property {number} [maxDepth]
 * @property {number} [timeoutMs]
 * @property {boolean} [skipSiteFiles] Skip robots.txt / llms.txt / sitemap.xml entirely.
 * @property {boolean} [prune] Delete orphaned twins OpenGSO wrote, rather than only reporting them.
 *   Refused, with a warning, on a run that cannot tell a deleted page from one it did not reach.
 * @property {string} [siteName]
 * @property {string} [siteDescription]
 * @property {(input: EnhanceInput) => Promise<EnhanceOutput>} [enhance]
 * @property {(event: SiteProgress) => void} [onProgress]
 * @property {AbortSignal} [signal] Set by the dashboard, aborted when the browser that asked for the
 *   run goes away. The crawl and each page check it, so a closed tab stops paying for AI calls.
 */

/**
 * @typedef {object} GenerateSiteResult
 * @property {string} site Origin every route is resolved against.
 * @property {string} target
 * @property {boolean} single
 * @property {CrawlResult} [crawl]
 * @property {GenerateResult} generate
 * @property {SiteFileResult[]} files
 * @property {string[]} warnings
 * @property {string[]} [notes] Worth knowing and not a problem, such as where the public address came
 *   from.
 * @property {number} durationMs
 * @property {'url' | 'files'} source Whether the pages were crawled or read from the web root.
 * @property {{ found: number; skipped: string[]; capped: boolean }} [scan] What reading the web root
 *   found, on a run that read files.
 */

/**
 * @param {GenerateSiteOptions} options
 * @returns {Promise<GenerateSiteResult>}
 */
export async function generateSite(options) {
  const started = Date.now();
  const target = new URL(options.target);
  const site = target.origin;
  const config = options.loaded.config;
  /** @type {string[]} */
  const warnings = [];
  const origin = publicOriginOf(config, site);
  // A crawl's routes are paths on the server it crawls, and its twins go where opengso-prod serves
  // them from. Neither has a place for the folder a site like that is published in, and its build
  // folder, read as files, does.
  if (basePathOf(origin)) throw new SourceFilesError(ERRORS.folderSiteCrawl(origin));

  /** @type {CrawlResult | undefined} */
  let crawl;
  /** @type {string[]} */
  let routes;
  /** @type {readonly string[] | 'all'} */
  let carryForward = [];
  /** @type {Map<string, string>} */
  const sources = new Map();

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
      signal: options.signal,
      onProgress: (event) => options.onProgress?.({ phase: 'crawl', crawl: event }),
    });
    warnings.push(...crawl.warnings);
    for (const page of crawl.pages) sources.set(page.route, page.html);
    routes = crawl.pages.map((page) => page.route);

    carryForward = crawl.failures.map((failure) => failure.route);
    if (routes.length === 0) {
      // The start page itself failed. Fall through with the single route so the caller gets a real
      // per-page error rather than a silent empty run, and keep everything generated before, since
      // a run that reached no page cannot say any of them are gone.
      routes = [normalizeRoute(target.pathname)];
      carryForward = 'all';
      const why = whyUnreachable(options.target, crawl.failures[0]?.reason ?? 'fetch failed');
      warnings.push(ERRORS.siteUnreachable(site, why, existsSync(manifestPath(internalDirPath(options.loaded)))));
    } else {
      for (const failure of crawl.failures) warnings.push(`${failure.route}: ${failure.reason}`);
    }
  }
  // Every absolute URL generate writes names this origin, so a loopback one ships a sitemap and an
  // llms.txt that point nobody anywhere. Said first, because the run otherwise looks like a success,
  // and not at all by a run that reached nothing and so wrote nothing.
  if (isLoopbackUrl(origin) && carryForward !== 'all') warnings.unshift(ERRORS.loopbackPublicOrigin(origin));

  // Pruning trusts the crawl to have seen the whole site. A run that reached no page, or stopped at
  // a page or depth cap, has not, and a page it missed may well still exist.
  let prune = options.prune === true;
  if (prune && (carryForward === 'all' || crawl?.capped)) {
    warnings.push(ERRORS.pruneRefused(carryForward === 'all' ? 'no page could be fetched' : 'the crawl stopped at a cap'));
    prune = false;
  }

  const generate = await generatePages({
    site,
    routes,
    loaded: options.loaded,
    tier: options.tier,
    force: options.force,
    merge: options.single === true,
    carryForward,
    prune,
    sources,
    enhance: options.enhance,
    signal: options.signal,
    onProgress: (event) => options.onProgress?.({ phase: 'generate', generate: event }),
  });

  /** @type {SiteFileResult[]} */
  let files = [];
  // A run that reached no page has nothing new to describe. The files would be rebuilt from the
  // manifest it kept, and on a first run that is an empty llms.txt and sitemap.xml, written by a run
  // whose only finding was that the server is not up.
  if (!options.skipSiteFiles && carryForward !== 'all') {
    options.onProgress?.({ phase: 'files' });
    files = writeSiteFilesFor(options.loaded, origin, generate, options, warnings);
  }
  const edge = refreshEdgeData(options.loaded);
  warnings.push(...edge.warnings);

  return {
    site,
    target: options.target,
    single: options.single === true,
    crawl,
    generate,
    files,
    warnings: [...generate.warnings, ...warnings],
    ...(edge.notes.length > 0 ? { notes: edge.notes } : {}),
    durationMs: Date.now() - started,
    source: 'url',
  };
}

/**
 * robots.txt, llms.txt and sitemap.xml for what a run left in the manifest.
 *
 * Driven off the manifest rather than this run's page list, so a single-page rerun and a
 * fully-cached rerun both still describe the whole site. A file OpenGSO could not write, or that is
 * somebody else's, adds its message to `warnings`.
 *
 * @param {LoadedConfig} loaded
 * @param {string} origin
 * @param {GenerateResult} generate
 * @param {{ siteName?: string; siteDescription?: string; force?: boolean }} options
 * @param {string[]} warnings
 * @returns {SiteFileResult[]}
 */
export function writeSiteFilesFor(loaded, origin, generate, options, warnings) {
  const config = loaded.config;
  /** @type {SitePage[]} */
  const pages = Object.values(generate.manifest.pages).map((entry) => ({
    route: entry.route,
    url: entry.url,
    canonical: entry.canonical,
    title: entry.title,
    description: entry.description,
    tokens: entry.tokens,
    lastUpdated: entry.lastUpdated,
    lastModified: entry.lastModified,
  }));

  const files = writeSiteFiles({
    site: origin,
    publicDir: publicDirPath(loaded),
    pages,
    blocked: config.bots.blocked,
    bots: resolveBots(config.bots.custom),
    siteName: options.siteName ?? pages.find((p) => p.route === '/')?.title,
    siteDescription: options.siteDescription ?? pages.find((p) => p.route === '/')?.description,
    force: options.force,
    negotiated: generate.manifest.source !== 'files',
  });

  for (const file of files) {
    if (file.status === 'proposed' || file.status === 'failed') {
      warnings.push(file.message ?? `${file.name}: ${file.status}`);
    }
  }
  return files;
}
