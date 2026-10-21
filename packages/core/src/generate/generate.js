import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { internalDirPath, publicDirPath, publicOriginOf } from '../shared/config.js';
import { contentHash } from '../shared/hash.js';
import { ERRORS } from '../shared/errors.js';
import { MAX_PROBE_BYTES, probe } from '../shared/http.js';
import { whyUnreachable } from '../shared/site-probe.js';
import { isIndexFile } from '../shared/local-pages.js';
import { hasDotSegment, MD_DIR, routeToTwinRelPath, routeToTwinUrlPath, twinFileKey, urlAt } from '../shared/routes.js';
import { countWords, estimateTokens } from '../shared/tokens.js';
import { extractPage } from './extract.js';
import { PROPOSED_SUFFIX, writeOrPropose } from './files.js';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';
import { emptyManifest, manifestPath as manifestFile, readManifestChecked, writeManifest } from './manifest.js';
import { dedupeRoutes, isOpenGsoTwin, manualEntry, samePages, settleOrphans, tierSatisfied } from './reconcile.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { TwinLayout } from '../shared/routes.js'
 * @import { GenerationTier, Manifest, ManifestEntry, OrphanTwin } from './manifest.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').PageStatus} PageStatus
 * @typedef {import('../shared/api-types.js').GeneratePageResult} GeneratePageResult
 */

// Re-exported so `@opengso/core/generate` keeps offering it.
export { dedupeRoutes } from './reconcile.js';

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
 *   manifest lists and whose frontmatter says OpenGSO generated it is ever deleted. The caller decides
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
 * @property {TwinLayout} [layout] Where the twins go on disk. `md` unless the pages came from files.
 * @property {ReadonlyMap<string, SourceStamp>} [sourceFiles] The HTML file each route was read from,
 *   for a run over the site's own files. Recorded in the manifest so the freshness check can tell
 *   when a page is edited after its twin was written. Its presence marks the manifest as made from
 *   files.
 */

