import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { internalDirPath, isLoopbackUrl, publicDirPath } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { contentHash } from '../shared/hash.js';
import { MAX_PROBE_BYTES } from '../shared/http.js';
import { fileToRoute, isIndexFile, listLocalPages, shownPath } from '../shared/local-pages.js';
import { normalizeRoute, twinFileKey } from '../shared/routes.js';
import { generatePages } from './generate.js';
import { readManifest } from './manifest.js';
import { writeSiteFilesFor } from './site.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { LocalPage } from '../shared/local-pages.js'
 * @import { EnhanceInput, EnhanceOutput, GeneratePageResult, SourceStamp } from './generate.js'
 * @import { GenerateSiteResult, SiteProgress } from './site.js'
 */

/**
 * `opengeo generate site/`: the same pipeline as a crawl, fed from the HTML files in the web root
 * instead of from a running server.
 *
 * A site that is a folder of pages, hand-written or built by a static site generator, has no server
 * to crawl until it is deployed, and the people who make one are the least likely to run a local
 * one. Reading the files also gives generate something a crawl never has, the file each page came
 * from, which is what lets OpenGEO say a twin is older than its page.
 *
 * Each twin is written beside its page, because the static host that serves the folder answers
 * `/about.md` only if a file sits at exactly that path.
 */

/**
 * @typedef {object} GenerateFromFilesOptions
 * @property {LoadedConfig} loaded Its `publicDir` is the folder that is read.
 * @property {string} [file] One page to regenerate, relative to the web root with forward slashes.
 *   Every other entry in the manifest is kept as it is.
 * @property {string} [origin] Where the site is published, from `--origin`. Wins over the config.
 * @property {string} [target] What the user typed, for the report.
 * @property {'free' | 'ai'} [tier]
 * @property {boolean} [force]
 * @property {number} [maxPages]
 * @property {boolean} [skipSiteFiles]
 * @property {boolean} [prune]
 * @property {string} [siteName]
 * @property {string} [siteDescription]
 * @property {(input: EnhanceInput) => Promise<EnhanceOutput>} [enhance]
 * @property {(event: SiteProgress) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

/**
 * A folder generate cannot read pages from. Written for the person who has to fix it, so the
 * dashboard can show it as it is.
 */
export class SourceFilesError extends Error {
  /** @override */
  name = 'SourceFilesError';
}

/**
 * @param {GenerateFromFilesOptions} options
 * @returns {Promise<GenerateSiteResult>}
 */
