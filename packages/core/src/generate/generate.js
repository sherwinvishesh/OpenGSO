import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { internalDirPath, publicDirPath, publicOriginOf } from '../shared/config.js';
import { contentHash } from '../shared/hash.js';
import { ERRORS } from '../shared/errors.js';
import { MAX_PROBE_BYTES, probe } from '../shared/http.js';
import { hasDotSegment, MD_DIR, normalizeRoute, routeToMdRelPath, routeToTwinUrlPath, twinFileKey } from '../shared/routes.js';
import { countWords, estimateTokens } from '../shared/tokens.js';
import { extractPage } from './extract.js';
import { PROPOSED_SUFFIX, writeOrPropose } from './files.js';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';
import { emptyManifest, readManifestChecked, writeManifest } from './manifest.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { GenerationTier, Manifest, ManifestEntry, OrphanTwin } from './manifest.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').PageStatus} PageStatus
 * @typedef {import('../shared/api-types.js').GeneratePageResult} GeneratePageResult
 */

/**
 * @typedef {object} GenerateProgress
 * @property {string} route
 * @property {number} index
 * @property {number} total
 * @property {'fetch' | 'extract' | 'ai' | 'write'} phase
 */

/**
 * @typedef {object} GenerateOptions
 * @property {string} site Base site URL. Every route is resolved against this.
 * @property {string[]} routes Routes to generate. Phase-2 callers pass the crawl result; a
 *   single-page run passes one.
 * @property {LoadedConfig} loaded
 * @property {'free' | 'ai'} [tier]
 * @property {boolean} [force]
 * @property {boolean} [merge] Keep manifest entries for routes this run didn't touch.
 *
 *   A whole-site run wants the default (false): the crawl is authoritative, so a page that has been
 *   deleted should disappear from the manifest and stop being served. A page the crawl tried and
 *   failed to fetch is not deleted, and is handled by `carryForward` instead. A single-page run wants true,
 *   otherwise regenerating one route would quietly drop every other page from the manifest and prod
 *   would stop answering for them at the next boot.
 * @property {readonly string[] | 'all'} [carryForward] Routes this run could not fetch, whose
 *   previous manifest entries are kept as they were.
 *
 *   "The crawl is authoritative" only holds for the pages it actually reached. A 503 is not a
 *   deletion, and prod serves from the manifest, so dropping the entry would un-serve a twin that
 *   is still on disk and still correct. `'all'` keeps every previous entry not regenerated here,
 *   for a run that reached nothing and so learned nothing about which pages still exist.
 * @property {boolean} [prune] Delete orphaned twins instead of only reporting them. Only a file the
 *   manifest lists and whose frontmatter says OpenGEO generated it is ever deleted. The caller decides
 *   whether this run learned enough to say a page is gone; see generateSite.
 * @property {(event: GenerateProgress) => void} [onProgress]
 * @property {AbortSignal} [signal] Checked before each route. An abandoned run throws, after keeping
 *   every previous manifest entry it did not get to, so stopping part way never un-serves a twin.
 * @property {ReadonlyMap<string, string>} [sources] HTML already fetched by the crawl, keyed by
 *   route. Route discovery has to download every page to find its links, so re-downloading them
 *   here would double the request count against the user's own dev server for no gain. A route
 *   missing from the map is fetched normally.
 * @property {(input: EnhanceInput) => Promise<EnhanceOutput>} [enhance] Optional AI enhancer.
 *   Injected rather than imported so the free tier never reaches provider code, and so tests can
 *   drive the fidelity guard with a fake provider.
 */

/**
 * @typedef {object} EnhanceInput
 * @property {string} url
 * @property {string} title
 * @property {string} html
 * @property {string} algorithmicMarkdown
 */

/**
 * @typedef {object} EnhanceOutput
 * @property {string} markdown
 * @property {string[]} warnings
 * @property {boolean} fellBack True when the fidelity guard rejected the AI output and the
 *   algorithmic one was kept.
 * @property {'fidelity' | 'truncated' | 'too-long' | 'unavailable'} [fallback] Why it fell back.
 *   Every reason but `unavailable` would recur on the same content, so it is remembered in the
 *   manifest and the page is not paid for again until it changes.
 */

