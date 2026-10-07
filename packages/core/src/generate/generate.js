import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { internalDirPath, publicDirPath } from '../shared/config.js';
import { contentHash } from '../shared/hash.js';
import { ERRORS } from '../shared/errors.js';
import { MAX_PROBE_BYTES, probe } from '../shared/http.js';
import { hasDotSegment, MD_DIR, normalizeRoute, routeToMdRelPath, routeToTwinUrlPath } from '../shared/routes.js';
import { estimateTokens } from '../shared/tokens.js';
import { extractPage } from './extract.js';
import { PROPOSED_SUFFIX, writeOrPropose } from './files.js';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';
import { emptyManifest, readManifestChecked, writeManifest } from './manifest.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { GenerationTier, Manifest, ManifestEntry } from './manifest.js'
 */

/** @typedef {'written' | 'cached' | 'skipped-manual' | 'proposed' | 'failed'} PageStatus */

/**
 * @typedef {object} GeneratePageResult
 * @property {string} route
 * @property {string} url
 * @property {PageStatus} status
 * @property {string} [title]
 * @property {string} [description]
 * @property {GenerationTier} [tier]
 * @property {string} [file]
 * @property {number} [tokens]
 * @property {number} [wordCount]
 * @property {string[]} warnings
 * @property {string} [reason]
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
 * @property {(event: GenerateProgress) => void} [onProgress]
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
 */

/**
 * @typedef {object} GenerateResult
 * @property {string} site
 * @property {GeneratePageResult[]} pages
 * @property {Manifest} manifest
 * @property {string} manifestPath
 * @property {string} publicDir
 * @property {string[]} warnings Problems with the run as a whole rather than with one page.
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

  const { manifest: previous, problem } = readManifestChecked(internalDir, site);
  const manifest = emptyManifest(site);
  if (options.merge) manifest.pages = { ...previous.pages };
  /** @type {GeneratePageResult[]} */
  const pages = [];

  const unique = dedupeRoutes(routes);
  let index = 0;

  const twinDir = resolve(publicDir, MD_DIR);

  let manifestPath = '';
  try {
    for (const route of unique) {
      index += 1;
      const url = new URL(route, site).toString();
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
        let html = options.sources?.get(route);

        if (html === undefined) {
          onProgress?.({ route, index, total: unique.length, phase: 'fetch' });
          const response = await probe(url, { timeoutMs: 20_000 });
          if (!response.ok || !response.body || response.truncated) {
            pages.push({
              route,
              url,
              status: 'failed',
              warnings: [],
              reason: response.truncated ? ERRORS.pageTooLarge(MAX_PROBE_BYTES) : (response.error ?? `HTTP ${response.status}`),
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
        if (existing && owned && !force && prior && prior.sourceHash === sourceHash && prior.tier === tier) {
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
            reason: 'Source unchanged since the last run.',
          });
          manifest.pages[route] = prior;
          continue;
        }

        let markdown = extracted.markdown;
        const warnings = [...extracted.warnings];
        /** @type {GenerationTier} */
        let appliedTier = 'free';

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
        }

        const tokens = estimateTokens(markdown);
        const wordCount = markdown.split(/\s+/).filter(Boolean).length;
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
          ...(extracted.description ? { description: extracted.description } : {}),
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
    const carried = options.carryForward === 'all' ? Object.keys(previous.pages) : (options.carryForward ?? []);
    for (const route of carried) {
      const entry = previous.pages[route];
      if (entry && !manifest.pages[route]) manifest.pages[route] = entry;
    }
    manifestPath = writeManifest(internalDir, manifest);
  }
  return {
    site,
    pages,
    manifest,
    manifestPath,
    publicDir,
    warnings: problem ? [problem] : [],
    durationMs: Date.now() - started,
  };
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
    wordCount: body.split(/\s+/).filter(Boolean).length,
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
  return out.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
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