export async function generateFromFiles(options) {
  const started = Date.now();
  const { loaded } = options;
  const config = loaded.config;
  const webRoot = publicDirPath(loaded);
  const shown = shownPath(webRoot);
  if (!isDirectory(webRoot)) throw new SourceFilesError(ERRORS.filesWebRootMissing(shown));

  const listing = listLocalPages(webRoot, {
    exclude: config.crawl.exclude,
    maxPages: options.maxPages ?? config.crawl.maxPages,
    skipDirs: [internalDirPath(loaded)],
  });
  if (listing.pages.length === 0) throw new SourceFilesError(ERRORS.noHtmlFiles(shown));

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const notes = [];

  /** @type {Map<string, string>} */
  const html = new Map();
  /** @type {Map<string, string>} */
  const unreadable = new Map();
  for (const page of listing.pages) {
    if (page.size > MAX_PROBE_BYTES) {
      unreadable.set(page.file, ERRORS.pageTooLarge(MAX_PROBE_BYTES));
      continue;
    }
    try {
      html.set(page.file, readFileSync(page.path, 'utf8'));
    } catch (error) {
      unreadable.set(page.file, ERRORS.sourceUnreadable(page.file, error instanceof Error ? error.message : String(error)));
    }
  }

  const home = listing.pages.find((page) => isIndexFile(page.file));
  const chosen = chooseOrigin(options.origin, config, home ? { file: home.file, html: html.get(home.file) ?? '' } : undefined);
  const origin = chosen.origin;
  if (chosen.note) notes.push(chosen.note);
  if (chosen.warning) warnings.push(chosen.warning);
  if (looksLikeGitHubPages(webRoot)) notes.push(ERRORS.jekyllWillConvertTwins(shown));

  const resolved = resolveRoutes(listing.pages, html, origin);
  warnings.push(...resolved.warnings);

  const previous = readManifest(internalDirPath(loaded), origin);
  /** @param {string} file */
  const previousRoute = (file) => Object.values(previous.pages).find((entry) => entry.sourceFile === file)?.route;

  /** @type {GeneratePageResult[]} */
  const failures = [];
  /** @type {string[]} */
  const carryForward = [];
  /** @type {string[]} */
  const routes = [];
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {Map<string, SourceStamp>} */
  const sourceFiles = new Map();

  const wanted = options.file === undefined ? undefined : options.file;
  if (wanted !== undefined && !listing.pages.some((page) => page.file === wanted)) {
    throw new SourceFilesError(ERRORS.htmlFileNotAPage(join(shown, wanted)));
  }

  for (const page of listing.pages) {
    if (wanted !== undefined && page.file !== wanted) continue;
    const route = resolved.routes.get(page.file);
    if (route === undefined) {
      // Lost a collision. Said once in the warnings for a whole run; a single-page run asked for this
      // file by name, so it gets the reason as its result.
      const lost = resolved.losers.get(page.file);
      if (wanted !== undefined && lost) {
        failures.push({ route: lost.route, url: new URL(lost.route, origin).toString(), status: 'failed', warnings: [], sourceFile: page.file, reason: lost.reason });
      }
      continue;
    }
    const why = unreadable.get(page.file);
    const text = html.get(page.file);
    if (why !== undefined || text === undefined) {
      const kept = previousRoute(page.file) ?? route;
      failures.push({ route: kept, url: new URL(kept, origin).toString(), status: 'failed', warnings: [], sourceFile: page.file, reason: why ?? '' });
      carryForward.push(kept);
      continue;
    }
    routes.push(route);
    sources.set(route, text);
    sourceFiles.set(route, { file: page.file, modified: new Date(page.mtimeMs).toISOString(), hash: contentHash(text) });
  }

  const single = wanted !== undefined;
  // Pruning trusts the run to have read every page. One that stopped at the page cap has not.
  let prune = options.prune === true && !single;
  if (prune && listing.capped) {
    warnings.push(ERRORS.pruneRefused('the folder held more pages than crawl.maxPages, so some were not read'));
    prune = false;
  }
  if (listing.capped) warnings.push(ERRORS.filesCapped(options.maxPages ?? config.crawl.maxPages));

  // Every URL generate writes names `origin`. Set on the config the generator reads, because a
  // publicOrigin there would otherwise win over the --origin this run was given.
  const effective = { ...loaded, config: { ...config, publicOrigin: origin } };
  const generate = await generatePages({
    site: origin,
    routes,
    loaded: effective,
    tier: options.tier,
    force: options.force,
    merge: single,
    carryForward,
    prune,
    sources,
    sourceFiles,
    layout: 'beside',
    enhance: options.enhance,
    signal: options.signal,
    onProgress: (event) => options.onProgress?.({ phase: 'generate', generate: event }),
  });
  generate.pages.push(...failures);

  /** @type {import('./files.js').SiteFileResult[]} */
  let files = [];
  if (!options.skipSiteFiles) {
    options.onProgress?.({ phase: 'files' });
    files = writeSiteFilesFor(effective, origin, generate, options, warnings);
  }

  return {
    site: origin,
    target: options.target ?? shown,
    single,
    generate,
    files,
    warnings: [...generate.warnings, ...warnings],
    notes,
    durationMs: Date.now() - started,
    source: 'files',
    scan: { found: listing.pages.length, skipped: listing.skipped, capped: listing.capped },
  };
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The origin every URL generate writes should name.
 *
 * A folder carries no address of its own, so this goes through what the user said (the flag, then
 * the config), then what the site says about itself (an absolute canonical link on the home page),
 * and only then falls back to the config's `site`, with a warning when that is a loopback address
 * nobody else can reach.
 *
 * @param {string | undefined} flag
 * @param {LoadedConfig['config']} config
 * @param {{ file: string; html: string } | undefined} home
 * @returns {{ origin: string; note?: string; warning?: string }}
 */
export function chooseOrigin(flag, config, home) {
  if (flag) return { origin: new URL(flag).origin };
  if (config.publicOrigin) return { origin: new URL(config.publicOrigin).origin };
  const site = URL.canParse(config.site) ? new URL(config.site) : new URL('http://localhost:3000');
  if (!isLoopbackUrl(site.toString())) return { origin: site.origin };
  const declared = home ? canonicalOf(home.html) : undefined;
  if (declared && URL.canParse(declared)) {
    const url = new URL(declared);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !isLoopbackUrl(url.toString())) {
      return { origin: url.origin, note: ERRORS.originFromCanonical(url.origin, /** @type {{ file: string }} */ (home).file) };
    }
  }
  return { origin: site.origin, warning: ERRORS.filesOriginUnknown(site.origin) };
}

/**
 * A GitHub Pages site runs through Jekyll unless the folder holds `.nojekyll`, and Jekyll turns
 * every `.md` file with frontmatter into an HTML page: `index.md` would be built into the very
 * `index.html` it is the twin of. A `CNAME` file, a Jekyll config or a folder named `docs`, the one
 * GitHub Pages publishes from, is enough of a sign to say so.
 *
 * @param {string} webRoot
 * @returns {boolean}
 */