/**
 * @typedef {object} GenerateResult
 * @property {string} site
 * @property {GeneratePageResult[]} pages
 * @property {Manifest} manifest
 * @property {string} manifestPath
 * @property {string} publicDir
 * @property {string[]} warnings Problems with the run as a whole rather than with one page.
 * @property {OrphanTwin[]} orphans Twins still on disk for pages this run did not find, left alone.
 * @property {OrphanTwin[]} pruned Orphaned twins this run deleted, because it was asked to.
 * @property {number} durationMs
 */

/**
 * Generate markdown twins for a set of routes (§6).
 *
 * Build-time only, never per visitor request: everything here writes static files to disk, so a
 * real visitor only ever receives a file that already exists.
 *
 * @param {GenerateOptions} options
 * @returns {Promise<GenerateResult>}
 */
export async function generatePages(options) {
  const started = Date.now();
  const { loaded, routes, site, tier = 'free', force = false, onProgress, enhance } = options;
  const publicDir = publicDirPath(loaded);
  const internalDir = internalDirPath(loaded);
  // Pages are fetched from `site` and described as living at `origin`: the two differ whenever
  // generate runs against a dev server for a site deployed somewhere else.
  const origin = publicOriginOf(loaded.config, site);

  const { manifest: previous, problem } = readManifestChecked(internalDir, site);
  const manifest = emptyManifest(site);
  if (options.merge) manifest.pages = { ...previous.pages };
  /** @type {GeneratePageResult[]} */
  const pages = [];

  const unique = dedupeRoutes(routes);
  let index = 0;

  const twinDir = resolve(publicDir, MD_DIR);

  // Which route owns each twin file. Seeded from the entries a merge keeps, so a single-page run
  // cannot overwrite a twin some other route is being served from.
  /** @type {Map<string, string>} */
  const claimed = new Map();
  for (const route of Object.keys(manifest.pages)) claimed.set(twinFileKey(route), route);

  let manifestPath = '';
  /** @type {string[]} */
  const warnings = problem ? [problem] : [];
  /** @type {{ orphans: OrphanTwin[]; pruned: OrphanTwin[] }} */
  let settled = { orphans: [], pruned: [] };
  try {
    for (const route of unique) {
      // Outside the per-route catch below, which would otherwise record the abort as one failed
      // page and carry on to the next.
      options.signal?.throwIfAborted();
      index += 1;
      const url = new URL(route, origin).toString();
      const fetchUrl = new URL(route, site).toString();
      // Each route is its own unit of work. A name the filesystem refuses, markup deep enough to
      // overflow the extractor, or a provider hook that throws fails that page and nothing else: the
      // rest of the run, and any AI calls already paid for, still land in the manifest.
      try {
        // Checked before the fetch as well as before the write: there is no reason to download a page
        // whose twin could only be written somewhere it must not go.
        if (hasDotSegment(route)) {
          pages.push({ route, url, status: 'failed', warnings: [], reason: ERRORS.unsafeRoute });
          continue;
        }
        const owner = claimed.get(twinFileKey(route));
        if (owner !== undefined && owner !== route) {
          pages.push({ route, url, status: 'failed', warnings: [], reason: ERRORS.twinFileCollision(routeToMdRelPath(route), owner) });
          continue;
        }
        claimed.set(twinFileKey(route), route);
        let html = options.sources?.get(route);

        if (html === undefined) {
          onProgress?.({ route, index, total: unique.length, phase: 'fetch' });
          const response = await probe(fetchUrl, { timeoutMs: 20_000 });
          const finalOrigin = new URL(response.finalUrl || fetchUrl).origin;
          const offSite = finalOrigin !== new URL(site).origin;
          if (offSite || !response.ok || !response.body || response.truncated) {
            pages.push({
              route,
              url,
              status: 'failed',
              warnings: [],
              reason: offSite
                ? ERRORS.redirectedOffSite(finalOrigin)
                : response.truncated
                  ? ERRORS.pageTooLarge(MAX_PROBE_BYTES)
                  : (response.error ?? `HTTP ${response.status}`),
            });
            const carried = previous.pages[route];
            if (carried) manifest.pages[route] = carried;
            continue;
          }
          html = response.body;
        }

        const relPath = routeToMdRelPath(route);
        const absPath = resolve(publicDir, relPath);
        // The last line of defence, whatever a future route source lets through.
        if (!absPath.startsWith(twinDir + sep)) {
          pages.push({ route, url, status: 'failed', warnings: [], reason: ERRORS.unsafeRoute });
          continue;
        }
        const existing = existsSync(absPath) ? readFileSync(absPath, 'utf8') : undefined;
        // A twin is ours when its frontmatter says OpenGEO generated it. A file with no frontmatter,
        // or with another tool's, is somebody's own work that happens to sit where the twin goes.
        const owned = existing === undefined || isOpenGeoTwin(parseFrontmatter(existing).data);

        // A manual twin is checked before anything else, because the whole point of the marker is that
        // OpenGEO does no work on that page at all.
        if (existing && !force) {
          const parsed = parseFrontmatter(existing);
          if (parsed.data.generated_by === 'manual') {
            pages.push({
              route,
              url,
              status: 'skipped-manual',
              title: typeof parsed.data.title === 'string' ? parsed.data.title : route,
              description: typeof parsed.data.description === 'string' ? parsed.data.description : undefined,
              tier: 'manual',
              file: relPath,
              warnings: [],
              reason: 'Frontmatter says generated_by: manual - left untouched. Use --force to regenerate.',
            });
            manifest.pages[route] = manualEntry(route, url, relPath, parsed.data, existing);
            continue;
          }
        }

        // Extraction runs before the cache check because the hash is taken from what a reader receives,
        // not from the raw markup around it. See ManifestEntry.sourceHash for why. It is pure local CPU
        // on HTML already in memory; the expensive things the cache protects (an AI call, a disk write)
        // still happen only on a real change.
        onProgress?.({ route, index, total: unique.length, phase: 'extract' });
        const extracted = extractPage(html, { url, minWords: loaded.config.generate.minWords });
        const sourceHash = contentHash(extracted.markdown);

        const prior = previous.pages[route];
        // The hash covers the body only. Title, description and URL go into the frontmatter and
        // llms.txt, so a change to any of them must regenerate too, or the twin keeps the old one.
        // The URL also changes on its own when publicOrigin does.
        const sameHead =
          prior &&
          prior.title === extracted.title &&
          prior.description === extracted.description &&
          prior.canonical === extracted.canonical &&
          prior.url === url;
        if (existing && owned && !force && prior && sameHead && prior.sourceHash === sourceHash && tierSatisfied(prior, tier)) {
          pages.push({
            route,
            url,
            status: 'cached',
            title: prior.title,
            description: prior.description,
            tier: prior.tier,
            file: relPath,
            tokens: prior.tokens,
            wordCount: prior.wordCount,
            warnings: [],
            reason: prior.aiFallback && tier === 'ai' ? ERRORS.aiFallbackCached(prior.aiFallback) : 'Source unchanged since the last run.',
          });
          // A declared date that moved on its own is not a reason to rewrite the twin or pay for an AI
          // call, but the sitemap reads it from here, so it is kept current.
          const { lastModified: _stale, ...rest } = prior;
          manifest.pages[route] = extracted.lastModified ? { ...rest, lastModified: extracted.lastModified } : rest;
          continue;
        }

        let markdown = extracted.markdown;
        const warnings = [...extracted.warnings];
        /** @type {GenerationTier} */
        let appliedTier = 'free';
        /** @type {ManifestEntry['aiFallback']} */
        let aiFallback;

        if (tier === 'ai' && enhance) {
          onProgress?.({ route, index, total: unique.length, phase: 'ai' });
          const enhanced = await enhance({
            url,
            title: extracted.title,
            html,
            algorithmicMarkdown: extracted.markdown,
          });
          markdown = enhanced.markdown;
          warnings.push(...enhanced.warnings);
          appliedTier = enhanced.fellBack ? 'free' : 'ai';
          if (enhanced.fellBack && enhanced.fallback && enhanced.fallback !== 'unavailable') aiFallback = enhanced.fallback;
        }

        const tokens = estimateTokens(markdown);
        const wordCount = countWords(markdown);
        const lastUpdated = new Date().toISOString();

        onProgress?.({ route, index, total: unique.length, phase: 'write' });
        const contents = withFrontmatter(
          {
            title: extracted.title,
            url,
            last_updated: lastUpdated,
            tokens,
            source_hash: sourceHash,
            generated_by: appliedTier === 'ai' ? 'opengeo-ai' : 'opengeo-free',
            ...(extracted.description ? { description: extracted.description } : {}),
          },
          markdown,
        );

        const written = writeOrPropose(absPath, contents, owned, force);
        if (written.proposed) {
          // Not recorded in the manifest: prod serves what the manifest lists, and the manifest must
          // not vouch for a file OpenGEO did not write.
          pages.push({
            route,
            url,
            status: 'proposed',
            title: extracted.title,
            file: `${relPath}${PROPOSED_SUFFIX}`,
            warnings,
            reason: ERRORS.twinNotOurs(relPath),
          });
          continue;
        }

        manifest.pages[route] = {
          route,
          url,
          title: extracted.title,
          file: relPath,
          tokens,
          wordCount,
          sourceHash,
          lastUpdated,
          tier: appliedTier,
          ...(aiFallback ? { aiFallback } : {}),
          ...(extracted.description ? { description: extracted.description } : {}),
          ...(extracted.canonical ? { canonical: extracted.canonical } : {}),
          ...(extracted.lastModified ? { lastModified: extracted.lastModified } : {}),
        };
        pages.push({
          route,
          url,
          status: 'written',
          title: extracted.title,
          description: extracted.description,
          tier: appliedTier,
          file: relPath,
          tokens,
          wordCount,
          warnings,
        });
      } catch (error) {
        const reason = ERRORS.pageCrashed(error instanceof Error ? error.message : String(error));
        pages.push({ route, url, status: 'failed', warnings: [], reason });
        const carried = previous.pages[route];
        if (carried && !manifest.pages[route]) manifest.pages[route] = carried;
      }
    }
  } finally {
    // Written whatever happened above, so a run that does stop part way keeps what it finished.
    const keepAll = options.carryForward === 'all' || options.signal?.aborted === true;
    const carried = keepAll ? Object.keys(previous.pages) : (options.carryForward ?? []);
    for (const route of carried) {
      const entry = previous.pages[route];
      if (entry && !manifest.pages[route]) manifest.pages[route] = entry;
    }
    settled = settleOrphans(previous, manifest, publicDir, twinDir, options.prune === true, warnings);
    if (settled.orphans.length > 0) manifest.orphans = settled.orphans;
    // The manifest is often committed. A run that changed no entry keeps the previous timestamp, so
    // a fully cached rerun leaves the file byte-identical instead of producing a one-line diff.
    if (
      typeof previous.generatedAt === 'string' &&
      previous.site === manifest.site &&
      previous.specVersion === manifest.specVersion &&
      samePages(previous.pages, manifest.pages) &&
      JSON.stringify(previous.orphans ?? []) === JSON.stringify(manifest.orphans ?? [])
    ) {
      manifest.generatedAt = previous.generatedAt;
    }
    manifestPath = writeManifest(internalDir, manifest);
  }
  return {
    site,
    pages,
    manifest,
    manifestPath,
    publicDir,
    warnings,
    orphans: settled.orphans,
    pruned: settled.pruned,
    durationMs: Date.now() - started,
  };
}

