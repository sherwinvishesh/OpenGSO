import { createAiEnhancer } from '../generate/ai.js';
import { SourceFilesError, generateFromFiles } from '../generate/local.js';
import { generateSite } from '../generate/site.js';
import { loadConfig } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import { ok, bad, resolveCredentials } from './api-shared.js';

/**
 * @import { EnhanceInput, EnhanceOutput } from '../generate/generate.js'
 * @import { GenerateSiteResult, SiteProgress } from '../generate/site.js'
 * @import { ApiProgress } from '../shared/api-types.js'
 * @import { ApiOptions, ApiResponse } from './api-shared.js'
 */

/** The generate route. */

// -- generate ------------------------------------------------------------------------------------

/**
 * A site progress event, flattened by one level.
 *
 * `SiteProgress` nests the crawl and generate payloads under a key named after the phase, which is
 * an awkward shape to switch on twice in a browser. Flattened here instead, and `phase` renamed to
 * `step` on the generate branch so the outer discriminant is not shadowed by an inner one.
 *
 * @param {SiteProgress} event
 * @returns {ApiProgress}
 */
export function generateFrame(event) {
  if (event.phase === 'crawl') return { phase: 'crawl', ...event.crawl };
  if (event.phase === 'generate') {
    const { phase, ...rest } = event.generate;
    return { phase: 'generate', step: phase, ...rest };
  }
  return { phase: 'files' };
}

/**
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
export async function runGenerate(body, options) {
  const input = /** @type {{
    url?: string;
    tier?: 'free' | 'ai';
    single?: boolean;
    force?: boolean;
    skipSiteFiles?: boolean;
    maxPages?: number;
    maxDepth?: number;
    file?: string;
  }} */ (body ?? {});
  const loaded = loadConfig(options.root);
  // A project that reads its files does so unless the request names a URL to crawl instead.
  const fromFiles = loaded.config.generate.source === 'files' && !input.url;
  const target = input.url || loaded.config.site;
  if (!fromFiles && !parseUrl(target)) return bad(ERRORS.invalidUrl(target));
  if (input.file !== undefined && (typeof input.file !== 'string' || !fromFiles)) return bad(ERRORS.fileNeedsFilesSource);

  const tier = input.tier ?? loaded.config.generate.tier;
  /** @type {((enhanceInput: EnhanceInput) => Promise<EnhanceOutput>) | undefined} */
  let enhance;
  if (tier === 'ai') {
    const built = resolveCredentials(options.root, loaded.config, "generate's AI tier");
    if ('error' in built) return bad(built.error, { needsKey: true });
    enhance = createAiEnhancer(built);
  }

  const shared = {
    loaded,
    tier,
    force: input.force,
    maxPages: input.maxPages,
    skipSiteFiles: input.skipSiteFiles,
    enhance,
    signal: options.signal,
    onProgress: options.onProgress ? (/** @type {SiteProgress} */ event) => options.onProgress?.(generateFrame(event)) : undefined,
  };
  /** @type {GenerateSiteResult} */
  let result;
  try {
    result = fromFiles
      ? await generateFromFiles({ ...shared, file: input.file })
      : await generateSite({ ...shared, target, single: input.single, maxDepth: input.maxDepth });
  } catch (error) {
    // Its message names the folder and says what to do, which is what the page should show.
    if (error instanceof SourceFilesError) return bad(error.message);
    throw error;
  }

  return ok({
    site: result.site,
    durationMs: result.durationMs,
    pages: result.generate.pages,
    files: result.files,
    warnings: result.warnings,
    ...(result.notes?.length ? { notes: result.notes } : {}),
    orphans: result.generate.orphans,
    publicDir: result.generate.publicDir,
    source: result.source,
  });
}