function looksLikeGitHubPages(webRoot) {
  if (existsSync(join(webRoot, '.nojekyll'))) return false;
  return existsSync(join(webRoot, 'CNAME')) || existsSync(join(webRoot, '_config.yml')) || /(^|[\\/])docs$/.test(webRoot);
}

// -- routes --------------------------------------------------------------------------------------

/**
 * The parts of a page a link scan must not read: a comment or a script can hold markup that is
 * never a link on the page.
 */
const NOT_MARKUP = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi;
const ANCHOR = /<a\b[^>]*>/gi;
const LINK = /<link\b[^>]*>/gi;
/** Resolves a page's relative links without pretending to know where the site lives. */
const LOCAL_ORIGIN = 'http://files.invalid';

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string | undefined}
 */
function attribute(tag, name) {
  const match = new RegExp(`[\\s<]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  const value = match ? (match[1] ?? match[2] ?? match[3]) : undefined;
  return value?.replace(/&amp;/gi, '&').trim();
}

/**
 * The href of a page's `<link rel="canonical">`, as written.
 *
 * @param {string} html
 * @returns {string | undefined}
 */
export function canonicalOf(html) {
  for (const tag of html.replace(NOT_MARKUP, '').match(LINK) ?? []) {
    const rel = attribute(tag, 'rel');
    if (rel && rel.toLowerCase().split(/\s+/).includes('canonical')) return attribute(tag, 'href');
  }
  return undefined;
}

/**
 * Where a page's relative links are resolved from: its own file, so `post.html` in `blog/index.html`
 * is `/blog/post.html` whichever form the site serves it in.
 *
 * @param {string} file
 * @returns {URL}
 */
function baseOf(file) {
  const name = /** @type {string} */ (file.split('/').pop());
  const path = isIndexFile(name) ? `${fileToRoute(file)}/`.replace(/\/{2,}$/, '/') : fileToRoute(file, 'file');
  return new URL(path, LOCAL_ORIGIN);
}

/**
 * The same site, whatever the scheme and with or without `www.`, which is how people link.
 *
 * @param {URL} url
 * @param {string} origin
 * @returns {boolean}
 */
function sameSite(url, origin) {
  if (url.origin === LOCAL_ORIGIN) return true;
  const strip = (/** @type {string} */ host) => host.replace(/^www\./, '');
  return (url.protocol === 'http:' || url.protocol === 'https:') && strip(url.host) === strip(new URL(origin).host);
}

/**
 * @typedef {object} ResolvedRoutes
 * @property {Map<string, string>} routes File to the route it is served at, for every file that
 *   won its URL.
 * @property {Map<string, { route: string; reason: string }>} losers Files left out because another
 *   file is served at the same URL, with that URL and the reason.
 * @property {string[]} warnings
 */

/**
 * The URL each file is served at.
 *
 * An index file is its folder. Any other page is `/about.html` or `/about`, and which one is a fact
 * about how the site is served that only the site knows, so it is read off the site: its own links
 * vote. A link to `/about.html` says the file form, a link to `/about` the clean one, a page's own
 * majority decides it, then the site's, and with no links at all the file form, which every host
 * answers to. A canonical link that names one of the page's own forms settles it outright, and one
 * that names some other address on the site is believed when no other page has a claim to it: that
 * is a host rewrite generate could not otherwise see.
 *
 * @param {readonly LocalPage[]} pages
 * @param {ReadonlyMap<string, string>} html By file. A file that could not be read has no entry.
 * @param {string} origin
 * @returns {ResolvedRoutes}
 */
export function resolveRoutes(pages, html, origin) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, LocalPage>} */
  const byFileForm = new Map();
  /** @type {Map<string, LocalPage>} */
  const byCleanForm = new Map();
  /** @type {Map<string, LocalPage>} */
  const byIndexRoute = new Map();
  for (const page of pages) {
    if (isIndex(page)) byIndexRoute.set(fileToRoute(page.file), page);
    else {
      byFileForm.set(fileToRoute(page.file, 'file'), page);
      byCleanForm.set(fileToRoute(page.file, 'clean'), page);
    }
  }

  /** @type {Map<string, { file: number; clean: number }>} */
  const votes = new Map();
  const total = { file: 0, clean: 0 };
  for (const page of pages) {
    const text = html.get(page.file);
    if (!text) continue;
    const base = baseOf(page.file);
    for (const tag of text.replace(NOT_MARKUP, '').match(ANCHOR) ?? []) {
      const href = attribute(tag, 'href');
      if (!href || href.startsWith('#') || !URL.canParse(href, base)) continue;
      const url = new URL(href, base);
      if (!sameSite(url, origin)) continue;
      const path = normalizeRoute(url.pathname);
      // `/about` is the folder's index when there is one, so it says nothing about about.html.
      const target = byFileForm.get(path) ?? (byIndexRoute.has(path) ? undefined : byCleanForm.get(path));
      if (!target) continue;
      const form = byFileForm.has(path) ? 'file' : 'clean';
      const tally = votes.get(target.file) ?? { file: 0, clean: 0 };
      tally[form] += 1;
      total[form] += 1;
      votes.set(target.file, tally);
    }
  }
  const siteForm = total.clean > total.file ? 'clean' : 'file';

  /** @type {Map<string, string>} */
  const natural = new Map();
  for (const page of pages) {
    if (isIndex(page)) {
      natural.set(page.file, fileToRoute(page.file));
      continue;
    }
    const tally = votes.get(page.file);
    const form = tally && tally.file !== tally.clean ? (tally.file > tally.clean ? 'file' : 'clean') : siteForm;
    natural.set(page.file, fileToRoute(page.file, form));
  }

  // Every form of every page, so a canonical naming another page can be told apart from a rewrite.
  // Index files last: `/about` is about/index.html's URL before it is about.html's clean one.
  /** @type {Map<string, LocalPage>} */
  const owners = new Map([...byCleanForm, ...byFileForm, ...byIndexRoute]);
  /** @type {Map<string, string>} */
  const routes = new Map(natural);
  /** @type {Map<string, { url: string; files: string[] }>} */
  const borrowed = new Map();
  /** @type {Map<string, string[]>} */
  const rewrites = new Map();
  for (const page of pages) {
    const text = html.get(page.file);
    const href = text ? canonicalOf(text) : undefined;
    if (!href || !URL.canParse(href, baseOf(page.file))) continue;
    const url = new URL(href, baseOf(page.file));
    if (!sameSite(url, origin)) continue;
    const path = normalizeRoute(url.pathname);
    if (path.endsWith('.md')) continue;
    const owner = owners.get(path);
    if (ownForms(page).includes(path)) {
      routes.set(page.file, path);
    } else if (owner) {
      const group = borrowed.get(path) ?? { url: url.origin === LOCAL_ORIGIN ? path : `${url.origin}${path}`, files: [] };
      group.files.push(page.file);
      borrowed.set(path, group);
    } else {
      rewrites.set(path, [...(rewrites.get(path) ?? []), page.file]);
    }
  }
  for (const [path, group] of borrowed) {
    warnings.push(ERRORS.canonicalNotOwn(group.url, group.files, owners.get(path)?.file));
  }
  for (const [path, files] of rewrites) {
    if (files.length === 1) routes.set(files[0], path);
    else warnings.push(ERRORS.canonicalNotOwn(path, files, undefined));
  }

  // Two files served at one URL would write one twin. The one a host is likelier to serve keeps it.
  /** @type {Map<string, LocalPage[]>} */
  const byTwin = new Map();
  for (const page of pages) {
    const key = twinFileKey(/** @type {string} */ (routes.get(page.file)), 'beside');
    byTwin.set(key, [...(byTwin.get(key) ?? []), page]);
  }
  /** @type {Map<string, { route: string; reason: string }>} */
  const losers = new Map();
  for (const group of byTwin.values()) {
    if (group.length < 2) continue;
    const [winner, ...rest] = [...group].sort(preferred);
    const route = /** @type {string} */ (routes.get(winner.file));
    for (const page of rest) {
      const reason = ERRORS.sameUrlFiles(page.file, winner.file, route);
      warnings.push(reason);
      losers.set(page.file, { route, reason });
      routes.delete(page.file);
    }
  }
  return { routes, losers, warnings };
}

/**
 * The URLs a page can be served at without a rewrite.
 *
 * @param {LocalPage} page
 * @returns {string[]}
 */
function ownForms(page) {
  return isIndex(page) ? [fileToRoute(page.file)] : [fileToRoute(page.file, 'file'), fileToRoute(page.file, 'clean')];
}

/**
 * @param {LocalPage} page
 * @returns {boolean}
 */
function isIndex(page) {
  return isIndexFile(/** @type {string} */ (page.file.split('/').pop()));
}

/**
 * `about.html` over `about/index.html`, `.html` over `.htm`, then path order.
 *
 * @param {LocalPage} a
 * @param {LocalPage} b
 * @returns {number}
 */
function preferred(a, b) {
  const score = (/** @type {LocalPage} */ page) => (isIndex(page) ? 2 : 0) + (/\.htm$/i.test(page.file) ? 1 : 0);
  return score(a) - score(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