/**
 * Whether the twin on disk is what this run's tier would produce. A free twin the AI tier already
 * tried and could not improve counts for the AI tier, or every run would pay for the same rejection.
 *
 * @param {ManifestEntry} prior
 * @param {'free' | 'ai'} tier
 * @returns {boolean}
 */
function tierSatisfied(prior, tier) {
  return prior.tier === tier || (tier === 'ai' && prior.tier === 'free' && prior.aiFallback !== undefined);
}

/**
 * @param {Record<string, ManifestEntry>} a
 * @param {Record<string, ManifestEntry>} b
 * @returns {boolean}
 */
function samePages(a, b) {
  const left = Object.keys(a).sort();
  const right = Object.keys(b).sort();
  return left.length === right.length && left.every((route, i) => route === right[i] && JSON.stringify(a[route]) === JSON.stringify(b[route]));
}

/**
 * Find the twins OpenGEO wrote for pages this run no longer has, and delete them only when asked.
 *
 * A candidate comes from the previous manifest, either as a page or as an orphan it already listed,
 * so a file no manifest ever vouched for is never considered. It must still be on disk inside the
 * twin directory, not be the file of a page this run kept, and still carry OpenGEO's frontmatter: a
 * twin the user has since taken over, with generated_by: manual or by rewriting it, is theirs.
 *
 * @param {Manifest} previous
 * @param {Manifest} manifest
 * @param {string} publicDir
 * @param {string} twinDir
 * @param {boolean} prune
 * @param {string[]} warnings
 * @returns {{ orphans: OrphanTwin[]; pruned: OrphanTwin[] }}
 */
