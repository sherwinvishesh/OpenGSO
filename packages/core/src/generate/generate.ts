import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { LoadedConfig } from '../shared/config.js';
import { internalDirPath, publicDirPath } from '../shared/config.js';
import { contentHash } from '../shared/hash.js';
import { ERRORS } from '../shared/errors.js';
import { writeFileAtomic } from '../shared/fs.js';
import { MAX_PROBE_BYTES, probe } from '../shared/http.js';
import { hasDotSegment, MD_DIR, normalizeRoute, routeToMdRelPath, routeToTwinUrlPath } from '../shared/routes.js';
import { estimateTokens } from '../shared/tokens.js';
import { extractPage } from './extract.js';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';
import type { GenerationTier, Manifest, ManifestEntry } from './manifest.js';
import { emptyManifest, readManifestChecked, writeManifest } from './manifest.js';

export type PageStatus = 'written' | 'cached' | 'skipped-manual' | 'failed';

export interface GeneratePageResult {
  route: string;
  url: string;
  status: PageStatus;
  title?: string;
  description?: string;
  tier?: GenerationTier;
  file?: string;
  tokens?: number;
  wordCount?: number;
  warnings: string[];
  reason?: string;
}

export interface GenerateProgress {
  route: string;
  index: number;
  total: number;
  phase: 'fetch' | 'extract' | 'ai' | 'write';
}

export interface GenerateOptions {
  /** Base site URL. Every route is resolved against this. */
  site: string;
  /** Routes to generate. Phase-2 callers pass the crawl result; a single-page run passes one. */
  routes: string[];
  loaded: LoadedConfig;
  tier?: 'free' | 'ai';
  force?: boolean;
  /**
   * Keep manifest entries for routes this run didn't touch.
   *
   * A whole-site run wants the default (false): the crawl is authoritative, so a page that has been
   * deleted should disappear from the manifest and stop being served. A page the crawl tried and
   * failed to fetch is not deleted, and is handled by `carryForward` instead. A single-page run wants true,
   * otherwise regenerating one route would quietly drop every other page from the manifest and prod
   * would stop answering for them at the next boot.
   */
  merge?: boolean;
  /**
   * Routes this run could not fetch, whose previous manifest entries are kept as they were.
   *
   * "The crawl is authoritative" only holds for the pages it actually reached. A 503 is not a
   * deletion, and prod serves from the manifest, so dropping the entry would un-serve a twin that
   * is still on disk and still correct. `'all'` keeps every previous entry not regenerated here,
   * for a run that reached nothing and so learned nothing about which pages still exist.
   */
  carryForward?: readonly string[] | 'all';
  onProgress?: (event: GenerateProgress) => void;
  /**
   * HTML already fetched by the crawl, keyed by route. Route discovery has to download every page
   * to find its links, so re-downloading them here would double the request count against the
   * user's own dev server for no gain. A route missing from the map is fetched normally.
   */
  sources?: ReadonlyMap<string, string>;
  /**
   * Optional AI enhancer. Injected rather than imported so the free tier never reaches provider
   * code, and so tests can drive the fidelity guard with a fake provider.
   */
  enhance?: (input: EnhanceInput) => Promise<EnhanceOutput>;
}

export interface EnhanceInput {
  url: string;
  title: string;
  html: string;
  algorithmicMarkdown: string;
}

export interface EnhanceOutput {
  markdown: string;
  warnings: string[];
  /** True when the fidelity guard rejected the AI output and the algorithmic one was kept. */
  fellBack: boolean;
}

export interface GenerateResult {
  site: string;
  pages: GeneratePageResult[];
  manifest: Manifest;
  manifestPath: string;
  publicDir: string;
  /** Problems with the run as a whole rather than with one page. */
  warnings: string[];
  durationMs: number;
}

/**
 * Generate markdown twins for a set of routes (§6).
 *
 * Build-time only, never per visitor request: everything here writes static files to disk, so a
 * real visitor only ever receives a file that already exists.
 */
export async function generatePages(options: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();
  const { loaded, routes, site, tier = 'free', force = false, onProgress, enhance } = options;
  const publicDir = publicDirPath(loaded);
  const internalDir = internalDirPath(loaded);

  const { manifest: previous, problem } = readManifestChecked(internalDir, site);
  const manifest = emptyManifest(site);
  if (options.merge) manifest.pages = { ...previous.pages };
  const pages: GeneratePageResult[] = [];

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
        if (existing && !force && prior && prior.sourceHash === sourceHash && prior.tier === tier) {
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
        let appliedTier: GenerationTier = 'free';

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

        writeFileAtomic(absPath, contents);

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
 * A hand-written twin, recorded in the manifest so prod still serves it, but never re-derived.
 *
 * `sourceHash` is carried through only when the author put one there. A hand-written twin usually
 * has none, and a made-up hash would make test's drift check pass a page nobody has verified; with
 * the field absent the check falls back to comparing facts, which is the honest answer.
 */
function manualEntry(
  route: string,
  url: string,
  relPath: string,
  data: Record<string, unknown>,
  contents: string,
): ManifestEntry {
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

export function dedupeRoutes(routes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of routes) {
    const route = normalizeRoute(raw);
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(route);
  }
  return out.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

/** Convenience for reporting: the URL an agent would fetch for a given route. */
export function twinUrlFor(site: string, route: string): string {
  return new URL(routeToTwinUrlPath(route), site).toString();
}