/**
 * @typedef {object} SourceStamp
 * @property {string} file Relative to the web root, forward slashes.
 * @property {string} modified The file's modification time, ISO.
 * @property {string} hash `contentHash` of the file's text.
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
  if (options.sourceFiles) manifest.source = 'files';
  if (options.merge) manifest.pages = { ...previous.pages };
  const layout = options.layout ?? 'md';
  /** @type {GeneratePageResult[]} */
  const pages = [];

  const unique = dedupeRoutes(routes);
  let index = 0;

  // Every twin this run writes must land in here. A twin written beside its page can be anywhere in
  // the web root, so for that layout the web root itself is the boundary.
  const twinDir = layout === 'md' ? resolve(publicDir, MD_DIR) : resolve(publicDir);

  // Which route owns each twin file. Seeded from the entries a merge keeps, so a single-page run
  // cannot overwrite a twin some other route is being served from.
  /** @type {Map<string, string>} */
  const claimed = new Map();
  for (const entry of Object.values(manifest.pages)) claimed.set(entry.file.toLowerCase(), entry.route);

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
      const url = urlAt(origin, route);
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
        const owner = claimed.get(twinFileKey(route, layout));
        if (owner !== undefined && owner !== route) {
          pages.push({ route, url, status: 'failed', warnings: [], reason: ERRORS.twinFileCollision(routeToTwinRelPath(route, layout), owner) });
          continue;
        }
        claimed.set(twinFileKey(route, layout), route);
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
                  : response.error
                    ? whyUnreachable(fetchUrl, response.error)
                    : `HTTP ${response.status}`,
            });
            const carried = previous.pages[route];
            if (carried) manifest.pages[route] = carried;
            continue;
          }
          html = response.body;
        }

        const relPath = routeToTwinRelPath(route, layout);
        const stamp = options.sourceFiles?.get(route);
        const absPath = resolve(publicDir, relPath);
        // The last line of defence, whatever a future route source lets through.
        if (!absPath.startsWith(twinDir + sep)) {
          pages.push({ route, url, status: 'failed', warnings: [], reason: ERRORS.unsafeRoute });
          continue;
        }
        const existing = existsSync(absPath) ? readFileSync(absPath, 'utf8') : undefined;
        // A twin is ours when its frontmatter says OpenGSO generated it. A file with no frontmatter,
        // or with another tool's, is somebody's own work that happens to sit where the twin goes.
        const owned = existing === undefined || isOpenGsoTwin(parseFrontmatter(existing).data);

        // A manual twin is checked before anything else, because the whole point of the marker is that
        // OpenGSO does no work on that page at all.
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
            // The file is recorded and its stamp is not. A stamp says "the twin matches this file", which
            // only the author of a hand-written twin can say; the freshness check compares the two
            // files' dates instead.
            const entry = manualEntry(route, url, relPath, parsed.data, existing);
            manifest.pages[route] = stamp ? { ...entry, sourceFile: stamp.file } : entry;
            continue;
          }
        }

        // Extraction runs before the cache check because the hash is taken from what a reader receives,
        // not from the raw markup around it. See ManifestEntry.sourceHash for why. It is pure local CPU
        // on HTML already in memory; the expensive things the cache protects (an AI call, a disk write)
        // still happen only on a real change.
        onProgress?.({ route, index, total: unique.length, phase: 'extract' });
        // A folder's page is served from inside the folder, `/guide/` and not `/guide`, and that is
        // where its relative links start: `setup.html` from it is `/guide/setup.html`, not `/setup.html`.
        const inFolder = stamp !== undefined && !url.endsWith('/') && isIndexFile(/** @type {string} */ (stamp.file.split('/').pop()));
        const extracted = extractPage(html, { url: inFolder ? `${url}/` : url, minWords: loaded.config.generate.minWords });
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
        if (existing && owned && !force && prior && prior.file === relPath && sameHead && prior.sourceHash === sourceHash && tierSatisfied(prior, tier)) {
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
          // The file may have changed in a way the reader never sees, a class name or a script tag.
          // The twin is still right, so it now matches the new file, and saying so is what clears the
          // freshness warning.
          manifest.pages[route] = stamped(extracted.lastModified ? { ...rest, lastModified: extracted.lastModified } : rest, stamp);
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
            generated_by: appliedTier === 'ai' ? 'opengso-ai' : 'opengso-free',
            ...(extracted.description ? { description: extracted.description } : {}),
          },
          markdown,
        );

        const written = writeOrPropose(absPath, contents, owned, force);
        if (written.proposed) {
          // Not recorded in the manifest: prod serves what the manifest lists, and the manifest must
          // not vouch for a file OpenGSO did not write.
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
        manifest.pages[route] = stamped(manifest.pages[route], stamp);
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
    // The whole web root rather than this run's twin directory, so a project that changed layout
    // still hears about the twins the other layout left behind.
    settled = settleOrphans(previous, manifest, publicDir, resolve(publicDir), options.prune === true, warnings);
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
    // A first run that reached no page has nothing to record, and an empty manifest would tell the
    // next run, the home screen and prod that this site has been generated.
    const recordsNothing = options.carryForward === 'all' && Object.keys(manifest.pages).length === 0 && !existsSync(manifestFile(internalDir));
    if (!recordsNothing) manifestPath = writeManifest(internalDir, manifest);
  }
  if (options.sourceFiles) {
    for (const page of pages) {
      const stamp = options.sourceFiles.get(page.route);
      if (stamp) page.sourceFile = stamp.file;
    }
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
 * An entry that records which file it was made from, and when that file last changed.
 *
 * The previous time is kept when the file's text is the same, which happens on every fresh clone
 * and every `touch`. Taking the new one would rewrite a committed manifest for nothing.
 *
 * @param {ManifestEntry} entry
 * @param {SourceStamp | undefined} stamp
 * @returns {ManifestEntry}
 */
function stamped(entry, stamp) {
  if (!stamp) return entry;
  const same = entry.sourceFile === stamp.file && entry.sourceFileHash === stamp.hash && typeof entry.sourceModified === 'string';
  return { ...entry, sourceFile: stamp.file, sourceModified: same ? /** @type {string} */ (entry.sourceModified) : stamp.modified, sourceFileHash: stamp.hash };
}

/**
 * Convenience for reporting: the URL an agent would fetch for a given route.
 *
 * @param {string} site
 * @param {string} route
 * @returns {string}
 */
export function twinUrlFor(site, route) {
  return urlAt(site, routeToTwinUrlPath(route));
}