function settleOrphans(previous, manifest, publicDir, twinDir, prune, warnings) {
  /** @type {Map<string, OrphanTwin>} */
  const candidates = new Map();
  for (const item of Array.isArray(previous.orphans) ? previous.orphans : []) {
    if (typeof item?.route === 'string' && typeof item.url === 'string' && typeof item.file === 'string') {
      candidates.set(item.route, { route: item.route, url: item.url, file: item.file });
    }
  }
  for (const entry of Object.values(previous.pages)) {
    candidates.set(entry.route, { route: entry.route, url: entry.url, file: entry.file });
  }
  const live = new Set(Object.values(manifest.pages).map((entry) => entry.file));

  /** @type {OrphanTwin[]} */
  const orphans = [];
  /** @type {OrphanTwin[]} */
  const pruned = [];
  for (const route of dedupeRoutes([...candidates.keys()])) {
    const orphan = candidates.get(route);
    if (!orphan || manifest.pages[route] || live.has(orphan.file)) continue;
    const absPath = resolve(publicDir, orphan.file);
    if (!absPath.startsWith(twinDir + sep) || !existsSync(absPath)) continue;
    /** @type {string} */
    let contents;
    try {
      contents = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (!isOpenGeoTwin(parseFrontmatter(contents).data)) continue;
    if (prune) {
      try {
        unlinkSync(absPath);
        pruned.push(orphan);
        continue;
      } catch (error) {
        warnings.push(ERRORS.pruneFailed(orphan.file, error instanceof Error ? error.message : String(error)));
      }
    }
    orphans.push(orphan);
  }
  return { orphans, pruned };
}

/**
 * @param {Record<string, unknown>} data
 * @returns {boolean}
 */
function isOpenGeoTwin(data) {
  return data.generated_by === 'opengeo-free' || data.generated_by === 'opengeo-ai';
}

/**
 * A hand-written twin, recorded in the manifest so prod still serves it, but never re-derived.
 *
 * `sourceHash` is carried through only when the author put one there. A hand-written twin usually
 * has none, and a made-up hash would make test's drift check pass a page nobody has verified; with
 * the field absent the check falls back to comparing facts, which is the honest answer.
 *
 * @param {string} route
 * @param {string} url
 * @param {string} relPath
 * @param {Record<string, unknown>} data
 * @param {string} contents
 * @returns {ManifestEntry}
 */
function manualEntry(
  route,
  url,
  relPath,
  data,
  contents,
) {
  const body = parseFrontmatter(contents).body;
  return {
    route,
    url,
    title: typeof data.title === 'string' ? data.title : route,
    file: relPath,
    tokens: typeof data.tokens === 'number' ? data.tokens : estimateTokens(body),
    wordCount: countWords(body),
    lastUpdated: typeof data.last_updated === 'string' ? data.last_updated : new Date().toISOString(),
    tier: 'manual',
    ...(typeof data.source_hash === 'string' ? { sourceHash: data.source_hash } : {}),
  };
}

/**
 * @param {string[]} routes
 * @returns {string[]}
 */
export function dedupeRoutes(routes) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of routes) {
    const route = normalizeRoute(raw);
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(route);
  }
  // Code-unit order rather than localeCompare, whose result depends on the machine's locale.
  return out.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Convenience for reporting: the URL an agent would fetch for a given route.
 *
 * @param {string} site
 * @param {string} route
 * @returns {string}
 */
export function twinUrlFor(site, route) {
  return new URL(routeToTwinUrlPath(route), site).toString();
}
