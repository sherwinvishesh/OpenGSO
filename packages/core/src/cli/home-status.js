import { basename, relative } from 'node:path';
import { checkFreshness } from '../generate/freshness.js';
import { readManifest } from '../generate/manifest.js';
import { CONFIG_FILENAME, internalDirPath, isLoopbackUrl, loadConfig, publicDirPath } from '../shared/config.js';
import { readCredentials } from '../shared/env.js';
import { deltaFor, lastScored, readHistory, scoreTrend } from '../shared/history.js';

/**
 * What the home screen knows about the project, read off disk. Nothing here draws, so the
 * full-screen menu and the flat one share one reading of it.
 */

/**
 * Everything the header knows, read once per repaint. Separated out so the rendering is testable.
 *
 * @typedef {object} HomeStatus
 * @property {string} project The directory name, which is what a person calls their project.
 * @property {string} root
 * @property {boolean} configured
 * @property {string} [site]
 * @property {{ value: number; at: string; delta?: number; trend: number[]; suggestions?: { adopted: number; count: number } }} [score]
 * @property {{ id: string; source: string; keyless?: boolean }} [provider]
 * @property {number} twins
 * @property {string} [generatedAt]
 * @property {string} [folder] Set when the project generates from its own HTML files: the folder
 *   they are read from, relative to the project.
 * @property {number} [stale] How many of those files changed after their twins were written, or have
 *   none. Only a project that generates from files can know.
 */

/**
 * Read the project's current state.
 *
 * Every source here is best-effort and every one of them is allowed to be missing: an unconfigured
 * directory, a project that has never generated, one with no key. A home screen that throws because
 * a file it wanted to summarise is absent would be worse than no home screen.
 *
 * @param {string} root
 * @returns {HomeStatus}
 */
export function readHomeStatus(root) {
  const loaded = safely(() => loadConfig(root));
  const configured = Boolean(loaded?.exists);
  /** @type {HomeStatus} */
  const status = { project: basename(root) || root, root, configured, twins: 0 };
  if (!loaded) return status;

  // Only a site the user actually chose. `defaultConfig()` fills in localhost:3000, and showing
  // that on an unconfigured directory would be the home screen inventing a project.
  status.site = configured ? loaded.config.site || undefined : undefined;
  const internalDir = internalDirPath(loaded);

  if (configured && loaded.config.generate.source === 'files') {
    status.folder = relative(root, publicDirPath(loaded)) || '.';
    // A folder of pages has no server, so the site is the public address if there is one. The
    // localhost default would be a URL nothing answers at.
    const origin = loaded.config.publicOrigin ?? loaded.config.site;
    status.site = origin && !safely(() => isLoopbackUrl(origin)) ? origin : undefined;
    // Hashes only the files whose dates moved, so it is cheap enough for every repaint.
    const freshness = safely(() => checkFreshness(loaded));
    if (freshness) status.stale = freshness.stale.length;
  }

  const manifest = safely(() => readManifest(internalDir, loaded.config.site));
  if (manifest) {
    const pages = Object.keys(manifest.pages ?? {});
    status.twins = pages.length;
    if (pages.length > 0) status.generatedAt = manifest.generatedAt;
  }

  const history = safely(() => readHistory(internalDir)) ?? { version: 1, entries: [] };
  const last = lastScored(history);
  if (last && typeof last.score === 'number') {
    status.score = {
      value: last.score,
      at: last.at,
      delta: deltaFor(history, last)?.points,
      trend: scoreTrend(history, last.url, 16),
      suggestions: last.suggestions,
    };
    // A score always belongs to the URL it was measured against, so the header shows that URL
    // rather than the configured one when they differ. Otherwise a run against localhost would be
    // reported under the production address it was never taken from.
    if (last.url && last.url !== status.site) status.site = last.url;
  }

  // Never the key itself, and never its length. Which provider and where it lives is the whole of
  // what a status line needs, and it is the one value in OpenGSO that must not reach a screen.
  const credentials = safely(() => readCredentials(root, loaded.config.ai));
  if (credentials) {
    const source = { 'env-file': '.env', 'process-env': 'environment', config: CONFIG_FILENAME }[credentials.source];
    status.provider = credentials.keyless ? { id: credentials.provider, source, keyless: true } : { id: credentials.provider, source };
  }
  return status;
}

/**
 * @template T
 * @param {() => T} read
 * @returns {T | undefined}
 */
function safely(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}
